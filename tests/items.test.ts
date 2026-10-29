import { beforeEach, describe, expect, test } from 'bun:test'
import { db } from '@/lib/db'
import { POST as createItem } from '@/app/api/items/route'
import { apiRequest, call, type TestUser } from './helpers/api'
import { resetDb } from './helpers/db'
import { seedTenant, seedUser } from './helpers/seed'

beforeEach(resetDb)

const post = (user: TestUser, body: Record<string, unknown>) => call(createItem(apiRequest('/api/items', { user, body })))

describe('POST /api/items', () => {
  test('creates an item with the type-prefixed next code and all master fields', async () => {
    const { company, user } = await seedTenant()
    const r = await post(user, {
      companyId: company.id, name: 'MS Plate 10mm', type: 'RAW', uom: 'kg', hsn: '7208', gstRate: '12', purchasePrice: '64.5',
      sellingPrice: 80, standardCost: 60, category: 'Steel', altUom: 'bundle', altFactor: 25, mrp: '90', barcode: '890100', brand: ' Tata ',
    })
    expect(r.status).toBe(200)
    expect(r.json.data).toMatchObject({
      code: 'RM-001', name: 'MS Plate 10mm', uom: 'KG', hsn: '7208', gstRate: 12, purchasePrice: 64.5, sellingPrice: 80,
      standardCost: 60, category: 'Steel', altUom: 'BUNDLE', altFactor: 25, mrp: 90, barcode: '890100', brand: 'Tata', status: 'ACTIVE',
    })
    const second = await post(user, { companyId: company.id, name: 'Gear Box', type: 'FINISHED' })
    expect(second.json.data.code).toBe('FG-001')
    const audit = await db.auditLog.count({ where: { companyId: company.id, entity: 'Item', action: 'CREATE' } })
    expect(audit).toBe(2)
  })

  test('the same name ignoring case/spaces/punctuation is a 409, as is a reused barcode', async () => {
    const { company, user } = await seedTenant()
    await post(user, { companyId: company.id, name: 'MS Plate 10 mm', barcode: 'B1' })
    expect((await post(user, { companyId: company.id, name: 'ms-plate 10MM' })).status).toBe(409)
    expect((await post(user, { companyId: company.id, name: 'Other', barcode: 'B1' })).status).toBe(409)
    expect(await db.item.count()).toBe(1)
  })

  test('opening stock posts an OPENING ledger row and balance at openingRate (else purchase price)', async () => {
    const { company, user, warehouse } = await seedTenant()
    const r = await post(user, { companyId: company.id, name: 'Bolt M8', purchasePrice: 5, openingQty: 100, openingWarehouseId: warehouse.id })
    expect(r.status).toBe(200)
    const ledger = await db.stockLedger.findMany({ where: { itemId: r.json.data.id } })
    expect(ledger).toHaveLength(1)
    expect(ledger[0]).toMatchObject({ type: 'OPENING', refType: 'OPENING', qtyIn: 100, rate: 5, warehouseId: warehouse.id, companyId: company.id })
    const bal = await db.stockBalance.findFirstOrThrow({ where: { itemId: r.json.data.id } })
    expect(bal).toMatchObject({ qty: 100, avgRate: 5 })

    const r2 = await post(user, { companyId: company.id, name: 'Nut M8', purchasePrice: 5, openingQty: 10, openingRate: 7, openingWarehouseId: warehouse.id })
    expect((await db.stockLedger.findFirstOrThrow({ where: { itemId: r2.json.data.id } })).rate).toBe(7)
  })

  test('opening stock of a batch-tracked item creates the batch', async () => {
    const { company, user, warehouse } = await seedTenant()
    const r = await post(user, {
      companyId: company.id, name: 'Resin', batchTracked: true, openingQty: 20, openingRate: 3, openingWarehouseId: warehouse.id,
      openingBatchNo: 'LOT-9', openingExpiry: '2030-01-31',
    })
    expect(r.status).toBe(200)
    const batch = await db.itemBatch.findFirstOrThrow({ where: { itemId: r.json.data.id } })
    expect(batch).toMatchObject({ batchNo: 'LOT-9', qty: 20, warehouseId: warehouse.id })
  })

  test('opening stock of a serial-tracked item needs exactly one serial per unit, else nothing is saved', async () => {
    const { company, user, warehouse } = await seedTenant()
    const bad = await post(user, { companyId: company.id, name: 'Drill', trackSerial: true, openingQty: 2, openingWarehouseId: warehouse.id, openingSerials: 'SN1' })
    expect(bad.status).toBe(400)
    expect(await db.item.count()).toBe(0)
    expect(await db.stockLedger.count()).toBe(0)
    const good = await post(user, { companyId: company.id, name: 'Drill', trackSerial: true, openingQty: 2, openingWarehouseId: warehouse.id, openingSerials: 'SN1\nSN2' })
    expect(good.status).toBe(200)
    expect(await db.itemSerial.count({ where: { itemId: good.json.data.id, status: 'IN_STOCK' } })).toBe(2)
  })

  test('respects the plan item limit, write permission and tenant', async () => {
    const { company, user } = await seedTenant()
    await db.company.update({ where: { id: company.id }, data: { maxItems: 1 } })
    expect((await post(user, { companyId: company.id, name: 'First' })).status).toBe(200)
    expect((await post(user, { companyId: company.id, name: 'Second' })).status).toBe(403)
    const viewer = await seedUser(company.id, 'VIEWER')
    expect((await post(viewer, { companyId: company.id, name: 'V' })).status).toBe(403)
    const other = await seedTenant()
    expect((await post(other.user, { companyId: company.id, name: 'Intruder' })).status).toBe(403)
    expect(await db.item.count({ where: { companyId: company.id } })).toBe(1)
  })

  test('invalid numbers and secondary units are 400s', async () => {
    const { company, user } = await seedTenant()
    expect((await post(user, { companyId: company.id, name: 'A', gstRate: 'abc' })).status).toBe(400)
    expect((await post(user, { companyId: company.id, name: 'B', altUom: 'BOX' })).status).toBe(400)
    expect((await post(user, { companyId: company.id, name: 'C', mrp: -1 })).status).toBe(400)
    expect((await post(user, { companyId: company.id, name: 'D', cessRate: 101 })).status).toBe(400)
    expect((await post(user, { companyId: company.id, name: '' })).status).toBe(400)
    expect(await db.item.count()).toBe(0)
  })
})
