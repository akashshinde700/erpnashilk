import { db } from '@/lib/db'
import { ok, fail, handleError, companyRequired, nextDocNumber, computeGst, isInterStateParty, postStock, logAudit, notify, ApiError, r2, requireWrite, claimStatus } from '@/lib/erp-helpers'

// Status machine: DRAFT → SENT → APPROVED | REJECTED; CANCELLED from DRAFT/SENT
const QT_TRANSITIONS: Record<string, string[]> = {
  DRAFT: ['SENT', 'CANCELLED'],
  SENT: ['APPROVED', 'REJECTED', 'CANCELLED'],
}

// QuotationItem carries only itemId (no Prisma relation to Item) — attach master info via JS mapping
async function withItemInfo<T extends { items: { itemId: string }[] }>(companyId: string, docs: T[]) {
  const ids = Array.from(new Set(docs.flatMap((d) => d.items.map((i) => i.itemId))))
  const masters = ids.length
    ? await db.item.findMany({ where: { companyId, id: { in: ids } }, select: { id: true, code: true, name: true, uom: true } })
    : []
  const map = new Map(masters.map((m) => [m.id, m]))
  return docs.map((d) => ({ ...d, items: d.items.map((i) => ({ ...i, item: map.get(i.itemId) || null })) }))
}

// GET /api/quotations/[id]?companyId=
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const companyId = await companyRequired(req)
    const quotation = await db.quotation.findFirst({
      where: { id, companyId },
      include: { customer: true, items: true },
    })
    if (!quotation) throw new ApiError('Quotation not found', 404)

    // Quotation.enquiryId has no Prisma relation — attach via JS
    const enquiry = quotation.enquiryId
      ? await db.enquiry.findFirst({ where: { id: quotation.enquiryId, companyId }, select: { id: true, number: true, status: true } })
      : null
    const [row] = await withItemInfo(companyId, [{ ...quotation, enquiry }])
    return ok(row)
  } catch (e) {
    return handleError(e)
  }
}

// PATCH /api/quotations/[id]  { companyId, fields.../items? } and/or { status }
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireWrite(req, 'quotations')
    const { id } = await params
    const body = await req.json().catch(() => ({}) as any)
    const companyId = await companyRequired(req, body.companyId)

    const current = await db.quotation.findFirst({ where: { id, companyId } })
    if (!current) throw new ApiError('Quotation not found', 404)

    const statusChange = !!body.status && body.status !== current.status
    if (statusChange) {
      const allowed = QT_TRANSITIONS[current.status]
      if (!allowed || !allowed.includes(body.status)) {
        throw new ApiError(`Invalid status transition ${current.status} → ${body.status}`, 400)
      }
    }

    const wantsEdit =
      body.customerId !== undefined || body.date !== undefined || body.validUntil !== undefined ||
      body.notes !== undefined || Array.isArray(body.items)
    if (wantsEdit && current.status !== 'DRAFT') throw new ApiError('Quotation can only be edited while DRAFT', 400)

    let customerId = current.customerId
    if (body.customerId !== undefined && body.customerId !== current.customerId) {
      const cust = await db.customer.findFirst({ where: { id: body.customerId, companyId } })
      if (!cust) throw new ApiError('Customer not found', 404)
      customerId = body.customerId
    }

    let itemsCreate: any[] | null = null
    let totals: ReturnType<typeof computeGst> | null = null
    if (Array.isArray(body.items)) {
      if (!body.items.length) throw new ApiError('At least one quotation line is required', 400)
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
      const interState = isInterStateParty(company ?? {}, customer ?? {})
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
      // Atomic guard: the status read above must still hold on the locked row
      if (statusChange) {
        await claimStatus(t.quotation, id, [current.status], body.status)
      } else {
        const g = await tx.quotation.updateMany({ where: { id, status: current.status }, data: { updatedAt: new Date() } })
        if (g.count !== 1) throw new ApiError('This document was just changed by someone else — refresh and try again', 409)
      }
      const data: any = {}
      if (body.customerId !== undefined) data.customerId = customerId
      if (body.date !== undefined) data.date = new Date(body.date)
      if (body.validUntil !== undefined) data.validUntil = body.validUntil ? new Date(body.validUntil) : null
      if (body.notes !== undefined) data.notes = body.notes ?? null
      if (statusChange) data.status = body.status
      if (itemsCreate && totals) {
        data.subtotal = totals.subtotal
        data.discountTotal = totals.discountTotal
        data.cgst = totals.cgst
        data.sgst = totals.sgst
        data.igst = totals.igst
        data.grandTotal = totals.grandTotal
        await tx.quotationItem.deleteMany({ where: { quotationId: id } })
        data.items = { create: itemsCreate }
      }
      const upd = await tx.quotation.update({
        where: { id },
        data,
        include: { customer: true, items: true },
      })
      await logAudit(t, {
        companyId, userName: body.userName, action: 'UPDATE', entity: 'Quotation', entityId: id,
        details: statusChange ? `Status ${current.status} → ${body.status}` : `Updated quotation ${current.number}`,
      })
      return upd
    })

    const [row] = await withItemInfo(companyId, [updated])
    return ok(row, 'Quotation updated')
  } catch (e) {
    return handleError(e)
  }
}

// DELETE /api/quotations/[id]?companyId=  — only when DRAFT
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireWrite(req, 'quotations')
    const { id } = await params
    const body = await req.json().catch(() => ({}) as any)
    const companyId = await companyRequired(req, body?.companyId)

    const current = await db.quotation.findFirst({ where: { id, companyId } })
    if (!current) throw new ApiError('Quotation not found', 404)
    if (current.status !== 'DRAFT') throw new ApiError(`Only DRAFT quotations can be deleted (current: ${current.status})`, 400)

    await db.$transaction(async (tx) => {
      const t = tx as any
      const del = await tx.quotation.deleteMany({ where: { id, status: 'DRAFT' } })
      if (del.count !== 1) throw new ApiError('This document was just changed by someone else — refresh and try again', 409)
      // If this draft was quoted from an enquiry, reopen the enquiry
      if (current.enquiryId) {
        const enq = await tx.enquiry.findFirst({ where: { id: current.enquiryId, companyId } })
        if (enq && enq.status === 'QUOTED') {
          await tx.enquiry.update({ where: { id: enq.id }, data: { status: 'OPEN' } })
        }
      }
      await logAudit(t, {
        companyId, userName: body?.userName, action: 'DELETE', entity: 'Quotation',
        entityId: id, details: `Deleted quotation ${current.number}`,
      })
    })
    return ok({ id }, 'Quotation deleted')
  } catch (e) {
    return handleError(e)
  }
}
