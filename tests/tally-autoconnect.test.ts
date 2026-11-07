import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { GET as statusRoute, POST as createCode } from '@/app/api/import-center/tally/connector/route'
import { GET as getJob, POST as createJobRoute } from '@/app/api/import-center/tally/jobs/route'
import { POST as heartbeatRoute } from '@/app/api/tally-connector/heartbeat/route'
import { POST as pairRoute } from '@/app/api/tally-connector/pair/route'
import { POST as pingRoute } from '@/app/api/tally-connector/ping/route'
import { POST as resultRoute } from '@/app/api/tally-connector/result/route'
import { db } from '@/lib/db'
import {
  CONNECTOR_LATEST_VERSION, CONNECTOR_MIN_VERSION, JOB_RUN_LIMIT_MS, TOKEN_RECOVERY_MS, TOKEN_ROTATE_MS, olderThan, type ConnectorStatus,
} from '@/lib/tally/connector'
import { FLOW_LABEL, tallyFlow, type TallyFlowState } from '@/lib/tally/flow'
import { LIST_REUSE_MS, companyList } from '@/lib/tally/jobs'
import * as connector from '../connector/tally/manuflow-tally-connector.mjs'
import { apiRequest, call, type TestUser } from './helpers/api'
import { resetDb } from './helpers/db'
import { seedTenant } from './helpers/seed'

// Phases H–N: automatic connection and company discovery. The real connector program talks to the real routes over
// HTTP; TallyPrime is a mock (no real TallyPrime here); the database is the test database. Nothing here is a real
// Tally verification.

// ---------------------------------------------------------------- mock TallyPrime

type Company = { name: string; guid?: string }
let tallyCompanies: Company[] = []
let tallyBodies: string[] = []
let tally: ReturnType<typeof Bun.serve> | null = null
let tallyPort = 0

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
function startTally(port = 0) {
  tally = Bun.serve({
    port, hostname: '127.0.0.1',
    async fetch(req) {
      const body = await req.text()
      tallyBodies.push(body)
      const id = /<ID>([^<]*)<\/ID>/.exec(body)?.[1] ?? ''
      if (id === 'ManuFlowCompanies') {
        const rows = tallyCompanies.map((c) => `<COMPANY NAME="${esc(c.name)}">${c.guid ? `<GUID>${c.guid}</GUID>` : ''}<STARTINGFROM>20260401</STARTINGFROM><BOOKSFROM>20260401</BOOKSFROM></COMPANY>`).join('')
        return new Response(`<ENVELOPE><HEADER><VERSION>1</VERSION><STATUS>1</STATUS></HEADER><BODY><DESC></DESC><DATA><COLLECTION>${rows}</COLLECTION></DATA></BODY></ENVELOPE>`)
      }
      if (id === 'ManuFlowDebtors') {
        return new Response('<ENVELOPE><HEADER><VERSION>1</VERSION><STATUS>1</STATUS></HEADER><BODY><DATA><COLLECTION><LEDGER NAME="Debtor 1"><GUID>g-d-1</GUID></LEDGER></COLLECTION></DATA></BODY></ENVELOPE>')
      }
      return new Response('<ENVELOPE><HEADER><VERSION>1</VERSION><STATUS>0</STATUS></HEADER><BODY><DATA><LINEERROR>Could not find Report</LINEERROR></DATA></BODY></ENVELOPE>')
    },
  })
  tallyPort = tally.port!
}
const stopTally = () => { tally?.stop(true); tally = null }

// ---------------------------------------------------------------- ManuFlow's connector endpoints over HTTP

let manuflow: ReturnType<typeof Bun.serve>
let dir = ''
const savedFlag = process.env.TALLY_CONNECTOR_POC

beforeAll(() => {
  startTally()
  manuflow = Bun.serve({
    port: 0, hostname: '127.0.0.1',
    fetch(req) {
      const p = new URL(req.url).pathname
      if (p === '/api/tally-connector/pair') return pairRoute(req)
      if (p === '/api/tally-connector/heartbeat') return heartbeatRoute(req)
      if (p === '/api/tally-connector/result') return resultRoute(req)
      if (p === '/api/tally-connector/ping') return pingRoute()
      return new Response('not found', { status: 404 })
    },
  })
  dir = mkdtempSync(join(tmpdir(), 'mf-tally-autoconnect-test-'))
})
afterAll(() => {
  stopTally()
  manuflow.stop(true)
  rmSync(dir, { recursive: true, force: true })
  if (savedFlag === undefined) delete process.env.TALLY_CONNECTOR_POC
  else process.env.TALLY_CONNECTOR_POC = savedFlag
})
beforeEach(async () => {
  await resetDb()
  process.env.TALLY_CONNECTOR_POC = '1'
  tallyCompanies = [{ name: 'ABC Trial Co', guid: 'guid-abc' }]
  tallyBodies = []
  if (!tally) startTally(tallyPort)
})

// ---------------------------------------------------------------- helpers

const serverUrl = () => `http://127.0.0.1:${manuflow.port}`
const tallyUrl = () => `http://127.0.0.1:${tallyPort}`
let n = 0
const cfgPath = () => join(dir, `c${++n}`, 'connector.json')
const idOf = (token: string) => token.split('_')[1]

const status = async (user: TestUser) => (await call<ConnectorStatus>(statusRoute(apiRequest('/api/import-center/tally/connector', { user })))).json.data!
const newCode = async (user: TestUser) => (await call(createCode(apiRequest('/api/import-center/tally/connector', { method: 'POST', user })))).json.data.code as string
const newJob = (user: TestUser, type: string, extra: Record<string, unknown> = {}) =>
  call(createJobRoute(apiRequest('/api/import-center/tally/jobs', { body: { type, ...extra }, user })))
const jobStatus = (user: TestUser, id: string) => call(getJob(apiRequest(`/api/import-center/tally/jobs?id=${id}`, { user })))
const resetLimiter = () => db.tallyConnector.updateMany({ where: { lastSeenAt: { not: null } }, data: { lastSeenAt: new Date(Date.now() - 6000) } })
/** One connector cycle with the real program: Tally check + heartbeat + the job it was handed. */
async function cycle(path: string) {
  await resetLimiter()
  return connector.heartbeatOnce(connector.loadConfig(path), path)
}
const rawBeat = async (token: string, body: Record<string, unknown>) => {
  await resetLimiter()
  return call(heartbeatRoute(apiRequest('/api/tally-connector/heartbeat', { body: { tally: { status: 'connected' }, ...body }, headers: { authorization: `Bearer ${token}` } })))
}

/** First-time device authorisation: an admin's one-time code, the real connector pairs with it. */
async function firstTime(user?: TestUser) {
  const t = user ? { user } : await seedTenant()
  const path = cfgPath()
  await connector.pair({ server: serverUrl(), code: await newCode(t.user), tally: tallyUrl(), path })
  return { ...t, user: t.user, path }
}

/** Ask for the company list the way the screen does by itself, let the connector run it, return the finished job. */
async function discover(user: TestUser, path: string, reuse = true) {
  const j = await newJob(user, 'list-companies', reuse ? { reuse: true } : {})
  expect(j.status).toBe(200)
  if (j.json.data.status === 'queued') await cycle(path)
  return (await jobStatus(user, j.json.data.id)).json.data
}

// ---------------------------------------------------------------- Phase H: availability, version, Tally address

describe('Phase H: connector availability and compatibility', () => {
  test('ping: reachable, switched on, versions; switched off says so; no company data', async () => {
    const r = await call(pingRoute())
    expect(r.json.data).toEqual({ service: 'manuflow-tally-connector', minVersion: CONNECTOR_MIN_VERSION, latestVersion: CONNECTOR_LATEST_VERSION })
    expect((await connector.pingServer(serverUrl())).ok).toBe(true)
    process.env.TALLY_CONNECTOR_POC = '0'
    expect((await call(pingRoute())).status).toBe(503)
    const off = await connector.pingServer(serverUrl())
    expect([off.ok, off.message]).toEqual([false, expect.stringContaining('switched off')])
  })

  test('ping from the connector: wrong service, unreachable server, plain http to another host refused', async () => {
    const other = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('nope', { status: 404 }) })
    try {
      expect(await connector.pingServer(`http://127.0.0.1:${other.port}`)).toEqual({ ok: false, message: expect.stringContaining('not as ManuFlow') })
    } finally { other.stop(true) }
    const dead = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') })
    const deadPort = dead.port
    dead.stop(true)
    expect((await connector.pingServer(`http://127.0.0.1:${deadPort}`)).message).toContain('cannot be reached')
    expect((await connector.pingServer('http://erp.example.com')).ok).toBe(false)
  })

  test('version rule: numeric, unreadable versions are never judged outdated', () => {
    expect(olderThan('0.2.0', '0.3.0')).toBe(true)
    expect(olderThan('0.10.0', '0.9.9')).toBe(false)
    expect(olderThan('1.0.0', '1.0.0')).toBe(false)
    expect(connector.olderThan('0.2.9', '0.3.0')).toBe(true)
    expect(connector.VERSION).toBe(CONNECTOR_LATEST_VERSION)
  })

  test('an outdated connector stays connected but gets no job, and the screen says why', async () => {
    const { user, path } = await firstTime()
    const token = connector.loadConfig(path).token
    const deviceId = connector.loadConfig(path).deviceId
    expect((await rawBeat(token, { version: '0.1.0', deviceId })).status).toBe(200)
    const s = await status(user)
    expect(s.state).toBe('outdated')
    expect(s.message).toContain(CONNECTOR_MIN_VERSION)
    expect((await newJob(user, 'list-companies')).json.error?.code).toBe('CONNECTOR_OUTDATED')
    // a job queued before is not handed out to it
    const c = await db.tallyConnector.findFirstOrThrow({ where: { activeFor: { not: null } } })
    await db.tallyJob.create({ data: { id: 'a'.repeat(24), companyId: c.companyId, connectorId: c.id, type: 'list-companies', status: 'queued', createdBy: user.id } })
    const r = await rawBeat(token, { version: '0.1.0', deviceId })
    expect(r.json.data.job).toBeUndefined()
    expect(r.json.data.minVersion).toBe(CONNECTOR_MIN_VERSION)
    // updated connector: works again without a new pairing
    expect((await rawBeat(token, { version: CONNECTOR_LATEST_VERSION, deviceId })).json.data.job?.id).toBe('a'.repeat(24))
  })

  test('the Tally address is set on the connector computer only, without pairing again', async () => {
    const { path } = await firstTime()
    const logs: string[] = []
    expect(await connector.main(['set-tally', '--tally', 'http://192.168.1.20:9000', '--config', path], (m: string) => logs.push(m))).toBe(0)
    expect(connector.loadConfig(path).tally).toBe('http://192.168.1.20:9000/')
    // a public address is refused: Tally's port must never be reached over the internet
    expect(await connector.main(['set-tally', '--tally', 'http://8.8.8.8:9000', '--config', path], (m: string) => logs.push(m))).toBe(1)
    expect(connector.loadConfig(path).tally).toBe('http://192.168.1.20:9000/')
    expect(logs.join('\n')).not.toContain(connector.loadConfig(path).token)
  })
})

// ---------------------------------------------------------------- Phase I: device registration and identity

describe('Phase I: device registration', () => {
  test('first-time pairing registers the computer: random id + name, token stored only as a hash', async () => {
    const { user, path } = await firstTime()
    const cfg = connector.loadConfig(path)
    expect(cfg.deviceId).toMatch(/^[a-f0-9]{32}$/)
    const row = await db.tallyConnector.findUniqueOrThrow({ where: { id: idOf(cfg.token) } })
    expect(row.deviceId).toBe(cfg.deviceId)
    expect(row.deviceName).toBe(connector.deviceName() ?? null)
    expect(JSON.stringify(row)).not.toContain(cfg.token.slice(30)) // the secret (after mftc_<24-hex id>_) is never stored
    await cycle(path)
    const s = await status(user)
    expect(s.state).toBe('connected')
    expect(s.connector?.deviceName).toBe(row.deviceName)
  })

  test('the token works only from its own computer; a copy elsewhere is refused and shown as authentication failed', async () => {
    const { user, path } = await firstTime()
    await cycle(path)
    const cfg = connector.loadConfig(path)
    const r = await rawBeat(cfg.token, { deviceId: 'f'.repeat(32) })
    expect([r.status, r.json.error?.code]).toEqual([401, 'CONNECTOR_DEVICE_MISMATCH'])
    expect((await rawBeat(cfg.token, {})).json.error?.code).toBe('CONNECTOR_DEVICE_MISMATCH') // no identity at all
    const s = await status(user)
    expect(s.state).toBe('auth_failed')
    expect(s.message).toContain('different computer')
    // the real computer is not locked out, and the warning clears with its next check-in
    expect((await cycle(path)).ok).toBe(true)
    expect((await status(user)).state).toBe('connected')
  })

  test('the connector keeps its token when ManuFlow reports a device mismatch', async () => {
    const { path } = await firstTime()
    const other = cfgPath()
    mkdirSync(dirname(other), { recursive: true })
    const copied = { ...connector.loadConfig(path), deviceId: 'e'.repeat(32) }
    writeFileSync(other, JSON.stringify(copied))
    const r = await cycle(other)
    expect([r.ok, r.error]).toEqual([false, expect.stringContaining('another computer')])
    expect(JSON.parse(readFileSync(other, 'utf8')).token).toBe(copied.token)
  })

  test('pairing the same computer again keeps its identity and replaces its old token; one active connector', async () => {
    const { user, path } = await firstTime()
    const first = connector.loadConfig(path)
    await connector.pair({ server: serverUrl(), code: await newCode(user), tally: tallyUrl(), path })
    const second = connector.loadConfig(path)
    expect(second.deviceId).toBe(first.deviceId)
    expect(second.token).not.toBe(first.token)
    expect((await rawBeat(first.token, { deviceId: first.deviceId })).json.error?.code).toBe('CONNECTOR_REVOKED')
    expect(await db.tallyConnector.count({ where: { activeFor: { not: null } } })).toBe(1)
    const audit = await db.auditLog.findFirst({ where: { entity: 'TallyConnector', details: { contains: 'same computer' } } })
    expect(audit).not.toBeNull()
  })

  test('a connector paired before 0.3.0 gets an identity at its next heartbeat, then the token is bound to it', async () => {
    const { path } = await firstTime()
    const legacy = connector.loadConfig(path)
    delete legacy.deviceId
    writeFileSync(path, JSON.stringify(legacy))
    await db.tallyConnector.updateMany({ data: { deviceId: null } })
    expect((await cycle(path)).ok).toBe(true)
    const made = connector.loadConfig(path).deviceId
    expect(made).toMatch(/^[a-f0-9]{32}$/)
    expect((await db.tallyConnector.findFirstOrThrow({ where: { activeFor: { not: null } } })).deviceId).toBe(made)
    expect((await rawBeat(legacy.token, {})).json.error?.code).toBe('CONNECTOR_DEVICE_MISMATCH')
  })

  test('expired credentials: shown as authentication failed; a new code recovers the same computer', async () => {
    const { user, path } = await firstTime()
    const cfg = connector.loadConfig(path)
    // rotation reply lost, then offline past the recovery window
    await db.tallyConnector.updateMany({ where: { id: idOf(cfg.token) }, data: { pairedAt: new Date(Date.now() - TOKEN_ROTATE_MS - 1000) } })
    await rawBeat(cfg.token, { deviceId: cfg.deviceId })
    const realNow = Date.now
    Date.now = () => realNow() + TOKEN_RECOVERY_MS + 1000
    try {
      await resetLimiter()
      const r = await connector.heartbeatOnce(connector.loadConfig(path), path)
      expect(r.error).toContain('must be paired again')
      const s = await status(user)
      expect(s.state).toBe('auth_failed')
      expect(s.message).toContain('offline too long')
      expect(tallyFlow(s).action).toBe('pair')
      await connector.pair({ server: serverUrl(), code: await newCode(user), tally: tallyUrl(), path })
      expect(connector.loadConfig(path).deviceId).toBe(cfg.deviceId)
      expect((await cycle(path)).ok).toBe(true)
      expect((await status(user)).state).toBe('connected')
    } finally { Date.now = realNow }
  })

  test('unknown or forged tokens are refused and change nothing', async () => {
    const { user, path } = await firstTime()
    await cycle(path)
    const before = await db.tallyConnector.findFirstOrThrow({ where: { activeFor: { not: null } } })
    const forged = `mftc_${before.id}_${'A'.repeat(43)}`
    for (const t of [forged, 'mftc_x', 'Bearer nonsense']) {
      expect((await rawBeat(t, { deviceId: before.deviceId })).json.error?.code).toBe('CONNECTOR_UNAUTHORIZED')
    }
    const after = await db.tallyConnector.findUniqueOrThrow({ where: { id: before.id } })
    expect([after.authFailure, after.authFailedAt]).toEqual([null, null])
    expect((await status(user)).state).toBe('connected')
  })

  test('tenant isolation: another company never sees or touches this device, even with the same device id', async () => {
    const a = await firstTime()
    await cycle(a.path)
    const b = await seedTenant()
    const s = await status(b.user)
    expect(s.state).toBe('not_paired')
    expect(s.connector).toBeUndefined()
    // B pairs a program that claims A's device id: A's connector is not revoked or changed
    const res = await call(pairRoute(apiRequest('/api/tally-connector/pair', {
      body: { code: await newCode(b.user), version: CONNECTOR_LATEST_VERSION, deviceId: connector.loadConfig(a.path).deviceId },
    })))
    expect(res.status).toBe(200)
    expect((await cycle(a.path)).ok).toBe(true)
    expect((await status(a.user)).state).toBe('connected')
    expect(await db.tallyConnector.count({ where: { activeFor: { not: null } } })).toBe(2)
  })
})

// ---------------------------------------------------------------- Phase J: connection engine

describe('Phase J: automatic connection engine', () => {
  test('returning device: a restarted connector reconnects with its saved token, no code, no new connector', async () => {
    const { user, path } = await firstTime()
    expect((await status(user)).state).toBe('connecting')
    await connector.runLoop({ path, log: () => {}, maxBeats: 1 })
    expect((await status(user)).state).toBe('connected')
    const codes = await db.tallyPairingCode.count()
    // "restart": a new run of the program, only the settings file is left
    await resetLimiter()
    expect(await connector.runLoop({ path, log: () => {}, maxBeats: 1 })).toBe(0)
    expect((await status(user)).state).toBe('connected')
    expect(await db.tallyPairingCode.count()).toBe(codes)
    expect(await db.tallyConnector.count()).toBe(1)
  })

  test('Tally closed, then started again: tally_error, then connected by itself', async () => {
    const { user, path } = await firstTime()
    await cycle(path)
    stopTally()
    const r = await cycle(path)
    expect([r.ok, r.tally.status]).toEqual([true, 'unreachable'])
    expect((await status(user)).state).toBe('tally_error')
    expect(tallyFlow(await status(user)).state).toBe('tally_unreachable')
    expect((await newJob(user, 'list-companies')).json.error?.code).toBe('TALLY_UNREACHABLE')
    startTally(tallyPort)
    expect((await cycle(path)).tally.status).toBe('connected')
    expect((await status(user)).state).toBe('connected')
  })

  test('network interruption: retries with growing waits, logs a repeated state once, never the token', async () => {
    const path = cfgPath()
    mkdirSync(dirname(path), { recursive: true })
    const dead = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') })
    const deadUrl = `http://127.0.0.1:${dead.port}`
    dead.stop(true)
    connector.saveConfig({ server: deadUrl, token: `mftc_${'a'.repeat(24)}_${'B'.repeat(43)}`, tally: tallyUrl(), deviceId: 'c'.repeat(32) }, path)
    const logs: string[] = []
    const waits: number[] = []
    await connector.runLoop({ path, log: (m: string) => logs.push(m), maxBeats: 8, sleep: async (ms: number) => { waits.push(ms) } })
    expect(waits).toEqual([15000, 30000, 60000, 120000, 240000, 300000, 300000]) // capped at 5 minutes
    expect(logs.join('\n')).not.toContain('B'.repeat(43))
    expect(connector.loadConfig(path).token).toBe(`mftc_${'a'.repeat(24)}_${'B'.repeat(43)}`) // kept
    // a new line while the wait grows; at the cap the same line is not repeated (at most hourly)
    expect(logs.length).toBe(6)
  })

  test('steady state is logged once, jobs always', async () => {
    const { user, path } = await firstTime()
    const logs: string[] = []
    let beats = 0
    await connector.runLoop({
      path, log: (m: string) => logs.push(m), maxBeats: 4,
      sleep: async () => { await resetLimiter(); if (++beats === 2) await newJob(user, 'list-companies') },
    })
    expect(logs.filter((l) => l.includes('Tally: connected')).length).toBe(1)
    expect(logs.filter((l) => l.includes('list-companies: 1 records sent')).length).toBe(1)
  })

  test('one running copy per settings file: a live lock blocks, a stale or dead one is taken over', () => {
    const path = cfgPath()
    mkdirSync(dirname(path), { recursive: true })
    expect(connector.acquireLock(path)).toBe(true)
    connector.releaseLock(path)
    expect(existsSync(`${path}.lock`)).toBe(false)
    // another live process holds it (the parent process stands in for a second connector)
    writeFileSync(`${path}.lock`, String(process.ppid))
    expect(connector.acquireLock(path)).toBe(false)
    connector.releaseLock(path) // not ours: left alone
    expect(existsSync(`${path}.lock`)).toBe(true)
    // not touched for 11 minutes: left behind (e.g. a crash and pid reuse) → taken over
    const old = new Date(Date.now() - 11 * 60_000)
    utimesSync(`${path}.lock`, old, old)
    expect(connector.acquireLock(path)).toBe(true)
    // the process that wrote it is gone → taken over
    const gone = Bun.spawnSync(['true']).pid
    writeFileSync(`${path}.lock`, String(gone))
    expect(connector.acquireLock(path)).toBe(true)
    connector.releaseLock(path)
  })

  test('the run command refuses to start a second copy', async () => {
    const path = cfgPath()
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(`${path}.lock`, String(process.ppid))
    const logs: string[] = []
    expect(await connector.main(['run', '--config', path], (m: string) => logs.push(m))).toBe(3)
    expect(logs.join('\n')).toContain('already running')
  })

  test('log file: written, rotated at 1 MB with one older file kept', () => {
    const file = join(dir, `log${++n}`, 'connector.log')
    const log = connector.fileLogger(file, () => {})
    log('first line')
    expect(readFileSync(file, 'utf8')).toBe('first line\n')
    writeFileSync(file, 'x'.repeat(1024 * 1024 + 1))
    log('after rotation')
    expect(readFileSync(file, 'utf8')).toBe('after rotation\n')
    expect(statSync(`${file}.1`).size).toBe(1024 * 1024 + 1)
  })
})

// ---------------------------------------------------------------- Phase K: company discovery

describe('Phase K: automatic company discovery', () => {
  test('companies with GUIDs, after connection only; nothing but the company list is read', async () => {
    const { user, path } = await firstTime()
    expect((await newJob(user, 'list-companies')).json.error?.code).toBe('CONNECTOR_OFFLINE') // not connected yet
    await cycle(path)
    tallyCompanies = [{ name: 'ABC Trial Co', guid: 'guid-abc' }, { name: 'Shree & Sons', guid: 'guid-ss' }]
    const j = await discover(user, path)
    expect(j.companies).toEqual([
      { name: 'ABC Trial Co', guid: 'guid-abc', booksFrom: '2026-04-01', startingFrom: '2026-04-01', ambiguous: false },
      { name: 'Shree & Sons', guid: 'guid-ss', booksFrom: '2026-04-01', startingFrom: '2026-04-01', ambiguous: false },
    ])
    const ids = tallyBodies.map((b) => /<ID>([^<]*)<\/ID>/.exec(b)?.[1])
    expect(new Set(ids)).toEqual(new Set(['ManuFlow Connectivity Check', 'ManuFlowCompanies']))
    for (const b of tallyBodies) expect(connector.isExportRequest(b)).toBe(true)
  })

  test('repeats collapse; the same name with different GUIDs is ambiguous and cannot be chosen', async () => {
    // the same company twice (same GUID) is one entry; two same-name entries without GUIDs cannot be told apart
    expect(companyList([{ name: 'A', guid: 'g1' }, { name: 'A', guid: 'g1' }, { name: 'B' }, { name: 'B' }, { name: 'C' }]).map((c) => [c.name, c.ambiguous]))
      .toEqual([['A', false], ['B', true], ['B', true], ['C', false]])
    const { user, path } = await firstTime()
    await cycle(path)
    tallyCompanies = [{ name: 'Same Name', guid: 'g1' }, { name: 'Same Name', guid: 'g2' }, { name: 'Unique', guid: 'g3' }]
    const j = await discover(user, path)
    expect(j.companies.map((c: { name: string; ambiguous: boolean }) => [c.name, c.ambiguous])).toEqual([['Same Name', true], ['Same Name', true], ['Unique', false]])
    const refused = await newJob(user, 'export-customers', { tallyCompany: 'Same Name' })
    expect([refused.status, refused.json.error?.code]).toEqual([400, 'TALLY_COMPANY_AMBIGUOUS'])
    expect((await newJob(user, 'export-customers', { tallyCompany: 'Unique' })).status).toBe(200) // the next step is available
  })

  test('empty company list: no company open in TallyPrime', async () => {
    const { user, path } = await firstTime()
    await cycle(path)
    tallyCompanies = []
    const j = await discover(user, path)
    expect(j.companies).toEqual([])
    expect(tallyFlow(await status(user), { listing: false, companies: j.companies, error: '' }).state).toBe('no_companies')
  })

  test('the screen asking by itself reuses a list read seconds ago; Refresh and an old list read again', async () => {
    const { user, path } = await firstTime()
    await cycle(path)
    const first = await discover(user, path)
    const reads = () => tallyBodies.filter((b) => b.includes('ManuFlowCompanies')).length
    expect(reads()).toBe(1)
    const again = await newJob(user, 'list-companies', { reuse: true })
    expect([again.json.data.id, again.json.data.status]).toEqual([first.id, 'done'])
    const refresh = await newJob(user, 'list-companies')
    expect(refresh.json.data.id).not.toBe(first.id)
    await cycle(path)
    expect(reads()).toBe(2)
    const realNow = Date.now
    Date.now = () => realNow() + LIST_REUSE_MS + 1000
    try {
      expect((await newJob(user, 'list-companies', { reuse: true })).json.data.status).toBe('queued')
    } finally { Date.now = realNow }
  })

  test('several tabs at once: one queued read, one Tally request', async () => {
    const { user, path } = await firstTime()
    await cycle(path)
    const ids = await Promise.all(Array.from({ length: 5 }, () => newJob(user, 'list-companies', { reuse: true }).then((r) => r.json.data.id)))
    expect(new Set(ids).size).toBe(1)
    expect(await db.tallyJob.count({ where: { type: 'list-companies' } })).toBe(1)
    await cycle(path)
    expect(tallyBodies.filter((b) => b.includes('ManuFlowCompanies')).length).toBe(1)
  })

  test('interrupted discovery: the connector stopped mid-read; handed out once more, finished, no duplicate job', async () => {
    const { user, path } = await firstTime()
    await cycle(path)
    const j = (await newJob(user, 'list-companies', { reuse: true })).json.data
    const cfg = connector.loadConfig(path)
    expect((await rawBeat(cfg.token, { deviceId: cfg.deviceId })).json.data.job?.id).toBe(j.id) // taken, never answered
    // while it is still running, asking again joins the same request
    expect((await newJob(user, 'list-companies', { reuse: true })).json.data.id).toBe(j.id)
    const realNow = Date.now
    Date.now = () => realNow() + JOB_RUN_LIMIT_MS + 1000
    try {
      await cycle(path) // the connector is back: the read is handed out again and finished
      expect((await jobStatus(user, j.id)).json.data.status).toBe('done')
      expect((await newJob(user, 'list-companies', { reuse: true })).json.data.id).toBe(j.id) // the finished list is reused
    } finally { Date.now = realNow }
    expect(await db.tallyJob.count()).toBe(1)
  })

  test('tenant isolation: one company cannot see another company’s Tally companies or jobs', async () => {
    const a = await firstTime()
    await cycle(a.path)
    const j = await discover(a.user, a.path)
    const b = await seedTenant()
    expect((await jobStatus(b.user, j.id)).status).toBe(404)
    expect((await newJob(b.user, 'export-customers', { tallyCompany: 'ABC Trial Co' })).json.error?.code).toBe('TALLY_COMPANY_UNKNOWN')
  })
})

// ---------------------------------------------------------------- Phase L: the states the screen shows

describe('Phase L: connection flow states', () => {
  const st = (state: ConnectorStatus['state']): ConnectorStatus => ({ state, message: '' })
  test('every server state maps to one of the screen states', () => {
    const cases: [ConnectorStatus | null, TallyFlowState][] = [
      [null, 'detecting'], [st('unavailable'), 'unavailable'], [st('not_paired'), 'authorization_required'], [st('pairing'), 'authorization_required'],
      [st('auth_failed'), 'auth_failed'], [st('offline'), 'connector_offline'], [st('reconnecting'), 'connector_offline'],
      [st('connecting'), 'connecting'], [st('outdated'), 'outdated'], [st('tally_error'), 'tally_unreachable'], [st('connected'), 'connected'],
    ]
    for (const [s, want] of cases) expect([s?.state, tallyFlow(s).state]).toEqual([s?.state, want])
  })
  test('company discovery states after the connection', () => {
    const c = st('connected')
    expect(tallyFlow(c, { listing: true, companies: null, error: '' }).state).toBe('fetching_companies')
    expect(tallyFlow(c, { listing: false, companies: [{}], error: '' })).toEqual({ state: 'companies_available', label: FLOW_LABEL.companies_available, reached: 3, action: 'choose' })
    expect(tallyFlow(c, { listing: false, companies: null, error: 'x' })).toMatchObject({ state: 'retry', action: 'retry' })
    // a lost connection wins over an old list
    expect(tallyFlow(st('offline'), { listing: false, companies: [{}], error: '' }).state).toBe('connector_offline')
  })
  test('the labels the brief asks for exist', () => {
    expect(Object.values(FLOW_LABEL)).toEqual(expect.arrayContaining([
      'Detecting connector', 'Device authorization required', 'Connecting to Tally', 'Tally not reachable', 'Fetching companies',
      'Companies available', 'Connected', 'Connector offline', 'Authentication failed', 'Retry available',
    ]))
  })
})

// ---------------------------------------------------------------- Phase N: end to end (mock TallyPrime)

describe('Phase N: end to end with a mock TallyPrime', () => {
  test('first time → connected → companies → choose → next step; then a returning device needs nothing', async () => {
    tallyCompanies = [{ name: 'ABC Trial Co', guid: 'guid-abc' }, { name: 'Second Co', guid: 'guid-2' }]
    const { user } = await seedTenant()
    expect(tallyFlow(await status(user)).state).toBe('authorization_required')
    const { path } = await firstTime(user)
    expect(tallyFlow(await status(user)).state).toBe('connecting')
    await connector.runLoop({ path, log: () => {}, maxBeats: 1 })
    expect(tallyFlow(await status(user)).state).toBe('connected')
    const list = await discover(user, path)
    expect(tallyFlow(await status(user), { listing: false, companies: list.companies, error: '' }).state).toBe('companies_available')
    expect(list.companies.map((c: { name: string }) => c.name)).toEqual(['ABC Trial Co', 'Second Co'])
    const next = await newJob(user, 'export-customers', { tallyCompany: 'Second Co' })
    expect(next.status).toBe(200)
    await cycle(path)
    expect((await jobStatus(user, next.json.data.id)).json.data).toMatchObject({ status: 'done', count: 1 })

    // returning device, next day: the program starts again and the screen finds everything without a code
    const codes = await db.tallyPairingCode.count()
    await resetLimiter()
    await connector.runLoop({ path, log: () => {}, maxBeats: 1 })
    expect((await status(user)).state).toBe('connected')
    const again = await discover(user, path, false)
    expect(again.companies.length).toBe(2)
    expect(await db.tallyPairingCode.count()).toBe(codes)
  })

  test('a device that was never authorised cannot connect or read', async () => {
    const r = await call(pairRoute(apiRequest('/api/tally-connector/pair', { body: { code: 'ABCDE-FGHJK', deviceId: 'd'.repeat(32) } })))
    expect([r.status, r.json.error?.code]).toEqual([401, 'PAIRING_CODE_INVALID'])
    expect(await db.tallyConnector.count()).toBe(0)
    const res = await call(resultRoute(apiRequest('/api/tally-connector/result', { body: { jobId: 'x', ok: true, records: [] } })))
    expect(res.status).toBe(401)
  })
})
