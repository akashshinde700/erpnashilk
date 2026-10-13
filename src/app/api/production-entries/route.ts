import { db } from '@/lib/db'
import { backflushComponents } from '@/lib/manufacturing'
import { ok, handleError, companyRequired, postStock, logAudit, notify, ApiError, r2, requireWrite } from '@/lib/erp-helpers'
import { emitEvent } from '@/lib/emit-event'
import { parseSerials, receiveBatch, receiveSerials } from '@/lib/batches'

// WorkOrder has no item relation in the schema — join in JS.
async function attachWorkOrderItems(entries: any[]) {
  const ids = Array.from(new Set(entries.map((p) => p.workOrder?.itemId).filter(Boolean)))
  const itemRows = ids.length
    ? await db.item.findMany({ where: { id: { in: ids } }, select: { id: true, code: true, name: true, uom: true } })
    : []
  const itemMap = new Map(itemRows.map((i) => [i.id, i]))
  return entries.map((p) => ({
    ...p,
    workOrder: p.workOrder ? { ...p.workOrder, item: itemMap.get(p.workOrder.itemId) || null } : null,
  }))
}

// GET /api/production-entries?companyId=&workOrderId=
export async function GET(req: Request) {
  try {
    const companyId = await companyRequired(req)
    const { searchParams } = new URL(req.url)
    const workOrderId = searchParams.get('workOrderId') || undefined

    const where: Record<string, unknown> = { companyId }
    if (workOrderId) where.workOrderId = workOrderId

    const rows = await db.productionEntry.findMany({
      where,
      include: {
        workOrder: { select: { number: true, status: true, itemId: true } },
      },
      orderBy: { date: 'desc' },
    })

    const items = await attachWorkOrderItems(rows)
    return ok({ items, total: items.length })
  } catch (e) {
    return handleError(e)
  }
}

// POST /api/production-entries  { workOrderId, producedQty, rejectedQty?, scrapQty?, operator?, downtimeMins?, notes?, userName?, batchNo?, expiryDate?, serials? }
// Batch-tracked finished item: the produced qty goes into batch `batchNo` (default = work order number), expiry optional.
// Serial-tracked finished item: `serials` (newline / comma separated) required, one per produced unit.
export async function POST(req: Request) {
  try {
    requireWrite(req, 'production-entries')
    const body = await req.json().catch(() => ({}) as any)
    const companyId = await companyRequired(req, body.companyId)
    const { workOrderId, operator, notes, userName } = body

    const producedQty = r2(Math.max(0, Number(body.producedQty) || 0))
    const rejectedQty = r2(Math.max(0, Number(body.rejectedQty) || 0))
    const scrapQty = r2(Math.max(0, Number(body.scrapQty) || 0))
    const downtimeMins = Math.max(0, Math.round(Number(body.downtimeMins) || 0))

    if (!workOrderId) throw new ApiError('Select a work order — finished stock is posted to its item', 400)
    // Quantities are optional: an all-zero entry just records work details / downtime.

    const created = await db.$transaction(async (tx) => {
      const wo = await tx.workOrder.findFirst({ where: { id: workOrderId, companyId } })
      if (!wo) throw new ApiError('Work order not found', 404)
      if (wo.status !== 'RELEASED' && wo.status !== 'IN_PROGRESS') {
        throw new ApiError(`Work order must be RELEASED or IN_PROGRESS to record production (current: ${wo.status})`, 400)
      }

      const item = await tx.item.findUnique({ where: { id: wo.itemId } })
      if (!item) throw new ApiError('Item not found for work order', 404)

      const totalProduced = r2(wo.producedQty + producedQty)
      const totalRejected = r2(wo.rejectedQty + rejectedQty)
      const totalScrap = r2(wo.scrapQty + scrapQty)
      if (totalProduced + totalRejected + totalScrap > wo.plannedQty * 1.05 + 0.001) {
        throw new ApiError('Entry exceeds planned qty', 400)
      }

      // Backflush: consume the BOM components this output needs that weren't issued yet.
      // Fails the whole entry (nothing posted) when any component is short.
      const flushed = await backflushComponents(tx, {
        companyId, wo: { id: wo.id, number: wo.number, bomId: wo.bomId }, unitsTotal: r2(totalProduced + totalRejected + totalScrap),
      })

      // Stock in at standard cost (only when something was produced)
      if (producedQty > 0) await postStock(tx as any, {
        companyId, itemId: wo.itemId, warehouseId: wo.warehouseId, type: 'PRODUCTION_IN',
        qtyIn: producedQty, rate: item.standardCost,
        refType: 'WORK_ORDER', refId: wo.id, refNumber: wo.number,
        notes: `Production entry for ${wo.number}`,
      })

      const entry = await tx.productionEntry.create({
        data: {
          companyId, workOrderId, date: new Date(),
          producedQty, rejectedQty, scrapQty, operator: operator || null,
          downtimeMins, notes: notes || null,
        },
      })

      // Batch / serial layer for the finished goods (no-op for untracked items)
      if (producedQty > 0) {
        await receiveBatch(tx, {
          companyId, itemId: wo.itemId, warehouseId: wo.warehouseId, qty: producedQty,
          batchNo: String(body.batchNo || '').trim() || wo.number, expiryDate: body.expiryDate || null, mfgDate: new Date(),
        })
        await receiveSerials(tx, {
          companyId, itemId: wo.itemId, warehouseId: wo.warehouseId, serials: parseSerials(body.serials), qty: producedQty,
          ref: { type: 'PRODUCTION_ENTRY', id: entry.id },
        })
      }

      const completed = totalProduced + totalRejected >= wo.plannedQty - 0.001
      await tx.workOrder.update({
        where: { id: wo.id },
        data: {
          producedQty: totalProduced,
          rejectedQty: totalRejected,
          scrapQty: totalScrap,
          status: completed ? 'COMPLETED' : 'IN_PROGRESS',
        },
      })

      if (completed) {
        await notify(tx as any, {
          companyId,
          title: `Work order ${wo.number} completed`,
          message: `Produced ${totalProduced} of ${item.code} (planned ${wo.plannedQty}).`,
          level: 'INFO',
        })

        // Linked sales order becomes READY for dispatch (only while still in production flow)
        if (wo.salesOrderId) {
          const so = await tx.salesOrder.findFirst({ where: { id: wo.salesOrderId, companyId } })
          if (so && (so.status === 'CONFIRMED' || so.status === 'IN_PRODUCTION')) {
            await tx.salesOrder.update({ where: { id: so.id }, data: { status: 'READY' } })
          }
        }
      }

      await logAudit(tx as any, {
        companyId, userName, action: 'POST', entity: 'ProductionEntry',
        entityId: entry.id,
        details: `Production entry on ${wo.number}: produced ${producedQty}, rejected ${rejectedQty}, scrap ${scrapQty}`
          + (flushed.length ? ` · auto-consumed ${flushed.length} component(s) from stock` : ''),
      })

      return { ...entry, consumed: flushed }
    })

    const row = await db.productionEntry.findUnique({
      where: { id: created.id },
      include: { workOrder: { select: { number: true, status: true, itemId: true } } },
    })
    const [full] = await attachWorkOrderItems([row])
    void emitEvent({ companyId, title: 'Production reported', message: `${full?.workOrder?.number || 'work order'} +${producedQty}`, topic: 'production' })
    const consumedNote = created.consumed.length ? ` — ${created.consumed.length} raw material(s) auto-consumed from stock` : ''
    return ok({ ...full, consumed: created.consumed }, `Production entry posted for ${full?.workOrder?.number || 'work order'}${consumedNote}`)
  } catch (e) {
    return handleError(e)
  }
}
