import { db } from '@/lib/db'
import { ok, handleError, companyRequired, ApiError, r2, requireRead } from '@/lib/erp-helpers'
import { ADVANCE, ADVANCE_ADJ, SALES_RETURN, salesReturnCredits } from '@/lib/party-credits'

// GET /api/customers/[id]/statement?companyId=&from=&to=
// Read-only statement of account (no requireWrite — mirrors the read-only GET convention
// used by /api/payments GET and /api/reports/*; middleware already enforces identity).
// from/to are YYYY-MM-DD (optional). Defaults: from = FY start (1 Apr of current Indian FY),
// to = today — same convention as /api/reports/sales-by-customer.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireRead(req, ['receivables', 'customers']) // Phase 5: financial read permission
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

    const customer = await db.customer.findFirst({
      where: { id, companyId },
      select: { id: true, name: true, code: true, gstin: true, phone: true, openingBalance: true },
    })
    if (!customer) throw new ApiError('Customer not found', 404)

    // Full history for BOTH sides so the opening balance (everything before `from`)
    // and the in-period rows come from the same queries.
    const invoices = await db.salesInvoice.findMany({
      where: { companyId, customerId: id, status: { not: 'CANCELLED' } },
      orderBy: { date: 'asc' },
      select: { id: true, number: true, date: true, grandTotal: true, paidAmount: true, status: true },
    })

    // Payment has no Prisma relations — plain customerId string (mirrors /api/payments GET).
    // Voiding a payment DELETES the row (and reverses the invoice paidAmount). Rows on the statement:
    //  - receipts (incl. advances and the part of a credit note applied to its invoice) → credit; a bounced cheque
    //    gave no credit and is left out
    //  - refunds paid to the customer (invoiceType SALES_RETURN) → debit
    //  - applications of an advance / of a return credit to an invoice move nothing between us and the customer
    //    (the credit was given when the advance came in / the note was posted) → left out
    //  - the part of a credit note NOT applied to its own invoice → credit (CREDIT_NOTE row below)
    const payments = (await db.payment.findMany({
      where: { companyId, customerId: id, OR: [{ chequeStatus: null }, { chequeStatus: { not: 'BOUNCED' } }] },
      orderBy: { date: 'asc' },
      select: { id: true, number: true, date: true, amount: true, mode: true, reference: true, invoiceId: true, invoiceType: true, allocatedFromId: true },
    })).filter((p) => p.mode !== ADVANCE_ADJ && !p.allocatedFromId)
    const returns = await db.salesReturn.findMany({
      where: { companyId, customerId: id, status: 'POSTED' },
      orderBy: { date: 'asc' },
      select: { id: true, number: true, date: true, grandTotal: true, invoiceId: true, status: true },
    })
    const noteCredit = await salesReturnCredits(db, companyId, returns)
    const returnById = new Map(returns.map((r) => [r.id, r.number]))

    const numberByInvoiceId = new Map(invoices.map((i) => [i.id, i.number]))

    type Entry = { date: Date; type: 'INVOICE' | 'PAYMENT' | 'CREDIT_NOTE' | 'REFUND'; ref: string; particulars: string; debit: number; credit: number }
    const all: Entry[] = []

    for (const inv of invoices) {
      all.push({
        date: inv.date,
        type: 'INVOICE',
        ref: inv.number,
        particulars: `Tax Invoice ${inv.number} — ${inv.status.replaceAll('_', ' ')}`,
        debit: r2(inv.grandTotal || 0),
        credit: 0,
      })
    }
    for (const p of payments) {
      if (p.invoiceType === SALES_RETURN) {
        all.push({
          date: p.date, type: 'REFUND', ref: p.number,
          particulars: `Refund ${p.number} by ${p.mode}${p.invoiceId && returnById.get(p.invoiceId) ? ` on credit note ${returnById.get(p.invoiceId)}` : ''}`,
          debit: r2(p.amount || 0), credit: 0,
        })
        continue
      }
      const against = p.invoiceId ? numberByInvoiceId.get(p.invoiceId) : undefined
      all.push({
        date: p.date,
        type: 'PAYMENT',
        ref: p.number,
        particulars: p.invoiceType === ADVANCE
          ? `Advance ${p.number} by ${p.mode}${p.reference ? ` · Ref: ${p.reference}` : ''}`
          : `${p.mode === 'CREDIT_NOTE' ? 'Credit note' : 'Receipt'} ${p.number}${p.mode === 'CREDIT_NOTE' ? '' : ` by ${p.mode}`}${p.reference ? ` · Ref: ${p.reference}` : ''}${against ? ` towards ${against}` : ''}`,
        debit: 0,
        credit: r2(p.amount || 0),
      })
    }
    for (const r of returns) {
      const c = noteCredit.get(r.id)
      const excess = c ? r2(c.total - c.appliedToInvoice) : 0
      if (excess <= 0.005) continue
      all.push({ date: r.date, type: 'CREDIT_NOTE', ref: r.number, particulars: `Credit note ${r.number} — credit to the customer (not adjusted on its invoice)`, debit: 0, credit: excess })
    }

    // Master opening balance (carried forward from before using the ERP) + activity before `from`
    const before = all.filter((e) => e.date < fd)
    const openingBalance = r2((customer.openingBalance || 0) + before.reduce((s, e) => s + e.debit - e.credit, 0))
    const entries = all.filter((e) => e.date >= fd && e.date <= td)

    // Chronological merge; on the same date invoices are listed before receipts so the
    // running balance always shows the day's billing before the day's collections.
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
      customer,
      period: { from: fromStr, to: toStr },
      openingBalance,
      rows,
      totals: { debits, credits, closing },
    })
  } catch (e) {
    return handleError(e)
  }
}
