import { db } from '@/lib/db'
import { handleError, logAudit, ok } from '@/lib/erp-helpers'

// POST /api/auth/logout { userName?, companyId? } → ok({ success: true })
// Audit row is best-effort and never blocks the sign-out.
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}))
    if (body?.userName && body?.companyId) {
      try {
        await logAudit(db as never, {
          companyId: String(body.companyId),
          userName: String(body.userName),
          action: 'LOGOUT',
          entity: 'USER',
          details: 'Signed out',
        })
      } catch {
        // ignore audit failures — logout must always succeed
      }
    }
    return ok({ success: true })
  } catch (e) {
    return handleError(e)
  }
}
