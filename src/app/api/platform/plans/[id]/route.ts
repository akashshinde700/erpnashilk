import { db } from '@/lib/db'
import { ApiError, handleError, ok, requirePlatformAdmin } from '@/lib/erp-helpers'
import { planData } from '@/lib/platform'

type Ctx = { params: Promise<{ id: string }> }

// PATCH /api/platform/plans/[id] — edit price/limits/name/active
export async function PATCH(req: Request, { params }: Ctx) {
  try {
    await requirePlatformAdmin(req)
    const { id } = await params
    const body = await req.json().catch(() => ({}))
    const data = planData(body)
    if (data.name === '') throw new ApiError('Plan name cannot be empty', 400)
    const plan = await db.plan.update({ where: { id }, data })
    return ok(plan, 'Plan updated')
  } catch (e) {
    return handleError(e)
  }
}

// DELETE /api/platform/plans/[id] — only when no organization uses it
export async function DELETE(req: Request, { params }: Ctx) {
  try {
    await requirePlatformAdmin(req)
    const { id } = await params
    const used = await db.company.count({ where: { planId: id } })
    if (used) throw new ApiError(`${used} organization(s) use this plan — move them to another plan first`, 409)
    await db.plan.delete({ where: { id } })
    return ok({ id }, 'Plan deleted')
  } catch (e) {
    return handleError(e)
  }
}
