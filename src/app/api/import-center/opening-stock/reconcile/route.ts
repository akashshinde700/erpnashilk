import { db } from '@/lib/db'
import { ApiError, companyRequired, handleError, ok, requireWrite } from '@/lib/erp-helpers'
import { OPENING_IMPORT_PREFIX } from '@/lib/go-live'
import { reconcileOpeningStock } from '@/lib/services/opening-stock-import'

// GET /api/import-center/opening-stock/reconcile?ref=OSI-… → { reconciliation, history }
// What an opening-stock import actually posted (read back from the stock ledger by its reference),
// with the import's history entry, which carries the source totals of the file. Read-only.
export async function GET(req: Request) {
  try {
    requireWrite(req, 'import-center')
    const companyId = await companyRequired(req)
    const ref = (new URL(req.url).searchParams.get('ref') || '').trim()
    if (!ref.startsWith(OPENING_IMPORT_PREFIX) || ref.length > 40) throw new ApiError('ref must be an opening-stock import reference', 400)
    const [reconciliation, history] = await Promise.all([
      reconcileOpeningStock(companyId, ref),
      db.auditLog.findFirst({ where: { companyId, action: 'IMPORT', entity: 'OPENING_STOCK', entityId: ref }, select: { createdAt: true, userName: true, details: true } }),
    ])
    if (!reconciliation.lines.length && !history) throw new ApiError('No opening-stock import with this reference', 404)
    return ok({ reconciliation, history })
  } catch (e) {
    return handleError(e)
  }
}
