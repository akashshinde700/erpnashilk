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
