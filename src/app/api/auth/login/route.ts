import { db } from '@/lib/db'
import { fail, handleError, logAudit, ok } from '@/lib/erp-helpers'
import { verifyPassword } from '@/lib/password'

// POST /api/auth/login { email, password }
// → ok({ user: { id, name, email, role, companyId }, company: { id, name, gstin, city, stateCode, logoText } })
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}))
    const email = typeof body?.email === 'string' ? body.email.trim() : ''
    const password = typeof body?.password === 'string' ? body.password : ''
    if (!email || !password) return fail('Email and password are required', 400)

    // SQLite has no case-insensitive `mode` — exact match first (fast path), then a
    // JS-side lowercase match over the (small) user table as fallback.
    const USER_FIELDS = {
      id: true, name: true, email: true, role: true, companyId: true, active: true, passwordHash: true,
    } as const
    let candidates = await db.user.findMany({ where: { email }, select: USER_FIELDS })
    if (candidates.length === 0) {
      const lower = email.toLowerCase()
      const all = await db.user.findMany({ select: USER_FIELDS })
      candidates = all.filter((u) => u.email.toLowerCase() === lower)
    }

    const matched = candidates.find((u) => verifyPassword(password, u.passwordHash))
    if (!matched) return fail('Invalid email or password', 401)
    if (!matched.active) return fail('Account is inactive', 403)

    const company = await db.company.findUnique({
      where: { id: matched.companyId },
      select: { id: true, name: true, gstin: true, city: true, stateCode: true, logoText: true },
    })
    if (!company) return fail('Invalid email or password', 401)

    await logAudit(db as never, {
      companyId: company.id,
      userName: matched.name,
      action: 'LOGIN',
      entity: 'USER',
      entityId: matched.id,
      details: 'Signed in',
    })

    return ok({
      user: { id: matched.id, name: matched.name, email: matched.email, role: matched.role, companyId: matched.companyId },
      company,
    })
  } catch (e) {
    return handleError(e)
  }
}
