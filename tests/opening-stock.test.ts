import { beforeEach, describe, expect, test } from 'bun:test'
import { db } from '@/lib/db'
import { POST as createItem } from '@/app/api/items/route'
import { postOpeningStock } from '@/lib/services/opening-stock'
import { apiRequest, call } from './helpers/api'
import { resetDb } from './helpers/db'
import { seedTenant } from './helpers/seed'

beforeEach(resetDb)

describe('opening stock warehouse is checked against the active company', () => {
  test('POST /api/items with another company\'s warehouse is a 404 and writes nothing', async () => {
    const a = await seedTenant()
    const b = await seedTenant()
    const r = await call(createItem(apiRequest('/api/items', {
      user: a.user, body: { companyId: a.company.id, name: 'Bolt', openingQty: 50, openingRate: 2, openingWarehouseId: b.warehouse.id },
    })))
    expect(r.status).toBe(404)
    expect(await db.item.count()).toBe(0)
    expect(await db.stockLedger.count()).toBe(0)
    expect(await db.stockBalance.count()).toBe(0)
  })

  test('an unknown warehouse id is a 404', async () => {
    const a = await seedTenant()
    const r = await call(createItem(apiRequest('/api/items', {
      user: a.user, body: { companyId: a.company.id, name: 'Bolt', openingQty: 5, openingWarehouseId: 'does-not-exist' },
    })))
    expect(r.status).toBe(404)
    expect(await db.item.count()).toBe(0)
  })

  test('the company\'s own warehouse still works, and no warehouse means no opening stock (unchanged)', async () => {
    const a = await seedTenant()
    const ok = await call(createItem(apiRequest('/api/items', {
      user: a.user, body: { companyId: a.company.id, name: 'Bolt', openingQty: 5, openingRate: 2, openingWarehouseId: a.warehouse.id },
    })))
    expect(ok.status).toBe(200)
    expect(await db.stockBalance.count({ where: { companyId: a.company.id, warehouseId: a.warehouse.id } })).toBe(1)
    const none = await call(createItem(apiRequest('/api/items', { user: a.user, body: { companyId: a.company.id, name: 'Nut', openingQty: 5 } })))
    expect(none.status).toBe(200)
    expect(await db.stockLedger.count({ where: { itemId: none.json.data.id } })).toBe(0)
  })

  test('postOpeningStock itself refuses a foreign warehouse or item (defence in depth)', async () => {
    const a = await seedTenant()
    const b = await seedTenant()
    const item = await db.item.create({ data: { companyId: a.company.id, code: 'X1', name: 'X' } })
    const foreignItem = await db.item.create({ data: { companyId: b.company.id, code: 'Y1', name: 'Y' } })
    const input = { qty: 1, rate: 1, batchNo: 'OPENING', serials: [] as string[] }
    await expect(db.$transaction((tx) => postOpeningStock(tx, a.company.id, item.id, { ...input, warehouseId: b.warehouse.id }))).rejects.toThrow('warehouse not found')
    await expect(db.$transaction((tx) => postOpeningStock(tx, a.company.id, foreignItem.id, { ...input, warehouseId: a.warehouse.id }))).rejects.toThrow('Item not found')
    expect(await db.stockLedger.count()).toBe(0)
  })
})
