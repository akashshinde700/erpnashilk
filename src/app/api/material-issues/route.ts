import { db } from '@/lib/db'
import { ok, handleError, companyRequired, nextDocNumber, postStock, availableQty, logAudit, ApiError, r2 } from '@/lib/erp-helpers'

// MaterialIssueItem has no item relation in the schema — join in JS.
async function attachIssueItems(issues: any[]) {
  const ids = Array.from(new Set(issues.flatMap((mi) => (mi.items || []).map((it: any) => it.itemId)).filter(Boolean)))
  const itemRows = ids.length
    ? await db.item.findMany({ where: { id: { in: ids } }, select: { id: true, code: true, name: true, uom: true } })
    : []
  const itemMap = new Map(itemRows.map((i) => [i.id, i]))
  return issues.map((mi) => ({
    ...mi,
    items: (mi.items || []).map((it: any) => ({ ...it, item: itemMap.get(it.itemId) || null })),
  }))
}

// GET /api/material-issues?companyId=&workOrderId=&status=
export async function GET(req: Request) {
  try {
    const companyId = await companyRequired(req)
    const { searchParams } = new URL(req.url)
    const workOrderId = searchParams.get('workOrderId') || undefined
    const status = searchParams.get('status') || undefined

    const where: Record<string, unknown> = { companyId }
    if (workOrderId) where.workOrderId = workOrderId
    if (status) where.status = status

    const issues = await db.materialIssue.findMany({
      where,
      include: {
        workOrder: {
          select: { number: true, itemId: true, plannedQty: true, warehouseId: true },
        },
        items: true,
      },
      orderBy: { date: 'desc' },
    })

    const items = await attachIssueItems(issues)
    return ok({ items, total: items.length })
  } catch (e) {
    return handleError(e)
  }
}

// POST /api/material-issues  { workOrderId, warehouseId, notes?, userName?, lines: [{itemId, requiredQty, issuedQty}] }
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}) as any)
    const companyId = await companyRequired(req, body.companyId)
    const { workOrderId, warehouseId, notes, userName, lines } = body

    if (!workOrderId) throw new ApiError('workOrderId is required', 400)
    if (!warehouseId) throw new ApiError('warehouseId is required', 400)
    if (!Array.isArray(lines) || lines.length === 0) throw new ApiError('At least one issue line is required', 400)

    const warehouse = await db.warehouse.findFirst({ where: { id: warehouseId, companyId } })
    if (!warehouse) throw new ApiError('Warehouse not found', 404)

    const created = await db.$transaction(async (tx) => {
      const wo = await tx.workOrder.findFirst({ where: { id: workOrderId, companyId } })
      if (!wo) throw new ApiError('Work order not found', 404)
      if (wo.status !== 'RELEASED' && wo.status !== 'IN_PROGRESS') {
        throw new ApiError(`Work order must be RELEASED or IN_PROGRESS to issue materials (current: ${wo.status})`, 400)
      }

      // Keep only lines with an actual issued quantity
      const validLines = lines
        .map((l: any) => ({
          itemId: String(l.itemId || ''),
          requiredQty: Number(l.requiredQty) || 0,
          issuedQty: r2(Number(l.issuedQty) || 0),
        }))
        .filter((l: any) => l.itemId && l.issuedQty > 0)
      if (validLines.length === 0) throw new ApiError('At least one line with issued quantity is required', 400)

      const itemIds = Array.from(new Set(validLines.map((l: any) => l.itemId)))
      const itemRows = await tx.item.findMany({ where: { id: { in: itemIds }, companyId } })
      const itemMap = new Map(itemRows.map((i) => [i.id, i]))
      for (const l of validLines) {
        if (!itemMap.has(l.itemId)) throw new ApiError(`Item not found: ${l.itemId}`, 404)
      }

      // Over-issue guard: max 5% above requirement
      for (const l of validLines) {
        if (l.issuedQty > r2(l.requiredQty * 1.05) + 0.0001) {
          throw new ApiError('Issued qty exceeds requirement for line', 400)
        }
      }

      // Availability guard: company-wide available qty across warehouses
      for (const l of validLines) {
        const item = itemMap.get(l.itemId)!
        const available = await availableQty(tx as any, companyId, l.itemId)
        if (available < l.issuedQty) {
          throw new ApiError(`Insufficient stock: ${item.code} (available ${r2(available)}, needed ${r2(l.issuedQty)})`, 400)
        }
      }

      const number = await nextDocNumber(tx as any, companyId, 'MI')
      const issue = await tx.materialIssue.create({
        data: {
          companyId, number, workOrderId, date: new Date(), status: 'POSTED',
          notes: notes || null,
        },
      })

      for (const l of validLines) {
        const item = itemMap.get(l.itemId)!
        const bal = await tx.stockBalance.findUnique({
          where: { itemId_warehouseId: { itemId: l.itemId, warehouseId } },
        })
        const rate = bal?.avgRate && bal.avgRate > 0 ? bal.avgRate : item.standardCost

        await postStock(tx as any, {
          companyId, itemId: l.itemId, warehouseId, type: 'ISSUE_OUT',
          qtyOut: l.issuedQty, rate,
          refType: 'MATERIAL_ISSUE', refId: issue.id, refNumber: number,
          notes: `Issued to work order ${wo.number}`,
        })

        await tx.materialIssueItem.create({
          data: { issueId: issue.id, itemId: l.itemId, requiredQty: l.requiredQty, issuedQty: l.issuedQty },
        })
      }

      // First issue moves the work order into production
      if (wo.status === 'RELEASED') {
        await tx.workOrder.update({ where: { id: wo.id }, data: { status: 'IN_PROGRESS' } })
      }

      await logAudit(tx as any, {
        companyId, userName, action: 'POST', entity: 'MaterialIssue',
        entityId: issue.id, details: `Posted material issue ${number} against work order ${wo.number}`,
      })

      return issue
    })

    const fullRow = await db.materialIssue.findUnique({
      where: { id: created.id },
      include: {
        workOrder: {
          select: { number: true, itemId: true, plannedQty: true, warehouseId: true },
        },
        items: true,
      },
    })
    const [full] = await attachIssueItems([fullRow])
    return ok(full, `Material issue ${created.number} posted`)
  } catch (e) {
    return handleError(e)
  }
}
