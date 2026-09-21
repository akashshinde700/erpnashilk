import { db } from '@/lib/db'
import { ok, handleError } from '@/lib/erp-helpers'

// GET /api/companies — list all tenants (no companyId filter; used by the tenant switcher)
export async function GET() {
  try {
    const companies = await db.company.findMany({
      orderBy: { name: 'asc' },
      select: { id: true, name: true, gstin: true, city: true, state: true, stateCode: true, logoText: true },
    })
    return ok({ companies })
  } catch (e) {
    return handleError(e)
  }
}
