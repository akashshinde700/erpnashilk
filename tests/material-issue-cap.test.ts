import { beforeEach, describe, expect, test } from 'bun:test'
import { POST as postIssue } from '@/app/api/material-issues/route'
import { PATCH as patchIssue } from '@/app/api/material-issues/[id]/route'
import { POST as postProduction } from '@/app/api/production-entries/route'
import { db } from '@/lib/db'
import { postStock } from '@/lib/erp-helpers'
import { apiRequest, call, ctx } from './helpers/api'
import { resetDb } from './helpers/db'
import { seedTenant } from './helpers/seed'

/**
 * The over-issue cap (BOM requirement + 5 %) used to trust the requiredQty the client sent and to
 * look at each issue on its own: a caller could send requiredQty 1000, or issue the full
 * requirement again and again. The requirement is now worked out on the server and the cap applies
 * to everything the work order has taken (issues + backflush).
 */

beforeEach(async () => { await resetDb() })

type User = { id: string; name: string; role: string; passwordHash?: string | null }

/** Released WO for 5 pcs of FG-1; BOM 2 KG RM-1 per piece (need 10 KG, cap 10.5); 100 KG in stock. */
async function seed() {
  const { company, user, warehouse } = await seedTenant()
  const c = company.id
  const fg = await db.item.create({ data: { companyId: c, code: 'FG-1', name: 'Finished part', type: 'FINISHED', uom: 'NOS', standardCost: 100 } })
  const rm = await db.item.create({ data: { companyId: c, code: 'RM-1', name: 'Raw bar', type: 'RAW', uom: 'KG', standardCost: 10 } })
  const other = await db.item.create({ data: { companyId: c, code: 'RM-X', name: 'Not on BOM', type: 'RAW', uom: 'KG', standardCost: 10 } })
  const bom = await db.bom.create({ data: { companyId: c, code: 'BOM-1', outputItemId: fg.id, outputQty: 1, status: 'ACTIVE', items: { create: [{ itemId: rm.id, qty: 2 }] } } })
  const wo = await db.workOrder.create({ data: { companyId: c, number: 'WO-1', itemId: fg.id, bomId: bom.id, warehouseId: warehouse.id, plannedQty: 5, status: 'RELEASED', startDate: new Date() } })
  await db.$transaction(async (tx) => {
    for (const it of [rm, other]) {
      await postStock(tx as never, { companyId: c, itemId: it.id, warehouseId: warehouse.id, type: 'OPENING', qtyIn: 100, rate: 10, refType: 'OPENING', refNumber: 'OP-1' })
    }
  })
  return { c, user, warehouse, fg, rm, other, wo }
}

const ISSUE = (s: Awaited<ReturnType<typeof seed>>, lines: { itemId: string; requiredQty: number; issuedQty: number }[], user: User = s.user) =>
  call(postIssue(apiRequest('/api/material-issues', { user, body: { companyId: s.c, workOrderId: s.wo.id, warehouseId: s.warehouse.id, lines } })))

const issuedKg = async (s: Awaited<ReturnType<typeof seed>>) =>
  (await db.stockLedger.aggregate({ where: { companyId: s.c, itemId: s.rm.id, type: 'ISSUE_OUT' }, _sum: { qtyOut: true } }))._sum.qtyOut ?? 0

describe('material issue over-issue cap', () => {
  test('a client-supplied requiredQty cannot lift the cap', async () => {
    const s = await seed()
    const r = await ISSUE(s, [{ itemId: s.rm.id, requiredQty: 1000, issuedQty: 30 }])
    expect(r.status).toBe(400)
    expect(r.json.error?.message).toMatch(/BOM needs 10 KG .*10\.5/)
    expect(await issuedKg(s)).toBe(0)
  })

  test('the cap is cumulative across issues on one work order', async () => {
    const s = await seed()
    expect((await ISSUE(s, [{ itemId: s.rm.id, requiredQty: 10, issuedQty: 10 }])).status).toBe(200)
    const again = await ISSUE(s, [{ itemId: s.rm.id, requiredQty: 10, issuedQty: 10 }])
    expect(again.status).toBe(400)
    expect(again.json.error?.message).toMatch(/at most 0\.5 more/)
    expect((await ISSUE(s, [{ itemId: s.rm.id, requiredQty: 0.5, issuedQty: 0.5 }])).status).toBe(200)
    expect(await issuedKg(s)).toBe(10.5)
  })

  test('two lines of the same item in one request are added together', async () => {
    const s = await seed()
    const r = await ISSUE(s, [{ itemId: s.rm.id, requiredQty: 10, issuedQty: 6 }, { itemId: s.rm.id, requiredQty: 10, issuedQty: 6 }])
    expect(r.status).toBe(400)
    expect(await issuedKg(s)).toBe(0)
  })

  test('backflushed material counts as taken', async () => {
    const s = await seed()
    // produce 2 of 5 with nothing issued → backflush 4 KG
    expect((await call(postProduction(apiRequest('/api/production-entries', { user: s.user, body: { companyId: s.c, workOrderId: s.wo.id, producedQty: 2 } })))).status).toBe(200)
    expect((await ISSUE(s, [{ itemId: s.rm.id, requiredQty: 10, issuedQty: 7 }])).status).toBe(400)
    expect((await ISSUE(s, [{ itemId: s.rm.id, requiredQty: 6, issuedQty: 6.5 }])).status).toBe(200)
  })

  test('an item that is not on the BOM is refused', async () => {
    const s = await seed()
    const r = await ISSUE(s, [{ itemId: s.other.id, requiredQty: 5, issuedQty: 1 }])
    expect(r.status).toBe(400)
    expect(r.json.error?.message).toMatch(/not on this work order's BOM/)
  })

  test('cancelling an issue gives the allowance back, and the stored requirement is the server value', async () => {
    const s = await seed()
    const first = await ISSUE(s, [{ itemId: s.rm.id, requiredQty: 999, issuedQty: 8 }])
    expect(first.status).toBe(200)
    const line = await db.materialIssueItem.findFirst({ where: { issueId: first.json.data.id } })
    expect(line?.requiredQty).toBe(10)
    expect((await call(patchIssue(apiRequest(`/api/material-issues/${first.json.data.id}`, { method: 'PATCH', user: s.user, body: { companyId: s.c, action: 'cancel' } }), ctx({ id: first.json.data.id })))).status).toBe(200)
    expect((await ISSUE(s, [{ itemId: s.rm.id, requiredQty: 10, issuedQty: 10.5 }])).status).toBe(200)
  })

  test('two parallel issues that together pass the cap: exactly one goes through', async () => {
    const s = await seed()
    const [a, b] = await Promise.all([
      ISSUE(s, [{ itemId: s.rm.id, requiredQty: 10, issuedQty: 7 }]),
      ISSUE(s, [{ itemId: s.rm.id, requiredQty: 10, issuedQty: 7 }]),
    ])
    expect([a.status, b.status].sort()).toEqual([200, 400])
    expect(await issuedKg(s)).toBe(7)
  })
})
