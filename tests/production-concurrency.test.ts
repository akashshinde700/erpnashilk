import { beforeEach, describe, expect, test } from 'bun:test'
import { POST as postProduction } from '@/app/api/production-entries/route'
import { db } from '@/lib/db'
import { postStock } from '@/lib/erp-helpers'
import { apiRequest, call } from './helpers/api'
import { resetDb } from './helpers/db'
import { seedTenant } from './helpers/seed'

/**
 * Transaction safety on the manufacturing floor.
 *
 * Every test here fires two requests at the same work order *in parallel* — the shape a double click,
 * a flaky network retry or two operators on the same job card produces. The work-order row lock in
 * POST /api/production-entries must make them behave like a queue: finished-goods stock, raw-material
 * backflush and the work order's own counters have to agree with the entries that were actually saved.
 *
 * Needs the guarded test database (see tests/README.md):  TEST_DATABASE_URL=… bun test
 */

beforeEach(async () => {
  await resetDb()
})

const PRODUCE = (companyId: string, workOrderId: string, qty: number, user: { id: string; name: string; role: string; passwordHash?: string | null }, headers: Record<string, string> = {}) =>
  call(postProduction(apiRequest('/api/production-entries', {
    body: { companyId, workOrderId, producedQty: qty },
    user,
    headers,
  })))

/** A released work order for 10 pcs of FG-1, whose BOM needs 2 KG of RM-1 per piece, with 100 KG in stock. */
async function seedWorkOrder(opts: { plannedQty?: number; rmStock?: number } = {}) {
  const plannedQty = opts.plannedQty ?? 10
  const rmStock = opts.rmStock ?? 100
  const { company, user, warehouse } = await seedTenant()
  const fg = await db.item.create({ data: { companyId: company.id, code: 'FG-1', name: 'Finished part', type: 'FINISHED', uom: 'NOS', standardCost: 100 } })
  const rm = await db.item.create({ data: { companyId: company.id, code: 'RM-1', name: 'Raw bar', type: 'RAW', uom: 'KG', standardCost: 10 } })
  const bom = await db.bom.create({
    data: {
      companyId: company.id, code: 'BOM-1', outputItemId: fg.id, outputQty: 1, status: 'ACTIVE',
      items: { create: [{ itemId: rm.id, qty: 2 }] },
    },
  })
  const wo = await db.workOrder.create({
    data: {
      companyId: company.id, number: 'WO-1', itemId: fg.id, bomId: bom.id, warehouseId: warehouse.id,
      plannedQty, status: 'RELEASED', startDate: new Date(),
    },
  })
  await db.$transaction(async (tx) => {
    await postStock(tx as never, {
      companyId: company.id, itemId: rm.id, warehouseId: warehouse.id, type: 'OPENING',
      qtyIn: rmStock, rate: 10, refType: 'OPENING', refNumber: 'OP-1',
    })
  })
  return { company, user, warehouse, fg, rm, wo }
}

const qtyOf = async (companyId: string, itemId: string) =>
  (await db.stockBalance.findFirst({ where: { companyId, itemId } }))?.qty ?? 0

describe('Production entries at the same work order', () => {
  test('two parallel entries cannot both post finished goods and backflush material', async () => {
    const s = await seedWorkOrder({ plannedQty: 10, rmStock: 100 })

    // Both ask for the full planned quantity; only one may win.
    const [a, b] = await Promise.all([
      PRODUCE(s.company.id, s.wo.id, 10, s.user),
      PRODUCE(s.company.id, s.wo.id, 10, s.user),
    ])

    const succeeded = [a, b].filter((r) => r.json.success)
    expect(succeeded.length).toBe(1)
    const failed = [a, b].find((r) => !r.json.success)!
    expect(failed.status).toBe(400)
    expect(failed.json.error?.message).toMatch(/exceeds planned qty/i)

    // One entry's worth of stock — not two
    expect(await qtyOf(s.company.id, s.fg.id)).toBe(10)
    // …and exactly the BOM quantity of raw material was consumed (2 KG per piece)
    expect(await qtyOf(s.company.id, s.rm.id)).toBe(100 - 20)

    expect(await db.productionEntry.count({ where: { companyId: s.company.id } })).toBe(1)
    const wo = await db.workOrder.findUnique({ where: { id: s.wo.id } })
    expect(wo?.producedQty).toBe(10)
    expect(wo?.status).toBe('COMPLETED')

    // Stock ledger tells the same story as the balances
    const ledger = await db.stockLedger.findMany({ where: { companyId: s.company.id, refType: 'WORK_ORDER' } })
    expect(ledger.filter((l) => l.type === 'PRODUCTION_IN').reduce((n, l) => n + l.qtyIn, 0)).toBe(10)
    expect(ledger.filter((l) => l.type === 'BACKFLUSH_OUT').reduce((n, l) => n + l.qtyOut, 0)).toBe(20)
  })

  test('five parallel entries still leave stock and counters consistent', async () => {
    const s = await seedWorkOrder({ plannedQty: 10, rmStock: 100 })

    const results = await Promise.all(Array.from({ length: 5 }, () => PRODUCE(s.company.id, s.wo.id, 4, s.user)))
    const okResults = results.filter((r) => r.json.success)
    // 4 + 4 + 4 would pass 10, so at most two entries fit (8 ≤ 10, third would be 12 > 10.5)
    expect(okResults.length).toBeLessThanOrEqual(2)
    expect(okResults.length).toBeGreaterThanOrEqual(1)

    const entries = await db.productionEntry.findMany({ where: { companyId: s.company.id } })
    const produced = entries.reduce((n, e) => n + e.producedQty, 0)
    expect(produced).toBe(okResults.length * 4)
    expect(await qtyOf(s.company.id, s.fg.id)).toBe(produced)
    expect(await qtyOf(s.company.id, s.rm.id)).toBe(100 - produced * 2)
    const wo = await db.workOrder.findUnique({ where: { id: s.wo.id } })
    expect(wo?.producedQty).toBe(produced)
  })
})

describe('Idempotency-Key on production entries', () => {
  test('a retried submission is replayed, not posted twice', async () => {
    const s = await seedWorkOrder({ plannedQty: 10, rmStock: 100 })
    const headers = { 'idempotency-key': 'prod-entry-0001' }

    const first = await PRODUCE(s.company.id, s.wo.id, 10, s.user, headers)
    const retry = await PRODUCE(s.company.id, s.wo.id, 10, s.user, headers)

    expect(first.json.success).toBe(true)
    expect(retry.json.success).toBe(true)
    // same entry back, and nothing new was created
    expect(retry.json.data?.id).toBe(first.json.data?.id)
    expect(await db.productionEntry.count({ where: { companyId: s.company.id } })).toBe(1)
    expect(await qtyOf(s.company.id, s.fg.id)).toBe(10)
    expect(await qtyOf(s.company.id, s.rm.id)).toBe(80)
  })

  test('a different payload under the same key is refused', async () => {
    const s = await seedWorkOrder({ plannedQty: 10, rmStock: 100 })
    const headers = { 'idempotency-key': 'prod-entry-0002' }

    const first = await PRODUCE(s.company.id, s.wo.id, 4, s.user, headers)
    expect(first.json.success).toBe(true)
    const other = await PRODUCE(s.company.id, s.wo.id, 6, s.user, headers)
    expect(other.json.success).toBe(false)
    expect(other.status).toBe(422)
    expect(await db.productionEntry.count({ where: { companyId: s.company.id } })).toBe(1)
    expect(await qtyOf(s.company.id, s.fg.id)).toBe(4)
  })

  test('a failed entry releases its key, so the corrected retry goes through', async () => {
    const s = await seedWorkOrder({ plannedQty: 10, rmStock: 5 }) // only enough material for 2 pcs
    const headers = { 'idempotency-key': 'prod-entry-0003' }

    const short = await PRODUCE(s.company.id, s.wo.id, 10, s.user, headers)
    expect(short.json.success).toBe(false)
    expect(short.status).toBe(409) // shortage is listed before anything is posted
    expect(await qtyOf(s.company.id, s.fg.id)).toBe(0)
    expect(await qtyOf(s.company.id, s.rm.id)).toBe(5)
    expect(await db.productionEntry.count({ where: { companyId: s.company.id } })).toBe(0)

    // The same key now runs again (nothing was committed) — and passes with a quantity that fits
    const retry = await PRODUCE(s.company.id, s.wo.id, 2, s.user, headers)
    expect(retry.json.success).toBe(true)
    expect(await qtyOf(s.company.id, s.fg.id)).toBe(2)
    expect(await qtyOf(s.company.id, s.rm.id)).toBe(1)
  })
})
