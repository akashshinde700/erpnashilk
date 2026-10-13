import { db } from '@/lib/db'
import { ApiError, companyRequired, handleError, ok, r2, sessionUser } from '@/lib/erp-helpers'
import { canAccessModule } from '@/lib/erp-constants'

type Ctx = { params: Promise<{ kind: string; id: string }> }

const DAY = 86400000
const OPEN_SO = ['DRAFT', 'CONFIRMED', 'IN_PRODUCTION', 'READY', 'PARTIALLY_DISPATCHED']
const OPEN_PO = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'PARTIALLY_RECEIVED']

/** Days past due (0 when not due / settled). */
function overdueDays(due: Date | null, outstanding: number, now: number) {
  if (!due || outstanding <= 0.005) return 0
  return Math.max(0, Math.floor((now - due.getTime()) / DAY))
}

async function customerSide(companyId: string, customerId: string) {
  const now = Date.now()
  const [customer, enquiries, quotations, orders, deliveries, invoices, payments] = await Promise.all([
    db.customer.findFirst({ where: { id: customerId, companyId } }),
    db.enquiry.findMany({ where: { companyId, customerId }, orderBy: { date: 'desc' }, take: 100, select: { id: true, number: true, date: true, status: true } }),
    db.quotation.findMany({ where: { companyId, customerId }, orderBy: { date: 'desc' }, take: 100, select: { id: true, number: true, date: true, validUntil: true, status: true, grandTotal: true } }),
    db.salesOrder.findMany({
      where: { companyId, customerId }, orderBy: { orderDate: 'desc' }, take: 100,
      select: { id: true, number: true, orderDate: true, deliveryDate: true, status: true, grandTotal: true, items: { select: { qty: true, dispatchedQty: true, invoicedQty: true } } },
    }),
    db.deliveryChallan.findMany({
      where: { companyId, salesOrder: { customerId } }, orderBy: { date: 'desc' }, take: 100,
      select: { id: true, number: true, date: true, status: true, vehicleNo: true, salesOrder: { select: { number: true } } },
    }),
    db.salesInvoice.findMany({ where: { companyId, customerId }, orderBy: { date: 'desc' }, take: 200, select: { id: true, number: true, date: true, dueDate: true, status: true, grandTotal: true, paidAmount: true, salesOrderId: true } }),
    db.payment.findMany({ where: { companyId, customerId }, orderBy: { date: 'desc' }, take: 200, select: { id: true, number: true, date: true, amount: true, mode: true, reference: true, invoiceId: true } }),
  ])
  if (!customer) return null

  // Production jobs ("projects") behind this customer's orders
  const soIds = orders.map((o) => o.id)
  const workOrders = soIds.length
    ? await db.workOrder.findMany({
      where: { companyId, salesOrderId: { in: soIds } }, orderBy: { startDate: 'desc' },
      select: { id: true, number: true, status: true, plannedQty: true, producedQty: true, startDate: true, dueDate: true, salesOrderId: true, itemId: true },
    })
    : []
  const woItems = workOrders.length
    ? await db.item.findMany({ where: { id: { in: [...new Set(workOrders.map((w) => w.itemId))] } }, select: { id: true, code: true, name: true } })
    : []
  const itemMap = new Map(woItems.map((i) => [i.id, i]))
  const soNumber = new Map(orders.map((o) => [o.id, o.number]))
  const invNumber = new Map(invoices.map((i) => [i.id, i.number]))

  const live = invoices.filter((i) => i.status !== 'CANCELLED')
  const invRows = invoices.map((i) => {
    const outstanding = i.status === 'CANCELLED' ? 0 : r2(i.grandTotal - i.paidAmount)
    return { ...i, outstanding, overdueDays: overdueDays(i.dueDate, outstanding, now), salesOrder: i.salesOrderId ? soNumber.get(i.salesOrderId) ?? null : null }
  })
  const billed = r2(live.reduce((s, i) => s + i.grandTotal, 0))
  const received = r2(payments.reduce((s, p) => s + p.amount, 0))
  const invoiceOutstanding = r2(invRows.reduce((s, i) => s + i.outstanding, 0))
  const opening = r2(customer.openingBalance || 0)

  return {
    party: customer,
    summary: {
      billed,
      received,
      openingBalance: opening,
      outstanding: r2(opening + invoiceOutstanding),
      overdue: r2(invRows.filter((i) => i.overdueDays > 0).reduce((s, i) => s + i.outstanding, 0)),
      overdueCount: invRows.filter((i) => i.overdueDays > 0).length,
      openOrders: orders.filter((o) => OPEN_SO.includes(o.status)).length,
      openOrderValue: r2(orders.filter((o) => OPEN_SO.includes(o.status)).reduce((s, o) => s + o.grandTotal, 0)),
      creditLimit: customer.creditLimit,
      lastActivity: [invoices[0]?.date, payments[0]?.date, orders[0]?.orderDate].filter(Boolean).sort((a, b) => +b! - +a!)[0] ?? null,
    },
    enquiries,
    quotations,
    orders: orders.map(({ items, ...o }) => {
      const qty = items.reduce((s, l) => s + l.qty, 0)
      return {
        ...o,
        dispatchedPct: qty ? Math.min(100, Math.round((items.reduce((s, l) => s + l.dispatchedQty, 0) / qty) * 100)) : 0,
        invoicedPct: qty ? Math.min(100, Math.round((items.reduce((s, l) => s + l.invoicedQty, 0) / qty) * 100)) : 0,
        workOrders: workOrders.filter((w) => w.salesOrderId === o.id).map((w) => w.number),
      }
    }),
    workOrders: workOrders.map((w) => ({ ...w, item: itemMap.get(w.itemId) ?? null, salesOrder: w.salesOrderId ? soNumber.get(w.salesOrderId) ?? null : null })),
    deliveries: deliveries.map((d) => ({ ...d, salesOrder: d.salesOrder?.number ?? null })),
    invoices: invRows,
    payments: payments.map((p) => ({ ...p, invoice: p.invoiceId ? invNumber.get(p.invoiceId) ?? null : null })),
  }
}

async function supplierSide(companyId: string, supplierId: string) {
  const now = Date.now()
  const [supplier, orders, grns, invoices, payments] = await Promise.all([
    db.supplier.findFirst({ where: { id: supplierId, companyId } }),
    db.purchaseOrder.findMany({ where: { companyId, supplierId }, orderBy: { orderDate: 'desc' }, take: 100, select: { id: true, number: true, orderDate: true, expectedDate: true, status: true, grandTotal: true } }),
    db.grn.findMany({ where: { companyId, po: { supplierId } }, orderBy: { date: 'desc' }, take: 100, select: { id: true, number: true, date: true, status: true, po: { select: { number: true } } } }),
    db.purchaseInvoice.findMany({ where: { companyId, supplierId }, orderBy: { date: 'desc' }, take: 200, select: { id: true, number: true, supplierInvNo: true, date: true, status: true, grandTotal: true, paidAmount: true } }),
    db.payment.findMany({ where: { companyId, supplierId }, orderBy: { date: 'desc' }, take: 200, select: { id: true, number: true, date: true, amount: true, mode: true, reference: true, invoiceId: true } }),
  ])
  if (!supplier) return null
  const invNumber = new Map(invoices.map((i) => [i.id, i.number]))
  const terms = supplier.paymentTermsDays ?? 30
  const invRows = invoices.map((i) => {
    const outstanding = i.status === 'CANCELLED' ? 0 : r2(i.grandTotal - i.paidAmount)
    const due = new Date(i.date.getTime() + terms * DAY)
    return { ...i, dueDate: due, outstanding, overdueDays: overdueDays(due, outstanding, now) }
  })
  const live = invoices.filter((i) => i.status !== 'CANCELLED')
  const opening = r2(supplier.openingBalance || 0)
  return {
    party: supplier,
    summary: {
      billed: r2(live.reduce((s, i) => s + i.grandTotal, 0)),
      paid: r2(payments.reduce((s, p) => s + p.amount, 0)),
      openingBalance: opening,
      outstanding: r2(opening + invRows.reduce((s, i) => s + i.outstanding, 0)),
      overdue: r2(invRows.filter((i) => i.overdueDays > 0).reduce((s, i) => s + i.outstanding, 0)),
      overdueCount: invRows.filter((i) => i.overdueDays > 0).length,
      openOrders: orders.filter((o) => OPEN_PO.includes(o.status)).length,
      openOrderValue: r2(orders.filter((o) => OPEN_PO.includes(o.status)).reduce((s, o) => s + o.grandTotal, 0)),
      creditLimit: supplier.creditLimit,
      lastActivity: [invoices[0]?.date, payments[0]?.date, orders[0]?.orderDate].filter(Boolean).sort((a, b) => +b! - +a!)[0] ?? null,
    },
    orders,
    grns: grns.map((g) => ({ ...g, po: g.po?.number ?? null })),
    invoices: invRows,
    payments: payments.map((p) => ({ ...p, invoice: p.invoiceId ? invNumber.get(p.invoiceId) ?? null : null })),
  }
}

// GET /api/parties/[kind]/[id] — party 360: profile, money summary and full document history.
// kind = customer | supplier. A "Both" party returns both sides (each only if the role may see it).
export async function GET(req: Request, { params }: Ctx) {
  try {
    const { kind, id } = await params
    if (kind !== 'customer' && kind !== 'supplier') throw new ApiError('kind must be customer or supplier', 400)
    const companyId = await companyRequired(req)
    const me = await sessionUser(req)
    if (!canAccessModule(me.role, kind === 'customer' ? 'customers' : 'suppliers')) throw new ApiError('Your role cannot view this party', 403)

    let customerId: string | null = null
    let supplierId: string | null = null
    if (kind === 'customer') {
      const c = await db.customer.findFirst({ where: { id, companyId }, select: { id: true, supplierId: true } })
      if (!c) throw new ApiError('Customer not found', 404)
      customerId = c.id
      supplierId = c.supplierId
    } else {
      const s = await db.supplier.findFirst({ where: { id, companyId }, select: { id: true, customer: { select: { id: true } } } })
      if (!s) throw new ApiError('Supplier not found', 404)
      supplierId = s.id
      customerId = s.customer?.id ?? null
    }
    const [asCustomer, asSupplier] = await Promise.all([
      customerId && canAccessModule(me.role, 'customers') ? customerSide(companyId, customerId) : null,
      supplierId && canAccessModule(me.role, 'suppliers') ? supplierSide(companyId, supplierId) : null,
    ])
    return ok({ kind, asCustomer, asSupplier })
  } catch (e) {
    return handleError(e)
  }
}
