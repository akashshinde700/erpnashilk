import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { requireSecurityPin } from '@/lib/security-pin'
import {
  ok, handleError, companyRequired, postStock, logAudit, ApiError, r2, requireWrite, claimStatus,
} from '@/lib/erp-helpers'
import { receiveBatch, receiveSerials, parseSerials } from '@/lib/batches'

// prisma 6.x generated delegates are not structurally assignable to the shared helpers' minimal
// tx types — intersect once and cast the transaction client at the boundary.
type HelperTx = Prisma.TransactionClient & Parameters<typeof postStock>[0] & Parameters<typeof logAudit>[0]

async function attachItemInfo<T extends { items: { itemId: string }[] }>(companyId: string, docs: T[]) {
  const ids = Array.from(new Set(docs.flatMap((d) => d.items.map((i) => i.itemId))))
  const items = ids.length
    ? await db.item.findMany({ where: { companyId, id: { in: ids } }, select: { id: true, code: true, name: true, uom: true, batchTracked: true, trackSerial: true } })
    : []
  const map = new Map(items.map((i) => [i.id, i]))
  return docs.map((d) => ({ ...d, items: d.items.map((i) => ({ ...i, item: map.get(i.itemId) || null })) }))
}

async function findGrn(id: string, companyId: string) {
  const grn = await db.grn.findFirst({
    where: { id, companyId },
    include: {
      po: {
        select: {
          id: true, number: true, orderDate: true, status: true,
          supplier: { select: { id: true, code: true, name: true, gstin: true, state: true, stateCode: true } },
        },
      },
      items: true,
    },
  })
  if (!grn) throw new ApiError('GRN not found', 404)
  return grn
}

// ============================== GET /api/grns/[id] ==============================
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const companyId = await companyRequired(req)
    const grn = await findGrn(id, companyId)
    const [row] = await attachItemInfo(companyId, [grn])
    const inspections = await db.qcInspection.findMany({
      where: { companyId, refType: 'GRN', refId: grn.id },
      orderBy: { date: 'asc' },
    })
    return ok({ ...row, inspections })
  } catch (e) {
    return handleError(e)
  }
}

// ============================== PATCH /api/grns/[id] — action=post ==============================
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireWrite(req, 'grns')
    const { id } = await params
    const body = await req.json()
    const companyId = await companyRequired(req, body.companyId)
    const grn = await findGrn(id, companyId)

    if (body.action !== 'post') throw new ApiError(`Unknown action '${body.action}' (use post)`, 400)
    if (grn.status !== 'PENDING_QC') throw new ApiError(`Only PENDING_QC GRNs can be posted (current: ${grn.status})`, 400)

    const posted = await db.$transaction(async (txRaw) => {
      const tx = txRaw as HelperTx
      await claimStatus((tx as any).grn, grn.id, ['PENDING_QC'], 'POSTED')
      // Lock the PO row so a concurrent PO cancel serializes with this post
      const poLock = await tx.purchaseOrder.updateMany({
        where: { id: grn.poId, companyId, status: { not: 'CANCELLED' } }, data: { updatedAt: new Date() },
      })
      if (poLock.count !== 1) throw new ApiError('Purchase order is cancelled — this GRN cannot be posted', 409)
      const po = await tx.purchaseOrder.findFirst({ where: { id: grn.poId, companyId }, include: { items: true } })
      if (!po) throw new ApiError('Purchase order not found', 404)

      for (const it of grn.items) {
        // Stock in for accepted qty @ PO rate (rejected qty never enters stock)
        if (it.acceptedQty > 0) {
          const poItem = it.poItemId ? po.items.find((p) => p.id === it.poItemId) : undefined
          await postStock(tx, {
            companyId,
            itemId: it.itemId,
            warehouseId: grn.warehouseId,
            type: 'GRN_IN',
            qtyIn: it.acceptedQty,
            rate: poItem ? poItem.rate : 0,
            date: grn.date,
            refType: 'GRN',
            refId: grn.id,
            refNumber: grn.number,
            notes: grn.supplierInvNo ? `Supplier inv ${grn.supplierInvNo}` : undefined,
          })
          // Batch / serial layer (no-op for items that are not tracked). A tracked line without a
          // batch no goes into a batch named after the GRN.
          await receiveBatch(tx, {
            companyId, itemId: it.itemId, warehouseId: grn.warehouseId, batchNo: it.batchNo || grn.number,
            mfgDate: it.mfgDate, expiryDate: it.expiryDate, qty: it.acceptedQty,
          })
          await receiveSerials(tx, {
            companyId, itemId: it.itemId, warehouseId: grn.warehouseId, serials: parseSerials(it.serials),
            qty: it.acceptedQty, ref: { type: 'GRN', id: grn.id },
          })
        }
        // PO receivedQty was NOT incremented at GRN create — increment here by receivedQty
        if (it.poItemId) {
          await tx.purchaseOrderItem.update({
            where: { id: it.poItemId },
            data: { receivedQty: { increment: it.receivedQty } },
          })
        }
      }

      const freshPoItems = await tx.purchaseOrderItem.findMany({ where: { poId: po.id } })
      const allReceived = freshPoItems.length > 0 && freshPoItems.every((p) => p.receivedQty + 0.01 >= p.qty)
      await tx.purchaseOrder.update({
        where: { id: po.id },
        data: { status: allReceived ? 'RECEIVED' : 'PARTIALLY_RECEIVED' },
      })

      const u = await tx.grn.update({ where: { id: grn.id }, data: { status: 'POSTED' }, include: { items: true } })
      await logAudit(tx, {
        companyId, userName: body.userName, action: 'POST', entity: 'Grn',
        entityId: grn.id,
        details: `Posted ${grn.number} — stock in ${r2(grn.items.reduce((s, i) => s + i.acceptedQty, 0))} qty against ${po.number} (${allReceived ? 'RECEIVED' : 'PARTIALLY_RECEIVED'})`,
      })
      return u
    })
    const [row] = await attachItemInfo(companyId, [posted])
    return ok(row, 'GRN posted — stock updated')
  } catch (e) {
    return handleError(e)
  }
}

// ============================== DELETE /api/grns/[id] ==============================
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireWrite(req, 'grns')
    const { id } = await params
    const body = await req.json().catch(() => ({}) as { companyId?: string; userName?: string })
    const companyId = await companyRequired(req, body.companyId)
    await requireSecurityPin(req, companyId)
    const grn = await findGrn(id, companyId)
    if (grn.status !== 'PENDING_QC') throw new ApiError('Only PENDING_QC GRNs can be deleted', 400)

    await db.$transaction(async (txRaw) => {
      const tx = txRaw as HelperTx
      // Conditional delete (items cascade): a concurrent post makes this a no-op → 409
      const del = await tx.grn.deleteMany({ where: { id: grn.id, status: 'PENDING_QC' } })
      if (del.count !== 1) throw new ApiError('This document was just changed by someone else — refresh and try again', 409)
      await tx.qcInspection.deleteMany({ where: { companyId, refType: 'GRN', refId: grn.id } })
      await logAudit(tx, {
        companyId, userName: body.userName, action: 'DELETE', entity: 'Grn',
        entityId: grn.id, details: `Deleted ${grn.number} (was PENDING_QC, no stock impact)`,
      })
    })
    return ok({ id: grn.id }, 'GRN deleted')
  } catch (e) {
    return handleError(e)
  }
}
