import { db } from '@/lib/db'
import { requireRead, requireWrite, ok, handleError, companyRequired, ApiError } from '@/lib/erp-helpers'
import { ACTIVITY_KINDS } from '@/lib/crm'

/**
 * GET/POST /api/lead-activities
 *
 * The follow-up list of the CRM: calls, meetings, WhatsApp messages and reminders booked against
 * a lead. `?open=1` returns only what is still to be done (due-date order) — the "Follow-ups" tab
 * and the dashboard count use that.
 */

const optStr = (v: unknown): string | null => {
  if (v === undefined || v === null) return null
  const s = String(v).trim()
  return s || null
}

const optDate = (v: unknown, field: string): Date | null => {
  if (v === undefined || v === null || v === '') return null
  const s = String(v).trim()
  if (!s) return null
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00.000Z` : s)
  if (Number.isNaN(d.getTime())) throw new ApiError(`${field} must be a valid date`, 400)
  return d
}

export async function GET(req: Request) {
  try {
    requireRead(req, ['crm', 'sales-invoices', 'enquiries'])
    const companyId = await companyRequired(req)
    const { searchParams } = new URL(req.url)
    const open = searchParams.get('open') === '1'
    const leadId = searchParams.get('leadId') || ''
    const where = { companyId, ...(open ? { doneAt: null } : {}), ...(leadId ? { leadId } : {}) }
    const items = await db.leadActivity.findMany({
      where,
      orderBy: [{ doneAt: 'asc' }, { dueDate: 'asc' }, { createdAt: 'desc' }],
      include: { lead: { select: { id: true, code: true, name: true, companyName: true, stage: true } } },
      take: 200,
    })
    return ok({ items, total: items.length })
  } catch (e) {
    return handleError(e)
  }
}

export async function POST(req: Request) {
  try {
    requireWrite(req, 'crm')
    const body = await req.json().catch(() => ({}))
    const companyId = await companyRequired(req, body.companyId)
    const leadId = String(body.leadId || '').trim()
    if (!leadId) throw new ApiError('leadId is required', 400)
    const lead = await db.lead.findFirst({ where: { id: leadId, companyId }, select: { id: true, code: true } })
    if (!lead) throw new ApiError('Lead not found', 404)
    const summary = String(body.summary || '').trim()
    if (!summary) throw new ApiError('What is the follow-up? (summary is required)', 400)
    const kind = String(body.kind || 'CALL').toUpperCase()
    if (!ACTIVITY_KINDS.includes(kind as (typeof ACTIVITY_KINDS)[number])) {
      throw new ApiError(`Type must be one of ${ACTIVITY_KINDS.join(', ')}`, 400)
    }
    const created = await db.leadActivity.create({
      data: {
        companyId,
        leadId,
        kind,
        summary,
        notes: optStr(body.notes),
        dueDate: optDate(body.dueDate, 'Due date'),
        owner: optStr(body.owner),
        // A logged note ("spoke to them about X") is already done; a booked call is a task.
        doneAt: body.done === true || kind === 'NOTE' ? new Date() : null,
      },
      include: { lead: { select: { id: true, code: true, name: true, companyName: true } } },
    })
    return ok(created, `Follow-up added to ${lead.code}`)
  } catch (e) {
    return handleError(e)
  }
}
