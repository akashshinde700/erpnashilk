import { db } from '@/lib/db'
import { ApiError, handleError, ok, requirePlatformAdmin } from '@/lib/erp-helpers'
import { planData } from '@/lib/platform'

// GET /api/platform/plans — all plans with how many organizations use each.
export async function GET(req: Request) {
  try {
    await requirePlatformAdmin(req)
    const plans = await db.plan.findMany({ orderBy: { priceMonthly: 'asc' }, include: { _count: { select: { companies: true } } } })
    return ok({ items: plans.map(({ _count, ...p }) => ({ ...p, orgCount: _count.companies })) })
  } catch (e) {
    return handleError(e)
  }
}

// POST /api/platform/plans { name, priceMonthly, priceYearly, maxUsers, maxWarehouses, maxItems } (limits: 0 = unlimited)
export async function POST(req: Request) {
  try {
    await requirePlatformAdmin(req)
    const body = await req.json().catch(() => ({}))
    const data = planData(body)
    if (!data.name) throw new ApiError('Plan name is required', 400)
    const plan = await db.plan.create({ data: { ...data, name: data.name } })
    return ok(plan, 'Plan created')
  } catch (e) {
    return handleError(e)
  }
}
