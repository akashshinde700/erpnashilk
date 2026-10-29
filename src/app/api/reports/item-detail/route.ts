import { db } from '@/lib/db'
import { ok, handleError, companyRequired, ApiError, r2, requireRead } from '@/lib/erp-helpers'
import { parsePeriod } from '@/lib/accounting'

// GET /api/reports/item-detail?companyId=&itemId=&from=&to=&warehouseId?
// Opening qty, every stock movement of the period with a running qty, closing qty & value,
// plus sales / purchase qty & value in the period.
// Opening qty = current balance − movements dated ≥ from; closing value uses the CURRENT average rate.
export async function GET(req: Request) {
  try {
    requireRead(req, 'reports') // Phase 5: financial read permission
    const companyId = await companyRequired(req)
    const { searchParams } = new URL(req.url)
    const itemId = (searchParams.get('itemId') || '').trim()
    if (!itemId) throw new ApiError('itemId is required', 400)
    const warehouseId = (searchParams.get('warehouseId') || '').trim() || undefined
    const { fromStr, toStr, from, to } = parsePeriod(searchParams)

    const item = await db.item.findFirst({
      where: { id: itemId, companyId },
      select: { id: true, code: true, name: true, uom: true, type: true, hsn: true, reorderLevel: true },
    })
    if (!item) throw new ApiError('Item not found', 404)

    const wh = warehouseId ? { warehouseId } : {}
    const [balances, after, moves, warehouses, salesLines, purchaseLines, salesReturnLines, purchaseReturnLines] = await Promise.all([
      db.stockBalance.findMany({ where: { companyId, itemId, ...wh }, select: { qty: true, avgRate: true } }),
      db.stockLedger.aggregate({ where: { companyId, itemId, ...wh, date: { gte: from } }, _sum: { qtyIn: true, qtyOut: true } }),
      db.stockLedger.findMany({
        where: { companyId, itemId, ...wh, date: { gte: from, lte: to } },
        orderBy: [{ date: 'asc' }, { createdAt: 'asc' }],
        select: { id: true, date: true, type: true, refType: true, refNumber: true, warehouseId: true, qtyIn: true, qtyOut: true, rate: true, notes: true, reasonType: true },
      }),
      db.warehouse.findMany({ where: { companyId }, select: { id: true, code: true, name: true } }),
      db.salesInvoiceItem.findMany({
        where: { itemId, invoice: { companyId, status: { not: 'CANCELLED' }, date: { gte: from, lte: to } } },
        select: { qty: true, lineTotal: true },
      }),
      db.purchaseInvoiceItem.findMany({
        where: { itemId, invoice: { companyId, status: { not: 'CANCELLED' }, date: { gte: from, lte: to } } },
        select: { qty: true, lineTotal: true },
      }),
      db.salesReturnItem.findMany({
        where: { itemId, ret: { companyId, status: { not: 'CANCELLED' }, date: { gte: from, lte: to } } },
        select: { qty: true, lineTotal: true },
      }),
      db.purchaseReturnItem.findMany({
        where: { itemId, ret: { companyId, status: { not: 'CANCELLED' }, date: { gte: from, lte: to } } },
        select: { qty: true, lineTotal: true },
      }),
    ])
    const whMap = new Map(warehouses.map((w) => [w.id, w]))

    const currentQty = balances.reduce((s, b) => s + (b.qty || 0), 0)
    const currentValue = balances.reduce((s, b) => s + (b.qty || 0) * (b.avgRate || 0), 0)
    const avgRate = currentQty > 0 ? currentValue / currentQty : (balances[0]?.avgRate || 0)
    const openingQty = r2(currentQty - ((after._sum.qtyIn || 0) - (after._sum.qtyOut || 0)))

    let running = openingQty
    const items = moves.map((m) => {
      running = r2(running + (m.qtyIn || 0) - (m.qtyOut || 0))
      const w = whMap.get(m.warehouseId)
      return {
        id: m.id,
        date: m.date,
        type: m.type,
        refType: m.refType,
        refNumber: m.refNumber,
        warehouse: w ? w.code : '—',
        qtyIn: r2(m.qtyIn || 0),
        qtyOut: r2(m.qtyOut || 0),
        runningQty: running,
        rate: r2(m.rate || 0),
        notes: [m.reasonType, m.notes].filter(Boolean).join(' · ') || null,
      }
    })
    const totalIn = r2(moves.reduce((s, m) => s + (m.qtyIn || 0), 0))
    const totalOut = r2(moves.reduce((s, m) => s + (m.qtyOut || 0), 0))
    const closingQty = r2(openingQty + totalIn - totalOut)

    const agg = (rows: { qty: number; lineTotal: number }[]) => ({
      qty: r2(rows.reduce((s, l) => s + (l.qty || 0), 0)),
      value: r2(rows.reduce((s, l) => s + (l.lineTotal || 0), 0)),
    })

    return ok({
      item,
      from: fromStr,
      to: toStr,
      openingQty,
      openingValue: r2(Math.max(0, openingQty) * avgRate),
      items,
      totals: { in: totalIn, out: totalOut },
      closingQty,
      avgRate: r2(avgRate),
      closingValue: r2(Math.max(0, closingQty) * avgRate),
      sales: agg(salesLines),
      salesReturns: agg(salesReturnLines),
      purchases: agg(purchaseLines),
      purchaseReturns: agg(purchaseReturnLines),
    })
  } catch (e) {
    return handleError(e)
  }
}
