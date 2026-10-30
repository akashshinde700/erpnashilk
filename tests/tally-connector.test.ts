import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, statSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GET as statusRoute, POST as createCode, DELETE as disconnect } from '@/app/api/import-center/tally/connector/route'
import { POST as pairRoute } from '@/app/api/tally-connector/pair/route'
import { POST as heartbeatRoute } from '@/app/api/tally-connector/heartbeat/route'
import { db } from '@/lib/db'
import { TALLY_HEALTH_REQUEST } from '@/lib/tally/client'
import { PAIRING_TTL_MS, connectorStore, normalizeCode, resetConnectorStore } from '@/lib/tally/connector'
import * as connector from '../connector/tally/manuflow-tally-connector.mjs'
import { apiRequest, call, type TestUser } from './helpers/api'
import { resetDb } from './helpers/db'
import { seedTenant, seedUser } from './helpers/seed'

// Mock TallyPrime (real TallyPrime is not available here) — records every request body it receives
type Mode = 'tally' | 'html' | 'down' | 'import-ok' | 'import-duplicate'
let tallyMode: Mode = 'tally'
const tallyBodies: string[] = []
let tally: ReturnType<typeof Bun.serve>
// ManuFlow's connector endpoints served over HTTP so the real connector program can talk to them
let manuflow: ReturnType<typeof Bun.serve>
let dir = ''
const savedFlag = process.env.TALLY_CONNECTOR_POC

beforeAll(() => {
  tally = Bun.serve({
    port: 0, hostname: '127.0.0.1',
    async fetch(req) {
      tallyBodies.push(await req.text())
      if (tallyMode === 'html') return new Response('<html>router</html>')
      if (tallyMode === 'import-ok') return new Response('<ENVELOPE><HEADER><VERSION>1</VERSION><STATUS>1</STATUS></HEADER><BODY><DATA><IMPORTRESULT><CREATED>1</CREATED></IMPORTRESULT></DATA></BODY></ENVELOPE>')
      if (tallyMode === 'import-duplicate') return new Response('<ENVELOPE><HEADER><VERSION>1</VERSION><STATUS>0</STATUS></HEADER><BODY><DATA><LINEERROR>Voucher number already exists</LINEERROR></DATA></BODY></ENVELOPE>')
      return new Response('<ENVELOPE><HEADER><VERSION>1</VERSION><STATUS>0</STATUS></HEADER><BODY><DATA><LINEERROR>Could not find Report</LINEERROR></DATA></BODY></ENVELOPE>')
    },
  })
  manuflow = Bun.serve({
    port: 0, hostname: '127.0.0.1',
    fetch(req) {
      const path = new URL(req.url).pathname
      if (path === '/api/tally-connector/pair') return pairRoute(req)
      if (path === '/api/tally-connector/heartbeat') return heartbeatRoute(req)
      return new Response('not found', { status: 404 })
    },
  })
  dir = mkdtempSync(join(tmpdir(), 'mf-connector-test-'))
})
afterAll(() => {
  tally.stop(true)
  manuflow.stop(true)
  rmSync(dir, { recursive: true, force: true })
  if (savedFlag === undefined) delete process.env.TALLY_CONNECTOR_POC
  else process.env.TALLY_CONNECTOR_POC = savedFlag
})
beforeEach(async () => {
  await resetDb()
  resetConnectorStore()
  process.env.TALLY_CONNECTOR_POC = '1'
  tallyMode = 'tally'
  tallyBodies.length = 0
})

const tallyUrl = () => `http://127.0.0.1:${tally.port}`
const serverUrl = () => `http://127.0.0.1:${manuflow.port}`
let n = 0
const cfgPath = () => join(dir, `c${++n}`, 'connector.json')

const status = (user: TestUser, companyId?: string) =>
  call(statusRoute(apiRequest(`/api/import-center/tally/connector${companyId ? `?companyId=${companyId}` : ''}`, { user })))
const newCode = (user: TestUser) => call(createCode(apiRequest('/api/import-center/tally/connector', { method: 'POST', user })))
const pairWith = (code: unknown, headers: Record<string, string> = {}) =>
  call(pairRoute(apiRequest('/api/tally-connector/pair', { body: { code, version: 't', platform: 'linux' }, headers })))
const beat = (token: string | null, body: unknown = { tally: { status: 'connected', latencyMs: 12, endpoint: '127.0.0.1:9000' } }) =>
  call(heartbeatRoute(apiRequest('/api/tally-connector/heartbeat', { body, headers: token ? { authorization: `Bearer ${token}` } : {} })))

/** Pair a connector for this admin's company; the in-process heartbeat limiter is cleared afterwards. */
async function paired(user: TestUser) {
  const code = (await newCode(user)).json.data.code as string
  const r = await pairWith(code)
  expect(r.status).toBe(200)
  return r.json.data.token as string
}

describe('push to Tally (the only write)', () => {
  const pushXml = () => '<?xml version="1.0" encoding="UTF-8"?>\n<ENVELOPE><HEADER><VERSION>1</VERSION>' +
    '<TALLYREQUEST>Import Data</TALLYREQUEST><TYPE>Data</TYPE><ID>Vouchers</ID></HEADER>' +
    '<BODY><DESC><STATICVARIABLES><SVCURRENTCOMPANY>Nashilk</SVCURRENTCOMPANY></STATICVARIABLES></DESC>' +
    '<DATA><TALLYMESSAGE><VOUCHER VCHTYPE="Sales" ACTION="Create" OBJVIEW="Invoice Voucher View">' +
    '<DATE>20260910</DATE><VOUCHERNUMBER>INV/26-27/0001</VOUCHERNUMBER>' +
    '</VOUCHER></TALLYMESSAGE></DATA></BODY></ENVELOPE>'

  test('only a single create-voucher envelope is accepted', () => {
    expect(connector.pushProblem(pushXml())).toBeNull()
    expect(connector.pushProblem('')).toBe('empty')
    expect(connector.pushProblem(pushXml().replace('ACTION="Create"', 'ACTION="Delete"'))).toBe('not_a_create')
    expect(connector.pushProblem(pushXml().replace('Import Data', 'Export'))).toBe('not_an_import')
    expect(connector.pushProblem('<!DOCTYPE x [<!ENTITY a "b">]>' + pushXml())).toBe('unsafe_xml')
  })

  test('the voucher is posted to Tally as-is and a created voucher comes back', async () => {
    tallyMode = 'import-ok'
    const out = await connector.pushVoucher(tallyUrl(), {
      id: 'job_1', type: 'push-voucher', xml: pushXml(),
    })
    expect(out.ok).toBe(true)
    expect(out.records?.[0]).toMatchObject({ name: 'INV/26-27/0001', status: 'created' })
    // Exactly the document it was given — no rebuild, no extra request.
    expect(tallyBodies.at(-1)).toBe(pushXml())
  })

  test('a duplicate in Tally is reported as "already there", not as a failure', async () => {
    tallyMode = 'import-duplicate'
    const out = await connector.pushVoucher(tallyUrl(), { id: 'job_2', type: 'push-voucher', xml: pushXml() })
    expect(out.ok).toBe(true)
    expect(out.records?.[0]?.status).toBe('exists')
  })

  test('Tally refusing the voucher fails the job with a fixable message', async () => {
    tallyMode = 'tally'
    const out = await connector.pushVoucher(tallyUrl(), { id: 'job_3', type: 'push-voucher', xml: pushXml() })
    expect(out).toEqual({ ok: false, error: 'voucher_rejected' })
  })
})

describe('feature switch', () => {
  test('off by default: status says unavailable; pairing and connector endpoints refuse (503)', async () => {
    delete process.env.TALLY_CONNECTOR_POC
    const { user } = await seedTenant()
    const s = await status(user)
    expect(s.json.data.state).toBe('unavailable')
    expect((await newCode(user)).status).toBe(503)
    expect((await pairWith('ABCDE-FGHJK')).status).toBe(503)
    expect((await beat('x')).status).toBe(503)
  })
})

describe('pairing', () => {
  test('code is shown once, stored hashed, and works exactly once', async () => {
    const { user, company } = await seedTenant()
    const c = await newCode(user)
    expect(c.status).toBe(200)
    expect(c.json.data.code).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/)
    // status never echoes the code
    const s = await status(user)
    expect(s.json.data.state).toBe('pairing')
    expect(JSON.stringify(s.json)).not.toContain(c.json.data.code)
    expect(JSON.stringify(s.json)).not.toContain(normalizeCode(c.json.data.code)!)

    const p = await pairWith(c.json.data.code.toLowerCase().replace('-', ' '))
    expect(p.status).toBe(200)
    expect(p.json.data.token).toMatch(/^mftc_[a-f0-9]{24}_/)
    // the token is not stored in clear
    const rec = await connectorStore().getConnector(p.json.data.connectorId)
    expect(rec!.companyId).toBe(company.id)
    expect(rec!.secretHash).not.toContain(p.json.data.token.split('_')[2])

    const again = await pairWith(c.json.data.code)
    expect([again.status, again.json.error?.code]).toEqual([401, 'PAIRING_CODE_INVALID'])
    const audit = await db.auditLog.findMany({ where: { companyId: company.id, entity: { startsWith: 'TallyConnector' } } })
    expect(audit.length).toBe(2)
    expect(JSON.stringify(audit)).not.toContain(p.json.data.token)
  })

  test('expired, malformed and replaced codes are refused', async () => {
    const { user } = await seedTenant()
    const first = (await newCode(user)).json.data.code
    const second = (await newCode(user)).json.data.code // replaces the first
    expect((await pairWith(first)).status).toBe(401)
    expect((await pairWith('not-a-code')).json.error?.code).toBe('PAIRING_CODE_INVALID')
    expect((await pairWith(12345)).status).toBe(401)
    // expire the open code
    const realNow = Date.now
    Date.now = () => realNow() + PAIRING_TTL_MS + 1000
    try {
      const r = await pairWith(second)
      expect([r.status, r.json.error?.code]).toEqual([401, 'PAIRING_CODE_EXPIRED'])
    } finally {
      Date.now = realNow
    }
    expect((await status(user)).json.data.state).toBe('not_paired')
  })

  test('wrong codes are rate-limited per IP', async () => {
    const { user } = await seedTenant()
    const good = (await newCode(user)).json.data.code
    const ip = { 'x-forwarded-for': '203.0.113.7' }
    for (let i = 0; i < 10; i++) expect((await pairWith('AAAAA-AAAAA', ip)).status).toBe(401)
    const blocked = await pairWith(good, ip)
    expect(blocked.status).toBe(429)
    // the code was not consumed by the blocked attempt; another address can still use it
    expect((await pairWith(good, { 'x-forwarded-for': '198.51.100.2' })).status).toBe(200)
  })

  test('only administrators can create codes or disconnect; viewers cannot see status', async () => {
    const { company } = await seedTenant()
    for (const role of ['SALES', 'STORE_MANAGER', 'ACCOUNTANT']) {
      const u = await seedUser(company.id, role)
      expect([role, (await newCode(u)).status]).toEqual([role, 403])
      expect([role, (await call(disconnect(apiRequest('/api/import-center/tally/connector', { method: 'DELETE', user: u })))).status]).toEqual([role, 403])
    }
    const viewer = await seedUser(company.id, 'VIEWER')
    expect((await status(viewer)).status).toBe(403)
    expect((await call(statusRoute(apiRequest('/api/import-center/tally/connector')))).status).toBe(401)
  })
})

describe('connector requests', () => {
  test('heartbeat needs a valid, active token', async () => {
    const { user } = await seedTenant()
    const token = await paired(user)
    expect((await beat(null)).status).toBe(401)
    expect((await beat('garbage')).status).toBe(401)
    // right id, wrong secret
    const forged = token.slice(0, -4) + (token.endsWith('AAAA') ? 'BBBB' : 'AAAA')
    expect((await beat(forged)).json.error?.code).toBe('CONNECTOR_UNAUTHORIZED')
    // a session cookie identity does not substitute for the token
    expect((await call(heartbeatRoute(apiRequest('/api/tally-connector/heartbeat', { body: { tally: { status: 'connected' } }, user })))).status).toBe(401)
    const ok = await beat(token)
    expect(ok.status).toBe(200)
    expect(ok.json.data).toEqual({ nextHeartbeatSec: 30 }) // no command, URL or XML ever comes back
  })

  test('heartbeat input is validated; unknown fields and public addresses are dropped', async () => {
    const { user } = await seedTenant()
    const token = await paired(user)
    expect((await beat(token, { tally: { status: 'drop tables' } })).status).toBe(400)
    resetLimiter()
    const r = await beat(token, { tally: { status: 'connected', endpoint: '8.8.8.8:9000', latencyMs: -5 }, command: 'IMPORT' })
    expect(r.status).toBe(200)
    const s = (await status(user)).json.data
    expect(s.connector.tallyEndpoint).toBeNull()
    expect(s.connector.latencyMs).toBeNull()
    // too frequent
    expect((await beat(token)).status).toBe(429)
    // oversize body
    resetLimiter()
    expect((await beat(token, { tally: { status: 'connected' }, pad: 'x'.repeat(5000) })).status).toBe(413)
  })

  test('tenant isolation: a connector only ever reports for its own company', async () => {
    const a = await seedTenant()
    const b = await seedTenant()
    const tokenA = await paired(a.user)
    expect((await beat(tokenA)).status).toBe(200)
    expect((await status(a.user)).json.data.state).toBe('connected')
    expect((await status(b.user)).json.data.state).toBe('not_paired')
    // B's admin cannot read A's status by naming A's company
    expect((await status(b.user, a.company.id)).status).toBe(403)
    // B disconnecting does not touch A
    await call(disconnect(apiRequest('/api/import-center/tally/connector', { method: 'DELETE', user: b.user })))
    resetLimiter()
    expect((await beat(tokenA)).status).toBe(200)
  })

  test('states: offline, tally_error, connected with last success', async () => {
    const { user } = await seedTenant()
    const token = await paired(user)
    expect((await status(user)).json.data.state).toBe('offline')
    await beat(token)
    const s1 = (await status(user)).json.data
    expect(s1.state).toBe('connected')
    expect(s1.message).toBe('The connector is online and TallyPrime is answering.') // a connection, not a claim about data
    resetLimiter()
    await beat(token, { tally: { status: 'unreachable' } })
    const s2 = (await status(user)).json.data
    expect(s2.state).toBe('tally_error')
    expect(s2.connector.lastSuccessAt).toBe(s1.connector.lastSuccessAt)
    expect(s2.message).toContain('Data Synchronization')
    const realNow = Date.now
    Date.now = () => realNow() + 120_000
    try { expect((await status(user)).json.data.state).toBe('offline') } finally { Date.now = realNow }
  })

  test('disconnect revokes the token at once; reconnect pairs a new connector and retires the old one', async () => {
    const { user } = await seedTenant()
    const t1 = await paired(user)
    const d = await call(disconnect(apiRequest('/api/import-center/tally/connector', { method: 'DELETE', user })))
    expect(d.json.data.revoked).toBe(true)
    expect((await beat(t1)).json.error?.code).toBe('CONNECTOR_REVOKED')
    expect((await status(user)).json.data.state).toBe('not_paired')

    const t2 = await paired(user)
    const t3 = await paired(user) // pairing again replaces t2
    expect((await beat(t2)).status).toBe(401)
    expect((await beat(t3)).status).toBe(200)
  })
})

/** Heartbeats are limited to one per 5 s per connector: clear the limiters (keeping the store) instead of waiting. */
function resetLimiter() {
  resetConnectorStore(connectorStore())
}

describe('connector program', () => {
  test('Tally address must be local / private; ManuFlow address must be https', () => {
    for (const ok of ['http://127.0.0.1:9000', 'http://localhost:9000', 'http://192.168.1.20:9000', 'http://10.0.0.5:9000', 'http://172.20.1.1:9000', 'http://[::1]:9000']) {
      expect([ok, connector.validateTallyUrl(ok).error]).toEqual([ok, undefined])
    }
    for (const bad of ['http://8.8.8.8:9000', 'http://169.254.169.254/', 'http://tally.example.com:9000', 'https://127.0.0.1:9000',
      'http://u:p@127.0.0.1:9000', 'http://127.0.0.1:9000/path', 'http://172.32.0.1:9000', 'http://192.168.1.300:9000', 'file:///etc/passwd', '']) {
      expect([bad, typeof connector.validateTallyUrl(bad).error]).toEqual([bad, 'string'])
    }
    expect(connector.validateServerUrl('https://www.menu.aetherdevsolutions.online').url).toBe('https://www.menu.aetherdevsolutions.online')
    expect(connector.validateServerUrl('http://erp.example.com').error).toBeDefined()
    expect(connector.validateServerUrl('http://127.0.0.1:3000').url).toBe('http://127.0.0.1:3000')
  })

  test('sends only the fixed read-only health request, identical to the server-side check', async () => {
    expect(connector.TALLY_HEALTH_REQUEST).toBe(TALLY_HEALTH_REQUEST)
    expect(TALLY_HEALTH_REQUEST).toContain('<TALLYREQUEST>Export</TALLYREQUEST>')
    expect(TALLY_HEALTH_REQUEST).not.toMatch(/Import|Alter|Delete|Create/)
    expect((await connector.checkTally(tallyUrl())).status).toBe('connected')
    tallyMode = 'html'
    expect((await connector.checkTally(tallyUrl())).status).toBe('invalid_response')
    expect((await connector.checkTally('http://8.8.8.8:9000')).status).toBe('invalid_config')
    expect(tallyBodies.every((b) => b === TALLY_HEALTH_REQUEST)).toBe(true)
  })

  test('end to end: pair → heartbeat → connected → disconnect → token deleted', async () => {
    const { user } = await seedTenant()
    const path = cfgPath()
    const code = (await newCode(user)).json.data.code
    await connector.pair({ server: serverUrl(), code, tally: tallyUrl(), path })
    // saved readable by this user only; token never printed
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o077).toBe(0)
    const saved = JSON.parse(readFileSync(path, 'utf8'))
    expect(saved.tally).toBe(`${tallyUrl()}/`)

    const logs: string[] = []
    expect(await connector.runLoop({ path, log: (m: string) => logs.push(m), maxBeats: 1 })).toBe(0)
    expect(logs.join('\n')).not.toContain(saved.token)
    const s = (await status(user)).json.data
    expect(s.state).toBe('connected')
    expect(s.connector.tallyEndpoint).toBe(`127.0.0.1:${tally.port}`)

    // Tally closed → connector stays online, UI shows a Tally error
    resetLimiter()
    tallyMode = 'html'
    await connector.runLoop({ path, log: () => {}, maxBeats: 1 })
    expect((await status(user)).json.data.state).toBe('tally_error')

    await call(disconnect(apiRequest('/api/import-center/tally/connector', { method: 'DELETE', user })))
    resetLimiter()
    expect(await connector.runLoop({ path, log: () => {}, maxBeats: 1 })).toBe(2)
    expect(connector.loadConfig(path)).toBeNull()
    expect(tallyBodies.every((b) => b === TALLY_HEALTH_REQUEST)).toBe(true)
  })

  test('pairing with a wrong code saves nothing; ManuFlow down → retries with back-off', async () => {
    const path = cfgPath()
    await expect(connector.pair({ server: serverUrl(), code: 'AAAAA-AAAAA', tally: tallyUrl(), path })).rejects.toThrow(/wrong or was already used/)
    expect(connector.loadConfig(path)).toBeNull()

    const { saveConfig } = connector
    saveConfig({ server: 'http://127.0.0.1:1', token: 'mftc_x', tally: tallyUrl(), pairedAt: '' }, path)
    const waits: number[] = []
    const logs: string[] = []
    await connector.runLoop({ path, log: (m: string) => logs.push(m), maxBeats: 3, sleep: async (ms: number) => { waits.push(ms) } })
    expect(waits).toEqual([15000, 30000])
    expect(logs.join('\n')).not.toContain('mftc_x')
  })
})
