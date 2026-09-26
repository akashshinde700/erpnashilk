import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { ok, handleError, companyRequired, logAudit, ApiError, r2, requireWrite } from '@/lib/erp-helpers'

// prisma 6.x generated delegates are not structurally assignable to the shared helpers' minimal
// tx types — intersect once and cast the transaction client at the boundary.
type HelperTx = Prisma.TransactionClient & Parameters<typeof logAudit>[0]

async function attachItemInfo<T extends { items: { itemId: string }[] }>(companyId: string, docs: T[]) {
  const ids = Array.from(new Set(docs.flatMap((d) => d.items.map((i) => i.itemId))))
  const items = ids.length
    ? await db.item.findMany({ where: { companyId, id: { in: ids } }, select: { id: true, code: true, name: true, uom: true } })
    : []
  const map = new Map(items.map((i) => [i.id, i]))
  return docs.map((d) => ({ ...d, items: d.items.map((i) => ({ ...i, item: map.get(i.itemId) || null })) }))
}

async function findInvoice(id: string, companyId: string) {
  const pinv = await db.purchaseInvoice.findFirst({
    where: { id, companyId },
    include: {
      supplier: { select: { id: true, code: true, name: true, gstin: true, state: true, stateCode: true, paymentTermsDays: true } },
      po: { select: { id: true, number: true, status: true } },
      items: true,
    },
  })
  if (!pinv) throw new ApiError('Purchase invoice not found', 404)
  return pinv
}

// ============================== GET /api/purchase-invoices/[id] ==============================
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const companyId = await companyRequired(req)
    const pinv = await findInvoice(id, companyId)
    const [row] = await attachItemInfo(companyId, [pinv])
    return ok(row)
  } catch (e) {
    return handleError(e)
  }
}

// ============================== PATCH /api/purchase-invoices/[id] — action=cancel ==============================
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireWrite(req, 'purchase-invoices')
    const { id } = await params
    const body = await req.json()
    const companyId = await companyRequired(req, body.companyId)
    const pinv = await findInvoice(id, companyId)

    if (body.action !== 'cancel') throw new ApiError(`Unknown action '${body.action}' (use cancel)`, 400)
    if (pinv.status === 'CANCELLED') throw new ApiError('Invoice is already cancelled', 400)
    if (pinv.paidAmount > 0) throw new ApiError('Cannot cancel: payments already recorded against this invoice', 400)

    const updated = await db.$transaction(async (txRaw) => {
      const tx = txRaw as HelperTx
      // Atomic claim: only while still unpaid, so a payment landing concurrently can't be lost
      const claim = await tx.purchaseInvoice.updateMany({
        where: { id: pinv.id, status: { in: ['UNPAID', 'PARTIALLY_PAID', 'PAID'] }, paidAmount: { lte: 0.005 } },
        data: { status: 'CANCELLED' },
      })
      if (claim.count !== 1) throw new ApiError('This invoice was just changed (payment or cancel) — refresh and try again', 409)
      // POST moved a fully-received PO to INVOICED — revert when no other live invoice remains
      if (pinv.poId) {
        const others = await tx.purchaseInvoice.count({ where: { poId: pinv.poId, status: { not: 'CANCELLED' } } })
        if (!others) await tx.purchaseOrder.updateMany({ where: { id: pinv.poId, status: 'INVOICED' }, data: { status: 'RECEIVED' } })
      }
      const u = await tx.purchaseInvoice.findUniqueOrThrow({ where: { id: pinv.id }, include: { items: true } })
      await logAudit(tx, {
        companyId, userName: body.userName, action: 'CANCEL', entity: 'PurchaseInvoice',
        entityId: pinv.id, details: `Cancelled ${pinv.number} (grand total ${r2(pinv.grandTotal)})`,
      })
      return u
    })
    return ok(updated, 'Purchase invoice cancelled')
  } catch (e) {
    return handleError(e)
  }
}
// NOTE: No DELETE — purchase invoices are accounting records; cancel instead.
