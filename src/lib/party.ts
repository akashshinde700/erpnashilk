import { db } from '@/lib/db'
import { ApiError } from '@/lib/erp-helpers'

/**
 * Shared field handling for the Customer and Supplier masters ("parties").
 * Returns only the fields present in the body (update) or all of them with defaults (create),
 * validated and normalised. code/name/status stay with the routes.
 */

const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/
const PAN_RE = /^[A-Z]{5}\d{4}[A-Z]$/
const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const GST_TYPES = ['REGULAR', 'COMPOSITION', 'UNREGISTERED', 'CONSUMER', 'OVERSEAS', 'SEZ']
const GSTIN_NEEDED: Record<string, string> = { REGULAR: 'Regular', COMPOSITION: 'Composition', SEZ: 'SEZ' }

const text = (v: unknown): string | null => {
  if (v === undefined || v === null) return null
  const s = String(v).trim()
  return s === '' ? null : s
}

/** Indian mobile/landline: keep digits, drop a leading 91 / 0 when it makes 10 digits. */
function phone(v: unknown, label: string): string | null {
  const s = text(v)
  if (!s) return null
  let d = s.replace(/\D/g, '')
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2)
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1)
  if (d.length !== 10) throw new ApiError(`${label} must be a 10-digit number`, 400)
  return d
}

function num(v: unknown, label: string, opts: { min?: number; int?: boolean } = {}): number {
  const n = Number(v)
  if (!Number.isFinite(n)) throw new ApiError(`${label} must be a number`, 400)
  if (opts.min !== undefined && n < opts.min) throw new ApiError(`${label} cannot be less than ${opts.min}`, 400)
  return opts.int ? Math.round(n) : Math.round(n * 100) / 100
}

type Body = Record<string, unknown>

export function partyData(body: Body, mode: 'create' | 'update') {
  const has = (k: string) => mode === 'create' || body[k] !== undefined
  const out: Record<string, string | number | null> = {}

  if (has('gstin')) {
    const g = text(body.gstin)?.toUpperCase().replace(/\s/g, '') ?? null
    if (g && !GSTIN_RE.test(g)) throw new ApiError('GSTIN is not valid (15 characters, e.g. 27ABCDE1234F1Z5)', 400)
    out.gstin = g
  }
  if (has('pan')) {
    const p = text(body.pan)?.toUpperCase() ?? null
    if (p && !PAN_RE.test(p)) throw new ApiError('PAN must be 5 letters, 4 digits, 1 letter', 400)
    out.pan = p
  }
  // GSTIN carries the state code (chars 1-2) and PAN (chars 3-12): fill them when not given.
  if (typeof out.gstin === 'string') {
    if (!text(body.pan)) out.pan = out.gstin.slice(2, 12)
    if (!text(body.stateCode)) out.stateCode = out.gstin.slice(0, 2)
  }
  if (has('gstType')) {
    const t = text(body.gstType)?.toUpperCase() ?? null
    if (t && !GST_TYPES.includes(t)) throw new ApiError('GST type must be one of Regular, Composition, Unregistered, Consumer, Overseas, SEZ', 400)
    // Default on create (or when cleared): registered when a GSTIN is given.
    const type = t ?? (typeof out.gstin === 'string' ? 'REGULAR' : 'UNREGISTERED')
    // Only enforced when the GSTIN is part of this request (an update may change just the type).
    if (GSTIN_NEEDED[type] && out.gstin === null) throw new ApiError(`GSTIN is required for ${GSTIN_NEEDED[type]} parties`, 400)
    out.gstType = type
  }
  if (has('stateCode') && out.stateCode === undefined) {
    const sc = text(body.stateCode)
    if (sc && !/^\d{2}$/.test(sc)) throw new ApiError('GST state code must be 2 digits', 400)
    out.stateCode = sc
  }

  for (const k of ['nickName', 'contactPerson', 'addressLine', 'addressLine2', 'city', 'state', 'shippingAddress', 'bankName', 'bankBranch', 'notes']) {
    if (has(k)) out[k] = text(body[k])
  }
  if (has('country')) out.country = text(body.country) || 'India'
  if (has('phone')) out.phone = phone(body.phone, 'Phone')
  if (has('altPhone')) out.altPhone = phone(body.altPhone, 'Alt phone')
  if (has('email')) {
    const e = text(body.email)?.toLowerCase() ?? null
    if (e && !EMAIL_RE.test(e)) throw new ApiError('Enter a valid email address', 400)
    out.email = e
  }
  if (has('pincode')) {
    const p = text(body.pincode)
    if (p && !/^\d{6}$/.test(p)) throw new ApiError('Pincode must be 6 digits', 400)
    out.pincode = p
  }
  if (has('bankIfsc')) {
    const i = text(body.bankIfsc)?.toUpperCase() ?? null
    if (i && !IFSC_RE.test(i)) throw new ApiError('IFSC must be 11 characters, e.g. HDFC0001234', 400)
    out.bankIfsc = i
  }
  if (has('bankAccountNo')) {
    const a = text(body.bankAccountNo)?.replace(/\s/g, '') ?? null
    if (a && !/^\d{6,18}$/.test(a)) throw new ApiError('Bank account number must be 6–18 digits', 400)
    out.bankAccountNo = a
  }
  // Tally ledger name: the account this party is posted to in Tally (blank = use the party name).
  if (has('tallyLedgerName')) {
    const ledger = text(body.tallyLedgerName)
    if (ledger && ledger.length > 100) throw new ApiError('Tally ledger name must be 100 characters or fewer', 400)
    out.tallyLedgerName = ledger
  }
  if (has('paymentTermsDays')) out.paymentTermsDays = body.paymentTermsDays === undefined || body.paymentTermsDays === '' || body.paymentTermsDays === null ? 30 : num(body.paymentTermsDays, 'Credit days', { min: 0, int: true })
  if (has('creditLimit')) out.creditLimit = body.creditLimit === undefined || body.creditLimit === '' || body.creditLimit === null ? 0 : num(body.creditLimit, 'Credit limit', { min: 0 })
  if (has('openingBalance')) out.openingBalance = body.openingBalance === undefined || body.openingBalance === '' || body.openingBalance === null ? 0 : num(body.openingBalance, 'Opening balance')
  return out
}

const partyPrefix = (kind: 'customer' | 'supplier') => (kind === 'customer' ? 'C-' : 'S-')
const partyCode = (prefix: string, n: number) => `${prefix}${String(n).padStart(4, '0')}`

function maxPartyNumber(rows: { code: string }[], prefix: string): number {
  return rows.reduce((m, r) => {
    // case-insensitive like the DB's startsWith filter (default MySQL collation)
    if (!r.code.toUpperCase().startsWith(prefix)) return m
    const n = Number(r.code.slice(prefix.length))
    return Number.isInteger(n) && n > m ? n : m
  }, 0)
}

/** Next free party code for a company: C-0001… for customers, S-0001… for suppliers. */
export async function nextPartyCode(companyId: string, kind: 'customer' | 'supplier'): Promise<string> {
  const prefix = partyPrefix(kind)
  const where = { companyId, code: { startsWith: prefix } }
  const rows = kind === 'customer'
    ? await db.customer.findMany({ where, select: { code: true } })
    : await db.supplier.findMany({ where, select: { code: true } })
  return partyCode(prefix, maxPartyNumber(rows, prefix) + 1)
}

/**
 * Bulk form of nextPartyCode for imports: reads the company's codes once, then hands out
 * the same C-0001 / S-0001 series in order, skipping any code already taken (case-insensitive).
 */
export async function partyCodeAllocator(companyId: string, kind: 'customer' | 'supplier') {
  const prefix = partyPrefix(kind)
  const rows = kind === 'customer'
    ? await db.customer.findMany({ where: { companyId }, select: { code: true } })
    : await db.supplier.findMany({ where: { companyId }, select: { code: true } })
  const inDb = new Set(rows.map((r) => r.code.toUpperCase()))
  const taken = new Set(inDb)
  let n = maxPartyNumber(rows, prefix)
  return {
    /** Code already used by a saved party. */
    exists: (code: string) => inDb.has(code.toUpperCase()),
    /** Mark a code as used (saved, reserved or handed out) so next() never returns it. */
    take: (code: string) => { taken.add(code.toUpperCase()) },
    next: () => {
      let code = partyCode(prefix, ++n)
      while (taken.has(code.toUpperCase())) code = partyCode(prefix, ++n)
      taken.add(code.toUpperCase())
      return code
    },
  }
}

/**
 * Fields shared by the two halves of a "Both" party (customer + linked supplier).
 * Opening balance and credit limit are per side; code and status stay per record.
 */
const SIDE_ONLY = new Set(['openingBalance', 'creditLimit', 'code', 'status'])
export function sharedProfile(data: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(data).filter(([k, v]) => !SIDE_ONLY.has(k) && v !== undefined))
}

/** Copyable profile of an existing customer/supplier row (for linking it as "Both"). */
export const PROFILE_KEYS = [
  'name', 'nickName', 'gstin', 'pan', 'contactPerson', 'phone', 'altPhone', 'email',
  'addressLine', 'addressLine2', 'city', 'state', 'stateCode', 'pincode', 'country',
  'bankIfsc', 'bankName', 'bankAccountNo', 'bankBranch', 'paymentTermsDays', 'notes',
  'gstType', 'shippingAddress', 'tallyLedgerName',
] as const

/** The company's walk-in "Cash Sale" customer (created on first use). */
export async function cashSaleCustomer(tx: { customer: { findFirst: (a: never) => Promise<{ id: string; name: string } | null>; create: (a: never) => Promise<{ id: string; name: string }> } }, companyId: string) {
  const found = await tx.customer.findFirst({ where: { companyId, code: 'CASH' }, select: { id: true, name: true } } as never)
  if (found) return found
  return tx.customer.create({
    data: { companyId, code: 'CASH', name: 'Cash Sale', gstType: 'CONSUMER', paymentTermsDays: 0, notes: 'Walk-in / counter sales' },
    select: { id: true, name: true },
  } as never)
}
