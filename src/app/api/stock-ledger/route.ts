import { db } from '@/lib/db'
import { ok, handleError, companyRequired, ApiError } from '@/lib/erp-helpers'

// GET /api/stock-ledger?companyId=&itemId=&type=&from=&to=&limit=
export async function GET(req: Request) {
  try {
    const companyId = await companyRequired(req)
    const { searchParams } = new URL(req.url)
    const itemId = searchParams.get('itemId') || undefined
    const type = searchParams.get('type') || undefined
    const from = searchParams.get('from') || undefined
    const to = searchParams.get('to') || undefined
    const warehouseId = searchParams.get('warehouseId') || undefined
    const refNumber = searchParams.get('refNumber') || undefined

    const limitRaw = parseInt(searchParams.get('limit') || '', 10)
    const limit = Math.min(Math.max(isNaN(limitRaw) ? 200 : limitRaw, 1), 500)

    const where: Record<string, unknown> = { companyId }
    if (itemId) where.itemId = itemId
    if (type) where.type = type
    if (warehouseId) where.warehouseId = warehouseId
    if (refNumber) where.refNumber = { contains: refNumber }

    if (from || to) {
      const date: Record<string, Date> = {}
      if (from) {
        const d = new Date(from)
        if (isNaN(d.getTime())) throw new ApiError('Invalid from date', 400)
        date.gte = d
      }
      if (to) {
        const d = new Date(to)
        if (isNaN(d.getTime())) throw new ApiError('Invalid to date', 400)
        // include the whole "to" day when only a date (no time) is supplied
        if (to.length <= 10) d.setHours(23, 59, 59, 999)
        date.lte = d
      }
      where.date = date
    }

    const [ledger, warehouses] = await Promise.all([
      db.stockLedger.findMany({
        where,
        include: {
          item: { select: { code: true, name: true, uom: true } },
        },
        orderBy: { date: 'desc' },
        take: limit,
      }),
      db.warehouse.findMany({ where: { companyId }, select: { id: true, code: true, name: true } }),
    ])
    const whMap = new Map(warehouses.map((w) => [w.id, w]))

    // StockLedger has no warehouse relation in the schema — join in JS
    const items = ledger.map((l) => ({ ...l, warehouse: whMap.get(l.warehouseId) || null }))

    return ok({ items, total: items.length })
  } catch (e) {
    return handleError(e)
  }
}
