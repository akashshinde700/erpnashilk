import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { ok, handleError, companyRequired } from '@/lib/erp-helpers'

// ============================== GET /api/serials ==============================
// ?itemId= &status= (IN_STOCK|SOLD|RETURNED_TO_SUPPLIER) &warehouseId= &q= (serial no contains)
// Each row carries item / warehouse names and the document numbers it came in on / went out on.
export async function GET(req: Request) {
  try {
    const companyId = await companyRequired(req)
    const sp = new URL(req.url).searchParams
    const itemId = (sp.get('itemId') || '').trim()
    const status = (sp.get('status') || '').trim()
    const warehouseId = (sp.get('warehouseId') || '').trim()
    const q = (sp.get('q') || '').trim()

    const where: Prisma.ItemSerialWhereInput = { companyId }
    if (itemId) where.itemId = itemId
    if (status) where.status = status
    if (warehouseId) where.warehouseId = warehouseId
    if (q) where.serialNo = { contains: q }
    const rows = await db.itemSerial.findMany({ where, orderBy: [{ updatedAt: 'desc' }], take: 500 })

    const itemIds = Array.from(new Set(rows.map((r) => r.itemId)))
    const whIds = Array.from(new Set(rows.map((r) => r.warehouseId).filter((x): x is string => !!x)))
    // Resolve in / out document numbers per ref type
    const idsOf = (type: string) => Array.from(new Set(rows.flatMap((r) => [
      r.inRefType === type ? r.inRefId : null, r.outRefType === type ? r.outRefId : null,
    ]).filter((x): x is string => !!x)))
    const sel = { id: true, number: true, date: true } as const
    const [items, warehouses, grns, dns, invs, srets, prets, pinvs] = await Promise.all([
      itemIds.length ? db.item.findMany({ where: { companyId, id: { in: itemIds } }, select: { id: true, code: true, name: true, uom: true } }) : [],
      whIds.length ? db.warehouse.findMany({ where: { companyId, id: { in: whIds } }, select: { id: true, code: true, name: true } }) : [],
      db.grn.findMany({ where: { companyId, id: { in: idsOf('GRN') } }, select: sel }),
      db.deliveryChallan.findMany({ where: { companyId, id: { in: idsOf('DELIVERY') } }, select: sel }),
      db.salesInvoice.findMany({ where: { companyId, id: { in: idsOf('SALES_INVOICE') } }, select: sel }),
      db.salesReturn.findMany({ where: { companyId, id: { in: idsOf('SALES_RETURN') } }, select: sel }),
      db.purchaseReturn.findMany({ where: { companyId, id: { in: idsOf('PURCHASE_RETURN') } }, select: sel }),
      db.purchaseInvoice.findMany({ where: { companyId, id: { in: idsOf('PURCHASE_INVOICE') } }, select: sel }),
    ])
    const refMap = new Map<string, { number: string; date: Date }>()
    const put = (type: string, list: { id: string; number: string; date: Date }[]) => list.forEach((d) => refMap.set(`${type}:${d.id}`, d))
    put('GRN', grns); put('DELIVERY', dns); put('SALES_INVOICE', invs); put('SALES_RETURN', srets); put('PURCHASE_RETURN', prets); put('PURCHASE_INVOICE', pinvs)
    const ref = (type: string | null, id: string | null) => {
      if (!type || !id) return null
      const d = refMap.get(`${type}:${id}`)
      return { type, id, number: d?.number ?? null, date: d?.date ?? null }
    }
    const im = new Map(items.map((i) => [i.id, i] as const))
    const wm = new Map(warehouses.map((w) => [w.id, w] as const))
    const out = rows.map((r) => ({
      ...r,
      item: im.get(r.itemId) || null,
      warehouse: r.warehouseId ? wm.get(r.warehouseId) || null : null,
      inRef: ref(r.inRefType, r.inRefId),
      outRef: ref(r.outRefType, r.outRefId),
    }))
    return ok({ items: out, total: out.length })
  } catch (e) {
    return handleError(e)
  }
}
