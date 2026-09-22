import { db } from '@/lib/db'
import { ok, fail, handleError, companyRequired, nextDocNumber, computeGst, isInterState, postStock, logAudit, notify, ApiError, r2, requireWrite } from '@/lib/erp-helpers'

interface InvLine { soItemId: string | null; itemId: string; qty: number; rate: number; discountPct: number; gstRate: number }

// SalesInvoiceItem carries only itemId (no Prisma relation to Item) — attach master info via JS mapping
async function withItemInfo<T extends { items: { itemId: string }[] }>(companyId: string, docs: T[]) {
  const ids = Array.from(new Set(docs.flatMap((d) => d.items.map((i) => i.itemId))))
  const masters = ids.length
    ? await db.item.findMany({ where: { companyId, id: { in: ids } }, select: { id: true, code: true, name: true, uom: true, hsn: true } })
    : []
  const map = new Map(masters.map((m) => [m.id, m]))
  return docs.map((d) => ({ ...d, items: d.items.map((i) => ({ ...i, item: map.get(i.itemId) || null })) }))
}

// GET /api/sales-invoices?companyId=&status=&customerId=&q=
export async function GET(req: Request) {
  try {
    const companyId = await companyRequired(req)
    const { searchParams } = new URL(req.url)
    const status = (searchParams.get('status') || '').trim()
    const customerId = (searchParams.get('customerId') || '').trim()
    const q = (searchParams.get('q') || '').trim()

    const where: any = { companyId }
    if (status) where.status = status
    if (customerId) where.customerId = customerId
    if (q) {
      where.OR = [
        { number: { contains: q } },
        { customer: { is: { name: { contains: q } } } },
      ]
    }

    const items = await db.salesInvoice.findMany({
      where,
      orderBy: { date: 'desc' },
      include: {
        customer: { select: { name: true, gstin: true, phone: true, state: true, stateCode: true } },
        salesOrder: { select: { number: true } },
      },
    })
    return ok({ items, total: items.length })
  } catch (e) {
    return handleError(e)
  }
}

// POST /api/sales-invoices
// { companyId, salesOrderId?, customerId, date?, dueDate?, placeOfSupply?, notes?, lines?: [{itemId, qty, rate, discountPct, gstRate}] }
// - salesOrderId without lines → auto-build lines from SO items with remaining (qty - invoicedQty)
export async function POST(req: Request) {
  try {
    requireWrite(req, 'sales-invoices')
    const body = await req.json().catch(() => ({}) as any)
    const companyId = await companyRequired(req, body.companyId)

    const customerId = body.customerId
    if (!customerId) throw new ApiError('customerId is required', 400)

    const [company, customer] = await Promise.all([
      db.company.findUnique({ where: { id: companyId } }),
      db.customer.findFirst({ where: { id: customerId, companyId } }),
    ])
    if (!company) throw new ApiError('Company not found', 404)
    if (!customer) throw new ApiError('Customer not found', 404)

    const so: any = body.salesOrderId
      ? await db.salesOrder.findFirst({ where: { id: body.salesOrderId, companyId }, include: { items: true } })
      : null
    if (body.salesOrderId && !so) throw new ApiError('Sales order not found', 404)

    const provided: any[] | null = Array.isArray(body.lines) && body.lines.length ? body.lines : null

    let lines: InvLine[] = []
    if (so && !provided) {
      // Auto-build from SO items with un-invoiced balance
      const pending = so.items.filter((si: any) => r2(si.qty - si.invoicedQty) > 0.005)
      if (!pending.length) throw new ApiError('No un-invoiced qty remaining on this sales order', 400)
      lines = pending.map((si: any) => ({
        soItemId: si.id,
        itemId: si.itemId,
        qty: r2(si.qty - si.invoicedQty),
        rate: si.rate,
        discountPct: si.discountPct,
        gstRate: si.gstRate,
      }))
    } else if (provided) {
      lines = provided.map((l) => {
        if (!l.itemId) throw new ApiError('itemId is required on every line', 400)
        const qty = Number(l.qty)
        const rate = Number(l.rate)
        if (!(qty > 0)) throw new ApiError('Line qty must be greater than 0', 400)
        if (Number.isNaN(rate) || rate < 0) throw new ApiError('Line rate must be 0 or more', 400)
        return {
          soItemId: null,
          itemId: String(l.itemId),
          qty: r2(qty),
          rate: r2(rate),
          discountPct: Number(l.discountPct ?? 0) || 0,
          gstRate: l.gstRate === undefined || l.gstRate === null || l.gstRate === '' ? 18 : Number(l.gstRate),
        }
      })
    } else {
      throw new ApiError('Provide salesOrderId (auto-lines) or explicit lines', 400)
    }

    // HSN from item master
    const itemIds = Array.from(new Set(lines.map((l) => l.itemId)))
    const masterItems = await db.item.findMany({ where: { companyId, id: { in: itemIds } }, select: { id: true, hsn: true } })
    const hsnMap = new Map(masterItems.map((m) => [m.id, m.hsn]))

    const date = body.date ? new Date(body.date) : new Date()
    const dueDate = body.dueDate
      ? new Date(body.dueDate)
      : new Date(date.getTime() + (customer.paymentTermsDays || 30) * 24 * 60 * 60 * 1000)
    const placeOfSupply = body.placeOfSupply ?? customer.state ?? null

    const interState = isInterState(company.stateCode, customer.stateCode)
    const totals = computeGst(lines, interState)

    const created = await db.$transaction(async (tx) => {
      const t = tx as any
      const number = await nextDocNumber(t, companyId, 'INV', date)
      const inv = await tx.salesInvoice.create({
        data: {
          companyId,
          number,
          salesOrderId: so?.id ?? null,
          customerId,
          date,
          dueDate,
          placeOfSupply,
          isInterState: interState,
          subtotal: totals.subtotal,
          discountTotal: totals.discountTotal,
          cgst: totals.cgst,
          sgst: totals.sgst,
          igst: totals.igst,
          grandTotal: totals.grandTotal,
          status: 'UNPAID',
          notes: body.notes ?? null,
          items: {
            create: lines.map((l, i) => ({
              itemId: l.itemId,
              hsn: hsnMap.get(l.itemId) ?? null,
              qty: l.qty,
              rate: l.rate,
              discountPct: l.discountPct,
              gstRate: l.gstRate,
              lineTotal: r2(totals.computed[i].taxable),
            })),
          },
        },
      })

      // Move SO invoicedQty forward
      if (so) {
        if (lines.every((l) => l.soItemId)) {
          for (const l of lines) {
            await tx.salesOrderItem.update({ where: { id: l.soItemId as string }, data: { invoicedQty: { increment: l.qty } } })
          }
        } else {
          // Explicit lines against an SO: consume remaining qty per itemId, in SO line order
          const byItem = new Map<string, number>()
          for (const l of lines) byItem.set(l.itemId, r2((byItem.get(l.itemId) || 0) + l.qty))
          for (const si of so.items) {
            const want = byItem.get(si.itemId)
            if (!want) continue
            const remaining = r2(si.qty - si.invoicedQty)
            const apply = Math.min(want, Math.max(0, remaining))
            if (apply > 0) {
              await tx.salesOrderItem.update({ where: { id: si.id }, data: { invoicedQty: { increment: apply } } })
              byItem.set(si.itemId, r2(want - apply))
            }
          }
        }
      }

      await logAudit(t, {
        companyId, userName: body.userName, action: 'CREATE', entity: 'SalesInvoice', entityId: inv.id,
        details: `Tax invoice ${number} for ${customer.name} • ₹${totals.grandTotal}${so ? ` against ${so.number}` : ''}`,
      })
      return inv
    })

    const full = await db.salesInvoice.findFirst({
      where: { id: created.id, companyId },
      include: {
        customer: { select: { name: true, gstin: true, state: true, stateCode: true } },
        salesOrder: { select: { number: true } },
        items: true,
      },
    })
    const [row] = await withItemInfo(companyId, full ? [full] : [])
    return ok(row, 'Invoice created')
  } catch (e) {
    return handleError(e)
  }
}
