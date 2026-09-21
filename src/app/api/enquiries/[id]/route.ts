import { db } from '@/lib/db'
import { ok, fail, handleError, companyRequired, nextDocNumber, computeGst, isInterState, postStock, logAudit, notify, ApiError, r2, requireWrite } from '@/lib/erp-helpers'

// Status machine: OPEN → QUOTED | WON | LOST | CLOSED
const NEXT_STATUSES = ['QUOTED', 'WON', 'LOST', 'CLOSED']

// Enquiry carries a plain customerId + item lines without Prisma relations — resolve via JS mapping
async function withRelations<T extends { customerId: string; items: { itemId: string }[] }>(companyId: string, docs: T[]) {
  const itemIds = Array.from(new Set(docs.flatMap((d) => d.items.map((i) => i.itemId))))
  const customerIds = Array.from(new Set(docs.map((d) => d.customerId)))
  const [items, customers] = await Promise.all([
    itemIds.length
      ? db.item.findMany({ where: { companyId, id: { in: itemIds } }, select: { id: true, code: true, name: true, uom: true } })
      : Promise.resolve([] as { id: string; code: string; name: string; uom: string }[]),
    customerIds.length
      ? db.customer.findMany({ where: { companyId, id: { in: customerIds } } })
      : Promise.resolve([] as { id: string; name: string }[]),
  ])
  const itemMap = new Map(items.map((m) => [m.id, m]))
  const custMap = new Map(customers.map((c) => [c.id, c]))
  return docs.map((d) => ({
    ...d,
    customer: custMap.get(d.customerId) ?? null,
    items: d.items.map((i) => ({ ...i, item: itemMap.get(i.itemId) || null })),
  }))
}

// GET /api/enquiries/[id]?companyId=
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const companyId = await companyRequired(req)
    const enquiry = await db.enquiry.findFirst({
      where: { id, companyId },
      include: { items: true },
    })
    if (!enquiry) throw new ApiError('Enquiry not found', 404)
    const [row] = await withRelations(companyId, [enquiry])
    return ok(row)
  } catch (e) {
    return handleError(e)
  }
}

// PATCH /api/enquiries/[id]  { companyId, fields.../items? } OR { status }
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireWrite(req, 'enquiries')
    const { id } = await params
    const body = await req.json().catch(() => ({}) as any)
    const companyId = await companyRequired(req, body.companyId)

    const current = await db.enquiry.findFirst({ where: { id, companyId } })
    if (!current) throw new ApiError('Enquiry not found', 404)

    const statusChange = !!body.status && body.status !== current.status
    if (statusChange) {
      if (!NEXT_STATUSES.includes(body.status)) {
        throw new ApiError(`Invalid status "${body.status}" (allowed: ${NEXT_STATUSES.join(', ')})`, 400)
      }
      if (current.status !== 'OPEN') {
        throw new ApiError(`Status change not allowed: enquiry is ${current.status} (only OPEN enquiries can move to ${NEXT_STATUSES.join('/')})`, 400)
      }
    }

    const wantsEdit =
      body.customerId !== undefined || body.date !== undefined || body.contactName !== undefined ||
      body.source !== undefined || body.notes !== undefined || Array.isArray(body.items)
    if (wantsEdit && current.status !== 'OPEN') throw new ApiError('Enquiry can only be edited while OPEN', 400)

    if (body.customerId !== undefined && body.customerId !== current.customerId) {
      const cust = await db.customer.findFirst({ where: { id: body.customerId, companyId } })
      if (!cust) throw new ApiError('Customer not found', 404)
    }

    let lineData: any[] | null = null
    if (Array.isArray(body.items)) {
      if (!body.items.length) throw new ApiError('At least one enquiry item is required', 400)
      const itemIds = Array.from(new Set<string>(body.items.map((l: any) => String(l.itemId))))
      const itemCount = await db.item.count({ where: { companyId, id: { in: itemIds } } })
      if (itemCount !== itemIds.length) throw new ApiError('One or more itemId values are invalid for this company', 400)
      for (const l of body.items) {
        if (!l.itemId) throw new ApiError('itemId is required on every line', 400)
        if (!(Number(l.qty) > 0)) throw new ApiError('Line qty must be greater than 0', 400)
      }
      lineData = body.items.map((l: any) => ({ itemId: String(l.itemId), qty: r2(Number(l.qty)), notes: l.notes ?? null }))
    }

    const updated = await db.$transaction(async (tx) => {
      const t = tx as any
      const data: any = {}
      if (body.customerId !== undefined) data.customerId = body.customerId
      if (body.date !== undefined) data.date = new Date(body.date)
      if (body.contactName !== undefined) data.contactName = body.contactName ?? null
      if (body.source !== undefined) data.source = body.source ?? null
      if (body.notes !== undefined) data.notes = body.notes ?? null
      if (statusChange) data.status = body.status
      if (lineData) {
        await tx.enquiryItem.deleteMany({ where: { enquiryId: id } })
        data.items = { create: lineData }
      }
      const upd = await tx.enquiry.update({
        where: { id },
        data,
        include: { items: true },
      })
      await logAudit(t, {
        companyId, userName: body.userName, action: 'UPDATE', entity: 'Enquiry', entityId: id,
        details: statusChange ? `Status ${current.status} → ${body.status}` : `Updated enquiry ${current.number}`,
      })
      return upd
    })

    const [row] = await withRelations(companyId, [updated])
    return ok(row, 'Enquiry updated')
  } catch (e) {
    return handleError(e)
  }
}

// DELETE /api/enquiries/[id]?companyId=  — only when OPEN
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireWrite(req, 'enquiries')
    const { id } = await params
    const body = await req.json().catch(() => ({}) as any)
    const companyId = await companyRequired(req, body?.companyId)

    const current = await db.enquiry.findFirst({ where: { id, companyId } })
    if (!current) throw new ApiError('Enquiry not found', 404)
    if (current.status !== 'OPEN') throw new ApiError(`Only OPEN enquiries can be deleted (current: ${current.status})`, 400)

    await db.$transaction(async (tx) => {
      const t = tx as any
      await tx.enquiry.delete({ where: { id } })
      await logAudit(t, {
        companyId, userName: body?.userName, action: 'DELETE', entity: 'Enquiry',
        entityId: id, details: `Deleted enquiry ${current.number}`,
      })
    })
    return ok({ id }, 'Enquiry deleted')
  } catch (e) {
    return handleError(e)
  }
}
