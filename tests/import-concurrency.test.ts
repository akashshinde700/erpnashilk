import { beforeEach, describe, expect, test } from 'bun:test'
import { db } from '@/lib/db'
import { importCustomers } from '@/lib/services/customer-import'
import { importSuppliers } from '@/lib/services/supplier-import'
import { importItems } from '@/lib/services/item-import'
import { importOpeningStock } from '@/lib/services/opening-stock-import'
import { resetDb } from './helpers/db'
import { seedTenant } from './helpers/seed'

/**
 * Two imports of the same data at the same time — as two server processes would run them (the
 * in-process lock of the routes is bypassed by calling the services directly). The company row lock
 * + re-check inside each write must leave exactly one record per name / item + warehouse.
 */

beforeEach(resetDb)

const rows = (data: Record<string, string>[]) => data.map((d, i) => ({ row: i + 2, data: d }))
const results = (r: Awaited<ReturnType<typeof importCustomers>>[]) =>
  r.flatMap((x) => x.results.map((y) => y.status)).sort()

describe('concurrent imports of the same data', () => {
  test('customers: each name is created once', async () => {
    const { company } = await seedTenant()
    const data = rows([{ name: 'Shree Traders' }, { name: 'Patel & Co' }, { name: 'Gujarat Bearings' }])
    const both = await Promise.all([importCustomers(company.id, data, { canWriteSuppliers: true }), importCustomers(company.id, data, { canWriteSuppliers: true })])
    expect(await db.customer.count({ where: { companyId: company.id } })).toBe(3)
    expect(both[0].imported + both[1].imported).toBe(3)
    expect(results(both).filter((s) => s === 'failed')).toEqual([])
  })

  test('suppliers: each name is created once', async () => {
    const { company } = await seedTenant()
    const data = rows([{ name: 'Tata Steel' }, { name: 'SK Bearings' }])
    const both = await Promise.all([importSuppliers(company.id, data), importSuppliers(company.id, data)])
    expect(await db.supplier.count({ where: { companyId: company.id } })).toBe(2)
    expect(both[0].imported + both[1].imported).toBe(2)
  })

  test('items: the same item (also spelled differently) is created once', async () => {
    const { company } = await seedTenant()
    const a = rows([{ code: 'RM-1', name: 'MS Plate 10mm', uom: 'KG', gstRate: '18' }])
    const b = rows([{ code: 'RM-2', name: 'ms-plate 10 MM', uom: 'KG', gstRate: '18' }])
    const both = await Promise.all([importItems(company.id, a), importItems(company.id, b)])
    expect(await db.item.count({ where: { companyId: company.id } })).toBe(1)
    expect(both[0].imported + both[1].imported).toBe(1)
    expect(both[0].skipped + both[1].skipped).toBe(1)
  })

  test('opening stock: an item + warehouse gets opening stock once', async () => {
    const { company, warehouse } = await seedTenant()
    const item = await db.item.create({ data: { companyId: company.id, code: 'RM-1', name: 'Bolt', uom: 'NOS' } })
    const goLive = new Date('2025-04-01')
    const data = rows([{ itemCode: item.code, qty: '10', rate: '2' }])
    const run = (ref: string) => importOpeningStock(company.id, data, { goLive, defaultWarehouseId: warehouse.id, importRef: ref })
    const both = await Promise.all([run('OSI-TEST-A'), run('OSI-TEST-B')])
    expect(await db.stockLedger.count({ where: { companyId: company.id, type: 'OPENING' } })).toBe(1)
    expect((await db.stockBalance.findFirstOrThrow({ where: { itemId: item.id } })).qty).toBe(10)
    expect(both[0].imported + both[1].imported).toBe(1)
  })
})
