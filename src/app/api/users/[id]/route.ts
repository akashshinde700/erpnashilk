import type { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { ok, handleError, companyRequired, ApiError, logAudit } from '@/lib/erp-helpers'
import { ROLES } from '@/lib/erp-constants'

// ============================== GET /api/users/[id] ==============================
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const companyId = await companyRequired(req)
    const user = await db.user.findFirst({ where: { id, companyId } })
    if (!user) throw new ApiError('User not found', 404)
    return ok({ user })
  } catch (e) {
    return handleError(e)
  }
}

// ============================== PATCH /api/users/[id] — name/role/phone/active ==============================
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const body = await req.json().catch(() => ({}))
    const companyId = await companyRequired(req, body.companyId)
    const existing = await db.user.findFirst({ where: { id, companyId } })
    if (!existing) throw new ApiError('User not found', 404)
    if (body.name !== undefined && !String(body.name).trim()) throw new ApiError('name cannot be empty', 400)
    if (body.role !== undefined && !(ROLES as readonly string[]).includes(String(body.role))) {
      throw new ApiError('Invalid role', 400)
    }

    const data: Prisma.UserUncheckedUpdateInput = {}
    if (body.name !== undefined) data.name = String(body.name).trim()
    if (body.role !== undefined) data.role = String(body.role)
    if (body.phone !== undefined) data.phone = body.phone || null
    if (body.active !== undefined) data.active = !!body.active

    const user = await db.$transaction(async (tx) => {
      const updated = await tx.user.update({ where: { id: existing.id }, data })
      await logAudit(tx as any, {
        companyId,
        userName: body.userName,
        action: 'UPDATE',
        entity: 'User',
        entityId: id,
        details: `${updated.name} (${updated.role}${updated.active ? '' : ', inactive'})`,
      })
      return updated
    })
    return ok(user, 'User updated')
  } catch (e) {
    return handleError(e)
  }
}

// ============================== DELETE /api/users/[id] ==============================
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const body = await req.json().catch(() => ({}))
    const companyId = await companyRequired(req, body.companyId)
    const existing = await db.user.findFirst({ where: { id, companyId } })
    if (!existing) throw new ApiError('User not found', 404)

    await db.$transaction(async (tx) => {
      await tx.user.delete({ where: { id } })
      await logAudit(tx as any, {
        companyId,
        userName: body.userName,
        action: 'DELETE',
        entity: 'User',
        entityId: id,
        details: `${existing.name} <${existing.email}>`,
      })
    })
    return ok({ id }, 'User deleted')
  } catch (e) {
    return handleError(e)
  }
}
