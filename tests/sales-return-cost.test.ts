import { afterEach, beforeEach, describe, expect, setSystemTime, test } from 'bun:test'
import { db } from '@/lib/db'
import { endOfDayStr, positionAsOf, profitAndLoss } from '@/lib/accounting'
import { POST as createSalesInvoice } from '@/app/api/sales-invoices/route'
import { PATCH as patchSalesInvoice } from '@/app/api/sales-invoices/[id]/route'
import { POST as createPurchaseInvoice } from '@/app/api/purchase-invoices/route'
import { POST as createSalesReturn } from '@/app/api/sales-returns/route'
import { PATCH as patchSalesReturn } from '@/app/api/sales-returns/[id]/route'
import { POST as createSalesOrder } from '@/app/api/sales-orders/route'
import { POST as createDelivery } from '@/app/api/deliveries/route'
import { PATCH as patchDelivery } from '@/app/api/deliveries/[id]/route'
import { apiRequest, call, ctx } from './helpers/api'
import { resetDb } from './helpers/db'
import { seedTenant } from './helpers/seed'

/**
 * AC-B1: sales returns re-enter goods at the ORIGINAL inventory cost of the sale (weighted average at the moment the
 * goods left, stored on the outward stock row as `costRate`; rebuilt from the ledger for rows written before that).
 * Synthetic data on the guarded test database; fixed system time.
 */

const NOW = new Date('2026-06-01T06:00:00Z')

async function setup() {
  const t = await seedTenant()
  const c = t.company.id
  const [customer, supplier, item, whB] = await Promise.all([
    db.customer.create({ data: { companyId: c, code: 'C-1', name: 'Test Customer' } }),
    db.supplier.create({ data: { companyId: c, code: 'S-1', name: 'Test Supplier' } }),
    db.item.create({ data: { companyId: c, code: 'FG-1', name: 'Test Part', uom: 'NOS' } }),
    db.warehouse.create({ data: { companyId: c, code: 'B', name: 'B store', type: 'GENERAL' } }),
  ])
  const whA = t.warehouse.id
  const send = async (handler: (r: Request) => Promise<Response>, path: string, body: Record<string, unknown>) =>
    call(handler(apiRequest(path, { user: t.user, body: { companyId: c, ...body } })))
  const ok = async (handler: (r: Request) => Promise<Response>, path: string, body: Record<string, unknown>) => {
    const r = await send(handler, path, body)
    expect([path, r.status, r.json.error?.message]).toEqual([path, 200, undefined])
    return r.json.data
  }
  const buy = (qty: number, rate: number, warehouseId = whA, date = '2026-05-02') =>
    ok(createPurchaseInvoice, '/api/purchase-invoices', { supplierId: supplier.id, date, lines: [{ itemId: item.id, qty, rate, gstRate: 0 }], receiveStock: true, warehouseId })
  const sell = (qty: number, rate: number, extra: Record<string, unknown> = {}) =>
    ok(createSalesInvoice, '/api/sales-invoices', { customerId: customer.id, date: '2026-05-03', lines: [{ itemId: item.id, qty, rate, discountPct: 0, gstRate: 0 }], deductStock: true, stockWarehouseId: whA, ...extra })
  const lineOf = async (invoiceId: string) => (await db.salesInvoiceItem.findFirstOrThrow({ where: { invoiceId } })).id
  const ret = async (invoiceId: string, qty: number, extra: Record<string, unknown> = {}) =>
    send(createSalesReturn, '/api/sales-returns', { invoiceId, date: '2026-05-10', lines: [{ invoiceItemId: await lineOf(invoiceId), qty }], ...extra })
  const bal = (warehouseId = whA) => db.stockBalance.findUnique({ where: { itemId_warehouseId: { itemId: item.id, warehouseId } }, select: { qty: true, avgRate: true } })
  const rows = (type: string) => db.stockLedger.findMany({ where: { companyId: c, itemId: item.id, type }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  return { t, c, customer, supplier, item, whA, whB: whB.id, send, ok, buy, sell, ret, bal, rows }
}

beforeEach(async () => { setSystemTime(NOW); await resetDb() })
afterEach(() => { setSystemTime() })

describe('original sale cost', () => {
  test('the sale stock row keeps the selling price in rate and stores the inventory cost in costRate', async () => {
    const s = await setup()
    await s.buy(10, 100)
    await s.sell(3, 250)
    const [out] = await s.rows('SALE_OUT')
    expect([out.qtyOut, out.rate, out.costRate]).toEqual([3, 250, 100])
    // stock-in rows carry no cost of their own
    expect((await s.rows('PURCHASE_IN'))[0].costRate).toBeNull()
  })

  test('weighted average: goods return at the average when sold — not today\'s average, not the selling price', async () => {
    const s = await setup()
    await s.buy(10, 100)
    await s.buy(10, 200) // average 150
    const inv = await s.sell(5, 500)
    await s.buy(10, 300) // average now (15 × 150 + 10 × 300) / 25 = 210
    expect((await s.bal())?.avgRate).toBe(210)
    const r = await s.ret(inv.id, 2)
    expect([r.status, r.json.data.stockReturned]).toEqual([200, true])
    const [back] = await s.rows('SALES_RETURN_IN')
    expect([back.qtyIn, back.rate]).toEqual([2, 150])
    expect(await s.bal()).toEqual({ qty: 27, avgRate: 205.56 }) // (25 × 210 + 2 × 150) / 27
  })
})

describe('partial and repeated returns', () => {
  test('partial returns all come back at the original cost; P&L shows no profit and no cost once everything is back', async () => {
    const s = await setup()
    await s.buy(10, 100)
    const inv = await s.sell(5, 200)
    expect((await s.ret(inv.id, 2)).status).toBe(200)
    expect((await s.ret(inv.id, 3)).status).toBe(200)
    expect((await s.rows('SALES_RETURN_IN')).map((r) => [r.qtyIn, r.rate])).toEqual([[2, 100], [3, 100]])
    expect(await s.bal()).toEqual({ qty: 10, avgRate: 100 })
    const pl = await profitAndLoss(s.c, new Date('2026-04-01'), endOfDayStr('2026-05-31'))
    expect({ salesNet: pl.sales.net, cogs: pl.cogs, gross: pl.grossProfit, closing: pl.closingStock }).toEqual({ salesNet: 0, cogs: 0, gross: 0, closing: 1000 })
  })

  test('returning more than was sold is refused — one after another and at the same moment', async () => {
    const s = await setup()
    await s.buy(10, 100)
    const inv = await s.sell(5, 200)
    expect((await s.ret(inv.id, 4)).status).toBe(200)
    const again = await s.ret(inv.id, 2)
    expect([again.status, again.json.error?.message]).toEqual([400, 'Return qty 2 exceeds what can still be returned on a line (invoiced 5, returnable 1)'])

    const inv2 = await s.sell(5, 200)
    const both = await Promise.all([s.ret(inv2.id, 3), s.ret(inv2.id, 3)])
    expect(both.map((r) => r.status).sort()).toEqual([200, 400])
    expect(await s.bal()).toEqual({ qty: 7, avgRate: 100 }) // 10 − 5 sold + 4 back − 5 sold + 3 back
  })
})

describe('cost history: edits, cancels and several stock movements', () => {
  test('an edited invoice is reversed at its original cost; a later return uses the re-posted sale\'s cost', async () => {
    const s = await setup()
    await s.buy(10, 100)
    const inv = await s.sell(2, 300)
    await s.buy(10, 400) // average (8 × 100 + 10 × 400) / 18 = 266.67
    const edit = await call(patchSalesInvoice(apiRequest(`/api/sales-invoices/${inv.id}`, { method: 'PATCH', user: s.t.user, body: { companyId: s.c, action: 'edit', customerId: s.customer.id, date: '2026-05-03', lines: [{ itemId: s.item.id, qty: 3, rate: 300, discountPct: 0, gstRate: 0 }] } }), ctx({ id: inv.id })))
    expect([edit.status, edit.json.error?.message]).toEqual([200, undefined])
    const [cancelIn] = await s.rows('SALE_CANCEL_IN')
    expect([cancelIn.qtyIn, cancelIn.rate]).toEqual([2, 100]) // back at the cost it left at, not 266.67
    const outs = await s.rows('SALE_OUT')
    const live = outs[outs.length - 1]
    expect(live.qtyOut).toBe(3)
    expect(live.costRate).toBe(250) // (18 × 266.67 + 2 × 100) / 20, rounded
    expect((await s.ret(inv.id, 1)).status).toBe(200)
    expect((await s.rows('SALES_RETURN_IN'))[0].rate).toBe(live.costRate!)
  })

  test('a cancelled invoice puts its goods back at the original cost', async () => {
    const s = await setup()
    await s.buy(10, 100)
    const inv = await s.sell(4, 300)
    await s.buy(10, 300)
    const r = await call(patchSalesInvoice(apiRequest(`/api/sales-invoices/${inv.id}`, { method: 'PATCH', user: s.t.user, body: { companyId: s.c, action: 'cancel' } }), ctx({ id: inv.id })))
    expect(r.status).toBe(200)
    expect((await s.rows('SALE_CANCEL_IN')).map((x) => [x.qtyIn, x.rate])).toEqual([[4, 100]])
    expect(await s.bal()).toEqual({ qty: 20, avgRate: 200 }) // 10 × 100 + 10 × 300
  })

  test('an invoice with two lines of the same item: one cost for the item, returns on each line at that cost', async () => {
    const s = await setup()
    await s.buy(10, 100)
    await s.buy(10, 200)
    const inv = await s.ok(createSalesInvoice, '/api/sales-invoices', {
      customerId: s.customer.id, date: '2026-05-03', deductStock: true, stockWarehouseId: s.whA,
      lines: [{ itemId: s.item.id, qty: 2, rate: 400, discountPct: 0, gstRate: 0 }, { itemId: s.item.id, qty: 3, rate: 450, discountPct: 0, gstRate: 0 }],
    })
    expect((await s.rows('SALE_OUT')).map((x) => x.costRate)).toEqual([150, 150])
    const lines = await db.salesInvoiceItem.findMany({ where: { invoiceId: inv.id }, orderBy: { qty: 'asc' } })
    const r = await s.send(createSalesReturn, '/api/sales-returns', { invoiceId: inv.id, date: '2026-05-10', lines: [{ invoiceItemId: lines[0].id, qty: 1 }, { invoiceItemId: lines[1].id, qty: 2 }] })
    expect(r.status).toBe(200)
    expect((await s.rows('SALES_RETURN_IN')).map((x) => [x.qtyIn, x.rate])).toEqual([[1, 150], [2, 150]])
  })
})

describe('legacy sales (cost not stored)', () => {
  async function legacySale() {
    const s = await setup()
    await s.buy(10, 100)
    await s.buy(10, 200) // average 150
    const inv = await s.sell(5, 500)
    await s.buy(10, 300)
    // as written before the costRate column existed (synthetic, test database only)
    await db.stockLedger.updateMany({ where: { companyId: s.c, type: 'SALE_OUT' }, data: { costRate: null } })
    return { ...s, inv }
  }

  test('reliable history: the cost at the sale is rebuilt from the ledger', async () => {
    const s = await legacySale()
    const r = await s.ret(s.inv.id, 2)
    expect(r.status).toBe(200)
    expect((await s.rows('SALES_RETURN_IN'))[0].rate).toBe(150)
  })

  test('history that does not add up to the stock balance: return stopped for review, nothing saved', async () => {
    const s = await legacySale()
    await db.stockBalance.updateMany({ where: { itemId: s.item.id, warehouseId: s.whA }, data: { avgRate: 999 } })
    const before = await db.stockLedger.count({ where: { companyId: s.c } })
    const r = await s.ret(s.inv.id, 2)
    expect(r.status).toBe(409)
    expect(r.json.error?.message).toContain('cannot be rebuilt reliably')
    expect(r.json.error?.message).toContain('needs review')
    expect(await db.salesReturn.count({ where: { companyId: s.c } })).toBe(0)
    expect(await db.payment.count({ where: { companyId: s.c, mode: 'CREDIT_NOTE' } })).toBe(0)
    expect(await db.stockLedger.count({ where: { companyId: s.c } })).toBe(before)
  })

  test('history with a missing movement: return stopped for review', async () => {
    const s = await legacySale()
    const first = (await s.rows('PURCHASE_IN'))[0]
    await db.stockLedger.delete({ where: { id: first.id } })
    const r = await s.ret(s.inv.id, 1)
    expect(r.status).toBe(409)
    expect(await db.salesReturn.count({ where: { companyId: s.c } })).toBe(0)
  })
})

describe('invoices that moved no stock', () => {
  test('stock deduction off: the return is a credit note only and inventory does not change, also when cancelled', async () => {
    const s = await setup()
    await s.buy(10, 100)
    const inv = await s.sell(2, 200, { deductStock: false })
    const r = await s.ret(inv.id, 1)
    expect([r.status, r.json.data.stockReturned, r.json.data.creditApplied]).toEqual([200, false, 200])
    expect(await s.rows('SALES_RETURN_IN')).toHaveLength(0)
    expect(await s.bal()).toEqual({ qty: 10, avgRate: 100 })
    const log = await db.auditLog.findFirstOrThrow({ where: { companyId: s.c, entity: 'SalesReturn', action: 'CREATE' } })
    expect(log.details).toContain('credit note only')

    const c = await call(patchSalesReturn(apiRequest(`/api/sales-returns/${r.json.data.id}`, { method: 'PATCH', user: s.t.user, body: { companyId: s.c, action: 'cancel' } }), ctx({ id: r.json.data.id })))
    expect(c.status).toBe(200)
    expect(await s.rows('SALES_RETURN_REVERSAL')).toHaveLength(0)
    expect(await s.bal()).toEqual({ qty: 10, avgRate: 100 })
  })
})

describe('warehouses and delivery challans', () => {
  test('return to another warehouse: stock lands there at the original cost; each warehouse keeps its own figures', async () => {
    const s = await setup()
    await s.buy(10, 100, s.whA)
    await s.buy(5, 300, s.whB)
    const inv = await s.sell(2, 500)
    const r = await s.ret(inv.id, 1, { warehouseId: s.whB })
    expect(r.status).toBe(200)
    const [back] = await s.rows('SALES_RETURN_IN')
    expect([back.warehouseId, back.qtyIn, back.rate]).toEqual([s.whB, 1, 100])
    expect(await s.bal(s.whA)).toEqual({ qty: 8, avgRate: 100 })
    expect(await s.bal(s.whB)).toEqual({ qty: 6, avgRate: 266.67 }) // (5 × 300 + 1 × 100) / 6
    const pos = await positionAsOf(s.c, endOfDayStr('2026-05-31'))
    expect(pos.stock).toBeCloseTo(2400, 1) // 8 × 100 + 5 × 300 + 1 × 100, within rounding of the average

    // cancelling that return takes the goods out of warehouse B at the cost they came in at
    const c = await call(patchSalesReturn(apiRequest(`/api/sales-returns/${r.json.data.id}`, { method: 'PATCH', user: s.t.user, body: { companyId: s.c, action: 'cancel' } }), ctx({ id: r.json.data.id })))
    expect(c.status).toBe(200)
    const [rev] = await s.rows('SALES_RETURN_REVERSAL')
    expect([rev.warehouseId, rev.qtyOut, rev.rate]).toEqual([s.whB, 1, 100])
    expect((await s.bal(s.whB))?.qty).toBe(5)
  })

  async function orderWithChallan(s: Awaited<ReturnType<typeof setup>>) {
    const so = await s.ok(createSalesOrder, '/api/sales-orders', { customerId: s.customer.id, items: [{ itemId: s.item.id, qty: 5, rate: 400, gstRate: 0 }] })
    const soItem = await db.salesOrderItem.findFirstOrThrow({ where: { salesOrderId: so.id } })
    const ch = await s.ok(createDelivery, '/api/deliveries', { salesOrderId: so.id, warehouseId: s.whA, date: '2026-05-04', lines: [{ salesOrderItemId: soItem.id, qty: 2 }] })
    const d = await call(patchDelivery(apiRequest(`/api/deliveries/${ch.id}`, { method: 'PATCH', user: s.t.user, body: { companyId: s.c, action: 'dispatch' } }), ctx({ id: ch.id })))
    expect([d.status, d.json.error?.message]).toEqual([200, undefined])
    return { so, ch }
  }

  test('invoice of a delivery challan: the return uses the cost the challan dispatched at', async () => {
    const s = await setup()
    await s.buy(10, 100)
    const { so, ch } = await orderWithChallan(s)
    const [disp] = await s.rows('DISPATCH_OUT')
    expect([disp.qtyOut, disp.rate, disp.costRate]).toEqual([2, 400, 100])
    await s.buy(10, 500)
    const inv = await s.ok(createSalesInvoice, '/api/sales-invoices', { customerId: s.customer.id, salesOrderId: so.id, challanId: ch.id, date: '2026-05-05' })
    const r = await s.ret(inv.id, 1)
    expect(r.status).toBe(200)
    expect((await s.rows('SALES_RETURN_IN'))[0].rate).toBe(100)
  })

  test('sales-order invoice without its challan, while order goods left on a challan: return stopped for review', async () => {
    const s = await setup()
    await s.buy(10, 100)
    const { so } = await orderWithChallan(s)
    const inv = await s.ok(createSalesInvoice, '/api/sales-invoices', { customerId: s.customer.id, salesOrderId: so.id, date: '2026-05-05' })
    const r = await s.ret(inv.id, 1)
    expect(r.status).toBe(409)
    expect(r.json.error?.message).toContain('needs review')
    expect(await db.salesReturn.count({ where: { companyId: s.c } })).toBe(0)
  })
})
