import { db } from '@/lib/db'
import { companyRequired, handleError, ok } from '@/lib/erp-helpers'

// GET /api/audit-logs?companyId=&limit= → { items } (createdAt desc, limit ≤ 300, default 200)
export async function GET(req: Request) {
  try {
    const companyId = await companyRequired(req)
    const { searchParams } = new URL(req.url)
    const parsed = Number.parseInt(searchParams.get('limit') || '', 10)
    const limit = Math.min(Number.isFinite(parsed) && parsed > 0 ? parsed : 200, 300)
    const items = await db.auditLog.findMany({
      where: { companyId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    })
    return ok({ items })
  } catch (e) {
    return handleError(e)
  }
}
