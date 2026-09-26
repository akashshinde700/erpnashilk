import { db } from '@/lib/db'
import { ok, fail, handleError, companyRequired, logAudit, ApiError, requireWrite, claimStatus } from '@/lib/erp-helpers'

type Ctx = { params: Promise<{ id: string }> }

// GET /api/work-orders/[id]?companyId= — full detail (item, bom+components, issues, entries, salesOrder)
export async function GET(req: Request, { params }: Ctx) {
  try {
    const companyId = await companyRequired(req)
    const { id } = await params

    const wo = await db.workOrder.findFirst({ where: { id, companyId } })
    if (!wo) throw new ApiError('Work order not found', 404)

    const [item, warehouse, salesOrder, issuesRows, entries] = await Promise.all([
      db.item.findUnique({
        where: { id: wo.itemId },
        select: { id: true, code: true, name: true, uom: true, type: true, standardCost: true },
      }),
      db.warehouse.findUnique({ where: { id: wo.warehouseId }, select: { id: true, code: true, name: true } }),
      wo.salesOrderId
        ? db.salesOrder.findUnique({ where: { id: wo.salesOrderId }, select: { id: true, number: true } })
        : Promise.resolve(null),
      db.materialIssue.findMany({
        where: { workOrderId: wo.id },
        include: { items: true },
        orderBy: { date: 'desc' },
      }),
      db.productionEntry.findMany({ where: { workOrderId: wo.id }, orderBy: { date: 'desc' } }),
    ])

    // BOM with components (BomItem has no item relation — join manually)
    let bom: any = null
    if (wo.bomId) {
      const bomRow = await db.bom.findFirst({ where: { id: wo.bomId }, include: { items: true } })
      if (bomRow) {
        const compIds = Array.from(new Set(bomRow.items.map((bi) => bi.itemId)))
        const comps = compIds.length
          ? await db.item.findMany({ where: { id: { in: compIds } }, select: { id: true, code: true, name: true, uom: true } })
          : []
        const compMap = new Map(comps.map((c) => [c.id, c]))
        bom = { ...bomRow, items: bomRow.items.map((bi) => ({ ...bi, item: compMap.get(bi.itemId) || null })) }
      }
    }

    // Attach items to issue lines
    const issueItemIds = Array.from(new Set(issuesRows.flatMap((mi) => mi.items.map((it) => it.itemId))))
    const issueItems = issueItemIds.length
      ? await db.item.findMany({ where: { id: { in: issueItemIds } }, select: { id: true, code: true, name: true, uom: true } })
      : []
    const issueItemMap = new Map(issueItems.map((i) => [i.id, i]))
    const issues = issuesRows.map((mi) => ({
      ...mi,
      items: mi.items.map((it) => ({ ...it, item: issueItemMap.get(it.itemId) || null })),
    }))

    return ok({ ...wo, item, warehouse, salesOrder, bom, issues, entries })
  } catch (e) {
    return handleError(e)
  }
}

// PATCH /api/work-orders/[id]  { companyId, action: 'release' | 'cancel', userName? }
export async function PATCH(req: Request, { params }: Ctx) {
  try {
    requireWrite(req, 'work-orders')
    const body = await req.json().catch(() => ({}) as any)
    const companyId = await companyRequired(req, body.companyId)
    const { id } = await params
    const action = body.action

    const result = await db.$transaction(async (tx) => {
      const wo = await tx.workOrder.findFirst({ where: { id, companyId } })
      if (!wo) throw new ApiError('Work order not found', 404)

      if (action === 'release') {
        if (wo.status !== 'PLANNED') {
          throw new ApiError(`Only PLANNED work orders can be released (current status: ${wo.status})`, 400)
        }
        await claimStatus((tx as any).workOrder, wo.id, ['PLANNED'], 'RELEASED')
        const updated = await tx.workOrder.findUniqueOrThrow({ where: { id: wo.id } })
        await logAudit(tx as any, {
          companyId, userName: body.userName, action: 'UPDATE', entity: 'WorkOrder',
          entityId: wo.id, details: `Work order ${wo.number} released`,
        })
        return updated
      }

      if (action === 'cancel') {
        if (wo.status === 'CANCELLED') throw new ApiError('Work order is already cancelled', 400)
        if (wo.status === 'COMPLETED') throw new ApiError('Completed work orders cannot be cancelled', 400)
        if (wo.producedQty > 0) throw new ApiError('Cannot cancel: production has already been posted', 400)
        // Atomic: status and producedQty re-checked on the locked row
        const claim = await tx.workOrder.updateMany({
          where: { id: wo.id, status: { notIn: ['CANCELLED', 'COMPLETED'] }, producedQty: { lte: 0 } },
          data: { status: 'CANCELLED' },
        })
        if (claim.count !== 1) throw new ApiError('This document was just changed by someone else — refresh and try again', 409)
        const updated = await tx.workOrder.findUniqueOrThrow({ where: { id: wo.id } })
        await logAudit(tx as any, {
          companyId, userName: body.userName, action: 'CANCEL', entity: 'WorkOrder',
          entityId: wo.id, details: `Work order ${wo.number} cancelled`,
        })
        return updated
      }

      throw new ApiError('Invalid action (expected release or cancel)', 400)
    })

    return ok(result, `Work order ${action}d`)
  } catch (e) {
    return handleError(e)
  }
}

// DELETE /api/work-orders/[id]?companyId= — allowed only while PLANNED
export async function DELETE(req: Request, { params }: Ctx) {
  try {
    requireWrite(req, 'work-orders')
    const companyId = await companyRequired(req)
    const { id } = await params

    const wo = await db.workOrder.findFirst({ where: { id, companyId } })
    if (!wo) throw new ApiError('Work order not found', 404)
    if (wo.status !== 'PLANNED') {
      return fail('Only PLANNED work orders can be deleted', 400)
    }

    await db.$transaction(async (tx) => {
      const del = await tx.workOrder.deleteMany({ where: { id: wo.id, status: 'PLANNED' } })
      if (del.count !== 1) throw new ApiError('This document was just changed by someone else — refresh and try again', 409)
      await logAudit(tx as any, {
        companyId, userName: new URL(req.url).searchParams.get('userName') || undefined,
        action: 'DELETE', entity: 'WorkOrder', entityId: wo.id,
        details: `Deleted work order ${wo.number}`,
      })
    })

    return ok({ id: wo.id }, `Work order ${wo.number} deleted`)
  } catch (e) {
    return handleError(e)
  }
}
