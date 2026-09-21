import { db } from '@/lib/db'
import { ok, handleError, companyRequired, r2 } from '@/lib/erp-helpers'

// GET /api/reports/stock-valuation?companyId=&warehouseId?&type?
// Valuation snapshot grouped per item across warehouses (StockBalance has no warehouse relation → JS attach).
export async function GET(req: Request) {
  try {
    const companyId = await companyRequired(req)
    const { searchParams } = new URL(req.url)
    const warehouseId = searchParams.get('warehouseId') || undefined
    const type = searchParams.get('type') || undefined

    const [balances, warehouses] = await Promise.all([
      db.stockBalance.findMany({
        where: { companyId, ...(warehouseId ? { warehouseId } : {}) },
        include: {
          item: { select: { id: true, code: true, name: true, type: true, uom: true, reorderLevel: true } },
        },
      }),
      db.warehouse.findMany({ where: { companyId }, select: { id: true, code: true, name: true } }),
    ])
    const whMap = new Map(warehouses.map((w) => [w.id, w]))

    interface WhRow { code: string; name: string; qty: number; value: number }
    interface Agg {
      itemId: string; code: string; name: string; type: string; uom: string; reorderLevel: number
      totalQty: number; value: number; warehouses: WhRow[]
    }
    const groups = new Map<string, Agg>()
    for (const b of balances) {
      if (type && b.item.type !== type) continue
      let g = groups.get(b.itemId)
      if (!g) {
        g = {
          itemId: b.itemId,
          code: b.item.code,
          name: b.item.name,
          type: b.item.type,
          uom: b.item.uom,
          reorderLevel: b.item.reorderLevel,
          totalQty: 0,
          value: 0,
          warehouses: [],
        }
        groups.set(b.itemId, g)
      }
      const qty = b.qty || 0
      const value = r2(qty * (b.avgRate || 0))
      g.totalQty = r2(g.totalQty + qty)
      g.value = r2(g.value + value)
      const w = whMap.get(b.warehouseId)
      if (qty !== 0 && w) g.warehouses.push({ code: w.code, name: w.name, qty: r2(qty), value })
    }

    const items = Array.from(groups.values())
      .map((g) => ({
        ...g,
        // qty-weighted average rate across balances: Σ(qty·avgRate) / Σqty
        avgRate: g.totalQty > 0 ? r2(g.value / g.totalQty) : 0,
        low: g.reorderLevel > 0 && g.totalQty <= g.reorderLevel,
        warehouses: g.warehouses.sort((a, b) => a.code.localeCompare(b.code)),
      }))
      .sort((a, b) => a.code.localeCompare(b.code))

    const totals = {
      skus: items.length,
      value: r2(items.reduce((s, i) => s + i.value, 0)),
      lowStock: items.filter((i) => i.low).length,
      totalQty: r2(items.reduce((s, i) => s + i.totalQty, 0)),
    }

    const byTypeMap = new Map<string, number>()
    for (const i of items) byTypeMap.set(i.type, r2((byTypeMap.get(i.type) || 0) + i.value))
    const byType = Array.from(byTypeMap.entries())
      .map(([t, value]) => ({ type: t, value }))
      .sort((a, b) => b.value - a.value)

    return ok({ items, totals, byType })
  } catch (e) {
    return handleError(e)
  }
}
