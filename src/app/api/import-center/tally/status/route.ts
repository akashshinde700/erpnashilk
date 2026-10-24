import { companyRequired, handleError, ok, requireWrite } from '@/lib/erp-helpers'
import { checkTally, tallyEndpoint, type TallyCheck } from '@/lib/tally/client'

// Last check per company for a few seconds, so repeated clicks don't hammer the Tally PC.
const recent = new Map<string, TallyCheck>()
const REUSE_MS = 3000

// GET /api/import-center/tally/status → TallyCheck
// The Tally address comes only from the server's TALLY_HTTP_URL setting (never from the request).
export async function GET(req: Request) {
  try {
    requireWrite(req, 'import-center')
    const companyId = await companyRequired(req)
    const cfg = tallyEndpoint()
    if (!cfg) {
      const r: TallyCheck = {
        status: 'not_configured',
        message: 'No Tally connection is set up for this ManuFlow server. TallyPrime runs on your own PC, so a cloud-hosted ManuFlow cannot reach it directly — a local connector is needed (see the setup notes).',
        checkedAt: new Date().toISOString(),
      }
      return ok(r)
    }
    if ('error' in cfg) return ok(cfg.error)
    const last = recent.get(companyId)
    if (last && last.endpoint === cfg.endpoint && Date.now() - Date.parse(last.checkedAt) < REUSE_MS) return ok(last)
    const result = await checkTally(cfg.url, cfg.endpoint)
    recent.set(companyId, result)
    return ok(result)
  } catch (e) {
    return handleError(e)
  }
}
