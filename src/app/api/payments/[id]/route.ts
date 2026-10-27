import { db } from '@/lib/db'
import { requireSecurityPin } from '@/lib/security-pin'
import { NON_MONEY_MODES, assertOnOrAfterOpening, moneyDate } from '@/lib/accounts'
import { CASH_TX, assertCashNotNegative, negativeCashOverride } from '@/lib/cash-guard'
import { claimIdempotency, type Idempotency } from '@/lib/idempotency'
import { businessDate, istDay } from '@/lib/business-date'
import { todayIst } from '@/lib/go-live'
import { ADVANCE, advanceApplied, paymentKindModule } from '@/lib/party-credits'
import { applyCustomerCredit } from '@/lib/credit-apply'
import { ok, fail, handleError, companyRequired, nextDocNumber, computeGst, isInterState, postStock, logAudit, notify, ApiError, r2, requireWrite, requireRead } from '@/lib/erp-helpers'

// GET /api/payments/[id]?companyId=
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireRead(req, 'payments') // Phase 5: financial read permission
    const { id } = await params
    const companyId = await companyRequired(req)
    const payment = await db.payment.findFirst({ where: { id, companyId } })
    if (!payment) throw new ApiError('Payment not found', 404)

    // Payment has no Prisma relations — resolve names / invoice number via JS mapping
    const [customer, supplier, invoice] = await Promise.all([
      payment.customerId ? db.customer.findFirst({ where: { id: payment.customerId, companyId }, select: { name: true } }) : Promise.resolve(null),
      payment.supplierId ? db.supplier.findFirst({ where: { id: payment.supplierId, companyId }, select: { name: true } }) : Promise.resolve(null),
      payment.invoiceId
        ? (payment.invoiceType === 'PURCHASE'
            ? db.purchaseInvoice.findFirst({ where: { id: payment.invoiceId, companyId }, select: { number: true } })
            : db.salesInvoice.findFirst({ where: { id: payment.invoiceId, companyId }, select: { number: true } }))
        : Promise.resolve(null),
    ])

    return ok({
      ...payment,
      customer,
      supplier,
      invoiceNumber: invoice?.number ?? null,
    })
  } catch (e) {
    return handleError(e)
  }
}

// DELETE /api/payments/[id]?companyId=  — void a payment: reverse invoice paidAmount/status, delete record.
// Phase 4: an advance / return-credit application is removed this way (the invoice's outstanding and the source's
// remaining credit come back); an advance with applications cannot be voided; a refund is voided without touching
// any invoice.
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireWrite(req, 'payments')
    const { id } = await params
    const body = await req.json().catch(() => ({}) as any)
    const companyId = await companyRequired(req, body?.companyId)
    await requireSecurityPin(req, companyId)

    const current = await db.payment.findFirst({ where: { id, companyId } })
    if (!current) throw new ApiError('Payment not found', 404)
    requireWrite(req, paymentKindModule(current)) // Phase 5: customer / supplier side of this payment
    const override = negativeCashOverride(req, body)
    // Credit / debit note adjustments are owned by their return document — except a return credit applied to
    // another invoice, which is removed like an advance application
    if ((current.mode === 'CREDIT_NOTE' || current.mode === 'DEBIT_NOTE') && !current.allocatedFromId) throw new ApiError('Cancel the credit/debit note instead', 400)

    await db.$transaction(async (tx) => {
      const t = tx as any
      // An advance: lock it, then refuse while any application still uses it (an apply in flight holds the same lock)
      if (current.invoiceType === ADVANCE) {
        await tx.payment.updateMany({ where: { id, companyId }, data: { updatedAt: new Date() } })
        const used = (await advanceApplied(tx, companyId, [id])).get(id) || 0
        if (used > 0.005) throw new ApiError(`₹${used.toFixed(2)} of this advance is applied to invoices — remove those applications first`, 400)
      }
      // Conditional delete first — a concurrent void of the same payment gets 409 instead of reversing twice
      const del = await tx.payment.deleteMany({ where: { id, companyId } })
      if (del.count !== 1) throw new ApiError('This payment was just changed by someone else — refresh and try again', 409)

      // Reverse the invoice effect (relative decrement, status derived from the updated row) — invoices and bills
      // only (advances and refunds settle no invoice). A bounced cheque already reversed its settlement when it bounced.
      if (current.invoiceId && (current.invoiceType === 'SALES' || current.invoiceType === 'PURCHASE') && current.chequeStatus !== 'BOUNCED') {
        const invModel = current.invoiceType === 'SALES' ? t.salesInvoice : t.purchaseInvoice
        const dec = await invModel.updateMany({
          where: { id: current.invoiceId, companyId },
          data: { paidAmount: { decrement: current.amount } },
        })
        if (dec.count === 1) {
          const inv = await invModel.findUniqueOrThrow({ where: { id: current.invoiceId } })
          const newPaid = r2(inv.paidAmount)
          const newStatus = inv.status === 'CANCELLED'
            ? inv.status
            : (newPaid <= 0.01 ? 'UNPAID' : (inv.grandTotal - newPaid <= 0.01 ? 'PAID' : 'PARTIALLY_PAID'))
          await invModel.update({ where: { id: inv.id }, data: { paidAmount: Math.max(0, newPaid), status: newStatus } })
        }
      }

      await logAudit(t, {
        companyId, userName: body?.userName, action: 'CANCEL', entity: 'Payment', entityId: id,
        details: current.invoiceType === 'SALES' || current.invoiceType === 'PURCHASE'
          ? `Payment ${current.number} voided — invoice balance restored${current.allocatedFromId ? ' (application removed)' : ''}`
          : `Payment ${current.number} voided (${current.invoiceType === ADVANCE ? 'advance' : 'refund'})`,
      })
      // Phase 5: voiding money that came in takes it back out of the account
      if (current.type === 'RECEIPT' && !NON_MONEY_MODES.includes(current.mode) && (current.chequeStatus === null || current.chequeStatus === 'CLEARED')) {
        await assertCashNotNegative(tx, { companyId, accounts: [current], from: moneyDate(current), override, what: `Voiding ${current.number}`, entity: 'Payment', entityId: id, userName: body?.userName })
      }
    }, CASH_TX)
    return ok({ id }, 'Payment voided')
  } catch (e) {
    return handleError(e)
  }
}

/** Decrement an invoice's paidAmount by `amount` and recompute its status (relative update, row-locked). */
async function reverseSettlement(t: any, companyId: string, invoiceType: string, invoiceId: string, amount: number) {
  const invModel = invoiceType === 'SALES' ? t.salesInvoice : t.purchaseInvoice
  const dec = await invModel.updateMany({ where: { id: invoiceId, companyId }, data: { paidAmount: { decrement: amount } } })
  if (dec.count !== 1) return null
  const inv = await invModel.findUniqueOrThrow({ where: { id: invoiceId } })
  const newPaid = Math.max(0, r2(inv.paidAmount))
  const newStatus = inv.status === 'CANCELLED'
    ? inv.status
    : (newPaid <= 0.01 ? 'UNPAID' : (inv.grandTotal - newPaid <= 0.01 ? 'PAID' : 'PARTIALLY_PAID'))
  await invModel.update({ where: { id: inv.id }, data: { paidAmount: newPaid, status: newStatus } })
  return { number: inv.number as string, status: newStatus }
}

// PATCH /api/payments/[id] { companyId, action: 'deposit' | 'clear' | 'bounce', date? } — cheque lifecycle
//   deposit: PENDING → DEPOSITED (cheque handed to the bank) — no money moves yet
//   clear:   PENDING/DEPOSITED → CLEARED, clearedDate = date (default today, IST). The money reaches the account
//            on that day: not before the payment date, the cheque date or the account's opening date, not in the future
//   bounce:  PENDING/DEPOSITED (or an un-tracked cheque) → BOUNCED; never counts in the account; the invoice
//            settlement is reversed
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  let idem: Idempotency | null = null
  try {
    requireWrite(req, 'payments')
    const { id } = await params
    const body = await req.json().catch(() => ({}) as any)
    const companyId = await companyRequired(req, body?.companyId)
    const action = String(body?.action || '').toLowerCase()
    // Apply part of a customer advance to an open invoice of that customer (no money moves)
    if (action === 'apply') {
      requireWrite(req, 'sales-invoices') // Phase 5: customer-side money
      idem = await claimIdempotency(req, companyId, `PATCH /api/payments/${id} apply`, body)
      if (idem.replay) return idem.replay
      const row = await db.$transaction(async (tx) => {
        const r = await applyCustomerCredit(tx, {
          companyId, source: 'ADVANCE', sourceId: id, invoiceId: body?.invoiceId, amount: body?.amount, date: body?.date, userName: body?.userName,
        })
        await idem!.done(tx, r, `Advance applied to ${r.invoiceNumber}`)
        return r
      })
      return ok(row, `Advance applied to ${row.invoiceNumber}`)
    }
    if (action === 'bounce') await requireSecurityPin(req, companyId)
    if (!['deposit', 'clear', 'bounce'].includes(action)) throw new ApiError("action must be 'apply', 'deposit', 'clear' or 'bounce'", 400)
    const when = businessDate(body?.date)

    const current = await db.payment.findFirst({ where: { id, companyId } })
    if (!current) throw new ApiError('Payment not found', 404)
    requireWrite(req, paymentKindModule(current)) // Phase 5: customer / supplier side of this payment
    const override = negativeCashOverride(req, body)
    if (current.mode !== 'CHEQUE') throw new ApiError('Only cheque payments have a cheque status', 400)

    const allowedFrom: Record<string, (string | null)[]> = {
      deposit: ['PENDING'],
      clear: ['PENDING', 'DEPOSITED'],
      bounce: ['PENDING', 'DEPOSITED', null],
    }
    if (!allowedFrom[action].includes(current.chequeStatus)) {
      throw new ApiError(`Cheque is ${current.chequeStatus ? current.chequeStatus.toLowerCase() : 'already counted as received'} — cannot ${action} it`, 400)
    }
    const nextStatus = action === 'deposit' ? 'DEPOSITED' : action === 'clear' ? 'CLEARED' : 'BOUNCED'
    if (action === 'clear') {
      const day = istDay(when)
      if (day > todayIst()) throw new ApiError('The clearing date cannot be in the future', 400)
      if (day < istDay(current.date)) throw new ApiError(`The clearing date cannot be before the payment date (${istDay(current.date)})`, 400)
      if (current.chequeDate && day < istDay(current.chequeDate)) throw new ApiError(`A cheque cannot clear before its cheque date (${istDay(current.chequeDate)})`, 400)
      const acc = current.accountId ? await db.moneyAccount.findFirst({ where: { id: current.accountId, companyId } }) : null
      if (acc) assertOnOrAfterOpening(acc, when, 'The clearing date')
    }

    const result = await db.$transaction(async (tx) => {
      const t = tx as any
      // Conditional status flip — a concurrent action on the same cheque gets 409 instead of double-reversing
      const flip = await tx.payment.updateMany({
        where: { id, companyId, chequeStatus: current.chequeStatus },
        data: { chequeStatus: nextStatus, ...(action === 'clear' ? { clearedDate: when } : {}) },
      })
      if (flip.count !== 1) throw new ApiError('This cheque was just changed by someone else — refresh and try again', 409)

      let invoiceNote = ''
      if (action === 'bounce' && current.invoiceType === ADVANCE) {
        // the flip above locked the advance; an applied advance cannot bounce until its applications are removed
        const used = (await advanceApplied(tx, companyId, [id])).get(id) || 0
        if (used > 0.005) throw new ApiError(`₹${used.toFixed(2)} of this advance is applied to invoices — remove those applications before marking the cheque bounced`, 400)
      }
      if (action === 'bounce' && current.invoiceId && (current.invoiceType === 'SALES' || current.invoiceType === 'PURCHASE')) {
        const inv = await reverseSettlement(t, companyId, current.invoiceType, current.invoiceId, current.amount)
        if (inv) invoiceNote = ` — ${inv.number} back to ${inv.status.replaceAll('_', ' ').toLowerCase()}`
      }
      await logAudit(t, {
        companyId, userName: body?.userName, action: 'UPDATE', entity: 'Payment', entityId: id,
        details: `Cheque ${current.chequeNo || ''} on ${current.number} ${nextStatus.toLowerCase()}${invoiceNote}`.replace('  ', ' '),
      })
      if (action === 'bounce') {
        await notify(t, { companyId, title: 'Cheque bounced', message: `${current.number} • ₹${current.amount.toFixed(2)}${invoiceNote}`, level: 'WARNING' })
        // Phase 5: a counted cheque received that bounces leaves the account (only a cash account is checked)
        if (current.type === 'RECEIPT' && current.chequeStatus === null) {
          await assertCashNotNegative(tx, { companyId, accounts: [current], from: current.date, override, what: `Bouncing ${current.number}`, entity: 'Payment', entityId: id, userName: body?.userName })
        }
      }
      return tx.payment.findUniqueOrThrow({ where: { id } })
    }, CASH_TX)
    return ok(result, action === 'deposit' ? 'Cheque deposited' : action === 'clear' ? 'Cheque cleared' : 'Cheque bounced — invoice balance restored')
  } catch (e) {
    await idem?.release()
    return handleError(e)
  }
}
