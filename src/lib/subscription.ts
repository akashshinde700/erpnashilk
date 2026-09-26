import { randomInt } from 'node:crypto'

/**
 * Subscription rules for customer organizations (pure helpers, no DB access).
 * An org may be used while it is ACTIVE and either has no dates set yet, or is
 * paid up / inside its trial. The platform operator's own company is never blocked.
 */

export interface OrgAccessFields {
  isPlatform?: boolean | null
  status?: string | null
  paidUntil?: Date | string | null
  trialEndsAt?: Date | string | null
}

const endOfDay = (d: Date | string) => {
  const x = new Date(d)
  x.setHours(23, 59, 59, 999)
  return x
}

/** Why this org can't be used right now, or null when it can. */
export function accessProblem(org: OrgAccessFields, now = new Date()): string | null {
  if (org.isPlatform) return null
  if (org.status === 'SUSPENDED') return 'This organization is suspended. Please contact support.'
  if (!org.paidUntil && !org.trialEndsAt) return null
  const paid = org.paidUntil && endOfDay(org.paidUntil) >= now
  const trial = org.trialEndsAt && endOfDay(org.trialEndsAt) >= now
  if (paid || trial) return null
  return org.paidUntil
    ? 'Your subscription has expired. Please renew to continue.'
    : 'Your free trial has ended. Please subscribe to continue.'
}

export type LimitKind = 'users' | 'warehouses' | 'items'

export interface LimitFields {
  maxUsers?: number | null
  maxWarehouses?: number | null
  maxItems?: number | null
  plan?: { maxUsers: number; maxWarehouses: number; maxItems: number } | null
}

/** Effective limits: per-org override, else the plan's; 0 or missing = unlimited. */
export function effectiveLimits(org: LimitFields): Record<LimitKind, number> {
  return {
    users: org.maxUsers ?? org.plan?.maxUsers ?? 0,
    warehouses: org.maxWarehouses ?? org.plan?.maxWarehouses ?? 0,
    items: org.maxItems ?? org.plan?.maxItems ?? 0,
  }
}

export function isCustomized(org: LimitFields): boolean {
  return org.maxUsers != null || org.maxWarehouses != null || org.maxItems != null
}

/** Readable random password (no look-alike characters) for new/reset org admins. */
export function generatePassword(length = 12): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
  let out = ''
  for (let i = 0; i < length; i++) out += chars[randomInt(chars.length)]
  return out
}

export function slugify(name: string): string {
  return name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'org'
}
