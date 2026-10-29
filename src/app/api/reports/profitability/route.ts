import { db } from '@/lib/db'
import { ok, handleError, companyRequired, ApiError, r2, requireFinancialReports } from '@/lib/erp-helpers'

// GET /api/reports/profitability?companyId=&from=&to=
// Line-level margin report: line taxable value (SalesInvoiceItem.lineTotal — stored as the
// GST-exclusive taxable amount by the sales-invoices API) vs item standardCost × qty.
export async function GET(req: Request) {
  try {
    requireFinancialReports(req) // Phase 5: financial read permission
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
      include: {
        customer: { select: { name: true } },
        items: true,
      },
      orderBy: { date: 'desc' },
    })

    // SalesInvoiceItem carries only itemId (no Item relation) — batch-attach master info in JS
    const itemIds = Array.from(new Set(invoices.flatMap((inv) => inv.items.map((l) => l.itemId))))
    const masters = itemIds.length
      ? await db.item.findMany({ where: { companyId, id: { in: itemIds } }, select: { id: true, code: true, name: true, standardCost: true } })
      : []
    const itemMap = new Map(masters.map((m) => [m.id, m]))

    interface Row {
      invoiceId: string; invoiceNumber: string; date: Date
      customerId: string; customerName: string
      itemId: string; itemCode: string; itemName: string
      qty: number; rate: number; taxable: number; cost: number; margin: number; marginPct: number
    }
    const rows: Row[] = []
    let revenue = 0
    let costSum = 0
    for (const inv of invoices) {
      for (const l of inv.items) {
        const m = itemMap.get(l.itemId)
        const stdCost = m?.standardCost || 0
        const qty = l.qty || 0
        const taxable = r2(l.lineTotal || 0)
        const cost = r2(stdCost * qty)
        const margin = r2(taxable - cost)
        const marginPct = taxable > 0 ? r2((margin / taxable) * 100) : 0
        revenue += taxable
        costSum += cost
        rows.push({
          invoiceId: inv.id,
          invoiceNumber: inv.number,
          date: inv.date,
          customerId: inv.customerId,
          customerName: inv.customer?.name || '—',
          itemId: l.itemId,
          itemCode: m?.code || '—',
          itemName: m?.name || '—',
          qty,
          rate: qty > 0 ? r2(taxable / qty) : 0,
          taxable,
          cost,
          margin,
          marginPct,
        })
      }
    }

    const items = rows.slice(0, 300)
    const tRevenue = r2(revenue)
    const tCost = r2(costSum)
    const tMargin = r2(tRevenue - tCost)
    const totals = {
      revenue: tRevenue,
      cost: tCost,
      margin: tMargin,
      marginPct: tRevenue > 0 ? r2((tMargin / tRevenue) * 100) : 0,
    }

    return ok({ items, totals, from: fromStr, to: toStr })
  } catch (e) {
    return handleError(e)
  }
}
