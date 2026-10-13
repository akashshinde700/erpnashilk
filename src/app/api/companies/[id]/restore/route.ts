import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { ApiError, companyRequired, handleError, logAudit, ok, sessionUser } from '@/lib/erp-helpers'

type Ctx = { params: Promise<{ id: string }> }

/**
 * Tables in a backup (key in backup.data → Prisma model), in insert order (parents first).
 * `parent` = [foreign-key field, backup key of the header] for document lines (they carry no companyId).
 * Users are never restored: logins and passwords stay as they are now.
 */
const TABLES: { key: string; model: string; parent?: [string, string] }[] = [
  { key: 'warehouses', model: 'Warehouse' },
  { key: 'plants', model: 'Plant' },
  { key: 'machines', model: 'Machine' },
  { key: 'items', model: 'Item' },
  { key: 'suppliers', model: 'Supplier' },
  { key: 'customers', model: 'Customer' },
  { key: 'boms', model: 'Bom' },
  { key: 'bomItems', model: 'BomItem', parent: ['bomId', 'boms'] },
  { key: 'enquiries', model: 'Enquiry' },
  { key: 'enquiryItems', model: 'EnquiryItem', parent: ['enquiryId', 'enquiries'] },
  { key: 'quotations', model: 'Quotation' },
  { key: 'quotationItems', model: 'QuotationItem', parent: ['quotationId', 'quotations'] },
  { key: 'salesOrders', model: 'SalesOrder' },
  { key: 'salesOrderItems', model: 'SalesOrderItem', parent: ['salesOrderId', 'salesOrders'] },
  { key: 'workOrders', model: 'WorkOrder' },
  { key: 'deliveries', model: 'DeliveryChallan' },
  { key: 'deliveryChallanItems', model: 'DeliveryChallanItem', parent: ['challanId', 'deliveries'] },
  { key: 'salesInvoices', model: 'SalesInvoice' },
  { key: 'salesInvoiceItems', model: 'SalesInvoiceItem', parent: ['invoiceId', 'salesInvoices'] },
  { key: 'purchaseRequisitions', model: 'PurchaseRequisition' },
  { key: 'purchaseRequisitionItems', model: 'PurchaseRequisitionItem', parent: ['prId', 'purchaseRequisitions'] },
  { key: 'purchaseOrders', model: 'PurchaseOrder' },
  { key: 'purchaseOrderItems', model: 'PurchaseOrderItem', parent: ['poId', 'purchaseOrders'] },
  { key: 'grns', model: 'Grn' },
  { key: 'grnItems', model: 'GrnItem', parent: ['grnId', 'grns'] },
  { key: 'purchaseInvoices', model: 'PurchaseInvoice' },
  { key: 'purchaseInvoiceItems', model: 'PurchaseInvoiceItem', parent: ['invoiceId', 'purchaseInvoices'] },
  { key: 'materialIssues', model: 'MaterialIssue' },
  { key: 'materialIssueItems', model: 'MaterialIssueItem', parent: ['issueId', 'materialIssues'] },
  { key: 'productionEntries', model: 'ProductionEntry' },
  { key: 'qcInspections', model: 'QcInspection' },
  { key: 'stockBalances', model: 'StockBalance' },
  { key: 'stockLedger', model: 'StockLedger' },
  { key: 'expenses', model: 'Expense' },
  { key: 'payments', model: 'Payment' },
  { key: 'notifications', model: 'Notification' },
  { key: 'auditLogs', model: 'AuditLog' },
  { key: 'numberSeqs', model: 'NumberSeq' },
]

// Company columns that belong to the platform subscription, never taken from a backup
const COMPANY_KEEP = new Set(['id', 'isPlatform', 'slug', 'planId', 'status', 'billingCycle', 'paidUntil', 'trialEndsAt', 'maxUsers', 'maxWarehouses', 'maxItems', 'createdAt', 'updatedAt'])

const delegate = (tx: Prisma.TransactionClient, model: string) =>
  (tx as unknown as Record<string, { createMany: (a: { data: object[] }) => Promise<unknown>; deleteMany: (a: object) => Promise<unknown> }>)[model.charAt(0).toLowerCase() + model.slice(1)]

/** Scalar column names of a model (unknown keys in an older/newer backup are dropped). */
function scalarFields(model: string): Set<string> {
  const m = Prisma.dmmf.datamodel.models.find((x) => x.name === model)
  if (!m) throw new ApiError(`Unknown table ${model}`, 500)
  return new Set(m.fields.filter((f) => f.kind === 'scalar' || f.kind === 'enum').map((f) => f.name))
}

// POST /api/companies/[id]/restore { confirmName, backup } — replace this company's data with a backup
// of the SAME company (downloaded from Settings → Data & Backup). Admins only. All-or-nothing.
export async function POST(req: Request, { params }: Ctx) {
  try {
    const me = await sessionUser(req)
    if (!['TENANT_ADMIN', 'MANAGEMENT', 'SUPER_ADMIN'].includes(me.role)) throw new ApiError('Only administrators can restore a backup', 403)
    const { id } = await params
    const companyId = await companyRequired(req, id)
    const company = await db.company.findUnique({ where: { id: companyId } })
    if (!company) throw new ApiError('Company not found', 404)

    const body = await req.json().catch(() => null) as { confirmName?: string; backup?: { meta?: { companyId?: string; version?: number }; data?: Record<string, unknown> } } | null
    if (!body?.backup?.data || !body.backup.meta) throw new ApiError('This is not a ManuFlow backup file', 400)
    if (String(body.confirmName || '').trim() !== company.name) throw new ApiError('Type the company name exactly to confirm', 400)
    const { meta, data } = body.backup
    if (meta.version !== 1) throw new ApiError(`Unsupported backup version ${meta.version}`, 400)
    if (meta.companyId !== companyId) throw new ApiError('This backup belongs to a different company — it can only be restored into the company it was taken from', 400)

    // Validate + clean every table before touching anything
    const rowsByKey = new Map<string, Record<string, unknown>[]>()
    const idsByKey = new Map<string, Set<string>>()
    for (const t of TABLES) {
      const raw = data[t.key]
      if (raw !== undefined && !Array.isArray(raw)) throw new ApiError(`Backup table ${t.key} is malformed`, 400)
      const allowed = scalarFields(t.model)
      const rows = ((raw as Record<string, unknown>[] | undefined) ?? []).map((r) => {
        const clean: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(r ?? {})) if (allowed.has(k)) clean[k] = v
        if (allowed.has('companyId')) clean.companyId = companyId // never write into another tenant
        return clean
      })
      if (t.parent) {
        const [fk, parentKey] = t.parent
        const parents = idsByKey.get(parentKey) ?? new Set()
        if (rows.some((r) => !parents.has(String(r[fk])))) throw new ApiError(`Backup is inconsistent: ${t.key} refers to missing ${parentKey}`, 400)
      }
      rowsByKey.set(t.key, rows)
      idsByKey.set(t.key, new Set(rows.map((r) => String(r.id))))
    }

    const total = [...rowsByKey.values()].reduce((s, r) => s + r.length, 0)
    await db.$transaction(async (tx) => {
      const w = { where: { companyId } }
      // Remove current data (children before parents; document lines cascade with their headers)
      for (const m of ['StockLedger', 'StockBalance', 'Payment', 'Expense', 'Notification', 'NumberSeq', 'AuditLog', 'QcInspection',
        'ProductionEntry', 'MaterialIssue', 'SalesInvoice', 'PurchaseInvoice', 'DeliveryChallan', 'Grn', 'WorkOrder', 'SalesOrder',
        'Quotation', 'Enquiry', 'PurchaseOrder', 'PurchaseRequisition', 'Bom', 'Customer', 'Supplier', 'Item', 'Machine', 'Plant', 'Warehouse']) {
        await delegate(tx, m).deleteMany(w)
      }
      // Company profile from the backup (subscription fields stay)
      const backupCompany = (data.company ?? {}) as Record<string, unknown>
      const companyFields = scalarFields('Company')
      const profile = Object.fromEntries(Object.entries(backupCompany).filter(([k]) => companyFields.has(k) && !COMPANY_KEEP.has(k)))
      if (Object.keys(profile).length) await tx.company.update({ where: { id: companyId }, data: profile })
      // Re-insert in dependency order
      for (const t of TABLES) {
        const rows = rowsByKey.get(t.key) ?? []
        for (let i = 0; i < rows.length; i += 500) await delegate(tx, t.model).createMany({ data: rows.slice(i, i + 500) })
      }
    }, { timeout: 300000, maxWait: 20000 })

    await logAudit(db as never, {
      companyId, userName: me.name, action: 'CONFIG', entity: 'COMPANY', entityId: companyId,
      details: `Data restored from backup taken ${String((meta as { exportedAt?: string }).exportedAt || '').slice(0, 19).replace('T', ' ')} (${total} records)`,
    })
    return ok({ restored: total }, `Backup restored — ${total} records`)
  } catch (e) {
    return handleError(e)
  }
}
