import type { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { requireSecurityPin } from '@/lib/security-pin'
import { requireWrite, ok, handleError, companyRequired, ApiError, logAudit } from '@/lib/erp-helpers'

function num(v: unknown, def = 0, field = 'value'): number {
  if (v === undefined || v === null || v === '') return def
  const n = Number(v)
  if (Number.isNaN(n)) throw new ApiError(`${field} must be a number`, 400)
  return n
}

function optInt(v: unknown, field: string): number | null {
  if (v === undefined || v === null || v === '') return null
  const n = Number(v)
  if (!Number.isInteger(n) || n < 0) throw new ApiError(`${field} must be a whole number of 0 or more`, 400)
  return n
}

const optStr = (v: unknown): string | null => (v === undefined || v === null ? null : String(v).trim() || null)

/** Optional number that must be >= 0 when given ('' / null → null). */
function optNonNeg(v: unknown, field: string): number | null {
  if (v === undefined || v === null || v === '') return null
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0) throw new ApiError(`${field} must be a number of 0 or more`, 400)
  return n
}

// ============================== GET /api/items/[id] ==============================
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const companyId = await companyRequired(req)
    const item = await db.item.findFirst({ where: { id, companyId } })
    if (!item) throw new ApiError('Item not found', 404)
    return ok({ item })
  } catch (e) {
    return handleError(e)
  }
}

// ============================== PATCH /api/items/[id] ==============================
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireWrite(req, 'items')
    const { id } = await params
    const body = await req.json().catch(() => ({}))
    const companyId = await companyRequired(req, body.companyId)
    const existing = await db.item.findFirst({ where: { id, companyId } })
    if (!existing) throw new ApiError('Item not found', 404)
    if (body.code !== undefined && !String(body.code).trim()) throw new ApiError('code cannot be empty', 400)
    if (body.name !== undefined && !String(body.name).trim()) throw new ApiError('name cannot be empty', 400)

    const data: Prisma.ItemUncheckedUpdateInput = {}
    if (body.code !== undefined) data.code = String(body.code).trim()
    if (body.name !== undefined) data.name = String(body.name).trim()
    if (body.type !== undefined) data.type = String(body.type)
    if (body.category !== undefined) data.category = body.category || null
    if (body.uom !== undefined) {
      const u = String(body.uom).trim().toUpperCase()
      if (!u) throw new ApiError('uom cannot be empty', 400)
      data.uom = u
    }
    // Secondary unit: validated against the final (possibly changed) UOM — both or neither
    if (body.altUom !== undefined || body.altFactor !== undefined || body.uom !== undefined) {
      const uom = (typeof data.uom === 'string' ? data.uom : existing.uom).toUpperCase()
      const altUom = body.altUom !== undefined ? (optStr(body.altUom)?.toUpperCase() ?? null) : existing.altUom
      const altFactor = body.altFactor !== undefined
        ? (body.altFactor === null || body.altFactor === '' ? null : Number(body.altFactor))
        : existing.altFactor
      if (altUom || altFactor != null) {
        if (!altUom || altFactor == null) throw new ApiError('Secondary unit needs both the unit and its conversion factor', 400)
        if (altUom.length > 20) throw new ApiError('Secondary unit is too long', 400)
        if (altUom === uom) throw new ApiError('Secondary unit must differ from the primary UOM', 400)
        if (!Number.isFinite(altFactor) || altFactor <= 0) throw new ApiError('Conversion factor must be greater than 0', 400)
      }
      data.altUom = altUom || null
      data.altFactor = altUom ? altFactor : null
    }
    if (body.mrp !== undefined) data.mrp = optNonNeg(body.mrp, 'MRP')
    if (body.priceIncludesTax !== undefined) data.priceIncludesTax = !!body.priceIncludesTax
    if (body.rack !== undefined) data.rack = optStr(body.rack)
    if (body.cessRate !== undefined) {
      const c = optNonNeg(body.cessRate, 'Cess %') ?? 0
      if (c > 100) throw new ApiError('Cess % cannot exceed 100', 400)
      data.cessRate = c
    }
    if (body.trackSerial !== undefined) data.trackSerial = !!body.trackSerial
    if (body.hsn !== undefined) data.hsn = body.hsn || null
    if (body.gstRate !== undefined) data.gstRate = num(body.gstRate, 18, 'gstRate')
    if (body.batchTracked !== undefined) data.batchTracked = !!body.batchTracked
    if (body.reorderLevel !== undefined) data.reorderLevel = num(body.reorderLevel, 0, 'reorderLevel')
    if (body.minStock !== undefined) data.minStock = num(body.minStock, 0, 'minStock')
    if (body.maxStock !== undefined) {
      data.maxStock = body.maxStock === null || body.maxStock === '' ? null : num(body.maxStock, 0, 'maxStock')
    }
    if (body.purchasePrice !== undefined) data.purchasePrice = num(body.purchasePrice, 0, 'purchasePrice')
    if (body.sellingPrice !== undefined) data.sellingPrice = num(body.sellingPrice, 0, 'sellingPrice')
    if (body.standardCost !== undefined) data.standardCost = num(body.standardCost, 0, 'standardCost')
    if (body.description !== undefined) data.description = body.description || null
    if (body.brand !== undefined) data.brand = optStr(body.brand)
    if (body.partNo !== undefined) data.partNo = optStr(body.partNo)
    if (body.barcode !== undefined) data.barcode = optStr(body.barcode)
    if (body.leadTimeDays !== undefined) data.leadTimeDays = optInt(body.leadTimeDays, 'leadTimeDays')
    if (body.status !== undefined) {
      const st = String(body.status)
      if (!['ACTIVE', 'INACTIVE'].includes(st)) throw new ApiError('status must be ACTIVE or INACTIVE', 400)
      data.status = st
    }

    const item = await db.$transaction(async (tx) => {
      const updated = await tx.item.update({ where: { id: existing.id }, data })
      await logAudit(tx as any, {
        companyId,
        userName: body.userName,
        action: 'UPDATE',
        entity: 'Item',
        entityId: id,
        details: `${updated.code} — ${updated.name}`,
      })
      return updated
    })
    return ok(item, 'Item updated')
  } catch (e) {
    return handleError(e)
  }
}

// ============================== DELETE /api/items/[id] ==============================
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireWrite(req, 'items')
    const { id } = await params
    const body = await req.json().catch(() => ({}))
    const companyId = await companyRequired(req, body.companyId)
    await requireSecurityPin(req, companyId)
    const existing = await db.item.findFirst({ where: { id, companyId } })
    if (!existing) throw new ApiError('Item not found', 404)

    const [posBalance, ledgerRow, bomLine, soLine, poLine] = await Promise.all([
      db.stockBalance.findFirst({ where: { itemId: id, companyId, qty: { gt: 0 } } }),
      db.stockLedger.findFirst({ where: { itemId: id, companyId } }),
      db.bomItem.findFirst({ where: { itemId: id, bom: { companyId } } }),
      db.salesOrderItem.findFirst({ where: { itemId: id, salesOrder: { companyId } } }),
      db.purchaseOrderItem.findFirst({ where: { itemId: id, po: { companyId } } }),
    ])
    if (posBalance || ledgerRow || bomLine || soLine || poLine) {
      throw new ApiError('Item is used in documents; deactivate instead', 409)
    }
    const child = await db.item.findFirst({ where: { companyId, variantOf: id }, select: { id: true } })
    if (child) throw new ApiError('Item has variants — delete or deactivate its variants first', 409)

    await db.$transaction(async (tx) => {
      await tx.stockBalance.deleteMany({ where: { itemId: id, companyId } }) // clear zero-qty balances
      await tx.item.delete({ where: { id } })
      await logAudit(tx as any, {
        companyId,
        userName: body.userName,
        action: 'DELETE',
        entity: 'Item',
        entityId: id,
        details: `${existing.code} — ${existing.name}`,
      })
    })
    return ok({ id }, 'Item deleted')
  } catch (e) {
    return handleError(e)
  }
}
