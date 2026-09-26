import type { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { requireWrite, ok, handleError, companyRequired, ApiError, logAudit, sessionUser, PLATFORM_ROLE, USER_PUBLIC } from '@/lib/erp-helpers'
import { ROLES } from '@/lib/erp-constants'
import { hashPassword, passwordProblem } from '@/lib/password'

/** Refuse changes that would leave the company without an active Tenant Admin. */
async function assertAnotherAdmin(companyId: string, excludeId: string) {
  const others = await db.user.count({ where: { companyId, role: 'TENANT_ADMIN', active: true, id: { not: excludeId } } })
  if (others === 0) throw new ApiError('The company must keep at least one active Tenant Admin', 400)
}

// ============================== GET /api/users/[id] ==============================
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const companyId = await companyRequired(req)
    const user = await db.user.findFirst({ where: { id, companyId }, select: USER_PUBLIC })
    if (!user) throw new ApiError('User not found', 404)
    return ok({ user })
  } catch (e) {
    return handleError(e)
  }
}

// ============================== PATCH /api/users/[id] — name/role/phone/active/password ==============================
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireWrite(req, 'users')
    const { id } = await params
    const body = await req.json().catch(() => ({}))
    const companyId = await companyRequired(req, body.companyId)
    const me = await sessionUser(req)
    const existing = await db.user.findFirst({ where: { id, companyId } })
    if (!existing) throw new ApiError('User not found', 404)
    if (existing.role === PLATFORM_ROLE && me.role !== PLATFORM_ROLE) throw new ApiError('You cannot modify the platform administrator', 403)
    if (body.name !== undefined && !String(body.name).trim()) throw new ApiError('name cannot be empty', 400)
    if (body.role !== undefined && String(body.role) !== existing.role && !(ROLES as readonly string[]).includes(String(body.role))) {
      throw new ApiError('Invalid role', 400)
    }

    const data: Prisma.UserUncheckedUpdateInput = {}
    if (body.name !== undefined) data.name = String(body.name).trim()
    if (body.role !== undefined) data.role = String(body.role)
    if (body.phone !== undefined) data.phone = body.phone || null
    if (body.active !== undefined) data.active = !!body.active
    if (body.password !== undefined && body.password !== '') {
      const problem = passwordProblem(body.password)
      if (problem) throw new ApiError(problem, 400)
      data.passwordHash = hashPassword(String(body.password))
    }

    const roleChanged = data.role !== undefined && data.role !== existing.role
    const deactivated = data.active === false && existing.active
    if (id === me.id && (roleChanged || deactivated)) throw new ApiError('You cannot change your own role or deactivate yourself', 400)
    if (existing.role === 'TENANT_ADMIN' && existing.active && (roleChanged || deactivated)) await assertAnotherAdmin(companyId, id)

    const user = await db.$transaction(async (tx) => {
      const updated = await tx.user.update({ where: { id: existing.id }, data, select: USER_PUBLIC })
      await logAudit(tx as any, {
        companyId,
        action: 'UPDATE',
        entity: 'User',
        entityId: id,
        details: `${updated.name} (${updated.role}${updated.active ? '' : ', inactive'})${data.passwordHash ? ', password reset' : ''}`,
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
    requireWrite(req, 'users')
    const { id } = await params
    const body = await req.json().catch(() => ({}))
    const companyId = await companyRequired(req, body.companyId)
    const me = await sessionUser(req)
    const existing = await db.user.findFirst({ where: { id, companyId } })
    if (!existing) throw new ApiError('User not found', 404)
    if (id === me.id) throw new ApiError('You cannot delete your own account', 400)
    if (existing.role === PLATFORM_ROLE && me.role !== PLATFORM_ROLE) throw new ApiError('You cannot delete the platform administrator', 403)
    if (existing.role === 'TENANT_ADMIN' && existing.active) await assertAnotherAdmin(companyId, id)

    await db.$transaction(async (tx) => {
      await tx.user.delete({ where: { id } })
      await logAudit(tx as any, {
        companyId,
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
