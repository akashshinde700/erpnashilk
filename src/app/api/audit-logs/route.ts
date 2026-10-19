import { db } from '@/lib/db'
import { companyRequired, handleError, ok } from '@/lib/erp-helpers'

// GET /api/audit-logs?companyId=&limit=&page=&pageSize=&q= → { items, total } (createdAt desc)
// - q: plain `contains` across action, entity, entityId, details, userName.
// - page (1-based) + pageSize: skip/take slice; pageSize wins over the legacy
//   `limit` alias (pageSize || limit || 200), both capped at 300, default 200.
// - No page → backward-compatible "latest pageSize rows" behavior (total still
//   included — cheap count, additive field).
export async function GET(req: Request) {
  try {
    const companyId = await companyRequired(req)
    const { searchParams } = new URL(req.url)
    const q = (searchParams.get('q') || '').trim()
    const where = {
      companyId,
      ...(q
        ? {
            OR: [
              { action: { contains: q } },
              { entity: { contains: q } },
              { entityId: { contains: q } },
              { details: { contains: q } },
              { userName: { contains: q } },
            ],
          }
        : {}),
    }
    const page = Math.max(0, Number.parseInt(searchParams.get('page') || '', 10) || 0)
    const pageSizeParam = Number.parseInt(searchParams.get('pageSize') || '', 10)
    const limitParam = Number.parseInt(searchParams.get('limit') || '', 10)
    const pageSize = Math.min(pageSizeParam > 0 ? pageSizeParam : limitParam > 0 ? limitParam : 200, 300)
    const [items, total] = await Promise.all([
      db.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        ...(page >= 1 ? { skip: (page - 1) * pageSize, take: pageSize } : { take: pageSize }),
      }),
      db.auditLog.count({ where }),
    ])
    return ok({ items, total })
  } catch (e) {
    return handleError(e)
  }
}
