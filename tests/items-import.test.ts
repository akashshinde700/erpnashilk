import { beforeEach, describe, expect, test } from 'bun:test'
import { db } from '@/lib/db'
import { POST as importItems } from '@/app/api/items/import/route'
import { apiRequest, call, type TestUser } from './helpers/api'
import { resetDb } from './helpers/db'
import { seedCompany, seedTenant, seedUser } from './helpers/seed'

beforeEach(resetDb)

type Row = Record<string, string>
const run = (user: TestUser, companyId: string, rows: Row[]) =>
  call(importItems(apiRequest('/api/items/import', { user, body: { companyId, rows } })))
const errorRows = (r: { json: { data?: { errors: { row: number }[] } } }) => r.json.data!.errors.map((e) => e.row)

describe('POST /api/items/import', () => {
  test('keeps HSN, GST rate, purchase price and category (and the existing columns)', async () => {
    const { company, user } = await seedTenant()
    const r = await run(user, company.id, [
      { code: 'rm-steel-1', name: 'Steel Rod 10mm', type: 'raw', uom: 'kg', hsn: '7214', gstRate: '18', purchasePrice: '110.5', category: 'Steel', standardCost: '120', sellPrice: '185', reorderLevel: '50', mrp: '', rack: 'A-01', brand: 'Tata' },
      { code: 'SV-1', name: 'Machining Labour', type: 'SERVICE', uom: 'HRS', hsn: '998898', gstRate: '5', status: 'inactive' },
      { code: 'CN-1', name: 'Cotton Waste', type: 'CONSUMABLE', uom: 'KG', gstRate: '0', altUom: 'bag', altFactor: '25', cessRate: '0', barcode: '8901' },
    ])
    expect(r.json.data).toMatchObject({ imported: 3, skipped: 0, errors: [] })
    const steel = await db.item.findFirstOrThrow({ where: { companyId: company.id, code: 'RM-STEEL-1' } })
    expect(steel).toMatchObject({ name: 'Steel Rod 10mm', type: 'RAW', uom: 'KG', hsn: '7214', gstRate: 18, purchasePrice: 110.5, category: 'Steel', standardCost: 120, sellingPrice: 185, reorderLevel: 50, mrp: null, rack: 'A-01', brand: 'Tata', status: 'ACTIVE' })
    const labour = await db.item.findFirstOrThrow({ where: { companyId: company.id, code: 'SV-1' } })
    expect(labour).toMatchObject({ hsn: '998898', gstRate: 5, status: 'INACTIVE' })
    const waste = await db.item.findFirstOrThrow({ where: { companyId: company.id, code: 'CN-1' } })
    expect(waste).toMatchObject({ gstRate: 0, altUom: 'BAG', altFactor: 25, barcode: '8901' })
  })

  test('a blank GST rate keeps the 18% default; invalid GST rates, types, units and numbers are row errors', async () => {
    const { company, user } = await seedTenant()
    const r = await run(user, company.id, [
      { code: 'A1', name: 'Default GST' },
      { code: 'A2', name: 'Bad GST text', gstRate: 'eighteen' },
      { code: 'A3', name: 'Bad GST range', gstRate: '150' },
      { code: 'A4', name: 'Bad type', type: 'GADGET' },
      { code: 'A5', name: 'Bad unit', uom: 'BUCKET' },
      { code: 'A6', name: 'Bad price', purchasePrice: '12abc' },
      { code: 'A7', name: 'Half alt unit', altUom: 'BOX' },
      { code: '', name: 'No code' },
    ])
    expect(r.json.data.imported).toBe(1)
    expect(errorRows(r)).toEqual([2, 3, 4, 5, 6, 7, 8])
    expect((await db.item.findFirstOrThrow({ where: { code: 'A1' } })).gstRate).toBe(18)
  })

  test('duplicates by code, barcode or same name (ignoring case/spaces/punctuation) are skipped — in the database and within the file', async () => {
    const { company, user } = await seedTenant()
    await db.item.create({ data: { companyId: company.id, code: 'OLD-1', name: 'MS Plate 10 mm', barcode: 'BC-1' } })
    const r = await run(user, company.id, [
      { code: 'old-1', name: 'Something new' },
      { code: 'N1', name: 'ms-plate 10MM' },
      { code: 'N2', name: 'Fresh item', barcode: 'BC-1' },
      { code: 'N3', name: 'Washer M10' },
      { code: 'N4', name: 'washer m-10' },
      { code: 'n3', name: 'Another' },
      { code: 'N5', name: 'Gasket', barcode: 'BC-2' },
      { code: 'N6', name: 'Seal', barcode: 'BC-2' },
    ])
    expect(r.json.data).toMatchObject({ imported: 2, skipped: 6 })
    expect(errorRows(r)).toEqual([1, 2, 3, 5, 6, 8])
    const codes = (await db.item.findMany({ where: { companyId: company.id }, orderBy: { code: 'asc' } })).map((i) => i.code)
    expect(codes).toEqual(['N3', 'N5', 'OLD-1'])
  })

  test('opening stock goes to the first warehouse as an OPENING movement at standard cost, else purchase price', async () => {
    const { company, user } = await seedTenant() // warehouse MAIN
    await db.warehouse.create({ data: { companyId: company.id, code: 'ZZZ', name: 'Later store' } })
    const r = await run(user, company.id, [
      { code: 'S1', name: 'Bearing 6205', standardCost: '40', purchasePrice: '35', openingStock: '12' },
      { code: 'S2', name: 'Bearing 6206', purchasePrice: '50', openingStock: '3' },
    ])
    expect(r.json.data.imported).toBe(2)
    const main = await db.warehouse.findFirstOrThrow({ where: { companyId: company.id, code: 'MAIN' } })
    const ledger = await db.stockLedger.findMany({ where: { companyId: company.id }, include: { item: true }, orderBy: { qtyIn: 'desc' } })
    expect(ledger.map((l) => [l.item.code, l.type, l.refType, l.qtyIn, l.rate, l.warehouseId])).toEqual([
      ['S1', 'OPENING', 'OPENING', 12, 40, main.id],
      ['S2', 'OPENING', 'OPENING', 3, 50, main.id],
    ])
    const bal = await db.stockBalance.findFirstOrThrow({ where: { item: { code: 'S1' } } })
    expect(bal).toMatchObject({ qty: 12, avgRate: 40, companyId: company.id })
  })

  test('opening stock without any warehouse is a row error, not a silent drop', async () => {
    const company = await seedCompany()
    const user = await seedUser(company.id)
    const r = await run(user, company.id, [{ code: 'S1', name: 'Bearing', openingStock: '5' }, { code: 'S2', name: 'No stock' }])
    expect(r.json.data.imported).toBe(1)
    expect(errorRows(r)).toEqual([1])
  })

  test('a failed stock posting leaves no partly-created item; the other rows still import', async () => {
    const { company, user } = await seedTenant()
    // Fault injection (test database only): the database rejects any stock ledger row of qty 7777,
    // so FAIL-ME's item insert succeeds and its opening-stock posting then fails.
    await db.$executeRawUnsafe('ALTER TABLE StockLedger ADD CONSTRAINT test_fail_opening CHECK (qtyIn <> 7777)')
    try {
      const r = await run(user, company.id, [
        { code: 'OK-1', name: 'Good before', openingStock: '2', standardCost: '1' },
        { code: 'FAIL-ME', name: 'Will fail', openingStock: '7777', standardCost: '1' },
        { code: 'OK-2', name: 'Good after', openingStock: '4', standardCost: '1' },
      ])
      expect(r.status).toBe(200)
      expect(await db.item.findFirst({ where: { code: 'FAIL-ME' } })).toBeNull()
      expect(r.json.data.imported).toBe(2)
      expect(errorRows(r)).toEqual([2])
      // internal database errors are not sent to the client
      expect(r.json.data.errors[0].message).not.toContain('test_fail_opening')
      expect(await db.stockBalance.count({ where: { companyId: company.id } })).toBe(2)
      expect(await db.stockLedger.count({ where: { companyId: company.id } })).toBe(2)
    } finally {
      await db.$executeRawUnsafe('ALTER TABLE StockLedger DROP CHECK test_fail_opening')
    }
  })

  test('the plan item limit counts the whole file before anything is created', async () => {
    const { company, user } = await seedTenant()
    await db.company.update({ where: { id: company.id }, data: { maxItems: 2 } })
    const r = await run(user, company.id, [{ code: 'A', name: 'A1' }, { code: 'B', name: 'B1' }, { code: 'C', name: 'C1' }])
    expect(r.status).toBe(403)
    expect(await db.item.count()).toBe(0)
  })

  test('writes one IMPORT audit summary', async () => {
    const { company, user } = await seedTenant()
    await run(user, company.id, [{ code: 'A', name: 'A1' }, { code: 'B', name: 'B1' }])
    const audit = await db.auditLog.findMany({ where: { companyId: company.id } })
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ action: 'IMPORT', entity: 'ITEM' })
  })

  test('rejects more than 500 rows, unauthorised roles and other tenants', async () => {
    const { company, user } = await seedTenant()
    expect((await run(user, company.id, Array.from({ length: 501 }, (_, i) => ({ code: `X${i}`, name: `Item ${i}` })))).status).toBe(400)
    const viewer = await seedUser(company.id, 'VIEWER')
    expect((await run(viewer, company.id, [{ code: 'A', name: 'A1' }])).status).toBe(403)
    const other = await seedTenant()
    expect((await run(other.user, company.id, [{ code: 'A', name: 'A1' }])).status).toBe(403)
    expect(await db.item.count()).toBe(0)
  })
})
