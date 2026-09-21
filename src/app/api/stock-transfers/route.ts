import { db } from '@/lib/db'
import { ok, handleError, companyRequired, nextDocNumber, postStock, logAudit, ApiError, r2, requireWrite } from '@/lib/erp-helpers'

// GET /api/stock-transfers?companyId= — TRANSFER_OUT ledger rows (UI pairs with TRANSFER_IN)
export async function GET(req: Request) {
  try {
    const companyId = await companyRequired(req)
    const { searchParams } = new URL(req.url)
    const itemId = searchParams.get('itemId') || undefined

    const [rows, warehouses] = await Promise.all([
      db.stockLedger.findMany({
        where: {
          companyId, type: 'TRANSFER_OUT',
          ...(itemId ? { itemId } : {}),
        },
        include: {
          item: { select: { code: true, name: true, uom: true } },
        },
        orderBy: { date: 'desc' },
        take: 100,
      }),
      db.warehouse.findMany({ where: { companyId }, select: { id: true, code: true, name: true } }),
    ])
    const whMap = new Map(warehouses.map((w) => [w.id, w]))

    // StockLedger has no warehouse relation in the schema — join in JS
    const items = rows.map((l) => ({ ...l, warehouse: whMap.get(l.warehouseId) || null }))

    return ok({ items, total: items.length })
  } catch (e) {
    return handleError(e)
  }
}

// POST /api/stock-transfers  { fromWarehouseId, toWarehouseId, date?, notes?, userName?, lines: [{itemId, qty}] }
export async function POST(req: Request) {
  try {
    requireWrite(req, 'stock-transfers')
    const body = await req.json().catch(() => ({}) as any)
    const companyId = await companyRequired(req, body.companyId)
    const { fromWarehouseId, toWarehouseId, date, notes, userName, lines } = body

    if (!fromWarehouseId || !toWarehouseId) throw new ApiError('fromWarehouseId and toWarehouseId are required', 400)
    if (fromWarehouseId === toWarehouseId) throw new ApiError('Source and destination warehouses must be different', 400)
    if (!Array.isArray(lines) || lines.length === 0) throw new ApiError('At least one transfer line is required', 400)

    const [fromWh, toWh] = await Promise.all([
      db.warehouse.findFirst({ where: { id: fromWarehouseId, companyId } }),
      db.warehouse.findFirst({ where: { id: toWarehouseId, companyId } }),
    ])
    if (!fromWh) throw new ApiError('Source warehouse not found', 404)
    if (!toWh) throw new ApiError('Destination warehouse not found', 404)

    const transferDate = date ? new Date(date) : new Date()
    if (isNaN(transferDate.getTime())) throw new ApiError('Invalid date', 400)

    const cleanLines = lines
      .map((l: any) => ({ itemId: String(l.itemId || ''), qty: r2(Number(l.qty) || 0) }))
      .filter((l: any) => l.itemId)
    if (cleanLines.length === 0) throw new ApiError('At least one transfer line is required', 400)
    for (const l of cleanLines) {
      if (l.qty <= 0) throw new ApiError('Transfer qty must be greater than 0', 400)
    }

    const result = await db.$transaction(async (tx) => {
      const itemIds = Array.from(new Set(cleanLines.map((l: any) => l.itemId)))
      const itemRows = await tx.item.findMany({ where: { id: { in: itemIds }, companyId } })
      const itemMap = new Map(itemRows.map((i) => [i.id, i]))
      for (const l of cleanLines) {
        if (!itemMap.has(l.itemId)) throw new ApiError(`Item not found: ${l.itemId}`, 404)
      }

      // Availability in the source warehouse
      const balances = await tx.stockBalance.findMany({
        where: { companyId, warehouseId: fromWarehouseId, itemId: { in: itemIds } },
      })
      const balMap = new Map(balances.map((b) => [b.itemId, b]))
      for (const l of cleanLines) {
        const item = itemMap.get(l.itemId)!
        const available = r2(balMap.get(l.itemId)?.qty || 0)
        if (available < l.qty) {
          throw new ApiError(`Insufficient stock in ${fromWh.code}: ${item.code} (available ${r2(available)}, needed ${r2(l.qty)})`, 400)
        }
      }

      const number = await nextDocNumber(tx as any, companyId, 'TRF', transferDate)

      for (const l of cleanLines) {
        const item = itemMap.get(l.itemId)!
        const bal = balMap.get(l.itemId)
        const rate = bal?.avgRate && bal.avgRate > 0 ? bal.avgRate : item.standardCost

        await postStock(tx as any, {
          companyId, itemId: l.itemId, warehouseId: fromWarehouseId, type: 'TRANSFER_OUT',
          qtyOut: l.qty, rate, date: transferDate,
          refType: 'TRANSFER', refNumber: number, notes,
        })
        await postStock(tx as any, {
          companyId, itemId: l.itemId, warehouseId: toWarehouseId, type: 'TRANSFER_IN',
          qtyIn: l.qty, rate, date: transferDate,
          refType: 'TRANSFER', refNumber: number, notes,
        })
      }

      await logAudit(tx as any, {
        companyId, userName, action: 'POST', entity: 'StockTransfer',
        details: `Transfer ${number}: ${cleanLines.length} line(s) from ${fromWh.code} to ${toWh.code}`,
      })

      return {
        number,
        date: transferDate,
        fromWarehouseId,
        toWarehouseId,
        lines: cleanLines.length,
        totalQty: r2(cleanLines.reduce((s: number, l: any) => s + l.qty, 0)),
      }
    })

    return ok(result, `Stock transfer ${result.number} posted`)
  } catch (e) {
    return handleError(e)
  }
}
