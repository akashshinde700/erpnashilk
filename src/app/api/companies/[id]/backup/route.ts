import { db } from '@/lib/db'
import { tenantSnapshot } from '@/lib/backup-plan'
import { ApiError, companyRequired, fail, handleError, logAudit, sessionUser } from '@/lib/erp-helpers'

type Ctx = { params: Promise<{ id: string }> }

// GET /api/companies/[id]/backup?companyId= — full tenant data backup (raw JSON download).
// Sensitive read: admin-only (TENANT_ADMIN / MANAGEMENT / SUPER_ADMIN), the :id path
// param must match the resolved ?companyId= tenant, and the response is streamed as an
// attachment (content-disposition) instead of the standard ok() envelope.
export async function GET(req: Request, { params }: Ctx) {
  try {
    // (a) signed-in user, re-checked against the DB
    const actor = await sessionUser(req)

    // (b) admin-only export
    if (!['TENANT_ADMIN', 'MANAGEMENT', 'SUPER_ADMIN'].includes(actor.role)) {
      throw new ApiError('Only administrators can download backups', 403)
    }

    // (c) the tenant must be one this user may access (own company, or any for SUPER_ADMIN)…
    const { id } = await params
    const companyId = await companyRequired(req, id)

    // (d) …and match the :id path param (no cross-tenant exports)
    if (companyId !== id) throw new ApiError('Company mismatch', 403)

    const company = await db.company.findUnique({ where: { id } })
    if (!company) throw new ApiError('Company not found', 404)

    // Every tenant table and its document lines, derived from the schema (src/lib/backup-plan.ts)
    const payload = await tenantSnapshot(db, id)

    // Best-effort audit trail — never block the download.
    try {
      await logAudit(db as never, {
        companyId: id,
        userName: actor.name,
        action: 'EXPORT',
        entity: 'COMPANY',
        entityId: id,
        details: 'Data backup downloaded',
      })
    } catch { /* best-effort */ }

    const now = new Date()
    const ymd = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`

    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'content-disposition': `attachment; filename="manuflow-backup-${id}-${ymd}.json"`,
      },
    })
  } catch (e) {
    return handleError(e)
  }
}

// Other methods are not part of the backup contract.
export async function POST() {
  return fail('Backup export is read-only — use GET', 405)
}
