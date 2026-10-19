import type { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { requireWrite, ok, handleError, companyRequired, ApiError, logAudit } from '@/lib/erp-helpers'

function num(v: unknown, def = 0, field = 'value'): number {
  if (v === undefined || v === null || v === '') return def
  const n = Number(v)
  if (Number.isNaN(n)) throw new ApiError(`${field} must be a number`, 400)
  return n
}

interface RawLine { itemId?: unknown; qty?: unknown; scrapPct?: unknown }

function parseLines(raw: unknown): { itemId: string; qty: number; scrapPct: number }[] {
  const rawLines: RawLine[] = Array.isArray(raw) ? raw : []
  if (rawLines.length === 0) throw new ApiError('At least one BOM line is required', 400)
  return rawLines.map((l) => {
    const itemId = String(l?.itemId || '')
    const qty = num(l?.qty, 0, 'qty')
    if (!itemId) throw new ApiError('Each BOM line requires an itemId', 400)
    if (qty <= 0) throw new ApiError('BOM line qty must be greater than 0', 400)
    return { itemId, qty, scrapPct: num(l?.scrapPct, 0, 'scrapPct') }
  })
}

// ============================== GET /api/boms/[id] ==============================
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const companyId = await companyRequired(req)
    const bom = await db.bom.findFirst({ where: { id, companyId }, include: { items: true } })
    if (!bom) throw new ApiError('BOM not found', 404)
    const ids = Array.from(new Set([bom.outputItemId, ...bom.items.map((l) => l.itemId)]))
    const itemRows = await db.item.findMany({
      where: { companyId, id: { in: ids } },
      select: { id: true, code: true, name: true, uom: true },
    })
    const map = new Map(itemRows.map((i) => [i.id, i]))
    const out = map.get(bom.outputItemId)
    return ok({
      bom: {
        ...bom,
        outputItem: out ? { id: out.id, code: out.code, name: out.name, uom: out.uom } : null,
        items: bom.items.map((l) => ({
          id: l.id,
          itemId: l.itemId,
          qty: l.qty,
          scrapPct: l.scrapPct,
          item: map.get(l.itemId) || null,
        })),
      },
    })
  } catch (e) {
    return handleError(e)
  }
}

// ============================== PATCH /api/boms/[id] — same shape; replaces lines ==============================
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireWrite(req, 'boms')
    const { id } = await params
    const body = await req.json().catch(() => ({}))
    const companyId = await companyRequired(req, body.companyId)
    const existing = await db.bom.findFirst({ where: { id, companyId } })
    if (!existing) throw new ApiError('BOM not found', 404)
    if (body.code !== undefined && !String(body.code).trim()) throw new ApiError('code cannot be empty', 400)

    const data: Prisma.BomUncheckedUpdateInput = {}
    if (body.code !== undefined) data.code = String(body.code).trim()
    if (body.outputItemId !== undefined) data.outputItemId = String(body.outputItemId)
    if (body.outputQty !== undefined) data.outputQty = num(body.outputQty, 1, 'outputQty')
    if (body.version !== undefined) data.version = String(body.version)
    if (body.scrapPct !== undefined) data.scrapPct = num(body.scrapPct, 0, 'scrapPct')
    if (body.notes !== undefined) data.notes = body.notes || null
    if (body.status !== undefined) {
      const st = String(body.status)
      if (!['DRAFT', 'ACTIVE', 'RETIRED'].includes(st)) throw new ApiError('status must be DRAFT, ACTIVE or RETIRED', 400)
      data.status = st
    }

    // If items array is present, validate + replace all lines (deleteMany + create)
    let replaceLines: { itemId: string; qty: number; scrapPct: number }[] | null = null
    if (body.items !== undefined) replaceLines = parseLines(body.items)

    const outputItemId = body.outputItemId !== undefined ? String(body.outputItemId) : existing.outputItemId
    if (body.outputItemId !== undefined || replaceLines) {
      const ids = Array.from(new Set([outputItemId, ...(replaceLines || []).map((l) => l.itemId)]))
      const found = await db.item.findMany({ where: { companyId, id: { in: ids } }, select: { id: true } })
      const foundIds = new Set(found.map((f) => f.id))
      if (!foundIds.has(outputItemId)) throw new ApiError('Output item not found in this company', 400)
      if (replaceLines && replaceLines.some((l) => !foundIds.has(l.itemId))) {
        throw new ApiError('One or more BOM line items are invalid for this company', 400)
      }
    }
    if (body.outputQty !== undefined && (data.outputQty as number) <= 0) {
      throw new ApiError('outputQty must be greater than 0', 400)
    }

    const bom = await db.$transaction(async (tx) => {
      const updated = await tx.bom.update({ where: { id: existing.id }, data })
      if (replaceLines) {
        await tx.bomItem.deleteMany({ where: { bomId: existing.id } })
        for (const l of replaceLines) {
          await tx.bomItem.create({
            data: { bomId: existing.id, itemId: l.itemId, qty: l.qty, scrapPct: l.scrapPct },
          })
        }
      }
      await logAudit(tx as any, {
        companyId,
        userName: body.userName,
        action: 'UPDATE',
        entity: 'Bom',
        entityId: id,
        details: `${updated.code} (${updated.version})${replaceLines ? ` — lines replaced (${replaceLines.length})` : ''}`,
      })
      return updated
    })
    return ok(bom, 'BOM updated')
  } catch (e) {
    return handleError(e)
  }
}

// ============================== DELETE /api/boms/[id] — cascades items ==============================
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireWrite(req, 'boms')
    const { id } = await params
    const body = await req.json().catch(() => ({}))
    const companyId = await companyRequired(req, body.companyId)
    const existing = await db.bom.findFirst({ where: { id, companyId } })
    if (!existing) throw new ApiError('BOM not found', 404)

    // WorkOrder.bomId is a plain string (no FK) — block instead of orphaning work orders
    const woRef = await db.workOrder.findFirst({ where: { bomId: id, companyId }, select: { number: true } })
    if (woRef) throw new ApiError(`BOM is used by work order ${woRef.number}; retire it instead`, 409)

    await db.$transaction(async (tx) => {
      await tx.bomItem.deleteMany({ where: { bomId: id } })
      await tx.bom.delete({ where: { id } })
      await logAudit(tx as any, {
        companyId,
        userName: body.userName,
        action: 'DELETE',
        entity: 'Bom',
        entityId: id,
        details: `${existing.code} (${existing.version})`,
      })
    })
    return ok({ id }, 'BOM deleted')
  } catch (e) {
    return handleError(e)
  }
}
