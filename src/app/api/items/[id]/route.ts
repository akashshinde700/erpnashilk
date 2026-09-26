import type { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { requireWrite, ok, handleError, companyRequired, ApiError, logAudit } from '@/lib/erp-helpers'

function num(v: unknown, def = 0, field = 'value'): number {
  if (v === undefined || v === null || v === '') return def
  const n = Number(v)
  if (Number.isNaN(n)) throw new ApiError(`${field} must be a number`, 400)
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
    if (body.uom !== undefined) data.uom = String(body.uom)
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
