import { db } from '@/lib/db'
import { requireWrite, ok, handleError, companyRequired, ApiError, logAudit } from '@/lib/erp-helpers'

const MACHINE_STATUSES = ['RUNNING', 'IDLE', 'MAINTENANCE', 'BREAKDOWN']

function num(v: unknown, def = 0, field = 'value'): number {
  if (v === undefined || v === null || v === '') return def
  const n = Number(v)
  if (Number.isNaN(n)) throw new ApiError(`${field} must be a number`, 400)
  return n
}

function optDate(v: unknown, field: string): Date | null {
  if (v === undefined || v === null || v === '') return null
  const s = String(v).trim()
  if (!s) return null
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00.000Z` : s)
  if (Number.isNaN(d.getTime())) throw new ApiError(`${field} must be a valid date`, 400)
  return d
}

function optInt(v: unknown, field: string): number | null {
  if (v === undefined || v === null || v === '') return null
  const n = Number(v)
  if (!Number.isInteger(n) || n < 0) throw new ApiError(`${field} must be a whole number of 0 or more`, 400)
  return n
}

const optStr = (v: unknown): string | null => (v === undefined || v === null ? null : String(v).trim() || null)

/** next service = last service + interval (days), when both are known */
function computeNextService(last: Date | null, intervalDays: number | null): Date | null {
  if (!last || !intervalDays) return null
  return new Date(last.getTime() + intervalDays * 86_400_000)
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
    requireWrite(req, 'machines')
    const body = await req.json().catch(() => ({}))
    const companyId = await companyRequired(req, body.companyId)
    const code = String(body.code || '').trim()
    const name = String(body.name || '').trim()
    if (!code || !name) throw new ApiError('code and name are required', 400)
    const status = body.status || 'RUNNING'
    if (!MACHINE_STATUSES.includes(status)) {
      throw new ApiError('status must be one of RUNNING, IDLE, MAINTENANCE, BREAKDOWN', 400)
    }
    const lastServiceDate = optDate(body.lastServiceDate, 'lastServiceDate')
    const serviceIntervalDays = optInt(body.serviceIntervalDays, 'serviceIntervalDays')
    const nextServiceDate =
      optDate(body.nextServiceDate, 'nextServiceDate') ?? computeNextService(lastServiceDate, serviceIntervalDays)

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
          make: optStr(body.make),
          model: optStr(body.model),
          serialNo: optStr(body.serialNo),
          purchaseDate: optDate(body.purchaseDate, 'purchaseDate'),
          lastServiceDate,
          nextServiceDate,
          serviceIntervalDays,
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
