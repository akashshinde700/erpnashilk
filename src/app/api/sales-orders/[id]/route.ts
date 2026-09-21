import { db } from '@/lib/db'
import { ok, fail, handleError, companyRequired, nextDocNumber, computeGst, isInterState, postStock, logAudit, notify, ApiError, r2, requireWrite } from '@/lib/erp-helpers'

// SalesOrderItem carries only itemId (no Prisma relation to Item) — attach master info via JS mapping
async function withItemInfo<T extends { items: { itemId: string }[] }>(companyId: string, docs: T[]) {
  const ids = Array.from(new Set(docs.flatMap((d) => d.items.map((i) => i.itemId))))
  const masters = ids.length
    ? await db.item.findMany({ where: { companyId, id: { in: ids } }, select: { id: true, code: true, name: true, uom: true } })
    : []
  const map = new Map(masters.map((m) => [m.id, m]))
  return docs.map((d) => ({ ...d, items: d.items.map((i) => ({ ...i, item: map.get(i.itemId) || null })) }))
}

// GET /api/sales-orders/[id]?companyId=  — full detail (customer + items + linked quotation + counts)
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const companyId = await companyRequired(req)
    const so = await db.salesOrder.findFirst({
      where: { id, companyId },
      include: { customer: true, items: true },
    })
    if (!so) throw new ApiError('Sales order not found', 404)

    // SalesOrder.quotationId has no Prisma relation — attach via JS
    const quotation = so.quotationId
      ? await db.quotation.findFirst({ where: { id: so.quotationId, companyId }, select: { id: true, number: true, status: true } })
      : null

    const [deliveriesCount, invoicesCount] = await Promise.all([
      db.deliveryChallan.count({ where: { salesOrderId: id, companyId } }),
      db.salesInvoice.count({ where: { salesOrderId: id, companyId } }),
    ])

    const [row] = await withItemInfo(companyId, [{ ...so, quotation, deliveriesCount, invoicesCount }])
    return ok(row)
  } catch (e) {
    return handleError(e)
  }
}

// PATCH /api/sales-orders/[id]
//  - { action: 'confirm' }  : DRAFT → CONFIRMED
//  - { action: 'cancel' }   : → CANCELLED (blocked if any dispatched qty)
//  - otherwise: edit fields/lines (DRAFT only, lines replaced, totals recomputed)
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireWrite(req, 'sales-orders')
    const { id } = await params
    const body = await req.json().catch(() => ({}) as any)
    const companyId = await companyRequired(req, body.companyId)

    const current = await db.salesOrder.findFirst({ where: { id, companyId }, include: { items: true } })
    if (!current) throw new ApiError('Sales order not found', 404)

    // ---- Workflow actions ----
    if (body.action === 'confirm') {
      if (current.status !== 'DRAFT') throw new ApiError(`Only DRAFT sales orders can be confirmed (current: ${current.status})`, 400)
      const updated = await db.$transaction(async (tx) => {
        const t = tx as any
        const u = await tx.salesOrder.update({ where: { id }, data: { status: 'CONFIRMED' } })
        await logAudit(t, {
          companyId, userName: body.userName, action: 'APPROVE', entity: 'SalesOrder', entityId: id,
          details: `Sales order ${current.number} confirmed`,
        })
        return u
      })
      return ok(updated, 'Sales order confirmed')
    }

    if (body.action === 'cancel') {
      if (['CANCELLED', 'COMPLETED'].includes(current.status)) {
        throw new ApiError(`Sales order is already ${current.status}`, 400)
      }
      const dispatched = current.items.some((i) => i.dispatchedQty > 0.005)
      if (dispatched) throw new ApiError('Cannot cancel: one or more items already dispatched', 400)
      const updated = await db.$transaction(async (tx) => {
        const t = tx as any
        const u = await tx.salesOrder.update({ where: { id }, data: { status: 'CANCELLED' } })
        await logAudit(t, {
          companyId, userName: body.userName, action: 'CANCEL', entity: 'SalesOrder', entityId: id,
          details: `Sales order ${current.number} cancelled`,
        })
        return u
      })
      return ok(updated, 'Sales order cancelled')
    }

    if (body.action) throw new ApiError(`Unknown action "${body.action}" (use confirm | cancel)`, 400)

    // ---- Edit (DRAFT only) ----
    if (current.status !== 'DRAFT') throw new ApiError('Sales order can only be edited while DRAFT', 400)

    let customerId = current.customerId
    if (body.customerId !== undefined && body.customerId !== current.customerId) {
      const cust = await db.customer.findFirst({ where: { id: body.customerId, companyId } })
      if (!cust) throw new ApiError('Customer not found', 404)
      customerId = body.customerId
    }

    let itemsCreate: any[] | null = null
    let totals: ReturnType<typeof computeGst> | null = null
    if (Array.isArray(body.items)) {
      if (!body.items.length) throw new ApiError('At least one order line is required', 400)
      const itemIds = Array.from(new Set<string>(body.items.map((l: any) => String(l.itemId))))
      const itemCount = await db.item.count({ where: { companyId, id: { in: itemIds } } })
      if (itemCount !== itemIds.length) throw new ApiError('One or more itemId values are invalid for this company', 400)

      const lines = body.items.map((l: any) => {
        if (!l.itemId) throw new ApiError('itemId is required on every line', 400)
        const qty = Number(l.qty)
        const rate = Number(l.rate)
        if (!(qty > 0)) throw new ApiError('Line qty must be greater than 0', 400)
        if (Number.isNaN(rate) || rate < 0) throw new ApiError('Line rate must be 0 or more', 400)
        return {
          itemId: String(l.itemId),
          qty: r2(qty),
          rate: r2(rate),
          discountPct: Number(l.discountPct ?? 0) || 0,
          gstRate: l.gstRate === undefined || l.gstRate === null || l.gstRate === '' ? 18 : Number(l.gstRate),
        }
      })

      const [company, customer] = await Promise.all([
        db.company.findUnique({ where: { id: companyId } }),
        db.customer.findUnique({ where: { id: customerId } }),
      ])
      const interState = isInterState(company?.state, customer?.state)
      const t2 = computeGst(lines, interState)
      totals = t2
      itemsCreate = lines.map((l, i) => ({
        itemId: l.itemId,
        qty: l.qty,
        rate: l.rate,
        discountPct: l.discountPct,
        gstRate: l.gstRate,
        lineTotal: r2(t2.computed[i].taxable),
      }))
    }

    const updated = await db.$transaction(async (tx) => {
      const t = tx as any
      const data: any = {}
      if (body.customerId !== undefined) data.customerId = customerId
      if (body.orderDate !== undefined) data.orderDate = new Date(body.orderDate)
      if (body.deliveryDate !== undefined) data.deliveryDate = body.deliveryDate ? new Date(body.deliveryDate) : null
      if (body.notes !== undefined) data.notes = body.notes ?? null
      if (itemsCreate && totals) {
        data.subtotal = totals.subtotal
        data.discountTotal = totals.discountTotal
        data.cgst = totals.cgst
        data.sgst = totals.sgst
        data.igst = totals.igst
        data.grandTotal = totals.grandTotal
        await tx.salesOrderItem.deleteMany({ where: { salesOrderId: id } })
        data.items = { create: itemsCreate }
      }
      const upd = await tx.salesOrder.update({
        where: { id },
        data,
        include: { customer: true, items: true },
      })
      await logAudit(t, {
        companyId, userName: body.userName, action: 'UPDATE', entity: 'SalesOrder', entityId: id,
        details: `Updated sales order ${current.number}`,
      })
      return upd
    })

    const [row] = await withItemInfo(companyId, [updated])
    return ok(row, 'Sales order updated')
  } catch (e) {
    return handleError(e)
  }
}

// DELETE /api/sales-orders/[id]?companyId=  — only when DRAFT
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireWrite(req, 'sales-orders')
    const { id } = await params
    const body = await req.json().catch(() => ({}) as any)
    const companyId = await companyRequired(req, body?.companyId)

    const current = await db.salesOrder.findFirst({ where: { id, companyId } })
    if (!current) throw new ApiError('Sales order not found', 404)
    if (current.status !== 'DRAFT') throw new ApiError(`Only DRAFT sales orders can be deleted (current: ${current.status})`, 400)

    await db.$transaction(async (tx) => {
      const t = tx as any
      await tx.salesOrder.delete({ where: { id } })
      await logAudit(t, {
        companyId, userName: body?.userName, action: 'DELETE', entity: 'SalesOrder',
        entityId: id, details: `Deleted sales order ${current.number}`,
      })
    })
    return ok({ id }, 'Sales order deleted')
  } catch (e) {
    return handleError(e)
  }
}
