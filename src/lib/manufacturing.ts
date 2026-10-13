import { ApiError, postStock, r2 } from '@/lib/erp-helpers'
import { batchNote, consumeBatches } from '@/lib/batches'

/** Component qty needed to make `units` of the BOM output (per-unit qty ÷ BOM output qty, plus component scrap %). */
export function componentNeed(units: number, bom: { outputQty?: number | null }, comp: { qty: number; scrapPct?: number | null }): number {
  const perUnit = (comp.qty || 0) / (bom.outputQty && bom.outputQty > 0 ? bom.outputQty : 1)
  return r2(units * perUnit * (1 + (comp.scrapPct || 0) / 100))
}

export const BACKFLUSH_TYPE = 'BACKFLUSH_OUT'

/** Material already consumed by a work order, per item: posted material issues + earlier backflushes. */
export async function consumedByItem(tx: any, companyId: string, workOrderId: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  const issues = await tx.materialIssue.findMany({
    where: { companyId, workOrderId, status: { not: 'CANCELLED' } },
    select: { items: { select: { itemId: true, issuedQty: true } } },
  })
  for (const mi of issues) for (const l of mi.items) out[l.itemId] = r2((out[l.itemId] || 0) + (l.issuedQty || 0))
  const flushed = await tx.stockLedger.findMany({
    where: { companyId, refType: 'WORK_ORDER', refId: workOrderId, type: BACKFLUSH_TYPE },
    select: { itemId: true, qtyOut: true },
  })
  for (const l of flushed) out[l.itemId] = r2((out[l.itemId] || 0) + (l.qtyOut || 0))
  return out
}

/**
 * Backflush: when production is reported, consume the BOM components that the reported output
 * needs but that were not already issued to the work order. Draws from raw-material stores first,
 * then any other store holding stock. If anything is short, nothing is posted and the error lists
 * every short component.
 */
export async function backflushComponents(tx: any, input: {
  companyId: string
  wo: { id: string; number: string; bomId: string | null }
  unitsTotal: number // produced + rejected + scrap after this entry
}): Promise<{ itemId: string; qty: number }[]> {
  const { companyId, wo, unitsTotal } = input
  if (!wo.bomId) return []
  const bom = await tx.bom.findFirst({ where: { id: wo.bomId, companyId }, include: { items: true } })
  if (!bom || !bom.items.length) return []

  const consumed = await consumedByItem(tx, companyId, wo.id)
  const needs = new Map<string, number>()
  for (const c of bom.items) needs.set(c.itemId, r2((needs.get(c.itemId) || 0) + componentNeed(unitsTotal, bom, c)))

  // What still has to come out of stock now
  const plan: { itemId: string; short: number }[] = []
  for (const [itemId, need] of needs) {
    const short = r2(need - (consumed[itemId] || 0))
    if (short > 0.0001) plan.push({ itemId, short })
  }
  if (!plan.length) return []

  // Availability per store (raw-material stores first, then most stock)
  const balances = await tx.stockBalance.findMany({
    where: { companyId, itemId: { in: plan.map((p) => p.itemId) }, qty: { gt: 0 } },
    select: { itemId: true, warehouseId: true, qty: true, avgRate: true },
  })
  const whTypes = new Map<string, string>(
    (await tx.warehouse.findMany({ where: { companyId }, select: { id: true, type: true } })).map((w: { id: string; type: string }) => [w.id, w.type]),
  )
  const shortages: string[] = []
  for (const p of plan) {
    const have = balances.filter((b: { itemId: string }) => b.itemId === p.itemId).reduce((s: number, b: { qty: number }) => s + b.qty, 0)
    if (have + 0.0001 < p.short) {
      const it = await tx.item.findUnique({ where: { id: p.itemId }, select: { code: true, name: true, uom: true } })
      shortages.push(`${it ? `${it.code} ${it.name}` : p.itemId}: need ${r2(p.short)}${it?.uom ? ` ${it.uom}` : ''}, in stock ${r2(have)}`)
    }
  }
  if (shortages.length) {
    throw new ApiError(`Not enough raw material for this production — ${shortages.join('; ')}. Receive stock (GRN) or adjust the BOM, then post again.`, 409)
  }

  const posted: { itemId: string; qty: number }[] = []
  for (const p of plan) {
    const stores = balances
      .filter((b: { itemId: string }) => b.itemId === p.itemId)
      .sort((a: { warehouseId: string; qty: number }, b: { warehouseId: string; qty: number }) =>
        (whTypes.get(a.warehouseId) === 'RM' ? 0 : 1) - (whTypes.get(b.warehouseId) === 'RM' ? 0 : 1) || b.qty - a.qty)
    let left = p.short
    for (const s of stores) {
      if (left <= 0.0001) break
      const take = r2(Math.min(left, s.qty))
      if (take <= 0) continue
      // Batch-tracked components: FEFO across that store's batches (legacy un-batched stock last);
      // taken first so the ledger note records the split. No-op for untracked items.
      const allocs = await consumeBatches(tx, { companyId, itemId: p.itemId, warehouseId: s.warehouseId, qty: take })
      await postStock(tx, {
        companyId, itemId: p.itemId, warehouseId: s.warehouseId, type: BACKFLUSH_TYPE,
        qtyOut: take, rate: s.avgRate, refType: 'WORK_ORDER', refId: wo.id, refNumber: wo.number,
        notes: `Auto-consumed for production on ${wo.number}${batchNote(allocs)}`,
      })
      left = r2(left - take)
    }
    posted.push({ itemId: p.itemId, qty: p.short })
  }
  return posted
}
