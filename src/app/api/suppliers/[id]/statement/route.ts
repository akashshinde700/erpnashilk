import { db } from '@/lib/db'
import { ok, handleError, companyRequired, ApiError, r2, requireRead } from '@/lib/erp-helpers'
import { PURCHASE_RETURN, purchaseReturnRefunds } from '@/lib/party-credits'

// GET /api/suppliers/[id]/statement?companyId=&from=&to=
// Read-only supplier statement of account (no requireWrite — mirrors the read-only GET
// convention used by /api/payments GET and /api/reports/*; middleware enforces identity).
// Debits = purchase invoices (what we owe) and refunds received; Credits = payments made and debit notes.
// from/to are YYYY-MM-DD (optional). Defaults: from = FY start (1 Apr of current Indian FY),
// to = today — same convention as /api/reports/sales-by-customer.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireRead(req, ['payables', 'suppliers']) // Phase 5: financial read permission
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
    // Voiding a payment DELETES the row (and reverses the bill paidAmount). Rows on the statement (Phase 5 fix,
    // mirrors the customer statement):
    //  - payments to the supplier and the part of a debit note applied to its bill → credit; a bounced cheque paid
    //    nothing and is left out
    //  - refunds received from the supplier (RECEIPT, invoiceType PURCHASE_RETURN) → debit: the supplier paid back
    //    what the debit note left in our favour
    //  - the part of a debit note NOT applied to its own bill → credit (DEBIT_NOTE row below)
    // So the closing balance = what the open bills still owe − refunds still due from the supplier (+ master opening).
    const payments = await db.payment.findMany({
      where: { companyId, supplierId: id, OR: [{ chequeStatus: null }, { chequeStatus: { not: 'BOUNCED' } }] },
      orderBy: { date: 'asc' },
      select: { id: true, number: true, date: true, amount: true, mode: true, reference: true, invoiceId: true, invoiceType: true },
    })
    const returns = await db.purchaseReturn.findMany({
      where: { companyId, supplierId: id, status: 'POSTED' },
      orderBy: { date: 'asc' },
      select: { id: true, number: true, date: true, grandTotal: true, invoiceId: true, status: true },
    })
    const noteRefund = await purchaseReturnRefunds(db, companyId, returns)
    const returnById = new Map(returns.map((r) => [r.id, r.number]))

    const numberByInvoiceId = new Map(invoices.map((i) => [i.id, i.number]))

    type Entry = { date: Date; type: 'INVOICE' | 'PAYMENT' | 'DEBIT_NOTE' | 'REFUND'; ref: string; particulars: string; debit: number; credit: number }
    const all: Entry[] = []

    for (const inv of invoices) {
      all.push({
        date: inv.date,
        type: 'INVOICE',
        ref: inv.number,
        particulars: `Purchase Invoice ${inv.number} — ${inv.status.replaceAll('_', ' ')}`,
        debit: r2(inv.grandTotal || 0),
        credit: 0,
      })
    }
    for (const p of payments) {
      if (p.invoiceType === PURCHASE_RETURN) {
        all.push({
          date: p.date, type: 'REFUND', ref: p.number,
          particulars: `Refund ${p.number} received by ${p.mode}${p.invoiceId && returnById.get(p.invoiceId) ? ` on debit note ${returnById.get(p.invoiceId)}` : ''}`,
          debit: r2(p.amount || 0), credit: 0,
        })
        continue
      }
      const against = p.invoiceId ? numberByInvoiceId.get(p.invoiceId) : undefined
      all.push({
        date: p.date,
        type: 'PAYMENT',
        ref: p.number,
        particulars: p.mode === 'DEBIT_NOTE'
          ? `Debit note ${p.reference || p.number}${against ? ` adjusted on ${against}` : ''}`
          : `Payment ${p.number} by ${p.mode}${p.reference ? ` · Ref: ${p.reference}` : ''}${against ? ` towards ${against}` : ''}`,
        debit: 0,
        credit: r2(p.amount || 0),
      })
    }
    for (const r of returns) {
      const c = noteRefund.get(r.id)
      const excess = c ? r2(c.total - c.appliedToBill) : 0
      if (excess <= 0.005) continue
      all.push({ date: r.date, type: 'DEBIT_NOTE', ref: r.number, particulars: `Debit note ${r.number} — due back from the supplier (more than its bill's balance)`, debit: 0, credit: excess })
    }

    // Master opening balance (carried forward from before using the ERP) + activity before `from`
    const before = all.filter((e) => e.date < fd)
    const openingBalance = r2((supplier.openingBalance || 0) + before.reduce((s, e) => s + e.debit - e.credit, 0))
    const entries = all.filter((e) => e.date >= fd && e.date <= td)

    // Chronological merge; on the same date bills are listed before payments so the
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
