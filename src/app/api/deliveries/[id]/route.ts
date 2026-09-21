import { db } from '@/lib/db'
import { ok, fail, handleError, companyRequired, nextDocNumber, computeGst, isInterState, postStock, logAudit, notify, ApiError, r2, requireWrite } from '@/lib/erp-helpers'

// DeliveryChallanItem carries only itemId (no Prisma relation to Item) — attach master info via JS mapping
async function withItemInfo<T extends { items: { itemId: string }[] }>(companyId: string, docs: T[]) {
  const ids = Array.from(new Set(docs.flatMap((d) => d.items.map((i) => i.itemId))))
  const masters = ids.length
    ? await db.item.findMany({ where: { companyId, id: { in: ids } }, select: { id: true, code: true, name: true, uom: true, hsn: true } })
    : []
  const map = new Map(masters.map((m) => [m.id, m]))
  return docs.map((d) => ({ ...d, items: d.items.map((i) => ({ ...i, item: map.get(i.itemId) || null })) }))
}

// GET /api/deliveries/[id]?companyId=
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const companyId = await companyRequired(req)
    const challan = await db.deliveryChallan.findFirst({
      where: { id, companyId },
      include: {
        salesOrder: {
          include: { customer: { select: { name: true, gstin: true, city: true, state: true, stateCode: true, addressLine: true } } },
        },
        items: true,
      },
    })
    if (!challan) throw new ApiError('Delivery challan not found', 404)

    // DeliveryChallan.warehouseId has no Prisma relation — attach via JS
    const warehouse = await db.warehouse.findFirst({
      where: { id: challan.warehouseId, companyId },
      select: { id: true, code: true, name: true, location: true },
    })
    // Consignor (our company) block for the challan print — DeliveryChallan has no
    // company relation in the schema, so fetch + attach via JS (mirrors sales-invoices detail).
    const company = await db.company.findUnique({
      where: { id: companyId },
      select: { name: true, gstin: true, addressLine: true, city: true, state: true, stateCode: true, phone: true, email: true },
    })
    const [row] = await withItemInfo(companyId, [{ ...challan, warehouse, company }])
    return ok(row)
  } catch (e) {
    return handleError(e)
  }
}

// PATCH /api/deliveries/[id]
//  - { action: 'dispatch' } : DRAFT → DISPATCHED, posts DISPATCH_OUT stock + updates SO dispatchedQty/status
//  - { action: 'cancel' }   : only when DRAFT
//  - otherwise: edit vehicleNo/transporter/notes/date (DRAFT only)
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireWrite(req, 'deliveries')
    const { id } = await params
    const body = await req.json().catch(() => ({}) as any)
    const companyId = await companyRequired(req, body.companyId)

    const current = await db.deliveryChallan.findFirst({ where: { id, companyId }, include: { items: true } })
    if (!current) throw new ApiError('Delivery challan not found', 404)

    // ---- Dispatch: post stock out + update SO ----
    if (body.action === 'dispatch') {
      if (current.status !== 'DRAFT') throw new ApiError(`Only DRAFT challans can be dispatched (current: ${current.status})`, 400)
      if (!current.items.length) throw new ApiError('Challan has no items to dispatch', 400)

      const result = await db.$transaction(async (tx) => {
        const t = tx as any
        // rate = SO item rate, fallback item.sellingPrice
        const soItems = await tx.salesOrderItem.findMany({ where: { salesOrderId: current.salesOrderId } })
        const soItemMap = new Map(soItems.map((si) => [si.id, si]))
        const itemIds = Array.from(new Set(current.items.map((ci) => ci.itemId)))
        const masterItems = await tx.item.findMany({ where: { id: { in: itemIds } }, select: { id: true, sellingPrice: true } })
        const priceMap = new Map(masterItems.map((m) => [m.id, m.sellingPrice]))

        for (const ci of current.items) {
          const soItem = ci.salesOrderItemId ? soItemMap.get(ci.salesOrderItemId) : undefined
          const rate = soItem ? soItem.rate : (priceMap.get(ci.itemId) || 0)
          await postStock(t, {
            companyId,
            itemId: ci.itemId,
            warehouseId: current.warehouseId,
            type: 'DISPATCH_OUT',
            qtyOut: ci.qty,
            rate,
            refType: 'DELIVERY',
            refId: current.id,
            refNumber: current.number,
            date: current.date,
            notes: `Dispatched on challan ${current.number}`,
          })
          if (ci.salesOrderItemId) {
            await tx.salesOrderItem.update({
              where: { id: ci.salesOrderItemId },
              data: { dispatchedQty: { increment: ci.qty } },
            })
          }
        }

        // Roll SO status up: DISPATCHED when every line fully dispatched
        const fresh = await tx.salesOrderItem.findMany({ where: { salesOrderId: current.salesOrderId } })
        const allDone = fresh.length > 0 && fresh.every((si) => r2(si.dispatchedQty) >= r2(si.qty) - 0.005)
        const soStatus = allDone ? 'DISPATCHED' : 'PARTIALLY_DISPATCHED'
        await tx.salesOrder.update({ where: { id: current.salesOrderId }, data: { status: soStatus } })

        const upd = await tx.deliveryChallan.update({ where: { id }, data: { status: 'DISPATCHED' } })
        await logAudit(t, {
          companyId, userName: body.userName, action: 'POST', entity: 'DeliveryChallan', entityId: id,
          details: `Dispatched ${current.number} — stock posted out, sales order ${soStatus}`,
        })
        return upd
      })
      return ok(result, 'Challan dispatched, stock updated')
    }

    // ---- Cancel (only DRAFT, nothing was posted yet) ----
    if (body.action === 'cancel') {
      if (current.status !== 'DRAFT') throw new ApiError(`Only DRAFT challans can be cancelled (current: ${current.status})`, 400)
      const updated = await db.$transaction(async (tx) => {
        const t = tx as any
        const u = await tx.deliveryChallan.update({ where: { id }, data: { status: 'CANCELLED' } })
        await logAudit(t, {
          companyId, userName: body.userName, action: 'CANCEL', entity: 'DeliveryChallan', entityId: id,
          details: `Cancelled delivery challan ${current.number}`,
        })
        return u
      })
      return ok(updated, 'Challan cancelled')
    }

    if (body.action) throw new ApiError(`Unknown action "${body.action}" (use dispatch | cancel)`, 400)

    // ---- Light edit (DRAFT only) ----
    if (current.status !== 'DRAFT') throw new ApiError('Delivery challan can only be edited while DRAFT', 400)
    const updated = await db.$transaction(async (tx) => {
      const t = tx as any
      const data: any = {}
      if (body.vehicleNo !== undefined) data.vehicleNo = body.vehicleNo ?? null
      if (body.transporter !== undefined) data.transporter = body.transporter ?? null
      if (body.notes !== undefined) data.notes = body.notes ?? null
      if (body.date !== undefined) data.date = new Date(body.date)
      const u = await tx.deliveryChallan.update({
        where: { id },
        data,
        include: {
          salesOrder: {
            select: { number: true, customerId: true, customer: { select: { name: true } } },
          },
          items: true,
        },
      })
      await logAudit(t, {
        companyId, userName: body.userName, action: 'UPDATE', entity: 'DeliveryChallan', entityId: id,
        details: `Updated delivery challan ${current.number}`,
      })
      return u
    })
    const [row] = await withItemInfo(companyId, [updated])
    return ok(row, 'Challan updated')
  } catch (e) {
    return handleError(e)
  }
}

// DELETE /api/deliveries/[id]?companyId=  — only when DRAFT
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireWrite(req, 'deliveries')
    const { id } = await params
    const body = await req.json().catch(() => ({}) as any)
    const companyId = await companyRequired(req, body?.companyId)

    const current = await db.deliveryChallan.findFirst({ where: { id, companyId } })
    if (!current) throw new ApiError('Delivery challan not found', 404)
    if (current.status !== 'DRAFT') throw new ApiError(`Only DRAFT challans can be deleted (current: ${current.status})`, 400)

    await db.$transaction(async (tx) => {
      const t = tx as any
      await tx.deliveryChallan.delete({ where: { id } })
      await logAudit(t, {
        companyId, userName: body?.userName, action: 'DELETE', entity: 'DeliveryChallan',
        entityId: id, details: `Deleted delivery challan ${current.number}`,
      })
    })
    return ok({ id }, 'Delivery challan deleted')
  } catch (e) {
    return handleError(e)
  }
}
