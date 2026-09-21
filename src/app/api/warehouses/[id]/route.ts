import type { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { requireWrite, ok, handleError, companyRequired, ApiError, logAudit } from '@/lib/erp-helpers'

const WAREHOUSE_TYPES = ['RM', 'FG', 'GENERAL', 'SCRAP']

// ============================== GET /api/warehouses/[id] ==============================
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const companyId = await companyRequired(req)
    const warehouse = await db.warehouse.findFirst({ where: { id, companyId } })
    if (!warehouse) throw new ApiError('Warehouse not found', 404)
    return ok({ warehouse })
  } catch (e) {
    return handleError(e)
  }
}

// ============================== PATCH /api/warehouses/[id] ==============================
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireWrite(req, 'warehouses')
    const { id } = await params
    const body = await req.json().catch(() => ({}))
    const companyId = await companyRequired(req, body.companyId)
    const existing = await db.warehouse.findFirst({ where: { id, companyId } })
    if (!existing) throw new ApiError('Warehouse not found', 404)
    if (body.code !== undefined && !String(body.code).trim()) throw new ApiError('code cannot be empty', 400)
    if (body.name !== undefined && !String(body.name).trim()) throw new ApiError('name cannot be empty', 400)
    if (body.type !== undefined && !WAREHOUSE_TYPES.includes(String(body.type))) {
      throw new ApiError('type must be one of RM, FG, GENERAL, SCRAP', 400)
    }

    const data: Prisma.WarehouseUncheckedUpdateInput = {}
    if (body.code !== undefined) data.code = String(body.code).trim()
    if (body.name !== undefined) data.name = String(body.name).trim()
    if (body.type !== undefined) data.type = String(body.type)
    if (body.location !== undefined) data.location = body.location || null

    const warehouse = await db.$transaction(async (tx) => {
      const updated = await tx.warehouse.update({ where: { id: existing.id }, data })
      await logAudit(tx as any, {
        companyId,
        userName: body.userName,
        action: 'UPDATE',
        entity: 'Warehouse',
        entityId: id,
        details: `${updated.code} — ${updated.name}`,
      })
      return updated
    })
    return ok(warehouse, 'Warehouse updated')
  } catch (e) {
    return handleError(e)
  }
}

// ============================== DELETE /api/warehouses/[id] ==============================
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireWrite(req, 'warehouses')
    const { id } = await params
    const body = await req.json().catch(() => ({}))
    const companyId = await companyRequired(req, body.companyId)
    const existing = await db.warehouse.findFirst({ where: { id, companyId } })
    if (!existing) throw new ApiError('Warehouse not found', 404)

    const bal = await db.stockBalance.findFirst({ where: { warehouseId: id, companyId } })
    if (bal) {
      throw new ApiError('Warehouse has stock balances; clear/move stock before deleting', 409)
    }

    await db.$transaction(async (tx) => {
      await tx.warehouse.delete({ where: { id } })
      await logAudit(tx as any, {
        companyId,
        userName: body.userName,
        action: 'DELETE',
        entity: 'Warehouse',
        entityId: id,
        details: `${existing.code} — ${existing.name}`,
      })
    })
    return ok({ id }, 'Warehouse deleted')
  } catch (e) {
    return handleError(e)
  }
}
