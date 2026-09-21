import { db } from '@/lib/db'
import { ok, handleError, companyRequired, r2 } from '@/lib/erp-helpers'

// GET /api/stock?companyId= — balances with item + warehouse, valuation + low stock count
export async function GET(req: Request) {
  try {
    const companyId = await companyRequired(req)

    const [balances, warehouses] = await Promise.all([
      db.stockBalance.findMany({
        where: { companyId },
        include: {
          item: { select: { code: true, name: true, uom: true, type: true, reorderLevel: true } },
        },
      }),
      db.warehouse.findMany({ where: { companyId }, select: { id: true, code: true, name: true } }),
    ])
    const whMap = new Map(warehouses.map((w) => [w.id, w]))

    const items = balances
      .map((b) => ({
        id: b.id,
        itemId: b.itemId,
        warehouseId: b.warehouseId,
        qty: b.qty,
        avgRate: b.avgRate,
        item: b.item,
        warehouse: whMap.get(b.warehouseId) || null,
      }))
      .sort(
        (a, b) =>
          (a.item?.code || '').localeCompare(b.item?.code || '') ||
          (a.warehouse?.code || '').localeCompare(b.warehouse?.code || '')
      )

    const totalValue = r2(items.reduce((s, i) => s + i.qty * i.avgRate, 0))
    const lowStockCount = items.filter((i) => i.item && i.item.reorderLevel > 0 && i.qty <= i.item.reorderLevel).length

    return ok({ items, totalValue, lowStockCount })
  } catch (e) {
    return handleError(e)
  }
}
