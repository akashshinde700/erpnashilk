import { Prisma } from '@prisma/client'
import { ApiError, logAudit, nextDocNumber, r2 } from '@/lib/erp-helpers'
import { businessDate, istDay } from '@/lib/business-date'
import { ADVANCE, ADVANCE_ADJ, advanceApplied, salesReturnCredits } from '@/lib/party-credits'

type Tx = Prisma.TransactionClient

/**
 * Apply a customer credit to an open sales invoice of the same customer — no money moves (Phase 4):
 *  - source 'ADVANCE': a customer advance payment → ADVANCE_ADJ row (liability "Customer advances" goes down)
 *  - source 'RETURN' : a sales return's remaining credit → CREDIT_NOTE row (liability "Refunds due to customers" goes down)
 * The source row is locked first and its remaining credit recomputed, then the invoice is incremented under its own
 * row lock — concurrent applications of one credit (or onto one invoice) cannot over-apply.
 */
export async function applyCustomerCredit(tx: Tx, input: {
  companyId: string; source: 'ADVANCE' | 'RETURN'; sourceId: string; invoiceId: unknown; amount: unknown; date?: unknown; userName?: string
}) {
  const { companyId, source, sourceId } = input
  const amount = r2(Number(input.amount))
  if (!(amount > 0)) throw new ApiError('Enter an amount greater than 0', 400)
  if (!input.invoiceId) throw new ApiError('Choose the invoice to apply it to', 400)
  const date = businessDate(input.date)

  // 1. Lock the source and work out what is left on it
  let customerId: string
  let sourceNumber: string
  let sourceDate: Date
  let remaining: number
  if (source === 'ADVANCE') {
    await tx.payment.updateMany({ where: { id: sourceId, companyId }, data: { updatedAt: new Date() } })
    const adv = await tx.payment.findFirst({ where: { id: sourceId, companyId } })
    if (!adv || adv.invoiceType !== ADVANCE) throw new ApiError('Advance not found', 404)
    if (adv.chequeStatus === 'BOUNCED') throw new ApiError(`The cheque for advance ${adv.number} bounced — nothing to apply`, 400)
    customerId = adv.customerId as string
    sourceNumber = adv.number
    sourceDate = adv.date
    remaining = r2(adv.amount - ((await advanceApplied(tx, companyId, [adv.id])).get(adv.id) || 0))
  } else {
    const lock = await tx.salesReturn.updateMany({ where: { id: sourceId, companyId, status: 'POSTED' }, data: { updatedAt: new Date() } })
    const ret = await tx.salesReturn.findFirst({ where: { id: sourceId, companyId } })
    if (!ret) throw new ApiError('Sales return not found', 404)
    if (lock.count !== 1) throw new ApiError(`Sales return ${ret.number} is cancelled`, 400)
    customerId = ret.customerId
    sourceNumber = ret.number
    sourceDate = ret.date
    remaining = (await salesReturnCredits(tx, companyId, [ret])).get(ret.id)!.remaining
  }
  if (amount > remaining + 0.005) throw new ApiError(`Only ₹${remaining.toFixed(2)} is left on ${sourceNumber}`, 400)

  // 2. The invoice: same customer, open, dated on or before the application
  const inv = await tx.salesInvoice.findFirst({ where: { id: String(input.invoiceId), companyId } })
  if (!inv) throw new ApiError('Sales invoice not found', 404)
  if (inv.status === 'CANCELLED') throw new ApiError(`Invoice ${inv.number} is cancelled`, 400)
  if (inv.customerId !== customerId) throw new ApiError(`Invoice ${inv.number} belongs to a different customer`, 400)
  const earliest = istDay(sourceDate) > istDay(inv.date) ? sourceDate : inv.date
  if (istDay(date) < istDay(earliest)) throw new ApiError(`The application date cannot be before ${istDay(earliest)} (the ${earliest === sourceDate ? sourceNumber : `invoice ${inv.number}`} date)`, 400)

  // 3. Settle the invoice under its row lock; refuse more than its outstanding
  const inc = await tx.salesInvoice.updateMany({ where: { id: inv.id, status: { not: 'CANCELLED' } }, data: { paidAmount: { increment: amount } } })
  if (inc.count !== 1) throw new ApiError('Invoice was just cancelled — refresh and try again', 409)
  const fresh = await tx.salesInvoice.findUniqueOrThrow({ where: { id: inv.id } })
  if (r2(fresh.paidAmount) > r2(fresh.grandTotal) + 0.01) {
    throw new ApiError(`Amount exceeds the outstanding on ${inv.number} (₹${r2(fresh.grandTotal - fresh.paidAmount + amount).toFixed(2)})`, 400)
  }
  await tx.salesInvoice.update({ where: { id: inv.id }, data: { status: fresh.grandTotal - r2(fresh.paidAmount) <= 0.01 ? 'PAID' : 'PARTIALLY_PAID' } })

  // 4. The application row (no money): mode tells the source apart; allocatedFromId links it
  const number = await nextDocNumber(tx as never, companyId, 'ADJ', date)
  const row = await tx.payment.create({
    data: {
      companyId, number, type: 'RECEIPT', partyType: 'CUSTOMER', customerId, invoiceType: 'SALES', invoiceId: inv.id,
      amount, mode: source === 'ADVANCE' ? ADVANCE_ADJ : 'CREDIT_NOTE', date, allocatedFromId: sourceId, reference: sourceNumber,
      notes: `${source === 'ADVANCE' ? 'Advance' : 'Return credit'} ${sourceNumber} applied to ${inv.number}`,
    },
  })
  await logAudit(tx as never, {
    companyId, userName: input.userName, action: 'CREATE', entity: 'Payment', entityId: row.id,
    details: `${number} • ₹${amount.toFixed(2)} of ${source === 'ADVANCE' ? 'advance' : 'credit note'} ${sourceNumber} applied to ${inv.number} (no money moved)`,
  })
  return { ...row, invoiceNumber: inv.number, remainingAfter: r2(remaining - amount) }
}
