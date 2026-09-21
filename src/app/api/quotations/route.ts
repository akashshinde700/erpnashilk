import { db } from '@/lib/db'
import { ok, fail, handleError, companyRequired, nextDocNumber, computeGst, isInterState, postStock, logAudit, notify, ApiError, r2, requireWrite } from '@/lib/erp-helpers'

interface QtLine { itemId: string; qty: number; rate: number; discountPct: number; gstRate: number }

// Quotation carries a plain customerId + item lines without Prisma relations — resolve via JS mapping
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

function validateLines(raw: any[]): QtLine[] {
  if (!raw.length) throw new ApiError('At least one quotation line is required', 400)
  return raw.map((l) => {
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
}

// GET /api/quotations?companyId=&q=&status=
export async function GET(req: Request) {
  try {
    const companyId = await companyRequired(req)
    const { searchParams } = new URL(req.url)
    const q = (searchParams.get('q') || '').trim()
    const status = (searchParams.get('status') || '').trim()

    const where: any = { companyId }
    if (status) where.status = status
    if (q) {
      // Quotation has no customer relation — match by number or by matching customer ids
      const custs = await db.customer.findMany({ where: { companyId, name: { contains: q } }, select: { id: true } })
      where.OR = [
        { number: { contains: q } },
        { customerId: { in: custs.map((c) => c.id) } },
      ]
    }

    const rows = await db.quotation.findMany({
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

// POST /api/quotations  { companyId, enquiryId?, customerId, date?, validUntil?, notes?, items: [{itemId, qty, rate, discountPct, gstRate}] }
export async function POST(req: Request) {
  try {
    requireWrite(req, 'quotations')
    const body = await req.json().catch(() => ({}) as any)
    const companyId = await companyRequired(req, body.companyId)

    const customerId = body.customerId
    if (!customerId) throw new ApiError('customerId is required', 400)
    const lines = validateLines(Array.isArray(body.items) ? body.items : [])

    const [company, customer] = await Promise.all([
      db.company.findUnique({ where: { id: companyId } }),
      db.customer.findFirst({ where: { id: customerId, companyId } }),
    ])
    if (!company) throw new ApiError('Company not found', 404)
    if (!customer) throw new ApiError('Customer not found', 404)

    const itemIds = Array.from(new Set(lines.map((l) => l.itemId)))
    const itemCount = await db.item.count({ where: { companyId, id: { in: itemIds } } })
    if (itemCount !== itemIds.length) throw new ApiError('One or more itemId values are invalid for this company', 400)

    let linkedEnquiry: { id: string; number: string } | null = null
    if (body.enquiryId) {
      const enq = await db.enquiry.findFirst({ where: { id: body.enquiryId, companyId } })
      if (!enq) throw new ApiError('Enquiry not found', 404)
      if (['WON', 'LOST', 'CLOSED'].includes(enq.status)) {
        throw new ApiError(`Enquiry ${enq.number} is ${enq.status} and cannot be quoted`, 400)
      }
      linkedEnquiry = { id: enq.id, number: enq.number }
    }

    const date = body.date ? new Date(body.date) : new Date()
    const validUntil = body.validUntil ? new Date(body.validUntil) : null

    const interState = isInterState(company.state, customer.state)
    const totals = computeGst(lines, interState)

    const created = await db.$transaction(async (tx) => {
      const t = tx as any
      const number = await nextDocNumber(t, companyId, 'QT', date)
      const qt = await tx.quotation.create({
        data: {
          companyId,
          number,
          customerId,
          enquiryId: linkedEnquiry?.id ?? null,
          date,
          validUntil,
          status: 'DRAFT',
          subtotal: totals.subtotal,
          discountTotal: totals.discountTotal,
          cgst: totals.cgst,
          sgst: totals.sgst,
          igst: totals.igst,
          grandTotal: totals.grandTotal,
          notes: body.notes ?? null,
          items: {
            create: lines.map((l, i) => ({
              itemId: l.itemId,
              qty: l.qty,
              rate: l.rate,
              discountPct: l.discountPct,
              gstRate: l.gstRate,
              lineTotal: r2(totals.computed[i].taxable),
            })),
          },
        },
      })
      if (linkedEnquiry) {
        await tx.enquiry.update({ where: { id: linkedEnquiry.id }, data: { status: 'QUOTED' } })
      }
      await logAudit(t, {
        companyId, userName: body.userName, action: 'CREATE', entity: 'Quotation', entityId: qt.id,
        details: `Quotation ${number} for ${customer.name} • ₹${totals.grandTotal}${linkedEnquiry ? ` (from ${linkedEnquiry.number})` : ''}`,
      })
      return qt
    })

    const full = await db.quotation.findFirst({ where: { id: created.id, companyId }, include: { items: true } })
    const [row] = await withRelations(companyId, full ? [full] : [])
    return ok(row, 'Quotation created')
  } catch (e) {
    return handleError(e)
  }
}
