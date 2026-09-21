import { db } from '@/lib/db'
import { ApiError, companyRequired, getActor, handleError, ok } from '@/lib/erp-helpers'

// GET /api/notifications?companyId=&status=all|unread|read (&unread=1 legacy) &q=&take=
// → { items, unreadCount } (createdAt desc, take default 50 · cap 200; unreadCount always = unread total for the company).
// q is a case-insensitive contains on title/message, filtered JS-side (SQLite has no case-insensitive contains).
export async function GET(req: Request) {
  try {
    const companyId = await companyRequired(req)
    const { searchParams } = new URL(req.url)
    const statusParam = (searchParams.get('status') || '').toLowerCase()
    const status = statusParam === 'unread' || statusParam === 'read'
      ? statusParam
      : searchParams.get('unread') === '1' ? 'unread' : 'all' // legacy unread=1 still honored
    const q = (searchParams.get('q') || '').trim().toLowerCase()
    const parsed = Number.parseInt(searchParams.get('take') || '', 10)
    const take = Math.min(Number.isFinite(parsed) && parsed > 0 ? parsed : 50, 200)

    const unreadCount = await db.notification.count({ where: { companyId, read: false } })
    const rows = await db.notification.findMany({
      where: { companyId, ...(status === 'all' ? {} : { read: status === 'read' }) },
      orderBy: { createdAt: 'desc' },
      // when searching, fetch a broader window first, then filter in JS and slice
      take: q ? 1000 : take,
    })
    const items = q
      ? rows
          .filter((r) => [r.title, r.message].some((v) => !!v && v.toLowerCase().includes(q)))
          .slice(0, take)
      : rows
    return ok({ items, unreadCount })
  } catch (e) {
    return handleError(e)
  }
}

// PATCH /api/notifications { companyId, all: true } → mark all as read
export async function PATCH(req: Request) {
  try {
    if (!getActor(req)) throw new ApiError('Unauthorized — sign in to continue', 401)
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
