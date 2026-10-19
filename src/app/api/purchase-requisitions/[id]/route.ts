import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { ok, handleError, companyRequired, logAudit, ApiError, r2, requireWrite, claimStatus } from '@/lib/erp-helpers'

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

function toDate(v: unknown): Date | null {
  if (!v) return null
  const d = new Date(String(v))
  return Number.isNaN(d.getTime()) ? null : d
}

interface LineInput { itemId?: string; qty?: number | string; notes?: string }

async function validateLines(companyId: string, lines: LineInput[]) {
  if (!lines.length) throw new ApiError('At least one item line is required', 400)
  for (const l of lines) {
    if (!l.itemId) throw new ApiError('itemId is required on every line', 400)
    if (!(Number(l.qty) > 0)) throw new ApiError('Line qty must be greater than 0', 400)
  }
  const ids = Array.from(new Set(lines.map((l) => l.itemId as string)))
  const count = await db.item.count({ where: { companyId, id: { in: ids } } })
  if (count !== ids.length) throw new ApiError('One or more itemId values are invalid for this company', 400)
}

async function findPr(id: string, companyId: string) {
  const pr = await db.purchaseRequisition.findFirst({ where: { id, companyId }, include: { items: true } })
  if (!pr) throw new ApiError('Purchase requisition not found', 404)
  return pr
}

// ============================== GET /api/purchase-requisitions/[id] ==============================
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const companyId = await companyRequired(req)
    const pr = await findPr(id, companyId)
    const [row] = await attachItemInfo(companyId, [pr])
    return ok(row)
  } catch (e) {
    return handleError(e)
  }
}

// ============================== PATCH /api/purchase-requisitions/[id] ==============================
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireWrite(req, 'requisitions')
    const { id } = await params
    const body = await req.json()
    const companyId = await companyRequired(req, body.companyId)
    const pr = await findPr(id, companyId)

    // --- Workflow actions ---
    if (body.action) {
      const action = String(body.action)
      const specs: Record<string, { from: string[]; to: string; audit: string; label: string }> = {
        approve: { from: ['PENDING'], to: 'APPROVED', audit: 'APPROVE', label: 'approved' },
        reject: { from: ['PENDING'], to: 'REJECTED', audit: 'REJECT', label: 'rejected' },
        close: { from: ['APPROVED'], to: 'CLOSED', audit: 'UPDATE', label: 'closed' },
      }
      const spec = specs[action]
      if (!spec) throw new ApiError(`Unknown action '${action}' (use approve | reject | close)`, 400)
      if (!spec.from.includes(pr.status)) {
        throw new ApiError(`Cannot ${action}: requisition is ${pr.status}`, 400)
      }
      const updated = await db.$transaction(async (txRaw) => {
      const tx = txRaw as HelperTx
        await claimStatus((tx as any).purchaseRequisition, pr.id, spec.from, spec.to)
        const u = await tx.purchaseRequisition.findUniqueOrThrow({ where: { id: pr.id }, include: { items: true } })
        await logAudit(tx, {
          companyId, userName: body.userName, action: spec.audit, entity: 'PurchaseRequisition',
          entityId: pr.id, details: `${pr.number} ${spec.label} → ${spec.to}`,
        })
        return u
      })
      const [row] = await attachItemInfo(companyId, [updated])
      return ok(row, `Requisition ${spec.label}`)
    }

    // --- Edit lines (PENDING only) ---
    if (pr.status !== 'PENDING') throw new ApiError('Only PENDING requisitions can be edited', 400)
    const lines: LineInput[] | null = Array.isArray(body.items) ? body.items : null
    if (lines) await validateLines(companyId, lines)

    const data: Prisma.PurchaseRequisitionUpdateInput = {}
    if (body.date) data.date = toDate(body.date) || pr.date
    if (body.requiredBy !== undefined) data.requiredBy = toDate(body.requiredBy)
    if (body.department !== undefined) data.department = body.department || null
    if (body.raisedBy !== undefined) data.raisedBy = body.raisedBy || null
    if (body.notes !== undefined) data.notes = body.notes || null

    const updated = await db.$transaction(async (txRaw) => {
      const tx = txRaw as HelperTx
      if (lines) {
        await tx.purchaseRequisitionItem.deleteMany({ where: { prId: pr.id } })
        await tx.purchaseRequisitionItem.createMany({
          data: lines.map((l) => ({ prId: pr.id, itemId: l.itemId as string, qty: r2(Number(l.qty)), notes: l.notes || null })),
        })
      }
      const u = await tx.purchaseRequisition.update({ where: { id: pr.id }, data, include: { items: true } })
      await logAudit(tx, {
        companyId, userName: body.userName, action: 'UPDATE', entity: 'PurchaseRequisition',
        entityId: pr.id, details: `Updated ${pr.number}`,
      })
      return u
    })
    const [row] = await attachItemInfo(companyId, [updated])
    return ok(row, 'Requisition updated')
  } catch (e) {
    return handleError(e)
  }
}

// ============================== DELETE /api/purchase-requisitions/[id] ==============================
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireWrite(req, 'requisitions')
    const { id } = await params
    const body = await req.json().catch(() => ({}) as { companyId?: string; userName?: string })
    const companyId = await companyRequired(req, body.companyId)
    const pr = await findPr(id, companyId)
    if (pr.status !== 'PENDING') throw new ApiError('Only PENDING requisitions can be deleted', 400)

    await db.$transaction(async (txRaw) => {
      const tx = txRaw as HelperTx
      // Conditional delete (items cascade) — a concurrent approve makes this a no-op → 409
      const del = await tx.purchaseRequisition.deleteMany({ where: { id: pr.id, status: 'PENDING' } })
      if (del.count !== 1) throw new ApiError('This document was just changed by someone else — refresh and try again', 409)
      await logAudit(tx, {
        companyId, userName: body.userName, action: 'DELETE', entity: 'PurchaseRequisition',
        entityId: pr.id, details: `Deleted ${pr.number}`,
      })
    })
    return ok({ id: pr.id }, 'Requisition deleted')
  } catch (e) {
    return handleError(e)
  }
}
