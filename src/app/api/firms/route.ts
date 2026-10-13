import { db } from '@/lib/db'
import { ApiError, handleError, linkedFirmIds, logAudit, ok, requireWrite, sessionUser } from '@/lib/erp-helpers'
import { slugify } from '@/lib/subscription'

/** Most firms (home + created/linked) one login may hold. */
const MAX_FIRMS = 10

const clean = (v: unknown, max = 191): string | null => {
  if (v === null || v === undefined) return null
  const s = String(v).trim().slice(0, max)
  return s === '' ? null : s
}

// GET /api/firms → firms the signed-in user can open: the home company plus linked firms.
// Row: { id, name, gstin, city, stateCode, logoText, isHome }
export async function GET(req: Request) {
  try {
    const me = await sessionUser(req)
    const ids = [me.companyId, ...(await linkedFirmIds(req))]
    const firms = await db.company.findMany({
      where: { id: { in: ids } },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, gstin: true, city: true, stateCode: true, logoText: true },
    })
    return ok({
      items: firms
        .map((f) => ({ ...f, isHome: f.id === me.companyId }))
        .sort((a, b) => Number(b.isHome) - Number(a.isHome)),
      max: MAX_FIRMS,
    })
  } catch (e) {
    return handleError(e)
  }
}

// POST /api/firms { name, gstin?, state?, stateCode?, city?, phone?, email? }
// TENANT_ADMIN only: creates another firm (company) on the same subscription as the
// caller's home company, with default warehouses, and links it to the caller.
export async function POST(req: Request) {
  try {
    requireWrite(req, 'companies')
    const me = await sessionUser(req)
    if (me.role !== 'TENANT_ADMIN') throw new ApiError('Only a tenant administrator can create a new firm', 403)

    const body = await req.json().catch(() => ({}))
    const name = clean(body?.name)
    if (!name) throw new ApiError('Firm name is required', 400)
    const gstin = clean(body?.gstin)?.toUpperCase() || null
    if (gstin && !/^[0-9A-Z]{15}$/.test(gstin)) throw new ApiError('GSTIN must be 15 letters/digits', 400)
    const stateCode = clean(body?.stateCode)
    if (stateCode && !/^\d{2}$/.test(stateCode)) throw new ApiError('State code must be 2 digits (e.g. 27)', 400)
    const email = clean(body?.email)?.toLowerCase() || null
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ApiError('Invalid email', 400)

    const home = await db.company.findUnique({
      where: { id: me.companyId },
      select: {
        isPlatform: true, planId: true, status: true, billingCycle: true, paidUntil: true, trialEndsAt: true,
        maxUsers: true, maxWarehouses: true, maxItems: true,
      },
    })
    if (!home || home.isPlatform) throw new ApiError('Firms can only be created from a customer organization', 403)

    const linked = await linkedFirmIds(req)
    if (linked.size + 1 >= MAX_FIRMS) throw new ApiError(`You can have at most ${MAX_FIRMS} firms per login`, 403)

    // Duplicate name guard within this login's own firms (case-insensitive under MySQL collation)
    if (await db.company.findFirst({ where: { name, id: { in: [me.companyId, ...linked] } }, select: { id: true } })) {
      throw new ApiError('You already have a firm with this name', 409)
    }

    let slug = slugify(name)
    if (await db.company.findUnique({ where: { slug }, select: { id: true } })) slug = `${slug}-${Date.now().toString(36).slice(-5)}`

    const firm = await db.$transaction(async (tx) => {
      // Re-count inside the transaction so parallel requests can't overshoot the cap by much.
      const count = await tx.userCompanyAccess.count({ where: { userId: me.id, companyId: { not: me.companyId } } })
      if (count + 1 >= MAX_FIRMS) throw new ApiError(`You can have at most ${MAX_FIRMS} firms per login`, 403)

      const created = await tx.company.create({
        data: {
          name, slug, gstin,
          city: clean(body?.city), state: clean(body?.state), stateCode,
          phone: clean(body?.phone, 30), email,
          logoText: name.slice(0, 2).toUpperCase(),
          // Same subscription as the creator's home organization
          isPlatform: false,
          planId: home.planId, status: home.status, billingCycle: home.billingCycle,
          paidUntil: home.paidUntil, trialEndsAt: home.trialEndsAt,
          maxUsers: home.maxUsers, maxWarehouses: home.maxWarehouses, maxItems: home.maxItems,
        },
        select: { id: true, name: true, gstin: true, city: true, stateCode: true, logoText: true },
      })
      await tx.warehouse.createMany({
        data: [
          { companyId: created.id, code: 'WH-RM', name: 'Raw Material Store', type: 'RM', location: created.city },
          { companyId: created.id, code: 'WH-FG', name: 'Finished Goods Store', type: 'FG', location: created.city },
          { companyId: created.id, code: 'WH-GEN', name: 'General Store', type: 'GENERAL', location: created.city },
        ],
      })
      await tx.userCompanyAccess.create({ data: { userId: me.id, companyId: created.id } })
      await logAudit(tx as never, {
        companyId: created.id, userName: me.name, action: 'CONFIG', entity: 'COMPANY', entityId: created.id,
        details: `Firm created by ${me.name} (${me.email}) from organization ${me.companyId}`,
      })
      return created
    })

    return ok({ ...firm, isHome: false }, 'Firm created')
  } catch (e) {
    return handleError(e)
  }
}
