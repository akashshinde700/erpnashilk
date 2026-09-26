import { db } from '@/lib/db'
import { requireWrite, ok, handleError, companyRequired, ApiError, logAudit, USER_PUBLIC } from '@/lib/erp-helpers'
import { ROLES } from '@/lib/erp-constants'
import { hashPassword, passwordProblem } from '@/lib/password'

// ============================== GET /api/users?q=&role=&active= ==============================
export async function GET(req: Request) {
  try {
    const companyId = await companyRequired(req)
    const { searchParams } = new URL(req.url)
    const q = (searchParams.get('q') || '').trim()
    const role = searchParams.get('role') || ''
    const active = searchParams.get('active') || ''
    const where = {
      companyId,
      ...(q ? { OR: [{ name: { contains: q } }, { email: { contains: q } }] } : {}),
      ...(role ? { role } : {}),
      ...(active === 'true' ? { active: true } : active === 'false' ? { active: false } : {}),
    }
    const [items, total] = await Promise.all([
      db.user.findMany({ where, orderBy: { name: 'asc' }, select: USER_PUBLIC }),
      db.user.count({ where }),
    ])
    return ok({ items, total })
  } catch (e) {
    return handleError(e)
  }
}

// ============================== POST /api/users { name, email, role, password, phone?, active? } ==============================
export async function POST(req: Request) {
  try {
    requireWrite(req, 'users')
    const body = await req.json().catch(() => ({}))
    const companyId = await companyRequired(req, body.companyId)
    const name = String(body.name || '').trim()
    const email = String(body.email || '').trim().toLowerCase()
    if (!name || !email) throw new ApiError('name and email are required', 400)
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ApiError('Enter a valid email address', 400)
    const role = String(body.role || 'VIEWER')
    if (!(ROLES as readonly string[]).includes(role)) {
      throw new ApiError('Invalid role', 400)
    }
    const problem = passwordProblem(body.password)
    if (problem) throw new ApiError(problem, 400)
    // unique email per company — friendly message before hitting the constraint
    const dup = await db.user.findFirst({ where: { companyId, email } })
    if (dup) throw new ApiError('A user with this email already exists', 409)

    const user = await db.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          companyId,
          name,
          email,
          role,
          passwordHash: hashPassword(String(body.password)),
          phone: body.phone || null,
          active: body.active === undefined ? true : !!body.active,
        },
        select: USER_PUBLIC,
      })
      await logAudit(tx as any, {
        companyId,
        action: 'CREATE',
        entity: 'User',
        entityId: created.id,
        details: `${name} <${email}> (${role})`,
      })
      return created
    })
    return ok(user, 'User created')
  } catch (e) {
    return handleError(e)
  }
}
