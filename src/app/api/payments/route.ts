import { db } from '@/lib/db'
import { ok, fail, handleError, companyRequired, nextDocNumber, computeGst, isInterState, postStock, logAudit, notify, ApiError, r2, requireWrite } from '@/lib/erp-helpers'
import { emitEvent } from '@/lib/emit-event'

// GET /api/payments?companyId=&type=RECEIPT|PAYMENT&customerId=&supplierId=&invoiceId=&q=
export async function GET(req: Request) {
  try {
    const companyId = await companyRequired(req)
    const { searchParams } = new URL(req.url)
    const type = (searchParams.get('type') || '').trim()
    const customerId = (searchParams.get('customerId') || '').trim()
    const supplierId = (searchParams.get('supplierId') || '').trim()
    const invoiceId = (searchParams.get('invoiceId') || '').trim()
    const q = (searchParams.get('q') || '').trim()

    const where: any = { companyId }
    if (type) where.type = type
    if (customerId) where.customerId = customerId
    if (supplierId) where.supplierId = supplierId
    if (invoiceId) where.invoiceId = invoiceId
    if (q) where.number = { contains: q }

    // Payment has no Prisma relations (plain customerId/supplierId/invoiceId strings) — resolve names via JS mapping
    const rows = await db.payment.findMany({ where, orderBy: { date: 'desc' } })

    const customerIds = Array.from(new Set(rows.filter((r) => r.customerId).map((r) => r.customerId as string)))
    const supplierIds = Array.from(new Set(rows.filter((r) => r.supplierId).map((r) => r.supplierId as string)))
    const salesIds = rows.filter((r) => r.invoiceType === 'SALES' && r.invoiceId).map((r) => r.invoiceId as string)
    const purchaseIds = rows.filter((r) => r.invoiceType === 'PURCHASE' && r.invoiceId).map((r) => r.invoiceId as string)

    const [customers, suppliers, salesInvoices, purchaseInvoices] = await Promise.all([
      customerIds.length ? db.customer.findMany({ where: { companyId, id: { in: customerIds } }, select: { id: true, name: true } }) : Promise.resolve([] as { id: string; name: string }[]),
      supplierIds.length ? db.supplier.findMany({ where: { companyId, id: { in: supplierIds } }, select: { id: true, name: true } }) : Promise.resolve([] as { id: string; name: string }[]),
      salesIds.length ? db.salesInvoice.findMany({ where: { companyId, id: { in: salesIds } }, select: { id: true, number: true } }) : Promise.resolve([] as { id: string; number: string }[]),
      purchaseIds.length ? db.purchaseInvoice.findMany({ where: { companyId, id: { in: purchaseIds } }, select: { id: true, number: true } }) : Promise.resolve([] as { id: string; number: string }[]),
    ])

    const customerMap = new Map(customers.map((c) => [c.id, c.name]))
    const supplierMap = new Map(suppliers.map((s) => [s.id, s.name]))
    const numberMap = new Map<string, string>()
    for (const inv of salesInvoices) numberMap.set(inv.id, inv.number)
    for (const inv of purchaseInvoices) numberMap.set(inv.id, inv.number)

    const items = rows.map((r) => ({
      ...r,
      customer: r.customerId ? { name: customerMap.get(r.customerId) ?? null } : null,
      supplier: r.supplierId ? { name: supplierMap.get(r.supplierId) ?? null } : null,
      invoiceNumber: r.invoiceId ? numberMap.get(r.invoiceId) ?? null : null,
    }))
    return ok({ items, total: items.length })
  } catch (e) {
    return handleError(e)
  }
}

// POST /api/payments
// { companyId, type: 'RECEIPT'|'PAYMENT', customerId?|supplierId?, invoiceType: 'SALES'|'PURCHASE',
//   invoiceId, amount, mode?, date?, reference?, notes?, userName? }
export async function POST(req: Request) {
  try {
    requireWrite(req, 'payments')
    const body = await req.json().catch(() => ({}) as any)
    const companyId = await companyRequired(req, body.companyId)

    const type = body.type
    if (!['RECEIPT', 'PAYMENT'].includes(type)) throw new ApiError('type must be RECEIPT or PAYMENT', 400)
    const invoiceType = body.invoiceType ? String(body.invoiceType) : (type === 'RECEIPT' ? 'SALES' : 'PURCHASE')
    if (type === 'RECEIPT' && invoiceType !== 'SALES') throw new ApiError('RECEIPT payments must reference a SALES invoice', 400)
    if (type === 'PAYMENT' && invoiceType !== 'PURCHASE') throw new ApiError('PAYMENT payments must reference a PURCHASE invoice', 400)
    if (!body.invoiceId) throw new ApiError('invoiceId is required', 400)

    const amount = r2(Number(body.amount))
    if (!(amount > 0)) throw new ApiError('amount must be greater than 0', 400)

    const customerId = type === 'RECEIPT' ? body.customerId : null
    const supplierId = type === 'PAYMENT' ? body.supplierId : null
    const partyType = type === 'RECEIPT' ? 'CUSTOMER' : 'SUPPLIER'
    if (type === 'RECEIPT' && !customerId) throw new ApiError('customerId is required for RECEIPT', 400)
    if (type === 'PAYMENT' && !supplierId) throw new ApiError('supplierId is required for PAYMENT', 400)

    const date = body.date ? new Date(body.date) : new Date()

    const result = await db.$transaction(async (tx) => {
      const t = tx as any
      // Party validation (tenant scope)
      if (customerId) {
        const c = await tx.customer.findFirst({ where: { id: customerId, companyId } })
        if (!c) throw new ApiError('Customer not found', 404)
      }
      if (supplierId) {
        const s = await tx.supplier.findFirst({ where: { id: supplierId, companyId } })
        if (!s) throw new ApiError('Supplier not found', 404)
      }

      // Invoice load with tenant guard
      const invoice = invoiceType === 'SALES'
        ? await tx.salesInvoice.findFirst({ where: { id: body.invoiceId, companyId } })
        : await tx.purchaseInvoice.findFirst({ where: { id: body.invoiceId, companyId } })
      if (!invoice) throw new ApiError(invoiceType === 'SALES' ? 'Sales invoice not found' : 'Purchase invoice not found', 404)
      if (invoice.status === 'CANCELLED') throw new ApiError('Invoice is cancelled', 400)
      const invParty = invoiceType === 'SALES' ? (invoice as any).customerId : (invoice as any).supplierId
      if (invParty !== (customerId || supplierId)) {
        throw new ApiError(`Invoice ${invoice.number} belongs to a different ${invoiceType === 'SALES' ? 'customer' : 'supplier'}`, 400)
      }

      const outstanding = r2(invoice.grandTotal - invoice.paidAmount)
      if (amount > outstanding + 0.01) throw new ApiError(`Amount exceeds outstanding (₹${outstanding.toFixed(2)})`)

      const number = await nextDocNumber(t, companyId, type === 'RECEIPT' ? 'RCPT' : 'PYMT', date)
      const payment = await tx.payment.create({
        data: {
          companyId,
          number,
          type,
          partyType,
          customerId: customerId || null,
          supplierId: supplierId || null,
          invoiceType,
          invoiceId: body.invoiceId,
          amount,
          mode: body.mode || 'NEFT',
          date,
          reference: body.reference ?? null,
          notes: body.notes ?? null,
        },
      })

      // Relative increment (locks the invoice row) — concurrent payments can't overwrite each other
      const invModel = invoiceType === 'SALES' ? t.salesInvoice : t.purchaseInvoice
      const inc = await invModel.updateMany({
        where: { id: invoice.id, status: { not: 'CANCELLED' } },
        data: { paidAmount: { increment: amount } },
      })
      if (inc.count !== 1) throw new ApiError('Invoice was just cancelled — refresh and try again', 409)
      const fresh = await invModel.findUniqueOrThrow({ where: { id: invoice.id } })
      const newPaid = r2(fresh.paidAmount)
      if (newPaid > r2(fresh.grandTotal) + 0.01) {
        throw new ApiError(`Amount exceeds outstanding (₹${r2(fresh.grandTotal - (newPaid - amount)).toFixed(2)})`, 400)
      }
      const newStatus = fresh.grandTotal - newPaid <= 0.01 ? 'PAID' : 'PARTIALLY_PAID'
      await invModel.update({ where: { id: invoice.id }, data: { status: newStatus } })

      await logAudit(t, {
        companyId, userName: body.userName, action: 'CREATE', entity: 'Payment', entityId: payment.id,
        details: `${type === 'RECEIPT' ? 'Receipt' : 'Payment'} ${number} • ₹${amount.toFixed(2)} ${type === 'RECEIPT' ? 'against' : 'towards'} ${invoice.number} (${invoiceType})`,
      })

      return {
        ...payment,
        invoiceNumber: invoice.number,
        invoiceStatus: newStatus,
        outstandingAfter: r2(fresh.grandTotal - newPaid),
      }
    })

    void emitEvent({ companyId, title: 'Payment recorded', message: `${type} ₹${amount.toFixed(2)} — ${partyType}`, topic: 'finance' })

    return ok(result, type === 'RECEIPT' ? 'Receipt recorded' : 'Payment recorded')
  } catch (e) {
    return handleError(e)
  }
}
