import { db } from '@/lib/db'
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

    const current = await db.payment.findFirst({ where: { id, companyId } })
    if (!current) throw new ApiError('Payment not found', 404)

    await db.$transaction(async (tx) => {
      const t = tx as any
      // Conditional delete first — a concurrent void of the same payment gets 409 instead of reversing twice
      const del = await tx.payment.deleteMany({ where: { id, companyId } })
      if (del.count !== 1) throw new ApiError('This payment was just changed by someone else — refresh and try again', 409)

      // Reverse the invoice effect (relative decrement, status derived from the updated row)
      if (current.invoiceId && current.invoiceType) {
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
