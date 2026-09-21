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
      // Reverse the invoice effect
      if (current.invoiceId && current.invoiceType) {
        if (current.invoiceType === 'SALES') {
          const inv = await tx.salesInvoice.findFirst({ where: { id: current.invoiceId, companyId } })
          if (inv) {
            const newPaid = r2(inv.paidAmount - current.amount)
            const newStatus = inv.status === 'CANCELLED' ? inv.status : (newPaid <= 0.01 ? 'UNPAID' : 'PARTIALLY_PAID')
            await tx.salesInvoice.update({ where: { id: inv.id }, data: { paidAmount: newPaid, status: newStatus } })
          }
        } else {
          const inv = await tx.purchaseInvoice.findFirst({ where: { id: current.invoiceId, companyId } })
          if (inv) {
            const newPaid = r2(inv.paidAmount - current.amount)
            const newStatus = inv.status === 'CANCELLED' ? inv.status : (newPaid <= 0.01 ? 'UNPAID' : 'PARTIALLY_PAID')
            await tx.purchaseInvoice.update({ where: { id: inv.id }, data: { paidAmount: newPaid, status: newStatus } })
          }
        }
      }

      await tx.payment.delete({ where: { id } })
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
