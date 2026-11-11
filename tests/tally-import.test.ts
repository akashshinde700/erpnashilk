import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { POST as createCode } from '@/app/api/import-center/tally/connector/route'
import { DELETE as cancelJobRoute, GET as getJob, POST as createJobRoute } from '@/app/api/import-center/tally/jobs/route'
import { POST as importRoute } from '@/app/api/import-center/tally/import/route'
import { POST as heartbeatRoute } from '@/app/api/tally-connector/heartbeat/route'
import { POST as pairRoute } from '@/app/api/tally-connector/pair/route'
import { POST as resultRoute } from '@/app/api/tally-connector/result/route'
import { db } from '@/lib/db'
import { partyData } from '@/lib/party'
import { importCustomers } from '@/lib/services/customer-import'
import { JOB_RUN_LIMIT_MS } from '@/lib/tally/connector'
import * as connector from '../connector/tally/manuflow-tally-connector.mjs'
import { apiRequest, call, type TestUser } from './helpers/api'
import { resetDb } from './helpers/db'
import { seedTenant, seedUser } from './helpers/seed'

// ---------------------------------------------------------------- mock TallyPrime (no real TallyPrime here)

type TallyMode = 'ok' | 'no-companies' | 'line-error' | 'utf16' | 'html' | 'slow'
let mode: TallyMode = 'ok'
let debtorCount = 3
const bodies: string[] = []
// A test's own debtor / creditor ledgers (synthetic), replacing the defaults when set
let customDebtors: string | null = null
let customCreditors: string | null = null

function partyXml(i: number) {
  // Alternate the older flat fields and the TallyPrime 3+ nested lists
  if (i % 2) {
    return `<LEDGER NAME="Debtor ${i}" RESERVEDNAME=""><GUID>g-d-${i}</GUID><PARENT>Sundry Debtors</PARENT>` +
      `<LEDGSTREGDETAILS.LIST><GSTREGISTRATIONTYPE>Regular</GSTREGISTRATIONTYPE><GSTIN>27AAPFU0939F1Z${i % 10}</GSTIN></LEDGSTREGDETAILS.LIST>` +
      `<LEDMAILINGDETAILS.LIST><ADDRESS.LIST><ADDRESS>Plot ${i}</ADDRESS><ADDRESS>MIDC</ADDRESS></ADDRESS.LIST><STATE>Maharashtra</STATE><PINCODE>411019</PINCODE></LEDMAILINGDETAILS.LIST></LEDGER>`
  }
  return `<LEDGER NAME="Debtor ${i}"><GUID>g-d-${i}</GUID><PARENT>Sundry Debtors</PARENT><LEDSTATENAME>Gujarat</LEDSTATENAME>` +
    `<ADDRESS.LIST><ADDRESS>Shop ${i}</ADDRESS></ADDRESS.LIST><LEDGERMOBILE>98200${String(i).padStart(5, '0')}</LEDGERMOBILE><EMAIL>d${i}@example.test</EMAIL></LEDGER>`
}

function reply(id: string): string {
  if (mode === 'line-error') return '<ENVELOPE><HEADER><VERSION>1</VERSION><STATUS>0</STATUS></HEADER><BODY><DATA><LINEERROR>Could not set \'SVCurrentCompany\' to \'X\'</LINEERROR></DATA></BODY></ENVELOPE>'
  const wrap = (inner: string) => `<?xml version="1.0"?>\n<ENVELOPE><HEADER><VERSION>1</VERSION><STATUS>1</STATUS></HEADER><BODY><DESC></DESC><DATA><COLLECTION>${inner}</COLLECTION></DATA></BODY></ENVELOPE>`
  switch (id) {
    case 'ManuFlowCompanies':
      return wrap(mode === 'no-companies' ? '' :
        '<COMPANY NAME="Shree &amp; Sons Pvt Ltd"><NAME>Shree &amp; Sons Pvt Ltd</NAME><STARTINGFROM TYPE="Date">20260401</STARTINGFROM><BOOKSFROM TYPE="Date">20240401</BOOKSFROM></COMPANY>' +
        '<COMPANY NAME="Trial Co&#4;"><STARTINGFROM>20250401</STARTINGFROM></COMPANY>')
    case 'ManuFlowDebtors':
      return wrap(customDebtors ?? Array.from({ length: debtorCount }, (_, i) => partyXml(i + 1)).join(''))
    case 'ManuFlowCreditors':
      if (customCreditors !== null) return wrap(customCreditors)
      return wrap('<LEDGER NAME="Steel Traders"><GUID>g-c-1</GUID><PARTYGSTIN>24AAACS1234A1Z5</PARTYGSTIN><GSTREGISTRATIONTYPE>Regular</GSTREGISTRATIONTYPE><INCOMETAXNUMBER>AAACS1234A</INCOMETAXNUMBER></LEDGER>')
    case 'ManuFlowStockItems':
      return wrap(
        '<STOCKITEM NAME="MS Bolt M8"><GUID>g-i-1</GUID><PARENT>Fasteners</PARENT><BASEUNITS>Nos</BASEUNITS>' +
        '<GSTDETAILS.LIST><HSNCODE>7318</HSNCODE><STATEWISEDETAILS.LIST><RATEDETAILS.LIST><GSTRATEDUTYHEAD>CGST</GSTRATEDUTYHEAD><GSTRATE>9</GSTRATE></RATEDETAILS.LIST>' +
        '<RATEDETAILS.LIST><GSTRATEDUTYHEAD>IGST</GSTRATEDUTYHEAD><GSTRATE>18</GSTRATE></RATEDETAILS.LIST></STATEWISEDETAILS.LIST></GSTDETAILS.LIST></STOCKITEM>' +
        '<STOCKITEM NAME="Cutting Oil"><GUID>g-i-2</GUID><BASEUNITS>Ltr</BASEUNITS></STOCKITEM>') // no GST rate → must not be guessed
    default:
      return wrap('')
  }
}

let tally: ReturnType<typeof Bun.serve>
let manuflow: ReturnType<typeof Bun.serve>
let dir = ''
const savedFlag = process.env.TALLY_CONNECTOR_POC

beforeAll(() => {
  tally = Bun.serve({
    port: 0, hostname: '127.0.0.1',
    async fetch(req) {
      const body = await req.text()
      bodies.push(body)
      if (mode === 'html') return new Response('<html>router</html>')
      if (mode === 'slow') await Bun.sleep(400)
      const id = /<ID>([^<]*)<\/ID>/.exec(body)?.[1] ?? ''
      if (id === 'ManuFlow Connectivity Check') return new Response('<ENVELOPE><HEADER><STATUS>0</STATUS></HEADER></ENVELOPE>')
      const text = reply(id)
      if (mode === 'utf16') return new Response(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]))
      return new Response(text)
    },
  })
  manuflow = Bun.serve({
    port: 0, hostname: '127.0.0.1',
    fetch(req) {
      const p = new URL(req.url).pathname
      if (p === '/api/tally-connector/pair') return pairRoute(req)
      if (p === '/api/tally-connector/heartbeat') return heartbeatRoute(req)
      if (p === '/api/tally-connector/result') return resultRoute(req)
      return new Response('not found', { status: 404 })
    },
  })
  dir = mkdtempSync(join(tmpdir(), 'mf-tally-import-test-'))
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
  process.env.TALLY_CONNECTOR_POC = '1'
  mode = 'ok'
  debtorCount = 3
  customDebtors = null
  customCreditors = null
  bodies.length = 0
})

// ---------------------------------------------------------------- helpers

let n = 0
interface Linked { user: TestUser; companyId: string; path: string }

/** Admin + paired connector (the real connector program) that has reported Tally reachable. */
async function linked(): Promise<Linked> {
  const { user, company } = await seedTenant()
  const path = join(dir, `c${++n}`, 'connector.json')
  const code = (await call(createCode(apiRequest('/api/import-center/tally/connector', { method: 'POST', user })))).json.data.code
  await connector.pair({ server: `http://127.0.0.1:${manuflow.port}`, code, tally: `http://127.0.0.1:${tally.port}`, path })
  await beat(path)
  return { user, companyId: company.id, path }
}

/** Heartbeats are limited to one per 5 s per connector: move the last check-in 6 s back instead of waiting. */
const resetLimiter = () => db.tallyConnector.updateMany({ where: { lastSeenAt: { not: null } }, data: { lastSeenAt: new Date(Date.now() - 6000) } })

/** One connector cycle: Tally check + heartbeat + the job it was handed, if any. (Heartbeat limiter cleared.) */
async function beat(path: string) {
  await resetLimiter()
  return connector.heartbeatOnce(connector.loadConfig(path), path)
}

/** A bare heartbeat as the connector would send it, without running the job it gets. (Heartbeat limiter cleared.) */
/** A heartbeat as the connector sends it, with the device identity the token is bound to. */
async function rawBeat(token: string) {
  await resetLimiter()
  const deviceId = (await db.tallyConnector.findUnique({ where: { id: token.split('_')[1] } }))?.deviceId
  return call(heartbeatRoute(apiRequest('/api/tally-connector/heartbeat', { body: { tally: { status: 'connected' }, ...(deviceId ? { deviceId } : {}) }, headers: { authorization: `Bearer ${token}` } })))
}

const newJob = (user: TestUser, type: string, tallyCompany?: string) =>
  call(createJobRoute(apiRequest('/api/import-center/tally/jobs', { body: { type, tallyCompany }, user })))
const jobStatus = (user: TestUser, id: string) => call(getJob(apiRequest(`/api/import-center/tally/jobs?id=${id}`, { user })))

/** Ask for a job, let the connector run it, return the finished job. */
async function runJob(l: Linked, type: string, tallyCompany?: string) {
  const j = await newJob(l.user, type, tallyCompany)
  expect(j.status).toBe(200)
  await beat(l.path)
  return (await jobStatus(l.user, j.json.data.id)).json.data
}

async function companies(l: Linked) {
  return runJob(l, 'list-companies')
}

const importBatch = (user: TestUser, body: Record<string, unknown>) =>
  call(importRoute(apiRequest('/api/import-center/tally/import', { body, user })))

// ---------------------------------------------------------------- connector program: XML + requests

describe('connector: Tally requests and XML', () => {
  test('every request to Tally is a read-only Export; the company name is escaped', () => {
    for (const [type, def] of Object.entries(connector.JOBS)) {
      const xml = def.request('A & B <Ltd> "x"')
      expect([type, xml.match(/<TALLYREQUEST>([^<]*)<\/TALLYREQUEST>/g)]).toEqual([type, ['<TALLYREQUEST>Export</TALLYREQUEST>']])
      // whole words: the field ALTERID (only read) must not hide an Alter request
      expect(xml).not.toMatch(/Import|ACTION=|<IMPORTDATA|\bAlter\b|\bDelete\b|\bCreate\b/i)
      expect(connector.isExportRequest(xml)).toBe(true)
      if (type !== 'list-companies') expect(xml).toContain('<SVCURRENTCOMPANY>A &amp; B &lt;Ltd&gt; &quot;x&quot;</SVCURRENTCOMPANY>')
    }
  })

  test('XML reader: entities, CDATA, control characters; refuses DTDs and broken XML', () => {
    const t = connector.parseXml('<?xml version="1.0"?><A X="1 &amp; 2"><B>&lt;b&gt;&#4;&#x41;</B><![CDATA[<raw>]]></A>')
    const a = t.children[0]
    expect(a.attrs.X).toBe('1 & 2')
    expect(a.children[0].text).toBe('<b>A')
    expect(a.text).toContain('<raw>')
    expect(() => connector.parseXml('<!DOCTYPE x [<!ENTITY e "boom">]><A>&e;</A>')).toThrow()
    expect(() => connector.parseXml('<A><B></A></B>')).toThrow()
    expect(() => connector.parseXml('<A>')).toThrow()
  })

  test('unknown job names from the server are refused without contacting Tally', async () => {
    const before = bodies.length
    expect(await connector.runJob(`http://127.0.0.1:${tally.port}`, { id: 'x', type: 'import-vouchers' })).toEqual({ ok: false, error: 'tally_error' })
    expect(await connector.runJob(`http://127.0.0.1:${tally.port}`, { id: 'x', type: 'export-items' })).toEqual({ ok: false, error: 'tally_error' }) // no company
    expect(bodies.length).toBe(before)
  })
})

// ---------------------------------------------------------------- company list

describe('company list from Tally', () => {
  test('real list through the connector (names decoded, years from Tally)', async () => {
    const l = await linked()
    const j = await companies(l)
    expect(j.status).toBe('done')
    expect(j.companies).toEqual([
      { name: 'Shree & Sons Pvt Ltd', guid: null, booksFrom: '2024-04-01', startingFrom: '2026-04-01', ambiguous: false },
      { name: 'Trial Co', guid: null, booksFrom: null, startingFrom: '2025-04-01', ambiguous: false },
    ])
  })

  test('UTF-16 replies are read the same', async () => {
    const l = await linked()
    mode = 'utf16'
    expect((await companies(l)).companies.map((c: { name: string }) => c.name)).toEqual(['Shree & Sons Pvt Ltd', 'Trial Co'])
  })

  test('no company open in Tally → empty list (nothing invented)', async () => {
    const l = await linked()
    mode = 'no-companies'
    const j = await companies(l)
    expect([j.status, j.companies]).toEqual(['done', []])
  })

  test('Tally answers with something else → failed with a plain message', async () => {
    const l = await linked()
    mode = 'html'
    const j = await companies(l)
    expect(j.status).toBe('failed')
    expect(j.message).toMatch(/does not understand/)
  })

  test('the same request twice reuses the waiting job (double click)', async () => {
    const l = await linked()
    const a = await newJob(l.user, 'list-companies')
    const b = await newJob(l.user, 'list-companies')
    expect(b.json.data.id).toBe(a.json.data.id)
  })
})

// ---------------------------------------------------------------- job rules

describe('job rules', () => {
  test('connector offline / Tally unreachable / not paired → refused with a clear reason', async () => {
    const { user } = await seedTenant()
    expect((await newJob(user, 'list-companies')).json.error?.code).toBe('TALLY_NOT_CONNECTED')

    const l = await linked()
    mode = 'html'
    await beat(l.path) // Tally check fails now
    expect((await newJob(l.user, 'list-companies')).json.error?.code).toBe('TALLY_UNREACHABLE')

    mode = 'ok'
    await beat(l.path)
    const realNow = Date.now
    Date.now = () => realNow() + 120_000
    try { expect((await newJob(l.user, 'list-companies')).json.error?.code).toBe('CONNECTOR_OFFLINE') } finally { Date.now = realNow }
  })

  test('exports only for a company from Tally’s own latest list; unknown job types refused', async () => {
    const l = await linked()
    expect((await newJob(l.user, 'export-customers', 'Shree & Sons Pvt Ltd')).json.error?.code).toBe('TALLY_COMPANY_UNKNOWN') // no list yet
    await companies(l)
    expect((await newJob(l.user, 'export-customers', 'Some Other Co')).json.error?.code).toBe('TALLY_COMPANY_UNKNOWN')
    expect((await newJob(l.user, 'import-vouchers')).status).toBe(400)
    expect((await newJob(l.user, 'export-customers', 'Shree & Sons Pvt Ltd')).status).toBe(200)
  })

  test('permissions: viewer and signed-out requests refused; item export needs item rights', async () => {
    const l = await linked()
    const viewer = await seedUser(l.companyId, 'VIEWER')
    expect((await newJob(viewer, 'list-companies')).status).toBe(403)
    expect((await call(createJobRoute(apiRequest('/api/import-center/tally/jobs', { body: { type: 'list-companies' } })))).status).toBe(401)
    await companies(l)
    const sales = await seedUser(l.companyId, 'SALES_EXECUTIVE')
    const r = await newJob(sales, 'export-items', 'Trial Co')
    expect(r.status).toBe(403)
  })

  test('tenant isolation: another company cannot read, cancel or import a job', async () => {
    const l = await linked()
    const j = await companies(l)
    const other = await seedTenant()
    expect((await jobStatus(other.user, j.id)).status).toBe(404)
    expect((await call(cancelJobRoute(apiRequest(`/api/import-center/tally/jobs?id=${j.id}`, { method: 'DELETE', user: other.user })))).status).toBe(404)
    const exp = await runJob(l, 'export-customers', 'Shree & Sons Pvt Ltd')
    expect((await importBatch(other.user, { jobId: exp.id, dataType: 'customers', mode: 'preview', batch: 0 })).status).toBe(404)
  })

  test('cancel: the connector’s late result is dropped', async () => {
    const l = await linked()
    const j = await newJob(l.user, 'list-companies')
    // the connector takes the job, then the user cancels before it answers
    const hb = await rawBeat(connector.loadConfig(l.path).token)
    expect(hb.json.data.job).toEqual({ id: j.json.data.id, type: 'list-companies' })
    const c = await call(cancelJobRoute(apiRequest(`/api/import-center/tally/jobs?id=${j.json.data.id}`, { method: 'DELETE', user: l.user })))
    expect(c.json.data.status).toBe('cancelled')
    const late = await call(resultRoute(apiRequest('/api/tally-connector/result', {
      body: { jobId: j.json.data.id, ok: true, records: [{ name: 'X' }] }, headers: { authorization: `Bearer ${connector.loadConfig(l.path).token}` },
    })))
    expect(late.json.data.accepted).toBe(false)
    expect((await jobStatus(l.user, j.json.data.id)).json.data.status).toBe('cancelled')
  })

  test('a job the connector never answers is handed out once more, then fails after the time limit', async () => {
    const l = await linked()
    const j = await newJob(l.user, 'list-companies')
    const token = connector.loadConfig(l.path).token
    expect((await rawBeat(token)).json.data.job?.id).toBe(j.json.data.id)
    const realNow = Date.now
    try {
      Date.now = () => realNow() + JOB_RUN_LIMIT_MS + 1000
      expect((await rawBeat(token)).json.data.job?.id).toBe(j.json.data.id) // lease ran out: second (last) attempt
      Date.now = () => realNow() + 2 * (JOB_RUN_LIMIT_MS + 1000)
      expect((await rawBeat(token)).json.data.job).toBeUndefined()
      const s = (await jobStatus(l.user, j.json.data.id)).json.data
      expect([s.status, s.message]).toEqual(['failed', expect.stringMatching(/too long/)])
    } finally { Date.now = realNow }
  })

  test('results: only the connector’s own running job, known fields only, bad data fails the job', async () => {
    const l = await linked()
    const token = connector.loadConfig(l.path).token
    const post = (body: unknown, t = token) => call(resultRoute(apiRequest('/api/tally-connector/result', { body, headers: { authorization: `Bearer ${t}` } })))
    expect((await post({ jobId: 'nope', ok: true, records: [] })).status).toBe(404)
    expect((await post({ jobId: 'x', ok: true, records: [] }, 'mftc_bad')).status).toBe(401)

    const j = await newJob(l.user, 'list-companies')
    await rawBeat(token)
    expect((await post({ jobId: j.json.data.id, ok: true, records: [{ name: 'A'.repeat(500) }] })).status).toBe(400)
    expect((await jobStatus(l.user, j.json.data.id)).json.data.status).toBe('failed')

    const k = await newJob(l.user, 'list-companies')
    await rawBeat(token)
    await post({ jobId: k.json.data.id, ok: true, records: [{ name: 'Real Co', password: 'x', booksFrom: '2024-04-01' }, { name: '' }] })
    expect((await jobStatus(l.user, k.json.data.id)).json.data.companies).toEqual([{ name: 'Real Co', guid: null, booksFrom: '2024-04-01', startingFrom: null, ambiguous: false }])
  })
})

// ---------------------------------------------------------------- import

describe('import through the Import Center pipeline', () => {
  async function exported(l: Linked, type: string) {
    await companies(l)
    const j = await runJob(l, type, 'Shree & Sons Pvt Ltd')
    expect(j.status).toBe('done')
    return j
  }

  test('customers: preview writes nothing; import creates them; a second import creates no duplicates', async () => {
    const l = await linked()
    const j = await exported(l, 'export-customers')
    expect(j.count).toBe(3)
    const p = await importBatch(l.user, { jobId: j.id, dataType: 'customers', mode: 'preview', batch: 0 })
    expect(p.json.data).toMatchObject({ batch: 0, batches: 1, totalRecords: 3 })
    expect(p.json.data.result.counts).toMatchObject({ total: 3, ready: 3 })
    expect(await db.customer.count({ where: { companyId: l.companyId } })).toBe(0)

    expect((await importBatch(l.user, { jobId: j.id, dataType: 'customers', mode: 'commit', batch: 0 })).status).toBe(400) // not confirmed
    const c = await importBatch(l.user, { jobId: j.id, dataType: 'customers', mode: 'commit', batch: 0, confirm: true })
    expect(c.json.data.result.counts.imported).toBe(3)
    const saved = await db.customer.findMany({ where: { companyId: l.companyId }, orderBy: { name: 'asc' } })
    expect(saved.map((s) => s.name)).toEqual(['Debtor 1', 'Debtor 2', 'Debtor 3'])
    expect(saved[0]).toMatchObject({ gstin: '27AAPFU0939F1Z1' })
    expect(JSON.stringify(saved[1])).toContain('Shop 2')

    // Same data again (double click / retry): everything is skipped as already there
    const again = await importBatch(l.user, { jobId: j.id, dataType: 'customers', mode: 'commit', batch: 0, confirm: true })
    expect(again.json.data.result.counts).toMatchObject({ imported: 0, duplicates: 3 })
    expect(await db.customer.count({ where: { companyId: l.companyId } })).toBe(3)
    const history = await db.auditLog.findMany({ where: { companyId: l.companyId, action: 'IMPORT' } })
    expect(history.length).toBe(2)
    expect(history[0].details).toContain('from Tally company "Shree & Sons Pvt Ltd"')
  })

  test('suppliers keep GSTIN and PAN', async () => {
    const l = await linked()
    const j = await exported(l, 'export-suppliers')
    await importBatch(l.user, { jobId: j.id, dataType: 'suppliers', mode: 'commit', batch: 0, confirm: true })
    const s = await db.supplier.findFirst({ where: { companyId: l.companyId } })
    expect(s).toMatchObject({ name: 'Steel Traders', gstin: '24AAACS1234A1Z5' })
  })

  test('stock items: IGST rate and unit used; a missing GST rate is reported, never guessed', async () => {
    const l = await linked()
    const j = await exported(l, 'export-items')
    expect((await importBatch(l.user, { jobId: j.id, dataType: 'items', mode: 'preview', batch: 0 })).status).toBe(400) // item type not chosen
    const r = await importBatch(l.user, { jobId: j.id, dataType: 'items', mode: 'commit', batch: 0, confirm: true, options: { itemType: 'RAW' } })
    expect(r.json.data.result.counts).toMatchObject({ imported: 1, errors: 1 })
    expect(r.json.data.result.rows[0].messages.join()).toMatch(/GST rate is blank/)
    const item = await db.item.findFirst({ where: { companyId: l.companyId } })
    expect(item).toMatchObject({ name: 'MS Bolt M8', gstRate: 18, uom: 'NOS', type: 'RAW' })
    const history = await db.auditLog.findFirst({ where: { companyId: l.companyId, action: 'IMPORT' } })
    expect(history!.details).toContain('GST rate is blank')
  })

  test('large sets are imported in batches of 500', async () => {
    const l = await linked()
    debtorCount = 1201
    const j = await exported(l, 'export-customers')
    expect(j.count).toBe(1201)
    let batches = 1
    let imported = 0
    for (let b = 0; b < batches; b++) {
      const r = await importBatch(l.user, { jobId: j.id, dataType: 'customers', mode: 'commit', batch: b, confirm: true })
      expect(r.status).toBe(200)
      batches = r.json.data.batches
      imported += r.json.data.result.counts.imported
    }
    expect(batches).toBe(3)
    expect(imported).toBe(1201)
    expect(await db.customer.count({ where: { companyId: l.companyId } })).toBe(1201)
    expect((await importBatch(l.user, { jobId: j.id, dataType: 'customers', mode: 'preview', batch: 3 })).status).toBe(400)
  }, 120_000)

  test('mismatched job / data type and unfinished jobs are refused', async () => {
    const l = await linked()
    const j = await exported(l, 'export-suppliers')
    expect((await importBatch(l.user, { jobId: j.id, dataType: 'customers', mode: 'preview', batch: 0 })).status).toBe(400)
    const waiting = await newJob(l.user, 'export-customers', 'Shree & Sons Pvt Ltd')
    expect((await importBatch(l.user, { jobId: waiting.json.data.id, dataType: 'customers', mode: 'preview', batch: 0 })).status).toBe(409)
    expect((await importBatch(l.user, { jobId: j.id, dataType: 'opening-stock', mode: 'preview', batch: 0 })).status).toBe(400)
  })

  test('Tally error for the company → failed job with a plain message, nothing imported', async () => {
    const l = await linked()
    await companies(l)
    mode = 'line-error'
    const j = await runJob(l, 'export-customers', 'Shree & Sons Pvt Ltd')
    expect([j.status, j.message]).toEqual(['failed', expect.stringMatching(/did not find that company/)])
    expect(await db.customer.count({ where: { companyId: l.companyId } })).toBe(0)
  })

  test('every request the mock Tally received was a read-only Export', async () => {
    const l = await linked()
    await exported(l, 'export-customers')
    await runJob(l, 'export-items', 'Shree & Sons Pvt Ltd')
    expect(bodies.length).toBeGreaterThan(3)
    for (const b of bodies) {
      expect(b).toContain('<TALLYREQUEST>Export</TALLYREQUEST>')
      expect(b).not.toMatch(/<TALLYREQUEST>(?!Export)/)
    }
  })
})

// ---------------------------------------------------------------- GSTIN missing: confirmation per record

/** A party ledger as Tally sends it; registration type and GSTIN only when given (all synthetic). */
function ledger(name: string, guid: string, opts: { type?: string; gstin?: string; mobile?: string } = {}) {
  return `<LEDGER NAME="${name}"><GUID>${guid}</GUID>` +
    (opts.type ? `<GSTREGISTRATIONTYPE>${opts.type}</GSTREGISTRATIONTYPE>` : '') +
    (opts.gstin ? `<PARTYGSTIN>${opts.gstin}</PARTYGSTIN>` : '') +
    (opts.mobile ? `<LEDGERMOBILE>${opts.mobile}</LEDGERMOBILE>` : '') + '</LEDGER>'
}

describe('GSTIN missing in Tally: imported only after a yes for that record', () => {
  // Lines are the record's place in the export + 2 (line 1 is the header), which is how the answers are keyed
  const DEBTORS = [
    ledger('No GST Debtor A', 'g-ng-a', { type: 'Regular' }), // line 2: Regular, no GSTIN → needs an answer
    ledger('No GST Debtor B', 'g-ng-b', { type: 'Regular' }), // line 3: Regular, no GSTIN → needs an answer
    ledger('With GST Debtor', 'g-ng-c', { type: 'Regular', gstin: '27AAPFU0939F1Z1' }), // line 4: valid → ready
    ledger('Bad Phone Debtor', 'g-ng-d', { type: 'Regular', mobile: '123' }), // line 5: other error stays an error
    ledger('Unregistered Debtor', 'g-ng-e'), // line 6: no type, no GSTIN → unregistered, imported as before
  ].join('')
  const CREDITORS = [
    ledger('No GST Supplier Y', 'g-ns-y', { type: 'Regular' }), // line 2
    ledger('No GST Supplier N', 'g-ns-n', { type: 'Composition' }), // line 3
    ledger('With GST Supplier', 'g-ns-ok', { type: 'Regular', gstin: '24AAACS1234A1Z5' }), // line 4
  ].join('')

  async function exportedParties(type: 'export-customers' | 'export-suppliers') {
    const l = await linked()
    await companies(l)
    const j = await runJob(l, type, 'Shree & Sons Pvt Ltd')
    expect(j.status).toBe('done')
    return { l, j }
  }
  const commit = (l: Linked, jobId: string, dataType: string, gstinDecisions?: unknown) =>
    importBatch(l.user, { jobId, dataType, mode: 'commit', batch: 0, confirm: true, ...(gstinDecisions !== undefined ? { gstinDecisions } : {}) })
  type Row = { line: number; status: string; messages: string[] }
  const rowOf = (res: { json: { data?: { result?: { rows?: Row[] } } } }, line: number) =>
    res.json.data?.result?.rows?.find((r) => r.line === line)

  test('preview: GSTIN-less Regular parties wait for an answer (not an error); others unchanged; nothing written', async () => {
    customDebtors = DEBTORS
    const { l, j } = await exportedParties('export-customers')
    const p = await importBatch(l.user, { jobId: j.id, dataType: 'customers', mode: 'preview', batch: 0, gstinDecisions: { 2: 'import' } })
    expect(p.status).toBe(200)
    // answers are ignored on preview: both still wait
    expect(p.json.data.result.counts).toMatchObject({ total: 5, ready: 2, confirm: 2, errors: 1, declined: 0 })
    expect(rowOf(p, 2)).toMatchObject({ status: 'confirm' })
    expect(rowOf(p, 2)!.messages.join(' ')).toContain('GSTIN is not available for this party.')
    expect(rowOf(p, 3)).toMatchObject({ status: 'confirm' })
    expect(rowOf(p, 5)).toMatchObject({ status: 'error' }) // the phone rule still applies
    expect(rowOf(p, 5)!.messages.join(' ')).toContain('10-digit')
    expect(JSON.stringify(p.json.data.result.rows)).not.toContain('GSTIN is required')
    expect(await db.customer.count({ where: { companyId: l.companyId } })).toBe(0)
  })

  test('customers: YES imports with GSTIN empty and the GST type kept; NO skips only that record; mixed in one import', async () => {
    customDebtors = DEBTORS
    const { l, j } = await exportedParties('export-customers')
    const c = await commit(l, j.id, 'customers', { 2: 'import', 3: 'skip' })
    expect(c.status).toBe(200)
    expect(c.json.data.result.counts).toMatchObject({ imported: 3, declined: 1, confirm: 0, errors: 1 })
    expect(rowOf(c, 3)).toMatchObject({ status: 'declined' })
    const saved = await db.customer.findMany({ where: { companyId: l.companyId }, orderBy: { name: 'asc' } })
    expect(saved.map((s) => s.name)).toEqual(['No GST Debtor A', 'Unregistered Debtor', 'With GST Debtor'])
    const a = saved.find((s) => s.name === 'No GST Debtor A')!
    expect(a.gstin).toBeNull() // nothing invented
    expect(a.gstType).toBe('REGULAR') // the type from Tally is kept, not changed to Unregistered
    expect(saved.find((s) => s.name === 'With GST Debtor')!.gstin).toBe('27AAPFU0939F1Z1')
    expect(saved.find((s) => s.name === 'Unregistered Debtor')!.gstType).toBe('UNREGISTERED')
    const history = await db.auditLog.findFirst({ where: { companyId: l.companyId, action: 'IMPORT' } })
    expect(history?.details).toContain('1 skipped by the user (no GSTIN)')
  })

  test('suppliers: YES imports without GSTIN, NO skips it; a supplier with a GSTIN imports as before', async () => {
    customCreditors = CREDITORS
    const { l, j } = await exportedParties('export-suppliers')
    const p = await importBatch(l.user, { jobId: j.id, dataType: 'suppliers', mode: 'preview', batch: 0 })
    expect(p.json.data.result.counts).toMatchObject({ ready: 1, confirm: 2 })
    const c = await commit(l, j.id, 'suppliers', { 2: 'import', 3: 'skip' })
    expect(c.json.data.result.counts).toMatchObject({ imported: 2, declined: 1, confirm: 0 })
    const saved = await db.supplier.findMany({ where: { companyId: l.companyId }, orderBy: { name: 'asc' } })
    expect(saved.map((s) => [s.name, s.gstin, s.gstType])).toEqual([
      ['No GST Supplier Y', null, 'REGULAR'],
      ['With GST Supplier', '24AAACS1234A1Z5', 'REGULAR'],
    ])
  })

  test('cancelled import / no answer: a GSTIN-less record is never imported; the rest of the batch is', async () => {
    customDebtors = DEBTORS
    const { l, j } = await exportedParties('export-customers')
    const c = await commit(l, j.id, 'customers') // no answers at all
    expect(c.json.data.result.counts).toMatchObject({ imported: 2, confirm: 2, declined: 0 })
    expect(await db.customer.count({ where: { companyId: l.companyId, name: { startsWith: 'No GST' } } })).toBe(0)
    const history = await db.auditLog.findFirst({ where: { companyId: l.companyId, action: 'IMPORT' } })
    expect(history?.details).toContain('2 not imported (no GSTIN, not confirmed)')
  })

  test('duplicates and repeated clicks: the same record is never imported twice; an existing party is not asked about', async () => {
    customDebtors = DEBTORS
    const { l, j } = await exportedParties('export-customers')
    // an existing customer with the name of record B: reported as already there, no question asked
    await db.customer.create({ data: { companyId: l.companyId, code: 'C-9001', name: 'No GST Debtor B' } })
    const p = await importBatch(l.user, { jobId: j.id, dataType: 'customers', mode: 'preview', batch: 0 })
    expect(rowOf(p, 3)).toMatchObject({ status: 'duplicate' })
    expect(p.json.data.result.counts.confirm).toBe(1)
    // the same commit twice (double click / retry): imported once, then skipped as already imported
    const first = await commit(l, j.id, 'customers', { 2: 'import' })
    expect(first.json.data.result.counts.imported).toBe(3)
    const again = await commit(l, j.id, 'customers', { 2: 'import' })
    expect(again.json.data.result.counts.imported).toBe(0)
    expect(rowOf(again, 2)).toMatchObject({ status: 'duplicate' })
    expect(await db.customer.count({ where: { companyId: l.companyId, name: 'No GST Debtor A' } })).toBe(1)
  })

  test('review table data: a preview lists every record (ready ones too, with their code); a commit reply lists none of the ready / imported ones', async () => {
    customDebtors = DEBTORS
    const { l, j } = await exportedParties('export-customers')
    const p = await importBatch(l.user, { jobId: j.id, dataType: 'customers', mode: 'preview', batch: 0 })
    const statuses = (p.json.data.result.rows as Row[]).map((r) => [r.line, r.status])
    expect(statuses).toEqual([[2, 'confirm'], [3, 'confirm'], [4, 'ready'], [5, 'error'], [6, 'ready']])
    const ready = (p.json.data.result.rows as (Row & { code?: string; values: Record<string, string> })[]).find((r) => r.line === 4)!
    expect(ready.code).toMatch(/^C-\d{4}$/)
    expect(ready.values).toMatchObject({ name: 'With GST Debtor', gstin: '27AAPFU0939F1Z1' })
    expect(await db.customer.count({ where: { companyId: l.companyId } })).toBe(0) // still a preview
    const c = await commit(l, j.id, 'customers', { 2: 'import', 3: 'skip' })
    expect((c.json.data.result.rows as Row[]).map((r) => r.status).sort()).toEqual(['declined', 'error'])
  })

  test('counts add up: every record in exactly one bucket; imported = ready + GSTIN-missing records answered yes', async () => {
    customDebtors = DEBTORS
    const { l, j } = await exportedParties('export-customers')
    const p = (await importBatch(l.user, { jobId: j.id, dataType: 'customers', mode: 'preview', batch: 0 })).json.data.result.counts
    // 5 records: 2 ready, 2 GSTIN missing, 1 invalid, 0 existing — no record in two buckets, none left out
    expect(p).toMatchObject({ total: 5, ready: 2, confirm: 2, errors: 1, duplicates: 0, failed: 0 })
    expect(p.ready + p.confirm + p.errors + p.failed + p.duplicates).toBe(p.total)
    // The final confirmation says "Import ready + yes" (tally-import.tsx: previewReady + gstinYes) — here 2 + 1 = 3
    const yes = 1
    const c = (await commit(l, j.id, 'customers', { 2: 'import', 3: 'skip' })).json.data.result.counts
    expect(c.imported).toBe(p.ready + yes)
    expect(c).toMatchObject({ declined: 1, confirm: 0, errors: 1, duplicates: 0 })
    expect(c.imported + c.declined + c.confirm + c.errors + c.failed + c.duplicates).toBe(c.total)
    expect(await db.customer.count({ where: { companyId: l.companyId } })).toBe(p.ready + yes)
  })

  test('answers are checked: anything but line → import | skip is refused, and nothing is imported', async () => {
    customDebtors = DEBTORS
    const { l, j } = await exportedParties('export-customers')
    for (const bad of [{ 2: 'yes' }, { abc: 'import' }, { 1: 'import' }, ['import'], 'import']) {
      const r = await commit(l, j.id, 'customers', bad)
      expect(r.status).toBe(400)
    }
    expect(await db.customer.count({ where: { companyId: l.companyId } })).toBe(0)
  })

  test('the rule itself is unchanged elsewhere: the party form and file imports still require a GSTIN for Regular', async () => {
    expect(() => partyData({ name: 'X', gstType: 'REGULAR' }, 'create')).toThrow('GSTIN is required for Regular parties')
    expect(() => partyData({ name: 'X', gstType: 'COMPOSITION' }, 'create')).toThrow('GSTIN is required for Composition parties')
    expect(() => partyData({ name: 'X', gstType: 'REGULAR', gstin: 'BADGSTIN' }, 'create', { gstinMayBeMissing: true })).toThrow('GSTIN is not valid')
    const { company } = await seedTenant()
    const r = await importCustomers(company.id, [{ row: 2, data: { name: 'File Party', gstType: 'REGULAR' } }], { canWriteSuppliers: true, dryRun: true })
    expect(r.results[0]).toMatchObject({ status: 'error' })
    expect(r.results[0].message).toContain('GSTIN is required for Regular parties')
  })
})
