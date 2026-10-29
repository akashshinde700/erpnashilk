import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { ApiError } from '@/lib/erp-helpers'

/**
 * ManuFlow Tally Connector — server side (proof of concept).
 *
 * TallyPrime runs on the customer's Windows PC; a cloud ManuFlow cannot reach it. A small connector program on a
 * computer in the customer's network connects OUT to ManuFlow over HTTPS:
 *
 *  1. An admin clicks "Connect Tally" → issuePairingCode(): a 10-character code, valid 10 minutes, single use,
 *     stored only as a SHA-256 hash, one open code per company (a new one replaces the old).
 *  2. The connector sends the code once → pairConnector(): the code is consumed and a connector token is returned
 *     ONCE (`mftc_<id>_<secret>`; only the hash of the secret is kept). Pairing revokes any earlier connector of the
 *     company (reconnect = pair again).
 *  3. The connector sends a heartbeat every ~30 s with the result of its own read-only check of Tally →
 *     recordHeartbeat(). ManuFlow never sends the connector a URL, XML or command: the Tally address is set on the
 *     connector's computer and the only request it sends to Tally is the fixed connectivity check.
 *  4. Disconnect → revokeConnector(): the token stops working at once (401); the connector then deletes it.
 *
 * 5. Jobs (src/lib/tally/jobs.ts): the reply to a heartbeat may carry ONE named job from a fixed list (company list,
 *    customers, suppliers, stock items) plus a Tally company name taken from Tally's own company list. The connector
 *    builds the read-only Export XML itself and posts normalised records back. Never a URL, XML or free command.
 *
 * Storage: the PoC keeps pairing codes and connectors in this process's memory (lost on restart, not shared between
 * processes) and is OFF unless TALLY_CONNECTOR_POC=1. Persisting them needs two new tables (docs/tally-connector.md)
 * — a schema change that has not been made.
 */

export const PAIRING_TTL_MS = 10 * 60 * 1000
export const ONLINE_WINDOW_MS = 90 * 1000
export const HEARTBEAT_MIN_INTERVAL_MS = 5 * 1000
const PAIR_FAIL_WINDOW_MS = 15 * 60 * 1000
const PAIR_MAX_FAILS = 10
const ISSUE_WINDOW_MS = 60 * 60 * 1000
const ISSUE_MAX = 10

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789' // no 0/O, 1/I/L
const TOKEN_RE = /^mftc_([a-f0-9]{24})_([A-Za-z0-9_-]{43})$/

export const TALLY_CHECK_STATUSES = ['connected', 'unreachable', 'timeout', 'invalid_response', 'invalid_config'] as const
export type ConnectorTallyStatus = (typeof TALLY_CHECK_STATUSES)[number]

export function connectorFeatureEnabled(env: Record<string, string | undefined> = process.env) {
  return env.TALLY_CONNECTOR_POC === '1'
}

export function assertConnectorEnabled() {
  if (!connectorFeatureEnabled()) {
    throw new ApiError('The ManuFlow Tally Connector is not available on this server yet', 503, 'TALLY_CONNECTOR_UNAVAILABLE')
  }
}

// ---------------------------------------------------------------- storage

export interface PairingRecord {
  codeHash: string
  companyId: string
  createdBy: string
  expiresAt: number
}

export interface ConnectorRecord {
  id: string
  companyId: string
  secretHash: string
  pairedAt: number
  pairedBy: string
  revokedAt: number | null
  lastSeenAt: number | null
  lastTallyStatus: ConnectorTallyStatus | null
  lastTallyCheckAt: number | null
  lastTallySuccessAt: number | null
  lastLatencyMs: number | null
  tallyEndpoint: string | null
  version: string | null
  platform: string | null
}

/** Async on purpose: a database-backed store can replace the in-memory one without changing callers. */
export type TallyJobType = 'list-companies' | 'export-customers' | 'export-suppliers' | 'export-items'
export type TallyJobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled'

export interface TallyJobRecord {
  id: string
  companyId: string
  connectorId: string
  type: TallyJobType
  /** Tally company the export is for (from Tally's own company list); null for list-companies. */
  tallyCompany: string | null
  status: TallyJobStatus
  createdBy: string
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
  /** Machine code; the UI message is written by the server. */
  error: string | null
  records: Record<string, string>[] | null
}

export interface ConnectorStore {
  putPairing(p: PairingRecord): Promise<void>
  /** Remove and return the pairing with this hash (single use). */
  takePairing(codeHash: string): Promise<PairingRecord | null>
  openPairing(companyId: string): Promise<PairingRecord | null>
  dropPairings(companyId: string): Promise<void>
  putConnector(c: ConnectorRecord): Promise<void>
  getConnector(id: string): Promise<ConnectorRecord | null>
  activeConnector(companyId: string): Promise<ConnectorRecord | null>
  updateConnector(id: string, patch: Partial<ConnectorRecord>): Promise<void>
  putJob(j: TallyJobRecord): Promise<void>
  getJob(id: string): Promise<TallyJobRecord | null>
  updateJob(id: string, patch: Partial<TallyJobRecord>): Promise<void>
  jobsOf(companyId: string): Promise<TallyJobRecord[]>
}

export function memoryStore(): ConnectorStore {
  const pairings = new Map<string, PairingRecord>()
  const connectors = new Map<string, ConnectorRecord>()
  const jobs = new Map<string, TallyJobRecord>()
  return {
    async putPairing(p) { pairings.set(p.codeHash, { ...p }) },
    async takePairing(h) {
      const p = pairings.get(h) ?? null
      pairings.delete(h)
      return p
    },
    async openPairing(companyId) {
      for (const p of pairings.values()) if (p.companyId === companyId && p.expiresAt > Date.now()) return { ...p }
      return null
    },
    async dropPairings(companyId) {
      for (const [h, p] of pairings) if (p.companyId === companyId || p.expiresAt <= Date.now()) pairings.delete(h)
    },
    async putConnector(c) { connectors.set(c.id, { ...c }) },
    async getConnector(id) {
      const c = connectors.get(id)
      return c ? { ...c } : null
    },
    async activeConnector(companyId) {
      let best: ConnectorRecord | null = null
      for (const c of connectors.values()) {
        if (c.companyId === companyId && !c.revokedAt && (!best || c.pairedAt > best.pairedAt)) best = c
      }
      return best ? { ...best } : null
    },
    async updateConnector(id, patch) {
      const c = connectors.get(id)
      if (c) connectors.set(id, { ...c, ...patch })
    },
    async putJob(j) { jobs.set(j.id, { ...j }) },
    async getJob(id) {
      const j = jobs.get(id)
      return j ? { ...j } : null
    },
    async updateJob(id, patch) {
      const j = jobs.get(id)
      if (j) jobs.set(id, { ...j, ...patch })
    },
    async jobsOf(companyId) {
      // Jobs and the Tally data they hold are kept 30 minutes
      for (const [id, j] of jobs) if (Date.now() - j.createdAt > 30 * 60 * 1000) jobs.delete(id)
      return [...jobs.values()].filter((j) => j.companyId === companyId).map((j) => ({ ...j }))
    },
  }
}

// One store per process; kept on globalThis so dev-server reloads don't drop it
const g = globalThis as unknown as { __tallyConnectorStore?: ConnectorStore }
export function connectorStore(): ConnectorStore {
  g.__tallyConnectorStore ??= memoryStore()
  return g.__tallyConnectorStore
}
/** Tests only. */
export function resetConnectorStore(store: ConnectorStore = memoryStore()) {
  g.__tallyConnectorStore = store
  pairFails.clear()
  issued.clear()
  lastBeat.clear()
  watching.clear()
}

// ---------------------------------------------------------------- helpers

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

export function normalizeCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const s = raw.toUpperCase().replace(/[\s-]/g, '')
  if (s.length !== 10 || [...s].some((ch) => !CODE_ALPHABET.includes(ch))) return null
  return s
}

function newCode(): string {
  let s = ''
  for (let i = 0; i < 10; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]
  return s
}

const formatCode = (s: string) => `${s.slice(0, 5)}-${s.slice(5)}`

function sameHash(a: string, b: string) {
  const x = Buffer.from(a, 'hex')
  const y = Buffer.from(b, 'hex')
  return x.length === y.length && timingSafeEqual(x, y)
}

// In-memory rate limits (single process, like the login throttle)
const pairFails = new Map<string, { count: number; first: number }>()
const issued = new Map<string, number[]>()
const lastBeat = new Map<string, number>()
// Companies whose Tally screen is open: their connector checks in every 5 s instead of 30 s, so jobs start quickly
const watching = new Map<string, number>()
const WATCH_MS = 2 * 60 * 1000
export function markWatching(companyId: string) {
  watching.set(companyId, Date.now())
}

// ---------------------------------------------------------------- operations

/** Admin action: a fresh pairing code for the company (shown once; replaces any open code). */
export async function issuePairingCode(companyId: string, createdBy: string, store = connectorStore()) {
  const now = Date.now()
  const recent = (issued.get(companyId) ?? []).filter((t) => now - t < ISSUE_WINDOW_MS)
  if (recent.length >= ISSUE_MAX) throw new ApiError('Too many pairing codes were created in the last hour — try again later', 429, 'RATE_LIMITED')
  issued.set(companyId, [...recent, now])

  const code = newCode()
  await store.dropPairings(companyId)
  await store.putPairing({ codeHash: sha256(code), companyId, createdBy, expiresAt: now + PAIRING_TTL_MS })
  return { code: formatCode(code), expiresAt: new Date(now + PAIRING_TTL_MS).toISOString() }
}

/** Connector action: exchange a pairing code for a connector token (returned once). */
export async function pairConnector(rawCode: unknown, ip: string, info: { version?: unknown; platform?: unknown }, store = connectorStore()) {
  const now = Date.now()
  const f = pairFails.get(ip)
  if (f && now - f.first < PAIR_FAIL_WINDOW_MS && f.count >= PAIR_MAX_FAILS) {
    throw new ApiError('Too many wrong pairing codes — wait 15 minutes and create a new code in ManuFlow', 429, 'RATE_LIMITED')
  }
  const failed = (message: string, code: string): never => {
    const cur = pairFails.get(ip)
    if (!cur || now - cur.first >= PAIR_FAIL_WINDOW_MS) pairFails.set(ip, { count: 1, first: now })
    else cur.count++
    throw new ApiError(message, 401, code)
  }

  const code = normalizeCode(rawCode)
  if (!code) return failed('That is not a valid pairing code', 'PAIRING_CODE_INVALID')
  const pairing = await store.takePairing(sha256(code)) // consumed even if it turns out to be expired
  if (!pairing) return failed('This pairing code is wrong or was already used — create a new code in ManuFlow', 'PAIRING_CODE_INVALID')
  if (pairing.expiresAt <= now) return failed('This pairing code has expired — create a new code in ManuFlow', 'PAIRING_CODE_EXPIRED')

  // Reconnect: the company's earlier connector stops working
  const old = await store.activeConnector(pairing.companyId)
  if (old) await store.updateConnector(old.id, { revokedAt: now })
  await store.dropPairings(pairing.companyId)

  const id = randomBytes(12).toString('hex')
  const secret = randomBytes(32).toString('base64url')
  await store.putConnector({
    id, companyId: pairing.companyId, secretHash: sha256(secret), pairedAt: now, pairedBy: pairing.createdBy,
    revokedAt: null, lastSeenAt: null, lastTallyStatus: null, lastTallyCheckAt: null, lastTallySuccessAt: null,
    lastLatencyMs: null, tallyEndpoint: null, version: shortText(info.version, 20), platform: shortText(info.platform, 20),
  })
  pairFails.delete(ip)
  return { companyId: pairing.companyId, connectorId: id, token: `mftc_${id}_${secret}`, replacedConnector: !!old }
}

/** Connector requests: the active connector for a bearer token, or 401. */
export async function authenticateConnector(req: Request, store = connectorStore()): Promise<ConnectorRecord> {
  const auth = req.headers.get('authorization') || ''
  const m = TOKEN_RE.exec(auth.replace(/^Bearer\s+/i, '').trim())
  const c = m ? await store.getConnector(m[1]) : null
  if (!m || !c || !sameHash(c.secretHash, sha256(m[2]))) throw new ApiError('Connector token is not valid', 401, 'CONNECTOR_UNAUTHORIZED')
  if (c.revokedAt) throw new ApiError('This connector was disconnected in ManuFlow — pair it again', 401, 'CONNECTOR_REVOKED')
  return c
}

function shortText(v: unknown, max: number): string | null {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null
}

// host:port of a loopback / private LAN address (the connector refuses anything else)
const ENDPOINT_RE = /^(localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}):\d{1,5}$/

export interface HeartbeatReply {
  nextHeartbeatSec: number
  job?: { id: string; type: TallyJobType; company?: string }
}

export async function recordHeartbeat(c: ConnectorRecord, body: unknown, store = connectorStore()): Promise<HeartbeatReply> {
  const now = Date.now()
  const prev = lastBeat.get(c.id)
  if (prev && now - prev < HEARTBEAT_MIN_INTERVAL_MS) throw new ApiError('Heartbeats are too frequent', 429, 'RATE_LIMITED')
  lastBeat.set(c.id, now)

  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const t = (b.tally && typeof b.tally === 'object' ? b.tally : {}) as Record<string, unknown>
  const status = TALLY_CHECK_STATUSES.includes(t.status as ConnectorTallyStatus) ? t.status as ConnectorTallyStatus : null
  if (!status) throw new ApiError('Heartbeat must include tally.status', 400, 'INVALID_HEARTBEAT')
  const latency = typeof t.latencyMs === 'number' && Number.isFinite(t.latencyMs) && t.latencyMs >= 0 && t.latencyMs < 600000 ? Math.round(t.latencyMs) : null
  const endpoint = typeof t.endpoint === 'string' && ENDPOINT_RE.test(t.endpoint) ? t.endpoint : null

  await store.updateConnector(c.id, {
    lastSeenAt: now,
    lastTallyStatus: status,
    lastTallyCheckAt: now,
    lastTallySuccessAt: status === 'connected' ? now : c.lastTallySuccessAt,
    lastLatencyMs: latency,
    tallyEndpoint: endpoint,
    version: shortText(b.version, 20) ?? c.version,
    platform: shortText(b.platform, 20) ?? c.platform,
  })
  // At most one named job; nothing else is ever sent to the connector
  const job = await takeNextJob(c, store)
  const fast = job || Date.now() - (watching.get(c.companyId) ?? 0) < WATCH_MS
  return job ? { nextHeartbeatSec: 5, job } : { nextHeartbeatSec: fast ? 5 : 30 }
}

export const JOB_RUN_LIMIT_MS = 3 * 60 * 1000

async function takeNextJob(c: ConnectorRecord, store: ConnectorStore): Promise<HeartbeatReply['job'] | undefined> {
  const now = Date.now()
  const mine = (await store.jobsOf(c.companyId)).filter((j) => j.connectorId === c.id)
  for (const j of mine) {
    // The connector took it but never answered (closed, crashed, Tally hung)
    if (j.status === 'running' && j.startedAt && now - j.startedAt > JOB_RUN_LIMIT_MS) {
      await store.updateJob(j.id, { status: 'failed', error: 'timeout', finishedAt: now })
    }
  }
  if (mine.some((j) => j.status === 'running' && j.startedAt && now - j.startedAt <= JOB_RUN_LIMIT_MS)) return undefined
  const next = mine.filter((j) => j.status === 'queued').sort((a, b) => a.createdAt - b.createdAt)[0]
  if (!next) return undefined
  await store.updateJob(next.id, { status: 'running', startedAt: now })
  return { id: next.id, type: next.type, ...(next.tallyCompany ? { company: next.tallyCompany } : {}) }
}

export async function revokeConnector(companyId: string, store = connectorStore()) {
  const c = await store.activeConnector(companyId)
  await store.dropPairings(companyId)
  if (c) await store.updateConnector(c.id, { revokedAt: Date.now() })
  for (const j of await store.jobsOf(companyId)) {
    if (j.status === 'queued' || j.status === 'running') await store.updateJob(j.id, { status: 'cancelled', finishedAt: Date.now() })
  }
  return { revoked: !!c }
}

// ---------------------------------------------------------------- status for the UI

export type ConnectorState = 'unavailable' | 'not_paired' | 'pairing' | 'connected' | 'tally_error' | 'offline'

export interface ConnectorStatus {
  state: ConnectorState
  message: string
  pairingExpiresAt?: string
  connector?: {
    pairedAt: string
    lastSeenAt: string | null
    lastSuccessAt: string | null
    tallyStatus: ConnectorTallyStatus | null
    tallyEndpoint: string | null
    latencyMs: number | null
    version: string | null
    platform: string | null
  }
}

const TALLY_MESSAGES: Record<ConnectorTallyStatus, string> = {
  connected: 'The connector is online and TallyPrime is answering.',
  unreachable: 'The connector is online but cannot reach TallyPrime. Open TallyPrime with a company loaded and set Exchange → Data Synchronization → “TallyPrime act as” to Server or Both.',
  timeout: 'The connector is online but TallyPrime did not answer in time. Check that TallyPrime is open, a company is loaded and no dialog is waiting.',
  invalid_response: 'Something answered at the Tally address, but it is not TallyPrime. Check the port number set in the connector (usually 9000).',
  invalid_config: 'The Tally address set in the connector is not allowed. Use this computer (127.0.0.1) or a private network address, e.g. 192.168.1.20:9000.',
}

const iso = (t: number | null) => (t ? new Date(t).toISOString() : null)

export async function connectorStatus(companyId: string, store = connectorStore()): Promise<ConnectorStatus> {
  if (!connectorFeatureEnabled()) {
    return { state: 'unavailable', message: 'The ManuFlow Tally Connector is not available on this server yet. Export a report from Tally to Excel / CSV and import that file instead.' }
  }
  const c = await store.activeConnector(companyId)
  const pairing = await store.openPairing(companyId)
  if (!c) {
    if (pairing) return { state: 'pairing', message: 'Waiting for the connector to be paired with the code.', pairingExpiresAt: iso(pairing.expiresAt)! }
    return { state: 'not_paired', message: 'No connector is paired with this company.' }
  }
  const connector = {
    pairedAt: iso(c.pairedAt)!, lastSeenAt: iso(c.lastSeenAt), lastSuccessAt: iso(c.lastTallySuccessAt),
    tallyStatus: c.lastTallyStatus, tallyEndpoint: c.tallyEndpoint, latencyMs: c.lastLatencyMs, version: c.version, platform: c.platform,
  }
  const extra = pairing ? { pairingExpiresAt: iso(pairing.expiresAt)! } : {}
  if (!c.lastSeenAt || Date.now() - c.lastSeenAt > ONLINE_WINDOW_MS) {
    return {
      state: 'offline', connector, ...extra,
      message: c.lastSeenAt
        ? 'The connector has not checked in for over a minute. Check that the computer running it is on, connected to the internet, and the connector is running.'
        : 'The connector is paired but has not checked in yet. Start it with “run” on the computer in your office.',
    }
  }
  if (c.lastTallyStatus !== 'connected') return { state: 'tally_error', connector, ...extra, message: TALLY_MESSAGES[c.lastTallyStatus ?? 'unreachable'] }
  return { state: 'connected', connector, ...extra, message: TALLY_MESSAGES.connected }
}
