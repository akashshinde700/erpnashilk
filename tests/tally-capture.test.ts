import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as connector from '../connector/tally/manuflow-tally-connector.mjs'
import { anonymiseFolder } from '../scripts/tally-fixtures/anonymise.mjs'

// Preparing real-Tally validation (docs/tally-real-validation-plan.md): the capture command and the anonymiser,
// against a mock TallyPrime with made-up data. Nothing here contacts a real Tally.

const GUID = (n: number) => `4a7c1e2b-90d1-4c3e-9f00-1b2c3d4e5f${String(n).padStart(2, '0')}-0000003${n}`
const wrap = (inner: string) => `<ENVELOPE><HEADER><VERSION>1</VERSION><STATUS>1</STATUS></HEADER><BODY><DATA><COLLECTION>${inner}</COLLECTION></DATA></BODY></ENVELOPE>`
const COMPANIES = wrap('<COMPANY NAME="Kothrud Engineering Works"><NAME>Kothrud Engineering Works</NAME><BOOKSFROM>20240401</BOOKSFROM><STARTINGFROM>20260401</STARTINGFROM></COMPANY><COMPANY NAME="Trial Co"><NAME>Trial Co</NAME></COMPANY>')
const DEBTORS = wrap(
  `<LEDGER NAME="Hadapsar Fabricators"><GUID>${GUID(1)}</GUID><PARENT>Sundry Debtors</PARENT><PARTYGSTIN>27AAKCH1111A1Z5</PARTYGSTIN>` +
  '<INCOMETAXNUMBER>AAKCH1111A</INCOMETAXNUMBER><LEDGERMOBILE>9822012345</LEDGERMOBILE><EMAIL>accounts@hadapsar-fab.example</EMAIL>' +
  '<LEDGERCONTACT>Suresh Patil</LEDGERCONTACT><ADDRESS.LIST><ADDRESS>Plot 7, Hadapsar Industrial Estate</ADDRESS><ADDRESS>Pune</ADDRESS></ADDRESS.LIST>' +
  '<LEDSTATENAME>Maharashtra</LEDSTATENAME><PINCODE>411013</PINCODE></LEDGER>',
)
const CREDITORS = wrap(`<LEDGER NAME="Bhosari Steel Traders"><GUID>${GUID(2)}</GUID><PARENT>Sundry Creditors</PARENT><PARTYGSTIN>24AABCB2222B1Z1</PARTYGSTIN></LEDGER>` +
  `<LEDGER NAME="Hadapsar Fabricators"><GUID>${GUID(1)}</GUID><PARENT>Sundry Creditors</PARENT></LEDGER>`) // same party on both sides
const ITEMS = wrap(`<STOCKITEM NAME="MS Bolt M8 x 40"><GUID>${GUID(3)}</GUID><PARENT>Fasteners</PARENT><BASEUNITS>Nos</BASEUNITS><HSNCODE>73181500</HSNCODE></STOCKITEM>` +
  // as real TallyPrime writes a built-in group (seen in the first real capture, 2026-11-03)
  `<STOCKITEM NAME="Cutting Oil"><GUID>${GUID(4)}</GUID><PARENT TYPE="String">&#4; Primary</PARENT><BASEUNITS>Ltr</BASEUNITS></STOCKITEM>`)

const bodies: string[] = []
const fetched: string[] = []
let tally: ReturnType<typeof Bun.serve>
let utf16 = false
let dir = ''
const realFetch = globalThis.fetch

beforeAll(() => {
  tally = Bun.serve({
    port: 0, hostname: '127.0.0.1',
    async fetch(req) {
      const body = await req.text()
      bodies.push(body)
      const id = /<ID>([^<]*)<\/ID>/.exec(body)?.[1] ?? ''
      const text = { ManuFlowCompanies: COMPANIES, ManuFlowDebtors: DEBTORS, ManuFlowCreditors: CREDITORS, ManuFlowStockItems: ITEMS }[id] ?? wrap('')
      return new Response(utf16 ? Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]) : text)
    },
  })
  // every network call made during these tests is recorded: only the mock Tally may be contacted
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    fetched.push(String(input instanceof Request ? input.url : input))
    return realFetch(input, init)
  }) as typeof fetch
  dir = mkdtempSync(join(tmpdir(), 'mf-tally-capture-test-'))
})
afterAll(() => {
  globalThis.fetch = realFetch
  tally.stop(true)
  rmSync(dir, { recursive: true, force: true })
})
beforeEach(() => {
  bodies.length = 0
  fetched.length = 0
  utf16 = false
})

const tallyUrl = () => `http://127.0.0.1:${tally.port}`
let n = 0
const newDir = () => join(dir, `capture-${++n}`)
const quiet = () => {}

describe('capture: read-only, outside Git, owner chooses the company', () => {
  test('without a company: only the company list is read and saved, and the names are shown to choose from', async () => {
    const out = newDir()
    const logs: string[] = []
    const r = await connector.capture({ tally: tallyUrl(), out, log: (m: string) => logs.push(m) })
    expect(r.companies).toEqual(['Kothrud Engineering Works', 'Trial Co'])
    expect(readdirSync(out).sort()).toEqual(['list-companies.xml', 'manifest.json'])
    expect(readFileSync(join(out, 'list-companies.xml'), 'utf8')).toBe(COMPANIES) // the exact bytes Tally sent
    expect(logs.join('\n')).toContain('1. Kothrud Engineering Works')
    if (process.platform !== 'win32') {
      expect(statSync(out).mode & 0o777).toBe(0o700)
      expect(statSync(join(out, 'list-companies.xml')).mode & 0o777).toBe(0o600)
    }
    expect(bodies.length).toBe(1)
  })

  test('with a company: customers, suppliers and stock items, raw bytes and a manifest; only Export requests', async () => {
    const out = newDir()
    await connector.capture({ tally: tallyUrl(), out, company: 'Kothrud Engineering Works', log: quiet })
    expect(readdirSync(out).sort()).toEqual(['export-customers.xml', 'export-items.xml', 'export-suppliers.xml', 'list-companies.xml', 'manifest.json'])
    const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'))
    expect(manifest.files.map((f: { job: string; records: number }) => [f.job, f.records])).toEqual([
      ['list-companies', 2], ['export-customers', 1], ['export-suppliers', 2], ['export-items', 2],
    ])
    expect(JSON.stringify(manifest)).not.toMatch(/mftc_|token/i)
    expect(bodies.length).toBe(4)
    for (const b of bodies) expect(connector.isExportRequest(b)).toBe(true)
    // nothing but the Tally address was contacted (no ManuFlow, no other host)
    expect(fetched.every((u) => u.startsWith(tallyUrl()))).toBe(true)
  })

  test('UTF-16 replies are saved exactly as received', async () => {
    utf16 = true
    const out = newDir()
    await connector.capture({ tally: tallyUrl(), out, company: 'Trial Co', log: quiet })
    const raw = readFileSync(join(out, 'export-items.xml'))
    expect([raw[0], raw[1]]).toEqual([0xff, 0xfe])
  })

  test('refused: a folder inside Git, a relative or non-empty folder, a company not open in Tally, no Tally address', async () => {
    const inRepo = join(process.cwd(), 'tmp-capture-must-not-exist')
    await expect(connector.capture({ tally: tallyUrl(), out: inRepo, log: quiet })).rejects.toThrow(/outside any Git/)
    expect(existsSync(inRepo)).toBe(false)
    await expect(connector.capture({ tally: tallyUrl(), out: 'relative/folder', log: quiet })).rejects.toThrow(/absolute/)
    const used = newDir()
    mkdirSync(used)
    writeFileSync(join(used, 'x'), 'x')
    await expect(connector.capture({ tally: tallyUrl(), out: used, log: quiet })).rejects.toThrow(/new or empty/)
    bodies.length = 0
    await expect(connector.capture({ tally: tallyUrl(), out: newDir(), company: 'Some Other Co', log: quiet })).rejects.toThrow(/not open in TallyPrime/)
    expect(bodies.length).toBe(1) // only the company list was read
    // the CLI never falls back to the saved settings for the Tally address
    const logs: string[] = []
    expect(await connector.main(['capture', '--out', newDir()], (m: string) => logs.push(m))).toBe(1)
    expect(logs.join('\n')).toMatch(/Tally address is not valid/)
  })
})

describe('anonymiser', () => {
  async function captured(company = 'Kothrud Engineering Works') {
    const out = newDir()
    await connector.capture({ tally: tallyUrl(), out, company, log: quiet })
    return out
  }
  const ORIGINALS = ['Kothrud Engineering', 'Hadapsar Fabricators', 'Bhosari Steel', 'MS Bolt', 'Cutting Oil', 'Fasteners', '27AAKCH1111A1Z5', 'AAKCH1111A',
    '24AABCB2222B1Z1', '9822012345', 'accounts@hadapsar-fab.example', 'Suresh Patil', 'Plot 7', '4a7c1e2b-90d1']

  test('every identifying value is replaced; structure, Tally names, state codes, units and HSN are kept', async () => {
    const out = newDir()
    const r = anonymiseFolder(await captured(), out, quiet)
    expect(r.files).toEqual(['export-customers.xml', 'export-items.xml', 'export-suppliers.xml', 'list-companies.xml'])
    const all = r.files.map((f) => readFileSync(join(out, f), 'utf8')).join('\n')
    for (const o of ORIGINALS) expect([o, all.includes(o)]).toEqual([o, false])
    for (const keep of ['Sundry Debtors', 'Sundry Creditors', '<PARENT TYPE="String">&#4; Primary</PARENT>', 'Maharashtra', '<BASEUNITS>Nos</BASEUNITS>', '<HSNCODE>73181500</HSNCODE>', '<BOOKSFROM>20240401</BOOKSFROM>', '-00000031']) {
      expect([keep, all.includes(keep)]).toEqual([keep, true])
    }
    expect(all).toMatch(/<PARTYGSTIN>27ZZ[A-Z]{3}\d{4}Z1Z\d<\/PARTYGSTIN>/) // state code 27 kept
    expect(all).toMatch(/<PARTYGSTIN>24ZZ/)
    expect(all).toMatch(/<PINCODE>41\d{4}<\/PINCODE>/)
  })

  test('the same party gets the same fake name in every file, and the fixtures still read through the connector', async () => {
    const out = newDir()
    anonymiseFolder(await captured(), out, quiet)
    const name = (f: string, i = 0) => [...readFileSync(join(out, f), 'utf8').matchAll(/<LEDGER NAME="([^"]+)"/g)].map((m) => m[1])[i]
    expect(name('export-suppliers.xml', 1)).toBe(name('export-customers.xml'))
    // serve the anonymised replies through a mock Tally and read them with the real job readers
    const served = Bun.serve({
      port: 0, hostname: '127.0.0.1',
      async fetch(req) {
        const id = /<ID>([^<]*)<\/ID>/.exec(await req.text())?.[1] ?? ''
        const file = { ManuFlowCompanies: 'list-companies', ManuFlowDebtors: 'export-customers', ManuFlowCreditors: 'export-suppliers', ManuFlowStockItems: 'export-items' }[id]
        return new Response(file ? readFileSync(join(out, `${file}.xml`)) : '')
      },
    })
    try {
      const r = await connector.runJob(`http://127.0.0.1:${served.port}`, { type: 'export-customers', company: 'x' })
      expect(r.ok).toBe(true)
      expect(r.records[0]).toMatchObject({ parent: 'Sundry Debtors', state: 'Maharashtra', gstin: expect.stringMatching(/^27ZZ/), email: expect.stringMatching(/@example\.test$/) })
    } finally { served.stop(true) }
  })

  test('UTF-16 captures stay UTF-16', async () => {
    utf16 = true
    const out = newDir()
    anonymiseFolder(await captured('Trial Co'), out, quiet)
    const raw = readFileSync(join(out, 'export-customers.xml'))
    expect([raw[0], raw[1]]).toEqual([0xff, 0xfe])
    expect(Buffer.from(raw.subarray(2)).toString('utf16le')).not.toContain('Hadapsar')
  })

  test('a value in a tag it does not know is caught: nothing is written', async () => {
    const input = newDir()
    mkdirSync(input)
    writeFileSync(join(input, 'export-customers.xml'), wrap('<LEDGER NAME="X Co"><UDFNOTE>Bank ref 27AAKCH1111A1Z5</UDFNOTE></LEDGER>'))
    const out = newDir()
    const logs: string[] = []
    expect(() => anonymiseFolder(input, out, (m: string) => logs.push(m))).toThrow(/Not anonymised safely/)
    expect(existsSync(out)).toBe(false)
    expect(logs.join('\n')).toContain('a GSTIN that is not a generated fake')
    expect(logs.join('\n')).not.toContain('27AAKCH1111A1Z5') // the report never repeats the value
  })
})
