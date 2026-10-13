import { db } from '@/lib/db'
import { ok, handleError, companyRequired, ApiError, r2 } from '@/lib/erp-helpers'

// GET /api/suppliers/[id]/statement?companyId=&from=&to=
// Read-only supplier statement of account (no requireWrite — mirrors the read-only GET
// convention used by /api/payments GET and /api/reports/*; middleware enforces identity).
// Debits = purchase invoices (what we owe), Credits = payments made to the supplier.
// from/to are YYYY-MM-DD (optional). Defaults: from = FY start (1 Apr of current Indian FY),
// to = today — same convention as /api/reports/sales-by-customer.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const companyId = await companyRequired(req)
    const { searchParams } = new URL(req.url)

    // Default period: current Indian financial year (1 Apr → today)
    const today = new Date()
    const fyStartYear = today.getMonth() + 1 >= 4 ? today.getFullYear() : today.getFullYear() - 1
    const fromStr = searchParams.get('from') || `${fyStartYear}-04-01`
    const toStr = searchParams.get('to') || today.toISOString().slice(0, 10)

    const fd = new Date(fromStr)
    if (isNaN(fd.getTime())) throw new ApiError('Invalid from date', 400)
    const td = new Date(toStr)
    if (isNaN(td.getTime())) throw new ApiError('Invalid to date', 400)
    // include the whole "to" day when only a date (no time) is supplied
    if (toStr.length <= 10) td.setHours(23, 59, 59, 999)

    const supplier = await db.supplier.findFirst({
      where: { id, companyId },
      select: { id: true, name: true, code: true, gstin: true, phone: true, openingBalance: true },
    })
    if (!supplier) throw new ApiError('Supplier not found', 404)

    // Full history for BOTH sides so the opening balance (everything before `from`)
    // and the in-period rows come from the same queries.
    const invoices = await db.purchaseInvoice.findMany({
      where: { companyId, supplierId: id, status: { not: 'CANCELLED' } },
      orderBy: { date: 'asc' },
      select: { id: true, number: true, date: true, grandTotal: true, paidAmount: true, status: true },
    })

    // Payment has no Prisma relations — plain supplierId string (mirrors /api/payments GET).
    // Voiding a payment DELETES the row (and reverses the invoice paidAmount), and invoices
    // cannot be cancelled while paidAmount > 0, so every stored Payment row is a valid credit.
    const payments = await db.payment.findMany({
      where: { companyId, supplierId: id },
      orderBy: { date: 'asc' },
      select: { id: true, number: true, date: true, amount: true, mode: true, reference: true, invoiceId: true, invoiceType: true },
    })

    const numberByInvoiceId = new Map(invoices.map((i) => [i.id, i.number]))

    const openingDebits = r2(invoices.filter((i) => i.date < fd).reduce((s, i) => s + (i.grandTotal || 0), 0))
    const openingCredits = r2(payments.filter((p) => p.date < fd).reduce((s, p) => s + (p.amount || 0), 0))
    // Master opening balance (carried forward from before using the ERP) + activity before `from`
    const openingBalance = r2((supplier.openingBalance || 0) + openingDebits - openingCredits)

    type Entry = { date: Date; type: 'INVOICE' | 'PAYMENT'; ref: string; particulars: string; debit: number; credit: number }
    const entries: Entry[] = []

    for (const inv of invoices) {
      if (inv.date < fd || inv.date > td) continue
      entries.push({
        date: inv.date,
        type: 'INVOICE',
        ref: inv.number,
        particulars: `Purchase Invoice ${inv.number} — ${inv.status.replaceAll('_', ' ')}`,
        debit: r2(inv.grandTotal || 0),
        credit: 0,
      })
    }
    for (const p of payments) {
      if (p.date < fd || p.date > td) continue
      const against = p.invoiceId ? numberByInvoiceId.get(p.invoiceId) : undefined
      entries.push({
        date: p.date,
        type: 'PAYMENT',
        ref: p.number,
        particulars: `Payment ${p.number} by ${p.mode}${p.reference ? ` · Ref: ${p.reference}` : ''}${against ? ` towards ${against}` : ''}`,
        debit: 0,
        credit: r2(p.amount || 0),
      })
    }

    // Chronological merge; on the same date invoices are listed before payments so the
    // running balance always shows the day's purchases before the day's settlements.
    entries.sort((a, b) => a.date.getTime() - b.date.getTime() || (a.type === b.type ? a.ref.localeCompare(b.ref) : a.type === 'INVOICE' ? -1 : 1))

    let running = openingBalance
    const rows = entries.map((e) => {
      running = r2(running + e.debit - e.credit)
      return { date: e.date, type: e.type, ref: e.ref, particulars: e.particulars, debit: e.debit, credit: e.credit, balance: running }
    })

    const debits = r2(rows.reduce((s, x) => s + x.debit, 0))
    const credits = r2(rows.reduce((s, x) => s + x.credit, 0))
    const closing = r2(openingBalance + debits - credits)

    return ok({
      supplier,
      period: { from: fromStr, to: toStr },
      openingBalance,
      rows,
      totals: { debits, credits, closing },
    })
  } catch (e) {
    return handleError(e)
  }
}
