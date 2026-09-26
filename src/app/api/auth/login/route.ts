import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { fail, handleError, logAudit } from '@/lib/erp-helpers'
import { verifyPassword } from '@/lib/password'
import {
  clientIp, loginBlocked, loginFailed, loginSucceeded, passwordVersion, sessionCookie, signSession,
} from '@/lib/session'

// Burns the same scrypt time for unknown emails so response timing doesn't reveal which emails exist.
const DUMMY_HASH = '00000000000000000000000000000000:0000000000000000000000000000000000000000000000000000000000000000'

// POST /api/auth/login { email, password }
// → ok({ user: { id, name, email, role, companyId }, company: { id, name, gstin, city, stateCode, logoText } })
// and sets the signed httpOnly session cookie.
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}))
    const email = typeof body?.email === 'string' ? body.email.trim() : ''
    const password = typeof body?.password === 'string' ? body.password : ''
    if (!email || !password) return fail('Email and password are required', 400)

    const throttleKey = `${clientIp(req)}|${email.toLowerCase()}`
    const waitMin = loginBlocked(throttleKey)
    if (waitMin) return fail(`Too many failed sign-in attempts. Try again in ${waitMin} minute${waitMin === 1 ? '' : 's'}.`, 429)

    // MySQL's default collation makes this match case-insensitive.
    const candidates = await db.user.findMany({
      where: { email },
      select: { id: true, name: true, email: true, role: true, companyId: true, active: true, passwordHash: true },
    })
    if (candidates.length === 0) verifyPassword(password, DUMMY_HASH)

    const matched = candidates.find((u) => verifyPassword(password, u.passwordHash))
    if (!matched) {
      loginFailed(throttleKey)
      return fail('Invalid email or password', 401)
    }
    if (!matched.active) return fail('Account is inactive', 403)

    const company = await db.company.findUnique({
      where: { id: matched.companyId },
      select: { id: true, name: true, gstin: true, city: true, stateCode: true, logoText: true },
    })
    if (!company) return fail('Invalid email or password', 401)
    loginSucceeded(throttleKey)

    await logAudit(db as never, {
      companyId: company.id,
      userName: matched.name,
      action: 'LOGIN',
      entity: 'USER',
      entityId: matched.id,
      details: 'Signed in',
    })

    const token = signSession({
      uid: matched.id, cid: matched.companyId, role: matched.role, name: matched.name, pv: passwordVersion(matched.passwordHash),
    })
    const res = NextResponse.json({
      success: true,
      data: {
        user: { id: matched.id, name: matched.name, email: matched.email, role: matched.role, companyId: matched.companyId },
        company,
      },
      message: '',
    })
    res.headers.append('Set-Cookie', sessionCookie(token))
    return res
  } catch (e) {
    return handleError(e)
  }
}
