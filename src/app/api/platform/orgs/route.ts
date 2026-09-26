import { db } from '@/lib/db'
import { ApiError, handleError, logAudit, ok, requirePlatformAdmin } from '@/lib/erp-helpers'
import { hashPassword, passwordProblem } from '@/lib/password'
import { ORG_INCLUDE, orgRow } from '@/lib/platform'
import { generatePassword, slugify } from '@/lib/subscription'

const clean = (v: unknown): string | null => {
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  return s === '' ? null : s
}

// GET /api/platform/orgs — every customer organization with plan, usage and subscription state.
export async function GET(req: Request) {
  try {
    await requirePlatformAdmin(req)
    const orgs = await db.company.findMany({
      where: { isPlatform: false },
      orderBy: { createdAt: 'desc' },
      include: ORG_INCLUDE,
    })
    return ok({ items: orgs.map(orgRow) })
  } catch (e) {
    return handleError(e)
  }
}

// POST /api/platform/orgs
// { name, adminName, adminEmail, password?, planId?, billingCycle?, trialDays?, gstin?, city?, state?, stateCode?, phone? }
// → { org, password } — the admin password is returned once and never stored in plain text.
export async function POST(req: Request) {
  try {
    const me = await requirePlatformAdmin(req)
    const body = await req.json().catch(() => ({}))
    const name = clean(body.name)
    if (!name) throw new ApiError('Company name is required', 400)
    const adminEmail = clean(body.adminEmail)?.toLowerCase()
    if (!adminEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail)) throw new ApiError('A valid admin email is required', 400)
    const adminName = clean(body.adminName) || 'Admin'
    const gstin = clean(body.gstin)?.toUpperCase() || null
    if (gstin && gstin.length !== 15) throw new ApiError('GSTIN must be 15 characters', 400)
    const password = clean(body.password) || generatePassword()
    const problem = passwordProblem(password)
    if (problem) throw new ApiError(problem, 400)
    const billingCycle = body.billingCycle === 'YEARLY' ? 'YEARLY' : 'MONTHLY'
    const trialDays = Math.max(0, Math.min(365, Math.round(Number(body.trialDays ?? 14)) || 0))
    const planId = clean(body.planId)
    if (planId && !(await db.plan.findUnique({ where: { id: planId }, select: { id: true } }))) throw new ApiError('Plan not found', 400)

    if (await db.company.findFirst({ where: { name }, select: { id: true } })) throw new ApiError('A company with this name already exists', 409)
    // Login is by email alone, so an email may belong to only one organization.
    if (await db.user.findFirst({ where: { email: adminEmail }, select: { id: true } })) {
      throw new ApiError('This email is already used by another login', 409)
    }

    let slug = slugify(name)
    if (await db.company.findUnique({ where: { slug }, select: { id: true } })) slug = `${slug}-${Date.now().toString(36).slice(-4)}`
    const trialEndsAt = trialDays ? new Date(Date.now() + trialDays * 86400000) : null

    const org = await db.$transaction(async (tx) => {
      const created = await tx.company.create({
        data: {
          name, slug, gstin, planId, billingCycle, trialEndsAt,
          city: clean(body.city), state: clean(body.state), stateCode: clean(body.stateCode),
          phone: clean(body.phone), email: adminEmail, logoText: name.slice(0, 2).toUpperCase(),
        },
      })
      await tx.warehouse.createMany({
        data: [
          { companyId: created.id, code: 'WH-RM', name: 'Raw Material Store', type: 'RM', location: created.city },
          { companyId: created.id, code: 'WH-FG', name: 'Finished Goods Store', type: 'FG', location: created.city },
          { companyId: created.id, code: 'WH-GEN', name: 'General Store', type: 'GENERAL', location: created.city },
        ],
      })
      await tx.user.create({
        data: { companyId: created.id, name: adminName, email: adminEmail, role: 'TENANT_ADMIN', passwordHash: hashPassword(password) },
      })
      await logAudit(tx as never, {
        companyId: created.id, userName: me.name, action: 'CONFIG', entity: 'COMPANY', entityId: created.id,
        details: `Organization created by platform admin${trialDays ? ` with ${trialDays}-day trial` : ''}`,
      })
      return tx.company.findUniqueOrThrow({ where: { id: created.id }, include: ORG_INCLUDE })
    })
    return ok({ org: orgRow(org), password }, 'Organization created')
  } catch (e) {
    return handleError(e)
  }
}
