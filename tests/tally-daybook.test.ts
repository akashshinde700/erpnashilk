import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as connector from '../connector/tally/manuflow-tally-connector.mjs'
import { anonymiseFolder } from '../scripts/tally-fixtures/anonymise.mjs'

// Diagnostic: TallyPrime's own Day Book report (prepared; running it against a real Tally needs its own approval).
// No database is used here: a mock Tally and made-up replies only.

const REVIEWED = '<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE><ID>DayBook</ID></HEADER>' +
  '<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT><SVCURRENTCOMPANY>ABC Private Limited</SVCURRENTCOMPANY>' +
  '<SVFROMDATE TYPE="Date">1-Apr-2026</SVFROMDATE><SVTODATE TYPE="Date">30-Apr-2026</SVTODATE></STATICVARIABLES></DESC></BODY></ENVELOPE>'

const PURCHASE = '<VOUCHER REMOTEID="r-1" VCHTYPE="Purchase" ACTION="Create"><DATE>20260401</DATE><GUID>g-1</GUID><VOUCHERTYPENAME>Purchase</VOUCHERTYPENAME>' +
  '<VOUCHERNUMBER>1</VOUCHERNUMBER><PARTYLEDGERNAME>Supplier One</PARTYLEDGERNAME>' +
  '<ALLLEDGERENTRIES.LIST><LEDGERNAME>Supplier One</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>1000.00</AMOUNT></ALLLEDGERENTRIES.LIST>' +
  '<ALLLEDGERENTRIES.LIST><LEDGERNAME>Purchase</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-1000.00</AMOUNT></ALLLEDGERENTRIES.LIST></VOUCHER>'
const INTERCHANGE = (vouchers: string) => '<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME></REQUESTDESC>' +
  `<REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallyUDF">${vouchers}</TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`
const DATA = (vouchers: string) => `<ENVELOPE><HEADER><VERSION>1</VERSION><STATUS>1</STATUS></HEADER><BODY><DESC><CMPINFO><VOUCHER>0</VOUCHER></CMPINFO></DESC><DATA><TALLYMESSAGE>${vouchers}</TALLYMESSAGE></DATA></BODY></ENVELOPE>`
const DISPLAY = '<ENVELOPE><DSPVCHDATE>1-Apr-26</DSPVCHDATE><DSPVCHLEDACCOUNT>Supplier One</DSPVCHLEDACCOUNT><DSPVCHTYPE>Purc</DSPVCHTYPE><DSPVCHCRAMT>1000.00</DSPVCHCRAMT></ENVELOPE>'
const COMPANIES = '<ENVELOPE><HEADER><VERSION>1</VERSION><STATUS>1</STATUS></HEADER><BODY><DATA><COLLECTION><COMPANY NAME="ABC Private Limited"><NAME>ABC Private Limited</NAME></COMPANY></COLLECTION></DATA></BODY></ENVELOPE>'

describe('Day Book request', () => {
  test('dates in Tally’s documented form', () => {
    expect(['20260401', '20260430', '20261231', '20270101', '20240229'].map(connector.tallyDateText)).toEqual(['1-Apr-2026', '30-Apr-2026', '31-Dec-2026', '1-Jan-2027', '29-Feb-2024'])
  })

  test('exactly the reviewed request: one plain Export, no TDL, filter, ACTION or import tags; passes the unchanged guard', () => {
    const xml = connector.dayBookRequest('ABC Private Limited', '20260401', '20260430')
    expect(xml).toBe(REVIEWED)
    expect(new Bun.CryptoHasher('sha256').update(xml).digest('hex')).toBe('2696e277223165e0c1c3d4f1a61200f418c50eb94f6494212253942457305694')
    expect(connector.isExportRequest(xml)).toBe(true)
    expect(xml.match(/<TALLYREQUEST>[^<]*<\/TALLYREQUEST>/g)).toEqual(['<TALLYREQUEST>Export</TALLYREQUEST>'])
    expect(xml).not.toMatch(/<TDL>|<FILTER>|<SYSTEM|ACTION=|IMPORTDATA|TALLYMESSAGE|\bAlter\b|\bDelete\b|\bCreate\b/i)
  })

  test('company escaped, dates checked: a hostile name or bad dates never change the request', () => {
    const hostile = connector.dayBookRequest('x</SVCURRENTCOMPANY><VOUCHER ACTION="Create">', '20260401', '20260430')
    expect(connector.isExportRequest(hostile)).toBe(true)
    expect(hostile).toContain('<SVCURRENTCOMPANY>x&lt;/SVCURRENTCOMPANY&gt;&lt;VOUCHER ACTION=&quot;Create&quot;&gt;</SVCURRENTCOMPANY>')
    for (const [c, f, t] of [['', '20260401', '20260430'], ['X', '2026-04-01', '20260430'], ['X', '20260501', '20260430'], ['X', '20260401', '30-Apr-2026']]) {
      expect(() => connector.dayBookRequest(c, f, t)).toThrow()
    }
  })

  test('not a job: ManuFlow cannot ask the connector for it', () => {
    expect(Object.keys(connector.JOBS).filter((k) => /day|voucher/i.test(k))).toEqual([])
  })
})

describe('Day Book reply layouts', () => {
  test('data-interchange layout (BODY/IMPORTDATA/REQUESTDATA/TALLYMESSAGE/VOUCHER)', () => {
    const r = connector.readDayBook(INTERCHANGE(PURCHASE))
    expect(r.layout).toBe('interchange')
    expect(r.vouchers.map((v: { voucherType: string; voucherNumber: string; date: string }) => [v.voucherType, v.voucherNumber, v.date])).toEqual([['Purchase', '1', '20260401']])
    expect(r.vouchers[0].ledgerEntries.map((e: { ledgerName: string; amount: string }) => [e.ledgerName, e.amount])).toEqual([['Supplier One', '1000.00'], ['Purchase', '-1000.00']])
  })

  test('data layout (BODY/DATA/TALLYMESSAGE/VOUCHER); the CMPINFO count is not a voucher', () => {
    const r = connector.readDayBook(DATA(PURCHASE + PURCHASE.replace('<VOUCHERNUMBER>1<', '<VOUCHERNUMBER>2<')))
    expect([r.layout, r.vouchers.length]).toEqual(['data', 2])
  })

  test('an empty Day Book is read as such; a display layout or anything else is reported as unknown, never guessed', () => {
    expect(connector.readDayBook(INTERCHANGE(''))).toEqual({ layout: 'interchange', vouchers: [] })
    expect(connector.readDayBook(DISPLAY)).toEqual({ layout: 'unknown', vouchers: [] })
    expect(connector.readDayBook('<ENVELOPE><HEADER><STATUS>1</STATUS></HEADER><BODY><DATA><COLLECTION/></DATA></BODY></ENVELOPE>')).toEqual({ layout: 'unknown', vouchers: [] })
    expect(() => connector.readDayBook('<html>router</html>')).toThrow()
    expect(() => connector.readDayBook('<ENVELOPE><BODY>')).toThrow()
  })
})

// ---------------------------------------------------------------- capture --daybook (mock Tally)

const bodies: string[] = []
let tally: ReturnType<typeof Bun.serve>
let dir = ''
beforeAll(() => {
  tally = Bun.serve({
    port: 0, hostname: '127.0.0.1',
    async fetch(req) {
      const body = await req.text()
      bodies.push(body)
      const id = /<ID>([^<]*)<\/ID>/.exec(body)?.[1]
      return new Response(id === 'ManuFlowCompanies' ? COMPANIES : id === 'DayBook' ? INTERCHANGE(PURCHASE) : DATA(''))
    },
  })
  dir = mkdtempSync(join(tmpdir(), 'mf-daybook-test-'))
})
afterAll(() => { tally.stop(true); rmSync(dir, { recursive: true, force: true }) })
beforeEach(() => { bodies.length = 0 })
let n = 0
const newDir = () => join(dir, `c${++n}`)
const quiet = () => {}
const tallyUrl = () => `http://127.0.0.1:${tally.port}`

describe('capture --daybook', () => {
  test('company list, then exactly the reviewed Day Book request; raw reply saved; layout and counts in the manifest', async () => {
    const out = newDir()
    const r = await connector.capture({ tally: tallyUrl(), out, company: 'ABC Private Limited', from: '20260401', to: '20260430', dayBook: true, log: quiet })
    expect(r.summary).toEqual({ vouchers: 1, byType: { Purchase: 1 } })
    expect(bodies.length).toBe(2)
    expect(bodies[1]).toBe(REVIEWED)
    for (const b of bodies) expect(connector.isExportRequest(b)).toBe(true)
    expect(readdirSync(out).sort()).toEqual(['daybook-20260401-20260430.xml', 'list-companies.xml', 'manifest.json'])
    expect(readFileSync(join(out, 'daybook-20260401-20260430.xml'), 'utf8')).toBe(INTERCHANGE(PURCHASE))
    const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'))
    expect([manifest.request, manifest.layout, manifest.period]).toEqual(['daybook', 'interchange', { from: '20260401', to: '20260430' }])
  })

  test('refused before anything is created or sent: no dates, bad dates, no company', async () => {
    for (const bad of [{ company: 'ABC Private Limited' }, { company: 'ABC Private Limited', from: '2026-04-01', to: '20260430' }, { from: '20260401', to: '20260430' }]) {
      const out = newDir()
      await expect(connector.capture({ tally: tallyUrl(), out, dayBook: true, log: quiet, ...bad })).rejects.toThrow()
      expect(existsSync(out)).toBe(false)
    }
    const logs: string[] = []
    expect(await connector.main(['capture', '--tally', tallyUrl(), '--out', newDir(), '--daybook'], (m: string) => logs.push(m))).toBe(1)
    expect(logs.join('\n')).toMatch(/--daybook needs --vouchers-from and --vouchers-to/)
    expect(bodies.length).toBe(0)
  })

  test('without --daybook the voucher capture still sends the unchanged collection request', async () => {
    await connector.capture({ tally: tallyUrl(), out: newDir(), company: 'ABC Private Limited', from: '20260401', to: '20260430', log: quiet })
    expect(bodies[1]).toBe(connector.voucherRequest('ABC Private Limited', '20260401', '20260430'))
    expect(bodies[1]).toContain('<ID>ManuFlowVouchers</ID>')
  })
})

// ---------------------------------------------------------------- fixes from the real Day Book capture (2026-11-03)

/** A Day Book reply in the structure real TallyPrime sent (made-up values). */
const REAL_SHAPE = (extraTag = '') => '<ENVELOPE><HEADER><VERSION>1</VERSION><STATUS>1</STATUS></HEADER><BODY><DESC><STATICVARIABLES><SVCURRENTCOMPANY>Kothrud Works Pvt Ltd</SVCURRENTCOMPANY></STATICVARIABLES></DESC><DATA>' +
  '<TALLYMESSAGE><VOUCHER REMOTEID="7d1e2f3a-1111-4222-8333-444455556666-00000001" VCHKEY="7d1e2f3a-1111-4222-8333-444455556666-0000b2c3:00000008" VCHTYPE="Purchase" ACTION="Create">' +
  '<DATE>20260401</DATE><GUID>7d1e2f3a-1111-4222-8333-444455556666-00000001</GUID><MASTERID>1</MASTERID><ALTERID>1</ALTERID><VOUCHERTYPENAME>Purchase</VOUCHERTYPENAME>' +
  '<VOUCHERNUMBER>1</VOUCHERNUMBER><REFERENCE>BHO-117</REFERENCE><PARTYLEDGERNAME>Bhosari Castings</PARTYLEDGERNAME><BASICBASEPARTYNAME>Bhosari Castings</BASICBASEPARTYNAME>' +
  '<BASICBUYERNAME>Kothrud Works Pvt Ltd</BASICBUYERNAME><BASICBUYERADDRESS.LIST TYPE="String"><BASICBUYERADDRESS>Kothrud, Pune</BASICBUYERADDRESS></BASICBUYERADDRESS.LIST>' +
  '<CONSIGNEEMAILINGNAME>Kothrud Works Pvt Ltd</CONSIGNEEMAILINGNAME><CONSIGNEEPINCODE>411038</CONSIGNEEPINCODE><CONSIGNEESTATENAME>Maharashtra</CONSIGNEESTATENAME>' +
  '<GSTREGISTRATION TAXTYPE="GST" TAXREGISTRATION="27AAKCK4321K1Z5">Maharashtra Registration</GSTREGISTRATION><VCHSTATUSTAXUNIT>Kothrud Works Registration</VCHSTATUSTAXUNIT>' +
  '<REMOTECMPSTATE>Maharashtra</REMOTECMPSTATE>' + extraTag +
  '<ALLLEDGERENTRIES.LIST>      </ALLLEDGERENTRIES.LIST>' + // an empty ALL… list next to the real one
  '<LEDGERENTRIES.LIST><LEDGERNAME>Bhosari Castings</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><ISPARTYLEDGER>Yes</ISPARTYLEDGER><AMOUNT>1000.00</AMOUNT>' +
  '<BILLALLOCATIONS.LIST><NAME>BHO-117</NAME><BILLTYPE>New Ref</BILLTYPE><AMOUNT>1000.00</AMOUNT></BILLALLOCATIONS.LIST></LEDGERENTRIES.LIST>' +
  '<LEDGERENTRIES.LIST>       </LEDGERENTRIES.LIST>' + // an empty entry
  '<ALLINVENTORYENTRIES.LIST><STOCKITEMNAME>Grey Iron Housing</STOCKITEMNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><RATE>100.00/Nos</RATE><AMOUNT>-1000.00</AMOUNT><ACTUALQTY> 10 Nos</ACTUALQTY><BILLEDQTY> 10 Nos</BILLEDQTY>' +
  '<BATCHALLOCATIONS.LIST><GODOWNNAME>Main Location</GODOWNNAME><BATCHNAME>Primary Batch</BATCHNAME><AMOUNT>-1000.00</AMOUNT><ACTUALQTY> 10 Nos</ACTUALQTY></BATCHALLOCATIONS.LIST>' +
  '<ACCOUNTINGALLOCATIONS.LIST><LEDGERNAME>Purchase Account</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-1000.00</AMOUNT>' +
  '<BILLALLOCATIONS.LIST>       </BILLALLOCATIONS.LIST></ACCOUNTINGALLOCATIONS.LIST></ALLINVENTORYENTRIES.LIST>' +
  '</VOUCHER></TALLYMESSAGE><TALLYMESSAGE><COMPANY><REMOTECMPINFO.LIST MERGE="Yes"><NAME>7d1e2f3a-1111-4222-8333-444455556666</NAME>' +
  '<REMOTECMPNAME>Kothrud Works Pvt Ltd</REMOTECMPNAME><REMOTECMPSTATE>Maharashtra</REMOTECMPSTATE></REMOTECMPINFO.LIST></COMPANY></TALLYMESSAGE></DATA></BODY></ENVELOPE>'

describe('reader fixes', () => {
  test('an empty ALLLEDGERENTRIES.LIST does not hide the filled LEDGERENTRIES.LIST; empty entries and empty bills are skipped', () => {
    const [v] = connector.readDayBook(REAL_SHAPE()).vouchers
    expect(v.ledgerEntries.map((e: { ledgerName: string; amount: string }) => [e.ledgerName, e.amount])).toEqual([['Bhosari Castings', '1000.00']])
    expect(v.ledgerEntries[0].bills.map((b: { name: string }) => b.name)).toEqual(['BHO-117'])
    expect(v.inventoryEntries[0].accountingAllocations[0].bills).toEqual([]) // the empty placeholder is not a bill
  })

  test('when both lists have entries, ALLLEDGERENTRIES.LIST is used, as before', () => {
    const both = REAL_SHAPE().replace('<ALLLEDGERENTRIES.LIST>      </ALLLEDGERENTRIES.LIST>', '<ALLLEDGERENTRIES.LIST><LEDGERNAME>From ALL</LEDGERNAME><AMOUNT>1000.00</AMOUNT></ALLLEDGERENTRIES.LIST>')
    expect(connector.readDayBook(both).vouchers[0].ledgerEntries.map((e: { ledgerName: string }) => e.ledgerName)).toEqual(['From ALL'])
  })
})

describe('anonymiser on a real-shaped Day Book reply', () => {
  const run = (xml: string) => {
    const input = join(dir, `anon-in-${++n}`)
    mkdirSync(input, { mode: 0o700 })
    writeFileSync(join(input, 'list-companies.xml'), COMPANIES.replaceAll('ABC Private Limited', 'Kothrud Works Pvt Ltd'))
    writeFileSync(join(input, 'daybook-20260401-20260430.xml'), xml)
    const out = join(dir, `anon-out-${n}`)
    return { out, result: () => anonymiseFolder(input, out, quiet) }
  }

  test('company, party, address and a business tax-unit name replaced; state tax unit, states, amounts, signs and structure kept', () => {
    const { out, result } = run(REAL_SHAPE())
    result()
    const text = readFileSync(join(out, 'daybook-20260401-20260430.xml'), 'utf8')
    for (const real of ['Kothrud', 'Bhosari', 'Pune', 'Grey Iron', 'BHO-117', '27AAKCK4321K1Z5', '7d1e2f3a', '411038']) expect([real, text.includes(real)]).toEqual([real, false])
    for (const kept of ['<GSTREGISTRATION TAXTYPE="GST" TAXREGISTRATION="', '>Maharashtra Registration</GSTREGISTRATION>', '<REMOTECMPSTATE>Maharashtra</REMOTECMPSTATE>',
      '<CONSIGNEESTATENAME>Maharashtra</CONSIGNEESTATENAME>', '<CONSIGNEEPINCODE>41', '<AMOUNT>1000.00</AMOUNT>', '<AMOUNT>-1000.00</AMOUNT>', '<ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>',
      '<RATE>100.00/Nos</RATE>', '<ACTUALQTY> 10 Nos</ACTUALQTY>', '<DATE>20260401</DATE>', '<LEDGERNAME>Purchase Account</LEDGERNAME>', '<GODOWNNAME>Main Location</GODOWNNAME>']) {
      expect([kept, text.includes(kept)]).toEqual([kept, true])
    }
    expect(text).toMatch(/<VCHSTATUSTAXUNIT>Tax Unit \d{4}<\/VCHSTATUSTAXUNIT>/)
    // the same company / party gets the same fake everywhere (and in the company list)
    const fake = (tag: string) => new RegExp(`<${tag}>([^<]+)</${tag}>`).exec(text)![1]
    expect(new Set([fake('SVCURRENTCOMPANY'), fake('REMOTECMPNAME'), fake('BASICBUYERNAME'), fake('CONSIGNEEMAILINGNAME')]).size).toBe(1)
    expect(readFileSync(join(out, 'list-companies.xml'), 'utf8')).toContain(`<NAME>${fake('SVCURRENTCOMPANY')}</NAME>`)
    expect(fake('BASICBASEPARTYNAME')).toBe(fake('PARTYLEDGERNAME'))
    // the reader gets the same accounting content from the anonymised reply
    const [a] = connector.readDayBook(text).vouchers
    const [o] = connector.readDayBook(REAL_SHAPE()).vouchers
    expect(a.ledgerEntries.map((e: { amount: string; isDeemedPositive: string }) => [e.amount, e.isDeemedPositive])).toEqual(o.ledgerEntries.map((e: { amount: string; isDeemedPositive: string }) => [e.amount, e.isDeemedPositive]))
    expect(a.ledgerEntries[0].bills[0].name).toBe(a.reference) // bill still matches the reference
  })

  test('a name in a tag the anonymiser does not know is still caught: nothing is written', () => {
    const { out, result } = run(REAL_SHAPE('<BASICSHIPPINGNOTE>For Bhosari Castings</BASICSHIPPINGNOTE>'))
    expect(result).toThrow(/Not anonymised safely/)
    expect(existsSync(out)).toBe(false)
  })
})
