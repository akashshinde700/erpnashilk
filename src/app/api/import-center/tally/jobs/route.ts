import { companyRequired, handleError, ok, requireWrite } from '@/lib/erp-helpers'
import { assertConnectorEnabled, markWatching } from '@/lib/tally/connector'
import { EXPORT_JOB, cancelJob, createJob, getJobFor, jobView } from '@/lib/tally/jobs'

// Reading from Tally is allowed to whoever may import that kind of data (company list: Import Center access).
function requireJobAccess(req: Request, type: unknown) {
  const actor = requireWrite(req, 'import-center')
  for (const [module, job] of Object.entries(EXPORT_JOB)) if (job === type) requireWrite(req, module)
  return actor
}

// GET /api/import-center/tally/jobs?id= → JobView (status; for a company list also the companies)
export async function GET(req: Request) {
  try {
    requireWrite(req, 'import-center')
    const companyId = await companyRequired(req)
    assertConnectorEnabled()
    markWatching(companyId)
    return ok(jobView(await getJobFor(companyId, new URL(req.url).searchParams.get('id'))))
  } catch (e) {
    return handleError(e)
  }
}

// POST /api/import-center/tally/jobs { type, tallyCompany? } → JobView (queued; the connector picks it up)
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
    const actor = requireJobAccess(req, body.type)
    const companyId = await companyRequired(req, typeof body.companyId === 'string' ? body.companyId : undefined)
    assertConnectorEnabled()
    markWatching(companyId)
    return ok(await createJob(companyId, actor.userId, body.type, body.tallyCompany))
  } catch (e) {
    return handleError(e)
  }
}

// DELETE /api/import-center/tally/jobs?id= → cancels a waiting / running request (its result is then ignored)
export async function DELETE(req: Request) {
  try {
    requireWrite(req, 'import-center')
    const companyId = await companyRequired(req)
    assertConnectorEnabled()
    return ok(await cancelJob(companyId, new URL(req.url).searchParams.get('id')))
  } catch (e) {
    return handleError(e)
  }
}
