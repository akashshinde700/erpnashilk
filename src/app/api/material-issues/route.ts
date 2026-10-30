import { db } from '@/lib/db'
import { ok, handleError, companyRequired, nextDocNumber, postStock, availableQty, logAudit, ApiError, r2, requireWrite } from '@/lib/erp-helpers'
import { batchNote, consumeBatches } from '@/lib/batches'
import { claimIdempotency, type Idempotency } from '@/lib/idempotency'
import { componentNeed, consumedByItem } from '@/lib/manufacturing'

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
  let idem: Idempotency | null = null
  try {
    requireWrite(req, 'material-issues')
    const body = await req.json().catch(() => ({}) as any)
    const companyId = await companyRequired(req, body.companyId)
    const { workOrderId, warehouseId, notes, userName, lines } = body

    if (!workOrderId) throw new ApiError('Select a work order — its BOM decides what to issue', 400)
    if (!Array.isArray(lines) || lines.length === 0) throw new ApiError('At least one issue line is required', 400)

    // Optional warehouse: defaults to the raw-material store (else the first warehouse).
    const warehouse = warehouseId
      ? await db.warehouse.findFirst({ where: { id: warehouseId, companyId } })
      : (await db.warehouse.findFirst({ where: { companyId, type: 'RM' }, orderBy: { createdAt: 'asc' } }))
        ?? (await db.warehouse.findFirst({ where: { companyId }, orderBy: { createdAt: 'asc' } }))
    if (!warehouse) throw new ApiError(warehouseId ? 'Warehouse not found' : 'Create a warehouse first', 404)

    // A retried submission must not issue the same material twice (each issue would move stock and
    // over-issue the work order). See src/lib/idempotency.ts.
    idem = await claimIdempotency(req, companyId, 'POST /api/material-issues', body)
    if (idem.replay) return idem.replay

    const { payload, message } = await db.$transaction(async (tx) => {
      // Same row lock as production entries: it serializes two issues against one work order, so the
      // availability check, the status flip to IN_PROGRESS and the stock posting stay consistent.
      await tx.workOrder.updateMany({ where: { id: workOrderId, companyId }, data: { producedQty: { increment: 0 } } })
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
          batchNo: String(l.batchNo || '').trim() || null, // batch-tracked: chosen batch, else FEFO
        }))
        .filter((l: any) => l.itemId && l.issuedQty > 0)
      if (validLines.length === 0) throw new ApiError('At least one line with issued quantity is required', 400)

      const itemIds = Array.from(new Set(validLines.map((l: any) => l.itemId)))
      const itemRows = await tx.item.findMany({ where: { id: { in: itemIds }, companyId } })
      const itemMap = new Map(itemRows.map((i) => [i.id, i]))
      for (const l of validLines) {
        if (!itemMap.has(l.itemId)) throw new ApiError(`Item not found: ${l.itemId}`, 404)
      }

      // Over-issue guard, worked out on the server: the BOM requirement for the planned quantity, less
      // what this work order already took (earlier issues + production backflush), with a 5 % margin.
      // The client's requiredQty is display only — trusting it let any caller lift the cap, and checking
      // each issue on its own let repeated issues take the requirement many times over.
      const bom = wo.bomId ? await tx.bom.findFirst({ where: { id: wo.bomId, companyId }, include: { items: true } }) : null
      if (bom && bom.items.length) {
        const need = new Map<string, number>()
        for (const c of bom.items) need.set(c.itemId, r2((need.get(c.itemId) || 0) + componentNeed(wo.plannedQty, bom, c)))
        const taken = await consumedByItem(tx, companyId, wo.id)
        const asked = new Map<string, number>()
        for (const l of validLines) asked.set(l.itemId, r2((asked.get(l.itemId) || 0) + l.issuedQty))
        for (const [itemId, qty] of asked) {
          const item = itemMap.get(itemId)!
          const required = need.get(itemId)
          if (required === undefined) throw new ApiError(`${item.code} ${item.name} is not on this work order's BOM`, 400)
          const already = taken[itemId] || 0
          const cap = r2(required * 1.05)
          if (already + qty > cap + 0.0001) {
            const left = r2(Math.max(0, cap - already))
            throw new ApiError(`Issued qty exceeds requirement for ${item.code}: BOM needs ${required} ${item.uom} (+5 % = ${cap}), already issued ${r2(already)}, at most ${left} more`, 400)
          }
        }
        // store the server's view of what was still pending, not the client's
        for (const l of validLines) l.requiredQty = r2(Math.max(0, (need.get(l.itemId) || 0) - (taken[l.itemId] || 0)))
      } else {
        // No BOM on the work order: the requirement can only come from the request
        for (const l of validLines) {
          if (l.issuedQty > r2(l.requiredQty * 1.05) + 0.0001) {
            throw new ApiError('Issued qty exceeds requirement for line', 400)
          }
        }
      }

      // Availability guard: company-wide available qty across warehouses
      const createdItems: any[] = []
      for (const l of validLines) {
        const item: any = itemMap.get(l.itemId)!
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
        const item: any = itemMap.get(l.itemId)!
        const bal = await tx.stockBalance.findUnique({
          where: { itemId_warehouseId: { itemId: l.itemId, warehouseId: warehouse.id } },
        })
        const rate = bal?.avgRate && bal.avgRate > 0 ? bal.avgRate : item.standardCost

        // Batch layer (no-op for untracked items): chosen batch else FEFO, legacy un-batched stock last.
        // Taken before postStock so the ledger note records the split; postStock still checks the total.
        const allocs = await consumeBatches(tx, { companyId, itemId: l.itemId, warehouseId: warehouse.id, qty: l.issuedQty, batchNo: l.batchNo })
        await postStock(tx as any, {
          companyId, itemId: l.itemId, warehouseId: warehouse.id, type: 'ISSUE_OUT',
          qtyOut: l.issuedQty, rate,
          refType: 'MATERIAL_ISSUE', refId: issue.id, refNumber: number,
          notes: `Issued to work order ${wo.number}${batchNote(allocs)}`,
        })

        const issueItem = await tx.materialIssueItem.create({
          data: { issueId: issue.id, itemId: l.itemId, requiredQty: l.requiredQty, issuedQty: l.issuedQty },
        })
        createdItems.push({ ...issueItem, item: { id: item.id, code: item.code, name: item.name, uom: item.uom } })
      }

      // First issue moves the work order into production
      if (wo.status === 'RELEASED') {
        await tx.workOrder.update({ where: { id: wo.id }, data: { status: 'IN_PROGRESS' } })
      }

      await logAudit(tx as any, {
        companyId, userName, action: 'POST', entity: 'MaterialIssue',
        entityId: issue.id, details: `Posted material issue ${number} against work order ${wo.number}`,
      })

      // Same shape the GET list returns, so a replayed response matches the original one
      const payload = {
        ...issue,
        workOrder: { number: wo.number, itemId: wo.itemId, plannedQty: wo.plannedQty, warehouseId: wo.warehouseId },
        items: createdItems,
      }
      const message = `Material issue ${number} posted`
      await idem!.done(tx, payload, message)
      return { payload, message }
    })

    return ok(payload, message)
  } catch (e) {
    await idem?.release()
    return handleError(e)
  }
}
