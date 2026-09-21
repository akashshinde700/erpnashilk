import type { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { requireWrite, ok, handleError, companyRequired, ApiError, logAudit } from '@/lib/erp-helpers'

function num(v: unknown, def = 0, field = 'value'): number {
  if (v === undefined || v === null || v === '') return def
  const n = Number(v)
  if (Number.isNaN(n)) throw new ApiError(`${field} must be a number`, 400)
  return n
}

// ============================== GET /api/suppliers/[id] ==============================
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const companyId = await companyRequired(req)
    const supplier = await db.supplier.findFirst({ where: { id, companyId } })
    if (!supplier) throw new ApiError('Supplier not found', 404)
    return ok({ supplier })
  } catch (e) {
    return handleError(e)
  }
}

// ============================== PATCH /api/suppliers/[id] ==============================
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireWrite(req, 'suppliers')
    const { id } = await params
    const body = await req.json().catch(() => ({}))
    const companyId = await companyRequired(req, body.companyId)
    const existing = await db.supplier.findFirst({ where: { id, companyId } })
    if (!existing) throw new ApiError('Supplier not found', 404)
    if (body.code !== undefined && !String(body.code).trim()) throw new ApiError('code cannot be empty', 400)
    if (body.name !== undefined && !String(body.name).trim()) throw new ApiError('name cannot be empty', 400)

    const data: Prisma.SupplierUncheckedUpdateInput = {}
    if (body.code !== undefined) data.code = String(body.code).trim()
    if (body.name !== undefined) data.name = String(body.name).trim()
    if (body.gstin !== undefined) data.gstin = body.gstin || null
    if (body.contactPerson !== undefined) data.contactPerson = body.contactPerson || null
    if (body.phone !== undefined) data.phone = body.phone || null
    if (body.email !== undefined) data.email = body.email || null
    if (body.addressLine !== undefined) data.addressLine = body.addressLine || null
    if (body.city !== undefined) data.city = body.city || null
    if (body.state !== undefined) data.state = body.state || null
    if (body.stateCode !== undefined) data.stateCode = body.stateCode || null
    if (body.paymentTermsDays !== undefined) {
      data.paymentTermsDays = Math.round(num(body.paymentTermsDays, 30, 'paymentTermsDays'))
    }
    if (body.status !== undefined) data.status = String(body.status)

    const supplier = await db.$transaction(async (tx) => {
      const updated = await tx.supplier.update({ where: { id: existing.id }, data })
      await logAudit(tx as any, {
        companyId,
        userName: body.userName,
        action: 'UPDATE',
        entity: 'Supplier',
        entityId: id,
        details: `${updated.code} — ${updated.name}`,
      })
      return updated
    })
    return ok(supplier, 'Supplier updated')
  } catch (e) {
    return handleError(e)
  }
}

// ============================== DELETE /api/suppliers/[id] ==============================
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireWrite(req, 'suppliers')
    const { id } = await params
    const body = await req.json().catch(() => ({}))
    const companyId = await companyRequired(req, body.companyId)
    const existing = await db.supplier.findFirst({ where: { id, companyId } })
    if (!existing) throw new ApiError('Supplier not found', 404)

    const [poRef, piRef] = await Promise.all([
      db.purchaseOrder.findFirst({ where: { supplierId: id, companyId } }),
      db.purchaseInvoice.findFirst({ where: { supplierId: id, companyId } }),
    ])
    if (poRef || piRef) {
      throw new ApiError('Supplier is used in documents; deactivate instead', 409)
    }

    await db.$transaction(async (tx) => {
      await tx.supplier.delete({ where: { id } })
      await logAudit(tx as any, {
        companyId,
        userName: body.userName,
        action: 'DELETE',
        entity: 'Supplier',
        entityId: id,
        details: `${existing.code} — ${existing.name}`,
      })
    })
    return ok({ id }, 'Supplier deleted')
  } catch (e) {
    return handleError(e)
  }
}
