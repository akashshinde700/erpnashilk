import { db } from '@/lib/db'
import { ApiError, companyRequired, fail, getActor, handleError, logAudit } from '@/lib/erp-helpers'

type Ctx = { params: Promise<{ id: string }> }

// GET /api/companies/[id]/backup?companyId= — full tenant data backup (raw JSON download).
// Sensitive read: admin-only (TENANT_ADMIN / MANAGEMENT / SUPER_ADMIN), the :id path
// param must match the resolved ?companyId= tenant, and the response is streamed as an
// attachment (content-disposition) instead of the standard ok() envelope.
export async function GET(req: Request, { params }: Ctx) {
  try {
    // (a) middleware identity headers must exist
    const actor = getActor(req)
    if (!actor) throw new ApiError('Unauthorized — sign in to continue', 401)

    // (b) admin-only export
    if (!['TENANT_ADMIN', 'MANAGEMENT', 'SUPER_ADMIN'].includes(actor.role)) {
      throw new ApiError('Only administrators can download backups', 403)
    }

    // (c) ?companyId= must resolve to a valid tenant…
    const companyId = await companyRequired(req)
    const { id } = await params

    // (d) …and match the :id path param (no cross-tenant exports)
    if (companyId !== id) throw new ApiError('Company mismatch', 403)

    const company = await db.company.findUnique({ where: { id } })
    if (!company) throw new ApiError('Company not found', 404)

    // Gather the full tenant snapshot (read-only finds; line tables hang off their
    // parent via relation filters since they carry no companyId column).
    const w = { companyId: id }
    const [
      users, items, customers, suppliers, warehouses, machines, plants, boms,
      enquiries, quotations, salesOrders, deliveries, salesInvoices, payments,
      purchaseRequisitions, purchaseOrders, grns, purchaseInvoices,
      workOrders, materialIssues, productionEntries, qcInspections,
      stockBalances, stockLedger, expenses,
      notifications, auditLogs, numberSeqs,
      bomItems, enquiryItems, quotationItems, salesOrderItems, deliveryChallanItems,
      salesInvoiceItems, purchaseRequisitionItems, purchaseOrderItems, grnItems,
      purchaseInvoiceItems, materialIssueItems,
    ] = await Promise.all([
      db.user.findMany({ where: w, orderBy: { id: 'asc' } }),
      db.item.findMany({ where: w, orderBy: { id: 'asc' } }),
      db.customer.findMany({ where: w, orderBy: { id: 'asc' } }),
      db.supplier.findMany({ where: w, orderBy: { id: 'asc' } }),
      db.warehouse.findMany({ where: w, orderBy: { id: 'asc' } }),
      db.machine.findMany({ where: w, orderBy: { id: 'asc' } }),
      db.plant.findMany({ where: w, orderBy: { id: 'asc' } }),
      db.bom.findMany({ where: w, orderBy: { id: 'asc' } }),
      db.enquiry.findMany({ where: w, orderBy: { id: 'asc' } }),
      db.quotation.findMany({ where: w, orderBy: { id: 'asc' } }),
      db.salesOrder.findMany({ where: w, orderBy: { id: 'asc' } }),
      db.deliveryChallan.findMany({ where: w, orderBy: { id: 'asc' } }),
      db.salesInvoice.findMany({ where: w, orderBy: { id: 'asc' } }),
      db.payment.findMany({ where: w, orderBy: { id: 'asc' } }),
      db.purchaseRequisition.findMany({ where: w, orderBy: { id: 'asc' } }),
      db.purchaseOrder.findMany({ where: w, orderBy: { id: 'asc' } }),
      db.grn.findMany({ where: w, orderBy: { id: 'asc' } }),
      db.purchaseInvoice.findMany({ where: w, orderBy: { id: 'asc' } }),
      db.workOrder.findMany({ where: w, orderBy: { id: 'asc' } }),
      db.materialIssue.findMany({ where: w, orderBy: { id: 'asc' } }),
      db.productionEntry.findMany({ where: w, orderBy: { id: 'asc' } }),
      db.qcInspection.findMany({ where: w, orderBy: { id: 'asc' } }),
      db.stockBalance.findMany({ where: w, orderBy: { id: 'asc' } }),
      db.stockLedger.findMany({ where: w, orderBy: { id: 'asc' } }),
      db.expense.findMany({ where: w, orderBy: { id: 'asc' } }),
      db.notification.findMany({ where: w, orderBy: { id: 'asc' } }),
      db.auditLog.findMany({ where: w, orderBy: { id: 'asc' } }),
      db.numberSeq.findMany({ where: w, orderBy: { id: 'asc' } }),
      db.bomItem.findMany({ where: { bom: { companyId: id } }, orderBy: { id: 'asc' } }),
      db.enquiryItem.findMany({ where: { enquiry: { companyId: id } }, orderBy: { id: 'asc' } }),
      db.quotationItem.findMany({ where: { quotation: { companyId: id } }, orderBy: { id: 'asc' } }),
      db.salesOrderItem.findMany({ where: { salesOrder: { companyId: id } }, orderBy: { id: 'asc' } }),
      db.deliveryChallanItem.findMany({ where: { challan: { companyId: id } }, orderBy: { id: 'asc' } }),
      db.salesInvoiceItem.findMany({ where: { invoice: { companyId: id } }, orderBy: { id: 'asc' } }),
      db.purchaseRequisitionItem.findMany({ where: { pr: { companyId: id } }, orderBy: { id: 'asc' } }),
      db.purchaseOrderItem.findMany({ where: { po: { companyId: id } }, orderBy: { id: 'asc' } }),
      db.grnItem.findMany({ where: { grn: { companyId: id } }, orderBy: { id: 'asc' } }),
      db.purchaseInvoiceItem.findMany({ where: { invoice: { companyId: id } }, orderBy: { id: 'asc' } }),
      db.materialIssueItem.findMany({ where: { issue: { companyId: id } }, orderBy: { id: 'asc' } }),
    ])

    const data: Record<string, unknown> = {
      company,
      users, items, customers, suppliers, warehouses, machines, plants, boms,
      enquiries, quotations, salesOrders, deliveries, salesInvoices, payments,
      purchaseRequisitions, purchaseOrders, grns, purchaseInvoices,
      workOrders, materialIssues, productionEntries, qcInspections,
      stockBalances, stockLedger, expenses,
      notifications, auditLogs, numberSeqs,
      bomItems, enquiryItems, quotationItems, salesOrderItems, deliveryChallanItems,
      salesInvoiceItems, purchaseRequisitionItems, purchaseOrderItems, grnItems,
      purchaseInvoiceItems, materialIssueItems,
    }

    const counts: Record<string, number> = {}
    for (const [k, v] of Object.entries(data)) counts[k] = Array.isArray(v) ? v.length : v ? 1 : 0

    // Best-effort audit trail — never block the download.
    try {
      await logAudit(db as never, {
        companyId: id,
        userName: actor.userName,
        action: 'EXPORT',
        entity: 'COMPANY',
        entityId: id,
        details: 'Data backup downloaded',
      })
    } catch { /* best-effort */ }

    const now = new Date()
    const ymd = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    const payload = {
      meta: { exportedAt: now.toISOString(), companyId: id, companyName: company.name, version: 1, counts },
      data,
    }

    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'content-disposition': `attachment; filename="manuflow-backup-${id}-${ymd}.json"`,
      },
    })
  } catch (e) {
    return handleError(e)
  }
}

// Other methods are not part of the backup contract.
export async function POST() {
  return fail('Backup export is read-only — use GET', 405)
}
