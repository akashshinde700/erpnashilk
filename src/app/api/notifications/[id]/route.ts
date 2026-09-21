import { db } from '@/lib/db'
import { ApiError, companyRequired, getActor, handleError, ok } from '@/lib/erp-helpers'

type Params = { params: Promise<{ id: string }> }

// PATCH /api/notifications/[id] { companyId, read?: boolean } → mark read (default) / unread
export async function PATCH(req: Request, { params }: Params) {
  try {
    if (!getActor(req)) throw new ApiError('Unauthorized — sign in to continue', 401)
    const { id } = await params
    const body = await req.json().catch(() => ({}))
    const companyId = await companyRequired(req, body?.companyId)

    const existing = await db.notification.findFirst({ where: { id, companyId } })
    if (!existing) throw new ApiError('Notification not found', 404)

    const updated = await db.notification.update({
      where: { id: existing.id },
      data: { read: body?.read === false ? false : true },
    })
    return ok(updated, 'Notification updated')
  } catch (e) {
    return handleError(e)
  }
}
