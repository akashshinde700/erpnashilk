import { db } from '@/lib/db'
import { requireWrite, ApiError, handleError, logAudit, ok, sessionUser, PLATFORM_ROLE } from '@/lib/erp-helpers'
import { hashPassword, passwordProblem } from '@/lib/password'

const clean = (v: unknown): string | null => {
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  return s === '' ? null : s
}

// GET /api/companies — tenants visible to the caller: every tenant for the platform
// SUPER_ADMIN, otherwise only the caller's own company.
// Row shape: scalars + phone, email, createdAt, userCount, itemCount.
export async function GET(req: Request) {
  try {
    const me = await sessionUser(req)
    const companies = await db.company.findMany({
      where: me.role === PLATFORM_ROLE ? {} : { id: me.companyId },
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        gstin: true,
        pan: true,
        addressLine: true,
        city: true,
        state: true,
        stateCode: true,
        logoText: true,
        phone: true,
        email: true,
        createdAt: true,
        _count: { select: { users: true, items: true } },
      },
    })
    return ok({
      companies: companies.map((c) => ({
        id: c.id,
        name: c.name,
        gstin: c.gstin,
        pan: c.pan,
        addressLine: c.addressLine,
        city: c.city,
        state: c.state,
        stateCode: c.stateCode,
        logoText: c.logoText,
        phone: c.phone,
        email: c.email,
        createdAt: c.createdAt,
        userCount: c._count.users,
        itemCount: c._count.items,
      })),
    })
  } catch (e) {
    return handleError(e)
  }
}

// POST /api/companies — create a tenant (company + 3 default warehouses + optional TENANT_ADMIN user).
// Platform SUPER_ADMIN only.
export async function POST(req: Request) {
  try {
    requireWrite(req, 'companies')
    const me = await sessionUser(req)
    if (me.role !== PLATFORM_ROLE) throw new ApiError('Only the platform administrator can create companies', 403)
    const body = await req.json().catch(() => ({}))
    const name = clean(body?.name)
    if (!name) throw new ApiError('Company name is required', 400)

    const gstin = clean(body?.gstin)
    if (gstin && gstin.length !== 15) throw new ApiError('Invalid GSTIN', 400)

    // Duplicate name guard (MySQL's default collation compares case-insensitively)
    if (await db.company.findFirst({ where: { name }, select: { id: true } })) {
      throw new ApiError('Company with this name already exists', 409)
    }

    const adminEmail = clean(body?.adminEmail)?.toLowerCase() || null
    const adminName = clean(body?.adminName) || 'Admin'
    const adminPassword = typeof body?.adminPassword === 'string' ? body.adminPassword : ''
    if (adminEmail) {
      const problem = passwordProblem(adminPassword)
      if (problem) throw new ApiError(`Admin ${problem.charAt(0).toLowerCase()}${problem.slice(1)}`, 400)
    }

    const company = await db.$transaction(async (tx) => {
      const created = await tx.company.create({
        data: {
          name,
          gstin: gstin ? gstin.toUpperCase() : null,
          pan: clean(body?.pan),
          addressLine: clean(body?.addressLine),
          city: clean(body?.city),
          state: clean(body?.state),
          stateCode: clean(body?.stateCode),
          phone: clean(body?.phone),
          email: clean(body?.email),
          logoText: clean(body?.logoText) || name.slice(0, 2).toUpperCase(),
        },
      })

      // Default warehouse set for a new tenant
      await tx.warehouse.createMany({
        data: [
          { companyId: created.id, code: 'WH-RM', name: 'Raw Material Store', type: 'RM', location: created.city },
          { companyId: created.id, code: 'WH-FG', name: 'Finished Goods Store', type: 'FG', location: created.city },
          { companyId: created.id, code: 'WH-GEN', name: 'General Store', type: 'GENERAL', location: created.city },
        ],
      })

      // Optional tenant admin (skipped silently when email not provided)
      if (adminEmail) {
        await tx.user.create({
          data: {
            companyId: created.id,
            name: adminName,
            email: adminEmail,
            role: 'TENANT_ADMIN',
            passwordHash: hashPassword(adminPassword),
            active: true,
          },
        })
      }

      await logAudit(tx as never, {
        companyId: created.id,
        userName: adminName,
        action: 'CONFIG',
        entity: 'COMPANY',
        entityId: created.id,
        details: 'Tenant created',
      })

      return created
    })

    return ok(company, 'Tenant created')
  } catch (e) {
    return handleError(e)
  }
}
