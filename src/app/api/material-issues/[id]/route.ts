import { db } from '@/lib/db'
import { ok, fail, handleError, companyRequired, ApiError } from '@/lib/erp-helpers'

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

// PATCH /api/material-issues/[id] — posted documents are immutable
export async function PATCH() {
  return fail('Posted issues cannot be cancelled', 400)
}

// DELETE /api/material-issues/[id] — posted documents are immutable
export async function DELETE() {
  return fail('Posted issues cannot be deleted', 400)
}
