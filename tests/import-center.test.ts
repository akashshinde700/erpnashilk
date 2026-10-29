import { beforeEach, describe, expect, test } from 'bun:test'
import { db } from '@/lib/db'
import { POST as parse } from '@/app/api/import-center/parse/route'
import { POST as preview } from '@/app/api/import-center/preview/route'
import { POST as commit } from '@/app/api/import-center/commit/route'
import { GET as history } from '@/app/api/import-center/history/route'
import { withImportLock } from '@/app/api/import-center/_shared'
import { apiRequest, call, uploadRequest, type TestUser } from './helpers/api'
import { resetDb } from './helpers/db'
import { csv, makeXlsx } from './helpers/files'
import { seedTenant, seedUser } from './helpers/seed'

beforeEach(resetDb)

const upload = async (user: TestUser, companyId: string, dataType: string, data: string | Uint8Array, name: string) =>
  call(parse(await uploadRequest('/api/import-center/parse', { companyId, dataType, file: { data: typeof data === 'string' ? Buffer.from(data) : data, name } }, user)))

const post = (handler: (r: Request) => Promise<Response>, path: string, user: TestUser, body: Record<string, unknown>) =>
  call(handler(apiRequest(path, { user, body })))

/** Business tables an import could touch. */
const businessCounts = async () => ({
  customers: await db.customer.count(), suppliers: await db.supplier.count(), items: await db.item.count(),
  ledger: await db.stockLedger.count(), audit: await db.auditLog.count(),
})

const CUSTOMER_FILE = csv([
  ['Acme Industries — List of Ledgers'],
  [''],
  ['Ledger Name', 'GST No', 'Mobile', 'City', 'State', 'Opening Balance'],
  ['Shree Traders', '27ABCDE1234F1Z5', '98765 43210', 'Pune', 'Maharashtra', '5000'],
  ['Gujarat Bearings', '', '', 'Surat', 'Gujarat', ''],
  ['Bad Phone Co', '', '12345', 'Nashik', 'Maharashtra', ''],
  ['shree traders', '', '', '', '', ''],
])

describe('Import Center — customers end-to-end (CSV)', () => {
  test('upload → suggested mapping → preview writes nothing → confirm → commit → history', async () => {
    const { company, user } = await seedTenant()
    const up = await upload(user, company.id, 'customers', CUSTOMER_FILE, 'ledgers.csv')
    expect(up.status).toBe(200)
    const p = up.json.data
    expect(p.format).toBe('csv')
    expect(p.headerRow).toBe(1) // title row dropped as blank; header is the 2nd non-blank row
    expect(p.suggestion.mapping).toEqual({ name: 0, gstin: 1, phone: 2, city: 3, state: 4 })
    expect(p.suggestion.notImported.map((n: { header: string }) => n.header)).toEqual(['Opening Balance'])

    const before = await businessCounts()
    const body = { companyId: company.id, dataType: 'customers', source: 'TALLY', fileName: p.fileName, table: p.table, headerRow: p.headerRow, mapping: p.suggestion.mapping }
    const pv = await post(preview, '/api/import-center/preview', user, body)
    expect(pv.status).toBe(200)
    expect(await businessCounts()).toEqual(before) // preview is read-only — no rows, no audit entry
    const byName = Object.fromEntries(pv.json.data.rows.map((r: { values: { name: string } }) => [r.values.name, r]))
    expect(byName['Shree Traders'].status).toBe('ready')
    expect(byName['Gujarat Bearings']).toMatchObject({ status: 'ready', values: { stateCode: '24' } })
    expect(byName['Bad Phone Co'].status).toBe('error')
    expect(byName['shree traders'].status).toBe('duplicate') // same name earlier in the file
    expect(byName['Shree Traders'].line).toBe(4) // the user's row number in the file
    expect(pv.json.data.counts).toMatchObject({ total: 4, ready: 2, duplicates: 1, errors: 1 })

    // No write without explicit confirmation
    const unconfirmed = await post(commit, '/api/import-center/commit', user, body)
    expect(unconfirmed.status).toBe(400)
    expect(await businessCounts()).toEqual(before)

    const done = await post(commit, '/api/import-center/commit', user, { ...body, confirm: true })
    expect(done.status).toBe(200)
    expect(done.json.data.counts).toMatchObject({ imported: 2, duplicates: 1, errors: 1, failed: 0 })
    const shree = await db.customer.findFirstOrThrow({ where: { companyId: company.id, name: 'Shree Traders' } })
    expect(shree).toMatchObject({ gstin: '27ABCDE1234F1Z5', stateCode: '27', gstType: 'REGULAR', phone: '9876543210', openingBalance: 0 })
    expect((await db.customer.findFirstOrThrow({ where: { name: 'Gujarat Bearings' } })).stateCode).toBe('24')

    const h = await call(history(apiRequest('/api/import-center/history', { user })))
    expect(h.json.data.total).toBe(1)
    expect(h.json.data.items[0].details).toContain('Import Center · Customers from Tally (Excel / CSV export) file "ledgers.csv": 2 imported, 1 skipped (duplicates), 1 failed')
    expect(h.json.data.items[0].details).toContain('Row 6:')

    // Importing the same file again: everything is now a duplicate
    const again = await post(commit, '/api/import-center/commit', user, { ...body, confirm: true })
    expect(again.json.data.counts).toMatchObject({ imported: 0, duplicates: 3 })
    expect(await db.customer.count({ where: { companyId: company.id } })).toBe(2)
  })
})

describe('Import Center — items end-to-end (XLSX)', () => {
  const ITEMS = makeXlsx({
    'Stock Summary': [
      ['Stock Item', 'SKU', 'HSN Code', 'Tax Rate', 'UOM', 'Purchase Price', 'Selling Price', 'Category', 'Opening Quantity'],
      ['MS Plate 10mm', 'RM-PL10', '7208', '18%', 'Kgs', '₹ 1,250.50', '1,400', 'Steel', '100'],
      ['Machining Labour', '', '998898', '18', 'Hrs', '', '500', '', ''],
      ['No GST Item', 'X-1', '', '', 'Nos', '1', '2', '', ''],
      ['Odd Unit', 'X-2', '', '5', 'Bucket', '1', '2', '', ''],
      ['ms-plate 10 MM', 'X-3', '', '18', 'Kg', '1', '2', '', ''],
    ],
  })

  test('aliases, normalised values, required GST rate / unit, generated codes, no opening stock', async () => {
    const { company, user } = await seedTenant()
    const up = await upload(user, company.id, 'items', ITEMS, 'stock.xlsx')
    expect(up.status).toBe(200)
    const p = up.json.data
    expect(p.format).toBe('xlsx')
    expect(p.suggestion.mapping).toEqual({ name: 0, code: 1, hsn: 2, gstRate: 3, uom: 4, purchasePrice: 5, sellPrice: 6, category: 7 })
    const body = { companyId: company.id, dataType: 'items', source: 'TALLY', fileName: p.fileName, table: p.table, headerRow: p.headerRow, mapping: p.suggestion.mapping }

    // Item type must be chosen explicitly when no type column is mapped
    expect((await post(preview, '/api/import-center/preview', user, body)).status).toBe(400)
    const withType = { ...body, options: { itemType: 'RAW' } }
    const pv = await post(preview, '/api/import-center/preview', user, withType)
    expect(pv.status).toBe(200)
    const rows = pv.json.data.rows as { line: number; status: string; messages: string[]; warnings: string[]; values: Record<string, string> }[]
    expect(rows.map((r) => r.status)).toEqual(['ready', 'ready', 'error', 'error', 'duplicate'])
    expect(rows[0].values).toMatchObject({ gstRate: '18', uom: 'KG', purchasePrice: '1250.50', sellPrice: '1400' })
    expect(rows[1].warnings.join(' ')).toContain('Purchase price is blank')
    expect(rows[2].messages.join(' ')).toContain('GST rate is blank')
    expect(rows[3].messages.join(' ')).toContain('Unit "Bucket"')
    expect(await db.item.count()).toBe(0)

    const done = await post(commit, '/api/import-center/commit', user, { ...withType, confirm: true })
    expect(done.json.data.counts).toMatchObject({ imported: 2, duplicates: 1, errors: 2 })
    const plate = await db.item.findFirstOrThrow({ where: { companyId: company.id, code: 'RM-PL10' } })
    expect(plate).toMatchObject({ name: 'MS Plate 10mm', hsn: '7208', gstRate: 18, uom: 'KG', purchasePrice: 1250.5, sellingPrice: 1400, category: 'Steel', type: 'RAW' })
    const labour = await db.item.findFirstOrThrow({ where: { companyId: company.id, name: 'Machining Labour' } })
    expect(labour).toMatchObject({ code: 'RM-001', uom: 'HRS', purchasePrice: 0 })
    // The "Opening Quantity" column is never imported: no stock movements at all
    expect(await db.stockLedger.count()).toBe(0)
    expect(await db.stockBalance.count()).toBe(0)
  })
})

describe('Import Center — validation of what the browser sends', () => {
  async function setup() {
    const t = await seedTenant()
    const up = await upload(t.user, t.company.id, 'customers', csv([['Name', 'City'], ['A Co', 'Pune']]), 'c.csv')
    return { ...t, base: { companyId: t.company.id, dataType: 'customers', table: up.json.data.table, headerRow: 0, mapping: { name: 0, city: 1 } } }
  }

  test('mapping must use known fields, real columns, each column once, and the required fields', async () => {
    const { user, base } = await setup()
    const bad = async (mapping: unknown) => (await post(preview, '/api/import-center/preview', user, { ...base, mapping })).json.error?.message
    expect(await bad({ name: 0, openingBalance: 1 })).toContain('Unknown field')
    expect(await bad({ name: 0, city: 7 })).toContain('not a column')
    expect(await bad({ name: 0, city: 0 })).toContain('both')
    expect(await bad({ city: 1 })).toContain('required')
    expect(await bad('name=0')).toContain('mapping must be')
    expect(await bad({ ['__proto__']: 0, name: 0 })).toContain('Unknown field')
  })

  test('tampered tables, header rows and unsupported data types are refused', async () => {
    const { user, base } = await setup()
    const status = async (extra: Record<string, unknown>) => (await post(preview, '/api/import-center/preview', user, { ...base, ...extra })).status
    expect(await status({ table: [{ line: 1, cells: [1, 2] }] })).toBe(400)
    expect(await status({ table: 'x' })).toBe(400)
    expect(await status({ table: Array.from({ length: 600 }, (_, i) => ({ line: i + 1, cells: ['x'] })) })).toBe(400)
    expect(await status({ headerRow: 5 })).toBe(400)
    expect(await status({ dataType: 'sales' })).toBe(400)
    expect(await status({ dataType: 'purchases' })).toBe(400)
    expect(await db.customer.count()).toBe(0)
  })

  test('formula-looking text cells are row errors', async () => {
    const { user, base } = await setup()
    const r = await post(preview, '/api/import-center/preview', user, { ...base, table: [{ line: 1, cells: ['Name', 'City'] }, { line: 2, cells: ['=HYPERLINK("http://x")', 'Pune'] }] })
    expect(r.json.data.rows[0].status).toBe('error')
    expect(r.json.data.rows[0].messages[0]).toContain('formula')
  })
})

describe('Import Center — limits', () => {
  test('more than 500 data rows, oversize uploads and unreadable files are refused at upload', async () => {
    const { company, user } = await seedTenant()
    const rows = [['Name'], ...Array.from({ length: 501 }, (_, i) => [`Party ${i}`])]
    expect((await upload(user, company.id, 'customers', csv(rows), 'many.csv')).json.error?.message).toContain('limit is 500')
    const big = await uploadRequest('/api/import-center/parse', { companyId: company.id, dataType: 'customers', file: { data: Buffer.alloc(3 * 1024 * 1024, 0x41), name: 'big.csv' } }, user)
    expect((await call(parse(big))).status).toBe(413)
    expect((await upload(user, company.id, 'customers', Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), 'x.xls')).status).toBe(400)
    const noLength = apiRequest('/api/import-center/parse', { method: 'POST', user })
    expect((await call(parse(noLength))).status).toBe(411)
  })

  test('only one import per company and data type runs at a time', async () => {
    let release!: () => void
    const first = withImportLock('c1:customers', () => new Promise<void>((r) => { release = r }))
    await expect(withImportLock('c1:customers', async () => 1)).rejects.toThrow('already running')
    expect(await withImportLock('c1:items', async () => 2)).toBe(2)
    release()
    await first
    expect(await withImportLock('c1:customers', async () => 3)).toBe(3)
  })
})

describe('Import Center — permissions and company isolation', () => {
  test('roles without Import Center access, or without write access to the data, are refused', async () => {
    const { company } = await seedTenant()
    for (const role of ['VIEWER', 'SALES_MANAGER', 'ACCOUNTANT', 'STORE_MANAGER']) {
      const u = await seedUser(company.id, role)
      const r = await upload(u, company.id, 'customers', csv([['Name'], ['A']]), 'c.csv')
      expect(r.status).toBe(403)
      const h = await call(history(apiRequest('/api/import-center/history', { user: u })))
      expect(h.status).toBe(403)
    }
    const anon = await call(preview(apiRequest('/api/import-center/preview', { body: { dataType: 'customers' } })))
    expect(anon.status).toBe(401)
  })

  test('a user cannot preview, import into or read the history of another company', async () => {
    const a = await seedTenant()
    const b = await seedTenant()
    const up = await upload(b.user, b.company.id, 'customers', csv([['Name'], ['Cross Tenant Co']]), 'c.csv')
    const body = { companyId: a.company.id, dataType: 'customers', table: up.json.data.table, headerRow: 0, mapping: { name: 0 }, confirm: true }
    expect((await post(preview, '/api/import-center/preview', b.user, body)).status).toBe(403)
    expect((await post(commit, '/api/import-center/commit', b.user, body)).status).toBe(403)
    expect((await upload(b.user, a.company.id, 'customers', csv([['Name'], ['X']]), 'c.csv')).status).toBe(403)
    const h = await call(history(apiRequest(`/api/import-center/history?companyId=${a.company.id}`, { user: b.user })))
    expect(h.status).toBe(403)
    expect(await db.customer.count({ where: { companyId: a.company.id } })).toBe(0)
    // Without an explicit companyId the import goes to the user's own company
    const own = await post(commit, '/api/import-center/commit', b.user, { ...body, companyId: undefined })
    expect(own.json.data.counts.imported).toBe(1)
    expect(await db.customer.count({ where: { companyId: b.company.id } })).toBe(1)
  })
})

describe('Import Center — failures during the import', () => {
  test('a database failure on one row is reported for that row only; no internals reach the browser', async () => {
    const { company, user } = await seedTenant()
    await db.$executeRawUnsafe("ALTER TABLE Customer ADD CONSTRAINT test_fail_customer CHECK (name <> 'Boom Traders')")
    try {
      const table = [{ line: 1, cells: ['Name'] }, { line: 2, cells: ['Good One'] }, { line: 3, cells: ['Boom Traders'] }, { line: 4, cells: ['Good Two'] }]
      const r = await post(commit, '/api/import-center/commit', user, { companyId: company.id, dataType: 'customers', table, headerRow: 0, mapping: { name: 0 }, confirm: true })
      expect(r.status).toBe(200)
      expect(r.json.data.counts).toMatchObject({ imported: 2, failed: 1 })
      const boom = r.json.data.rows.find((x: { line: number }) => x.line === 3)
      expect(boom).toMatchObject({ status: 'failed', messages: ['Failed to create customer'] })
      expect(JSON.stringify(r.json)).not.toContain('test_fail_customer')
      expect(await db.customer.count({ where: { companyId: company.id } })).toBe(2)
      const h = await db.auditLog.findFirstOrThrow({ where: { companyId: company.id, action: 'IMPORT' } })
      expect(h.details).toContain('2 imported, 0 skipped (duplicates), 1 failed')
    } finally {
      await db.$executeRawUnsafe('ALTER TABLE Customer DROP CHECK test_fail_customer')
    }
  })

  test('the plan item limit stops the whole batch before anything is written', async () => {
    const { company, user } = await seedTenant()
    await db.company.update({ where: { id: company.id }, data: { maxItems: 1 } })
    const table = [{ line: 1, cells: ['Item Name', 'GST Rate', 'Unit'] }, { line: 2, cells: ['A1', '18', 'Nos'] }, { line: 3, cells: ['B1', '18', 'Nos'] }]
    const r = await post(commit, '/api/import-center/commit', user, { companyId: company.id, dataType: 'items', table, headerRow: 0, mapping: { name: 0, gstRate: 1, uom: 2 }, options: { itemType: 'RAW' }, confirm: true })
    expect(r.status).toBe(403)
    expect(await db.item.count()).toBe(0)
  })
})
