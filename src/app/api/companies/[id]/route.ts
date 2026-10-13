import { db } from '@/lib/db'
import { requireWrite, ApiError, fail, handleError, logAudit, ok, sessionUser, PLATFORM_ROLE, assertFirmAccess } from '@/lib/erp-helpers'

type Ctx = { params: Promise<{ id: string }> }

const EDITABLE = ['name', 'gstin', 'pan', 'addressLine', 'city', 'state', 'stateCode', 'phone', 'email', 'logoText'] as const

const clean = (v: unknown): string | null => {
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  return s === '' ? null : s
}

/** Home company, a linked firm of this login, or any company for the platform SUPER_ADMIN. */
async function assertCompanyAccess(req: Request, id: string) {
  const me = await sessionUser(req)
  if (!(await assertFirmAccess(req, id))) throw new ApiError('Company not found', 404)
  return me
}

// GET /api/companies/[id] — single tenant with counts (users, items, warehouses)
export async function GET(req: Request, { params }: Ctx) {
  try {
    const { id } = await params
    await assertCompanyAccess(req, id)
    const company = await db.company.findUnique({
      where: { id },
      include: { _count: { select: { users: true, items: true, warehouses: true } } },
    })
    if (!company) throw new ApiError('Company not found', 404)
    const { _count, ...rest } = company
    return ok({ ...rest, userCount: _count.users, itemCount: _count.items, warehouseCount: _count.warehouses })
  } catch (e) {
    return handleError(e)
  }
}

// PATCH /api/companies/[id] — tenant admin profile update (no companyId needed — id IS the tenant)
export async function PATCH(req: Request, { params }: Ctx) {
  try {
    requireWrite(req, 'companies')
    const { id } = await params
    await assertCompanyAccess(req, id)
    const body = await req.json().catch(() => ({}))
    const existing = await db.company.findUnique({ where: { id }, select: { id: true } })
    if (!existing) throw new ApiError('Company not found', 404)

    const data: Record<string, string | null> = {}
    for (const f of EDITABLE) {
      if (f in body) {
        const s = clean(body[f])
        data[f] = s === '' && f !== 'name' ? null : s
      }
    }
    if ('name' in data && !data.name) throw new ApiError('Company name cannot be empty', 400)
    if ('gstin' in data && data.gstin && data.gstin.length !== 15) throw new ApiError('Invalid GSTIN', 400)
    if (Object.keys(data).length === 0) throw new ApiError('No editable fields provided', 400)
    if (data.gstin) data.gstin = data.gstin.toUpperCase()

    const company = await db.$transaction(async (tx) => {
      const updated = await tx.company.update({ where: { id }, data: data as { name: string } })
      await logAudit(tx as never, {
        companyId: id,
        userName: typeof body?.userName === 'string' && body.userName.trim() ? body.userName.trim() : 'system',
        action: 'CONFIG',
        entity: 'COMPANY',
        entityId: id,
        details: 'Company profile updated',
      })
      return updated
    })

    return ok(company, 'Company profile updated')
  } catch (e) {
    return handleError(e)
  }
}

// DELETE — tenant deletion is intentionally disabled in the demo build
export async function DELETE() {
  return fail('Tenant deletion is disabled in demo build', 403)
}
