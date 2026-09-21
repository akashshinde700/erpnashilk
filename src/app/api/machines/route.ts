import { db } from '@/lib/db'
import { ok, handleError, companyRequired, ApiError, logAudit } from '@/lib/erp-helpers'

const MACHINE_STATUSES = ['RUNNING', 'IDLE', 'MAINTENANCE', 'BREAKDOWN']

function num(v: unknown, def = 0, field = 'value'): number {
  if (v === undefined || v === null || v === '') return def
  const n = Number(v)
  if (Number.isNaN(n)) throw new ApiError(`${field} must be a number`, 400)
  return n
}

// ============================== GET /api/machines?q=&status= ==============================
export async function GET(req: Request) {
  try {
    const companyId = await companyRequired(req)
    const { searchParams } = new URL(req.url)
    const q = (searchParams.get('q') || '').trim()
    const status = searchParams.get('status') || ''
    const where = {
      companyId,
      ...(q ? { OR: [{ code: { contains: q } }, { name: { contains: q } }, { workCenter: { contains: q } }] } : {}),
      ...(status ? { status } : {}),
    }
    const [items, total] = await Promise.all([
      db.machine.findMany({ where, orderBy: { code: 'asc' } }),
      db.machine.count({ where }),
    ])
    return ok({ items, total })
  } catch (e) {
    return handleError(e)
  }
}

// ============================== POST /api/machines ==============================
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}))
    const companyId = await companyRequired(req, body.companyId)
    const code = String(body.code || '').trim()
    const name = String(body.name || '').trim()
    if (!code || !name) throw new ApiError('code and name are required', 400)
    const status = body.status || 'RUNNING'
    if (!MACHINE_STATUSES.includes(status)) {
      throw new ApiError('status must be one of RUNNING, IDLE, MAINTENANCE, BREAKDOWN', 400)
    }

    const machine = await db.$transaction(async (tx) => {
      const created = await tx.machine.create({
        data: {
          companyId,
          code,
          name,
          workCenter: body.workCenter || null,
          capacityPerDay: num(body.capacityPerDay, 0, 'capacityPerDay'),
          status,
          hourlyRate: num(body.hourlyRate, 0, 'hourlyRate'),
          notes: body.notes || null,
        },
      })
      await logAudit(tx as any, {
        companyId,
        userName: body.userName,
        action: 'CREATE',
        entity: 'Machine',
        entityId: created.id,
        details: `${code} — ${name}`,
      })
      return created
    })
    return ok(machine, 'Machine created')
  } catch (e) {
    return handleError(e)
  }
}
