import type { Prisma } from '@prisma/client'
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

// ============================== GET /api/machines/[id] ==============================
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const companyId = await companyRequired(req)
    const machine = await db.machine.findFirst({ where: { id, companyId } })
    if (!machine) throw new ApiError('Machine not found', 404)
    return ok({ machine })
  } catch (e) {
    return handleError(e)
  }
}

// ============================== PATCH /api/machines/[id] ==============================
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireWrite(req, 'machines')
    const { id } = await params
    const body = await req.json().catch(() => ({}))
    const companyId = await companyRequired(req, body.companyId)
    const existing = await db.machine.findFirst({ where: { id, companyId } })
    if (!existing) throw new ApiError('Machine not found', 404)
    if (body.code !== undefined && !String(body.code).trim()) throw new ApiError('code cannot be empty', 400)
    if (body.name !== undefined && !String(body.name).trim()) throw new ApiError('name cannot be empty', 400)
    if (body.status !== undefined && !MACHINE_STATUSES.includes(String(body.status))) {
      throw new ApiError('status must be one of RUNNING, IDLE, MAINTENANCE, BREAKDOWN', 400)
    }

    const data: Prisma.MachineUncheckedUpdateInput = {}
    if (body.code !== undefined) data.code = String(body.code).trim()
    if (body.name !== undefined) data.name = String(body.name).trim()
    if (body.workCenter !== undefined) data.workCenter = body.workCenter || null
    if (body.capacityPerDay !== undefined) data.capacityPerDay = num(body.capacityPerDay, 0, 'capacityPerDay')
    if (body.status !== undefined) data.status = String(body.status)
    if (body.hourlyRate !== undefined) data.hourlyRate = num(body.hourlyRate, 0, 'hourlyRate')
    if (body.notes !== undefined) data.notes = body.notes || null
    if (body.make !== undefined) data.make = optStr(body.make)
    if (body.model !== undefined) data.model = optStr(body.model)
    if (body.serialNo !== undefined) data.serialNo = optStr(body.serialNo)
    if (body.purchaseDate !== undefined) data.purchaseDate = optDate(body.purchaseDate, 'purchaseDate')
    if (body.lastServiceDate !== undefined) data.lastServiceDate = optDate(body.lastServiceDate, 'lastServiceDate')
    if (body.serviceIntervalDays !== undefined) {
      data.serviceIntervalDays = optInt(body.serviceIntervalDays, 'serviceIntervalDays')
    }
    if (body.nextServiceDate !== undefined) data.nextServiceDate = optDate(body.nextServiceDate, 'nextServiceDate')
    // Auto-schedule: when the next service date is left empty (or not sent) but the
    // service schedule changed, derive it from last service + interval.
    const scheduleTouched = body.lastServiceDate !== undefined || body.serviceIntervalDays !== undefined
    if (scheduleTouched && !data.nextServiceDate && (body.nextServiceDate !== undefined || !existing.nextServiceDate)) {
      const last = body.lastServiceDate !== undefined ? (data.lastServiceDate as Date | null) : existing.lastServiceDate
      const interval =
        body.serviceIntervalDays !== undefined ? (data.serviceIntervalDays as number | null) : existing.serviceIntervalDays
      const next = computeNextService(last, interval)
      if (next) data.nextServiceDate = next
    }

    const machine = await db.$transaction(async (tx) => {
      const updated = await tx.machine.update({ where: { id: existing.id }, data })
      await logAudit(tx as any, {
        companyId,
        userName: body.userName,
        action: 'UPDATE',
        entity: 'Machine',
        entityId: id,
        details: `${updated.code} — ${updated.name} (${updated.status})`,
      })
      return updated
    })
    return ok(machine, 'Machine updated')
  } catch (e) {
    return handleError(e)
  }
}

// ============================== DELETE /api/machines/[id] ==============================
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireWrite(req, 'machines')
    const { id } = await params
    const body = await req.json().catch(() => ({}))
    const companyId = await companyRequired(req, body.companyId)
    const existing = await db.machine.findFirst({ where: { id, companyId } })
    if (!existing) throw new ApiError('Machine not found', 404)

    await db.$transaction(async (tx) => {
      await tx.machine.delete({ where: { id } })
      await logAudit(tx as any, {
        companyId,
        userName: body.userName,
        action: 'DELETE',
        entity: 'Machine',
        entityId: id,
        details: `${existing.code} — ${existing.name}`,
      })
    })
    return ok({ id }, 'Machine deleted')
  } catch (e) {
    return handleError(e)
  }
}
