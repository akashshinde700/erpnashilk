import { db } from '@/lib/db'
import { fail, handleError, logAudit, ok } from '@/lib/erp-helpers'
import { hashPassword, verifyPassword } from '@/lib/password'

// POST /api/auth/change-password { userId, currentPassword, newPassword, userName? }
// → ok({ success: true }, 'Password updated successfully')
// Legacy demo users (passwordHash null) authenticate with the shared demo password.
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}))
    const userId = typeof body?.userId === 'string' ? body.userId.trim() : ''
    const currentPassword = typeof body?.currentPassword === 'string' ? body.currentPassword : ''
    const newPassword = typeof body?.newPassword === 'string' ? body.newPassword : ''
    if (!userId || !currentPassword || !newPassword) {
      return fail('Current and new passwords are required', 400)
    }
    if (newPassword.trim().length < 6) {
      return fail('New password must be at least 6 characters', 400)
    }

    const user = await db.user.findUnique({ where: { id: userId } })
    if (!user) return fail('User not found', 404)

    // verifyPassword falls back to the demo password when passwordHash is null
    // (legacy users created before the auth phase).
    if (!verifyPassword(currentPassword, user.passwordHash)) {
      return fail('Current password is incorrect', 401)
    }

    // Reject a no-op change: the new (trimmed) password must differ from the
    // effective current one (hashed, or the demo default for legacy users).
    if (verifyPassword(newPassword.trim(), user.passwordHash)) {
      return fail('New password must be different from current password', 400)
    }

    await db.user.update({
      where: { id: user.id },
      data: { passwordHash: hashPassword(newPassword.trim()) },
    })

    try {
      await logAudit(db as never, {
        companyId: user.companyId,
        userName: typeof body?.userName === 'string' && body.userName.trim() ? body.userName.trim() : user.name,
        action: 'CONFIG',
        entity: 'USER',
        entityId: user.id,
        details: `Password changed for ${user.email}`,
      })
    } catch {
      // ignore audit failures — the password change must still succeed
    }

    return ok({ success: true }, 'Password updated successfully')
  } catch (e) {
    return handleError(e)
  }
}
