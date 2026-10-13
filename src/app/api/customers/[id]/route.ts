import type { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { requireSecurityPin } from '@/lib/security-pin'
import { partyData, sharedProfile } from '@/lib/party'
import { requireWrite, ok, handleError, companyRequired, ApiError, logAudit } from '@/lib/erp-helpers'


// ============================== GET /api/customers/[id] ==============================
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const companyId = await companyRequired(req)
    const customer = await db.customer.findFirst({ where: { id, companyId } })
    if (!customer) throw new ApiError('Customer not found', 404)
    return ok({ customer })
  } catch (e) {
    return handleError(e)
  }
}

// ============================== PATCH /api/customers/[id] ==============================
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireWrite(req, 'customers')
    const { id } = await params
    const body = await req.json().catch(() => ({}))
    const companyId = await companyRequired(req, body.companyId)
    const existing = await db.customer.findFirst({ where: { id, companyId } })
    if (!existing) throw new ApiError('Customer not found', 404)
    if (body.code !== undefined && !String(body.code).trim()) throw new ApiError('code cannot be empty', 400)
    if (body.name !== undefined && !String(body.name).trim()) throw new ApiError('name cannot be empty', 400)

    const data: Prisma.CustomerUncheckedUpdateInput = {}
    if (body.code !== undefined) data.code = String(body.code).trim()
    if (body.name !== undefined) data.name = String(body.name).trim()
    Object.assign(data, partyData(body, 'update'))
    if (body.status !== undefined) {
      const st = String(body.status)
      if (!['ACTIVE', 'INACTIVE'].includes(st)) throw new ApiError('status must be ACTIVE or INACTIVE', 400)
      data.status = st
    }

    const customer = await db.$transaction(async (tx) => {
      const updated = await tx.customer.update({ where: { id: existing.id }, data })
      // "Both" party: keep the linked supplier's profile in step
      if (existing.supplierId) await tx.supplier.update({ where: { id: existing.supplierId }, data: sharedProfile(data) })
      await logAudit(tx as any, {
        companyId,
        userName: body.userName,
        action: 'UPDATE',
        entity: 'Customer',
        entityId: id,
        details: `${updated.code} — ${updated.name}`,
      })
      return updated
    })
    return ok(customer, 'Customer updated')
  } catch (e) {
    return handleError(e)
  }
}

// ============================== DELETE /api/customers/[id] ==============================
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireWrite(req, 'customers')
    const { id } = await params
    const body = await req.json().catch(() => ({}))
    const companyId = await companyRequired(req, body.companyId)
    await requireSecurityPin(req, companyId)
    const existing = await db.customer.findFirst({ where: { id, companyId } })
    if (!existing) throw new ApiError('Customer not found', 404)

    const [soRef, invRef, enqRef, qtRef, payRef] = await Promise.all([
      db.salesOrder.findFirst({ where: { customerId: id, companyId }, select: { id: true } }),
      db.salesInvoice.findFirst({ where: { customerId: id, companyId }, select: { id: true } }),
      db.enquiry.findFirst({ where: { customerId: id, companyId }, select: { id: true } }),
      db.quotation.findFirst({ where: { customerId: id, companyId }, select: { id: true } }),
      db.payment.findFirst({ where: { customerId: id, companyId }, select: { id: true } }),
    ])
    if (soRef || invRef || enqRef || qtRef || payRef) {
      throw new ApiError('Customer is used in documents; deactivate instead', 409)
    }

    await db.$transaction(async (tx) => {
      await tx.customer.delete({ where: { id } })
      await logAudit(tx as any, {
        companyId,
        userName: body.userName,
        action: 'DELETE',
        entity: 'Customer',
        entityId: id,
        details: `${existing.code} — ${existing.name}`,
      })
    })
    return ok({ id }, 'Customer deleted')
  } catch (e) {
    return handleError(e)
  }
}
