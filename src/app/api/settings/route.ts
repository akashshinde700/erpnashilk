import { db } from '@/lib/db'
import { ApiError, companyRequired, handleError, logAudit, ok } from '@/lib/erp-helpers'

const EDITABLE = ['name', 'gstin', 'pan', 'addressLine', 'city', 'state', 'stateCode', 'phone', 'email', 'logoText'] as const
type EditableField = (typeof EDITABLE)[number]

const PROFILE_SELECT = {
  id: true,
  name: true,
  gstin: true,
  pan: true,
  addressLine: true,
  city: true,
  state: true,
  stateCode: true,
  phone: true,
  email: true,
  logoText: true,
} as const

// GET /api/settings?companyId= → company profile (singleton for tenant)
export async function GET(req: Request) {
  try {
    const companyId = await companyRequired(req)
    const company = await db.company.findUnique({ where: { id: companyId }, select: PROFILE_SELECT })
    if (!company) throw new ApiError('Company not found', 404)
    return ok(company)
  } catch (e) {
    return handleError(e)
  }
}

// PATCH /api/settings { companyId, ...editable fields, userName? } → update profile + CONFIG audit
export async function PATCH(req: Request) {
  try {
    const body = await req.json().catch(() => ({}))
    const companyId = await companyRequired(req, body?.companyId)

    const data: Record<string, string | null> = {}
    for (const f of EDITABLE) {
      if (f in body) {
        const s = body[f] === null || body[f] === undefined ? null : String(body[f]).trim()
        data[f] = s === '' && f !== 'name' ? null : s
      }
    }
    if ('name' in data && !data.name) throw new ApiError('Company name cannot be empty', 400)
    if (Object.keys(data).length === 0) throw new ApiError('No editable fields provided', 400)

    const company = await db.$transaction(async (tx) => {
      const updated = await tx.company.update({ where: { id: companyId }, data: data as { name: string }, select: PROFILE_SELECT })
      await logAudit(tx as never, {
        companyId,
        userName: body?.userName,
        action: 'CONFIG',
        entity: 'COMPANY',
        entityId: companyId,
        details: 'Company profile updated',
      })
      return updated
    })
    return ok(company, 'Company profile updated')
  } catch (e) {
    return handleError(e)
  }
}
