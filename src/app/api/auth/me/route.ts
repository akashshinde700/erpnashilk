import { db } from '@/lib/db'
import { ApiError, handleError, ok, sessionUser } from '@/lib/erp-helpers'

// GET /api/auth/me → the signed-in user + home company (same shape as login).
// The client calls this on boot to confirm the stored session is still valid.
export async function GET(req: Request) {
  try {
    const user = await sessionUser(req)
    const company = await db.company.findUnique({
      where: { id: user.companyId },
      select: { id: true, name: true, gstin: true, city: true, stateCode: true, logoText: true },
    })
    if (!company) throw new ApiError('Your session has ended — sign in again', 401)
    return ok({ user, company })
  } catch (e) {
    return handleError(e)
  }
}
