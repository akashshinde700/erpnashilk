import { db } from '@/lib/db'
import { ApiError, companyRequired, handleError, ok } from '@/lib/erp-helpers'

// GET /api/parties/last-rates?kind=customer|supplier&partyId=&itemIds=a,b
// → { rates: { [itemId]: { rate, discountPct, date, ref } } } — the rate last billed to/by this party
// for each item (latest invoice line; falls back to the latest order line). Used to pre-fill line rates.
export async function GET(req: Request) {
  try {
    const companyId = await companyRequired(req)
    const sp = new URL(req.url).searchParams
    const kind = sp.get('kind')
    const partyId = sp.get('partyId') || ''
    const itemIds = (sp.get('itemIds') || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 200)
    if (kind !== 'customer' && kind !== 'supplier') throw new ApiError('kind must be customer or supplier', 400)
    if (!partyId) throw new ApiError('partyId is required', 400)
    const rates: Record<string, { rate: number; discountPct: number; date: string; ref: string }> = {}
    const keep = (itemId: string, rate: number, discountPct: number, date: Date, ref: string) => {
      if (!rates[itemId]) rates[itemId] = { rate, discountPct, date: date.toISOString(), ref }
    }
    const itemFilter = itemIds.length ? { itemId: { in: itemIds } } : {}

    if (kind === 'customer') {
      const inv = await db.salesInvoiceItem.findMany({
        where: { ...itemFilter, invoice: { companyId, customerId: partyId, status: { not: 'CANCELLED' } } },
        orderBy: { invoice: { date: 'desc' } }, take: 500,
        select: { itemId: true, rate: true, discountPct: true, invoice: { select: { date: true, number: true } } },
      })
      for (const l of inv) keep(l.itemId, l.rate, l.discountPct, l.invoice.date, l.invoice.number)
      const so = await db.salesOrderItem.findMany({
        where: { ...itemFilter, salesOrder: { companyId, customerId: partyId, status: { not: 'CANCELLED' } } },
        orderBy: { salesOrder: { orderDate: 'desc' } }, take: 500,
        select: { itemId: true, rate: true, discountPct: true, salesOrder: { select: { orderDate: true, number: true } } },
      })
      for (const l of so) keep(l.itemId, l.rate, l.discountPct ?? 0, l.salesOrder.orderDate, l.salesOrder.number)
    } else {
      const inv = await db.purchaseInvoiceItem.findMany({
        where: { ...itemFilter, invoice: { companyId, supplierId: partyId, status: { not: 'CANCELLED' } } },
        orderBy: { invoice: { date: 'desc' } }, take: 500,
        select: { itemId: true, rate: true, invoice: { select: { date: true, number: true } } },
      })
      for (const l of inv) keep(l.itemId, l.rate, 0, l.invoice.date, l.invoice.number)
      const po = await db.purchaseOrderItem.findMany({
        where: { ...itemFilter, po: { companyId, supplierId: partyId, status: { not: 'CANCELLED' } } },
        orderBy: { po: { orderDate: 'desc' } }, take: 500,
        select: { itemId: true, rate: true, po: { select: { orderDate: true, number: true } } },
      })
      for (const l of po) keep(l.itemId, l.rate, 0, l.po.orderDate, l.po.number)
    }
    return ok({ rates })
  } catch (e) {
    return handleError(e)
  }
}
