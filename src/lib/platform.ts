import { db } from '@/lib/db'
import { ApiError } from '@/lib/erp-helpers'
import { accessProblem, effectiveLimits, isCustomized } from '@/lib/subscription'

/** Company fields + relations needed to render one row of the platform-admin org table. */
export const ORG_INCLUDE = {
  plan: { select: { id: true, name: true, maxUsers: true, maxWarehouses: true, maxItems: true, priceMonthly: true, priceYearly: true } },
  _count: { select: { users: true, warehouses: true, items: true, customers: true } },
  users: {
    where: { role: 'TENANT_ADMIN' },
    orderBy: { createdAt: 'asc' as const },
    take: 1,
    select: { id: true, name: true, email: true, active: true },
  },
} as const

type OrgWithRelations = NonNullable<Awaited<ReturnType<typeof loadOrg>>>

export function loadOrg(id: string) {
  return db.company.findUnique({ where: { id }, include: ORG_INCLUDE })
}

/** 'suspended' | 'expired' | 'trial' | 'active' — what the org's users experience right now. */
export function orgState(org: OrgWithRelations): 'suspended' | 'expired' | 'trial' | 'active' {
  if (org.status === 'SUSPENDED') return 'suspended'
  if (accessProblem(org)) return 'expired'
  const paid = org.paidUntil && new Date(org.paidUntil) >= new Date()
  if (!paid && org.trialEndsAt) return 'trial'
  return 'active'
}

export function orgRow(org: OrgWithRelations) {
  const admin = org.users[0] || null
  return {
    id: org.id,
    name: org.name,
    slug: org.slug,
    gstin: org.gstin,
    city: org.city,
    state: org.state,
    phone: org.phone,
    email: org.email,
    admin,
    plan: org.plan ? { id: org.plan.id, name: org.plan.name } : null,
    customized: isCustomized(org),
    limits: effectiveLimits(org),
    overrides: { maxUsers: org.maxUsers, maxWarehouses: org.maxWarehouses, maxItems: org.maxItems },
    usage: { users: org._count.users, warehouses: org._count.warehouses, items: org._count.items, customers: org._count.customers },
    status: org.status,
    state_: orgState(org),
    billingCycle: org.billingCycle,
    paidUntil: org.paidUntil,
    trialEndsAt: org.trialEndsAt,
    createdAt: org.createdAt,
  }
}

/** Validated Plan fields from a request body (undefined = leave unchanged). */
export function planData(body: Record<string, unknown>) {
  const num = (k: string, int = false) => {
    const v = body[k]
    if (v === undefined || v === null || v === '') return undefined
    const n = Number(v)
    if (!Number.isFinite(n) || n < 0) throw new ApiError(`${k} must be 0 or more`, 400)
    return int ? Math.round(n) : Math.round(n * 100) / 100
  }
  return {
    ...(body.name !== undefined ? { name: String(body.name).trim() } : {}),
    priceMonthly: num('priceMonthly'),
    priceYearly: num('priceYearly'),
    maxUsers: num('maxUsers', true),
    maxWarehouses: num('maxWarehouses', true),
    maxItems: num('maxItems', true),
    ...(body.active !== undefined ? { active: !!body.active } : {}),
  }
}
