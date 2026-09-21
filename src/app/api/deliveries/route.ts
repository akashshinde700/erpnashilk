import { db } from '@/lib/db'
import { ok, fail, handleError, companyRequired, nextDocNumber, computeGst, isInterState, postStock, logAudit, notify, ApiError, r2 } from '@/lib/erp-helpers'

// DeliveryChallanItem carries only itemId (no Prisma relation to Item) — attach master info via JS mapping
async function withItemInfo<T extends { items: { itemId: string }[] }>(companyId: string, docs: T[]) {
  const ids = Array.from(new Set(docs.flatMap((d) => d.items.map((i) => i.itemId))))
  const masters = ids.length
    ? await db.item.findMany({ where: { companyId, id: { in: ids } }, select: { id: true, code: true, name: true, uom: true } })
    : []
  const map = new Map(masters.map((m) => [m.id, m]))
  return docs.map((d) => ({ ...d, items: d.items.map((i) => ({ ...i, item: map.get(i.itemId) || null })) }))
}

// GET /api/deliveries?companyId=&salesOrderId=&status=&q=
export async function GET(req: Request) {
  try {
    const companyId = await companyRequired(req)
    const { searchParams } = new URL(req.url)
    const salesOrderId = (searchParams.get('salesOrderId') || '').trim()
    const status = (searchParams.get('status') || '').trim()
    const q = (searchParams.get('q') || '').trim()

    const where: any = { companyId }
    if (salesOrderId) where.salesOrderId = salesOrderId
    if (status) where.status = status
    if (q) where.number = { contains: q }

    const rows = await db.deliveryChallan.findMany({
      where,
      orderBy: { date: 'desc' },
      include: {
        salesOrder: {
          select: { number: true, customerId: true, customer: { select: { name: true } } },
        },
        items: true,
      },
    })
    const items = await withItemInfo(companyId, rows)
    return ok({ items, total: items.length })
  } catch (e) {
    return handleError(e)
  }
}

// POST /api/deliveries  { companyId, salesOrderId, warehouseId, date?, vehicleNo?, transporter?, notes?, lines: [{salesOrderItemId, itemId?, qty}] }
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}) as any)
    const companyId = await companyRequired(req, body.companyId)

    if (!body.salesOrderId) throw new ApiError('salesOrderId is required', 400)
    if (!body.warehouseId) throw new ApiError('warehouseId is required', 400)
    const rawLines: any[] = Array.isArray(body.lines) ? body.lines : []
    if (!rawLines.length) throw new ApiError('At least one delivery line is required', 400)

    const warehouse = await db.warehouse.findFirst({ where: { id: body.warehouseId, companyId } })
    if (!warehouse) throw new ApiError('Warehouse not found', 404)

    const date = body.date ? new Date(body.date) : new Date()

    const created = await db.$transaction(async (tx) => {
      const t = tx as any
      const so = await tx.salesOrder.findFirst({ where: { id: body.salesOrderId, companyId }, include: { items: true } })
      if (!so) throw new ApiError('Sales order not found', 404)
      const ALLOWED = ['CONFIRMED', 'IN_PRODUCTION', 'READY', 'PARTIALLY_DISPATCHED']
      if (!ALLOWED.includes(so.status)) {
        throw new ApiError(`Sales order ${so.number} cannot be dispatched in ${so.status} status`, 400)
      }

      const soItemMap = new Map(so.items.map((si) => [si.id, si]))
      const lineData = rawLines.map((l) => {
        const soItem = l.salesOrderItemId ? soItemMap.get(String(l.salesOrderItemId)) : undefined
        if (!soItem) throw new ApiError('Each line needs a valid salesOrderItemId from this sales order', 400)
        const qty = Number(l.qty)
        if (!(qty > 0)) throw new ApiError('Line qty must be greater than 0', 400)
        const pending = r2(soItem.qty - soItem.dispatchedQty)
        if (r2(qty) > pending) throw new ApiError('Line qty exceeds pending qty')
        return {
          salesOrderItemId: soItem.id,
          itemId: l.itemId ? String(l.itemId) : soItem.itemId,
          qty: r2(qty),
        }
      })

      const number = await nextDocNumber(t, companyId, 'DN', date)
      const dn = await tx.deliveryChallan.create({
        data: {
          companyId,
          number,
          salesOrderId: so.id,
          warehouseId: body.warehouseId,
          date,
          vehicleNo: body.vehicleNo ?? null,
          transporter: body.transporter ?? null,
          notes: body.notes ?? null,
          status: 'DRAFT',
          items: { create: lineData },
        },
      })
      await logAudit(t, {
        companyId, userName: body.userName, action: 'CREATE', entity: 'DeliveryChallan', entityId: dn.id,
        details: `Delivery challan ${number} drafted against ${so.number}`,
      })
      return dn
    })

    const full = await db.deliveryChallan.findFirst({
      where: { id: created.id, companyId },
      include: {
        salesOrder: {
          select: { number: true, customerId: true, customer: { select: { name: true } } },
        },
        items: true,
      },
    })
    const [row] = await withItemInfo(companyId, full ? [full] : [])
    return ok(row, 'Delivery challan created')
  } catch (e) {
    return handleError(e)
  }
}
