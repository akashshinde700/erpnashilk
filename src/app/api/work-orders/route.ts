import { db } from '@/lib/db'
import { ok, handleError, companyRequired, nextDocNumber, logAudit, ApiError, requireWrite } from '@/lib/erp-helpers'

// WorkOrder has no direct relations to item/bom/warehouse in the schema — join in JS.
async function attachWorkOrderRelations(rows: any[]) {
  const itemIds = Array.from(new Set(rows.map((w) => w.itemId).filter(Boolean)))
  const bomIds = Array.from(new Set(rows.map((w) => w.bomId).filter(Boolean)))
  const soIds = Array.from(new Set(rows.map((w) => w.salesOrderId).filter(Boolean)))
  const whIds = Array.from(new Set(rows.map((w) => w.warehouseId).filter(Boolean)))

  const [items, boms, sos, whs] = await Promise.all([
    db.item.findMany({ where: { id: { in: itemIds } }, select: { id: true, code: true, name: true, uom: true, type: true } }),
    db.bom.findMany({ where: { id: { in: bomIds } }, select: { id: true, code: true } }),
    db.salesOrder.findMany({ where: { id: { in: soIds } }, select: { id: true, number: true } }),
    db.warehouse.findMany({ where: { id: { in: whIds } }, select: { id: true, code: true, name: true } }),
  ])
  const itemMap = new Map(items.map((i) => [i.id, i]))
  const bomMap = new Map(boms.map((b) => [b.id, b]))
  const soMap = new Map(sos.map((s) => [s.id, s]))
  const whMap = new Map(whs.map((w) => [w.id, w]))

  return rows.map((w) => ({
    ...w,
    item: itemMap.get(w.itemId) || null,
    bom: w.bomId ? bomMap.get(w.bomId) || null : null,
    salesOrder: w.salesOrderId ? soMap.get(w.salesOrderId) || null : null,
    warehouse: whMap.get(w.warehouseId) || null,
  }))
}

// GET /api/work-orders?companyId=&status=&itemId=&salesOrderId=
export async function GET(req: Request) {
  try {
    const companyId = await companyRequired(req)
    const { searchParams } = new URL(req.url)
    const status = searchParams.get('status') || undefined
    const itemId = searchParams.get('itemId') || undefined
    const salesOrderId = searchParams.get('salesOrderId') || undefined

    const where: Record<string, unknown> = { companyId }
    if (status) where.status = status
    if (itemId) where.itemId = itemId
    if (salesOrderId) where.salesOrderId = salesOrderId

    const [rows, groupByStatus] = await Promise.all([
      db.workOrder.findMany({ where, orderBy: { createdAt: 'desc' } }),
      db.workOrder.groupBy({ by: ['status'], where: { companyId }, _count: { _all: true } }),
    ])

    const items = await attachWorkOrderRelations(rows)
    const counts: Record<string, number> = {}
    for (const g of groupByStatus) counts[g.status] = g._count._all

    return ok({ items, total: items.length, counts })
  } catch (e) {
    return handleError(e)
  }
}

// POST /api/work-orders  { itemId, bomId?, salesOrderId?, warehouseId, plannedQty, startDate, dueDate?, priority?, notes?, userName? }
export async function POST(req: Request) {
  try {
    requireWrite(req, 'work-orders')
    const body = await req.json().catch(() => ({}) as any)
    const companyId = await companyRequired(req, body.companyId)

    const {
      itemId, bomId, salesOrderId, warehouseId,
      plannedQty, startDate, dueDate, priority, notes, userName,
    } = body

    if (!itemId) throw new ApiError('Select the item to manufacture', 400)
    // Optional fields: planned qty defaults to 1, warehouse to the FG store (else the first warehouse).
    const qty = Number(plannedQty) > 0 ? Number(plannedQty) : 1

    const item = await db.item.findFirst({ where: { id: itemId, companyId } })
    if (!item) throw new ApiError('Item not found', 404)
    const warehouse = warehouseId
      ? await db.warehouse.findFirst({ where: { id: warehouseId, companyId } })
      : (await db.warehouse.findFirst({ where: { companyId, type: 'FG' }, orderBy: { createdAt: 'asc' } }))
        ?? (await db.warehouse.findFirst({ where: { companyId }, orderBy: { createdAt: 'asc' } }))
    if (!warehouse) throw new ApiError(warehouseId ? 'Warehouse not found' : 'Create a warehouse first', 404)
    if (salesOrderId) {
      const so = await db.salesOrder.findFirst({ where: { id: salesOrderId, companyId } })
      if (!so) throw new ApiError('Sales order not found', 404)
    }

    const start = startDate ? new Date(startDate) : new Date()
    if (isNaN(start.getTime())) throw new ApiError('Invalid startDate', 400)
    let due: Date | null = null
    if (dueDate) {
      due = new Date(dueDate)
      if (isNaN(due.getTime())) throw new ApiError('Invalid dueDate', 400)
    }

    const created = await db.$transaction(async (tx) => {
      // Auto-pick latest ACTIVE BOM for the item when not supplied
      let resolvedBomId: string | null = bomId || null
      if (!resolvedBomId) {
        const bom = await tx.bom.findFirst({
          where: { companyId, outputItemId: itemId, status: 'ACTIVE' },
          orderBy: { createdAt: 'desc' },
        })
        resolvedBomId = bom?.id || null
      } else {
        const bom = await tx.bom.findFirst({ where: { id: resolvedBomId, companyId } })
        if (!bom) throw new ApiError('BOM not found', 404)
        if (bom.outputItemId !== itemId) throw new ApiError('BOM does not belong to the selected item', 400)
      }

      const number = await nextDocNumber(tx as any, companyId, 'WO')
      const wo = await tx.workOrder.create({
        data: {
          companyId, number, itemId, bomId: resolvedBomId, salesOrderId: salesOrderId || null,
          warehouseId: warehouse.id, plannedQty: qty, status: 'PLANNED', startDate: start,
          dueDate: due, priority: priority || 'NORMAL', notes: notes || null,
        },
      })

      await logAudit(tx as any, {
        companyId, userName, action: 'CREATE', entity: 'WorkOrder',
        entityId: wo.id, details: `Created work order ${number} for ${item.code} x${qty}`,
      })

      return wo
    })

    const [full] = await attachWorkOrderRelations([created])
    return ok(full, `Work order ${created.number} created`)
  } catch (e) {
    return handleError(e)
  }
}
