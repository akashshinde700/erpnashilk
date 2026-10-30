import { db } from '@/lib/db'
import { requireRead, requireWrite, ok, handleError, companyRequired, ApiError, logAudit, r2 } from '@/lib/erp-helpers'
import { LEAD_SOURCES, STAGE_PROBABILITY, isValidStage, type LeadStage } from '@/lib/crm'

/**
 * GET/POST /api/leads
 *
 * The CRM pipeline. A lead is a prospect plus the expected deal; activities (calls, meetings,
 * reminders) hang off it. GET returns the leads with their open follow-up, so the board and the
 * follow-up list need one call.
 */

const optStr = (v: unknown): string | null => {
  if (v === undefined || v === null) return null
  const s = String(v).trim()
  return s || null
}

const num = (v: unknown, field: string, def = 0): number => {
  if (v === undefined || v === null || v === '') return def
  const n = Number(v)
  if (Number.isNaN(n)) throw new ApiError(`${field} must be a number`, 400)
  return n
}

const optDate = (v: unknown, field: string): Date | null => {
  if (v === undefined || v === null || v === '') return null
  const s = String(v).trim()
  if (!s) return null
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00.000Z` : s)
  if (Number.isNaN(d.getTime())) throw new ApiError(`${field} must be a valid date`, 400)
  return d
}

/** Next free LD-0001 style code for the company. */
async function nextLeadCode(companyId: string): Promise<string> {
  const rows = (await db.lead.findMany({ where: { companyId }, select: { code: true } })) as unknown as { code: string }[]
  const max = rows.reduce((m, r) => {
    const n = Number(String(r.code).replace(/^LD-?/i, ''))
    return Number.isInteger(n) && n > m ? n : m
  }, 0)
  return `LD-${String(max + 1).padStart(4, '0')}`
}

export async function GET(req: Request) {
  try {
    requireRead(req, ['crm', 'sales-invoices', 'enquiries'])
    const companyId = await companyRequired(req)
    const { searchParams } = new URL(req.url)
    const stage = searchParams.get('stage') || ''
    const q = (searchParams.get('q') || '').trim()
    const where = {
      companyId,
      ...(stage ? { stage } : {}),
      ...(q
        ? { OR: [{ name: { contains: q } }, { companyName: { contains: q } }, { code: { contains: q } }, { phone: { contains: q } }] }
        : {}),
    }
    const items = (await db.lead.findMany({
      where,
      orderBy: [{ updatedAt: 'desc' }],
      include: {
        // the next thing to do — the board shows it, and the follow-up tab sorts by it
        activities: { where: { doneAt: null }, orderBy: [{ dueDate: 'asc' }], take: 1 },
      },
    })) as unknown as LeadRowLike[]

    const open = items.filter((l) => l.stage !== 'WON' && l.stage !== 'LOST')
    const summary = {
      total: items.length,
      open: open.length,
      pipelineValue: r2(open.reduce((s, l) => s + (Number(l.value) || 0), 0)),
      weightedValue: r2(open.reduce((s, l) => s + ((Number(l.value) || 0) * (Number(l.probability) || 0)) / 100, 0)),
      won: items.filter((l) => l.stage === 'WON').length,
      lost: items.filter((l) => l.stage === 'LOST').length,
      wonValue: r2(items.filter((l) => l.stage === 'WON').reduce((s, l) => s + (Number(l.value) || 0), 0)),
    }
    return ok({ items, total: items.length, summary })
  } catch (e) {
    return handleError(e)
  }
}

interface LeadRowLike {
  stage: string
  value?: number | null
  probability?: number | null
}

export async function POST(req: Request) {
  try {
    requireWrite(req, 'crm')
    const body = await req.json().catch(() => ({}))
    const companyId = await companyRequired(req, body.companyId)

    const name = String(body.name || '').trim()
    if (!name) throw new ApiError('Contact name is required', 400)
    const stage = String(body.stage || 'NEW').toUpperCase() as LeadStage
    if (!isValidStage(stage)) throw new ApiError(`Stage must be one of ${['NEW', 'CONTACTED', 'QUALIFIED', 'PROPOSAL', 'NEGOTIATION', 'WON', 'LOST'].join(', ')}`, 400)
    const source = String(body.source || 'OTHER').toUpperCase()
    if (!LEAD_SOURCES.includes(source as (typeof LEAD_SOURCES)[number])) throw new ApiError(`Source must be one of ${LEAD_SOURCES.join(', ')}`, 400)
    const probability = body.probability === undefined || body.probability === null || body.probability === ''
      ? STAGE_PROBABILITY[stage]
      : Math.max(0, Math.min(100, Math.round(num(body.probability, 'Probability'))))

    const created = (await db.$transaction(async (tx) => {
      const t = tx as any
      const code = String(body.code || '').trim() || (await nextLeadCode(companyId))
      const lead = await t.lead.create({
        data: {
          companyId,
          code,
          name,
          companyName: optStr(body.companyName),
          phone: optStr(body.phone),
          email: optStr(body.email),
          city: optStr(body.city),
          source,
          stage,
          value: num(body.value, 'Deal value'),
          probability,
          owner: optStr(body.owner),
          expectedCloseDate: optDate(body.expectedCloseDate, 'Expected close date'),
          notes: optStr(body.notes),
        },
      })
      await logAudit(t, {
        companyId, userName: body.userName, action: 'CREATE', entity: 'Lead', entityId: lead.id,
        details: `${code} — ${name}${body.companyName ? ` (${body.companyName})` : ''}`,
      })
      return lead
    })) as { id: string; code: string }

    const lead = await db.lead.findUnique({ where: { id: created.id }, include: { activities: true } })
    return ok(lead, `Lead ${created.code} created`)
  } catch (e) {
    return handleError(e)
  }
}
