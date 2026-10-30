import { db } from '@/lib/db'
import { requireWrite, ok, handleError, companyRequired, ApiError } from '@/lib/erp-helpers'

/**
 * PATCH /api/lead-activities/:id — tick a follow-up off (`done: true`) or reopen it, edit the note.
 * DELETE — remove a follow-up booked by mistake.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireWrite(req, 'crm')
    const { id } = await params
    const body = await req.json().catch(() => ({}))
    const companyId = await companyRequired(req, body.companyId)
    const row = await db.leadActivity.findFirst({ where: { id, companyId } })
    if (!row) throw new ApiError('Follow-up not found', 404)

    const data: Record<string, unknown> = {}
    if (body.done !== undefined) data.doneAt = body.done ? new Date() : null
    if (body.summary !== undefined) {
      const s = String(body.summary).trim()
      if (!s) throw new ApiError('Summary cannot be empty', 400)
      data.summary = s
    }
    if (body.notes !== undefined) data.notes = body.notes ? String(body.notes).trim() : null
    if (body.dueDate !== undefined) {
      const raw = String(body.dueDate || '').trim()
      data.dueDate = raw ? new Date(/^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00.000Z` : raw) : null
    }
    if (!Object.keys(data).length) throw new ApiError('Nothing to update', 400)

    const updated = await db.leadActivity.update({
      where: { id },
      data,
      include: { lead: { select: { id: true, code: true, name: true, companyName: true } } },
    })
    return ok(updated, body.done === true ? 'Follow-up completed' : 'Follow-up updated')
  } catch (e) {
    return handleError(e)
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireWrite(req, 'crm')
    const { id } = await params
    const companyId = await companyRequired(req)
    const row = await db.leadActivity.findFirst({ where: { id, companyId }, select: { id: true } })
    if (!row) throw new ApiError('Follow-up not found', 404)
    await db.leadActivity.delete({ where: { id } })
    return ok({ id }, 'Follow-up removed')
  } catch (e) {
    return handleError(e)
  }
}
