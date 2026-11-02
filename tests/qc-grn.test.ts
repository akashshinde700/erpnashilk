import { beforeEach, describe, expect, test } from 'bun:test'
import { DELETE as deleteGrn, GET as getGrn, PATCH as patchGrn } from '@/app/api/grns/[id]/route'
import { GET as listGrns, POST as createGrn } from '@/app/api/grns/route'
import { GET as getQc, PATCH as patchQc } from '@/app/api/qc-inspections/[id]/route'
import { GET as listQc, POST as createQc } from '@/app/api/qc-inspections/route'
import { POST as closeQty } from '@/app/api/purchase-orders/[id]/closures/route'
import { GET as getPo } from '@/app/api/purchase-orders/[id]/route'
import { GET as mrp } from '@/app/api/mrp/route'
import { backupPlan } from '@/lib/backup-plan'
import * as correctionsRoute from '@/app/api/qc-inspections/[id]/corrections/route'
import { POST as postCorrection } from '@/app/api/qc-inspections/[id]/corrections/route'
import { db } from '@/lib/db'
import { matchInspectionsToLines, readQcResult } from '@/lib/grn-qc'
import { apiRequest, call, ctx, type TestUser } from './helpers/api'
import { resetDb } from './helpers/db'
import { seedTenant, seedUser } from './helpers/seed'

// Isolated test database only (tests/setup/test-db-guard.ts). Quantities below are fixtures, not business records.
beforeEach(resetDb)

interface LineSpec { name: string; qty: number; rate: number; receive?: number; serial?: boolean }

async function setup(specs: LineSpec[]) {
  const t = await seedTenant()
  const supplier = await db.supplier.create({ data: { companyId: t.company.id, code: 'S-1', name: 'Steel Traders Ltd.' } })
  const items = await Promise.all(specs.map((s, i) => db.item.create({
    data: { companyId: t.company.id, code: `I-${i}-${s.name}`.slice(0, 30), name: s.name, uom: 'NOS', trackSerial: !!s.serial } as never,
  })))
  const po = await db.purchaseOrder.create({
    data: {
      companyId: t.company.id, number: `PO-${Date.now()}-${Math.random()}`.slice(0, 30), supplierId: supplier.id, orderDate: new Date(), status: 'APPROVED',
      items: { create: specs.map((s, i) => ({ itemId: items[i].id, qty: s.qty, rate: s.rate })) },
    } as never,
    include: { items: true },
  }) as unknown as { id: string; items: { id: string; itemId: string; qty: number }[] }
  return { ...t, supplier, items, po }
}

/** Creates the GRN through the real route; returns it with its inspections in line order. */
async function receive(s: Awaited<ReturnType<typeof setup>>, lines: { poItemId: string; itemId: string; receivedQty: number; serials?: string; acceptedQty?: number }[]) {
  const r = await call(createGrn(apiRequest('/api/grns', { user: s.user, body: { poId: s.po.id, warehouseId: s.warehouse.id, items: lines } })))
  expect(r.status).toBe(200)
  const inspections = await db.qcInspection.findMany({ where: { refType: 'GRN', refId: r.json.data.id }, orderBy: { number: 'asc' } })
  return { grn: r.json.data as { id: string; number: string; items: { id: string; itemId: string; poItemId: string; receivedQty: number; acceptedQty: number; rejectedQty: number; qcStatus: string }[] }, inspections }
}
const allLines = (s: Awaited<ReturnType<typeof setup>>, specs: LineSpec[]) => s.po.items.map((p) => {
  const spec = specs[s.items.findIndex((i) => i.id === p.itemId)]
  return { poItemId: p.id, itemId: p.itemId, receivedQty: spec.receive ?? p.qty }
})
const submit = (user: TestUser, id: string, body: Record<string, unknown>) =>
  call(patchQc(apiRequest(`/api/qc-inspections/${id}`, { method: 'PATCH', user, body }), ctx({ id })))
const post = (user: TestUser, id: string) =>
  call(patchGrn(apiRequest(`/api/grns/${id}`, { method: 'PATCH', user, body: { action: 'post' } }), ctx({ id })))
const stockOf = async (itemId: string) => (await db.stockBalance.findFirst({ where: { itemId } }))?.qty ?? 0

describe('Business example: GRN with four materials', () => {
  const SPECS: LineSpec[] = [
    { name: 'MS Channel 100', qty: 250, rate: 60 }, { name: 'MS Plate 10mm', qty: 200, rate: 70 },
    { name: 'MS Angle 40x40x5', qty: 150, rate: 55 }, { name: 'Welding Electrode 3.15mm', qty: 20, rate: 300 },
  ]
  const RESULT: Record<string, [number, number]> = {
    'MS Channel 100': [1, 249], 'MS Plate 10mm': [50, 150], 'MS Angle 40x40x5': [150, 0], 'Welding Electrode 3.15mm': [15, 5],
  }

  test('620 received → 216 in stock, 404 rejected, nothing pending, POSTED', async () => {
    const s = await setup(SPECS)
    const { grn, inspections } = await receive(s, allLines(s, SPECS))
    const nameOf = (itemId: string) => s.items.find((i) => i.id === itemId)!.name
    expect(inspections.map((i) => i.qtyChecked).reduce((a, b) => a + b)).toBe(620)

    for (const [n, qc] of inspections.entries()) {
      const [qtyAccepted, qtyRejected] = RESULT[nameOf(qc.itemId)]
      const r = await submit(s.user, qc.id, { qtyAccepted, qtyRejected, inspector: 'R. Patil' })
      expect(r.status).toBe(200)
      const status = (await db.grn.findUnique({ where: { id: grn.id } }))!.status
      expect(status).toBe(n === inspections.length - 1 ? 'QC_COMPLETED' : 'PENDING_QC')
    }
    // Nothing enters stock until it is posted
    expect(await db.stockBalance.count({ where: { companyId: s.company.id } })).toBe(0)

    const p = await post(s.user, grn.id)
    expect(p.status).toBe(200)
    expect(p.json.data.status).toBe('POSTED')

    const lines = await db.grnItem.findMany({ where: { grnId: grn.id } })
    expect(lines.reduce((a, l) => a + l.receivedQty, 0)).toBe(620)
    expect(lines.reduce((a, l) => a + l.acceptedQty, 0)).toBe(216)
    expect(lines.reduce((a, l) => a + l.rejectedQty, 0)).toBe(404)

    const balances = await db.stockBalance.findMany({ where: { companyId: s.company.id } })
    expect(balances.reduce((a, b) => a + b.qty, 0)).toBe(216)
    for (const item of s.items) {
      expect([item.name, await stockOf(item.id)]).toEqual([item.name, RESULT[item.name][0]])
      const spec = SPECS.find((x) => x.name === item.name)!
      const ledger = await db.stockLedger.findMany({ where: { itemId: item.id, refId: grn.id } })
      expect(ledger.map((l) => [l.type, l.qtyIn, l.rate])).toEqual([['GRN_IN', RESULT[item.name][0], spec.rate]])
    }
    expect(await db.qcInspection.count({ where: { refId: grn.id, status: 'PENDING' } })).toBe(0)
    const audit = await db.auditLog.findFirst({ where: { companyId: s.company.id, entity: 'Grn', action: 'POST' } })
    expect(audit!.details).toContain('stock in 216 qty, rejected 404')
    // receivedQty is the physical count; rejected material stays owed, so the PO stays open
    const po = await db.purchaseOrder.findUnique({ where: { id: s.po.id }, include: { items: true } })
    expect(po!.status).toBe('PARTIALLY_RECEIVED')
    expect(po!.items.reduce((a, i) => a + i.receivedQty, 0)).toBe(620)
  })
})

describe('QC outcomes', () => {
  const ONE: LineSpec[] = [{ name: 'Part', qty: 100, rate: 10 }]

  test('fully accepted: PASSED, all in stock', async () => {
    const s = await setup(ONE)
    const { grn, inspections } = await receive(s, allLines(s, ONE))
    expect((await submit(s.user, inspections[0].id, { qtyAccepted: 100, qtyRejected: 0 })).json.data.status).toBe('PASSED')
    await post(s.user, grn.id)
    expect(await stockOf(s.items[0].id)).toBe(100)
    expect((await db.grnItem.findFirst({ where: { grnId: grn.id } }))!.qcStatus).toBe('PASSED')
  })

  test('fully rejected: FAILED, no stock and no ledger row, GRN still posts and PO records the receipt', async () => {
    const s = await setup(ONE)
    const { grn, inspections } = await receive(s, allLines(s, ONE))
    expect((await submit(s.user, inspections[0].id, { qtyAccepted: 0, qtyRejected: 100 })).json.data.status).toBe('FAILED')
    expect((await post(s.user, grn.id)).status).toBe(200)
    expect(await stockOf(s.items[0].id)).toBe(0)
    expect(await db.stockLedger.count({ where: { refId: grn.id } })).toBe(0)
    expect((await db.grnItem.findFirst({ where: { grnId: grn.id } }))!).toMatchObject({ acceptedQty: 0, rejectedQty: 100, qcStatus: 'FAILED' })
    expect(await db.notification.count({ where: { companyId: s.company.id, level: 'CRITICAL' } })).toBe(1)
  })

  test('partly accepted: PARTIAL, only the accepted qty in stock, line not marked as passed', async () => {
    const s = await setup(ONE)
    const { grn, inspections } = await receive(s, allLines(s, ONE))
    expect((await submit(s.user, inspections[0].id, { qtyAccepted: 60, qtyRejected: 40 })).json.data.status).toBe('PARTIAL')
    await post(s.user, grn.id)
    expect(await stockOf(s.items[0].id)).toBe(60)
    expect((await db.grnItem.findFirst({ where: { grnId: grn.id } }))!).toMatchObject({ acceptedQty: 60, rejectedQty: 40, qcStatus: 'PARTIAL' })
  })

  test('one failed line among several: only the good lines enter stock', async () => {
    const specs: LineSpec[] = [{ name: 'Good', qty: 10, rate: 1 }, { name: 'Bad', qty: 20, rate: 2 }]
    const s = await setup(specs)
    const { grn, inspections } = await receive(s, allLines(s, specs))
    for (const qc of inspections) {
      const good = qc.itemId === s.items[0].id
      await submit(s.user, qc.id, good ? { qtyAccepted: 10, qtyRejected: 0 } : { qtyAccepted: 0, qtyRejected: 20 })
    }
    expect((await post(s.user, grn.id)).status).toBe(200)
    expect(await stockOf(s.items[0].id)).toBe(10)
    expect(await stockOf(s.items[1].id)).toBe(0)
  })

  test('accepted qty typed on the GRN form is ignored: only QC can accept material', async () => {
    const s = await setup(ONE)
    const { grn, inspections } = await receive(s, [{ ...allLines(s, ONE)[0], acceptedQty: 100 }])
    expect(grn.items[0].acceptedQty).toBe(0)
    await submit(s.user, inspections[0].id, { qtyAccepted: 5, qtyRejected: 95 })
    await post(s.user, grn.id)
    expect(await stockOf(s.items[0].id)).toBe(5)
  })
})

describe('QC quantity validation (server)', () => {
  const ONE: LineSpec[] = [{ name: 'Part', qty: 250, rate: 10 }]
  const cases: [string, Record<string, unknown>, string][] = [
    ['accepted + rejected less than checked', { qtyAccepted: 1, qtyRejected: 0 }, 'QC_QTY_MISMATCH'],
    ['accepted + rejected more than checked', { qtyAccepted: 200, qtyRejected: 100 }, 'QC_QTY_MISMATCH'],
    ['negative accepted', { qtyAccepted: -1, qtyRejected: 251 }, 'QC_QTY_INVALID'],
    ['negative rejected', { qtyAccepted: 251, qtyRejected: -1 }, 'QC_QTY_INVALID'],
    ['accepted above checked', { qtyAccepted: 300, qtyRejected: 0 }, 'QC_QTY_INVALID'],
    ['not a number', { qtyAccepted: 'abc', qtyRejected: 0 }, 'QC_QTY_INVALID'],
    ['missing accepted', { qtyRejected: 250 }, 'QC_QTY_INVALID'],
    ['blank rejected', { qtyAccepted: 250, qtyRejected: '' }, 'QC_QTY_INVALID'],
    ['status contradicting the qty', { qtyAccepted: 100, qtyRejected: 150, status: 'PASSED' }, 'QC_STATUS_CONFLICT'],
  ]
  for (const [name, body, code] of cases) {
    test(`${name} is refused and changes nothing`, async () => {
      const s = await setup(ONE)
      const { grn, inspections } = await receive(s, allLines(s, ONE))
      const r = await submit(s.user, inspections[0].id, body)
      expect([r.status, r.json.error?.code]).toEqual([400, code])
      expect((await db.qcInspection.findUnique({ where: { id: inspections[0].id } }))!.status).toBe('PENDING')
      expect((await db.grn.findUnique({ where: { id: grn.id } }))!.status).toBe('PENDING_QC')
    })
  }

  test('rounding within the ERP 2-decimal precision is accepted', () => {
    expect(readQcResult({ qtyAccepted: 33.33, qtyRejected: 66.67 }, 100).status).toBe('PARTIAL')
    expect(readQcResult({ qtyAccepted: '0.1', qtyRejected: '0.2' }, 0.3).status).toBe('PARTIAL')
    expect(() => readQcResult({ qtyAccepted: 33.33, qtyRejected: 66.6 }, 100)).toThrow('unaccounted')
  })

  test('a second result on the same inspection is refused', async () => {
    const s = await setup(ONE)
    const { inspections } = await receive(s, allLines(s, ONE))
    expect((await submit(s.user, inspections[0].id, { qtyAccepted: 250, qtyRejected: 0 })).status).toBe(200)
    expect((await submit(s.user, inspections[0].id, { qtyAccepted: 0, qtyRejected: 250 })).status).toBe(400)
    expect((await db.grnItem.findFirst({ where: { itemId: s.items[0].id } }))!.acceptedQty).toBe(250)
  })

  test('two simultaneous results: exactly one wins', async () => {
    const s = await setup(ONE)
    const { inspections } = await receive(s, allLines(s, ONE))
    const [a, b] = await Promise.all([
      submit(s.user, inspections[0].id, { qtyAccepted: 250, qtyRejected: 0 }),
      submit(s.user, inspections[0].id, { qtyAccepted: 0, qtyRejected: 250 }),
    ])
    expect([a.status, b.status].filter((x) => x === 200).length).toBe(1)
    const line = (await db.grnItem.findFirst({ where: { itemId: s.items[0].id } }))!
    const qc = (await db.qcInspection.findUnique({ where: { id: inspections[0].id } }))!
    expect(line.acceptedQty).toBe(qc.qtyAccepted)
  })
})

describe('Line-level mapping', () => {
  test('two lines of one item keep separate results, each with its own PO line rate', async () => {
    const specs: LineSpec[] = [{ name: 'Rod A', qty: 100, rate: 10 }]
    const s = await setup(specs)
    // A second PO line for the same item, at another rate
    const second = await db.purchaseOrderItem.create({ data: { poId: s.po.id, itemId: s.items[0].id, qty: 50, rate: 20 } })
    const { grn, inspections } = await receive(s, [
      { poItemId: s.po.items[0].id, itemId: s.items[0].id, receivedQty: 100 },
      { poItemId: second.id, itemId: s.items[0].id, receivedQty: 50 },
    ])
    expect(new Set(inspections.map((i) => i.grnItemId)).size).toBe(2)
    const first = inspections.find((i) => i.qtyChecked === 100)!
    const other = inspections.find((i) => i.qtyChecked === 50)!
    await submit(s.user, first.id, { qtyAccepted: 100, qtyRejected: 0 })
    let lines = await db.grnItem.findMany({ where: { grnId: grn.id } })
    // The other line of the same item is untouched
    expect(lines.find((l) => l.receivedQty === 50)).toMatchObject({ qcStatus: 'PENDING', acceptedQty: 0, rejectedQty: 0 })
    await submit(s.user, other.id, { qtyAccepted: 0, qtyRejected: 50 })
    lines = await db.grnItem.findMany({ where: { grnId: grn.id } })
    expect(lines.find((l) => l.receivedQty === 100)).toMatchObject({ qcStatus: 'PASSED', acceptedQty: 100 })
    expect(lines.find((l) => l.receivedQty === 50)).toMatchObject({ qcStatus: 'FAILED', rejectedQty: 50 })
    await post(s.user, grn.id)
    expect(await stockOf(s.items[0].id)).toBe(100)
    const ledger = await db.stockLedger.findMany({ where: { refId: grn.id } })
    expect(ledger.map((l) => [l.qtyIn, l.rate])).toEqual([[100, 10]])
  })

  test('two identical lines of one item, two inspections: results land on the right line', async () => {
    const specs: LineSpec[] = [{ name: 'Rod B', qty: 40, rate: 10 }]
    const s = await setup(specs)
    const poItem = s.po.items[0]
    const { grn, inspections } = await receive(s, [
      { poItemId: poItem.id, itemId: s.items[0].id, receivedQty: 20 },
      { poItemId: poItem.id, itemId: s.items[0].id, receivedQty: 20 },
    ])
    await submit(s.user, inspections[0].id, { qtyAccepted: 20, qtyRejected: 0 })
    await submit(s.user, inspections[1].id, { qtyAccepted: 5, qtyRejected: 15 })
    expect((await db.grnItem.findUnique({ where: { id: inspections[0].grnItemId! } }))!).toMatchObject({ acceptedQty: 20, qcStatus: 'PASSED' })
    expect((await db.grnItem.findUnique({ where: { id: inspections[1].grnItemId! } }))!).toMatchObject({ acceptedQty: 5, rejectedQty: 15, qcStatus: 'PARTIAL' })
    await post(s.user, grn.id)
    expect(await stockOf(s.items[0].id)).toBe(25)
  })

  test('older inspections without a line link are matched by item and qty, and linked', async () => {
    const specs: LineSpec[] = [{ name: 'Old', qty: 30, rate: 7 }]
    const s = await setup(specs)
    const { grn, inspections } = await receive(s, allLines(s, specs))
    await db.qcInspection.update({ where: { id: inspections[0].id }, data: { grnItemId: null } })
    expect((await submit(s.user, inspections[0].id, { qtyAccepted: 30, qtyRejected: 0 })).status).toBe(200)
    expect((await db.qcInspection.findUnique({ where: { id: inspections[0].id } }))!.grnItemId).toBe(grn.items[0].id)
    expect((await db.grnItem.findUnique({ where: { id: grn.items[0].id } }))!.acceptedQty).toBe(30)
  })

  test('an uncertain older match is refused, not guessed', () => {
    const base = { itemId: 'i', receivedQty: 5 }
    const lines = [{ id: 'a', ...base, batchNo: 'B1' }, { id: 'b', ...base, batchNo: 'B2' }]
    const r = matchInspectionsToLines(lines, [{ id: 'q', number: 'Q1', itemId: 'i', qtyChecked: 5, grnItemId: null }])
    expect(r.byLine.size).toBe(0)
    expect(r.unmatched.length).toBe(1)
    // Different qty is not a match either
    expect(matchInspectionsToLines([{ id: 'a', itemId: 'i', receivedQty: 9 }], [{ id: 'q', number: 'Q1', itemId: 'i', qtyChecked: 5 }]).byLine.size).toBe(0)
  })

  test('older GRN with an incomplete result cannot be posted: the missing qty is not guessed', async () => {
    const specs: LineSpec[] = [{ name: 'Old2', qty: 250, rate: 7 }]
    const s = await setup(specs)
    const { grn, inspections } = await receive(s, allLines(s, specs))
    await db.qcInspection.update({ where: { id: inspections[0].id }, data: { grnItemId: null, status: 'PASSED', qtyAccepted: 1, qtyRejected: 0 } })
    const r = await post(s.user, grn.id)
    expect([r.status, r.json.error?.code]).toEqual([409, 'QC_RESULT_INCOMPLETE'])
    expect((await db.grn.findUnique({ where: { id: grn.id } }))!.status).toBe('PENDING_QC')
    expect(await stockOf(s.items[0].id)).toBe(0)
  })

  test('older GRN whose results add up posts from PENDING_QC using the inspection qty', async () => {
    const specs: LineSpec[] = [{ name: 'Old3', qty: 10, rate: 7 }]
    const s = await setup(specs)
    const { grn, inspections } = await receive(s, allLines(s, specs))
    await db.qcInspection.update({ where: { id: inspections[0].id }, data: { grnItemId: null, status: 'PARTIAL', qtyAccepted: 4, qtyRejected: 6 } })
    await db.grnItem.update({ where: { id: grn.items[0].id }, data: { acceptedQty: 10, qcStatus: 'PARTIAL' } }) // typed on the old form
    expect((await post(s.user, grn.id)).status).toBe(200)
    expect(await stockOf(s.items[0].id)).toBe(4)
    expect((await db.grnItem.findUnique({ where: { id: grn.items[0].id } }))!).toMatchObject({ acceptedQty: 4, rejectedQty: 6 })
  })
})

describe('GRN workflow', () => {
  const TWO: LineSpec[] = [{ name: 'A', qty: 10, rate: 1 }, { name: 'B', qty: 10, rate: 1 }]

  test('posting is blocked while any inspection is pending, and rolls back fully', async () => {
    const s = await setup(TWO)
    const { grn, inspections } = await receive(s, allLines(s, TWO))
    await submit(s.user, inspections[0].id, { qtyAccepted: 10, qtyRejected: 0 })
    const r = await post(s.user, grn.id)
    expect([r.status, r.json.error?.code]).toEqual([409, 'QC_PENDING'])
    expect(r.json.error?.message).toContain(inspections[1].number)
    expect((await db.grn.findUnique({ where: { id: grn.id } }))!.status).toBe('PENDING_QC')
    expect(await db.stockBalance.count({ where: { companyId: s.company.id } })).toBe(0)
    expect((await db.purchaseOrderItem.findMany({ where: { poId: s.po.id } })).every((i) => i.receivedQty === 0)).toBe(true)
  })

  test('the two last results arriving together still complete QC', async () => {
    const s = await setup(TWO)
    const { grn, inspections } = await receive(s, allLines(s, TWO))
    const rs = await Promise.all(inspections.map((q) => submit(s.user, q.id, { qtyAccepted: 10, qtyRejected: 0 })))
    expect(rs.map((r) => r.status)).toEqual([200, 200])
    expect((await db.grn.findUnique({ where: { id: grn.id } }))!.status).toBe('QC_COMPLETED')
  })

  test('posting twice is blocked, also when simultaneous: stock enters once', async () => {
    const s = await setup(TWO)
    const { grn, inspections } = await receive(s, allLines(s, TWO))
    for (const q of inspections) await submit(s.user, q.id, { qtyAccepted: 10, qtyRejected: 0 })
    const rs = await Promise.all([post(s.user, grn.id), post(s.user, grn.id)])
    expect(rs.map((r) => r.status).filter((x) => x === 200).length).toBe(1)
    const again = await post(s.user, grn.id)
    expect([again.status, again.json.error?.code]).toEqual([409, 'GRN_ALREADY_POSTED'])
    expect(await stockOf(s.items[0].id)).toBe(10)
    expect((await db.purchaseOrderItem.findMany({ where: { poId: s.po.id } })).every((i) => i.receivedQty === 10)).toBe(true)
  })

  test('a posted GRN cannot be deleted; a QC_COMPLETED one can, with no stock impact', async () => {
    const s = await setup(TWO)
    const a = await receive(s, allLines(s, TWO).map((l) => ({ ...l, receivedQty: 5 })))
    for (const q of a.inspections) await submit(s.user, q.id, { qtyAccepted: 5, qtyRejected: 0 })
    await post(s.user, a.grn.id)
    const del = await call(deleteGrn(apiRequest(`/api/grns/${a.grn.id}`, { method: 'DELETE', user: s.user, body: {} }), ctx({ id: a.grn.id })))
    expect(del.status).toBe(400)
    expect(await db.grn.count({ where: { id: a.grn.id } })).toBe(1)

    const b = await receive(s, allLines(s, TWO).map((l) => ({ ...l, receivedQty: 5 })))
    for (const q of b.inspections) await submit(s.user, q.id, { qtyAccepted: 5, qtyRejected: 0 })
    expect((await call(deleteGrn(apiRequest(`/api/grns/${b.grn.id}`, { method: 'DELETE', user: s.user, body: {} }), ctx({ id: b.grn.id })))).status).toBe(200)
    expect(await db.qcInspection.count({ where: { refId: b.grn.id } })).toBe(0)
  })

  test('a result after the GRN is posted is refused (GRN is locked)', async () => {
    const s = await setup(TWO)
    const { grn, inspections } = await receive(s, allLines(s, TWO))
    await db.grn.update({ where: { id: grn.id }, data: { status: 'POSTED' } })
    const r = await submit(s.user, inspections[0].id, { qtyAccepted: 10, qtyRejected: 0 })
    expect([r.status, r.json.error?.code]).toEqual([409, 'GRN_NOT_PENDING_QC'])
    expect((await db.qcInspection.findUnique({ where: { id: inspections[0].id } }))!.status).toBe('PENDING')
  })

  test('PO: partial receipt → PARTIALLY_RECEIVED, the rest → RECEIVED; QC_COMPLETED qty still blocks over-receipt', async () => {
    const one: LineSpec[] = [{ name: 'P', qty: 100, rate: 3 }]
    const s = await setup(one)
    const line = allLines(s, one)[0]
    const a = await receive(s, [{ ...line, receivedQty: 60 }])
    await submit(s.user, a.inspections[0].id, { qtyAccepted: 50, qtyRejected: 10 })
    expect((await db.grn.findUnique({ where: { id: a.grn.id } }))!.status).toBe('QC_COMPLETED')
    const over = await call(createGrn(apiRequest('/api/grns', { user: s.user, body: { poId: s.po.id, warehouseId: s.warehouse.id, items: [{ ...line, receivedQty: 50 }] } })))
    expect(over.status).toBe(400)
    await post(s.user, a.grn.id)
    let po = await db.purchaseOrder.findUnique({ where: { id: s.po.id }, include: { items: true } })
    expect([po!.status, po!.items[0].receivedQty]).toEqual(['PARTIALLY_RECEIVED', 60])
    const b = await receive(s, [{ ...line, receivedQty: 40 }])
    await submit(s.user, b.inspections[0].id, { qtyAccepted: 40, qtyRejected: 0 })
    await post(s.user, b.grn.id)
    po = await db.purchaseOrder.findUnique({ where: { id: s.po.id }, include: { items: true } })
    expect([po!.status, po!.items[0].receivedQty]).toEqual(['PARTIALLY_RECEIVED', 100])
    expect(await stockOf(s.items[0].id)).toBe(90)
    // The replacement for the 10 rejected completes it
    const c = await receive(s, [{ ...line, receivedQty: 10 }])
    await submit(s.user, c.inspections[0].id, { qtyAccepted: 10, qtyRejected: 0 })
    await post(s.user, c.grn.id)
    po = await db.purchaseOrder.findUnique({ where: { id: s.po.id }, include: { items: true } })
    expect([po!.status, po!.items[0].receivedQty]).toEqual(['RECEIVED', 110])
    expect(await stockOf(s.items[0].id)).toBe(100)
  })

  test('the GRN list says how many inspections are pending', async () => {
    const s = await setup(TWO)
    const { grn, inspections } = await receive(s, allLines(s, TWO))
    await submit(s.user, inspections[0].id, { qtyAccepted: 10, qtyRejected: 0 })
    const r = await call(listGrns(apiRequest('/api/grns', { user: s.user })))
    expect(r.json.data.items.find((g: { id: string }) => g.id === grn.id).qcPending).toBe(1)
  })

  test('audit log records results, QC completion and posting; inspector placeholder is replaced', async () => {
    const one: LineSpec[] = [{ name: 'Z', qty: 5, rate: 1 }]
    const s = await setup(one)
    const { grn, inspections } = await receive(s, allLines(s, one))
    expect(inspections[0].inspector).toBe('pending')
    const r = await submit(s.user, inspections[0].id, { qtyAccepted: 5, qtyRejected: 0 })
    expect(r.json.data.inspector).toBe(s.user.name)
    await post(s.user, grn.id)
    const details = (await db.auditLog.findMany({ where: { companyId: s.company.id } })).map((a) => a.details).join('\n')
    expect(details).toContain('→ PASSED (accepted 5 / rejected 0)')
    expect(details).toContain('→ QC_COMPLETED')
    expect(details).toContain('Posted')
  })
})

describe('Serial-tracked lines', () => {
  const SERIAL: LineSpec[] = [{ name: 'Meter', qty: 3, rate: 100, serial: true }]

  test('partly accepted: names the accepted serials; only those enter stock', async () => {
    const s = await setup(SERIAL)
    const { grn, inspections } = await receive(s, [{ ...allLines(s, SERIAL)[0], serials: 'S1\nS2\nS3' }])
    expect((await submit(s.user, inspections[0].id, { qtyAccepted: 2, qtyRejected: 1 })).json.error?.code).toBe('QC_SERIALS_INVALID')
    expect((await submit(s.user, inspections[0].id, { qtyAccepted: 2, qtyRejected: 1, acceptedSerials: 'S1\nS9' })).json.error?.code).toBe('QC_SERIALS_INVALID')
    expect((await submit(s.user, inspections[0].id, { qtyAccepted: 2, qtyRejected: 1, acceptedSerials: 'S1\nS3' })).status).toBe(200)
    expect((await post(s.user, grn.id)).status).toBe(200)
    const inStock = await db.itemSerial.findMany({ where: { itemId: s.items[0].id, status: 'IN_STOCK' } })
    expect(inStock.map((x) => x.serialNo).sort()).toEqual(['S1', 'S3'])
  })

  test('fully rejected: no serial enters stock', async () => {
    const s = await setup(SERIAL)
    const { grn, inspections } = await receive(s, [{ ...allLines(s, SERIAL)[0], serials: 'S1\nS2\nS3' }])
    await submit(s.user, inspections[0].id, { qtyAccepted: 0, qtyRejected: 3 })
    expect((await post(s.user, grn.id)).status).toBe(200)
    expect(await db.itemSerial.count({ where: { itemId: s.items[0].id } })).toBe(0)
  })

  test('the GRN needs one serial per received unit', async () => {
    const s = await setup(SERIAL)
    const r = await call(createGrn(apiRequest('/api/grns', { user: s.user, body: { poId: s.po.id, warehouseId: s.warehouse.id, items: [{ ...allLines(s, SERIAL)[0], serials: 'S1' }] } })))
    expect(r.status).toBe(400)
  })
})

describe('Permissions and tenants', () => {
  const ONE: LineSpec[] = [{ name: 'T', qty: 10, rate: 1 }]

  test('a role without QC rights cannot submit results; signed-out is refused', async () => {
    const s = await setup(ONE)
    const { inspections } = await receive(s, allLines(s, ONE))
    for (const role of ['VIEWER', 'SALES_EXECUTIVE', 'ACCOUNTANT']) {
      const u = await seedUser(s.company.id, role)
      expect([role, (await submit(u, inspections[0].id, { qtyAccepted: 10, qtyRejected: 0 })).status]).toEqual([role, 403])
    }
    const anon = await call(patchQc(apiRequest(`/api/qc-inspections/${inspections[0].id}`, { method: 'PATCH', body: { qtyAccepted: 10, qtyRejected: 0 } }), ctx({ id: inspections[0].id })))
    expect(anon.status).toBe(401)
    const inspector = await seedUser(s.company.id, 'QC_INSPECTOR')
    expect((await submit(inspector, inspections[0].id, { qtyAccepted: 10, qtyRejected: 0 })).status).toBe(200)
  })

  test('another company cannot read, submit or post', async () => {
    const s = await setup(ONE)
    const { grn, inspections } = await receive(s, allLines(s, ONE))
    const other = await seedTenant()
    const id = inspections[0].id
    expect((await call(getQc(apiRequest(`/api/qc-inspections/${id}`, { user: other.user }), ctx({ id })))).status).toBe(404)
    expect((await submit(other.user, id, { qtyAccepted: 10, qtyRejected: 0 })).status).toBe(404)
    expect((await post(other.user, grn.id)).status).toBe(404)
    expect((await call(getGrn(apiRequest(`/api/grns/${grn.id}`, { user: other.user }), ctx({ id: grn.id })))).status).toBe(404)
    // Naming the victim's company is refused too
    expect((await submit(other.user, id, { companyId: s.company.id, qtyAccepted: 10, qtyRejected: 0 })).status).toBe(403)
    expect((await call(listQc(apiRequest('/api/qc-inspections', { user: other.user })))).json.data.items.length).toBe(0)
    expect((await db.qcInspection.findUnique({ where: { id } }))!.status).toBe('PENDING')
  })

  test('a manual inspection cannot be attached to a GRN, not even another company’s', async () => {
    const s = await setup(ONE)
    const { grn } = await receive(s, allLines(s, ONE))
    const other = await seedTenant()
    const item = await db.item.create({ data: { companyId: other.company.id, code: 'X', name: 'X', uom: 'NOS' } as never })
    const r = await call(createQc(apiRequest('/api/qc-inspections', { user: other.user, body: { type: 'INCOMING', itemId: item.id, qtyChecked: 10, refType: 'GRN', refId: grn.id } })))
    expect(r.status).toBe(400)
    expect(await db.qcInspection.count({ where: { refId: grn.id } })).toBe(1)
  })

  test('non-GRN inspections follow the same quantity rules', async () => {
    const s = await setup(ONE)
    const c = await call(createQc(apiRequest('/api/qc-inspections', { user: s.user, body: { type: 'FINAL', itemId: s.items[0].id, qtyChecked: 10 } })))
    expect((await submit(s.user, c.json.data.id, { qtyAccepted: 1, qtyRejected: 0 })).status).toBe(400)
    expect((await submit(s.user, c.json.data.id, { qtyAccepted: 8, qtyRejected: 2 })).json.data.status).toBe('PARTIAL')
  })
})

describe('PO completion: rejected material stays outstanding', () => {
  const ONE: LineSpec[] = [{ name: 'Sheet', qty: 100, rate: 50 }]
  const close = (user: TestUser, poId: string, body: Record<string, unknown>) =>
    call(closeQty(apiRequest(`/api/purchase-orders/${poId}/closures`, { user, body }), ctx({ id: poId })))
  const poState = async (user: TestUser, poId: string) => (await call(getPo(apiRequest(`/api/purchase-orders/${poId}`, { user }), ctx({ id: poId })))).json.data

  /** PO of 100, GRN of 100 with 70 accepted and 30 rejected, posted. */
  async function rejected30() {
    const s = await setup(ONE)
    const { grn, inspections } = await receive(s, allLines(s, ONE))
    await submit(s.user, inspections[0].id, { qtyAccepted: 70, qtyRejected: 30 })
    await post(s.user, grn.id)
    return { s, line: allLines(s, ONE)[0] }
  }

  test('the PO shows ordered, received, accepted, rejected and outstanding separately', async () => {
    const { s } = await rejected30()
    const po = await poState(s.user, s.po.id)
    expect(po.status).toBe('PARTIALLY_RECEIVED')
    expect(po.items[0]).toMatchObject({ qty: 100, receivedQty: 100, acceptedQty: 70, rejectedQty: 30, closedQty: 0, outstandingQty: 30, receivableQty: 30 })
  })

  test('fully rejected material leaves everything outstanding; a replacement can be received', async () => {
    const s = await setup(ONE)
    const a = await receive(s, allLines(s, ONE))
    await submit(s.user, a.inspections[0].id, { qtyAccepted: 0, qtyRejected: 100 })
    await post(s.user, a.grn.id)
    expect((await poState(s.user, s.po.id))).toMatchObject({ status: 'PARTIALLY_RECEIVED' })
    const b = await receive(s, allLines(s, ONE))
    await submit(s.user, b.inspections[0].id, { qtyAccepted: 100, qtyRejected: 0 })
    await post(s.user, b.grn.id)
    expect((await poState(s.user, s.po.id)).status).toBe('RECEIVED')
    expect(await stockOf(s.items[0].id)).toBe(100)
  })

  test('a replacement cannot exceed what is outstanding, and material in QC counts against it', async () => {
    const { s, line } = await rejected30()
    const tooMany = await call(createGrn(apiRequest('/api/grns', { user: s.user, body: { poId: s.po.id, warehouseId: s.warehouse.id, items: [{ ...line, receivedQty: 31 }] } })))
    expect(tooMany.status).toBe(400)
    await receive(s, [{ ...line, receivedQty: 20 }])
    expect((await poState(s.user, s.po.id)).items[0].receivableQty).toBe(10)
    const again = await call(createGrn(apiRequest('/api/grns', { user: s.user, body: { poId: s.po.id, warehouseId: s.warehouse.id, items: [{ ...line, receivedQty: 11 }] } })))
    expect(again.status).toBe(400)
  })

  test('waiving the rejected qty completes the PO, with a permanent record and audit entry', async () => {
    const { s, line } = await rejected30()
    const before = { stock: await stockOf(s.items[0].id), ledger: await db.stockLedger.count({ where: { companyId: s.company.id } }) }
    const r = await close(s.user, s.po.id, { poItemId: line.poItemId, qty: 30, type: 'WAIVED', reason: 'Supplier closed the line' })
    expect(r.status).toBe(200)
    expect(r.json.data.status).toBe('RECEIVED')
    const po = await poState(s.user, s.po.id)
    expect(po.items[0]).toMatchObject({ closedQty: 30, outstandingQty: 0, receivedQty: 100, acceptedQty: 70 })
    expect(po.closures[0]).toMatchObject({ qty: 30, type: 'WAIVED', reason: 'Supplier closed the line', createdBy: s.user.name })
    // No stock or money moved
    expect(await stockOf(s.items[0].id)).toBe(before.stock)
    expect(await db.stockLedger.count({ where: { companyId: s.company.id } })).toBe(before.ledger)
    const audit = await db.auditLog.findFirst({ where: { companyId: s.company.id, action: 'CLOSE' } })
    expect(audit!.details).toContain('closed 30 rejected qty as WAIVED')
  })

  test('a partial closure leaves the rest outstanding; a credit note needs its number', async () => {
    const { s, line } = await rejected30()
    expect((await close(s.user, s.po.id, { poItemId: line.poItemId, qty: 10, type: 'CREDIT_NOTE', reason: 'Settled' })).status).toBe(400)
    const r = await close(s.user, s.po.id, { poItemId: line.poItemId, qty: 10, type: 'CREDIT_NOTE', reason: 'Settled', reference: 'CN-77' })
    expect(r.json.data.status).toBe('PARTIALLY_RECEIVED')
    expect((await poState(s.user, s.po.id)).items[0]).toMatchObject({ closedQty: 10, outstandingQty: 20, receivableQty: 20 })
  })

  test('closures are limited: no reason, bad qty, more than rejected, unknown line, closed PO', async () => {
    const { s, line } = await rejected30()
    const base = { poItemId: line.poItemId, type: 'WAIVED', reason: 'x', qty: 5 }
    for (const bad of [{ reason: ' ' }, { qty: 0 }, { qty: -1 }, { qty: 'abc' }, { qty: 31 }, { poItemId: 'nope' }, { type: 'SILENT' }]) {
      expect([bad, (await close(s.user, s.po.id, { ...base, ...bad })).status]).toEqual([bad, 400])
    }
    await close(s.user, s.po.id, { ...base, qty: 30 })
    const closed = await close(s.user, s.po.id, { ...base, qty: 1 })
    expect([closed.status, closed.json.error?.code]).toEqual([409, 'PO_NOT_OPEN'])
    expect(await db.purchaseOrderClosure.count({ where: { poId: s.po.id } })).toBe(1)
  })

  test('accepted material cannot be closed, and neither can material still in QC', async () => {
    const s = await setup(ONE)
    const line = allLines(s, ONE)[0]
    const a = await receive(s, [{ ...line, receivedQty: 50 }])
    await submit(s.user, a.inspections[0].id, { qtyAccepted: 50, qtyRejected: 0 })
    await post(s.user, a.grn.id)
    expect((await close(s.user, s.po.id, { poItemId: line.poItemId, qty: 1, type: 'WAIVED', reason: 'x' })).json.error?.code).toBe('CLOSURE_QTY_TOO_HIGH')
  })

  test('two simultaneous closures cannot both use the same qty', async () => {
    const { s, line } = await rejected30()
    const body = { poItemId: line.poItemId, qty: 30, type: 'WAIVED', reason: 'x' }
    const rs = await Promise.all([close(s.user, s.po.id, body), close(s.user, s.po.id, body)])
    expect(rs.filter((r) => r.status === 200).length).toBe(1)
    expect((await poState(s.user, s.po.id)).items[0].closedQty).toBe(30)
  })

  test('only managers can close; other companies cannot', async () => {
    const { s, line } = await rejected30()
    const body = { poItemId: line.poItemId, qty: 1, type: 'WAIVED', reason: 'x' }
    for (const role of ['PURCHASE_EXECUTIVE', 'VIEWER', 'QC_INSPECTOR']) {
      expect([role, (await close(await seedUser(s.company.id, role), s.po.id, body)).status]).toEqual([role, 403])
    }
    const other = await seedTenant()
    expect((await close(other.user, s.po.id, body)).status).toBe(404)
    expect((await close(await seedUser(s.company.id, 'PURCHASE_MANAGER'), s.po.id, body)).status).toBe(200)
  })

  test('older posted GRNs count by their accepted qty, with no data migration', async () => {
    const s = await setup(ONE)
    const line = allLines(s, ONE)[0]
    const grn = await db.grn.create({ data: { companyId: s.company.id, number: 'OLD-1', poId: s.po.id, warehouseId: s.warehouse.id, date: new Date(), status: 'POSTED', items: { create: [{ poItemId: line.poItemId, itemId: line.itemId, orderedQty: 100, receivedQty: 100, acceptedQty: 90, rejectedQty: 10, qcStatus: 'PARTIAL' }] } } })
    await db.purchaseOrderItem.update({ where: { id: line.poItemId }, data: { receivedQty: 100 } })
    expect(grn.status).toBe('POSTED')
    expect((await poState(s.user, s.po.id)).items[0]).toMatchObject({ acceptedQty: 90, rejectedQty: 10, outstandingQty: 10 })
  })

  test('MRP treats rejected, unclosed material as still incoming, and closed material as not', async () => {
    const { s, line } = await rejected30()
    await db.purchaseOrder.update({ where: { id: s.po.id }, data: { status: 'PARTIALLY_RECEIVED' } })
    const so = await db.customer.create({ data: { companyId: s.company.id, code: 'C', name: 'C' } })
    await db.salesOrder.create({ data: { companyId: s.company.id, number: 'SO-1', customerId: so.id, orderDate: new Date(), status: 'CONFIRMED', items: { create: [{ itemId: s.items[0].id, qty: 200, rate: 1 }] } } as never })
    const incoming = async () => {
      const r = await call(mrp(apiRequest('/api/mrp', { user: s.user })))
      const rows = (r.json.data.rows ?? r.json.data.items ?? r.json.data) as { itemId: string; incoming?: number; onOrder?: number }[]
      const row = rows.find((x) => x.itemId === s.items[0].id)
      return row?.incoming ?? row?.onOrder
    }
    expect(await incoming()).toBe(30)
    await close(s.user, s.po.id, { poItemId: line.poItemId, qty: 30, type: 'WAIVED', reason: 'x' })
    expect(await incoming()).toBe(0)
  })

  test('company backup includes the closures table', () => {
    expect(backupPlan().map((t) => t.model)).toContain('PurchaseOrderClosure')
  })
})

describe('QC correction: the GRN-2627-000002 situation', () => {
  const SPECS: LineSpec[] = [
    { name: 'MS Channel 100', qty: 250, rate: 60 }, { name: 'MS Plate 10mm', qty: 200, rate: 70 },
    { name: 'MS Angle 40x40x5', qty: 150, rate: 55 }, { name: 'Welding Electrode 3.15mm', qty: 20, rate: 300 },
  ]
  const RESULT: Record<string, [number, number]> = {
    'MS Channel 100': [1, 0], 'MS Plate 10mm': [50, 150], 'MS Angle 40x40x5': [150, 0], 'Welding Electrode 3.15mm': [15, 5],
  }
  const correct = (user: TestUser, id: string, body: Record<string, unknown>) =>
    call(postCorrection(apiRequest(`/api/qc-inspections/${id}/corrections`, { user, body }), ctx({ id })))
  const reconcile = (over: Record<string, unknown> = {}) => ({
    qtyAccepted: 1, qtyRejected: 249, basedOn: { qtyAccepted: 1, qtyRejected: 0 }, inspectedBy: 'A. Kulkarni',
    reason: 'Recounted at stores: 249 failed dimension check', physicalCheckConfirmed: true, ...over,
  })

  /** An older GRN as production has it: no line links, typed line qty, one result that does not add up, still PENDING_QC. */
  async function legacyGrn() {
    const s = await setup(SPECS)
    const { grn, inspections } = await receive(s, allLines(s, SPECS))
    for (const qc of inspections) {
      const [qtyAccepted, qtyRejected] = RESULT[s.items.find((i) => i.id === qc.itemId)!.name]
      const status = qtyRejected === 0 ? 'PASSED' : 'PARTIAL'
      await db.qcInspection.update({ where: { id: qc.id }, data: { grnItemId: null, status, qtyAccepted, qtyRejected, inspector: 'old inspector' } })
    }
    for (const l of grn.items) await db.grnItem.update({ where: { id: l.id }, data: { acceptedQty: l.receivedQty, qcStatus: 'PASSED' } })
    const channel = s.items.find((i) => i.name === 'MS Channel 100')!
    const bad = inspections.find((q) => q.itemId === channel.id)!
    return { s, grn, inspections, bad, channel }
  }

  test('blocked and flagged → corrected by a person → QC complete → posted → stock ledger exact', async () => {
    const { s, grn, bad, channel } = await legacyGrn()

    // Before: visible as a problem, and posting changes nothing
    const list = await call(listGrns(apiRequest('/api/grns', { user: s.user })))
    expect(list.json.data.items.find((g: { id: string }) => g.id === grn.id)).toMatchObject({ status: 'PENDING_QC', qcPending: 0, qcUnreconciled: 1 })
    const refused = await post(s.user, grn.id)
    expect([refused.status, refused.json.error?.code]).toEqual([409, 'QC_RESULT_INCOMPLETE'])
    expect(await db.stockBalance.count({ where: { companyId: s.company.id } })).toBe(0)

    // The person states the count; the GRN is the same record throughout
    const r = await correct(s.user, bad.id, reconcile())
    expect(r.status).toBe(200)
    expect(r.json.data).toMatchObject({ status: 'PARTIAL', qtyAccepted: 1, qtyRejected: 249, inspector: 'A. Kulkarni', grnItemId: expect.any(String) })
    expect((await db.grnItem.findFirst({ where: { grnId: grn.id, itemId: channel.id } }))!).toMatchObject({ acceptedQty: 1, rejectedQty: 249, qcStatus: 'PARTIAL' })
    const after = await db.grn.findUnique({ where: { id: grn.id } })
    expect([after!.id, after!.number, after!.status]).toEqual([grn.id, grn.number, 'QC_COMPLETED'])

    // Posting: only accepted qty, at each PO rate
    expect((await post(s.user, grn.id)).status).toBe(200)
    const lines = await db.grnItem.findMany({ where: { grnId: grn.id } })
    expect(lines.reduce((a, l) => a + l.receivedQty, 0)).toBe(620)
    expect(lines.reduce((a, l) => a + l.acceptedQty, 0)).toBe(216)
    expect(lines.reduce((a, l) => a + l.rejectedQty, 0)).toBe(404)
    expect((await db.stockBalance.findMany({ where: { companyId: s.company.id } })).reduce((a, b) => a + b.qty, 0)).toBe(216)
    const ledger = await db.stockLedger.findMany({ where: { refId: grn.id } })
    expect(ledger.map((l) => [l.type, l.qtyIn, l.rate]).sort((a, b) => Number(a[1]) - Number(b[1]))).toEqual([
      ['GRN_IN', 1, 60], ['GRN_IN', 15, 300], ['GRN_IN', 50, 70], ['GRN_IN', 150, 55],
    ])
    // Rejected material remains owed by the supplier
    const po = await db.purchaseOrder.findUnique({ where: { id: s.po.id } })
    expect(po!.status).toBe('PARTIALLY_RECEIVED')
  })

  test('the original result is kept and every correction is appended', async () => {
    const { s, bad } = await legacyGrn()
    await correct(s.user, bad.id, reconcile({ qtyAccepted: 1, qtyRejected: 249 }))
    await correct(s.user, bad.id, reconcile({ qtyAccepted: 10, qtyRejected: 240, basedOn: { qtyAccepted: 1, qtyRejected: 249 }, reason: 'Second count found 9 more good' }))
    const detail = await call(getQc(apiRequest(`/api/qc-inspections/${bad.id}`, { user: s.user }), ctx({ id: bad.id })))
    const rows = detail.json.data.corrections
    expect(rows.map((c: Record<string, unknown>) => [c.previousAccepted, c.previousRejected, c.previousStatus, c.newAccepted, c.newRejected, c.newStatus])).toEqual([
      [1, 0, 'PASSED', 1, 249, 'PARTIAL'],
      [1, 249, 'PARTIAL', 10, 240, 'PARTIAL'],
    ])
    expect(rows[0]).toMatchObject({ previousInspector: 'old inspector', inspectedBy: 'A. Kulkarni', correctedBy: s.user.name, correctedByUserId: s.user.id, grnNumber: expect.any(String) })
    expect(detail.json.data).toMatchObject({ qtyAccepted: 10, qtyRejected: 240 })
    const audit = await db.auditLog.findMany({ where: { companyId: s.company.id, action: 'CORRECT' } })
    expect(audit.length).toBe(2)
    expect(audit.map((a) => a.details).join()).toContain('accepted 1 / rejected 0 (PASSED) → accepted 1 / rejected 249 (PARTIAL)')
    // The list marks it, and the API offers no way to change history
    const list = await call(listQc(apiRequest('/api/qc-inspections', { user: s.user })))
    expect(list.json.data.items.find((q: { id: string }) => q.id === bad.id).correctionCount).toBe(2)
    expect(Object.keys(correctionsRoute).sort()).toEqual(['POST'])
  })

  test('the missing 249 are never classified for the user', async () => {
    const { s, grn, bad } = await legacyGrn()
    // Leaving it as it is, or naming only part of it, is refused; nothing else is assumed
    for (const body of [{ qtyAccepted: 1, qtyRejected: 0 }, { qtyAccepted: 1, qtyRejected: 100 }, { qtyAccepted: 1, qtyRejected: undefined }]) {
      const r = await correct(s.user, bad.id, reconcile(body))
      expect(r.status).toBe(400)
    }
    expect((await db.qcInspection.findUnique({ where: { id: bad.id } }))!).toMatchObject({ qtyAccepted: 1, qtyRejected: 0, status: 'PASSED' })
    expect(await db.qcCorrection.count({ where: { grnId: grn.id } })).toBe(0)
    expect((await db.grn.findUnique({ where: { id: grn.id } }))!.status).toBe('PENDING_QC')
    // Any honest split is accepted: it is the person's count, not a rule
    expect((await correct(s.user, bad.id, reconcile({ qtyAccepted: 200, qtyRejected: 50 }))).json.data).toMatchObject({ qtyAccepted: 200, qtyRejected: 50 })
  })

  test('a correction needs a reason, an inspector, the physical check and a real change', async () => {
    const { s, bad } = await legacyGrn()
    const cases: [Record<string, unknown>, string][] = [
      [{ reason: 'short' }, 'QC_REASON_REQUIRED'], [{ reason: '          ' }, 'QC_REASON_REQUIRED'],
      [{ inspectedBy: '  ' }, 'QC_INSPECTOR_REQUIRED'], [{ physicalCheckConfirmed: false }, 'QC_CHECK_NOT_CONFIRMED'],
      [{ physicalCheckConfirmed: 'yes' }, 'QC_CHECK_NOT_CONFIRMED'], [{ qtyAccepted: -1, qtyRejected: 251 }, 'QC_QTY_INVALID'], [{ qtyAccepted: 'x' }, 'QC_QTY_INVALID'],
    ]
    for (const [over, code] of cases) expect([over, (await correct(s.user, bad.id, reconcile(over))).json.error?.code]).toEqual([over, code])
    expect((await correct(s.user, bad.id, reconcile())).status).toBe(200)
    const same = await correct(s.user, bad.id, reconcile({ basedOn: { qtyAccepted: 1, qtyRejected: 249 } }))
    expect(same.json.error?.code).toBe('QC_NO_CHANGE')
    expect(await db.qcCorrection.count({ where: { inspectionId: bad.id } })).toBe(1)
  })

  test('someone working from old values is stopped; two at once cannot both save', async () => {
    const { s, bad } = await legacyGrn()
    const stale = await correct(s.user, bad.id, reconcile({ basedOn: { qtyAccepted: 5, qtyRejected: 5 } }))
    expect([stale.status, stale.json.error?.code]).toEqual([409, 'QC_CHANGED'])
    const missing = await correct(s.user, bad.id, reconcile({ basedOn: undefined }))
    expect(missing.json.error?.code).toBe('QC_CHANGED')
    const rs = await Promise.all([correct(s.user, bad.id, reconcile()), correct(s.user, bad.id, reconcile({ qtyAccepted: 2, qtyRejected: 248 }))])
    expect(rs.filter((r) => r.status === 200).length).toBe(1)
    expect(await db.qcCorrection.count({ where: { inspectionId: bad.id } })).toBe(1)
  })

  test('a posted GRN cannot be corrected; a pending result cannot either', async () => {
    const one: LineSpec[] = [{ name: 'Q', qty: 10, rate: 1 }, { name: 'R', qty: 5, rate: 1 }]
    const s = await setup(one)
    const { grn, inspections } = await receive(s, allLines(s, one))
    const body = { qtyAccepted: 1, qtyRejected: 9, basedOn: { qtyAccepted: 10, qtyRejected: 0 }, inspectedBy: 'X', reason: 'Long enough reason', physicalCheckConfirmed: true }
    expect((await correct(s.user, inspections[0].id, body)).json.error?.code).toBe('QC_NOT_SUBMITTED')
    for (const q of inspections) await submit(s.user, q.id, { qtyAccepted: q.qtyChecked, qtyRejected: 0 })
    await post(s.user, grn.id)
    const before = await stockOf(s.items[0].id)
    const r = await correct(s.user, inspections.find((q) => q.qtyChecked === 10)!.id, body)
    expect([r.status, r.json.error?.code]).toEqual([409, 'GRN_NOT_CORRECTABLE'])
    expect(await stockOf(s.items[0].id)).toBe(before)
  })

  test('correcting a QC_COMPLETED GRN keeps it completed and posting uses the corrected qty', async () => {
    const one: LineSpec[] = [{ name: 'Q2', qty: 10, rate: 4 }]
    const s = await setup(one)
    const { grn, inspections } = await receive(s, allLines(s, one))
    await submit(s.user, inspections[0].id, { qtyAccepted: 10, qtyRejected: 0 })
    await correct(s.user, inspections[0].id, reconcile({ qtyAccepted: 6, qtyRejected: 4, basedOn: { qtyAccepted: 10, qtyRejected: 0 } }))
    expect((await db.grn.findUnique({ where: { id: grn.id } }))!.status).toBe('QC_COMPLETED')
    await post(s.user, grn.id)
    expect(await stockOf(s.items[0].id)).toBe(6)
  })

  test('with two results to reconcile the GRN stays blocked until both are fixed', async () => {
    const two: LineSpec[] = [{ name: 'U', qty: 10, rate: 1 }, { name: 'V', qty: 20, rate: 1 }]
    const s = await setup(two)
    const { grn, inspections } = await receive(s, allLines(s, two))
    for (const q of inspections) await db.qcInspection.update({ where: { id: q.id }, data: { status: 'PASSED', qtyAccepted: 1, qtyRejected: 0 } })
    const fix = (q: typeof inspections[number]) => correct(s.user, q.id, reconcile({ qtyAccepted: 1, qtyRejected: q.qtyChecked - 1 }))
    await fix(inspections[0])
    expect((await db.grn.findUnique({ where: { id: grn.id } }))!.status).toBe('PENDING_QC')
    expect((await post(s.user, grn.id)).json.error?.code).toBe('QC_RESULT_INCOMPLETE')
    await fix(inspections[1])
    expect((await db.grn.findUnique({ where: { id: grn.id } }))!.status).toBe('QC_COMPLETED')
    expect((await post(s.user, grn.id)).status).toBe(200)
  })

  test('only quality managers and administrators may correct; other companies cannot', async () => {
    const { s, bad } = await legacyGrn()
    for (const role of ['QC_INSPECTOR', 'VIEWER', 'PURCHASE_MANAGER', 'STORE_MANAGER']) {
      expect([role, (await correct(await seedUser(s.company.id, role), bad.id, reconcile())).status]).toEqual([role, 403])
    }
    const other = await seedTenant()
    expect((await correct(other.user, bad.id, reconcile())).status).toBe(404)
    expect((await correct(other.user, bad.id, reconcile({ companyId: s.company.id }))).status).toBe(403)
    const anon = await call(postCorrection(apiRequest(`/api/qc-inspections/${bad.id}/corrections`, { body: reconcile() }), ctx({ id: bad.id })))
    expect(anon.status).toBe(401)
    expect(await db.qcCorrection.count({ where: { inspectionId: bad.id } })).toBe(0)
    expect((await correct(await seedUser(s.company.id, 'QUALITY_MANAGER'), bad.id, reconcile())).status).toBe(200)
  })

  test('non-GRN inspections are not correctable here', async () => {
    const one: LineSpec[] = [{ name: 'W', qty: 5, rate: 1 }]
    const s = await setup(one)
    const c = await call(createQc(apiRequest('/api/qc-inspections', { user: s.user, body: { type: 'FINAL', itemId: s.items[0].id, qtyChecked: 5 } })))
    await submit(s.user, c.json.data.id, { qtyAccepted: 5, qtyRejected: 0 })
    expect((await correct(s.user, c.json.data.id, reconcile({ qtyAccepted: 1, qtyRejected: 4 }))).status).toBe(400)
  })

  test('serial-tracked: a correction cannot accept units whose serials left the line', async () => {
    const one: LineSpec[] = [{ name: 'Meter2', qty: 3, rate: 9, serial: true }]
    const s = await setup(one)
    const { grn, inspections } = await receive(s, [{ ...allLines(s, one)[0], serials: 'A1\nA2\nA3' }])
    await submit(s.user, inspections[0].id, { qtyAccepted: 2, qtyRejected: 1, acceptedSerials: 'A1\nA2' })
    const base = { basedOn: { qtyAccepted: 2, qtyRejected: 1 } }
    expect((await correct(s.user, inspections[0].id, reconcile({ ...base, qtyAccepted: 3, qtyRejected: 0 }))).json.error?.code).toBe('QC_SERIALS_INVALID')
    expect((await correct(s.user, inspections[0].id, reconcile({ ...base, qtyAccepted: 1, qtyRejected: 2, acceptedSerials: 'A2' }))).status).toBe(200)
    await post(s.user, grn.id)
    expect((await db.itemSerial.findMany({ where: { itemId: s.items[0].id, status: 'IN_STOCK' } })).map((x) => x.serialNo)).toEqual(['A2'])
  })

  test('tables are in the company backup', () => {
    expect(backupPlan().map((t) => t.model)).toEqual(expect.arrayContaining(['QcCorrection', 'PurchaseOrderClosure']))
  })
})
