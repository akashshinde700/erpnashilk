import { db } from '@/lib/db'
import { companyRequired, handleError, ok, requireWrite } from '@/lib/erp-helpers'
import { IMPORT_HISTORY_ENTITY } from '@/lib/import/fields'

// GET /api/import-center/history?page= → { items, total } — this company's IMPORT entries from the
// audit log (Import Center and the older CSV dialogs), newest first, 50 per page.
export async function GET(req: Request) {
  try {
    requireWrite(req, 'import-center')
    const companyId = await companyRequired(req)
    const page = Math.max(1, Number.parseInt(new URL(req.url).searchParams.get('page') || '', 10) || 1)
    const where = { companyId, action: 'IMPORT', entity: { in: Object.values(IMPORT_HISTORY_ENTITY) } }
    const [items, total] = await Promise.all([
      db.auditLog.findMany({
        where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * 50, take: 50,
        select: { id: true, createdAt: true, userName: true, entity: true, details: true },
      }),
      db.auditLog.count({ where }),
    ])
    return ok({ items, total })
  } catch (e) {
    return handleError(e)
  }
}
