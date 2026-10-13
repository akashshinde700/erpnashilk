import type { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { requireSecurityPin } from '@/lib/security-pin'
import { partyData, sharedProfile } from '@/lib/party'
import { requireWrite, ok, handleError, companyRequired, ApiError, logAudit } from '@/lib/erp-helpers'


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
    Object.assign(data, partyData(body, 'update'))
    if (body.status !== undefined) {
      const st = String(body.status)
      if (!['ACTIVE', 'INACTIVE'].includes(st)) throw new ApiError('status must be ACTIVE or INACTIVE', 400)
      data.status = st
    }

    const supplier = await db.$transaction(async (tx) => {
      const updated = await tx.supplier.update({ where: { id: existing.id }, data })
      // "Both" party: keep the linked customer's profile in step
      await tx.customer.updateMany({ where: { supplierId: existing.id, companyId }, data: sharedProfile(data) })
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
    await requireSecurityPin(req, companyId)
    const existing = await db.supplier.findFirst({ where: { id, companyId } })
    if (!existing) throw new ApiError('Supplier not found', 404)

    const [poRef, piRef, payRef] = await Promise.all([
      db.purchaseOrder.findFirst({ where: { supplierId: id, companyId }, select: { id: true } }),
      db.purchaseInvoice.findFirst({ where: { supplierId: id, companyId }, select: { id: true } }),
      db.payment.findFirst({ where: { supplierId: id, companyId }, select: { id: true } }),
    ])
    if (poRef || piRef || payRef) {
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
