import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { GET as tallyStatus } from '@/app/api/import-center/tally/status/route'
import { TALLY_HEALTH_REQUEST, checkTally, looksLikeTallyXml, tallyEndpoint } from '@/lib/tally/client'
import { apiRequest, call } from './helpers/api'
import { resetDb } from './helpers/db'
import { seedTenant, seedUser } from './helpers/seed'

// A stand-in HTTP server — real TallyPrime is not available in this environment.
type Mode = 'tally' | 'html' | 'http500' | 'slow' | 'huge' | 'doctype' | 'redirect'
let mode: Mode = 'tally'
let lastBody = ''
let server: ReturnType<typeof Bun.serve>
beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      lastBody = await req.text()
      if (mode === 'slow') await Bun.sleep(1500)
      if (mode === 'html') return new Response('<html><body>Router login</body></html>')
      if (mode === 'http500') return new Response('oops', { status: 500 })
      if (mode === 'redirect') return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } })
      if (mode === 'huge') return new Response(`<ENVELOPE>${'x'.repeat(300 * 1024)}</ENVELOPE>`)
      if (mode === 'doctype') return new Response('<!DOCTYPE x [<!ENTITY a "b">]><ENVELOPE>&a;</ENVELOPE>')
      return new Response('<?xml version="1.0"?>\n<ENVELOPE><HEADER><VERSION>1</VERSION><STATUS>0</STATUS></HEADER><BODY><DATA><LINEERROR>Could not find Report</LINEERROR></DATA></BODY></ENVELOPE>')
    },
  })
})
afterAll(() => server.stop(true))

const url = () => `http://127.0.0.1:${server.port}/`
const endpoint = () => `127.0.0.1:${server.port}`

describe('Tally connectivity check (mock server)', () => {
  test('connected only for a Tally-style XML envelope; the documented ENVELOPE request is sent', async () => {
    mode = 'tally'
    const r = await checkTally(url(), endpoint())
    expect(r.status).toBe('connected')
    expect(r.message).toContain('not available yet') // never claims companies or data
    expect(lastBody).toBe(TALLY_HEALTH_REQUEST)
  })

  test('non-Tally replies are not treated as a connection', async () => {
    for (const m of ['html', 'http500', 'huge', 'doctype', 'redirect'] as Mode[]) {
      mode = m
      const r = await checkTally(url(), endpoint())
      expect([m, r.status]).toEqual([m, 'invalid_response'])
    }
  })

  test('timeout and unreachable', async () => {
    mode = 'slow'
    expect((await checkTally(url(), endpoint(), { timeoutMs: 200 })).status).toBe('timeout')
    // A port nothing listens on
    const probe = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') })
    const closed = probe.port
    probe.stop(true)
    expect((await checkTally(`http://127.0.0.1:${closed}/`, `127.0.0.1:${closed}`, { timeoutMs: 1000 })).status).toBe('unreachable')
  })

  test('XML shape check', () => {
    expect(looksLikeTallyXml('<RESPONSE>TallyPrime Server is Running</RESPONSE>')).toBe(true)
    expect(looksLikeTallyXml('\ufeff<?xml version="1.0"?><ENVELOPE></ENVELOPE>')).toBe(true)
    expect(looksLikeTallyXml('<ENVELOPE>unterminated')).toBe(false)
    expect(looksLikeTallyXml('{"ENVELOPE":1}')).toBe(false)
  })

  test('endpoint settings come only from TALLY_HTTP_URL and are validated', () => {
    expect(tallyEndpoint({})).toBeNull()
    expect(tallyEndpoint({ TALLY_HTTP_URL: 'http://192.168.1.20:9000' })).toEqual({ url: 'http://192.168.1.20:9000/', endpoint: '192.168.1.20:9000' })
    for (const bad of ['ftp://x:21', 'http://u:p@host:9000', 'http://host:9000/path', 'nonsense', 'http://host:9000/?a=1']) {
      expect(tallyEndpoint({ TALLY_HTTP_URL: bad })).toMatchObject({ error: { status: 'invalid_config' } })
    }
  })
})

describe('GET /api/import-center/tally/status', () => {
  beforeEach(resetDb)
  const saved = process.env.TALLY_HTTP_URL

  test('not configured → Not connected with the connector explanation (no fake data)', async () => {
    delete process.env.TALLY_HTTP_URL
    const { user } = await seedTenant()
    const r = await call(tallyStatus(apiRequest('/api/import-center/tally/status', { user })))
    expect(r.status).toBe(200)
    expect(r.json.data.status).toBe('not_configured')
    expect(JSON.stringify(r.json.data)).not.toMatch(/compan(y|ies)"\s*:/i)
    process.env.TALLY_HTTP_URL = saved
  })

  test('configured → real check; the address in the request is ignored', async () => {
    process.env.TALLY_HTTP_URL = url()
    mode = 'tally'
    const { user } = await seedTenant()
    const r = await call(tallyStatus(apiRequest('/api/import-center/tally/status?url=http://169.254.169.254/', { user })))
    expect(r.json.data).toMatchObject({ status: 'connected', endpoint: endpoint() })
    if (saved === undefined) delete process.env.TALLY_HTTP_URL
    else process.env.TALLY_HTTP_URL = saved
  })

  test('requires Import Center access', async () => {
    const { company } = await seedTenant()
    const viewer = await seedUser(company.id, 'VIEWER')
    expect((await call(tallyStatus(apiRequest('/api/import-center/tally/status', { user: viewer })))).status).toBe(403)
  })
})
