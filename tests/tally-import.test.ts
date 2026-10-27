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
import { JOB_RUN_LIMIT_MS, connectorStore, resetConnectorStore } from '@/lib/tally/connector'
import * as connector from '../connector/tally/manuflow-tally-connector.mjs'
import { apiRequest, call, type TestUser } from './helpers/api'
import { resetDb } from './helpers/db'
import { seedTenant, seedUser } from './helpers/seed'

// ---------------------------------------------------------------- mock TallyPrime (no real TallyPrime here)

type TallyMode = 'ok' | 'no-companies' | 'line-error' | 'utf16' | 'html' | 'slow'
let mode: TallyMode = 'ok'
let debtorCount = 3
const bodies: string[] = []

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
      return wrap(Array.from({ length: debtorCount }, (_, i) => partyXml(i + 1)).join(''))
    case 'ManuFlowCreditors':
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
  resetConnectorStore()
  process.env.TALLY_CONNECTOR_POC = '1'
  mode = 'ok'
  debtorCount = 3
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

/** One connector cycle: Tally check + heartbeat + the job it was handed, if any. (Heartbeat limiter cleared.) */
async function beat(path: string) {
  resetConnectorStore(connectorStore())
  return connector.heartbeatOnce(connector.loadConfig(path), path)
}

/** A bare heartbeat as the connector would send it, without running the job it gets. (Heartbeat limiter cleared.) */
function rawBeat(token: string) {
  resetConnectorStore(connectorStore())
  return call(heartbeatRoute(apiRequest('/api/tally-connector/heartbeat', { body: { tally: { status: 'connected' } }, headers: { authorization: `Bearer ${token}` } })))
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
      expect(xml).not.toMatch(/Import|ACTION=|<IMPORTDATA|Alter|Delete/i)
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
      { name: 'Shree & Sons Pvt Ltd', booksFrom: '2024-04-01', startingFrom: '2026-04-01' },
      { name: 'Trial Co', booksFrom: null, startingFrom: '2025-04-01' },
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

  test('a job the connector never answers fails after the time limit', async () => {
    const l = await linked()
    const j = await newJob(l.user, 'list-companies')
    const token = connector.loadConfig(l.path).token
    await rawBeat(token)
    const realNow = Date.now
    Date.now = () => realNow() + JOB_RUN_LIMIT_MS + 1000
    try {
      await rawBeat(token)
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
    expect((await jobStatus(l.user, k.json.data.id)).json.data.companies).toEqual([{ name: 'Real Co', booksFrom: '2024-04-01', startingFrom: null }])
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
