import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { ok, handleError, companyRequired } from '@/lib/erp-helpers'

// ============================== GET /api/batches ==============================
// ?itemId= &warehouseId= &expiringInDays= (expiry on/before today + N days, incl. already expired)
// &includeEmpty=1 (also batches with qty 0) &q= (batch no)
// Rows are in FEFO order (earliest expiry first, no expiry last, then oldest) with item / warehouse names.
export async function GET(req: Request) {
  try {
    const companyId = await companyRequired(req)
    const sp = new URL(req.url).searchParams
    const itemId = (sp.get('itemId') || '').trim()
    const warehouseId = (sp.get('warehouseId') || '').trim()
    const q = (sp.get('q') || '').trim()
    const includeEmpty = sp.get('includeEmpty') === '1'
    const daysRaw = (sp.get('expiringInDays') || '').trim()
    const days = daysRaw === '' ? NaN : Number(daysRaw)

    const where: Prisma.ItemBatchWhereInput = { companyId }
    if (itemId) where.itemId = itemId
    if (warehouseId) where.warehouseId = warehouseId
    if (q) where.batchNo = { contains: q }
    if (!includeEmpty) where.qty = { gt: 0.0005 }
    if (Number.isFinite(days)) {
      const until = new Date()
      until.setHours(23, 59, 59, 999)
      until.setDate(until.getDate() + Math.max(0, Math.floor(days)))
      where.expiryDate = { not: null, lte: until }
    }

    const rows = await db.itemBatch.findMany({ where, take: 2000 })
    rows.sort((a, b) => {
      const ea = a.expiryDate ? a.expiryDate.getTime() : Number.POSITIVE_INFINITY
      const eb = b.expiryDate ? b.expiryDate.getTime() : Number.POSITIVE_INFINITY
      return ea !== eb ? ea - eb : a.createdAt.getTime() - b.createdAt.getTime()
    })

    const itemIds = Array.from(new Set(rows.map((r) => r.itemId)))
    const whIds = Array.from(new Set(rows.map((r) => r.warehouseId)))
    const [items, warehouses] = await Promise.all([
      itemIds.length ? db.item.findMany({ where: { companyId, id: { in: itemIds } }, select: { id: true, code: true, name: true, uom: true } }) : [],
      whIds.length ? db.warehouse.findMany({ where: { companyId, id: { in: whIds } }, select: { id: true, code: true, name: true } }) : [],
    ])
    const im = new Map(items.map((i) => [i.id, i] as const))
    const wm = new Map(warehouses.map((w) => [w.id, w] as const))
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const out = rows.map((r) => ({
      ...r,
      qty: Math.round(r.qty * 1000) / 1000,
      daysToExpiry: r.expiryDate ? Math.floor((r.expiryDate.getTime() - today.getTime()) / 86400000) : null,
      item: im.get(r.itemId) || null,
      warehouse: wm.get(r.warehouseId) || null,
    }))
    return ok({ items: out, total: out.length })
  } catch (e) {
    return handleError(e)
  }
}
