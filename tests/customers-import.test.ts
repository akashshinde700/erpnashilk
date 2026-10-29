import { beforeEach, describe, expect, test } from 'bun:test'
import { db } from '@/lib/db'
import { POST as importCustomers } from '@/app/api/customers/import/route'
import { apiRequest, call, type TestUser } from './helpers/api'
import { resetDb } from './helpers/db'
import { seedTenant, seedUser } from './helpers/seed'

beforeEach(resetDb)

type Row = Record<string, string>
const run = (user: TestUser, companyId: string, rows: Row[]) =>
  call(importCustomers(apiRequest('/api/customers/import', { user, body: { companyId, rows } })))

describe('POST /api/customers/import', () => {
  test('uses the shared party validation: GSTIN derives state code, PAN and GST type; phone is normalised', async () => {
    const { company, user } = await seedTenant()
    const r = await run(user, company.id, [
      { name: 'Precision Tools', gstin: '27abcde1234f1z5', phone: '+91 98765 43210', city: 'Pune' },
      { name: 'Walk-in Retail' },
    ])
    expect(r.status).toBe(200)
    expect(r.json.data).toMatchObject({ imported: 2, skipped: 0, errors: [] })
    const c = await db.customer.findFirstOrThrow({ where: { companyId: company.id, name: 'Precision Tools' } })
    expect(c).toMatchObject({ gstin: '27ABCDE1234F1Z5', stateCode: '27', pan: 'ABCDE1234F', gstType: 'REGULAR', phone: '9876543210', city: 'Pune', status: 'ACTIVE' })
    const w = await db.customer.findFirstOrThrow({ where: { companyId: company.id, name: 'Walk-in Retail' } })
    expect(w.gstType).toBe('UNREGISTERED')
  })

  test('auto codes continue the C-0001 series used by the customer form', async () => {
    const { company, user } = await seedTenant()
    await db.customer.create({ data: { companyId: company.id, code: 'C-0007', name: 'Existing' } })
    const r = await run(user, company.id, [{ name: 'One' }, { name: 'Two', code: 'c-0008' }, { name: 'Three' }])
    expect(r.json.data.imported).toBe(3)
    const codes = (await db.customer.findMany({ where: { companyId: company.id }, orderBy: { code: 'asc' } })).map((c) => c.code)
    expect(codes).toEqual(['C-0007', 'C-0008', 'C-0009', 'C-0010'])
  })

  test('invalid rows are reported with their row number and nothing is created for them', async () => {
    const { company, user } = await seedTenant()
    const r = await run(user, company.id, [
      { name: 'Bad GSTIN', gstin: '27ABCDE1234F1Z' },
      { name: 'Bad Phone', phone: '12345' },
      { name: 'Registered no GSTIN', gstType: 'REGULAR' },
      { name: '' },
      { name: 'Good' },
    ])
    expect(r.status).toBe(200)
    expect(r.json.data.imported).toBe(1)
    const byRow = Object.fromEntries(r.json.data.errors.map((e: { row: number; message: string }) => [e.row, e.message]))
    expect(byRow[1]).toContain('GSTIN is not valid')
    expect(byRow[2]).toContain('10-digit')
    expect(byRow[3]).toContain('GSTIN is required')
    expect(byRow[4]).toContain('name is required')
    expect(await db.customer.count({ where: { companyId: company.id } })).toBe(1)
  })

  test('duplicate names (existing or within the file) and duplicate codes are skipped', async () => {
    const { company, user } = await seedTenant()
    await db.customer.create({ data: { companyId: company.id, code: 'K1', name: 'Acme Corp' } })
    const r = await run(user, company.id, [
      { name: 'acme corp' },
      { name: 'Fresh' },
      { name: 'FRESH' },
      { name: 'Other', code: 'k1' },
    ])
    expect(r.json.data).toMatchObject({ imported: 1, skipped: 3 })
    expect(await db.customer.count({ where: { companyId: company.id } })).toBe(2)
  })

  test('partyType BOTH creates a linked supplier with the same profile', async () => {
    const { company, user } = await seedTenant()
    await db.supplier.create({ data: { companyId: company.id, code: 'S-0003', name: 'Old Vendor' } })
    const r = await run(user, company.id, [{ name: 'Twin Traders', partyType: 'both', gstin: '24ABCDE1234F1Z5', city: 'Surat' }])
    expect(r.json.data).toMatchObject({ imported: 1, errors: [] })
    const c = await db.customer.findFirstOrThrow({ where: { companyId: company.id, name: 'Twin Traders' }, include: { supplier: true } })
    expect(c.code).toBe('C-0001')
    expect(c.supplier).toMatchObject({ code: 'S-0004', name: 'Twin Traders', gstin: '24ABCDE1234F1Z5', stateCode: '24', gstType: 'REGULAR', city: 'Surat' })
  })

  test('BOTH rows need suppliers write access; SUPPLIER-only rows are not accepted here', async () => {
    const { company } = await seedTenant()
    const sm = await seedUser(company.id, 'SALES_MANAGER') // customers yes, suppliers no
    const r = await run(sm, company.id, [{ name: 'Twin', partyType: 'BOTH' }, { name: 'Vendor', partyType: 'SUPPLIER' }, { name: 'Plain' }])
    expect(r.json.data.imported).toBe(1)
    expect(r.json.data.errors.map((e: { row: number }) => e.row)).toEqual([1, 2])
    expect(await db.supplier.count({ where: { companyId: company.id } })).toBe(0)
  })

  test('a BOTH row whose name already exists as a supplier is skipped', async () => {
    const { company, user } = await seedTenant()
    await db.supplier.create({ data: { companyId: company.id, code: 'S-0001', name: 'Shared Name' } })
    const r = await run(user, company.id, [{ name: 'Shared Name', partyType: 'BOTH' }])
    expect(r.json.data).toMatchObject({ imported: 0, skipped: 1 })
    expect(await db.customer.count({ where: { companyId: company.id } })).toBe(0)
  })

  test('opening balances are not imported through this endpoint', async () => {
    const { company, user } = await seedTenant()
    await run(user, company.id, [{ name: 'Debtor', openingBalance: '5000', creditLimit: '100' } as Row])
    const c = await db.customer.findFirstOrThrow({ where: { companyId: company.id } })
    expect(c.openingBalance).toBe(0)
    expect(c.creditLimit).toBe(0)
  })

  test('writes one IMPORT audit summary, not one row per customer', async () => {
    const { company, user } = await seedTenant()
    await run(user, company.id, [{ name: 'A' }, { name: 'B' }])
    const audit = await db.auditLog.findMany({ where: { companyId: company.id } })
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ action: 'IMPORT', entity: 'CUSTOMER' })
  })

  test('rejects more than 500 rows, unauthorised roles and other tenants', async () => {
    const { company, user } = await seedTenant()
    const many = Array.from({ length: 501 }, (_, i) => ({ name: `P${i}` }))
    expect((await run(user, company.id, many)).status).toBe(400)
    const viewer = await seedUser(company.id, 'VIEWER')
    expect((await run(viewer, company.id, [{ name: 'X' }])).status).toBe(403)
    const other = await seedTenant()
    expect((await run(other.user, company.id, [{ name: 'X' }])).status).toBe(403)
    expect(await db.customer.count()).toBe(0)
  })
})
