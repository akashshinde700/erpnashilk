import { db } from '@/lib/db'
import { ok, fail, handleError, companyRequired, nextDocNumber, computeGst, isInterState, postStock, logAudit, notify, ApiError, r2 } from '@/lib/erp-helpers'

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
      : Promise.resolve([] as { id: string; name: string; gstin: string | null; city: string | null }[]),
  ])
  const itemMap = new Map(items.map((m) => [m.id, m]))
  const custMap = new Map(customers.map((c) => [c.id, c]))
  return docs.map((d) => ({
    ...d,
    customer: custMap.get(d.customerId) ?? null,
    items: d.items.map((i) => ({ ...i, item: itemMap.get(i.itemId) || null })),
  }))
}

// GET /api/enquiries?companyId=&q=&status=
export async function GET(req: Request) {
  try {
    const companyId = await companyRequired(req)
    const { searchParams } = new URL(req.url)
    const q = (searchParams.get('q') || '').trim()
    const status = (searchParams.get('status') || '').trim()

    const where: any = { companyId }
    if (status) where.status = status
    if (q) {
      // Enquiry has no customer relation — match by number or by matching customer ids
      const custs = await db.customer.findMany({ where: { companyId, name: { contains: q } }, select: { id: true } })
      where.OR = [
        { number: { contains: q } },
        { customerId: { in: custs.map((c) => c.id) } },
      ]
    }

    const rows = await db.enquiry.findMany({
      where,
      orderBy: { date: 'desc' },
      include: { items: true },
    })
    const items = await withRelations(companyId, rows)
    return ok({ items, total: items.length })
  } catch (e) {
    return handleError(e)
  }
}

// POST /api/enquiries  { companyId, customerId, date?, contactName?, source?, notes?, items: [{itemId, qty, notes?}] }
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}) as any)
    const companyId = await companyRequired(req, body.companyId)

    const customerId = body.customerId
    if (!customerId) throw new ApiError('customerId is required', 400)
    const rawItems: any[] = Array.isArray(body.items) ? body.items : []
    if (!rawItems.length) throw new ApiError('At least one enquiry item is required', 400)
    for (const l of rawItems) {
      if (!l.itemId) throw new ApiError('itemId is required on every line', 400)
      if (!(Number(l.qty) > 0)) throw new ApiError('Line qty must be greater than 0', 400)
    }

    const customer = await db.customer.findFirst({ where: { id: customerId, companyId } })
    if (!customer) throw new ApiError('Customer not found', 404)

    const itemIds = Array.from(new Set(rawItems.map((l: any) => String(l.itemId))))
    const itemCount = await db.item.count({ where: { companyId, id: { in: itemIds } } })
    if (itemCount !== itemIds.length) throw new ApiError('One or more itemId values are invalid for this company', 400)

    const date = body.date ? new Date(body.date) : new Date()

    const created = await db.$transaction(async (tx) => {
      const t = tx as any
      const number = await nextDocNumber(t, companyId, 'ENQ', date)
      const c = await tx.enquiry.create({
        data: {
          companyId,
          number,
          customerId,
          date,
          contactName: body.contactName ?? customer.contactPerson ?? null,
          source: body.source ?? null,
          notes: body.notes ?? null,
          status: 'OPEN',
          items: {
            create: rawItems.map((l: any) => ({
              itemId: String(l.itemId),
              qty: r2(Number(l.qty)),
              notes: l.notes ?? null,
            })),
          },
        },
      })
      await logAudit(t, {
        companyId, userName: body.userName, action: 'CREATE', entity: 'Enquiry',
        entityId: c.id, details: `Enquiry ${number} raised for ${customer.name}`,
      })
      return c
    })

    const full = await db.enquiry.findFirst({ where: { id: created.id, companyId }, include: { items: true } })
    const [row] = await withRelations(companyId, full ? [full] : [])
    return ok(row, 'Enquiry created')
  } catch (e) {
    return handleError(e)
  }
}
