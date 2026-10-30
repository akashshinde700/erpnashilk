import { NextResponse } from 'next/server'
import { headers } from 'next/headers'
import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { canAccessModule, canSeeFinancialReports } from '@/lib/erp-constants'
import { passwordVersion } from '@/lib/session'
import { accessProblem, effectiveLimits, type LimitKind } from '@/lib/subscription'

// ============ Consistent API responses ============

export function ok<T>(data: T, message = '') {
  return NextResponse.json({ success: true, data, message })
}

export function fail(message: string, status = 400, code = 'ERR', details?: unknown) {
  return NextResponse.json({ success: false, error: { code, message, ...(details === undefined ? {} : { details }) } }, { status })
}

// ============ Company (tenant) resolution ============

// Only the platform SUPER_ADMIN may act on any company; other users on their home
// company plus firms linked to them via UserCompanyAccess.
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
        select: {
          id: true, name: true, email: true, role: true, companyId: true, active: true, passwordHash: true,
          company: { select: { isPlatform: true, status: true, paidUntil: true, trialEndsAt: true } },
        },
      })
      if (!u || !u.active) throw new ApiError('Your session has ended — sign in again', 401)
      if (u.role !== PLATFORM_ROLE) {
        const blocked = accessProblem(u.company)
        if (blocked) throw new ApiError(blocked, 401)
      }
      if (u.role !== req.headers.get('x-erp-role')) throw new ApiError('Your role was changed — sign in again', 401)
      if (req.headers.get('x-erp-pv') !== passwordVersion(u.passwordHash)) throw new ApiError('Your password was changed — sign in again', 401)
      return { id: u.id, name: u.name, email: u.email, role: u.role, companyId: u.companyId }
    })()
    sessionCache.set(req, p)
  }
  return p
}

/** Platform-admin-only endpoints (/api/platform/*). */
export async function requirePlatformAdmin(req: Request): Promise<SessionUser> {
  const me = await sessionUser(req)
  if (me.role !== PLATFORM_ROLE) throw new ApiError('Platform administrator access required', 403)
  return me
}

/** Throw 403 when creating one more user/warehouse/item would exceed the org's plan. */
export async function assertLimit(companyId: string, kind: LimitKind, adding = 1) {
  const org = await db.company.findUnique({
    where: { id: companyId },
    select: { isPlatform: true, maxUsers: true, maxWarehouses: true, maxItems: true, plan: { select: { maxUsers: true, maxWarehouses: true, maxItems: true } } },
  })
  if (!org || org.isPlatform) return
  const limit = effectiveLimits(org)[kind]
  if (!limit) return
  const used = kind === 'users'
    ? await db.user.count({ where: { companyId, active: true } })
    : kind === 'warehouses'
      ? await db.warehouse.count({ where: { companyId } })
      : await db.item.count({ where: { companyId } })
  if (used + adding > limit) {
    throw new ApiError(`Plan limit reached: ${used}/${limit} ${kind}. Ask your provider to upgrade the plan.`, 403)
  }
}

const firmCache = new WeakMap<Request, Promise<Set<string>>>()

/**
 * Extra firms (companies other than the home company) this user may open — rows in
 * UserCompanyAccess, created when a TENANT_ADMIN creates another firm. Cached per request.
 */
export function linkedFirmIds(req: Request): Promise<Set<string>> {
  let p = firmCache.get(req)
  if (!p) {
    p = (async () => {
      const user = await sessionUser(req)
      const rows = await db.userCompanyAccess.findMany({ where: { userId: user.id }, select: { companyId: true } })
      return new Set(rows.map((r) => r.companyId).filter((c) => c !== user.companyId))
    })()
    firmCache.set(req, p)
  }
  return p
}

/**
 * Throw 403 unless the signed-in user may act on company `cid`: their home company,
 * a linked firm, or any company for the platform SUPER_ADMIN. For everyone else the
 * target firm's subscription must also be usable (not suspended / expired).
 * Returns false when the company does not exist.
 */
export async function assertFirmAccess(req: Request, cid: string): Promise<boolean> {
  const user = await sessionUser(req)
  if (user.role === PLATFORM_ROLE) {
    return !!(await db.company.findUnique({ where: { id: cid }, select: { id: true } }))
  }
  if (cid !== user.companyId && !(await linkedFirmIds(req)).has(cid)) {
    throw new ApiError('You do not have access to this company', 403)
  }
  const company = await db.company.findUnique({
    where: { id: cid },
    select: { id: true, isPlatform: true, status: true, paidUntil: true, trialEndsAt: true },
  })
  if (!company) return false
  const blocked = accessProblem(company)
  if (blocked) throw new ApiError(blocked, 403)
  return true
}

/**
 * Tenant for this request: the requested company (body, then ?companyId, then the
 * x-company-id header), defaulting to the user's own company. Users are pinned to their
 * home company plus any linked firms; only the platform SUPER_ADMIN may open any company.
 */
export async function resolveCompanyId(req: Request, bodyCompanyId?: string): Promise<string | null> {
  const user = await sessionUser(req)
  const { searchParams } = new URL(req.url)
  const cid = bodyCompanyId || searchParams.get('companyId') || req.headers.get('x-company-id') || user.companyId
  return (await assertFirmAccess(req, cid)) ? cid : null
}

export function companyRequired(req: Request, bodyCompanyId?: string): Promise<string> {
  return resolveCompanyId(req, bodyCompanyId).then((c) => {
    if (!c) throw new ApiError('companyId is required (valid tenant id)', 400)
    return c
  })
}

export class ApiError extends Error {
  status: number
  /** Machine-readable code for the client (e.g. NEGATIVE_CASH, POSSIBLE_DUPLICATE); 'ERR' when not set. */
  code: string
  details?: unknown
  constructor(message: string, status = 400, code = 'ERR', details?: unknown) {
    super(message)
    this.status = status
    this.code = code
    this.details = details
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

/**
 * Enforce role-based READ access to financial data (Phase 5): the role must have at least one of `moduleKeys`
 * (existing module permissions — nothing new is granted). Throws 401 / 403.
 */
export function requireRead(req: Request, moduleKeys: string | string[]): RequestActor {
  const actor = getActor(req)
  if (!actor) throw new ApiError('Unauthorized — sign in to continue', 401)
  const keys = Array.isArray(moduleKeys) ? moduleKeys : [moduleKeys]
  if (!keys.some((k) => canAccessModule(actor.role, k))) throw new ApiError('Your role cannot view this information', 403)
  return actor
}

/** Sensitive financial reports (P&L, balance sheet, trial balance, cash flow, daybook, transactions, profitability). */
export function requireFinancialReports(req: Request): RequestActor {
  const actor = getActor(req)
  if (!actor) throw new ApiError('Unauthorized — sign in to continue', 401)
  if (!canSeeFinancialReports(actor.role)) throw new ApiError('Your role cannot view financial reports', 403)
  return actor
}

export function handleError(e: unknown) {
  if (e instanceof ApiError) return fail(e.message, e.status, e.code, e.details)
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
  SRET: 'CN', PRET: 'DBN', // sales return = credit note, purchase return = debit note
  ATX: 'ATX', // cash & bank entries (adjustments, contra, loans)
}

/** Prefix for a document type: the company's override (Settings → Document Numbering) or the default. */
async function docPrefix(client: { company: { findUnique: (a: never) => Promise<{ docPrefixes: string | null } | null> } }, companyId: string, docType: string): Promise<string> {
  try {
    const c = await client.company.findUnique({ where: { id: companyId }, select: { docPrefixes: true } } as never)
    const map = c?.docPrefixes ? (JSON.parse(c.docPrefixes) as Record<string, string>) : {}
    const p = typeof map[docType] === 'string' ? map[docType].trim() : ''
    if (p) return p
  } catch { /* malformed setting → default */ }
  return DOC_PREFIX[docType] || docType
}

/**
 * Atomically generate next document number for (companyId, docType, FY).
 * Must be called inside the same transaction/interactive tx as record creation.
 */
export async function nextDocNumber(tx: {
  company: { findUnique: (a: never) => Promise<{ docPrefixes: string | null } | null> }
  numberSeq: {
    findUnique: (a: never) => Promise<{ nextNumber: number } | null>
    updateMany: (a: never) => Promise<{ count: number }>
    create: (a: never) => Promise<unknown>
  }
  $queryRaw: (query: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>
}, companyId: string, docType: string, date: Date = new Date()): Promise<string> {
  const fy = financialYearOf(date)
  // Everything goes through the caller's transaction (CB-R1): reading through the global client from inside a
  // transaction needs a second pool connection, so a burst of documents the size of the pool used to time out.
  const prefix = await docPrefix(tx, companyId, docType)
  const where = { companyId_docType_financialYear: { companyId, docType, financialYear: fy } }
  // First number of a (company, docType, FY): created inside the transaction. Concurrent first documents of the
  // company queue on its Company row (FOR UPDATE), then re-check with a locking (current) read — so exactly one
  // creates the counter and nobody races on the unique key (a plain concurrent INSERT IGNORE deadlocks in InnoDB).
  // A rolled-back transaction leaves no counter row behind.
  if (!(await tx.numberSeq.findUnique({ where } as never))) {
    await tx.$queryRaw`SELECT id FROM Company WHERE id = ${companyId} FOR UPDATE`
    const existing = await tx.$queryRaw`SELECT id FROM NumberSeq WHERE companyId = ${companyId} AND docType = ${docType} AND financialYear = ${fy} FOR UPDATE` as unknown[]
    if (!existing.length) await tx.numberSeq.create({ data: { companyId, docType, prefix, financialYear: fy, nextNumber: 1 } } as never)
  }
  // Increment under the row lock (a plain UPDATE reads the latest committed row, unlike the
  // transaction's snapshot), then read our own write back: each transaction gets a distinct number.
  const bumped = await tx.numberSeq.updateMany({ where: { companyId, docType, financialYear: fy }, data: { nextNumber: { increment: 1 } } } as never)
  if (bumped.count !== 1) throw new ApiError('Document numbering is busy — please try again', 503)
  const seq = await tx.numberSeq.findUnique({ where } as never)
  const n = (seq?.nextNumber ?? 1) - 1
  return `${prefix}-${fy}-${String(n).padStart(6, '0')}`
}

// ============ GST helpers ============

export interface TaxLine {
  qty: number; rate: number; discountPct?: number; gstRate: number; cessRate?: number
}

/**
 * Compute per-line taxable value and tax split. interState => IGST, else CGST+SGST.
 *
 * Every line is rounded to paise and the document totals are the sum of those rounded lines, so the
 * printed lines, the stored totals and the reports always agree to the paisa (an invoice whose
 * line column summed to a different value than its taxable total would fail GSTR-1 matching).
 * The intra-state split gives an odd paisa to SGST, so CGST + SGST is exactly the line's tax.
 */
/** Largest quantity / rate a line may carry, and the largest line value (₹10,000 crore): far beyond any
 *  real bill, and small enough that every total stays exact in paise (2^53 paise ≈ ₹90 lakh crore). */
export const MAX_LINE_QTY = 1e9
export const MAX_LINE_RATE = 1e9
export const MAX_LINE_VALUE = 1e11

/**
 * Reject line values no bill can have before they reach the totals: a discount above 100 % turned a
 * line negative (a negative taxable value and a negative bill), and a huge quantity silently lost
 * paise. Sign rules for qty / rate stay with each route (returns, zero-rate lines).
 */
export function assertTaxLines(lines: TaxLine[]) {
  lines.forEach((l, i) => {
    const n = i + 1
    const pct = (v: unknown, what: string) => {
      const x = Number(v ?? 0)
      if (!Number.isFinite(x) || x < 0 || x > 100) throw new ApiError(`Line ${n}: ${what} must be between 0 and 100 %`, 400)
    }
    pct(l.discountPct, 'discount')
    pct(l.gstRate, 'GST rate')
    pct(l.cessRate, 'cess rate')
    if (!Number.isFinite(l.qty) || Math.abs(l.qty) > MAX_LINE_QTY) throw new ApiError(`Line ${n}: quantity is not a usable number (max ${MAX_LINE_QTY.toLocaleString('en-IN')})`, 400)
    if (!Number.isFinite(l.rate) || Math.abs(l.rate) > MAX_LINE_RATE) throw new ApiError(`Line ${n}: rate is not a usable number (max ${MAX_LINE_RATE.toLocaleString('en-IN')})`, 400)
    if (Math.abs(l.qty * l.rate) > MAX_LINE_VALUE) throw new ApiError(`Line ${n}: value above ₹${MAX_LINE_VALUE.toLocaleString('en-IN')} — split it across documents`, 400)
  })
}

export function computeGst(lines: TaxLine[], interState: boolean) {
  assertTaxLines(lines)
  let subtotal = 0, discountTotal = 0, cgst = 0, sgst = 0, igst = 0
  const computed = lines.map((l) => {
    const gross = r2(l.qty * l.rate)
    const disc = r2(gross * ((l.discountPct || 0) / 100))
    const taxable = r2(gross - disc)
    const tax = r2(taxable * (l.gstRate / 100))
    subtotal = r2(subtotal + gross)
    discountTotal = r2(discountTotal + disc)
    if (interState) igst = r2(igst + tax)
    else {
      const half = r2(tax / 2)
      cgst = r2(cgst + half)
      sgst = r2(sgst + (tax - half))
    }
    return { ...l, taxable, tax }
  })
  const grandTotal = r2(subtotal - discountTotal + cgst + sgst + igst)
  return { computed, subtotal, discountTotal, cgst, sgst, igst, grandTotal }
}

export const r2 = (n: number) => Math.round(n * 100) / 100

export interface BillAdjustments {
  billDiscount?: number // flat ₹ off the bill, spread across lines before GST
  freight?: { amount: number; gstRate: number }
  packing?: { amount: number; gstRate: number }
  roundOff?: boolean // round grand total to the rupee
}

/**
 * Full bill totals: line discounts, bill discount (pro-rata on line taxable values, so GST is on the
 * discounted value), freight / packing as taxable charges, CGST+SGST or IGST, optional round-off.
 * `computed[i].taxable` is the line's final taxable value (store it as lineTotal).
 *
 * Paisa-exact by construction:
 *  • every line's taxable value is rounded once, and the bill discount is distributed with the
 *    largest-remainder method — so Σ line taxable === bill taxable (no 1-paisa drift between the
 *    printed line column and the total, which is what a GSTR-1 comparison trips over),
 *  • tax and cess are computed from that rounded line value, and the intra-state split keeps
 *    CGST + SGST === the line's tax exactly,
 *  • the grand total is the sum of the stored line values + the rounded charges, so print, saved row
 *    and reports all read the same number.
 */
export function computeBillTotals(lines: TaxLine[], interState: boolean, adj: BillAdjustments = {}) {
  assertTaxLines(lines)
  for (const [what, c] of [['freight', adj.freight], ['packing', adj.packing]] as const) {
    if (!c) continue
    if (!Number.isFinite(c.amount) || c.amount < 0 || c.amount > MAX_LINE_VALUE) throw new ApiError(`${what} charge is not a usable amount`, 400)
    if (!Number.isFinite(c.gstRate ?? 18) || (c.gstRate ?? 18) < 0 || (c.gstRate ?? 18) > 100) throw new ApiError(`${what} GST rate must be between 0 and 100 %`, 400)
  }
  const round2 = (n: number) => Math.round(n * 100) / 100
  const cents = (n: number) => Math.round(n * 100)
  let subtotalC = 0, lineDiscC = 0
  const pre = lines.map((l) => {
    const gross = round2(l.qty * l.rate)
    const disc = round2(gross * ((l.discountPct || 0) / 100))
    subtotalC += cents(gross)
    lineDiscC += cents(disc)
    return { ...l, base: round2(gross - disc) }
  })
  const baseSumC = pre.reduce((s, l) => s + cents(l.base), 0)
  // A bill discount can never exceed the taxable value of the bill
  const billDiscountC = Math.min(Math.max(0, cents(adj.billDiscount || 0)), baseSumC)

  // 1. pro-rata share of the bill discount per line, kept in paise (integers, no float drift)
  const share = pre.map((l) => (baseSumC > 0 ? Math.round((cents(l.base) * billDiscountC) / baseSumC) : 0))
  const shareSum = share.reduce((s, n) => s + n, 0)
  // 2. largest-remainder: hand the leftover paise to the lines with the biggest cut-down fraction
  let leftover = billDiscountC - shareSum
  if (leftover !== 0) {
    const frac = pre.map((l, i) => {
      const exact = baseSumC > 0 ? (cents(l.base) * billDiscountC) / baseSumC : 0
      return { i, rem: exact - share[i] }
    })
    const order = leftover > 0
      ? frac.sort((a, b) => b.rem - a.rem || b.i - a.i)
      : frac.sort((a, b) => a.rem - b.rem || b.i - a.i)
    const step = leftover > 0 ? 1 : -1
    for (let k = 0; leftover !== 0; k++) {
      const idx = order[k % order.length].i
      share[idx] += step
      leftover -= step
    }
  }

  let cgstC = 0, sgstC = 0, igstC = 0, cessC = 0, taxableTotalC = 0
  const addTax = (taxC: number) => {
    if (interState) igstC += taxC
    else {
      const half = Math.round(taxC / 2) // an odd paisa goes to CGST; CGST + SGST === the line's tax
      cgstC += half
      sgstC += taxC - half
    }
  }
  const computed = pre.map(({ base, ...l }, i) => {
    const lineC = cents(base) - share[i] // this line's final taxable value, in paise
    const taxC = Math.round((lineC * (l.gstRate || 0)) / 100)
    const cessLineC = Math.round((lineC * (l.cessRate || 0)) / 100)
    taxableTotalC += lineC
    addTax(taxC)
    cessC += cessLineC
    return { ...l, taxable: lineC / 100, tax: taxC / 100, cess: cessLineC / 100 }
  })

  const charge = (c?: { amount: number; gstRate: number }) => {
    const amountC = Math.max(0, cents(c?.amount || 0))
    if (amountC) addTax(Math.round(amountC * ((c?.gstRate ?? 18) / 100)))
    return amountC / 100
  }
  const freight = charge(adj.freight)
  const packing = charge(adj.packing)

  const exactC = taxableTotalC + cents(freight) + cents(packing) + cgstC + sgstC + igstC + cessC
  const grandC = adj.roundOff ? Math.round(exactC / 100) * 100 : exactC
  return {
    computed,
    subtotal: subtotalC / 100,
    discountTotal: (lineDiscC + billDiscountC) / 100,
    billDiscount: billDiscountC / 100,
    freight,
    packing,
    cgst: cgstC / 100,
    sgst: sgstC / 100,
    igst: igstC / 100,
    cess: cessC / 100,
    roundOff: (grandC - exactC) / 100,
    grandTotal: grandC / 100,
  }
}

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
  // Services (repair, labour, consultancy) have no stock — no ledger row, no balance check
  const kind = await (tx as unknown as { item: { findUnique: (a: unknown) => Promise<{ type: string } | null> } }).item.findUnique({ where: { id: input.itemId }, select: { type: true } })
  if (kind?.type === 'SERVICE') return 0
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
      type: input.type, qtyIn, qtyOut, rate,
      // Cost of the goods leaving = the average before this movement (outward rows don't change the average)
      costRate: qtyOut > 0 ? prevRate : null,
      refType: input.refType, refId: input.refId,
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
