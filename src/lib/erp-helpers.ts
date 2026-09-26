import { NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { canAccessModule } from '@/lib/erp-constants'
import { passwordVersion } from '@/lib/session'

// ============ Consistent API responses ============

export function ok<T>(data: T, message = '') {
  return NextResponse.json({ success: true, data, message })
}

export function fail(message: string, status = 400, code = 'ERR') {
  return NextResponse.json({ success: false, error: { code, message } }, { status })
}

// ============ Company (tenant) resolution ============

// Only the platform SUPER_ADMIN may act on a company other than their own.
export const PLATFORM_ROLE = 'SUPER_ADMIN'

/** User columns safe to return from the API (never the password hash). */
export const USER_PUBLIC = {
  id: true, companyId: true, name: true, email: true, phone: true, role: true, active: true, createdAt: true, updatedAt: true,
} as const

export interface SessionUser {
  id: string
  name: string
  email: string
  role: string
  companyId: string
}

const sessionCache = new WeakMap<Request, Promise<SessionUser>>()

/**
 * The signed-in user, re-read from the DB on every request (middleware has already
 * verified the cookie signature and set x-erp-user-id / x-erp-role). Rejects
 * deactivated users and role changes made after the session was issued.
 */
export function sessionUser(req: Request): Promise<SessionUser> {
  let p = sessionCache.get(req)
  if (!p) {
    p = (async () => {
      const id = req.headers.get('x-erp-user-id')
      if (!id) throw new ApiError('Unauthorized — sign in to continue', 401)
      const u = await db.user.findUnique({
        where: { id },
        select: { id: true, name: true, email: true, role: true, companyId: true, active: true, passwordHash: true },
      })
      if (!u || !u.active) throw new ApiError('Your session has ended — sign in again', 401)
      if (u.role !== req.headers.get('x-erp-role')) throw new ApiError('Your role was changed — sign in again', 401)
      if (req.headers.get('x-erp-pv') !== passwordVersion(u.passwordHash)) throw new ApiError('Your password was changed — sign in again', 401)
      return { id: u.id, name: u.name, email: u.email, role: u.role, companyId: u.companyId }
    })()
    sessionCache.set(req, p)
  }
  return p
}

/**
 * Tenant for this request: the requested company (body, then ?companyId, then the
 * x-company-id header), defaulting to the user's own company. Everyone except the
 * platform SUPER_ADMIN is pinned to their own company.
 */
export async function resolveCompanyId(req: Request, bodyCompanyId?: string): Promise<string | null> {
  const user = await sessionUser(req)
  const { searchParams } = new URL(req.url)
  const cid = bodyCompanyId || searchParams.get('companyId') || req.headers.get('x-company-id') || user.companyId
  if (cid !== user.companyId && user.role !== PLATFORM_ROLE) {
    throw new ApiError('You do not have access to this company', 403)
  }
  const company = await db.company.findUnique({ where: { id: cid }, select: { id: true } })
  return company ? company.id : null
}

export function companyRequired(req: Request, bodyCompanyId?: string): Promise<string> {
  return resolveCompanyId(req, bodyCompanyId).then((c) => {
    if (!c) throw new ApiError('companyId is required (valid tenant id)', 400)
    return c
  })
}

export class ApiError extends Error {
  status: number
  constructor(message: string, status = 400) {
    super(message)
    this.status = status
  }
}

// ============ Request identity + server-side role guard ============
// The client api() helper (use-api.ts) attaches x-erp-user-id / x-erp-user-name /
// x-erp-role headers from the stored session. Middleware rejects anonymous calls;
// requireWrite() additionally enforces role-based WRITE access per module.

export interface RequestActor {
  userId: string
  userName: string
  role: string
}

export function getActor(req: Request): RequestActor | null {
  const userId = req.headers.get('x-erp-user-id') || ''
  const role = req.headers.get('x-erp-role') || ''
  if (!userId || !role) return null
  const rawName = req.headers.get('x-erp-user-name') || ''
  let userName = rawName
  try { userName = rawName ? decodeURIComponent(rawName) : 'system' } catch { /* keep raw */ }
  return { userId, userName, role }
}

/** Entities only Tenant Admin / Management / Super Admin may modify. */
const WRITE_ADMIN_ONLY = new Set(['users', 'companies', 'company-setup', 'settings'])

/**
 * Enforce role-based write access for a mutating endpoint.
 * moduleKey is the registry module key (e.g. 'items', 'sales-orders').
 * Throws 401 (no identity) / 403 (role lacks access) — caught by handleError().
 */
export function requireWrite(req: Request, moduleKey: string): RequestActor {
  const actor = getActor(req)
  if (!actor) throw new ApiError('Unauthorized — sign in to continue', 401)
  const allowed = WRITE_ADMIN_ONLY.has(moduleKey)
    ? ['TENANT_ADMIN', 'MANAGEMENT', 'SUPER_ADMIN'].includes(actor.role)
    : canAccessModule(actor.role, moduleKey)
  if (!allowed) throw new ApiError(`Your role is not allowed to modify ${moduleKey}`, 403)
  return actor
}

export function handleError(e: unknown) {
  if (e instanceof ApiError) return fail(e.message, e.status)
  if (e instanceof Prisma.PrismaClientKnownRequestError) {
    if (e.code === 'P2002') return fail('Duplicate record: code/number already exists', 409)
    if (e.code === 'P2025') return fail('Record not found', 404)
    if (e.code === 'P2003') return fail('This record is used by other documents and cannot be removed or changed', 409)
    if (e.code === 'P2028' || e.code === 'P2034') return fail('The server was busy — please try again', 503)
  }
  if (e instanceof SyntaxError) return fail('Invalid request body', 400)
  // Details go to the server log only; internals are never sent to the client.
  console.error('[API]', e)
  return fail('Something went wrong on the server — please try again', 500)
}

/**
 * Atomically move a document from one of `from` statuses to `to` inside a transaction.
 * The conditional update locks the row, so two concurrent post/dispatch/cancel calls
 * cannot both pass a status check that was read earlier.
 */
export async function claimStatus(
  model: { updateMany: (a: never) => Promise<{ count: number }> },
  id: string,
  from: string[],
  to: string,
) {
  const r = await model.updateMany({ where: { id, status: { in: from } }, data: { status: to } } as never)
  if (r.count !== 1) throw new ApiError('This document was just changed by someone else — refresh and try again', 409)
}

// ============ Financial year + document numbering ============
// Indian FY: 1 Apr – 31 Mar. Format: PREFIX-FY-000001  (e.g. SO-2526-000001)

export function financialYearOf(d: Date = new Date()): string {
  const y = d.getFullYear()
  const m = d.getMonth() + 1
  const start = m >= 4 ? y : y - 1
  const end = start + 1
  return `${String(start % 100).padStart(2, '0')}${String(end % 100).padStart(2, '0')}`
}

export const DOC_PREFIX: Record<string, string> = {
  ENQ: 'ENQ', QT: 'QT', SO: 'SO', DN: 'DN', INV: 'INV',
  PR: 'PR', PO: 'PO', GRN: 'GRN', PINV: 'PINV',
  WO: 'WO', MI: 'MI', QC: 'QC',
  RCPT: 'RCPT', PYMT: 'PYMT', EXP: 'EXP', TRF: 'TRF', ADJ: 'ADJ',
}

/**
 * Atomically generate next document number for (companyId, docType, FY).
 * Must be called inside the same transaction/interactive tx as record creation.
 */
export async function nextDocNumber(tx: {
  numberSeq: { upsert: (a: never) => Promise<{ nextNumber: number }> }
}, companyId: string, docType: string, date: Date = new Date()): Promise<string> {
  const fy = financialYearOf(date)
  const prefix = DOC_PREFIX[docType] || docType
  // Increment first, then derive the number from the row we just locked: concurrent
  // transactions queue on the same NumberSeq row and each gets a distinct number.
  const bump = () => tx.numberSeq.upsert({
    where: { companyId_docType_financialYear: { companyId, docType, financialYear: fy } },
    create: { companyId, docType, prefix, financialYear: fy, nextNumber: 2 },
    update: { nextNumber: { increment: 1 } },
  } as never)
  let seq: { nextNumber: number }
  try {
    seq = await bump()
  } catch (e) {
    // First number of a new (company, docType, FY): a concurrent request created the row
    // between our check and insert. The row exists now, so the retry takes the update path.
    if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e
    seq = await bump()
  }
  const n = seq.nextNumber - 1
  return `${prefix}-${fy}-${String(n).padStart(6, '0')}`
}

// ============ GST helpers ============

export interface TaxLine {
  qty: number; rate: number; discountPct?: number; gstRate: number
}

/** Compute per-line taxable value and tax split. interState => IGST, else CGST+SGST */
export function computeGst(lines: TaxLine[], interState: boolean) {
  let subtotal = 0, discountTotal = 0, cgst = 0, sgst = 0, igst = 0
  const computed = lines.map((l) => {
    const gross = l.qty * l.rate
    const disc = gross * ((l.discountPct || 0) / 100)
    const taxable = gross - disc
    const tax = taxable * (l.gstRate / 100)
    subtotal += gross
    discountTotal += disc
    if (interState) igst += tax
    else { cgst += tax / 2; sgst += tax / 2 }
    return { ...l, taxable, tax }
  })
  const grandTotal = subtotal - discountTotal + cgst + sgst + igst
  return { computed, subtotal: r2(subtotal), discountTotal: r2(discountTotal), cgst: r2(cgst), sgst: r2(sgst), igst: r2(igst), grandTotal: r2(grandTotal) }
}

export const r2 = (n: number) => Math.round(n * 100) / 100

/** isInterState if company stateCode differs from party stateCode */
export function isInterState(companyState?: string | null, partyState?: string | null): boolean {
  if (!companyState || !partyState) return false
  return companyState.trim().toLowerCase() !== partyState.trim().toLowerCase()
}

/** Inter-state check for a company/party pair: GST state codes when both have one, else state names. */
export function isInterStateParty(
  company: { stateCode?: string | null; state?: string | null },
  party: { stateCode?: string | null; state?: string | null },
): boolean {
  if (company.stateCode && party.stateCode) return isInterState(company.stateCode, party.stateCode)
  return isInterState(company.state, party.state)
}

// ============ Stock posting (immutable ledger) ============

export interface StockPostInput {
  companyId: string
  itemId: string
  warehouseId: string
  type: string
  qtyIn?: number
  qtyOut?: number
  rate?: number
  date?: Date
  refType?: string
  refId?: string
  refNumber?: string
  notes?: string
}

interface MinimalTx {
  stockLedger: { create: (a: unknown) => Promise<unknown> }
  stockBalance: {
    findUnique: (a: unknown) => Promise<{ id: string; qty: number; avgRate: number } | null>
    updateMany: (a: unknown) => Promise<unknown>
    upsert: (a: unknown) => Promise<unknown>
    update: (a: unknown) => Promise<unknown>
  }
  notification: { create: (a: unknown) => Promise<unknown> }
  item: { findUnique: (a: unknown) => Promise<{ id: string; name: string; code: string; reorderLevel: number; uom: string } | null> }
}

/**
 * Post a stock movement: writes immutable StockLedger row + updates StockBalance (moving average rate).
 * Call inside a prisma $transaction. Returns updated balance qty.
 */
export async function postStock(tx: MinimalTx, input: StockPostInput): Promise<number> {
  const qtyIn = Math.max(0, input.qtyIn || 0)
  const qtyOut = Math.max(0, input.qtyOut || 0)
  const rate = input.rate || 0
  const date = input.date || new Date()

  // The no-op write takes the row lock first, so the read below sees the latest
  // committed balance and concurrent movements on one item+warehouse serialize.
  await tx.stockBalance.updateMany({
    where: { itemId: input.itemId, warehouseId: input.warehouseId },
    data: { qty: { increment: 0 } },
  })
  const bal = await tx.stockBalance.findUnique({
    where: { itemId_warehouseId: { itemId: input.itemId, warehouseId: input.warehouseId } },
  })
  const prevQty = bal?.qty || 0
  const prevRate = bal?.avgRate || 0
  const newQty = r2(prevQty + qtyIn - qtyOut)

  if (qtyOut > 0 && newQty < 0) {
    const it = await tx.item.findUnique({ where: { id: input.itemId } })
    throw new ApiError(
      `Insufficient stock for ${it ? `${it.code} ${it.name}` : 'item'}: ${r2(prevQty)} available in this warehouse, ${r2(qtyOut)} required`,
      409,
    )
  }

  let newRate = prevRate
  if (qtyIn > 0 && rate > 0) {
    newRate = prevQty > 0 ? r2((prevQty * prevRate + qtyIn * rate) / (prevQty + qtyIn)) : r2(rate)
  }

  await tx.stockLedger.create({
    data: {
      companyId: input.companyId, date, itemId: input.itemId, warehouseId: input.warehouseId,
      type: input.type, qtyIn, qtyOut, rate, refType: input.refType, refId: input.refId,
      refNumber: input.refNumber, notes: input.notes,
    },
  })

  if (bal) {
    await tx.stockBalance.update({ where: { id: bal.id }, data: { qty: newQty, avgRate: newRate } })
  } else {
    await tx.stockBalance.upsert({
      where: { itemId_warehouseId: { itemId: input.itemId, warehouseId: input.warehouseId } },
      create: { companyId: input.companyId, itemId: input.itemId, warehouseId: input.warehouseId, qty: newQty, avgRate: newRate },
      update: { qty: newQty, avgRate: newRate },
    })
  }

  // Low-stock notification on outward movement
  if (qtyOut > 0) {
    const item = await tx.item.findUnique({ where: { id: input.itemId } })
    if (item && item.reorderLevel > 0 && newQty <= item.reorderLevel) {
      const openCount = await (tx as unknown as { notification: { count: (a: unknown) => Promise<number> } }).notification.count({
        where: { companyId: input.companyId, read: false, title: { contains: 'Low stock' } },
      })
      if (openCount < 20) {
        await tx.notification.create({
          data: {
            companyId: input.companyId,
            title: `Low stock: ${item.name}`,
            message: `${item.code} is at ${newQty} ${item.uom} (reorder level ${item.reorderLevel}). Raise a purchase requisition.`,
            level: newQty <= 0 ? 'CRITICAL' : 'WARNING',
          },
        })
      }
    }
  }

  return newQty
}

/** Available qty across all warehouses for an item (within tx). */
export async function availableQty(tx: {
  stockBalance: { findMany: (a: unknown) => Promise<{ qty: number }[]> }
}, companyId: string, itemId: string, excludeWarehouseId?: string): Promise<number> {
  const rows = await tx.stockBalance.findMany({ where: { companyId, itemId, ...(excludeWarehouseId ? { warehouseId: { not: excludeWarehouseId } } : {}) } })
  return r2(rows.reduce((s, r) => s + r.qty, 0))
}

// ============ Audit + notifications ============

/** Name of the signed-in user for this request (set by middleware from the verified session). */
export async function trustedUserName(): Promise<string | null> {
  try {
    const raw = (await headers()).get('x-erp-user-name')
    return raw ? decodeURIComponent(raw) : null
  } catch {
    return null // outside a request (scripts)
  }
}

export async function logAudit(tx: {
  auditLog: { create: (a: unknown) => Promise<unknown> }
}, input: { companyId: string; userName?: string; action: string; entity: string; entityId?: string; details?: string }) {
  // The session identity always wins over any client-supplied name.
  const userName = (await trustedUserName()) || input.userName || 'system'
  await tx.auditLog.create({
    data: {
      companyId: input.companyId, userName, action: input.action,
      entity: input.entity, entityId: input.entityId, details: input.details,
    },
  })
}

export async function notify(tx: {
  notification: { create: (a: unknown) => Promise<unknown> }
}, input: { companyId: string; title: string; message?: string; level?: string }) {
  await tx.notification.create({
    data: { companyId: input.companyId, title: input.title, message: input.message, level: input.level || 'INFO' },
  })
}
