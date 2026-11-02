import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { ApiError, companyRequired, handleError, logAudit, ok, r2, requireWrite } from '@/lib/erp-helpers'
import { outstandingQty, poLineProgress, refreshPoReceiptStatus, type PoLineProgress } from '@/lib/po-receipt'

const CLOSURE_TYPES = ['WAIVED', 'CREDIT_NOTE']
// Giving up on material the supplier owes is a management decision, not a data-entry one
const CLOSURE_ROLES = ['TENANT_ADMIN', 'MANAGEMENT', 'SUPER_ADMIN', 'PURCHASE_MANAGER']

type HelperTx = Prisma.TransactionClient & Parameters<typeof logAudit>[0]

// POST /api/purchase-orders/[id]/closures { poItemId, qty, type: WAIVED | CREDIT_NOTE, reason, reference? }
// Formally closes rejected qty that will not be replaced, so the PO can complete. Records are never edited or deleted.
// Changes no stock and no money: a credit note itself is entered in Purchase Returns; this only references it.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = requireWrite(req, 'purchase-orders')
    if (!CLOSURE_ROLES.includes(actor.role)) throw new ApiError('Only a purchase manager or administrator can close rejected quantities', 403)
    const { id } = await params
    const body = await req.json()
    const companyId = await companyRequired(req, body.companyId)

    const type = String(body.type || '')
    if (!CLOSURE_TYPES.includes(type)) throw new ApiError('type must be WAIVED or CREDIT_NOTE', 400)
    const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
    if (!reason) throw new ApiError('A reason is required', 400)
    const reference = typeof body.reference === 'string' ? body.reference.trim() : ''
    if (type === 'CREDIT_NOTE' && !reference) throw new ApiError('Enter the supplier credit note number', 400)
    const rawQty = typeof body.qty === 'number' || typeof body.qty === 'string' ? Number(body.qty) : NaN
    if (!Number.isFinite(rawQty) || rawQty <= 0) throw new ApiError('Qty must be greater than 0', 400)
    const qty = r2(rawQty)

    const result = await db.$transaction(async (txRaw) => {
      const tx = txRaw as HelperTx
      // Locks the PO row: two closures, or a closure and a GRN post, cannot both use the same outstanding qty
      const lock = await tx.purchaseOrder.updateMany({
        where: { id, companyId, status: { in: ['APPROVED', 'PARTIALLY_RECEIVED'] } }, data: { updatedAt: new Date() },
      })
      if (lock.count !== 1) {
        const exists = await tx.purchaseOrder.count({ where: { id, companyId } })
        if (!exists) throw new ApiError('Purchase order not found', 404)
        throw new ApiError('Only an open purchase order can have quantities closed', 409, 'PO_NOT_OPEN')
      }
      const po = await tx.purchaseOrder.findFirstOrThrow({ where: { id, companyId }, include: { items: true } })
      const line = po.items.find((i) => i.id === body.poItemId)
      if (!line) throw new ApiError('poItemId does not belong to this purchase order', 400)
      const progress = (await poLineProgress(tx, [line.id])).get(line.id) as PoLineProgress
      const closable = Math.min(r2(progress.rejected - progress.closed), r2(outstandingQty(line.qty, progress) - progress.inQc))
      if (qty > closable + 0.01) {
        throw new ApiError(`Only ${Math.max(0, closable)} of this line can be closed: it must be rejected, still outstanding and not in QC`, 400, 'CLOSURE_QTY_TOO_HIGH')
      }
      const closure = await tx.purchaseOrderClosure.create({
        data: { companyId, poId: po.id, poItemId: line.id, qty, type, reason, reference: reference || null, createdBy: actor.userName },
      })
      const status = await refreshPoReceiptStatus(tx, po.id)
      await logAudit(tx, {
        companyId, userName: body.userName, action: 'CLOSE', entity: 'PurchaseOrder', entityId: po.id,
        details: `${po.number}: closed ${qty} rejected qty as ${type}${reference ? ` (${reference})` : ''} — ${reason}. PO is ${status}`,
      })
      return { closure, status }
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted })
    return ok(result, 'Rejected quantity closed')
  } catch (e) {
    return handleError(e)
  }
}
