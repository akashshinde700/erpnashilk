import { db } from '@/lib/db'
import { requireSecurityPin } from '@/lib/security-pin'
import { ok, fail, handleError, companyRequired, nextDocNumber, computeGst, isInterState, postStock, logAudit, notify, ApiError, r2, requireWrite, claimStatus } from '@/lib/erp-helpers'
import { consumeBatches, formatAllocation, isUnbatched, parseAllocation, parseSerials, joinSerials, sellSerials } from '@/lib/batches'

// DeliveryChallanItem carries only itemId (no Prisma relation to Item) — attach master info via JS mapping
async function withItemInfo<T extends { items: { itemId: string }[] }>(companyId: string, docs: T[]) {
  const ids = Array.from(new Set(docs.flatMap((d) => d.items.map((i) => i.itemId))))
  const masters = ids.length
    ? await db.item.findMany({ where: { companyId, id: { in: ids } }, select: { id: true, code: true, name: true, uom: true, hsn: true, batchTracked: true, trackSerial: true } })
    : []
  const map = new Map(masters.map((m) => [m.id, m]))
  return docs.map((d) => ({ ...d, items: d.items.map((i) => ({ ...i, item: map.get(i.itemId) || null })) }))
}

// GET /api/deliveries/[id]?companyId=
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const companyId = await companyRequired(req)
    const challan = await db.deliveryChallan.findFirst({
      where: { id, companyId },
      include: {
        salesOrder: {
          include: { customer: { select: { name: true, gstin: true, city: true, state: true, stateCode: true, addressLine: true } } },
        },
        items: true,
      },
    })
    if (!challan) throw new ApiError('Delivery challan not found', 404)

    // DeliveryChallan.warehouseId has no Prisma relation — attach via JS
    const warehouse = await db.warehouse.findFirst({
      where: { id: challan.warehouseId, companyId },
      select: { id: true, code: true, name: true, location: true },
    })
    // Consignor (our company) block for the challan print — DeliveryChallan has no
    // company relation in the schema, so fetch + attach via JS (mirrors sales-invoices detail).
    const company = await db.company.findUnique({
      where: { id: companyId },
      select: { name: true, gstin: true, addressLine: true, city: true, state: true, stateCode: true, phone: true, email: true },
    })
    // Batch expiry per line for the print (batch text is "B1" or "B1×5, B2×3"). The UNBATCHED pool
    // (stock from before batch tracking) is not a real batch — it is left out of `batches`.
    const realBatches = (batchNo: string | null, qty: number) => parseAllocation(batchNo, qty).filter((a) => !isUnbatched(a.batchNo))
    const batchNames = Array.from(new Set(challan.items.flatMap((ci) => realBatches(ci.batchNo, ci.qty).map((a) => a.batchNo))))
    const batchRows = batchNames.length
      ? await db.itemBatch.findMany({
          where: { companyId, warehouseId: challan.warehouseId, batchNo: { in: batchNames } },
          select: { itemId: true, batchNo: true, mfgDate: true, expiryDate: true },
        })
      : []
    const items = challan.items.map((ci) => ({
      ...ci,
      batches: realBatches(ci.batchNo, ci.qty).map((a) => {
        const b = batchRows.find((x) => x.itemId === ci.itemId && x.batchNo === a.batchNo)
        return { ...a, mfgDate: b?.mfgDate ?? null, expiryDate: b?.expiryDate ?? null }
      }),
    }))
    const [row] = await withItemInfo(companyId, [{ ...challan, items, warehouse, company }])
    return ok(row)
  } catch (e) {
    return handleError(e)
  }
}

// PATCH /api/deliveries/[id]
//  - { action: 'dispatch', lines?: [{id, batchNo?, serials?}] } : DRAFT → DISPATCHED, posts DISPATCH_OUT stock + updates
//    SO dispatchedQty/status; batch-tracked lines draw from the chosen batch (else FEFO) and serial-tracked
//    lines mark their serials SOLD — the batch(es) actually used are written back on the line
//  - { action: 'cancel' }   : only when DRAFT
//  - { action: 'edit-lines', lines: [{salesOrderItemId, itemId?, qty, batchNo?, serials?}], warehouseId?, date?, notes? }
//    : DRAFT only — replaces the lines (same checks as POST: pending qty per SO line, batch / serial inputs stored as-is)
//  - otherwise: light edit — vehicleNo/transporter/driverPhone/ewayBillNo/lrNo/lrDate (DRAFT or DISPATCHED; transport papers
//    often arrive after the truck leaves), notes/date/shippingAddress (DRAFT only)
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireWrite(req, 'deliveries')
    const { id } = await params
    const body = await req.json().catch(() => ({}) as any)
    const companyId = await companyRequired(req, body.companyId)
    if (body.action === 'cancel' || body.action === 'edit-lines') await requireSecurityPin(req, companyId)

    const current = await db.deliveryChallan.findFirst({ where: { id, companyId }, include: { items: true } })
    if (!current) throw new ApiError('Delivery challan not found', 404)

    // ---- Dispatch: post stock out + update SO ----
    if (body.action === 'dispatch') {
      if (current.status !== 'DRAFT') throw new ApiError(`Only DRAFT challans can be dispatched (current: ${current.status})`, 400)
      if (!current.items.length) throw new ApiError('Challan has no items to dispatch', 400)

      const result = await db.$transaction(async (tx) => {
        const t = tx as any
        await claimStatus(t.deliveryChallan, id, ['DRAFT'], 'DISPATCHED')
        // Lines as of the claim (an edit-lines that committed just before is included)
        const lines = await tx.deliveryChallanItem.findMany({ where: { challanId: id } })
        if (!lines.length) throw new ApiError('Challan has no items to dispatch', 400)
        // Lock the SO and make sure it is still dispatchable (not cancelled/closed meanwhile).
        const soLock = await tx.salesOrder.updateMany({
          where: { id: current.salesOrderId, companyId, status: { in: ['CONFIRMED', 'IN_PRODUCTION', 'READY', 'PARTIALLY_DISPATCHED'] } },
          data: { updatedAt: new Date() },
        })
        if (soLock.count !== 1) throw new ApiError('The sales order is no longer open for dispatch — refresh and check its status', 409)
        // rate = SO item rate, fallback item.sellingPrice
        const soItems = await tx.salesOrderItem.findMany({ where: { salesOrderId: current.salesOrderId } })
        const soItemMap = new Map(soItems.map((si) => [si.id, si]))
        const itemIds = Array.from(new Set(lines.map((ci) => ci.itemId)))
        const masterItems = await tx.item.findMany({ where: { id: { in: itemIds } }, select: { id: true, sellingPrice: true } })
        const priceMap = new Map(masterItems.map((m) => [m.id, m.sellingPrice]))
        const overrides = new Map<string, { batchNo?: string | null; serials?: string | null }>(
          (Array.isArray(body.lines) ? body.lines : []).filter((l: any) => l?.id).map((l: any) => [String(l.id), l]),
        )

        for (const ci of lines) {
          const soItem = ci.salesOrderItemId ? soItemMap.get(ci.salesOrderItemId) : undefined
          const rate = soItem ? soItem.rate : (priceMap.get(ci.itemId) || 0)
          await postStock(t, {
            companyId,
            itemId: ci.itemId,
            warehouseId: current.warehouseId,
            type: 'DISPATCH_OUT',
            qtyOut: ci.qty,
            rate,
            refType: 'DELIVERY',
            refId: current.id,
            refNumber: current.number,
            date: current.date,
            notes: `Dispatched on challan ${current.number}`,
          })
          // Batch / serial layer (no-op for untracked items)
          const ov = overrides.get(ci.id)
          const chosen = String((ov && ov.batchNo !== undefined ? ov.batchNo : ci.batchNo) || '').trim()
          const allocs = await consumeBatches(tx, {
            companyId, itemId: ci.itemId, warehouseId: current.warehouseId, qty: ci.qty,
            // a stored split ("B1×5, B2×3") is not a single pick → FEFO
            batchNo: chosen && !chosen.includes('×') && !chosen.includes(',') ? chosen : null,
          })
          const serials = await sellSerials(tx, {
            companyId, itemId: ci.itemId, warehouseId: current.warehouseId,
            serials: parseSerials(ov && ov.serials !== undefined ? ov.serials : ci.serials), qty: ci.qty,
            ref: { type: 'DELIVERY', id: current.id },
          })
          if (allocs.length || serials.length) {
            await tx.deliveryChallanItem.update({
              where: { id: ci.id },
              data: {
                ...(allocs.length ? { batchNo: formatAllocation(allocs) } : {}),
                ...(serials.length ? { serials: joinSerials(serials) } : {}),
              },
            })
          }
          if (ci.salesOrderItemId) {
            const si = await tx.salesOrderItem.update({
              where: { id: ci.salesOrderItemId },
              data: { dispatchedQty: { increment: ci.qty } },
            })
            // Several draft challans can exist for one SO line; the one that would overshoot fails here.
            if (r2(si.dispatchedQty) > r2(si.qty) + 0.005) {
              throw new ApiError(`Dispatch exceeds the sales order quantity for a line (ordered ${r2(si.qty)}, dispatched would be ${r2(si.dispatchedQty)})`, 409)
            }
          }
        }

        // Roll SO status up: DISPATCHED when every line fully dispatched,
        // COMPLETED when it is also fully invoiced (invoice raised before dispatch).
        const fresh = await tx.salesOrderItem.findMany({ where: { salesOrderId: current.salesOrderId } })
        const allDone = fresh.length > 0 && fresh.every((si) => r2(si.dispatchedQty) >= r2(si.qty) - 0.005)
        const allInvoiced = fresh.length > 0 && fresh.every((si) => r2(si.invoicedQty) >= r2(si.qty) - 0.005)
        const soStatus = allDone ? (allInvoiced ? 'COMPLETED' : 'DISPATCHED') : 'PARTIALLY_DISPATCHED'
        await tx.salesOrder.update({ where: { id: current.salesOrderId }, data: { status: soStatus } })

        const upd = await tx.deliveryChallan.update({ where: { id }, data: { status: 'DISPATCHED' } })
        await logAudit(t, {
          companyId, userName: body.userName, action: 'POST', entity: 'DeliveryChallan', entityId: id,
          details: `Dispatched ${current.number} — stock posted out, sales order ${soStatus}`,
        })
        return upd
      })
      return ok(result, 'Challan dispatched, stock updated')
    }

    // ---- Cancel (only DRAFT, nothing was posted yet) ----
    if (body.action === 'cancel') {
      if (current.status !== 'DRAFT') throw new ApiError(`Only DRAFT challans can be cancelled (current: ${current.status})`, 400)
      const updated = await db.$transaction(async (tx) => {
        const t = tx as any
        await claimStatus(t.deliveryChallan, id, ['DRAFT'], 'CANCELLED')
        const u = await tx.deliveryChallan.findUniqueOrThrow({ where: { id } })
        await logAudit(t, {
          companyId, userName: body.userName, action: 'CANCEL', entity: 'DeliveryChallan', entityId: id,
          details: `Cancelled delivery challan ${current.number}`,
        })
        return u
      })
      return ok(updated, 'Challan cancelled')
    }

    // ---- Edit lines (only DRAFT, nothing was posted yet) ----
    if (body.action === 'edit-lines') {
      if (current.status !== 'DRAFT') throw new ApiError(`Only DRAFT challans can be edited (current: ${current.status})`, 400)
      const rawLines: any[] = Array.isArray(body.lines) ? body.lines : []
      if (!rawLines.length) throw new ApiError('At least one delivery line is required', 400)
      let warehouseId = current.warehouseId
      if (body.warehouseId !== undefined && body.warehouseId !== null && body.warehouseId !== '') {
        const wh = await db.warehouse.findFirst({ where: { id: String(body.warehouseId), companyId } })
        if (!wh) throw new ApiError('Warehouse not found', 404)
        warehouseId = wh.id
      }
      let date: Date | undefined
      if (body.date !== undefined && body.date !== null && body.date !== '') {
        date = new Date(body.date)
        if (isNaN(date.getTime())) throw new ApiError('date is not a valid date', 400)
      }
      const updated = await db.$transaction(async (tx) => {
        const t = tx as any
        // Atomic claim: still DRAFT (row-locked until commit, so a dispatch can't run on the old lines)
        const g = await tx.deliveryChallan.updateMany({ where: { id, companyId, status: 'DRAFT' }, data: { updatedAt: new Date() } })
        if (g.count !== 1) throw new ApiError('This challan was just dispatched or changed by someone else — refresh and try again', 409)
        const so = await tx.salesOrder.findFirst({ where: { id: current.salesOrderId, companyId }, include: { items: true } })
        if (!so) throw new ApiError('Sales order not found', 404)
        const ALLOWED = ['CONFIRMED', 'IN_PRODUCTION', 'READY', 'PARTIALLY_DISPATCHED']
        if (!ALLOWED.includes(so.status)) throw new ApiError(`Sales order ${so.number} cannot be dispatched in ${so.status} status`, 400)

        const soItemMap = new Map(so.items.map((si) => [si.id, si]))
        const flagRows = await tx.item.findMany({
          where: { companyId, id: { in: Array.from(new Set(so.items.map((si) => si.itemId).concat(rawLines.filter((l) => l?.itemId).map((l) => String(l.itemId))))) } },
          select: { id: true, code: true, name: true, batchTracked: true, trackSerial: true },
        })
        const flags = new Map(flagRows.map((f) => [f.id, f]))
        const used = new Map<string, number>() // qty per SO line across this challan's lines
        const lineData = rawLines.map((l) => {
          const soItem = l?.salesOrderItemId ? soItemMap.get(String(l.salesOrderItemId)) : undefined
          if (!soItem) throw new ApiError('Each line needs a valid salesOrderItemId from this sales order', 400)
          const qty = Number(l.qty)
          if (!(qty > 0)) throw new ApiError('Line qty must be greater than 0', 400)
          const pending = r2(soItem.qty - soItem.dispatchedQty)
          const total = r2((used.get(soItem.id) || 0) + qty)
          if (total > pending + 0.005) throw new ApiError(`Line qty exceeds pending qty (${pending} pending on the sales order line)`, 400)
          used.set(soItem.id, total)
          const itemId = l.itemId ? String(l.itemId) : soItem.itemId
          const f = flags.get(itemId)
          if (!f) throw new ApiError('Item not found', 404)
          const serials = f.trackSerial ? parseSerials(l.serials) : []
          if (f.trackSerial && serials.length && serials.length !== Math.round(qty)) {
            throw new ApiError(`${f.code} ${f.name} is serial-tracked — enter exactly ${r2(qty)} serial no(s) (got ${serials.length})`, 400)
          }
          return {
            challanId: id,
            salesOrderItemId: soItem.id,
            itemId,
            qty: r2(qty),
            batchNo: f.batchTracked && l.batchNo ? String(l.batchNo).trim() || null : null,
            serials: joinSerials(serials),
          }
        })
        await tx.deliveryChallanItem.deleteMany({ where: { challanId: id } })
        await tx.deliveryChallanItem.createMany({ data: lineData })
        const u = await tx.deliveryChallan.update({
          where: { id },
          data: {
            warehouseId,
            ...(date ? { date } : {}),
            ...(body.notes !== undefined ? { notes: body.notes ? String(body.notes) : null } : {}),
          },
          include: {
            salesOrder: { select: { number: true, customerId: true, customer: { select: { name: true } } } },
            items: true,
          },
        })
        await logAudit(t, {
          companyId, userName: body.userName, action: 'UPDATE', entity: 'DeliveryChallan', entityId: id,
          details: `Edited lines of delivery challan ${current.number}: ${current.items.length} → ${lineData.length} line(s), qty ${r2(current.items.reduce((s, l) => s + l.qty, 0))} → ${r2(lineData.reduce((s, l) => s + l.qty, 0))}`,
        })
        return u
      })
      const [row] = await withItemInfo(companyId, [updated])
      return ok(row, 'Challan lines updated')
    }

    if (body.action) throw new ApiError(`Unknown action "${body.action}" (use dispatch | cancel | edit-lines)`, 400)

    // ---- Light edit: transport details on DRAFT/DISPATCHED, everything else DRAFT only ----
    const draftOnly = body.notes !== undefined || body.date !== undefined || body.shippingAddress !== undefined
    if (draftOnly && current.status !== 'DRAFT') throw new ApiError('Notes, date and ship-to can only be edited while DRAFT', 400)
    if (!['DRAFT', 'DISPATCHED'].includes(current.status)) throw new ApiError(`A ${current.status} challan cannot be edited`, 400)
    let lrDate: Date | null | undefined
    if (body.lrDate !== undefined) {
      lrDate = body.lrDate ? new Date(body.lrDate) : null
      if (lrDate && isNaN(lrDate.getTime())) throw new ApiError('lrDate is not a valid date', 400)
    }
    const updated = await db.$transaction(async (tx) => {
      const t = tx as any
      // Atomic guard: the status read above must still hold
      const g = await tx.deliveryChallan.updateMany({ where: { id, status: current.status }, data: { updatedAt: new Date() } })
      if (g.count !== 1) throw new ApiError('This document was just changed by someone else — refresh and try again', 409)
      const data: any = {}
      if (body.vehicleNo !== undefined) data.vehicleNo = body.vehicleNo ?? null
      if (body.transporter !== undefined) data.transporter = body.transporter ?? null
      for (const k of ['ewayBillNo', 'lrNo', 'shippingAddress', 'driverPhone'] as const) {
        if (body[k] !== undefined) data[k] = body[k] === null || String(body[k]).trim() === '' ? null : String(body[k]).trim()
      }
      if (lrDate !== undefined) data.lrDate = lrDate
      if (body.notes !== undefined) data.notes = body.notes ?? null
      if (body.date !== undefined) data.date = new Date(body.date)
      const u = await tx.deliveryChallan.update({
        where: { id },
        data,
        include: {
          salesOrder: {
            select: { number: true, customerId: true, customer: { select: { name: true } } },
          },
          items: true,
        },
      })
      await logAudit(t, {
        companyId, userName: body.userName, action: 'UPDATE', entity: 'DeliveryChallan', entityId: id,
        details: `Updated delivery challan ${current.number}`,
      })
      return u
    })
    const [row] = await withItemInfo(companyId, [updated])
    return ok(row, 'Challan updated')
  } catch (e) {
    return handleError(e)
  }
}

// DELETE /api/deliveries/[id]?companyId=  — only when DRAFT
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireWrite(req, 'deliveries')
    const { id } = await params
    const body = await req.json().catch(() => ({}) as any)
    const companyId = await companyRequired(req, body?.companyId)
    await requireSecurityPin(req, companyId)

    const current = await db.deliveryChallan.findFirst({ where: { id, companyId } })
    if (!current) throw new ApiError('Delivery challan not found', 404)
    if (current.status !== 'DRAFT') throw new ApiError(`Only DRAFT challans can be deleted (current: ${current.status})`, 400)

    await db.$transaction(async (tx) => {
      const t = tx as any
      const del = await tx.deliveryChallan.deleteMany({ where: { id, status: 'DRAFT' } })
      if (del.count !== 1) throw new ApiError('This document was just changed by someone else — refresh and try again', 409)
      await logAudit(t, {
        companyId, userName: body?.userName, action: 'DELETE', entity: 'DeliveryChallan',
        entityId: id, details: `Deleted delivery challan ${current.number}`,
      })
    })
    return ok({ id }, 'Delivery challan deleted')
  } catch (e) {
    return handleError(e)
  }
}
