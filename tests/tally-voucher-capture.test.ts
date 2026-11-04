import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { db } from '@/lib/db'
import { stageVouchers } from '@/lib/tally/voucher-stage'
import { normaliseVoucher } from '@/lib/tally/vouchers'
import * as connector from '../connector/tally/manuflow-tally-connector.mjs'
import { anonymiseFolder } from '../scripts/tally-fixtures/anonymise.mjs'
import { resetDb } from './helpers/db'
import { seedTenant } from './helpers/seed'

// Phase G preparation: the voucher reader, the capture command's voucher mode and the anonymiser on vouchers.
// Made-up vouchers in Tally's object XML structure (tag names as in a Tally-format voucher file). NOT a real
// TallyPrime reply — that capture needs its own approval (docs/tally-vouchers-design.md).

const sale = (n: number, extra = '') => `<VOUCHER REMOTEID="5f0c1d2e-aaaa-4bbb-8ccc-1234567890ab-0000000${n}" VCHKEY="5f0c1d2e-aaaa-4bbb-8ccc-1234567890ab-0000ab12:0000000${n}" VCHTYPE="Sales" ACTION="Create" OBJVIEW="Invoice Voucher View">
  <DATE>202604${10 + n}</DATE><GUID>5f0c1d2e-aaaa-4bbb-8ccc-1234567890ab-0000000${n}</GUID><MASTERID>${100 + n}</MASTERID><ALTERID>${200 + n}</ALTERID>
  <VOUCHERTYPENAME>Sales</VOUCHERTYPENAME><VOUCHERNUMBER>KEW/26/${n}</VOUCHERNUMBER><REFERENCE>PO-77${n}</REFERENCE>
  <PARTYLEDGERNAME>Kothrud Engineering Works</PARTYLEDGERNAME><PARTYGSTIN>27AAKCK4321K1Z5</PARTYGSTIN><PLACEOFSUPPLY>Maharashtra</PLACEOFSUPPLY>
  <NARRATION>Dispatched via Shivneri Transport</NARRATION><ISCANCELLED>No</ISCANCELLED><ISOPTIONAL>No</ISOPTIONAL><ISINVOICE>Yes</ISINVOICE>
  <LEDGERENTRIES.LIST><LEDGERNAME>Kothrud Engineering Works</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><ISPARTYLEDGER>Yes</ISPARTYLEDGER><AMOUNT>-1180.00</AMOUNT>
    <BILLALLOCATIONS.LIST><NAME>KEW/26/${n}</NAME><BILLTYPE>New Ref</BILLTYPE><BILLCREDITPERIOD>30 Days</BILLCREDITPERIOD><AMOUNT>-1180.00</AMOUNT></BILLALLOCATIONS.LIST>
  </LEDGERENTRIES.LIST>
  <LEDGERENTRIES.LIST><LEDGERNAME>Output IGST</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>180.00</AMOUNT></LEDGERENTRIES.LIST>
  <ALLINVENTORYENTRIES.LIST><STOCKITEMNAME>MS Bolt M8 x 40</STOCKITEMNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><RATE>100.00/Nos</RATE><AMOUNT>1000.00</AMOUNT>
    <ACTUALQTY> 10 Nos</ACTUALQTY><BILLEDQTY> 10 Nos</BILLEDQTY>
    <BATCHALLOCATIONS.LIST><GODOWNNAME>Bhosari Store</GODOWNNAME><BATCHNAME>LOT-26-A</BATCHNAME><AMOUNT>1000.00</AMOUNT><ACTUALQTY> 10 Nos</ACTUALQTY><BILLEDQTY> 10 Nos</BILLEDQTY></BATCHALLOCATIONS.LIST>
    <ACCOUNTINGALLOCATIONS.LIST><LEDGERNAME>Sales GST</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>1000.00</AMOUNT></ACCOUNTINGALLOCATIONS.LIST>
  </ALLINVENTORYENTRIES.LIST>${extra}
</VOUCHER>`
const receipt = `<VOUCHER VCHTYPE="Receipt"><DATE>20260420</DATE><GUID>5f0c1d2e-aaaa-4bbb-8ccc-1234567890ab-00000009</GUID><MASTERID>109</MASTERID>
  <VOUCHERTYPENAME>Receipt</VOUCHERTYPENAME><VOUCHERNUMBER>R-9</VOUCHERNUMBER><PARTYLEDGERNAME>Kothrud Engineering Works</PARTYLEDGERNAME><ISCANCELLED>No</ISCANCELLED><ISOPTIONAL>No</ISOPTIONAL>
  <ALLLEDGERENTRIES.LIST><LEDGERNAME>Kothrud Engineering Works</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>1180.00</AMOUNT>
    <BILLALLOCATIONS.LIST><NAME>KEW/26/1</NAME><BILLTYPE>Agst Ref</BILLTYPE><AMOUNT>1180.00</AMOUNT></BILLALLOCATIONS.LIST></ALLLEDGERENTRIES.LIST>
  <ALLLEDGERENTRIES.LIST><LEDGERNAME>Cash</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-1180.00</AMOUNT></ALLLEDGERENTRIES.LIST>
</VOUCHER>`
const reply = (body: string) => `<ENVELOPE><HEADER><VERSION>1</VERSION><STATUS>1</STATUS></HEADER><BODY><DESC><CMPINFO><VOUCHER>0</VOUCHER></CMPINFO></DESC><DATA><COLLECTION>${body}</COLLECTION></DATA></BODY></ENVELOPE>`
const COMPANIES = reply('<COMPANY NAME="Kothrud Engineering Works Pvt Ltd"><NAME>Kothrud Engineering Works Pvt Ltd</NAME><BOOKSFROM>20260401</BOOKSFROM></COMPANY>')
const VOUCHERS = reply(sale(1) + sale(2) + receipt)

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
      return new Response(id === 'ManuFlowCompanies' ? COMPANIES : id === 'ManuFlowVouchers' ? VOUCHERS : reply(''))
    },
  })
  dir = mkdtempSync(join(tmpdir(), 'mf-voucher-capture-test-'))
})
afterAll(() => { tally.stop(true); rmSync(dir, { recursive: true, force: true }) })
beforeEach(() => { bodies.length = 0 })
let n = 0
const newDir = () => join(dir, `c${++n}`)
const quiet = () => {}
const tallyUrl = () => `http://127.0.0.1:${tally.port}`

describe('voucher reader (Tally object XML; not yet a real Tally reply)', () => {
  test('header, ledger lines, accounting allocations, inventory, batches and bills — text as sent, CMPINFO ignored', () => {
    const list = connector.readVouchers(VOUCHERS)
    // first, on untouched data (asymmetric matchers below can replace the values they check in place)
    for (const v of connector.readVouchers(VOUCHERS)) expect(normaliseVoucher(v).issues).toEqual([]) // balanced, dates and amounts readable
    expect(list.map((v: { voucherType: string; voucherNumber: string }) => [v.voucherType, v.voucherNumber])).toEqual([['Sales', 'KEW/26/1'], ['Sales', 'KEW/26/2'], ['Receipt', 'R-9']])
    const s = list[0]
    expect(s).toMatchObject({ guid: expect.stringMatching(/-00000001$/), masterId: '101', alterId: '201', date: '20260411', partyLedger: 'Kothrud Engineering Works', isInvoice: 'Yes' })
    expect(s.extra).toMatchObject({ PARTYGSTIN: '27AAKCK4321K1Z5', PLACEOFSUPPLY: 'Maharashtra' })
    expect(s.ledgerEntries[0].bills).toEqual([{ name: 'KEW/26/1', billType: 'New Ref', amount: '-1180.00', extra: { BILLCREDITPERIOD: '30 Days' } }])
    expect(s.inventoryEntries[0]).toMatchObject({ stockItemName: 'MS Bolt M8 x 40', actualQty: '10 Nos', rate: '100.00/Nos', batches: [{ godownName: 'Bhosari Store', batchName: 'LOT-26-A' }] })
    // the receipt uses ALLLEDGERENTRIES.LIST, read the same way
    expect(list[2].ledgerEntries.map((e: { ledgerName: string; amount: string }) => [e.ledgerName, e.amount])).toEqual([['Kothrud Engineering Works', '1180.00'], ['Cash', '-1180.00']])
  })

  test('an amount Tally writes with a currency is never guessed at: kept as an issue', () => {
    const v = connector.readVouchers(reply(sale(3).replace('<AMOUNT>180.00</AMOUNT>', '<AMOUNT>USD 2.15 @ ₹ 83.72/USD = ₹ 180.00</AMOUNT>')))[0]
    expect(normaliseVoucher(v).issues.map((i) => i.code)).toContain('bad_amount')
  })
})

describe('capture: voucher mode (prepared; run only with approval)', () => {
  test('company and dates are checked before anything is created or sent', async () => {
    for (const bad of [{ company: 'X', from: '2026-04-01', to: '20260430' }, { company: 'X', from: '20260501', to: '20260430' }, { from: '20260401', to: '20260430' }]) {
      const out = newDir()
      await expect(connector.capture({ tally: tallyUrl(), out, log: quiet, ...bad })).rejects.toThrow()
      expect(existsSync(out)).toBe(false)
    }
    expect(bodies.length).toBe(0)
  })

  test('company list, then one voucher Export for the period; raw reply saved; counts per type in the manifest', async () => {
    const out = newDir()
    const r = await connector.capture({ tally: tallyUrl(), out, company: 'Kothrud Engineering Works Pvt Ltd', from: '20260401', to: '20260430', log: quiet })
    expect(r.summary).toEqual({ vouchers: 3, byType: { Sales: 2, Receipt: 1 } })
    expect(readdirSync(out).sort()).toEqual(['list-companies.xml', 'manifest.json', 'vouchers-20260401-20260430.xml'])
    expect(readFileSync(join(out, 'vouchers-20260401-20260430.xml'), 'utf8')).toBe(VOUCHERS)
    expect(JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')).period).toEqual({ from: '20260401', to: '20260430' })
    expect(bodies.length).toBe(2)
    for (const b of bodies) {
      expect(connector.isExportRequest(b)).toBe(true)
      expect(b.match(/<TALLYREQUEST>[^<]*<\/TALLYREQUEST>/g)).toEqual(['<TALLYREQUEST>Export</TALLYREQUEST>'])
    }
    expect(bodies[1]).toContain('<SVFROMDATE TYPE="Date">20260401</SVFROMDATE><SVTODATE TYPE="Date">20260430</SVTODATE>')
  })
})

describe('anonymiser on vouchers', () => {
  test('names, GUIDs, voucher keys, GSTIN, narration, references replaced; bills still match invoices; amounts kept', async () => {
    const input = newDir()
    await connector.capture({ tally: tallyUrl(), out: input, company: 'Kothrud Engineering Works Pvt Ltd', from: '20260401', to: '20260430', log: quiet })
    const out = newDir()
    anonymiseFolder(input, out, quiet)
    const text = readFileSync(join(out, 'vouchers-20260401-20260430.xml'), 'utf8')
    for (const real of ['Kothrud', 'Shivneri', 'Bhosari', 'MS Bolt', 'KEW/26', 'PO-77', '27AAKCK4321K1Z5', 'LOT-26-A', '5f0c1d2e']) expect([real, text.includes(real)]).toEqual([real, false])
    for (const kept of ['<LEDGERNAME>Output IGST</LEDGERNAME>', '<LEDGERNAME>Sales GST</LEDGERNAME>', '<LEDGERNAME>Cash</LEDGERNAME>', '<AMOUNT>-1180.00</AMOUNT>', '<RATE>100.00/Nos</RATE>', '<DATE>20260411</DATE>', 'VCHTYPE="Sales"', '<PLACEOFSUPPLY>Maharashtra</PLACEOFSUPPLY>']) {
      expect([kept, text.includes(kept)]).toEqual([kept, true])
    }
    const anon = connector.readVouchers(text)
    // the receipt's bill still names the first sale's invoice, and the invoice's own bill
    expect(anon[2].ledgerEntries[0].bills[0].name).toBe(anon[0].voucherNumber)
    expect(anon[0].ledgerEntries[0].bills[0].name).toBe(anon[0].voucherNumber)
    // same accounting content: totals and line counts unchanged
    const real = connector.readVouchers(VOUCHERS)
    expect(anon.map((v: object) => normaliseVoucher(v).header.sumPositivePaise)).toEqual(real.map((v: object) => normaliseVoucher(v).header.sumPositivePaise))
  })
})

describe('captured vouchers stage into Layer 1', () => {
  test('parsed vouchers stage idempotently; a second read changes nothing', async () => {
    await resetDb()
    const { company } = await seedTenant()
    const list = connector.readVouchers(VOUCHERS)
    const scope = { companyId: company.id, tallyCompany: 'Name 0001', jobId: 'cap-1' }
    expect(await stageVouchers(scope, list)).toMatchObject({ created: 3 })
    expect(await stageVouchers({ ...scope, jobId: 'cap-2' }, list)).toMatchObject({ unchanged: 3, created: 0, revised: 0 })
    expect(await db.tallySourceVoucher.count({ where: { companyId: company.id } })).toBe(3)
    expect(await db.tallySourceBillAllocation.count({ where: { companyId: company.id } })).toBe(3)
    expect(await db.tallySourceInventoryLine.count({ where: { companyId: company.id } })).toBe(2)
  })
})

