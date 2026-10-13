import { db } from '@/lib/db'
import { requireSecurityPin } from '@/lib/security-pin'
import { ok, fail, handleError, companyRequired, nextDocNumber, computeGst, isInterState, postStock, logAudit, notify, ApiError, r2, requireWrite } from '@/lib/erp-helpers'

// GET /api/payments/[id]?companyId=
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
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

// DELETE /api/payments/[id]?companyId=  — void a payment: reverse invoice paidAmount/status, delete record
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireWrite(req, 'payments')
    const { id } = await params
    const body = await req.json().catch(() => ({}) as any)
    const companyId = await companyRequired(req, body?.companyId)
    await requireSecurityPin(req, companyId)

    const current = await db.payment.findFirst({ where: { id, companyId } })
    if (!current) throw new ApiError('Payment not found', 404)
    // Credit / debit note adjustments are owned by their return document
    if (current.mode === 'CREDIT_NOTE' || current.mode === 'DEBIT_NOTE') throw new ApiError('Cancel the credit/debit note instead', 400)

    await db.$transaction(async (tx) => {
      const t = tx as any
      // Conditional delete first — a concurrent void of the same payment gets 409 instead of reversing twice
      const del = await tx.payment.deleteMany({ where: { id, companyId } })
      if (del.count !== 1) throw new ApiError('This payment was just changed by someone else — refresh and try again', 409)

      // Reverse the invoice effect (relative decrement, status derived from the updated row).
      // A bounced cheque already reversed its settlement when it bounced.
      if (current.invoiceId && current.invoiceType && current.chequeStatus !== 'BOUNCED') {
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
        details: `Payment ${current.number} voided — invoice balance restored`,
      })
    })
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
//   deposit: PENDING → DEPOSITED (cheque handed to the bank)
//   clear:   PENDING/DEPOSITED → CLEARED, clearedDate = date (counts in the account balance from now on)
//   bounce:  PENDING/DEPOSITED (or an un-tracked cheque) → BOUNCED; the invoice settlement is reversed
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireWrite(req, 'payments')
    const { id } = await params
    const body = await req.json().catch(() => ({}) as any)
    const companyId = await companyRequired(req, body?.companyId)
    const action = String(body?.action || '').toLowerCase()
    if (action === 'bounce') await requireSecurityPin(req, companyId)
    if (!['deposit', 'clear', 'bounce'].includes(action)) throw new ApiError("action must be 'deposit', 'clear' or 'bounce'", 400)
    let when = new Date()
    if (body?.date) {
      const s = String(body.date).trim()
      when = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00.000Z` : s)
      if (Number.isNaN(when.getTime())) throw new ApiError('date must be a valid date', 400)
    }

    const current = await db.payment.findFirst({ where: { id, companyId } })
    if (!current) throw new ApiError('Payment not found', 404)
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

    const result = await db.$transaction(async (tx) => {
      const t = tx as any
      // Conditional status flip — a concurrent action on the same cheque gets 409 instead of double-reversing
      const flip = await tx.payment.updateMany({
        where: { id, companyId, chequeStatus: current.chequeStatus },
        data: { chequeStatus: nextStatus, ...(action === 'clear' ? { clearedDate: when } : {}) },
      })
      if (flip.count !== 1) throw new ApiError('This cheque was just changed by someone else — refresh and try again', 409)

      let invoiceNote = ''
      if (action === 'bounce' && current.invoiceId && current.invoiceType) {
        const inv = await reverseSettlement(t, companyId, current.invoiceType, current.invoiceId, current.amount)
        if (inv) invoiceNote = ` — ${inv.number} back to ${inv.status.replaceAll('_', ' ').toLowerCase()}`
      }
      await logAudit(t, {
        companyId, userName: body?.userName, action: 'UPDATE', entity: 'Payment', entityId: id,
        details: `Cheque ${current.chequeNo || ''} on ${current.number} ${nextStatus.toLowerCase()}${invoiceNote}`.replace('  ', ' '),
      })
      if (action === 'bounce') {
        await notify(t, { companyId, title: 'Cheque bounced', message: `${current.number} • ₹${current.amount.toFixed(2)}${invoiceNote}`, level: 'WARNING' })
      }
      return tx.payment.findUniqueOrThrow({ where: { id } })
    })
    return ok(result, action === 'deposit' ? 'Cheque deposited' : action === 'clear' ? 'Cheque cleared' : 'Cheque bounced — invoice balance restored')
  } catch (e) {
    return handleError(e)
  }
}
