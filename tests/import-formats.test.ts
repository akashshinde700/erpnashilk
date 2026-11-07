import { beforeEach, describe, expect, test } from 'bun:test'
import { gzipSync } from 'node:zlib'
import { POST as commit } from '@/app/api/import-center/commit/route'
import { POST as parse } from '@/app/api/import-center/parse/route'
import { POST as preview } from '@/app/api/import-center/preview/route'
import { MAX_LARGE_UPLOADS, largeUploadsInFlight, takeLargeUploadSlot } from '@/app/api/import-center/_shared'
import { applyMapping, IMPORT_CHECK_HEADER } from '@/lib/import/apply-mapping'
import { db } from '@/lib/db'
import { IMPORT_LIMITS, findDataType } from '@/lib/import/fields'
import { parseImportFile } from '@/lib/import/parse-file'
import type { RunResult } from '@/lib/import/run'
import { jsonDepth } from '@/lib/import/structured'
import { TALLY_TABLE } from '@/lib/import/tally-xml'
import { addFileDuplicates, fileProblemFor, markFileDuplicates, mergeRunResults, splitParts, withoutLines } from '@/lib/import/wizard-helpers'
import { XML_LIMITS, parseXml } from '@/lib/import/xml'
import { apiRequest, call, uploadRequest, type TestUser } from './helpers/api'
import { resetDb } from './helpers/db'
import { seedTenant } from './helpers/seed'

// Universal file import: XML (generic and Tally), JSON, TXT, PDF refusal, encodings, limits, and the Import Center
// pipeline (parse → preview → confirm → commit) for the new formats. All data here is made up.

const MARATHI = 'श्री गणेश ट्रेडर्स'
const MARATHI_CITY = 'पुणे'
const GSTIN = '27ABCDE1234F1Z5' // a well-formed GSTIN used in the other import tests

const parseOf = (text: string | Buffer, name: string, sheet?: string | null, preferredSheet?: string) =>
  parseImportFile(typeof text === 'string' ? Buffer.from(text) : text, name, sheet ?? null, { preferredSheet })
const header = (p: ReturnType<typeof parseOf>) => p.rows[0].cells
const col = (p: ReturnType<typeof parseOf>, name: string) => p.rows.slice(1).map((r) => r.cells[header(p).indexOf(name)])

// ---------------------------------------------------------------- synthetic Tally files (same layout as a real export)

const env = (company: string, messages: string) =>
  '<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>All Masters</REPORTNAME>' +
  `<STATICVARIABLES><SVCURRENTCOMPANY>${company}</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC><REQUESTDATA>${messages}</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`
const msg = (inner: string) => `<TALLYMESSAGE xmlns:UDF="TallyUDF">${inner}</TALLYMESSAGE>`

const TALLY_MASTERS = env('Demo Trading Co', [
  msg('<GROUP NAME="Pune Debtors" RESERVEDNAME=""><GUID>g-grp-1</GUID><PARENT>&#4; Sundry Debtors</PARENT></GROUP>'),
  msg('<LEDGER NAME="Shree Ganesh Traders" RESERVEDNAME=""><GUID>g-led-1</GUID><PARENT>Pune Debtors</PARENT>' +
    `<PARTYGSTIN>${GSTIN}</PARTYGSTIN><GSTREGISTRATIONTYPE>Regular</GSTREGISTRATIONTYPE><LEDSTATENAME>Maharashtra</LEDSTATENAME>` +
    '<ADDRESS.LIST TYPE="String"><ADDRESS>Plot 4, MIDC</ADDRESS><ADDRESS>Bhosari</ADDRESS></ADDRESS.LIST><LEDGERMOBILE>9876543210</LEDGERMOBILE>' +
    '<OPENINGBALANCE>-1500.50</OPENINGBALANCE></LEDGER>'),
  msg(`<LEDGER NAME="${MARATHI}" RESERVEDNAME=""><GUID>g-led-2</GUID><PARENT>&#4; Sundry Debtors</PARENT>` +
    '<LEDGSTREGDETAILS.LIST><APPLICABLEFROM>20170701</APPLICABLEFROM><GSTREGISTRATIONTYPE>Regular</GSTREGISTRATIONTYPE><GSTIN>27OLDOLD0000A1Z5</GSTIN></LEDGSTREGDETAILS.LIST>' +
    '<LEDGSTREGDETAILS.LIST><APPLICABLEFROM>20230401</APPLICABLEFROM><GSTREGISTRATIONTYPE>Unregistered/Consumer</GSTREGISTRATIONTYPE><GSTIN></GSTIN></LEDGSTREGDETAILS.LIST>' +
    `<LEDMAILINGDETAILS.LIST><APPLICABLEFROM>20230401</APPLICABLEFROM><ADDRESS.LIST><ADDRESS>${MARATHI_CITY}</ADDRESS></ADDRESS.LIST><STATE>Maharashtra</STATE><PINCODE>411001</PINCODE></LEDMAILINGDETAILS.LIST></LEDGER>`),
  msg('<LEDGER NAME="Steel Suppliers" RESERVEDNAME=""><GUID>g-led-3</GUID><PARENT>&#4; Sundry Creditors</PARENT><OPENINGBALANCE>2500</OPENINGBALANCE></LEDGER>'),
  msg('<LEDGER NAME="Cash" RESERVEDNAME=""><PARENT>&#4; Cash-in-Hand</PARENT></LEDGER>'),
  msg('<STOCKITEM NAME="MS Bolt M8" RESERVEDNAME=""><GUID>g-item-1</GUID><PARENT>&#4; Primary</PARENT><BASEUNITS>Nos</BASEUNITS><ISBATCHWISEON>No</ISBATCHWISEON>' +
    '<GSTDETAILS.LIST><APPLICABLEFROM>20170701</APPLICABLEFROM><HSNCODE>7317</HSNCODE><STATEWISEDETAILS.LIST><STATENAME>&#4; Any</STATENAME>' +
    '<RATEDETAILS.LIST><GSTRATEDUTYHEAD>IGST</GSTRATEDUTYHEAD><GSTRATE> 12</GSTRATE></RATEDETAILS.LIST></STATEWISEDETAILS.LIST></GSTDETAILS.LIST>' +
    '<GSTDETAILS.LIST><APPLICABLEFROM>20220101</APPLICABLEFROM><HSNCODE>7318</HSNCODE><STATEWISEDETAILS.LIST><STATENAME>&#4; Any</STATENAME>' +
    '<RATEDETAILS.LIST><GSTRATEDUTYHEAD>CGST</GSTRATEDUTYHEAD><GSTRATE> 9</GSTRATE></RATEDETAILS.LIST>' +
    '<RATEDETAILS.LIST><GSTRATEDUTYHEAD>IGST</GSTRATEDUTYHEAD><GSTRATE> 18</GSTRATE></RATEDETAILS.LIST></STATEWISEDETAILS.LIST></GSTDETAILS.LIST>' +
    '<OPENINGBALANCE> 100 Nos</OPENINGBALANCE><OPENINGRATE>10.00/Nos</OPENINGRATE><OPENINGVALUE>-1000.00</OPENINGVALUE>' +
    '<BATCHALLOCATIONS.LIST><GODOWNNAME>Main Location</GODOWNNAME><BATCHNAME>Primary Batch</BATCHNAME><OPENINGBALANCE> 100 Nos</OPENINGBALANCE><OPENINGVALUE>-1000.00</OPENINGVALUE></BATCHALLOCATIONS.LIST></STOCKITEM>'),
  msg('<STOCKITEM NAME="Cutting Oil" RESERVEDNAME=""><GUID>g-item-2</GUID><PARENT>Consumables</PARENT><BASEUNITS>Ltr</BASEUNITS><OPENINGBALANCE> 0 Ltr</OPENINGBALANCE></STOCKITEM>'),
].join(''))

const voucher = (attrs: string, inner: string) => msg(`<VOUCHER ${attrs}>${inner}</VOUCHER>`)
const TALLY_VOUCHERS = env('Demo Trading Co', [
  voucher('REMOTEID="r1" VCHTYPE="Sales" ACTION="Create"', '<DATE>20260405</DATE><GUID>v-1</GUID><VOUCHERTYPENAME>Sales</VOUCHERTYPENAME><VOUCHERNUMBER>S-1</VOUCHERNUMBER>' +
    '<PARTYLEDGERNAME>Shree Ganesh Traders</PARTYLEDGERNAME><ISINVOICE>Yes</ISINVOICE>' +
    '<LEDGERENTRIES.LIST><LEDGERNAME>Shree Ganesh Traders</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><ISPARTYLEDGER>Yes</ISPARTYLEDGER><AMOUNT>-1180.00</AMOUNT>' +
    '<BILLALLOCATIONS.LIST><NAME>S-1</NAME><BILLTYPE>New Ref</BILLTYPE><AMOUNT>-1180.00</AMOUNT></BILLALLOCATIONS.LIST></LEDGERENTRIES.LIST>' +
    '<LEDGERENTRIES.LIST><LEDGERNAME>Output IGST</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>180.00</AMOUNT><BILLALLOCATIONS.LIST></BILLALLOCATIONS.LIST></LEDGERENTRIES.LIST>' +
    '<ALLINVENTORYENTRIES.LIST><STOCKITEMNAME>MS Bolt M8</STOCKITEMNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><RATE>100.00/Nos</RATE><AMOUNT>1000.00</AMOUNT>' +
    '<ACTUALQTY> 10 Nos</ACTUALQTY><BILLEDQTY> 10 Nos</BILLEDQTY><BATCHALLOCATIONS.LIST><GODOWNNAME>Main Location</GODOWNNAME><BATCHNAME>Primary Batch</BATCHNAME>' +
    '<AMOUNT>1000.00</AMOUNT><ACTUALQTY> 10 Nos</ACTUALQTY></BATCHALLOCATIONS.LIST><ACCOUNTINGALLOCATIONS.LIST><LEDGERNAME>Sales Account</LEDGERNAME>' +
    '<ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>1000.00</AMOUNT></ACCOUNTINGALLOCATIONS.LIST></ALLINVENTORYENTRIES.LIST>'),
  voucher('VCHTYPE="Purchase" ACTION="Create"', '<DATE>20260410</DATE><VOUCHERTYPENAME>Purchase</VOUCHERTYPENAME><VOUCHERNUMBER>P-1</VOUCHERNUMBER><PARTYLEDGERNAME>Steel Suppliers</PARTYLEDGERNAME>' +
    '<LEDGERENTRIES.LIST><LEDGERNAME>Steel Suppliers</LEDGERNAME><AMOUNT>1000.10</AMOUNT></LEDGERENTRIES.LIST>' +
    '<LEDGERENTRIES.LIST><LEDGERNAME>Purchase Account</LEDGERNAME><AMOUNT>-1000.00</AMOUNT></LEDGERENTRIES.LIST>'),
  voucher('VCHTYPE="Sales" ACTION="Cancel"', '<DATE>20260411</DATE><VOUCHERTYPENAME>Sales</VOUCHERTYPENAME><VOUCHERNUMBER>S-2</VOUCHERNUMBER>'),
  voucher('VCHTYPE="Journal"', '<DATE>20260301</DATE><VOUCHERTYPENAME>Journal</VOUCHERTYPENAME><VOUCHERNUMBER>J-1</VOUCHERNUMBER>' +
    '<ALLLEDGERENTRIES.LIST><LEDGERNAME>Rent</LEDGERNAME><AMOUNT>-500.00</AMOUNT></ALLLEDGERENTRIES.LIST>' +
    '<ALLLEDGERENTRIES.LIST><LEDGERNAME>Cash</LEDGERNAME><AMOUNT>500.00</AMOUNT></ALLLEDGERENTRIES.LIST>'),
].join(''))

// ---------------------------------------------------------------- XML reader safety

describe('XML reader: safety', () => {
  test('external entities (XXE) and entity expansion are refused before anything is resolved', () => {
    const xxe = '<?xml version="1.0"?><!DOCTYPE r [<!ENTITY x SYSTEM "file:///etc/passwd">]><r><a>&x;</a></r>'
    expect(() => parseOf(xxe, 'x.xml')).toThrow('DOCTYPE')
    const laughs = '<!DOCTYPE l [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">]><l>&b;</l>'
    expect(() => parseOf(laughs, 'x.xml')).toThrow('DOCTYPE')
    expect(() => parseXml('<r>&custom;</r>')).toThrow('entities other than the standard five')
    expect(parseXml('<r a="1 &amp; 2 &gt; 1">&lt;b&gt;&#2346;&#x941;</r>').text).toBe('<b>पु')
  })

  test('malformed, too deep, too many elements, text outside the root', () => {
    expect(() => parseXml('<a><b></a></b>')).toThrow('not well formed')
    expect(() => parseXml('<a><b>')).toThrow('never closed')
    expect(() => parseXml('<a/><b/>')).toThrow('more than one root')
    expect(() => parseXml('hello <a/>')).toThrow('outside its root')
    expect(() => parseXml(`${'<x>'.repeat(XML_LIMITS.maxDepth + 2)}${'</x>'.repeat(XML_LIMITS.maxDepth + 2)}`)).toThrow('nested more than')
    expect(() => parseXml(`<r>${'<i/>'.repeat(20)}</r>`, { ...XML_LIMITS, maxElements: 10 })).toThrow('more than 10 elements')
    expect(parseXml('<r note="a > b"/>').attrs.note).toBe('a > b') // '>' inside a quoted attribute is allowed
  })
})

// ---------------------------------------------------------------- generic XML

describe('generic XML → table', () => {
  const XML = `<?xml version="1.0" encoding="UTF-8"?><export><customers>
    <customer code="C1"><name>Acme</name><mobile>9876543210</mobile><mobile>9822000000</mobile><city>Pune</city><address><line1>Plot 1</line1><pin>411001</pin></address>
      <orders><order><no>1</no></order><order><no>2</no></order></orders></customer>
    <customer code="C2"><name>${MARATHI}</name><city>${MARATHI_CITY}</city><notes><![CDATA[a < b & c]]></notes></customer>
  </customers><items><item><name>Bolt</name></item><item><name>Nut</name></item><item><name>Washer</name></item></items></export>`

  test('records found per kind; attributes, nested fields and repeated values; nested lists left out with a note', () => {
    const p = parseOf(XML, 'export.xml')
    expect(p.format).toBe('xml')
    expect(p.sheetNames).toEqual(['customer (2)', 'item (3)'])
    expect(header(p)).toEqual(['code', 'name', 'mobile', 'city', 'address.line1', 'address.pin', 'notes'])
    expect(p.rows[1].cells).toEqual(['C1', 'Acme', '9876543210; 9822000000', 'Pune', 'Plot 1', '411001', ''])
    expect(p.rows[2].cells).toEqual(['C2', MARATHI, '', MARATHI_CITY, '', '', 'a < b & c'])
    expect(p.notes.join(' ')).toContain('orders')
    const items = parseOf(XML, 'export.xml', 'item (3)')
    expect(col(items, 'name')).toEqual(['Bolt', 'Nut', 'Washer'])
    expect(() => parseOf(XML, 'export.xml', 'nothing (1)')).toThrow('not found')
  })

  test('UTF-16 (both byte orders) and a single record', () => {
    const text = `<customer><name>${MARATHI}</name><city>Nashik</city></customer>`
    const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])
    const be = Buffer.from(Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, 'utf16le').swap16()]))
    for (const b of [le, be]) {
      const p = parseOf(b, 'one.xml')
      expect(p.rows).toEqual([{ line: 1, cells: ['name', 'city'] }, { line: 2, cells: [MARATHI, 'Nashik'] }])
    }
  })
})

// ---------------------------------------------------------------- Tally XML

describe('Tally XML masters', () => {
  test('parties by group (sub-groups followed), latest GST details, opening balance Dr / Cr; built-in names cleaned', () => {
    const p = parseOf(TALLY_MASTERS, 'master.xml', null, TALLY_TABLE.debtors)
    expect(p.format).toBe('tally-xml')
    expect(p.tally).toEqual({ layout: 'import', company: 'Demo Trading Co', objectCounts: { GROUP: 1, LEDGER: 4, STOCKITEM: 2 } })
    expect(p.sheetNames).toEqual([`${TALLY_TABLE.debtors} (2)`, `${TALLY_TABLE.creditors} (1)`, `${TALLY_TABLE.items} (2)`, `${TALLY_TABLE.openingStock} (1)`])
    expect(col(p, 'Party Name')).toEqual(['Shree Ganesh Traders', MARATHI]) // Cash is not a party
    expect(col(p, 'GSTIN')).toEqual([GSTIN, '']) // the latest registration has none: the old GSTIN is not used
    expect(col(p, 'GST Registration Type')).toEqual(['Regular', 'Unregistered']) // Tally's "Unregistered/Consumer"
    expect(col(p, 'Address')).toEqual(['Plot 4, MIDC, Bhosari', MARATHI_CITY])
    expect(col(p, 'Pincode')).toEqual(['', '411001'])
    expect(col(p, 'Opening Balance')).toEqual(['1,500.50 Dr', ''])
    expect(col(p, 'Tally Parent Group')).toEqual(['Pune Debtors', 'Sundry Debtors'])
    const cr = parseOf(TALLY_MASTERS, 'master.xml', `${TALLY_TABLE.creditors} (1)`)
    expect([col(cr, 'Party Name'), col(cr, 'Opening Balance')]).toEqual([['Steel Suppliers'], ['2,500.00 Cr']])
  })

  test('stock items: latest HSN and IGST rate, no guessed rate, root group blank; opening stock per godown', () => {
    const items = parseOf(TALLY_MASTERS, 'master.xml', null, TALLY_TABLE.items)
    expect(col(items, 'Item Name')).toEqual(['MS Bolt M8', 'Cutting Oil'])
    expect(col(items, 'HSN')).toEqual(['7318', ''])
    expect(col(items, 'GST Rate')).toEqual(['18', ''])
    expect(col(items, 'Stock Group')).toEqual(['', 'Consumables'])
    expect(col(items, 'Opening Quantity')).toEqual(['100', '0'])
    const os = parseOf(TALLY_MASTERS, 'master.xml', null, TALLY_TABLE.openingStock)
    expect(os.rows.slice(1).map((r) => r.cells)).toEqual([['MS Bolt M8', '100', 'Nos', '10.00', '1000.00', 'Main Location', '', 'g-item-1']])
    expect(os.notes[0]).toContain('minus sign')
  })
})

describe('Tally XML vouchers (check only)', () => {
  test('header, ledger lines with bills, inventory with batches and accounting allocations; balance, cancel and action reported', () => {
    const p = parseOf(TALLY_VOUCHERS, 'voucher.xml')
    expect(p.rows).toEqual([])
    const v = p.vouchers!
    expect([v.count, v.from, v.to]).toEqual([4, '2026-03-01', '2026-04-11'])
    expect(v.byType).toEqual([
      { type: 'Sales', count: 2, cancelled: 1, optional: 0, unbalanced: 0, amountPaise: 118000 },
      { type: 'Purchase', count: 1, cancelled: 0, optional: 0, unbalanced: 1, amountPaise: 100010 },
      { type: 'Journal', count: 1, cancelled: 0, optional: 0, unbalanced: 0, amountPaise: 50000 },
    ])
    expect(v.actions).toEqual({ Create: 2, Cancel: 1 })
    expect([v.unbalanced, v.ledgerLines, v.inventoryLines, v.billAllocations, v.batchAllocations]).toEqual([1, 7, 1, 1, 1])
    const sale = v.vouchers[0]
    expect(sale.ledgerLines).toEqual([
      { ledger: 'Shree Ganesh Traders', amountPaise: -118000, drCr: 'Dr', fromItem: false, bills: [{ name: 'S-1', type: 'New Ref', amountPaise: -118000 }] },
      { ledger: 'Output IGST', amountPaise: 18000, drCr: 'Cr', fromItem: false, bills: [] }, // the empty bill placeholder is dropped
      { ledger: 'Sales Account', amountPaise: 100000, drCr: 'Cr', fromItem: true, bills: [] },
    ])
    expect(sale.inventoryLines).toEqual([{ item: 'MS Bolt M8', qty: '10', unit: 'Nos', ratePaise: 10000, amountPaise: 100000, batches: [{ godown: 'Main Location', batch: 'Primary Batch', qty: '10 Nos' }] }])
    expect([sale.balanced, v.vouchers[1].balanced, v.vouchers[1].issues]).toEqual([true, false, ['The accounting lines of this voucher do not add up to zero.']])
    expect(v.vouchers[2]).toMatchObject({ cancelled: true, action: 'Cancel', number: 'S-2' })
    expect(v.vouchers[3].ledgerLines.map((l) => l.ledger)).toEqual(['Rent', 'Cash']) // ALLLEDGERENTRIES.LIST read too
  })
})

// ---------------------------------------------------------------- JSON, TXT, PDF, detection

describe('JSON → table', () => {
  test('top-level list, nested lists of records, nested objects, primitive arrays; nested record lists left out', () => {
    const p = parseOf(JSON.stringify([{ name: MARATHI, gstin: GSTIN, phone: 9876543210, active: true, address: { city: MARATHI_CITY }, tags: ['a', 'b'], orders: [{ no: 1 }] }, { name: 'Acme', extra: null }]), 'c.json')
    expect(p.format).toBe('json')
    expect(header(p)).toEqual(['name', 'gstin', 'phone', 'active', 'address.city', 'tags', 'extra'])
    expect(p.rows[1].cells).toEqual([MARATHI, GSTIN, '9876543210', 'true', MARATHI_CITY, 'a; b', ''])
    expect(p.notes.join(' ')).toContain('orders')
    const nested = parseOf(JSON.stringify({ data: { customers: [{ name: 'A' }], items: [{ name: 'X' }, { name: 'Y' }] }, meta: { v: 1 } }), 'd.json')
    expect(nested.sheetNames).toEqual(['data.customers (1)', 'data.items (2)'])
  })

  test('invalid, too deep, mixed lists, nothing to import', () => {
    expect(() => parseOf('{"a": [1, 2', 'x.json')).toThrow('not valid JSON')
    expect(() => parseOf(`${'['.repeat(IMPORT_LIMITS.maxJsonDepth + 1)}${']'.repeat(IMPORT_LIMITS.maxJsonDepth + 1)}`, 'x.json')).toThrow('nested more than')
    expect(jsonDepth('{"a": "[[[[[", "b": [{}]}')).toBe(3) // brackets inside strings do not count
    expect(() => parseOf('[{"a": 1}, 2]', 'x.json')).toThrow('mixes records')
    expect(() => parseOf('[1, 2, 3]', 'x.json')).toThrow('no records')
  })
})

describe('TXT, PDF, signatures and limits', () => {
  test('text in columns: tab, pipe, semicolon; free text is refused', () => {
    expect(parseOf(`Name|City\n${MARATHI}|${MARATHI_CITY}\n`, 'list.txt').rows[1].cells).toEqual([MARATHI, MARATHI_CITY])
    expect(parseOf('Name\tCity\nA\tB\n', 'list.txt').rows[1].cells).toEqual(['A', 'B'])
    expect(parseOf('Name;City\nA;B\n', 'list.txt').format).toBe('txt')
    expect(() => parseOf('Dear sir,\nplease find our customer list attached.\n', 'letter.txt')).toThrow('no columns')
  })

  test('PDF is refused clearly; content and name must agree; binary files are refused', () => {
    expect(() => parseOf(Buffer.from('%PDF-1.7\n1 0 obj <<>> endobj'), 'report.pdf')).toThrow('PDF files cannot be imported')
    expect(() => parseOf(Buffer.from('%PDF-1.4 …'), 'renamed.csv')).toThrow('PDF')
    expect(() => parseOf('Name,City\nA,B', 'data.xml')).toThrow('not XML')
    expect(() => parseOf('<r><a>1</a></r>', 'data.csv')).toThrow('content is XML')
    expect(() => parseOf('[{"a":1}]', 'data.txt')).toThrow('content is JSON')
    expect(() => parseOf('Name\nA', 'data.json')).toThrow('not JSON')
    expect(() => parseOf(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]), 'logo.csv')).toThrow('not a CSV / text file')
    expect(() => parseOf('a,b', 'x.docx')).toThrow('Unsupported file type .docx')
  })

  test('size limits: spreadsheets 2 MB, XML / JSON 32 MB', () => {
    expect(() => parseOf(Buffer.alloc(IMPORT_LIMITS.maxFileBytes + 1, 'a'), 'big.csv')).toThrow('larger than 2 MB')
    const bigXml = Buffer.alloc(IMPORT_LIMITS.maxStructuredBytes + 1, ' ')
    bigXml.write('<r>')
    expect(() => parseOf(bigXml, 'big.xml')).toThrow('larger than 32 MB')
  })

  test('browser-side helpers: file check, parts of 500, results merged', () => {
    expect(fileProblemFor('m.xml', 7_500_000)).toBe('')
    expect(fileProblemFor('m.csv', 7_500_000)).toContain('too large')
    expect(fileProblemFor('r.pdf', 10)).toContain('PDF files cannot be imported')
    expect(fileProblemFor('x.exe', 10)).toContain('cannot be imported')
    const table = [{ line: 1, cells: ['Name'] }, ...Array.from({ length: 1001 }, (_, i) => ({ line: i + 2, cells: [`N${i}`] }))]
    const parts = splitParts(table, 0)
    expect(parts.map((p) => [p.table.length, p.table[0].line, p.table[1].line, p.headerRow])).toEqual([[501, 1, 2, 0], [501, 1, 502, 0], [2, 1, 1002, 0]])
    const r = (ready: number, line: number) => ({ headers: ['Name'], notes: ['n'], rows: [{ line, status: 'ready' as const, messages: [], warnings: [], values: {} }], counts: { total: 1, ready, imported: 0, duplicates: 0, errors: 0, failed: 0, withWarnings: 0 } })
    expect(mergeRunResults([r(1, 2), r(1, 502)])).toMatchObject({ notes: ['n'], counts: { total: 2, ready: 2 }, rows: [{ line: 2 }, { line: 502 }] })
  })
})

// ---------------------------------------------------------------- through the Import Center routes (database)

describe('Import Center routes with the new formats', () => {
  beforeEach(resetDb)

  const upload = async (user: TestUser, companyId: string, dataType: string, data: Buffer, name: string, extra: Record<string, string> = {}) =>
    call(parse(await uploadRequest('/api/import-center/parse', { companyId, dataType, file: { data, name }, ...extra }, user)))
  const post = (handler: (r: Request) => Promise<Response>, path: string, user: TestUser, body: Record<string, unknown>) =>
    call(handler(apiRequest(path, { user, body })))
  const gz = (s: string) => gzipSync(Buffer.from(s))

  test('Tally master XML (sent compressed) → customers: mapping, preview writes nothing, confirmation, import, duplicates on repeat', async () => {
    const { company, user } = await seedTenant()
    const up = await upload(user, company.id, 'customers', gz(TALLY_MASTERS), 'master.xml', { encoding: 'gzip' })
    expect(up.status).toBe(200)
    const p = up.json.data
    expect([p.format, p.sheet, p.headerRow]).toEqual(['tally-xml', `${TALLY_TABLE.debtors} (2)`, 0])
    expect(p.suggestion.mapping).toMatchObject({ name: 0, gstin: 1, gstType: 2, phone: 5, addressLine: 7, state: 8, pincode: 9 })
    const base = { companyId: company.id, dataType: 'customers', source: 'TALLY', fileName: 'master.xml', table: p.table, headerRow: 0, mapping: p.suggestion.mapping }
    const pv = await post(preview, '/api/import-center/preview', user, base)
    expect(pv.json.data.counts).toMatchObject({ total: 2, ready: 2, errors: 0 })
    expect(await db.customer.count()).toBe(0)
    expect((await post(commit, '/api/import-center/commit', user, base)).status).toBe(400) // no confirmation
    const done = await post(commit, '/api/import-center/commit', user, { ...base, confirm: true })
    expect(done.json.data.counts).toMatchObject({ imported: 2, duplicates: 0 })
    const saved = await db.customer.findMany({ where: { companyId: company.id }, orderBy: { name: 'asc' } })
    expect(saved.map((c) => c.name).sort()).toEqual(['Shree Ganesh Traders', MARATHI].sort()) // Marathi kept exactly
    const again = await post(commit, '/api/import-center/commit', user, { ...base, confirm: true })
    expect(again.json.data.counts).toMatchObject({ imported: 0, duplicates: 2 })
    expect(await db.customer.count()).toBe(2)
  })

  test('JSON with more records than one import: parsed whole, checked and imported in parts, no duplicates', async () => {
    const { company, user } = await seedTenant()
    const records = Array.from({ length: 520 }, (_, i) => ({ 'Customer Name': `Party ${String(i + 1).padStart(3, '0')}`, City: i % 2 ? 'Pune' : MARATHI_CITY }))
    const up = await upload(user, company.id, 'customers', gz(JSON.stringify(records)), 'parties.json', { encoding: 'gzip' })
    expect(up.status).toBe(200)
    const p = up.json.data
    expect(p.table.length).toBe(521)
    const parts = splitParts(p.table, 0)
    expect(parts.length).toBe(2)
    const base = { companyId: company.id, dataType: 'customers', source: 'EXCEL', fileName: 'parties.json', mapping: p.suggestion.mapping }
    const checked = mergeRunResults(await Promise.all(parts.map(async (part) => (await post(preview, '/api/import-center/preview', user, { ...base, ...part })).json.data)))
    expect(checked.counts).toMatchObject({ total: 520, ready: 520 })
    for (const part of parts) expect((await post(commit, '/api/import-center/commit', user, { ...base, ...part, confirm: true })).json.data.counts.failed).toBe(0)
    expect(await db.customer.count({ where: { companyId: company.id } })).toBe(520)
    // one part sent alone with more than 500 rows is still refused by the server
    expect((await post(preview, '/api/import-center/preview', user, { ...base, table: p.table, headerRow: 0 })).status).toBe(400)
  }, 120_000)

  test('Tally vouchers: checked through their own data type, never imported; wrong data type explains itself', async () => {
    const { company, user } = await seedTenant()
    const ok = await upload(user, company.id, 'tally-vouchers', gz(TALLY_VOUCHERS), 'voucher.xml', { encoding: 'gzip' })
    expect(ok.status).toBe(200)
    expect(ok.json.data.vouchers).toMatchObject({ count: 4, unbalanced: 1 })
    expect(ok.json.data.table).toEqual([])
    const wrong = await upload(user, company.id, 'customers', gz(TALLY_VOUCHERS), 'voucher.xml', { encoding: 'gzip' })
    expect([wrong.status, wrong.json.error?.message]).toEqual([400, expect.stringContaining('4 Tally vouchers')])
    const noVouchers = await upload(user, company.id, 'tally-vouchers', Buffer.from(TALLY_MASTERS), 'master.xml')
    expect(noVouchers.json.error?.message).toContain('no Tally vouchers')
    const blocked = await post(commit, '/api/import-center/commit', user, { companyId: company.id, dataType: 'tally-vouchers', table: [{ line: 1, cells: ['x'] }], headerRow: 0, mapping: {}, confirm: true })
    expect([blocked.status, blocked.json.error?.message]).toEqual([400, expect.stringContaining('not imported')])
    expect(await db.auditLog.count({ where: { action: 'IMPORT' } })).toBe(0)
  })

  test('upload limits: compressed bomb, fake gzip, oversize request, PDF; JSON over the part limit for opening stock', async () => {
    const { company, user } = await seedTenant()
    const bomb = gzipSync(Buffer.alloc(IMPORT_LIMITS.maxStructuredBytes + 1024 * 1024, ' '))
    expect(bomb.length).toBeLessThan(IMPORT_LIMITS.maxUploadBytes)
    expect((await upload(user, company.id, 'customers', bomb, 'big.xml', { encoding: 'gzip' })).json.error?.message).toContain('larger than 32 MB')
    expect((await upload(user, company.id, 'customers', Buffer.from('<r/>'), 'a.xml', { encoding: 'gzip' })).json.error?.message).toContain('not gzip')
    const huge = apiRequest('/api/import-center/parse', { method: 'POST', user, headers: { 'content-length': String(IMPORT_LIMITS.maxUploadBytes + 1024 * 1024) }, body: {} })
    expect((await call(parse(huge))).status).toBe(413)
    expect((await upload(user, company.id, 'customers', Buffer.from('%PDF-1.7'), 'list.pdf')).json.error?.message).toContain('PDF files cannot be imported')
    const many = JSON.stringify(Array.from({ length: 501 }, (_, i) => ({ 'Item Name': `I${i}`, Quantity: '1' })))
    const r = await upload(user, company.id, 'customers', Buffer.from(many), 'x.json')
    expect(r.status).toBe(200) // customers may come in parts
    // CSV keeps its 500-row limit
    const csv = ['Customer Name', ...Array.from({ length: 501 }, (_, i) => `P${i}`)].join('\n')
    expect((await upload(user, company.id, 'customers', Buffer.from(csv), 'x.csv')).json.error?.message).toContain('the limit is 500')
  })

  test('Marathi CSV (UTF-8 with BOM) keeps its text through the preview', async () => {
    const { company, user } = await seedTenant()
    const up = await upload(user, company.id, 'customers', Buffer.from(`﻿Customer Name,City\n${MARATHI},${MARATHI_CITY}\n`), 'm.csv')
    const p = up.json.data
    const pv = await post(preview, '/api/import-center/preview', user, { companyId: company.id, dataType: 'customers', table: p.table, headerRow: p.headerRow, mapping: p.suggestion.mapping })
    expect(pv.json.data.rows[0]).toMatchObject({ status: 'ready', values: { name: MARATHI, city: MARATHI_CITY } })
  })
})

// ---------------------------------------------------------------- hardening: GST consistency, duplicates across parts, memory

const party = (name: string, inner: string) => msg(`<LEDGER NAME="${name}" RESERVEDNAME=""><PARENT>&#4; Sundry Debtors</PARENT>${inner}</LEDGER>`)
const reg = (from: string, type: string, gstin: string) =>
  `<LEDGSTREGDETAILS.LIST><APPLICABLEFROM>${from}</APPLICABLEFROM><GSTREGISTRATIONTYPE>${type}</GSTREGISTRATIONTYPE><GSTIN>${gstin}</GSTIN></LEDGSTREGDETAILS.LIST>`

describe('Tally GST: one source for GSTIN and type; conflicts reported, never guessed', () => {
  const GST_FILE = env('Demo', [
    party('Old Style', `<PARTYGSTIN>${GSTIN}</PARTYGSTIN><GSTREGISTRATIONTYPE>Regular</GSTREGISTRATIONTYPE>`),
    party('New Style', `${reg('20170701', 'Unregistered/Consumer', '')}${reg('20240401', 'Regular', GSTIN)}`),
    party('Both Agree', `<PARTYGSTIN>${GSTIN}</PARTYGSTIN>${reg('20240401', 'Regular', GSTIN)}`),
    party('Ledger Differs', `<PARTYGSTIN>24ABCDE1234F1Z5</PARTYGSTIN>${reg('20240401', 'Regular', GSTIN)}`),
    party('Same Day Twice', `${reg('20240401', 'Regular', GSTIN)}${reg('20240401', 'Composition', GSTIN)}`),
    party('GSTIN But Unregistered', `<PARTYGSTIN>${GSTIN}</PARTYGSTIN><GSTREGISTRATIONTYPE>Unregistered/Consumer</GSTREGISTRATIONTYPE>`),
    party('Regular Without GSTIN', reg('20240401', 'Regular', '')),
    party('Unknown Type', `<PARTYGSTIN>${GSTIN}</PARTYGSTIN><GSTREGISTRATIONTYPE>Deemed Exporter</GSTREGISTRATIONTYPE>`),
  ].join(''))

  test('the latest registration is used for both values; every kind of conflict blanks both and explains', () => {
    const p = parseOf(GST_FILE, 'g.xml', null, TALLY_TABLE.debtors)
    const rows = Object.fromEntries(p.rows.slice(1).map((r) => [r.cells[0], { gstin: r.cells[1], type: r.cells[2], check: r.cells[header(p).indexOf(IMPORT_CHECK_HEADER)] }]))
    expect(rows['Old Style']).toEqual({ gstin: GSTIN, type: 'Regular', check: '' })
    expect(rows['New Style']).toEqual({ gstin: GSTIN, type: 'Regular', check: '' })
    expect(rows['Both Agree']).toEqual({ gstin: GSTIN, type: 'Regular', check: '' })
    expect(rows['Unknown Type']).toEqual({ gstin: GSTIN, type: '', check: '' }) // unknown type: blank, decided from the GSTIN
    for (const [name, says] of [
      ['Ledger Differs', 'differs from its latest GST registration'], ['Same Day Twice', 'from the same date'],
      ['GSTIN But Unregistered', 'registration type is Unregistered/Consumer'], ['Regular Without GSTIN', 'but there is no GSTIN'],
    ]) {
      expect([name, rows[name].gstin, rows[name].type, rows[name].check]).toEqual([name, '', '', expect.stringContaining(says)])
    }
  })

  test('the Import check column makes the row an error on the server (it can only block rows)', () => {
    const p = parseOf(GST_FILE, 'g.xml', null, TALLY_TABLE.debtors)
    const dt = findDataType('customers')!
    const res = applyMapping(dt, p.rows, 0, { name: 0, gstin: 1, gstType: 2 })
    const byName = Object.fromEntries(res.rows.map((r) => [r.values.name, r.errors]))
    expect(byName['Old Style']).toEqual([])
    expect(byName['Ledger Differs']).toEqual([expect.stringContaining('Tally GST data does not agree')])
    // the column cannot be "unmapped" to get around it: it is read whatever the mapping
    expect(applyMapping(dt, p.rows, 0, { name: 0 }).rows.find((r) => r.values.name === 'Same Day Twice')!.errors).toHaveLength(1)
  })
})

describe('duplicates across the whole file', () => {
  const row = (line: number, status: 'ready' | 'duplicate' | 'error', values: Record<string, string>) => ({ line, status, messages: [], warnings: [], values })
  const result = (rows: ReturnType<typeof row>[]) => ({ headers: [], notes: [], rows, counts: { total: rows.length, ready: rows.filter((r) => r.status === 'ready').length, imported: 0, duplicates: rows.filter((r) => r.status === 'duplicate').length, errors: rows.filter((r) => r.status === 'error').length, failed: 0, withWarnings: 0 } })

  test('a later ready row repeating an earlier ready row (any part) becomes a duplicate; errors and database duplicates claim nothing', () => {
    const r = result([
      row(2, 'ready', { name: 'Acme' }), row(3, 'error', { name: 'Zed' }), row(4, 'duplicate', { name: 'Old Co' }),
      row(600, 'ready', { name: 'ACME ' }), row(601, 'ready', { name: 'Zed' }), row(602, 'ready', { name: 'Old Co' }), row(603, 'ready', { name: 'Other', code: 'c-1' }), row(604, 'ready', { name: 'Else', code: 'C-1' }),
    ])
    const { result: out, fileDuplicates } = markFileDuplicates('customers', r)
    expect([...fileDuplicates.keys()]).toEqual([600, 604])
    expect(fileDuplicates.get(600)).toBe('Same name “ACME” as row 2 earlier in this file — skipped') // this row's spelling, the earlier row's number
    expect(fileDuplicates.get(604)).toBe('Same code C-1 as row 603 earlier in this file — skipped')
    expect(out.counts).toMatchObject({ total: 8, ready: 4, duplicates: 3, errors: 1 })
    // items: the item form's name rule (spaces / case / punctuation), codes and barcodes
    const items = markFileDuplicates('items', result([row(2, 'ready', { name: 'MS Plate 10 mm' }), row(3, 'ready', { name: 'ms-plate 10MM' }), row(4, 'ready', { name: 'X', barcode: '890' }), row(5, 'ready', { name: 'Y', barcode: '890' })]))
    expect([...items.fileDuplicates.keys()]).toEqual([3, 5])
  })

  test('left out of the import and added back as skipped rows', () => {
    const table = [{ line: 1, cells: ['Name'] }, { line: 2, cells: ['A'] }, { line: 3, cells: ['a'] }]
    expect(withoutLines(table, 0, new Set([3]))).toEqual(table.slice(0, 2))
    const preview = result([row(2, 'ready', { name: 'A' }), row(3, 'ready', { name: 'a' })])
    const marked = markFileDuplicates('customers', preview)
    const imported = { ...result([row(2, 'ready', { name: 'A' })]), rows: [{ ...row(2, 'ready', { name: 'A' }), status: 'imported' as const }] }
    expect(addFileDuplicates(imported, marked.result, marked.fileDuplicates).rows.map((r) => [r.line, r.status])).toEqual([[2, 'imported'], [3, 'duplicate']])
  })
})

describe('Import Center routes: duplicates across parts, upload slots', () => {
  beforeEach(resetDb)
  const upload = async (user: TestUser, companyId: string, dataType: string, data: Buffer, name: string, extra: Record<string, string> = {}) =>
    call(parse(await uploadRequest('/api/import-center/parse', { companyId, dataType, file: { data, name }, ...extra }, user)))
  const post = (handler: (r: Request) => Promise<Response>, path: string, user: TestUser, body: Record<string, unknown>) =>
    call(handler(apiRequest(path, { user, body })))

  test('a record repeated in another part is shown as a duplicate in the preview and created once', async () => {
    const { company, user } = await seedTenant()
    const records = Array.from({ length: 510 }, (_, i) => ({ 'Customer Name': `Party ${String(i + 1).padStart(3, '0')}` }))
    records[504]['Customer Name'] = 'PARTY 003' // record 505 (part 2) repeats record 3 (part 1)
    const p = (await upload(user, company.id, 'customers', gzipSync(Buffer.from(JSON.stringify(records))), 'p.json', { encoding: 'gzip' })).json.data
    const base = { companyId: company.id, dataType: 'customers', mapping: p.suggestion.mapping, fileName: 'p.json' }
    const parts = splitParts(p.table, 0)
    const merged = mergeRunResults(await Promise.all(parts.map(async (part) => (await post(preview, '/api/import-center/preview', user, { ...base, ...part })).json.data)))
    expect(merged.counts).toMatchObject({ ready: 510, duplicates: 0 }) // each part alone cannot see it
    const { result: checked, fileDuplicates } = markFileDuplicates('customers', merged)
    expect(checked.counts).toMatchObject({ total: 510, ready: 509, duplicates: 1 })
    expect(checked.rows.find((r) => r.line === 506)).toMatchObject({ status: 'duplicate', messages: ['Same name “PARTY 003” as row 4 earlier in this file — skipped'] })
    const results: RunResult[] = []
    for (const part of splitParts(withoutLines(p.table, 0, new Set(fileDuplicates.keys())), 0)) results.push((await post(commit, '/api/import-center/commit', user, { ...base, ...part, confirm: true })).json.data)
    const done = addFileDuplicates(mergeRunResults(results), checked, fileDuplicates)
    expect(done.counts).toMatchObject({ total: 510, imported: 509, duplicates: 1, failed: 0 })
    expect(await db.customer.count({ where: { companyId: company.id } })).toBe(509)
    // the server still refuses it if the browser sends it anyway (database duplicate check)
    const again = await post(commit, '/api/import-center/commit', user, { ...base, table: [p.table[0], p.table[505]], headerRow: 0, confirm: true })
    expect(again.json.data.counts).toMatchObject({ imported: 0, duplicates: 1 })
  }, 120_000)

  test('at most two large uploads are read at once; slots are always given back', async () => {
    const { company, user } = await seedTenant()
    const held = Array.from({ length: MAX_LARGE_UPLOADS }, () => takeLargeUploadSlot())
    expect(() => takeLargeUploadSlot()).toThrow('try again')
    const busy = await upload(user, company.id, 'customers', gzipSync(Buffer.from(TALLY_MASTERS)), 'm.xml', { encoding: 'gzip' })
    expect([busy.status, busy.json.error?.message]).toEqual([429, expect.stringContaining('try again')])
    held.forEach((r) => r())
    expect(largeUploadsInFlight()).toBe(0)
    expect((await upload(user, company.id, 'customers', gzipSync(Buffer.from(TALLY_MASTERS)), 'm.xml', { encoding: 'gzip' })).status).toBe(200)
    expect((await upload(user, company.id, 'customers', Buffer.from('<r/>'), 'a.xml', { encoding: 'gzip' })).status).toBe(400) // fails: slot still returned
    expect(largeUploadsInFlight()).toBe(0)
  })
})

describe('memory: a ~30 MB Tally master file', () => {
  /** Stock items shaped like a real TallyPrime export (~7.8 KB each: many flags, GST details, batch allocation). */
  function bigTallyFile(target: number): { xml: string; items: number } {
    const flags = Array.from({ length: 60 }, (_, i) => `<FLAG${i}>No</FLAG${i}>`).join('\n          ')
    const parts: string[] = []
    let size = 0
    let i = 0
    while (size < target) {
      const item = msg(`\n        <STOCKITEM NAME="Item ${++i} ${MARATHI}" RESERVEDNAME="">\n          <GUID>g-${i}</GUID><PARENT>&#4; Primary</PARENT><BASEUNITS>Nos</BASEUNITS>\n          ${flags}\n` +
        `          <GSTDETAILS.LIST><APPLICABLEFROM>20220101</APPLICABLEFROM><HSNCODE>7318</HSNCODE><STATEWISEDETAILS.LIST><STATENAME>&#4; Any</STATENAME>` +
        ['IGST', 'CGST', 'SGST/UTGST', 'Cess', 'State Cess'].map((h) => `\n            <RATEDETAILS.LIST><GSTRATEDUTYHEAD>${h}</GSTRATEDUTYHEAD><GSTRATEVALUATIONTYPE>Based on Value</GSTRATEVALUATIONTYPE><GSTRATE> 18</GSTRATE></RATEDETAILS.LIST>`).join('') +
        `\n          </STATEWISEDETAILS.LIST></GSTDETAILS.LIST>\n          <OPENINGBALANCE> 5 Nos</OPENINGBALANCE><OPENINGVALUE>-50.00</OPENINGVALUE>\n` +
        `          <BATCHALLOCATIONS.LIST><GODOWNNAME>Main Location</GODOWNNAME><BATCHNAME>Primary Batch</BATCHNAME><OPENINGBALANCE> 5 Nos</OPENINGBALANCE><OPENINGVALUE>-50.00</OPENINGVALUE></BATCHALLOCATIONS.LIST>\n` +
        `          ${'<UNUSED.LIST>      </UNUSED.LIST>\n          '.repeat(40)}\n        </STOCKITEM>\n`)
      parts.push(item)
      size += item.length
    }
    return { xml: env('Big Co', parts.join('')), items: i }
  }

  test('parsed within limits, in reasonable time and memory, and nothing is kept afterwards', () => {
    const { xml, items } = bigTallyFile(30 * 1024 * 1024)
    const buf = Buffer.from(xml)
    expect(buf.length).toBeLessThan(IMPORT_LIMITS.maxStructuredBytes)
    Bun.gc(true)
    const before = process.memoryUsage()
    const t0 = performance.now()
    const p = parseOf(buf, 'big.xml', null, TALLY_TABLE.items)
    const ms = performance.now() - t0
    const during = process.memoryUsage()
    expect(p.rows.length).toBe(items + 1)
    expect(col(p, 'GST Rate')[items - 1]).toBe('18')
    const growthMb = (during.rss - before.rss) / 1024 / 1024
    console.log(`[memory] ${(buf.length / 1024 / 1024).toFixed(1)} MB XML, ${items} stock items: ${Math.round(ms)} ms, RSS +${growthMb.toFixed(0)} MB (heap used ${(during.heapUsed / 1024 / 1024).toFixed(0)} MB)`)
    expect(ms).toBeLessThan(20_000)
    expect(growthMb).toBeLessThan(900)
    // a second parse does not keep growing (nothing from the first one is retained)
    Bun.gc(true)
    const settled = process.memoryUsage().rss
    parseOf(buf, 'big.xml', null, TALLY_TABLE.items)
    Bun.gc(true)
    const afterSecond = process.memoryUsage().rss
    console.log(`[memory] after GC: ${(settled / 1024 / 1024).toFixed(0)} MB → after a second parse + GC: ${(afterSecond / 1024 / 1024).toFixed(0)} MB`)
    expect((afterSecond - settled) / 1024 / 1024).toBeLessThan(150)
  }, 120_000)

  test('indentation is not kept as text; just over 32 MB and over 2 million elements are refused', () => {
    const tree = parseXml('<r>\n  <a>\n    <b> x </b>\n  </a>\n</r>')
    expect([tree.text, tree.children[0].text, tree.children[0].children[0].text]).toEqual(['', '', ' x '])
    const over = Buffer.alloc(IMPORT_LIMITS.maxStructuredBytes + 1, ' ')
    over.write('<ENVELOPE>')
    expect(() => parseOf(over, 'big.xml')).toThrow('larger than 32 MB')
    expect(() => parseXml(`<r>${'<i/>'.repeat(XML_LIMITS.maxElements + 1)}</r>`)).toThrow('more than 20,00,000 elements') // Indian digit grouping
  }, 120_000)
})
