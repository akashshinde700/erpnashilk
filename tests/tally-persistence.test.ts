import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { POST as createCode, DELETE as disconnect } from '@/app/api/import-center/tally/connector/route'
import { POST as createJobRoute } from '@/app/api/import-center/tally/jobs/route'
import { POST as pairRoute } from '@/app/api/tally-connector/pair/route'
import { POST as heartbeatRoute } from '@/app/api/tally-connector/heartbeat/route'
import { POST as resultRoute } from '@/app/api/tally-connector/result/route'
import { GET as download } from '@/app/api/companies/[id]/backup/route'
import { POST as restore } from '@/app/api/companies/[id]/restore/route'
import { Prisma } from '@prisma/client'
import { NOT_BACKED_UP, backupPlan } from '@/lib/backup-plan'
import { db } from '@/lib/db'
import {
  JOB_RUN_LIMIT_MS, TOKEN_RECOVERY_MS, TOKEN_ROTATE_MS, cleanupTallyTables, connectorStatus, takeNextJob,
} from '@/lib/tally/connector'
import { CHUNK_RECORDS, getJobFor, jobRecords } from '@/lib/tally/jobs'
import * as connector from '../connector/tally/manuflow-tally-connector.mjs'
import { apiRequest, call, ctx, type TestUser } from './helpers/api'
import { resetDb } from './helpers/db'
import { seedTenant } from './helpers/seed'

// Phase B: pairing, tokens, rate limits and jobs live in the database (restart-safe, shared between processes).
// A "server restart" is any point where only the database is left: nothing in these tests relies on process memory.

const TALLY_REPLY = '<ENVELOPE><HEADER><VERSION>1</VERSION><STATUS>0</STATUS></HEADER><BODY><DATA><LINEERROR>Could not find Report</LINEERROR></DATA></BODY></ENVELOPE>'
let tally: ReturnType<typeof Bun.serve>
let manuflow: ReturnType<typeof Bun.serve> | null = null
let manuflowPort = 0
// What the ManuFlow test server answers: the real routes, or a failure mode
type ServerMode = 'routes' | '500' | '503' | 'not-json' | 'no-data' | 'unauthorized'
let serverMode: ServerMode = 'routes'
let dir = ''
const savedFlag = process.env.TALLY_CONNECTOR_POC

function startManuflow(port = 0) {
  manuflow = Bun.serve({
    port, hostname: '127.0.0.1',
    fetch(req) {
      if (serverMode === '500') return new Response('boom', { status: 500 })
      if (serverMode === '503') return Response.json({ success: false, error: { code: 'TALLY_CONNECTOR_UNAVAILABLE', message: 'off' } }, { status: 503 })
      if (serverMode === 'not-json') return new Response('<html>proxy error</html>', { status: 200 })
      if (serverMode === 'no-data') return Response.json({ success: true }, { status: 200 })
      if (serverMode === 'unauthorized') return Response.json({ success: false, error: { code: 'CONNECTOR_UNAUTHORIZED', message: 'x' } }, { status: 401 })
      const p = new URL(req.url).pathname
      if (p === '/api/tally-connector/pair') return pairRoute(req)
      if (p === '/api/tally-connector/heartbeat') return heartbeatRoute(req)
      if (p === '/api/tally-connector/result') return resultRoute(req)
      return new Response('not found', { status: 404 })
    },
  })
  manuflowPort = manuflow.port!
}

beforeAll(() => {
  tally = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response(TALLY_REPLY) })
  startManuflow()
  dir = mkdtempSync(join(tmpdir(), 'mf-tally-persist-test-'))
})
afterAll(() => {
  tally.stop(true)
  manuflow?.stop(true)
  rmSync(dir, { recursive: true, force: true })
  if (savedFlag === undefined) delete process.env.TALLY_CONNECTOR_POC
  else process.env.TALLY_CONNECTOR_POC = savedFlag
})
beforeEach(async () => {
  await resetDb()
  process.env.TALLY_CONNECTOR_POC = '1'
  serverMode = 'routes'
})

// ---------------------------------------------------------------- helpers

let n = 0
const cfgPath = () => join(dir, `c${++n}`, 'connector.json')
const serverUrl = () => `http://127.0.0.1:${manuflowPort}`
const tallyUrl = () => `http://127.0.0.1:${tally.port}`

const newCode = async (user: TestUser) => (await call(createCode(apiRequest('/api/import-center/tally/connector', { method: 'POST', user })))).json.data.code as string
const pairWith = (code: unknown, ip = '192.0.2.1') =>
  call(pairRoute(apiRequest('/api/tally-connector/pair', { body: { code, version: 't', platform: 'linux' }, headers: { 'x-forwarded-for': ip } })))
// Like the real connector: a heartbeat carries the device identity the token is bound to (if it has one)
const beat = async (token: string, body: Record<string, unknown> = { tally: { status: 'connected' } }) => {
  const bound = (await db.tallyConnector.findUnique({ where: { id: idOf(token) } }))?.deviceId
  const withDevice = bound && !('deviceId' in body) ? { ...body, deviceId: bound } : body
  return call(heartbeatRoute(apiRequest('/api/tally-connector/heartbeat', { body: withDevice, headers: { authorization: `Bearer ${token}` } })))
}
const postResult = (token: string, body: unknown) =>
  call(resultRoute(apiRequest('/api/tally-connector/result', { body, headers: { authorization: `Bearer ${token}` } })))

/** Heartbeats are limited to one per 5 s per connector: move the last check-in 6 s back instead of waiting. */
const resetLimiter = () => db.tallyConnector.updateMany({ where: { lastSeenAt: { not: null } }, data: { lastSeenAt: new Date(Date.now() - 6000) } })

async function pairedToken(user: TestUser) {
  const r = await pairWith(await newCode(user))
  expect(r.status).toBe(200)
  return r.json.data.token as string
}

/** Make the connector's current token old enough to be rotated at the next heartbeat. */
const ageToken = (id: string) => db.tallyConnector.update({
  where: { id }, data: { pairedAt: new Date(Date.now() - TOKEN_ROTATE_MS - 1000), rotatedAt: null },
})
const idOf = (token: string) => token.split('_')[1]

/** Row counts of every table that is not a Tally connector table (ManuFlow business data + system tables). */
async function businessCounts() {
  const tables = await db.$queryRawUnsafe<{ name: string }[]>(
    "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE' AND table_name NOT LIKE 'Tally%' ORDER BY table_name",
  )
  const out: Record<string, number> = {}
  for (const { name } of tables) {
    const [r] = await db.$queryRawUnsafe<{ n: bigint }[]>(`SELECT COUNT(*) AS n FROM \`${name.replaceAll('`', '')}\``)
    out[name] = Number(r.n)
  }
  return out
}

/** A few business records for a company, so preservation checks compare non-empty tables. */
async function seedBusiness(companyId: string) {
  await db.customer.create({ data: { companyId, code: 'C-0001', name: 'Existing Customer' } })
  await db.supplier.create({ data: { companyId, code: 'S-0001', name: 'Existing Supplier' } })
  await db.item.create({ data: { companyId, code: 'I-0001', name: 'Existing Item', uom: 'NOS' } })
}

// ---------------------------------------------------------------- pairing

describe('pairing (database)', () => {
  test('a code is stored only as a hash, works exactly once, and is kept as used', async () => {
    const { user, company } = await seedTenant()
    const code = await newCode(user)
    const row = await db.tallyPairingCode.findFirstOrThrow({ where: { companyId: company.id } })
    expect(JSON.stringify(row)).not.toContain(code.replace('-', ''))
    expect(row.usedAt).toBeNull()
    expect((await pairWith(code)).status).toBe(200)
    expect((await db.tallyPairingCode.findUniqueOrThrow({ where: { id: row.id } })).usedAt).not.toBeNull()
    const again = await pairWith(code)
    expect([again.status, again.json.error?.code]).toEqual([401, 'PAIRING_CODE_INVALID'])
  })

  test('the same code sent many times at once pairs exactly one connector', async () => {
    const { user, company } = await seedTenant()
    const code = await newCode(user)
    const rs = await Promise.all(Array.from({ length: 6 }, (_, i) => pairWith(code, `192.0.2.${10 + i}`)))
    expect(rs.filter((r) => r.status === 200).length).toBe(1)
    expect(rs.filter((r) => r.status !== 200).every((r) => r.status === 401 && r.json.error?.code === 'PAIRING_CODE_INVALID')).toBe(true)
    expect(await db.tallyConnector.count({ where: { companyId: company.id } })).toBe(1)
  })

  test('two codes of one company used at once: the company still has exactly one active connector', async () => {
    const { user, company } = await seedTenant()
    // Normally a new code retires the old one; plant two open codes to force the race
    const a = await newCode(user)
    const open = await db.tallyPairingCode.findFirstOrThrow({ where: { companyId: company.id, usedAt: null } })
    const b = await newCode(user)
    await db.tallyPairingCode.update({ where: { id: open.id }, data: { expiresAt: new Date(Date.now() + 60_000) } })
    const rs = await Promise.all([pairWith(a, '192.0.2.21'), pairWith(b, '192.0.2.22')])
    expect(rs.every((r) => r.status === 200 || (r.status === 409 && r.json.error?.code === 'PAIRING_CONFLICT'))).toBe(true)
    expect(rs.some((r) => r.status === 200)).toBe(true)
    expect(await db.tallyConnector.count({ where: { activeFor: company.id } })).toBe(1)
    // only the active connector's token works
    const tokens = rs.filter((r) => r.status === 200).map((r) => r.json.data.token as string)
    const active = await db.tallyConnector.findUniqueOrThrow({ where: { activeFor: company.id } })
    for (const t of tokens) {
      await resetLimiter()
      expect((await beat(t)).status).toBe(idOf(t) === active.id ? 200 : 401)
    }
  })

  test('wrong-code and code-issue limits are kept in the database, not in the process', async () => {
    const { user } = await seedTenant()
    const good = await newCode(user)
    for (let i = 0; i < 10; i++) expect((await pairWith('AAAAA-AAAAA', '203.0.113.9')).status).toBe(401)
    // the counter is a row (the IP itself is stored only as a hash) — a restarted server sees it too
    const rows = await db.tallyRateLimit.findMany({ where: { key: { startsWith: 'pair-ip:' } } })
    expect(rows.map((r) => r.count)).toEqual([10])
    expect(JSON.stringify(rows)).not.toContain('203.0.113.9')
    expect((await pairWith(good, '203.0.113.9')).status).toBe(429)
    // 9 more codes this hour are allowed (10 in all), the 11th is refused
    for (let i = 0; i < 9; i++) await newCode(user)
    expect((await call(createCode(apiRequest('/api/import-center/tally/connector', { method: 'POST', user })))).status).toBe(429)
  })
})

// ---------------------------------------------------------------- tokens

describe('token rotation and revocation', () => {
  test('after 7 days the heartbeat hands out a new token once; once it is used the old one stops working', async () => {
    const { user } = await seedTenant()
    const t1 = await pairedToken(user)
    const first = await beat(t1)
    expect(first.json.data.newToken).toBeUndefined()

    await ageToken(idOf(t1))
    await resetLimiter()
    const r = await beat(t1)
    const t2 = r.json.data.newToken as string
    expect(t2).toMatch(/^mftc_[a-f0-9]{24}_[A-Za-z0-9_-]{43}$/)
    expect(idOf(t2)).toBe(idOf(t1))
    const row = await db.tallyConnector.findUniqueOrThrow({ where: { id: idOf(t1) } })
    expect(JSON.stringify(row)).not.toContain(t2.split('_')[2]) // only hashes are stored
    expect(row.prevValidUntil!.getTime()).toBeGreaterThan(Date.now() + TOKEN_RECOVERY_MS - 60_000)

    await resetLimiter()
    const next = await beat(t2)
    expect(next.status).toBe(200)
    expect(next.json.data.newToken).toBeUndefined()
    expect((await db.tallyConnector.findUniqueOrThrow({ where: { id: idOf(t1) } })).prevSecretHash).toBeNull()
    await resetLimiter()
    expect((await beat(t1)).json.error?.code).toBe('CONNECTOR_UNAUTHORIZED')
  })

  test('lost rotation reply: the old token still works and gets a fresh one; the recovery limit is not extended', async () => {
    const { user } = await seedTenant()
    const t1 = await pairedToken(user)
    await ageToken(idOf(t1))
    const lost = (await beat(t1)).json.data.newToken as string // never reaches the connector
    const grace = (await db.tallyConnector.findUniqueOrThrow({ where: { id: idOf(t1) } })).prevValidUntil!

    await resetLimiter()
    const retry = await beat(t1)
    expect(retry.status).toBe(200)
    const t3 = retry.json.data.newToken as string
    expect(t3).toBeDefined()
    expect(t3).not.toBe(lost)
    expect((await db.tallyConnector.findUniqueOrThrow({ where: { id: idOf(t1) } })).prevValidUntil!.getTime()).toBe(grace.getTime())
    await resetLimiter()
    expect((await beat(lost)).status).toBe(401) // replaced before it was ever used
    await resetLimiter()
    expect((await beat(t3)).status).toBe(200)
  })

  test('recovery after a long outage: the connector comes back after 20 days with the old token and reconnects', async () => {
    const { user } = await seedTenant()
    const t1 = await pairedToken(user)
    await ageToken(idOf(t1))
    await beat(t1) // rotation reply lost; the connector then goes offline
    const realNow = Date.now
    Date.now = () => realNow() + 20 * 24 * 60 * 60 * 1000
    try {
      await resetLimiter()
      const r = await beat(t1)
      expect(r.status).toBe(200)
      const t2 = r.json.data.newToken as string
      expect(t2).toMatch(/^mftc_/)
      await resetLimiter()
      expect((await beat(t2)).status).toBe(200) // new token in use → the old one is cleared
      await resetLimiter()
      expect((await beat(t1)).json.error?.code).toBe('CONNECTOR_UNAUTHORIZED')
    } finally { Date.now = realNow }
  })

  test('recovery is bounded: 30 days after the rotation the old token is refused (expired), never extended', async () => {
    const { user } = await seedTenant()
    const t1 = await pairedToken(user)
    await ageToken(idOf(t1))
    await beat(t1)
    const realNow = Date.now
    try {
      // every contact with the old token hands out a fresh token but keeps the original limit
      Date.now = () => realNow() + 29 * 24 * 60 * 60 * 1000
      await resetLimiter()
      expect((await beat(t1)).status).toBe(200)
      Date.now = () => realNow() + TOKEN_RECOVERY_MS + 1000
      await resetLimiter()
      const r = await beat(t1)
      expect([r.status, r.json.error?.code]).toEqual([401, 'CONNECTOR_TOKEN_EXPIRED'])
      // someone without the token cannot tell an expired connector from an unknown one
      const forged = `mftc_${idOf(t1)}_${'A'.repeat(43)}`
      expect((await beat(forged)).json.error?.code).toBe('CONNECTOR_UNAUTHORIZED')
    } finally { Date.now = realNow }
  })

  test('a revoked connector cannot use the recovery path', async () => {
    const { user } = await seedTenant()
    const t1 = await pairedToken(user)
    await ageToken(idOf(t1))
    await beat(t1)
    await call(disconnect(apiRequest('/api/import-center/tally/connector', { method: 'DELETE', user })))
    await resetLimiter()
    const r = await beat(t1)
    expect([r.status, r.json.error?.code]).toEqual([401, 'CONNECTOR_REVOKED'])
    expect(r.json.data).toBeUndefined()
  })

  test('connector program: an expired token is kept, the user is told to pair again, and it keeps retrying slowly', async () => {
    const { user } = await seedTenant()
    const path = cfgPath()
    await connector.pair({ server: serverUrl(), code: await newCode(user), tally: tallyUrl(), path })
    const t1 = connector.loadConfig(path).token
    await ageToken(idOf(t1))
    await beat(t1) // rotation reply lost
    const saved = readFileSync(path, 'utf8')
    const realNow = Date.now
    Date.now = () => realNow() + TOKEN_RECOVERY_MS + 1000
    try {
      await resetLimiter()
      const logs: string[] = []
      const waits: number[] = []
      await connector.runLoop({ path, log: (m: string) => logs.push(m), maxBeats: 2, sleep: async (ms: number) => { waits.push(ms) } })
      expect(logs.join('\n')).toContain('must be paired again')
      expect(waits).toEqual([15000])
      expect(readFileSync(path, 'utf8')).toBe(saved)
    } finally { Date.now = realNow }
  })

  test('revocation works at once, and only a holder of the token learns it was revoked', async () => {
    const { user } = await seedTenant()
    const t1 = await pairedToken(user)
    await call(disconnect(apiRequest('/api/import-center/tally/connector', { method: 'DELETE', user })))
    expect((await beat(t1)).json.error?.code).toBe('CONNECTOR_REVOKED')
    const forged = `mftc_${idOf(t1)}_${'A'.repeat(43)}`
    expect((await beat(forged)).json.error?.code).toBe('CONNECTOR_UNAUTHORIZED')
  })
})

// ---------------------------------------------------------------- the connector program

describe('connector program: restart and reconnect', () => {
  test('server restart: the saved token keeps working with no new pairing', async () => {
    const { user, company } = await seedTenant()
    const path = cfgPath()
    await connector.pair({ server: serverUrl(), code: await newCode(user), tally: tallyUrl(), path })
    expect(await connector.runLoop({ path, log: () => {}, maxBeats: 1 })).toBe(0)

    // ManuFlow goes down (restart / deploy): the connector waits longer each time and keeps its token
    const port = manuflowPort
    manuflow!.stop(true)
    const waits: number[] = []
    await connector.runLoop({ path, log: () => {}, maxBeats: 3, sleep: async (ms: number) => { waits.push(ms) } })
    expect(waits).toEqual([15000, 30000])
    expect(connector.loadConfig(path)?.token).toMatch(/^mftc_/)

    // ManuFlow is back (a new process; only the database is left) → the same token connects again
    startManuflow(port)
    await resetLimiter()
    expect(await connector.runLoop({ path, log: () => {}, maxBeats: 1 })).toBe(0)
    expect((await connectorStatus(company.id)).state).toBe('connected')
  })

  test('the token is never deleted for errors: 5xx, unavailable, odd replies, an unaccepted token', async () => {
    const { user } = await seedTenant()
    const path = cfgPath()
    await connector.pair({ server: serverUrl(), code: await newCode(user), tally: tallyUrl(), path })
    const saved = readFileSync(path, 'utf8')
    for (const mode of ['500', '503', 'not-json', 'no-data', 'unauthorized'] as ServerMode[]) {
      serverMode = mode
      const waits: number[] = []
      const logs: string[] = []
      expect([mode, await connector.runLoop({ path, log: (m: string) => logs.push(m), maxBeats: 3, sleep: async (ms: number) => { waits.push(ms) } })]).toEqual([mode, 0])
      expect([mode, waits]).toEqual([mode, [15000, 30000]]) // increasing waits, never a tight loop
      expect([mode, readFileSync(path, 'utf8')]).toEqual([mode, saved])
      expect(logs.join('\n')).not.toContain(JSON.parse(saved).token)
    }
  })

  test('the connector saves a rotated token (owner-only file) and goes on with it', async () => {
    const { user } = await seedTenant()
    const path = cfgPath()
    await connector.pair({ server: serverUrl(), code: await newCode(user), tally: tallyUrl(), path })
    const t1 = connector.loadConfig(path).token
    await ageToken(idOf(t1))
    const logs: string[] = []
    expect(await connector.runLoop({ path, log: (m: string) => logs.push(m), maxBeats: 1 })).toBe(0)
    const t2 = connector.loadConfig(path).token
    expect(t2).not.toBe(t1)
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o077).toBe(0)
    expect(logs.join('\n')).not.toContain(t2)
    await resetLimiter()
    expect(await connector.runLoop({ path, log: () => {}, maxBeats: 1 })).toBe(0)
    expect((await db.tallyConnector.findUniqueOrThrow({ where: { id: idOf(t1) } })).prevSecretHash).toBeNull()
  })

  test('disconnected in ManuFlow (CONNECTOR_REVOKED): only then is the token deleted', async () => {
    const { user } = await seedTenant()
    const path = cfgPath()
    await connector.pair({ server: serverUrl(), code: await newCode(user), tally: tallyUrl(), path })
    await call(disconnect(apiRequest('/api/import-center/tally/connector', { method: 'DELETE', user })))
    expect(await connector.runLoop({ path, log: () => {}, maxBeats: 1 })).toBe(2)
    expect(connector.loadConfig(path)).toBeNull()
  })
})

// ---------------------------------------------------------------- jobs

async function onlineConnector() {
  const { user, company } = await seedTenant()
  const token = await pairedToken(user)
  await beat(token)
  const c = await db.tallyConnector.findUniqueOrThrow({ where: { id: idOf(token) } })
  return { user, company, token, c }
}
const newJob = (user: TestUser, type = 'list-companies') =>
  call(createJobRoute(apiRequest('/api/import-center/tally/jobs', { body: { type }, user })))

describe('jobs (database)', () => {
  test('concurrent claims never hand out one job twice', async () => {
    const { user, c } = await onlineConnector()
    const j = (await newJob(user)).json.data.id as string
    const got = await Promise.all(Array.from({ length: 8 }, () => takeNextJob(c)))
    expect(got.filter(Boolean).map((x) => x!.id)).toEqual([j])
    const row = await db.tallyJob.findUniqueOrThrow({ where: { id: j } })
    expect([row.status, row.attempt]).toEqual(['running', 1])
  })

  test('restart recovery: a running job keeps its state and its late result is accepted', async () => {
    const { user, company, token } = await onlineConnector()
    const j = (await newJob(user)).json.data.id as string
    await resetLimiter()
    expect((await beat(token)).json.data.job.id).toBe(j)
    // server restarts here — nothing but the database is left
    const r = await postResult(token, { jobId: j, ok: true, records: [{ name: 'Real Co' }] })
    expect(r.json.data.accepted).toBe(true)
    const job = await getJobFor(company.id, j)
    expect([job.status, job.recordCount]).toEqual(['done', 1])
  })

  test('lease ran out after a crash: the job is handed out again, and the stale result is dropped', async () => {
    const { user, token } = await onlineConnector()
    const j = (await newJob(user)).json.data.id as string
    await resetLimiter()
    await beat(token)
    await db.tallyJob.update({ where: { id: j }, data: { leaseUntil: new Date(Date.now() - 1000) } })
    await resetLimiter()
    const again = await beat(token)
    expect(again.json.data.job.id).toBe(j)
    expect((await db.tallyJob.findUniqueOrThrow({ where: { id: j } })).attempt).toBe(2)
    // a result for the job is accepted once; a second copy is dropped
    expect((await postResult(token, { jobId: j, ok: true, records: [{ name: 'A' }] })).json.data.accepted).toBe(true)
    expect((await postResult(token, { jobId: j, ok: true, records: [{ name: 'B' }] })).json.data.accepted).toBe(false)
    expect(JOB_RUN_LIMIT_MS).toBe(3 * 60 * 1000)
  })

  test('records are stored in chunks of 500, in order, with the done status', async () => {
    const { user, company, token, c } = await onlineConnector()
    const j = (await newJob(user)).json.data.id as string
    await takeNextJob(c)
    const records = Array.from({ length: 1201 }, (_, i) => ({ name: `Co ${i}` }))
    expect((await postResult(token, { jobId: j, ok: true, records })).json.data.accepted).toBe(true)
    const chunks = await db.tallyJobChunk.findMany({ where: { jobId: j }, orderBy: { seq: 'asc' } })
    expect(chunks.map((x) => [x.seq, (x.records as unknown[]).length])).toEqual([[0, CHUNK_RECORDS], [1, CHUNK_RECORDS], [2, 201]])
    expect(chunks.every((x) => x.companyId === company.id)).toBe(true)
    expect((await jobRecords(await getJobFor(company.id, j))).map((r) => r.name)).toEqual(records.map((r) => r.name))
  })

  test('tenant isolation: jobs, results and records stay with their own company', async () => {
    const a = await onlineConnector()
    const b = await onlineConnector()
    const ja = (await newJob(a.user)).json.data.id as string
    await takeNextJob(a.c)
    // B's connector cannot post A's job, B's company cannot read it, and B's heartbeat never gets it
    expect((await postResult(b.token, { jobId: ja, ok: true, records: [{ name: 'X' }] })).status).toBe(404)
    await expect(getJobFor(b.company.id, ja)).rejects.toThrow()
    await db.tallyJob.update({ where: { id: ja }, data: { status: 'queued' } })
    expect(await takeNextJob(b.c)).toBeUndefined()
    expect((await postResult(a.token, { jobId: ja, ok: true, records: [{ name: 'Y' }] })).json.data.accepted).toBe(false) // re-queued: dropped
    expect(await db.tallyJobChunk.count({ where: { companyId: b.company.id } })).toBe(0)
  })
})

// ---------------------------------------------------------------- cleanup and data preservation

describe('cleanup touches only the Tally connector tables', () => {
  test('expired Tally rows go, fresh ones stay, and every other table is unchanged', async () => {
    const { company, user, token, c } = await onlineConnector()
    await seedBusiness(company.id)
    const day = 24 * 60 * 60 * 1000
    const old = new Date(Date.now() - 31 * day)
    await db.tallyJob.create({ data: { id: 'old-job', companyId: company.id, connectorId: c.id, type: 'list-companies', status: 'done', createdBy: user.id, createdAt: old } })
    await db.tallyJobChunk.create({ data: { jobId: 'old-job', companyId: company.id, seq: 0, records: [{ name: 'x' }], createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) } })
    await db.tallyPairingCode.create({ data: { companyId: company.id, codeHash: 'f'.repeat(64), createdBy: user.id, expiresAt: new Date(Date.now() - 2 * day) } })
    await db.tallyRateLimit.create({ data: { key: 'issue:old', windowStart: new Date(Date.now() - 3 * 60 * 60 * 1000), count: 3, updatedAt: new Date(Date.now() - 3 * 60 * 60 * 1000) } })
    // fresh rows that must stay
    const fresh = (await newJob(user)).json.data.id as string

    const before = await businessCounts()
    expect(before.Customer).toBe(1)
    const removed = await cleanupTallyTables()
    expect(removed).toEqual({ chunks: 1, jobs: 1, pairingCodes: 1, rateLimits: 1 })
    expect(await businessCounts()).toEqual(before)
    expect(await db.tallyJob.findUnique({ where: { id: fresh } })).not.toBeNull()
    expect(await db.tallyConnector.count()).toBe(1)
    await resetLimiter()
    expect((await beat(token)).status).toBe(200)
  })

  test('the connector code deletes only from Tally tables and runs no destructive SQL', () => {
    const root = process.cwd()
    const files = ['src/lib/tally/connector.ts', 'src/lib/tally/jobs.ts', 'src/lib/tally/layer1.ts', 'src/lib/tally/links.ts', 'src/lib/tally/vouchers.ts', 'src/lib/tally/voucher-stage.ts', 'src/app/api/tally-connector', 'src/app/api/import-center/tally']
    const read = (f: string): string[] => {
      const p = join(root, f)
      if (statSync(p).isDirectory()) {
        return [...new Bun.Glob('**/*.ts').scanSync(p)].flatMap((x) => read(join(f, x)))
      }
      return [readFileSync(p, 'utf8')]
    }
    const src = files.flatMap(read).join('\n')
    // every delete goes through a Tally delegate
    const deletes = [...src.matchAll(/(?:db|tx)\.(\w+)\.delete(?:Many)?\(/g)].map((m) => m[1])
    expect(deletes.length).toBeGreaterThan(0)
    expect(deletes.filter((d) => !d.startsWith('tally'))).toEqual([])
    // the only raw SQL: the rate-limit upsert, the Layer 1 source-master upsert, and two row locks (voucher read; the
    // connector while a job is queued, so two tabs get one job)
    const raw = [...src.matchAll(/\$(?:execute|query)Raw(?:Unsafe)?`([^`]*(?:\\`[^`]*)*)`/g)].map((m) => m[1].trim())
    expect(raw.length).toBe(4)
    expect(raw.map((q) => q.split(/\s/).slice(0, 3).join(' ')).sort()).toEqual(['INSERT INTO TallyRateLimit', 'INSERT INTO TallySourceMaster', 'SELECT id FROM', 'SELECT id FROM'])
    expect(raw.filter((q) => q.startsWith('SELECT')).sort()).toEqual([
      'SELECT id FROM TallyConnector WHERE id = ${c.id} FOR UPDATE',
      'SELECT id FROM TallyVoucherRead WHERE id = ${readId} FOR UPDATE',
    ])
    // upserts and a read lock only: no DELETE / UPDATE / DROP / TRUNCATE / ALTER besides those clauses themselves
    expect(raw.join(' ').replaceAll('ON DUPLICATE KEY UPDATE', '').replaceAll('FOR UPDATE', '')).not.toMatch(/\b(DELETE|UPDATE|DROP|TRUNCATE|ALTER)\b/i)
    expect(src).not.toMatch(/\b(TRUNCATE|DROP\s+TABLE|ALTER\s+TABLE)\b|\$executeRawUnsafe|\$queryRawUnsafe/i)
  })

  test('Tally connector tables are never part of a company backup or restore', () => {
    const plan = backupPlan().map((t) => t.model)
    for (const m of ['TallyPairingCode', 'TallyConnector', 'TallyJob', 'TallyJobChunk', 'TallyRateLimit']) {
      expect([m, plan.includes(m), NOT_BACKED_UP.has(m)]).toEqual([m, false, true])
    }
    // Leaving them out changes nothing else: same tables, order, parents and restore flags as a schema without them
    const models = Prisma.dmmf.datamodel.models as unknown as NonNullable<Parameters<typeof backupPlan>[0]>
    expect(backupPlan(models)).toEqual(backupPlan(models.filter((m) => !m.name.startsWith('Tally'))))
    expect([...NOT_BACKED_UP].filter((m) => !m.startsWith('Tally'))).toEqual(['IdempotencyKey'])
  })

  test('backup → restore with a paired connector: no Tally data in the file, the connector untouched by the restore', async () => {
    const { user, company, token, c } = await onlineConnector()
    await seedBusiness(company.id)
    const j = (await newJob(user)).json.data.id as string
    await takeNextJob(c)
    await postResult(token, { jobId: j, ok: true, records: [{ name: 'Real Co' }] })

    const res = await download(apiRequest(`/api/companies/${company.id}/backup?companyId=${company.id}`, { user }), ctx({ id: company.id }))
    expect(res.status).toBe(200)
    const backup = await res.json()
    const text = JSON.stringify(backup)
    expect(Object.keys(backup.data).filter((k) => /tally/i.test(k))).toEqual([])
    expect(text).not.toContain(c.secretHash)
    expect(text).not.toContain('Real Co')
    expect(backup.data.customers.length).toBe(1)

    // a hand-edited file trying to plant a connector is ignored
    backup.data.tallyConnectors = [{ ...c, id: 'f'.repeat(24), activeFor: company.id }]
    await db.customer.create({ data: { companyId: company.id, code: 'C-0002', name: 'Added after the backup' } })
    const tallyBefore = { connectors: await db.tallyConnector.findMany(), jobs: await db.tallyJob.count(), chunks: await db.tallyJobChunk.count() }
    const r = await call(restore(apiRequest(`/api/companies/${company.id}/restore?companyId=${company.id}`, { user, body: { confirmName: company.name, backup } }), ctx({ id: company.id })))
    expect(r.status).toBe(200)
    expect(await db.customer.count({ where: { companyId: company.id } })).toBe(1) // business data restored as it was
    expect({ connectors: await db.tallyConnector.findMany(), jobs: await db.tallyJob.count(), chunks: await db.tallyJobChunk.count() }).toEqual(tallyBefore)
    await resetLimiter()
    expect((await beat(token)).status).toBe(200) // still paired with the same token
  })

  test('a whole connector lifecycle leaves existing ManuFlow data exactly as it was', async () => {
    const { company, user } = await seedTenant()
    await seedBusiness(company.id)
    const other = await seedTenant()
    await seedBusiness(other.company.id)
    const auditBefore = await db.auditLog.count()
    const before = await businessCounts()

    const path = cfgPath()
    await connector.pair({ server: serverUrl(), code: await newCode(user), tally: tallyUrl(), path })
    await connector.runLoop({ path, log: () => {}, maxBeats: 1 })
    await ageToken(idOf(connector.loadConfig(path).token))
    await resetLimiter()
    await connector.runLoop({ path, log: () => {}, maxBeats: 1 })
    await cleanupTallyTables(new Date(Date.now() + 40 * 24 * 60 * 60 * 1000))
    await call(disconnect(apiRequest('/api/import-center/tally/connector', { method: 'DELETE', user })))

    const after = await businessCounts()
    // only the audit trail grows (code created, paired, disconnected); every other table is identical
    expect(after.AuditLog - auditBefore).toBe(3)
    expect({ ...after, AuditLog: 0 }).toEqual({ ...before, AuditLog: 0 })
    expect(await db.customer.count({ where: { companyId: other.company.id } })).toBe(1)
  })
})
