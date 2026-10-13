import { db } from '@/lib/db'
import { requireSecurityPin } from '@/lib/security-pin'
import { ok, fail, handleError, companyRequired, ApiError, claimStatus, postStock, logAudit, r2, requireWrite } from '@/lib/erp-helpers'
import { parseBatchNote, receiveBatch } from '@/lib/batches'

type Ctx = { params: Promise<{ id: string }> }

// GET /api/material-issues/[id]?companyId=
export async function GET(req: Request, { params }: Ctx) {
  try {
    const companyId = await companyRequired(req)
    const { id } = await params

    const issue = await db.materialIssue.findFirst({
      where: { id, companyId },
      include: {
        workOrder: {
          select: { id: true, number: true, itemId: true, plannedQty: true, warehouseId: true, status: true },
        },
        items: true,
      },
    })
    if (!issue) throw new ApiError('Material issue not found', 404)

    // MaterialIssueItem has no item relation in the schema — join in JS
    const ids = Array.from(new Set(issue.items.map((it) => it.itemId)))
    const itemRows = ids.length
      ? await db.item.findMany({ where: { id: { in: ids } }, select: { id: true, code: true, name: true, uom: true } })
      : []
    const itemMap = new Map(itemRows.map((i) => [i.id, i]))

    return ok({
      ...issue,
      items: issue.items.map((it) => ({ ...it, item: itemMap.get(it.itemId) || null })),
    })
  } catch (e) {
    return handleError(e)
  }
}

// PATCH /api/material-issues/[id]  { action: 'cancel' }
// POSTED → CANCELLED while the work order is still open (not COMPLETED / CANCELLED): every ISSUE_OUT
// ledger row of the issue is put back into the store it came from (ISSUE_CANCEL_IN, same rate), and the
// batches recorded in the ledger note ("Batches: B1×5, …") are restored. Un-batched pool stock needs no
// batch row. Backflush (consumedByItem) ignores CANCELLED issues, so later production draws again.
export async function PATCH(req: Request, { params }: Ctx) {
  try {
    requireWrite(req, 'material-issues')
    const { id } = await params
    const body = await req.json().catch(() => ({}) as any)
    const companyId = await companyRequired(req, body.companyId)
    if (body.action !== 'cancel') throw new ApiError(`Unknown action "${body.action}" (use cancel)`, 400)
    await requireSecurityPin(req, companyId)

    const issue = await db.materialIssue.findFirst({
      where: { id, companyId },
      include: { workOrder: { select: { id: true, number: true, status: true } }, items: true },
    })
    if (!issue) throw new ApiError('Material issue not found', 404)
    if (issue.status !== 'POSTED') throw new ApiError(`Only POSTED issues can be cancelled (current: ${issue.status})`, 400)
    if (['COMPLETED', 'CANCELLED'].includes(issue.workOrder.status)) {
      throw new ApiError(`Work order ${issue.workOrder.number} is ${issue.workOrder.status} — its material issues can no longer be cancelled`, 400)
    }

    const updated = await db.$transaction(async (tx) => {
      const t = tx as any
      // Lock the work order while it is still open, so it can't be completed / cancelled meanwhile
      const woLock = await tx.workOrder.updateMany({
        where: { id: issue.workOrderId, companyId, status: { notIn: ['COMPLETED', 'CANCELLED'] } },
        data: { updatedAt: new Date() },
      })
      if (woLock.count !== 1) throw new ApiError('The work order was just completed or cancelled — refresh and try again', 409)
      await claimStatus(t.materialIssue, issue.id, ['POSTED'], 'CANCELLED')

      const outRows = await tx.stockLedger.findMany({
        where: { companyId, refType: 'MATERIAL_ISSUE', refId: issue.id, refNumber: issue.number, type: 'ISSUE_OUT' },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      })
      for (const r of outRows) {
        if (!(r.qtyOut > 0)) continue
        await postStock(t, {
          companyId, itemId: r.itemId, warehouseId: r.warehouseId, type: 'ISSUE_CANCEL_IN',
          qtyIn: r.qtyOut, rate: r.rate,
          refType: 'MATERIAL_ISSUE', refId: issue.id, refNumber: issue.number,
          notes: `Returned to store: material issue ${issue.number} cancelled (work order ${issue.workOrder.number})`,
        })
        // Batch layer: back into the batches the issue drew from (UNBATCHED → pool, no batch row)
        for (const a of parseBatchNote(r.notes)) {
          await receiveBatch(tx, { companyId, itemId: r.itemId, warehouseId: r.warehouseId, batchNo: a.batchNo, qty: a.qty })
        }
      }

      const u = await tx.materialIssue.findUniqueOrThrow({ where: { id: issue.id }, include: { items: true } })
      await logAudit(t, {
        companyId, userName: body.userName, action: 'CANCEL', entity: 'MaterialIssue', entityId: issue.id,
        details: `Cancelled material issue ${issue.number} (work order ${issue.workOrder.number}) — ${outRows.length} line(s), ${r2(outRows.reduce((s, r) => s + r.qtyOut, 0))} qty returned to store`,
      })
      return u
    })
    return ok(updated, `Material issue ${issue.number} cancelled — stock returned`)
  } catch (e) {
    return handleError(e)
  }
}

// DELETE /api/material-issues/[id] — posted documents are kept; cancel instead
export async function DELETE() {
  return fail('Material issues cannot be deleted — cancel the issue instead', 405)
}
