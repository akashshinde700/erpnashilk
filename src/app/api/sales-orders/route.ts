import { db } from '@/lib/db'
import { ok, fail, handleError, companyRequired, nextDocNumber, computeGst, isInterStateParty, postStock, logAudit, notify, ApiError, r2, requireWrite } from '@/lib/erp-helpers'
import { emitEvent } from '@/lib/emit-event'

interface SoLine { itemId: string; qty: number; rate: number; discountPct: number; gstRate: number }

// SalesOrderItem carries only itemId (no Prisma relation to Item) — attach master info via JS mapping
async function withItemInfo<T extends { items: { itemId: string }[] }>(companyId: string, docs: T[]) {
  const ids = Array.from(new Set(docs.flatMap((d) => d.items.map((i) => i.itemId))))
  const masters = ids.length
    ? await db.item.findMany({ where: { companyId, id: { in: ids } }, select: { id: true, code: true, name: true, uom: true } })
    : []
  const map = new Map(masters.map((m) => [m.id, m]))
  return docs.map((d) => ({ ...d, items: d.items.map((i) => ({ ...i, item: map.get(i.itemId) || null })) }))
}

function validateLines(raw: any[]): SoLine[] {
  if (!raw.length) throw new ApiError('At least one order line is required', 400)
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

// GET /api/sales-orders?companyId=&q=&status=&customerId=
export async function GET(req: Request) {
  try {
    const companyId = await companyRequired(req)
    const { searchParams } = new URL(req.url)
    const q = (searchParams.get('q') || '').trim()
    const status = (searchParams.get('status') || '').trim()
    const customerId = (searchParams.get('customerId') || '').trim()

    const where: any = { companyId }
    if (status) where.status = status
    if (customerId) where.customerId = customerId
    if (q) {
      where.OR = [
        { number: { contains: q } },
        { customer: { is: { name: { contains: q } } } },
      ]
    }

    const rows = await db.salesOrder.findMany({
      where,
      orderBy: { orderDate: 'desc' },
      include: {
        customer: { select: { name: true, state: true, stateCode: true } },
        items: true,
      },
    })
    const items = await withItemInfo(companyId, rows)
    return ok({ items, total: items.length })
  } catch (e) {
    return handleError(e)
  }
}

// POST /api/sales-orders  { companyId, quotationId?, customerId, orderDate?, deliveryDate?, notes?, items: [...], status? ('DRAFT'|'CONFIRMED', default CONFIRMED) }
export async function POST(req: Request) {
  try {
    requireWrite(req, 'sales-orders')
    const body = await req.json().catch(() => ({}) as any)
    const companyId = await companyRequired(req, body.companyId)

    const customerId = body.customerId
    if (!customerId) throw new ApiError('customerId is required', 400)
    const lines = validateLines(Array.isArray(body.items) ? body.items : [])
    const status = body.status ? String(body.status) : 'CONFIRMED'
    if (!['DRAFT', 'CONFIRMED'].includes(status)) throw new ApiError('status must be DRAFT or CONFIRMED', 400)

    const [company, customer] = await Promise.all([
      db.company.findUnique({ where: { id: companyId } }),
      db.customer.findFirst({ where: { id: customerId, companyId } }),
    ])
    if (!company) throw new ApiError('Company not found', 404)
    if (!customer) throw new ApiError('Customer not found', 404)

    const itemIds = Array.from(new Set(lines.map((l) => l.itemId)))
    const itemCount = await db.item.count({ where: { companyId, id: { in: itemIds } } })
    if (itemCount !== itemIds.length) throw new ApiError('One or more itemId values are invalid for this company', 400)

    let linkedQuotation: { id: string; number: string } | null = null
    if (body.quotationId) {
      const qt = await db.quotation.findFirst({ where: { id: body.quotationId, companyId } })
      if (!qt) throw new ApiError('Quotation not found', 404)
      if (!['DRAFT', 'SENT', 'APPROVED'].includes(qt.status)) {
        throw new ApiError(`Quotation ${qt.number} cannot be converted (status: ${qt.status})`, 400)
      }
      linkedQuotation = { id: qt.id, number: qt.number }
    }

    const orderDate = body.orderDate ? new Date(body.orderDate) : new Date()
    const deliveryDate = body.deliveryDate ? new Date(body.deliveryDate) : null

    const interState = isInterStateParty(company ?? {}, customer ?? {})
    const totals = computeGst(lines, interState)

    const created = await db.$transaction(async (tx) => {
      const t = tx as any
      const number = await nextDocNumber(t, companyId, 'SO', orderDate)
      const so = await tx.salesOrder.create({
        data: {
          companyId,
          number,
          customerId,
          quotationId: linkedQuotation?.id ?? null,
          orderDate,
          deliveryDate,
          status,
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
      if (linkedQuotation) {
        await tx.quotation.update({ where: { id: linkedQuotation.id }, data: { status: 'CONVERTED' } })
      }
      await logAudit(t, {
        companyId, userName: body.userName, action: 'CREATE', entity: 'SalesOrder', entityId: so.id,
        details: `Sales order ${number} for ${customer.name} • ₹${totals.grandTotal}${linkedQuotation ? ` (from ${linkedQuotation.number})` : ''}`,
      })
      return so
    })

    void emitEvent({ companyId, title: 'New Sales Order', message: `${created.number} for ₹${totals.grandTotal}`, level: 'INFO', topic: 'sales' })

    const full = await db.salesOrder.findFirst({
      where: { id: created.id, companyId },
      include: { customer: { select: { name: true, state: true, stateCode: true } }, items: true },
    })
    const [row] = await withItemInfo(companyId, full ? [full] : [])
    return ok(row, status === 'DRAFT' ? 'Sales order saved as draft' : 'Sales order confirmed')
  } catch (e) {
    return handleError(e)
  }
}
