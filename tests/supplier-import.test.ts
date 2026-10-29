import { beforeEach, describe, expect, test } from 'bun:test'
import { db } from '@/lib/db'
import { POST as parse } from '@/app/api/import-center/parse/route'
import { POST as preview } from '@/app/api/import-center/preview/route'
import { POST as commit } from '@/app/api/import-center/commit/route'
import { GET as history } from '@/app/api/import-center/history/route'
import { apiRequest, call, uploadRequest, type TestUser } from './helpers/api'
import { resetDb } from './helpers/db'
import { csv, makeXlsx } from './helpers/files'
import { seedTenant, seedUser } from './helpers/seed'

beforeEach(resetDb)

type Row = { line: number; status: string; messages: string[]; warnings: string[]; values: Record<string, string>; code?: string }

const upload = async (user: TestUser, companyId: string, data: string | Uint8Array, name: string) =>
  call(parse(await uploadRequest('/api/import-center/parse', { companyId, dataType: 'suppliers', file: { data: typeof data === 'string' ? Buffer.from(data) : data, name } }, user)))

async function prepare(user: TestUser, companyId: string, data: string | Uint8Array, name = 'suppliers.csv') {
  const up = await upload(user, companyId, data, name)
  expect(up.status).toBe(200)
  const p = up.json.data
  return { companyId, dataType: 'suppliers', source: 'TALLY', fileName: p.fileName, table: p.table, headerRow: p.headerRow, mapping: p.suggestion.mapping }
}
const run = (handler: typeof preview, user: TestUser, body: Record<string, unknown>) => call(handler(apiRequest('/api/import-center/x', { user, body })))
const byName = (rows: Row[]) => Object.fromEntries(rows.map((r) => [r.values.name, r]))

describe('Supplier import — end to end', () => {
  test('aliases, party validation, bank / credit fields, preview without writes, confirm, history', async () => {
    const { company, user } = await seedTenant()
    const file = csv([
      ['Vendor Name', 'GST No', 'Mobile', 'City', 'State', 'IFSC Code', 'Account No', 'Credit Days', 'Closing Balance'],
      ['Tata Steel Processing', '27AAACT9876M1ZR', '+91 98221 66666', 'Navi Mumbai', 'Maharashtra', 'hdfc0001234', '50100123456789', '45', '12000 Cr'],
      ['Gujarat Copper', '', '', 'Ahmedabad', 'Gujarat', '', '', '', ''],
    ])
    const body = await prepare(user, company.id, file)
    expect(body.mapping).toEqual({ name: 0, gstin: 1, phone: 2, city: 3, state: 4, bankIfsc: 5, bankAccountNo: 6, paymentTermsDays: 7 })

    const pv = await run(preview, user, body)
    expect(pv.status).toBe(200)
    expect(pv.json.data.counts).toMatchObject({ total: 2, ready: 2 })
    expect(await db.supplier.count()).toBe(0)
    expect(await db.auditLog.count()).toBe(0)

    expect((await run(commit, user, body)).status).toBe(400) // no confirm → no write
    const done = await run(commit, user, { ...body, confirm: true })
    expect(done.json.data.counts).toMatchObject({ imported: 2, duplicates: 0, errors: 0, failed: 0 })
    const tata = await db.supplier.findFirstOrThrow({ where: { companyId: company.id, name: 'Tata Steel Processing' } })
    expect(tata).toMatchObject({
      code: 'S-0001', gstin: '27AAACT9876M1ZR', stateCode: '27', pan: 'AAACT9876M', gstType: 'REGULAR', phone: '9822166666',
      bankIfsc: 'HDFC0001234', bankAccountNo: '50100123456789', paymentTermsDays: 45, openingBalance: 0,
    })
    expect((await db.supplier.findFirstOrThrow({ where: { name: 'Gujarat Copper' } })).stateCode).toBe('24')
    expect(await db.customer.count()).toBe(0) // suppliers never create customers

    const h = await call(history(apiRequest('/api/import-center/history', { user })))
    expect(h.json.data.items[0]).toMatchObject({ entity: 'SUPPLIER' })
    expect(h.json.data.items[0].details).toContain('Suppliers from Tally')
  })

  test('works from .xlsx too', async () => {
    const { company, user } = await seedTenant()
    const body = await prepare(user, company.id, makeXlsx({ Creditors: [['Sundry Creditors'], ['Party Name', 'GSTIN/UIN'], ['SK Bearings Co.', '07AAECS1122O1ZV']] }), 'creditors.xlsx')
    const done = await run(commit, user, { ...body, confirm: true })
    expect(done.json.data.counts.imported).toBe(1)
    expect((await db.supplier.findFirstOrThrow({ where: { companyId: company.id } })).stateCode).toBe('07')
  })
})

describe('Supplier import — duplicates and "Both" parties', () => {
  test('existing suppliers, the supplier half of a Both party, in-file names and codes are skipped', async () => {
    const { company, user } = await seedTenant()
    const both = await db.supplier.create({ data: { companyId: company.id, code: 'S-0007', name: 'Twin Traders' } })
    await db.customer.create({ data: { companyId: company.id, code: 'C-0003', name: 'Twin Traders', supplierId: both.id } })
    await db.supplier.create({ data: { companyId: company.id, code: 'S-0008', name: 'Old Vendor' } })
    const body = await prepare(user, company.id, csv([
      ['Supplier Name', 'Supplier Code'],
      ['TWIN TRADERS', ''],
      ['old vendor', ''],
      ['New Vendor', ''],
      ['new vendor', ''],
      ['Coded Vendor', 's-0008'],
      ['Another', 'X1'],
      ['Yet Another', 'x1'],
    ]))
    const rows = byName((await run(preview, user, body)).json.data.rows)
    expect(rows['TWIN TRADERS']).toMatchObject({ status: 'duplicate' })
    expect(rows['TWIN TRADERS'].messages[0]).toContain('"Both" party with customer C-0003')
    expect(rows['old vendor'].status).toBe('duplicate')
    expect(rows['New Vendor']).toMatchObject({ status: 'ready', code: 'S-0009' })
    expect(rows['new vendor'].status).toBe('duplicate')
    expect(rows['Coded Vendor'].status).toBe('duplicate')
    expect(rows['Another'].status).toBe('ready')
    expect(rows['Yet Another'].status).toBe('duplicate')

    const done = await run(commit, user, { ...body, confirm: true })
    expect(done.json.data.counts).toMatchObject({ imported: 2, duplicates: 5 })
    expect(await db.supplier.count({ where: { companyId: company.id, name: { in: ['Twin Traders', 'TWIN TRADERS'] } } })).toBe(1)
    // Re-importing the same file creates nothing
    const again = await run(commit, user, { ...body, confirm: true })
    expect(again.json.data.counts.imported).toBe(0)
    expect(await db.supplier.count({ where: { companyId: company.id } })).toBe(4)
  })

  test('a customer-only party with the same name is created as a supplier with a warning, not linked silently', async () => {
    const { company, user } = await seedTenant()
    const cust = await db.customer.create({ data: { companyId: company.id, code: 'C-0001', name: 'Shakti Pumps', city: 'Ahmedabad' } })
    const body = await prepare(user, company.id, csv([['Supplier Name', 'City'], ['Shakti Pumps', 'Indore']]))
    const row = (await run(preview, user, body)).json.data.rows[0] as Row
    expect(row.status).toBe('ready')
    expect(row.warnings.join(' ')).toContain('A customer named Shakti Pumps exists (C-0001)')
    await run(commit, user, { ...body, confirm: true })
    expect(await db.supplier.count({ where: { companyId: company.id, name: 'Shakti Pumps' } })).toBe(1)
    expect(await db.customer.findUniqueOrThrow({ where: { id: cust.id } })).toMatchObject({ supplierId: null, city: 'Ahmedabad' })
  })

  test('a GSTIN already on another supplier is a warning (branches), not a block', async () => {
    const { company, user } = await seedTenant()
    await db.supplier.create({ data: { companyId: company.id, code: 'S-0001', name: 'Copperfield Pune', gstin: '24AAJCC5566N1ZT' } })
    const body = await prepare(user, company.id, csv([['Supplier Name', 'GSTIN'], ['Copperfield Ahmedabad', '24AAJCC5566N1ZT'], ['Copperfield Surat', '24AAJCC5566N1ZT']]))
    const rows = (await run(preview, user, body)).json.data.rows as Row[]
    expect(rows.map((r) => r.status)).toEqual(['ready', 'ready'])
    expect(rows[0].warnings[0]).toContain('also on supplier S-0001 Copperfield Pune')
    expect(rows[1].warnings[0]).toContain('also on supplier S-0001 Copperfield Pune')
  })
})

describe('Supplier import — validation', () => {
  test('invalid GSTIN, IFSC, account number, credit days and phone are row errors', async () => {
    const { company, user } = await seedTenant()
    const body = await prepare(user, company.id, csv([
      ['Supplier Name', 'GSTIN', 'IFSC', 'Account No', 'Credit Days', 'Phone'],
      ['Bad GSTIN', '27AAACT9876', '', '', '', ''],
      ['Bad IFSC', '', 'HDFC1234', '', '', ''],
      ['Bad Account', '', '', '12ab', '', ''],
      ['Bad Days', '', '', '', 'thirty', ''],
      ['Bad Phone', '', '', '', '', '123'],
      ['Fine', '', '', '', '', ''],
    ]))
    const rows = byName((await run(preview, user, body)).json.data.rows)
    expect(rows['Bad GSTIN'].messages[0]).toContain('GSTIN is not valid')
    expect(rows['Bad IFSC'].messages[0]).toContain('IFSC')
    expect(rows['Bad Account'].messages[0]).toContain('account number')
    expect(rows['Bad Days'].messages[0]).toContain('Credit days')
    expect(rows['Bad Phone'].messages[0]).toContain('10-digit')
    expect(rows['Fine'].status).toBe('ready')
    expect((await run(commit, user, { ...body, confirm: true })).json.data.counts).toMatchObject({ imported: 1, errors: 5 })
    expect(await db.supplier.count()).toBe(1)
  })

  test('opening balance columns are recognised but not mapped or imported', async () => {
    const { company, user } = await seedTenant()
    const up = await upload(user, company.id, csv([['Supplier Name', 'Opening Balance', 'Credit Limit'], ['A Co', '5000', '100']]), 's.csv')
    expect(up.json.data.suggestion.mapping).toEqual({ name: 0 })
    expect(up.json.data.suggestion.notImported.map((n: { header: string }) => n.header)).toEqual(['Opening Balance', 'Credit Limit'])
    const body = { companyId: company.id, dataType: 'suppliers', table: up.json.data.table, headerRow: 0, mapping: { name: 0, openingBalance: 1 } }
    expect((await run(preview, user, body)).json.error?.message).toContain('Unknown field')
  })
})

describe('Supplier import — authorization and company isolation', () => {
  test('roles without Import Center access are refused, even with supplier rights', async () => {
    const { company } = await seedTenant()
    for (const role of ['PURCHASE_MANAGER', 'PURCHASE_EXECUTIVE', 'SALES_MANAGER', 'VIEWER']) {
      const u = await seedUser(company.id, role)
      expect((await upload(u, company.id, csv([['Supplier Name'], ['A']]), 's.csv')).status).toBe(403)
      expect((await run(commit, u, { companyId: company.id, dataType: 'suppliers', table: [{ line: 1, cells: ['Name'] }, { line: 2, cells: ['A'] }], headerRow: 0, mapping: { name: 0 }, confirm: true })).status).toBe(403)
    }
    expect(await db.supplier.count()).toBe(0)
  })

  test('cannot import suppliers into another company; duplicates are checked per company', async () => {
    const a = await seedTenant()
    const b = await seedTenant()
    await db.supplier.create({ data: { companyId: a.company.id, code: 'S-0001', name: 'Shared Name' } })
    const body = await prepare(b.user, b.company.id, csv([['Supplier Name'], ['Shared Name']]))
    expect((await run(commit, b.user, { ...body, companyId: a.company.id, confirm: true })).status).toBe(403)
    // In its own company the same name is not a duplicate of company A's supplier
    const own = await run(commit, b.user, { ...body, confirm: true })
    expect(own.json.data.counts.imported).toBe(1)
    expect(await db.supplier.count({ where: { companyId: a.company.id } })).toBe(1)
  })
})

describe('Supplier import — partial failures', () => {
  test('a database failure on one row fails only that row and is reported without internals', async () => {
    const { company, user } = await seedTenant()
    await db.$executeRawUnsafe("ALTER TABLE Supplier ADD CONSTRAINT test_fail_supplier CHECK (name <> 'Boom Vendor')")
    try {
      const table = [{ line: 1, cells: ['Name'] }, { line: 2, cells: ['Good Vendor'] }, { line: 3, cells: ['Boom Vendor'] }, { line: 4, cells: ['Fine Vendor'] }]
      const r = await run(commit, user, { companyId: company.id, dataType: 'suppliers', table, headerRow: 0, mapping: { name: 0 }, confirm: true })
      expect(r.json.data.counts).toMatchObject({ imported: 2, failed: 1 })
      expect(r.json.data.rows[1]).toMatchObject({ status: 'failed', messages: ['Failed to create supplier'] })
      expect(JSON.stringify(r.json)).not.toContain('test_fail_supplier')
      expect(await db.supplier.count({ where: { companyId: company.id } })).toBe(2)
    } finally {
      await db.$executeRawUnsafe('ALTER TABLE Supplier DROP CHECK test_fail_supplier')
    }
  })
})
