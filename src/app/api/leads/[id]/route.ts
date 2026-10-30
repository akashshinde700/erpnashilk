import { db } from '@/lib/db'
import { requireRead, requireWrite, ok, handleError, companyRequired, ApiError, logAudit } from '@/lib/erp-helpers'
import { STAGE_LABEL, STAGE_PROBABILITY, isValidStage, type LeadStage } from '@/lib/crm'
import { createParty } from '@/lib/services/parties'

/**
 * GET/PATCH/DELETE /api/leads/:id
 *
 * PATCH covers three things:
 *   • plain field edits (any subset),
 *   • `action: 'stage'` — move the lead on the board (probability follows the stage unless set),
 *   • `action: 'convert'` — win the lead: create the Customer master from it (unless it already
 *     exists) and link it, so the order can be raised without retyping the party.
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

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireRead(req, ['crm', 'sales-invoices', 'enquiries'])
    const { id } = await params
    const companyId = await companyRequired(req)
    const lead = await db.lead.findFirst({
      where: { id, companyId },
      include: { activities: { orderBy: [{ doneAt: 'asc' }, { dueDate: 'asc' }] } },
    })
    if (!lead) throw new ApiError('Lead not found', 404)
    return ok(lead)
  } catch (e) {
    return handleError(e)
  }
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireWrite(req, 'crm')
    const { id } = await params
    const body = await req.json().catch(() => ({}))
    const companyId = await companyRequired(req, body.companyId)
    const lead = (await db.lead.findFirst({ where: { id, companyId } })) as unknown as LeadRecord | null
    if (!lead) throw new ApiError('Lead not found', 404)

    // ---- convert: win the lead and create / link the customer master ----
    if (body.action === 'convert') {
      if (lead.customerId) {
        const existing = await db.lead.findUnique({ where: { id: lead.id }, include: { activities: true } })
        return ok({ lead: existing, customerId: lead.customerId, created: false }, 'Lead was already converted')
      }
      const result = await db.$transaction(async (tx) => {
        const t = tx as any
        const customer = await createParty(t, companyId, 'customer', {
          name: String(body.customerName || lead.companyName || lead.name).trim(),
          phone: lead.phone || undefined,
          email: lead.email || undefined,
          city: lead.city || undefined,
          notes: `Converted from lead ${lead.code}`,
        }, { userName: body.userName })
        const updated = await t.lead.update({
          where: { id: lead.id },
          data: { stage: 'WON', probability: 100, customerId: customer.id, convertedAt: new Date() },
        })
        await logAudit(t, {
          companyId, userName: body.userName, action: 'UPDATE', entity: 'Lead', entityId: lead.id,
          details: `${lead.code} converted to customer ${customer.code}`,
        })
        return { customer, lead: updated }
      })
      const withActivities = await db.lead.findUnique({ where: { id: lead.id }, include: { activities: true } })
      return ok({ lead: withActivities, customer: result.customer, customerId: result.customer.id, created: true },
        `Converted to customer ${result.customer.code}`)
    }

    // ---- stage move from the board ----
    const data: Record<string, unknown> = {}
    if (body.action === 'stage' || body.stage !== undefined) {
      const stage = String(body.stage || '').toUpperCase() as LeadStage
      if (!isValidStage(stage)) throw new ApiError('Unknown pipeline stage', 400)
      data.stage = stage
      if (body.probability === undefined) data.probability = STAGE_PROBABILITY[stage]
      if (stage === 'WON') data.convertedAt = lead.convertedAt ?? new Date()
      if (stage !== 'LOST') data.lostReason = null
    }
    if (body.probability !== undefined) data.probability = Math.max(0, Math.min(100, Math.round(Number(body.probability) || 0)))
    if (body.value !== undefined) {
      const v = Number(body.value)
      if (Number.isNaN(v) || v < 0) throw new ApiError('Deal value must be a positive number', 400)
      data.value = v
    }
    if (body.name !== undefined) {
      const n = String(body.name).trim()
      if (!n) throw new ApiError('Contact name is required', 400)
      data.name = n
    }
    for (const k of ['companyName', 'phone', 'email', 'city', 'owner', 'notes', 'source']) {
      if (body[k] !== undefined) data[k] = optStr(body[k])
    }
    if (body.lostReason !== undefined) data.lostReason = optStr(body.lostReason)
    if (body.expectedCloseDate !== undefined) data.expectedCloseDate = optDate(body.expectedCloseDate, 'Expected close date')

    if (!Object.keys(data).length) throw new ApiError('Nothing to update', 400)

    await db.$transaction(async (tx) => {
      const t = tx as any
      await t.lead.update({ where: { id: lead.id }, data })
      if (data.stage && data.stage !== lead.stage) {
        await logAudit(t, {
          companyId, userName: body.userName, action: 'UPDATE', entity: 'Lead', entityId: lead.id,
          details: `${lead.code}: ${STAGE_LABEL[lead.stage as LeadStage] || lead.stage} → ${STAGE_LABEL[data.stage as LeadStage]}`,
        })
      }
    })
    const updated = await db.lead.findUnique({ where: { id: lead.id }, include: { activities: { orderBy: [{ doneAt: 'asc' }, { dueDate: 'asc' }] } } })
    return ok(updated, 'Lead updated')
  } catch (e) {
    return handleError(e)
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireWrite(req, 'crm')
    const { id } = await params
    const companyId = await companyRequired(req)
    const lead = await db.lead.findFirst({ where: { id, companyId }, select: { id: true, code: true } })
    if (!lead) throw new ApiError('Lead not found', 404)
    const params2 = new URL(req.url).searchParams
    const body = params2.get('userName')
    await db.$transaction(async (tx) => {
      await (tx as any).leadActivity.deleteMany({ where: { leadId: id, companyId } })
      await (tx as any).lead.delete({ where: { id } })
      await logAudit(tx as never, { companyId, userName: body || undefined, action: 'DELETE', entity: 'Lead', entityId: id, details: lead.code })
    })
    return ok({ id }, 'Lead deleted')
  } catch (e) {
    return handleError(e)
  }
}

interface LeadRecord {
  id: string
  code: string
  stage: LeadStage
  name: string
  companyName?: string | null
  phone?: string | null
  email?: string | null
  city?: string | null
  customerId?: string | null
  convertedAt?: Date | string | null
}
