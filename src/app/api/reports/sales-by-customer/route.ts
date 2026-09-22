import { db } from '@/lib/db'
import { ok, handleError, companyRequired, ApiError, r2 } from '@/lib/erp-helpers'

// GET /api/reports/sales-by-customer?companyId=&from=&to=
// from/to are YYYY-MM-DD; defaults: from = FY start (1 Apr of current FY), to = today.
export async function GET(req: Request) {
  try {
    const companyId = await companyRequired(req)
    const { searchParams } = new URL(req.url)

    // Default period: current Indian financial year (1 Apr → today)
    const today = new Date()
    const fyStartYear = today.getMonth() + 1 >= 4 ? today.getFullYear() : today.getFullYear() - 1
    const fromStr = searchParams.get('from') || `${fyStartYear}-04-01`
    const toStr = searchParams.get('to') || today.toISOString().slice(0, 10)

    // Same date pattern as /api/stock-ledger
    const date: Record<string, Date> = {}
    const fd = new Date(fromStr)
    if (isNaN(fd.getTime())) throw new ApiError('Invalid from date', 400)
    date.gte = fd
    const td = new Date(toStr)
    if (isNaN(td.getTime())) throw new ApiError('Invalid to date', 400)
    // include the whole "to" day when only a date (no time) is supplied
    if (toStr.length <= 10) td.setHours(23, 59, 59, 999)
    date.lte = td

    const invoices = await db.salesInvoice.findMany({
      where: { companyId, status: { not: 'CANCELLED' }, date },
      include: { customer: { select: { name: true, city: true, state: true } } },
    })

    interface Group {
      customerId: string; name: string; city: string | null; state: string | null
      invoices: number; base: number; tax: number; grand: number; received: number
    }
    const groups = new Map<string, Group>()
    for (const inv of invoices) {
      let g = groups.get(inv.customerId)
      if (!g) {
        g = {
          customerId: inv.customerId,
          name: inv.customer?.name || '—',
          city: inv.customer?.city ?? null,
          state: inv.customer?.state ?? null,
          invoices: 0, base: 0, tax: 0, grand: 0, received: 0,
        }
        groups.set(inv.customerId, g)
      }
      g.invoices += 1
      // taxable base = subtotal − discountTotal (schema has no separate taxableTotal field)
      g.base += (inv.subtotal || 0) - (inv.discountTotal || 0)
      g.tax += (inv.cgst || 0) + (inv.sgst || 0) + (inv.igst || 0)
      g.grand += inv.grandTotal || 0
      g.received += inv.paidAmount || 0
    }

    const items = Array.from(groups.values())
      .map((g) => ({
        ...g,
        base: r2(g.base),
        tax: r2(g.tax),
        grand: r2(g.grand),
        received: r2(g.received),
        outstanding: r2(g.grand - g.received),
      }))
      .sort((a, b) => b.grand - a.grand)

    const totals = {
      invoices: items.reduce((s, i) => s + i.invoices, 0),
      base: r2(items.reduce((s, i) => s + i.base, 0)),
      tax: r2(items.reduce((s, i) => s + i.tax, 0)),
      grand: r2(items.reduce((s, i) => s + i.grand, 0)),
      received: r2(items.reduce((s, i) => s + i.received, 0)),
      outstanding: 0,
    }
    totals.outstanding = r2(totals.grand - totals.received)

    return ok({ items, totals, from: fromStr, to: toStr })
  } catch (e) {
    return handleError(e)
  }
}
