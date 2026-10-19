import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { fail, handleError, logAudit, sessionUser } from '@/lib/erp-helpers'
import { hashPassword, passwordProblem, verifyPassword } from '@/lib/password'
import { loginBlocked, loginFailed, loginSucceeded, passwordVersion, sessionCookie, signSession } from '@/lib/session'

// POST /api/auth/change-password { currentPassword, newPassword }
// Changes the signed-in user's own password and re-issues their session cookie
// (sessions issued before the change stop working).
export async function POST(req: Request) {
  try {
    const me = await sessionUser(req)
    const body = await req.json().catch(() => ({}))
    const currentPassword = typeof body?.currentPassword === 'string' ? body.currentPassword : ''
    const newPassword = typeof body?.newPassword === 'string' ? body.newPassword.trim() : ''
    if (!currentPassword || !newPassword) {
      return fail('Current and new passwords are required', 400)
    }
    const problem = passwordProblem(newPassword)
    if (problem) return fail(problem, 400)

    const throttleKey = `pwd|${me.id}`
    if (loginBlocked(throttleKey)) return fail('Too many wrong attempts. Try again later.', 429)

    const user = await db.user.findUnique({ where: { id: me.id } })
    if (!user) return fail('User not found', 404)

    if (!verifyPassword(currentPassword, user.passwordHash)) {
      loginFailed(throttleKey)
      return fail('Current password is incorrect', 401)
    }
    loginSucceeded(throttleKey)
    if (verifyPassword(newPassword, user.passwordHash)) {
      return fail('New password must be different from current password', 400)
    }

    const passwordHash = hashPassword(newPassword)
    await db.user.update({ where: { id: user.id }, data: { passwordHash } })

    try {
      await logAudit(db as never, {
        companyId: user.companyId,
        userName: user.name,
        action: 'CONFIG',
        entity: 'USER',
        entityId: user.id,
        details: `Password changed for ${user.email}`,
      })
    } catch {
      // ignore audit failures — the password change must still succeed
    }

    const token = signSession({ uid: user.id, cid: user.companyId, role: user.role, name: user.name, pv: passwordVersion(passwordHash) })
    const res = NextResponse.json({ success: true, data: { success: true }, message: 'Password updated successfully' })
    res.headers.append('Set-Cookie', sessionCookie(token))
    return res
  } catch (e) {
    return handleError(e)
  }
}
