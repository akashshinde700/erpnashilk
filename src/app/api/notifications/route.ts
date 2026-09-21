import { db } from '@/lib/db'
import { ApiError, companyRequired, handleError, ok } from '@/lib/erp-helpers'

// GET /api/notifications?companyId=&unread=1 → { items, unreadCount } (createdAt desc, latest 30)
export async function GET(req: Request) {
  try {
    const companyId = await companyRequired(req)
    const { searchParams } = new URL(req.url)
    const unreadOnly = searchParams.get('unread') === '1'
    const unreadCount = await db.notification.count({ where: { companyId, read: false } })
    const items = await db.notification.findMany({
      where: { companyId, ...(unreadOnly ? { read: false } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 30,
    })
    return ok({ items, unreadCount })
  } catch (e) {
    return handleError(e)
  }
}

// PATCH /api/notifications { companyId, all: true } → mark all as read
export async function PATCH(req: Request) {
  try {
    const body = await req.json().catch(() => ({}))
    const companyId = await companyRequired(req, body?.companyId)
    if (!body?.all) throw new ApiError('Send { all: true } to mark all notifications as read', 400)
    const res = await db.notification.updateMany({
      where: { companyId, read: false },
      data: { read: true },
    })
    return ok({ count: res.count }, 'All notifications marked as read')
  } catch (e) {
    return handleError(e)
  }
}
