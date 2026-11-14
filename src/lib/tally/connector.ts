import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { Prisma, type TallyConnector } from '@prisma/client'
import { db } from '@/lib/db'
import { ApiError } from '@/lib/erp-helpers'

/**
 * ManuFlow Tally Connector — server side. Read-only: TallyPrime → ManuFlow.
 *
 * TallyPrime runs on the customer's Windows PC; a cloud ManuFlow cannot reach it. A small connector program on a
 * computer in the customer's network connects OUT to ManuFlow over HTTPS:
 *
 *  1. An admin clicks "Connect Tally" → issuePairingCode(): a 10-character code, valid 10 minutes, single use,
 *     stored only as a SHA-256 hash, one open code per company (a new one replaces the old).
 *  2. The connector sends the code once → pairConnector(): the code is claimed with a conditional update (only one
 *     request can win it) and a connector token is returned ONCE (`mftc_<id>_<secret>`; only the hash of the secret is
 *     kept). Pairing revokes any earlier connector of the company: TallyConnector.activeFor is unique, so a company
 *     never has two active connectors. The connector also sends its device identity (a random id it made itself, plus
 *     the computer's name): the token is bound to that id, and a heartbeat with another id is refused
 *     (CONNECTOR_DEVICE_MISMATCH). This one-time pairing is the device authorisation: after it the connector reconnects
 *     by itself, after restarts and interruptions, without a new code.
 *  3. The connector sends a heartbeat every 5–30 s with the result of its own read-only check of Tally →
 *     recordHeartbeat(). Every 7 days the reply carries a new token once (see "Token rotation" below).
 *  4. Disconnect → revokeConnector(): the token stops working at once (401 CONNECTOR_REVOKED, sent only to a request
 *     that proved it holds the token); the connector then deletes it. No other answer makes the connector delete it.
 *
 * 5. Jobs (src/lib/tally/jobs.ts): the reply to a heartbeat may carry ONE named job from a fixed list (company list,
 *    customers, suppliers, stock items, groups, ledgers, stock groups, units, godowns) plus a Tally company name taken from Tally's own company list. The connector
 *    builds the read-only Export XML itself and posts normalised records back. Never a URL, XML or free command.
 *
 * Storage: the TallyPairingCode / TallyConnector / TallyJob / TallyJobChunk / TallyRateLimit tables, so pairing, jobs
 * and rate limits survive restarts and are shared between server processes. cleanupTallyTables() deletes expired rows
 * of those five tables only. OFF unless TALLY_CONNECTOR_POC=1.
 */

export const PAIRING_TTL_MS = 10 * 60 * 1000
export const ONLINE_WINDOW_MS = 90 * 1000
/** The connector retries at most every 5 minutes after an interruption: a gap up to this long is "reconnecting". */
export const RECONNECT_WINDOW_MS = 6 * 60 * 1000
export const HEARTBEAT_MIN_INTERVAL_MS = 5 * 1000
export const TOKEN_ROTATE_MS = 7 * 24 * 60 * 60 * 1000
/**
 * Token rotation is two-step, so a lost reply can never lock a connector out:
 *  - the server stores the new secret and keeps the previous one (prevSecretHash) as the connector's way back;
 *  - the first request with the new token clears the previous one (normally the next heartbeat, seconds later);
 *  - a request with the previous token (the reply was lost, or the connector was offline) gets a fresh token, and the
 *    previous one stays usable — but never past TOKEN_RECOVERY_MS after the rotation. That limit is set once, when the
 *    token is rotated, and is never extended; after it the connector must be paired again (CONNECTOR_TOKEN_EXPIRED).
 * So a connector offline for days or weeks reconnects by itself, and no secret is usable for more than
 * TOKEN_ROTATE_MS + TOKEN_RECOVERY_MS after it was issued. Revocation still ends every token at once.
 */
export const TOKEN_RECOVERY_MS = 30 * 24 * 60 * 60 * 1000
/** A job the connector took but did not answer within this time is re-queued once, then failed. */
export const JOB_RUN_LIMIT_MS = 3 * 60 * 1000
export const JOB_MAX_ATTEMPTS = 2
const PAIR_FAIL_WINDOW_MS = 15 * 60 * 1000
const PAIR_MAX_FAILS = 10
const ISSUE_WINDOW_MS = 60 * 60 * 1000
const ISSUE_MAX = 10
const WATCH_MS = 2 * 60 * 1000

/** How long rows of the Tally connector tables are kept. Revoked connectors are kept as history. */
export const RETENTION = {
  chunksMs: 24 * 60 * 60 * 1000, // the Tally records a job read
  jobsMs: 30 * 24 * 60 * 60 * 1000,
  pairingCodesMs: 24 * 60 * 60 * 1000, // after expiry
  rateLimitsMs: 2 * 60 * 60 * 1000, // after the last hit (longest window: 1 hour)
}
const CLEANUP_EVERY_MS = 10 * 60 * 1000

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789' // no 0/O, 1/I/L
const TOKEN_RE = /^mftc_([a-f0-9]{24})_([A-Za-z0-9_-]{43})$/

/** Connectors older than this get no jobs (they must be updated); older than the latest are told an update exists. */
export const CONNECTOR_MIN_VERSION = '0.2.0'
export const CONNECTOR_LATEST_VERSION = '0.4.0'
const DEVICE_ID_RE = /^[a-f0-9]{32}$/
const VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/

/** Is version a older than version b? (numeric x.y.z; anything unreadable counts as 0; same rule as the connector) */
export function olderThan(a: string, b: string) {
  const pa = a.split('.').map((x) => Number.parseInt(x, 10) || 0)
  const pb = b.split('.').map((x) => Number.parseInt(x, 10) || 0)
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0)
  return false
}
/** Only a well-formed version is judged; a connector reporting something else is not blocked on a guess. */
const isOlder = (v: string | null | undefined, than: string) => !!v && VERSION_RE.test(v) && olderThan(v, than)
export const connectorOutdated = (c: Pick<TallyConnector, 'version'>) => isOlder(c.version, CONNECTOR_MIN_VERSION)

export const TALLY_CHECK_STATUSES = ['connected', 'unreachable', 'timeout', 'invalid_response', 'invalid_config'] as const
export type ConnectorTallyStatus = (typeof TALLY_CHECK_STATUSES)[number]

/** Read-only: every job is a fixed Export request built by the connector. Nothing writes to Tally. */
export const TALLY_JOB_TYPES = [
  'list-companies', 'export-customers', 'export-suppliers', 'export-items',
  // masters kept as a source copy only (Layer 1, src/lib/tally/layer1.ts)
  'export-groups', 'export-ledgers', 'export-stockgroups', 'export-units', 'export-godowns',
  // connector 0.4.0 and newer (MIN_JOB_VERSION in jobs.ts)
  'export-costcentres',
] as const
export type TallyJobType = (typeof TALLY_JOB_TYPES)[number]
export type TallyJobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled'
export const OPEN_JOB_STATUSES: TallyJobStatus[] = ['queued', 'running']

export function connectorFeatureEnabled(env: Record<string, string | undefined> = process.env) {
  return env.TALLY_CONNECTOR_POC === '1'
}

export function assertConnectorEnabled() {
  if (!connectorFeatureEnabled()) {
    throw new ApiError('The ManuFlow Tally Connector is not available on this server yet', 503, 'TALLY_CONNECTOR_UNAVAILABLE')
  }
}

// ---------------------------------------------------------------- helpers

// Date.now() (not the database clock) so every comparison uses one clock
const now = () => new Date(Date.now())
const ago = (at: Date, ms: number) => new Date(at.getTime() - ms)
const later = (at: Date, ms: number) => new Date(at.getTime() + ms)

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

function shortText(v: unknown, max: number): string | null {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null
}

const deviceIdOf = (v: unknown) => (typeof v === 'string' && DEVICE_ID_RE.test(v) ? v : null)
const deviceNameOf = (v: unknown) => (typeof v === 'string' ? shortText(v.replace(/[^\w.\- ]/g, ''), 60) : null)

// ---------------------------------------------------------------- rate limits (shared, in TallyRateLimit)

/** Hits of `key` in its current fixed window. */
async function hitsInWindow(key: string, windowMs: number, at: Date) {
  const r = await db.tallyRateLimit.findUnique({ where: { key } })
  return r && r.windowStart > ago(at, windowMs) ? r.count : 0
}

/** One more hit of `key`; a window that has run out starts again at 1. Atomic across processes. */
async function countHit(key: string, windowMs: number, at: Date) {
  const cutoff = ago(at, windowMs)
  await db.$executeRaw`INSERT INTO TallyRateLimit (\`key\`, windowStart, count, updatedAt) VALUES (${key}, ${at}, 1, ${at})
    ON DUPLICATE KEY UPDATE count = IF(windowStart <= ${cutoff}, 1, count + 1), windowStart = IF(windowStart <= ${cutoff}, ${at}, windowStart), updatedAt = ${at}`
}

// ---------------------------------------------------------------- cleanup (Tally connector tables only)

/**
 * Deletes expired rows of the Tally connector tables — never anything else. Revoked connectors are kept.
 * Returns how many rows went from each table.
 */
export async function cleanupTallyTables(at = now()) {
  const [chunks, jobs, pairingCodes, rateLimits] = await db.$transaction([
    db.tallyJobChunk.deleteMany({ where: { createdAt: { lt: ago(at, RETENTION.chunksMs) } } }),
    db.tallyJob.deleteMany({ where: { createdAt: { lt: ago(at, RETENTION.jobsMs) } } }),
    db.tallyPairingCode.deleteMany({ where: { expiresAt: { lt: ago(at, RETENTION.pairingCodesMs) } } }),
    db.tallyRateLimit.deleteMany({ where: { updatedAt: { lt: ago(at, RETENTION.rateLimitsMs) } } }),
  ])
  return { chunks: chunks.count, jobs: jobs.count, pairingCodes: pairingCodes.count, rateLimits: rateLimits.count }
}

let lastCleanup = 0
async function cleanupNowAndThen() {
  if (Date.now() - lastCleanup < CLEANUP_EVERY_MS) return
  lastCleanup = Date.now()
  try {
    await cleanupTallyTables()
  } catch {
    // retried next time; expired rows are never read anyway
  }
}

/** Tests only: run the cleanup on the next request again. */
export function resetCleanupTimer() {
  lastCleanup = 0
}

/** Companies whose Tally screen is open: their connector checks in every 5 s instead of 30 s, so jobs start quickly. */
export async function markWatching(companyId: string) {
  await db.tallyConnector.updateMany({ where: { activeFor: companyId }, data: { fastPollUntil: later(now(), WATCH_MS) } })
}

// ---------------------------------------------------------------- operations

/** Admin action: a fresh pairing code for the company (shown once; replaces any open code). */
export async function issuePairingCode(companyId: string, createdBy: string) {
  const at = now()
  const key = `issue:${companyId}`
  if ((await hitsInWindow(key, ISSUE_WINDOW_MS, at)) >= ISSUE_MAX) {
    throw new ApiError('Too many pairing codes were created in the last hour — try again later', 429, 'RATE_LIMITED')
  }
  await countHit(key, ISSUE_WINDOW_MS, at)
  await cleanupNowAndThen()

  const code = newCode()
  const expiresAt = later(at, PAIRING_TTL_MS)
  await db.$transaction([
    db.tallyPairingCode.updateMany({ where: { companyId, usedAt: null, expiresAt: { gt: at } }, data: { expiresAt: at } }),
    db.tallyPairingCode.create({ data: { companyId, codeHash: sha256(code), createdBy, expiresAt, createdAt: at } }),
  ])
  return { code: formatCode(code), expiresAt: expiresAt.toISOString() }
}

/** Connector action: exchange a pairing code for a connector token (returned once). */
export async function pairConnector(rawCode: unknown, ip: string, info: { version?: unknown; platform?: unknown; deviceId?: unknown; deviceName?: unknown }) {
  const at = now()
  const ipKey = `pair-ip:${sha256(ip)}`
  if ((await hitsInWindow(ipKey, PAIR_FAIL_WINDOW_MS, at)) >= PAIR_MAX_FAILS) {
    throw new ApiError('Too many wrong pairing codes — wait 15 minutes and create a new code in ManuFlow', 429, 'RATE_LIMITED')
  }
  const failed = async (message: string, code: string): Promise<never> => {
    await countHit(ipKey, PAIR_FAIL_WINDOW_MS, at)
    throw new ApiError(message, 401, code)
  }

  const code = normalizeCode(rawCode)
  if (!code) return failed('That is not a valid pairing code', 'PAIRING_CODE_INVALID')

  const id = randomBytes(12).toString('hex')
  const secret = randomBytes(32).toString('base64url')
  const deviceId = deviceIdOf(info.deviceId)
  let outcome: 'invalid' | 'expired' | { companyId: string; replaced: boolean; sameDevice: boolean }
  try {
    outcome = await db.$transaction(async (tx) => {
      const p = await tx.tallyPairingCode.findUnique({ where: { codeHash: sha256(code) } })
      if (!p || p.usedAt) return 'invalid' as const
      // Single use: of two requests with the same code only one changes the row
      const claimed = await tx.tallyPairingCode.updateMany({ where: { id: p.id, usedAt: null }, data: { usedAt: at } })
      if (claimed.count !== 1) return 'invalid' as const
      if (p.expiresAt <= at) return 'expired' as const // consumed all the same

      // Reconnect: the company's earlier connector stops working, its waiting jobs with it
      const old = await tx.tallyConnector.findUnique({ where: { activeFor: p.companyId } })
      if (old) {
        await tx.tallyConnector.updateMany({ where: { id: old.id }, data: { activeFor: null, revokedAt: at } })
        await tx.tallyJob.updateMany({ where: { connectorId: old.id, status: { in: OPEN_JOB_STATUSES } }, data: { status: 'cancelled', finishedAt: at, leaseUntil: null } })
      }
      await tx.tallyPairingCode.updateMany({ where: { companyId: p.companyId, usedAt: null, expiresAt: { gt: at } }, data: { expiresAt: at } })
      await tx.tallyConnector.create({
        data: {
          id, companyId: p.companyId, activeFor: p.companyId, secretHash: sha256(secret), pairedAt: at, pairedBy: p.createdBy,
          version: shortText(info.version, 20), platform: shortText(info.platform, 20), deviceId, deviceName: deviceNameOf(info.deviceName),
          createdAt: at,
        },
      })
      return { companyId: p.companyId, replaced: !!old, sameDevice: !!old?.deviceId && old.deviceId === deviceId }
    })
  } catch (e) {
    // Two codes of one company used at the same moment: activeFor is unique (P2002) or MySQL picks a deadlock victim
    // (P2034). Either way that pairing is rolled back whole, its code unused.
    if (e instanceof Prisma.PrismaClientKnownRequestError && (e.code === 'P2002' || e.code === 'P2034')) {
      throw new ApiError('Another connector was being paired for this company at the same moment — try again', 409, 'PAIRING_CONFLICT')
    }
    throw e
  }
  if (outcome === 'invalid') return failed('This pairing code is wrong or was already used — create a new code in ManuFlow', 'PAIRING_CODE_INVALID')
  if (outcome === 'expired') return failed('This pairing code has expired — create a new code in ManuFlow', 'PAIRING_CODE_EXPIRED')
  await db.tallyRateLimit.deleteMany({ where: { key: ipKey } })
  return { companyId: outcome.companyId, connectorId: id, token: `mftc_${id}_${secret}`, replacedConnector: outcome.replaced, sameDevice: outcome.sameDevice }
}

/** A connector that proved it holds a token; `via` says whether that was the current or the previous (rotated) one. */
export type AuthedConnector = TallyConnector & { via: 'current' | 'previous' }

/** Connector requests: the active connector for a bearer token, or 401. */
export async function authenticateConnector(req: Request): Promise<AuthedConnector> {
  const auth = req.headers.get('authorization') || ''
  const m = TOKEN_RE.exec(auth.replace(/^Bearer\s+/i, '').trim())
  const c = m ? await db.tallyConnector.findUnique({ where: { id: m[1] } }) : null
  const hash = m ? sha256(m[2]) : ''
  const via = !c ? null
    : sameHash(c.secretHash, hash) ? 'current' as const
      : c.prevSecretHash && sameHash(c.prevSecretHash, hash) ? (c.prevValidUntil && c.prevValidUntil > now() ? 'previous' as const : 'expired' as const)
        : null
  if (!c || !via) throw new ApiError('Connector token is not valid', 401, 'CONNECTOR_UNAUTHORIZED')
  // Only a request that proved it holds the token learns that it was revoked (the connector then deletes it)
  if (c.revokedAt) throw new ApiError('This connector was disconnected in ManuFlow — pair it again', 401, 'CONNECTOR_REVOKED')
  if (via === 'expired') {
    await recordAuthFailure(c.id, 'token_expired')
    throw new ApiError('This connector was offline too long to reconnect by itself — pair it again', 401, 'CONNECTOR_TOKEN_EXPIRED')
  }
  return { ...c, via }
}

/** Shown to the admins (state auth_failed) until the connector gets through again. Only for requests that proved the token. */
async function recordAuthFailure(id: string, reason: 'token_expired' | 'device_mismatch') {
  await db.tallyConnector.updateMany({ where: { id, revokedAt: null }, data: { authFailure: reason, authFailedAt: now() } })
}

/** A new secret for the connector, unless something else changed it meanwhile. → the new token, or undefined. */
async function issueSecret(c: TallyConnector, at: Date, prev: { prevSecretHash: string | null; prevValidUntil: Date | null }) {
  const secret = randomBytes(32).toString('base64url')
  const r = await db.tallyConnector.updateMany({
    where: { id: c.id, secretHash: c.secretHash, revokedAt: null },
    data: { secretHash: sha256(secret), ...prev, rotatedAt: at },
  })
  return r.count === 1 ? `mftc_${c.id}_${secret}` : undefined
}

async function rotateIfDue(c: AuthedConnector, at: Date): Promise<string | undefined> {
  // Still on the previous token: the reply that carried the new one was lost. A fresh one; the recovery limit is not extended.
  if (c.via === 'previous') return issueSecret(c, at, { prevSecretHash: c.prevSecretHash, prevValidUntil: c.prevValidUntil })
  if (at.getTime() - (c.rotatedAt ?? c.pairedAt).getTime() >= TOKEN_ROTATE_MS) {
    return issueSecret(c, at, { prevSecretHash: c.secretHash, prevValidUntil: later(at, TOKEN_RECOVERY_MS) })
  }
  // The connector uses the new token: the previous one is no longer needed
  if (c.prevSecretHash) {
    await db.tallyConnector.updateMany({ where: { id: c.id, secretHash: c.secretHash }, data: { prevSecretHash: null, prevValidUntil: null } })
  }
  return undefined
}

// host:port of a loopback / private LAN address (the connector refuses anything else)
const ENDPOINT_RE = /^(localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}):\d{1,5}$/

export interface HeartbeatReply {
  nextHeartbeatSec: number
  /** The connector compares these with its own version and tells its user to update. */
  minVersion: string
  latestVersion: string
  job?: { id: string; type: TallyJobType; company?: string }
  /** Rotated connector token, sent once; the connector saves it in place of the old one. */
  newToken?: string
}

export async function recordHeartbeat(c: AuthedConnector, body: unknown): Promise<HeartbeatReply> {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const t = (b.tally && typeof b.tally === 'object' ? b.tally : {}) as Record<string, unknown>
  const status = TALLY_CHECK_STATUSES.includes(t.status as ConnectorTallyStatus) ? t.status as ConnectorTallyStatus : null
  if (!status) throw new ApiError('Heartbeat must include tally.status', 400, 'INVALID_HEARTBEAT')
  const latency = typeof t.latencyMs === 'number' && Number.isFinite(t.latencyMs) && t.latencyMs >= 0 && t.latencyMs < 600000 ? Math.round(t.latencyMs) : null
  const endpoint = typeof t.endpoint === 'string' && ENDPOINT_RE.test(t.endpoint) ? t.endpoint : null
  // The token works only from the computer it was paired on (or, for a connector paired before 0.3.0, the first
  // identity it reports). A connector that sends none keeps working until it has one.
  const deviceId = deviceIdOf(b.deviceId)
  if (c.deviceId && deviceId !== c.deviceId) {
    await recordAuthFailure(c.id, 'device_mismatch')
    throw new ApiError('This token belongs to another computer — pair this computer with its own code', 401, 'CONNECTOR_DEVICE_MISMATCH')
  }

  const at = now()
  // At most one heartbeat per 5 s, across all server processes
  const beat = await db.tallyConnector.updateMany({
    where: { id: c.id, revokedAt: null, OR: [{ lastSeenAt: null }, { lastSeenAt: { lte: ago(at, HEARTBEAT_MIN_INTERVAL_MS) } }] },
    data: {
      lastSeenAt: at,
      lastTallyStatus: status,
      lastTallyCheckAt: at,
      lastTallySuccessAt: status === 'connected' ? at : c.lastTallySuccessAt,
      lastLatencyMs: latency,
      tallyEndpoint: endpoint,
      version: shortText(b.version, 20) ?? c.version,
      platform: shortText(b.platform, 20) ?? c.platform,
      deviceName: deviceNameOf(b.deviceName) ?? c.deviceName,
      authFailure: null,
      authFailedAt: null,
    },
  })
  if (beat.count !== 1) throw new ApiError('Heartbeats are too frequent', 429, 'RATE_LIMITED')
  // Bound once: two heartbeats racing with different ids cannot both bind (the second one is refused next time)
  if (!c.deviceId && deviceId) await db.tallyConnector.updateMany({ where: { id: c.id, deviceId: null }, data: { deviceId } })
  await cleanupNowAndThen()

  const newToken = await rotateIfDue(c, at)
  const version = shortText(b.version, 20) ?? c.version
  // At most one named job; nothing else is ever sent to the connector. A connector too old for this server gets none.
  const job = isOlder(version, CONNECTOR_MIN_VERSION) ? undefined : await takeNextJob(c, at)
  const fast = job || (c.fastPollUntil && c.fastPollUntil > at)
  return {
    nextHeartbeatSec: fast ? 5 : 30, minVersion: CONNECTOR_MIN_VERSION, latestVersion: CONNECTOR_LATEST_VERSION,
    ...(job ? { job } : {}), ...(newToken ? { newToken } : {}),
  }
}

/** The connector's next job, claimed for it (exported for the concurrency tests). */
export async function takeNextJob(c: TallyConnector, at = now()): Promise<HeartbeatReply['job'] | undefined> {
  const types = [...TALLY_JOB_TYPES]
  // A job of any other type is never handed out (this code cannot create one; refuse it if it is ever planted)
  await db.tallyJob.updateMany({
    where: { connectorId: c.id, status: { in: OPEN_JOB_STATUSES }, type: { notIn: types } },
    data: { status: 'failed', error: 'tally_error', finishedAt: at, leaseUntil: null },
  })
  // Lease ran out: the connector took the job but never answered (closed, crashed, Tally hung). Once more, then failed.
  await db.tallyJob.updateMany({
    where: { connectorId: c.id, status: 'running', leaseUntil: { lt: at }, attempt: { lt: JOB_MAX_ATTEMPTS } },
    data: { status: 'queued', startedAt: null, leaseUntil: null },
  })
  await db.tallyJob.updateMany({
    where: { connectorId: c.id, status: 'running', leaseUntil: { lt: at } },
    data: { status: 'failed', error: 'timeout', finishedAt: at, leaseUntil: null },
  })
  if (await db.tallyJob.count({ where: { connectorId: c.id, status: 'running' } })) return undefined
  for (let i = 0; i < 3; i++) {
    const next = await db.tallyJob.findFirst({
      where: { connectorId: c.id, status: 'queued', type: { in: types } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    })
    if (!next) return undefined
    // Claimed only if still queued: two server processes can never hand out the same job
    const claimed = await db.tallyJob.updateMany({
      where: { id: next.id, status: 'queued' },
      data: { status: 'running', startedAt: at, leaseUntil: later(at, JOB_RUN_LIMIT_MS), attempt: { increment: 1 } },
    })
    if (claimed.count === 1) return { id: next.id, type: next.type as TallyJobType, ...(next.tallyCompany ? { company: next.tallyCompany } : {}) }
  }
  return undefined
}

export async function revokeConnector(companyId: string) {
  const at = now()
  return db.$transaction(async (tx) => {
    const r = await tx.tallyConnector.updateMany({ where: { activeFor: companyId }, data: { activeFor: null, revokedAt: at } })
    await tx.tallyPairingCode.updateMany({ where: { companyId, usedAt: null, expiresAt: { gt: at } }, data: { expiresAt: at } })
    await tx.tallyJob.updateMany({ where: { companyId, status: { in: OPEN_JOB_STATUSES } }, data: { status: 'cancelled', finishedAt: at, leaseUntil: null } })
    return { revoked: r.count > 0 }
  })
}

// ---------------------------------------------------------------- status for the UI

export type ConnectorState =
  | 'unavailable' | 'not_paired' | 'pairing' | 'connecting' | 'connected' | 'tally_error' | 'reconnecting' | 'offline' | 'auth_failed' | 'outdated'

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
    deviceName: string | null
    updateAvailable: boolean
  }
}

const TALLY_MESSAGES: Record<ConnectorTallyStatus, string> = {
  connected: 'The connector is online and TallyPrime is answering.',
  unreachable: 'The connector is online but cannot reach TallyPrime. Open TallyPrime with a company loaded and set Exchange → Data Synchronization → “TallyPrime act as” to Server or Both.',
  timeout: 'The connector is online but TallyPrime did not answer in time. Check that TallyPrime is open, a company is loaded and no dialog is waiting.',
  invalid_response: 'Something answered at the Tally address, but it is not TallyPrime. Check the port number set in the connector (usually 9000).',
  invalid_config: 'The Tally address set in the connector is not allowed. Use this computer (127.0.0.1) or a private network address, e.g. 192.168.1.20:9000.',
}

const iso = (t: Date | null) => (t ? t.toISOString() : null)

export async function connectorStatus(companyId: string): Promise<ConnectorStatus> {
  if (!connectorFeatureEnabled()) {
    return { state: 'unavailable', message: 'The ManuFlow Tally Connector is not available on this server yet. Export a report from Tally to Excel / CSV and import that file instead.' }
  }
  const at = now()
  const c = await db.tallyConnector.findUnique({ where: { activeFor: companyId } })
  const pairing = await db.tallyPairingCode.findFirst({ where: { companyId, usedAt: null, expiresAt: { gt: at } }, orderBy: { expiresAt: 'desc' } })
  if (!c) {
    if (pairing) return { state: 'pairing', message: 'Waiting for the connector to be paired with the code.', pairingExpiresAt: iso(pairing.expiresAt)! }
    return { state: 'not_paired', message: 'No connector is paired with this company.' }
  }
  const connector = {
    pairedAt: iso(c.pairedAt)!, lastSeenAt: iso(c.lastSeenAt), lastSuccessAt: iso(c.lastTallySuccessAt),
    tallyStatus: c.lastTallyStatus as ConnectorTallyStatus | null, tallyEndpoint: c.tallyEndpoint, latencyMs: c.lastLatencyMs,
    version: c.version, platform: c.platform, deviceName: c.deviceName,
    updateAvailable: isOlder(c.version, CONNECTOR_LATEST_VERSION),
  }
  const extra = pairing ? { pairingExpiresAt: iso(pairing.expiresAt)! } : {}
  if (c.authFailedAt && (!c.lastSeenAt || c.authFailedAt > c.lastSeenAt)) {
    return {
      state: 'auth_failed', connector, ...extra,
      message: c.authFailure === 'device_mismatch'
        ? 'ManuFlow refused the connector: its token is being used from a different computer than the one that was paired. Pair that computer with a new code, or disconnect if you do not recognise it.'
        : 'The connector was offline too long to reconnect by itself (its saved token has expired). Create a new code and pair it again; nothing else is lost.',
    }
  }
  if (!c.lastSeenAt) {
    return {
      state: 'connecting', connector, ...extra,
      message: 'Paired. Waiting for the connector’s first check-in: it starts by itself where it was installed to start with the computer, otherwise start it with “run”.',
    }
  }
  const silentMs = at.getTime() - c.lastSeenAt.getTime()
  if (silentMs > ONLINE_WINDOW_MS && silentMs <= RECONNECT_WINDOW_MS) {
    return {
      state: 'reconnecting', connector, ...extra,
      message: 'The connector lost contact with ManuFlow and is retrying by itself (at least every 5 minutes). Nothing needs to be done if the computer running it is on and online.',
    }
  }
  if (silentMs > ONLINE_WINDOW_MS) {
    return {
      state: 'offline', connector, ...extra,
      message: 'The connector has not checked in for several minutes. Check that the computer running it is on and connected to the internet; where it was installed to start with the computer, restarting the computer starts it again.',
    }
  }
  if (connectorOutdated(c)) {
    return {
      state: 'outdated', connector, ...extra,
      message: `The connector on that computer (version ${c.version}) is too old for this ManuFlow. Install version ${CONNECTOR_MIN_VERSION} or newer there; its pairing stays valid.`,
    }
  }
  if (c.lastTallyStatus !== 'connected') {
    return { state: 'tally_error', connector, ...extra, message: TALLY_MESSAGES[(c.lastTallyStatus as ConnectorTallyStatus | null) ?? 'unreachable'] }
  }
  return { state: 'connected', connector, ...extra, message: TALLY_MESSAGES.connected }
}
