import { createHash } from 'node:crypto'
import { amountToPaise } from '@/lib/tally/layer1'
import { monthRanges, type DateRange } from '@/lib/tally/period'

/**
 * Tally vouchers, Layer 1 — the rules that do not need the database (Phase F design; docs/tally-vouchers-design.md).
 *
 *  - identity: which stored voucher a voucher from Tally is (GUID → MASTERID → natural key), never content-based
 *    unless nothing else exists;
 *  - contentHash: whether a re-read brought different content (then a new revision is written);
 *  - normaliseVoucher: Tally's record → header + accounting lines + inventory lines + bill allocations, amounts in
 *    paise with Tally's sign, raw text kept;
 *  - read slices and completeness: a period is read in slices (months; days if a month is too large); it is complete
 *    only when every slice was read AND staged. Only then may unseen vouchers be marked missing.
 *
 * NOTE: the record shape below is what the connector is planned to send. Tally's real voucher Export has not been
 * captured yet; field names follow Tally's object XML (tag names seen in a Tally-format voucher file).
 */

export interface TallyVoucherRecord {
  guid?: string
  masterId?: string
  alterId?: string
  date?: string // YYYYMMDD as Tally writes it
  effectiveDate?: string
  voucherType?: string
  voucherNumber?: string
  reference?: string
  referenceDate?: string
  partyLedger?: string
  narration?: string
  isCancelled?: string // Yes | No
  isOptional?: string
  isInvoice?: string
  extra?: Record<string, string> // other header fields (place of supply, party GSTIN, …)
  ledgerEntries?: TallyLedgerEntry[]
  inventoryEntries?: TallyInventoryEntry[]
}
export interface TallyLedgerEntry {
  ledgerName?: string
  amount?: string
  isDeemedPositive?: string
  isPartyLedger?: string
  bills?: { name?: string; billType?: string; amount?: string; extra?: Record<string, string> }[]
  extra?: Record<string, string>
}
export interface TallyInventoryEntry {
  stockItemName?: string
  actualQty?: string // "5 Nos"
  billedQty?: string
  rate?: string // "100.00/Nos"
  amount?: string
  isDeemedPositive?: string
  batches?: Record<string, string>[] // godown / batch allocations as sent
  accountingAllocations?: TallyLedgerEntry[]
  extra?: Record<string, string>
}

export interface VoucherIssue { code: string; message: string }

// ---------------------------------------------------------------- small parsers

const yes = (v?: string) => (v === undefined || v === '' ? null : /^yes$/i.test(v.trim()))
const tallyDate = (s?: string) => (s && /^\d{8}$/.test(s.trim()) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : null)
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

/** "5 Nos" / "2.5 Kg" / "-3 Nos" → { qty: '5', unit: 'Nos' }; anything else → null. Decimal kept as text (no float). */
export function parseQty(s?: string): { qty: string; unit: string | null } | null {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*([^\d\s][^\s]*(?:\s[^\d\s][^\s]*)*)?\s*$/.exec(s ?? '')
  if (!m) return null
  return { qty: m[1], unit: m[2]?.replace(/\.$/, '') || null }
}

/** "100.00/Nos" → { paise: 10000, unit: 'Nos' }; a rate without a unit is accepted too. */
export function parseRate(s?: string): { paise: number; unit: string | null } | null {
  const m = /^\s*([-\d,.]+)\s*(?:\/\s*(.+?))?\s*$/.exec(s ?? '')
  if (!m) return null
  const paise = amountToPaise(m[1])
  return paise === null ? null : { paise, unit: m[2]?.replace(/\.$/, '') || null }
}

// ---------------------------------------------------------------- identity

/**
 * Which stored voucher this is, strongest first:
 *  1. GUID                               → 'g:<guid>'
 *  2. MASTERID (Tally's per-company id)  → 'm:<masterId>'
 *  3. natural key, when there is a voucher number: type + number + date (no amounts, so changed content keeps it)
 *  4. nothing stable: type + date + party + content hash (+ #n for identical vouchers in one read) — flagged
 * naturalKey (3) is stored for every voucher so a later read that brings a GUID can find and adopt the earlier row.
 */
export function voucherIdentity(r: TallyVoucherRecord, contentHash: string, occurrence = 1) {
  const issues: VoucherIssue[] = []
  const type = (r.voucherType ?? '').trim()
  const number = (r.voucherNumber ?? '').trim()
  const date = (r.date ?? '').trim()
  const naturalKey = sha256(`${type}\u0000${number}\u0000${date}`)
  const guid = (r.guid ?? '').trim()
  const masterId = /^\d{1,9}$/.test((r.masterId ?? '').trim()) ? (r.masterId ?? '').trim() : ''
  if (guid) return { identity: `g:${guid}`.slice(0, 100), source: 'guid' as const, naturalKey, stable: true, issues }
  issues.push({ code: 'no_guid', message: 'Tally sent no GUID for this voucher.' })
  if (masterId) return { identity: `m:${masterId}`, source: 'masterid' as const, naturalKey, stable: true, issues }
  if (number) return { identity: `n:${naturalKey}`, source: 'natural' as const, naturalKey, stable: true, issues }
  issues.push({ code: 'no_stable_identity', message: 'No GUID, MASTERID or voucher number: a changed copy of this voucher cannot be told from a new one.' })
  const weak = sha256(`${type}\u0000${date}\u0000${(r.partyLedger ?? '').trim()}\u0000${contentHash}\u0000${occurrence}`)
  return { identity: `c:${weak}`, source: 'content' as const, naturalKey, stable: false, issues }
}

// ---------------------------------------------------------------- normalise + hash

export interface NormalisedVoucher {
  header: {
    guid: string | null; masterId: number | null; alterId: number | null; voucherType: string; voucherNumber: string | null
    date: string | null; effectiveDate: string | null; reference: string | null; referenceDate: string | null; partyLedger: string | null
    narration: string | null; isCancelled: boolean; isOptional: boolean; isInvoice: boolean
    sumPositivePaise: number; sumNegativePaise: number; data: Record<string, string>
  }
  lines: { seq: number; source: 'ledger' | 'inventory'; inventorySeq: number | null; ledgerName: string; amountPaise: number; isDeemedPositive: boolean | null; isPartyLedger: boolean | null; data: Record<string, string> }[]
  inventory: {
    seq: number; stockItemName: string; actualQty: string | null; billedQty: string | null; unit: string | null; ratePaise: number | null
    rateUnit: string | null; amountPaise: number | null; isDeemedPositive: boolean | null; godownName: string | null; data: Record<string, unknown>
  }[]
  bills: { lineSeq: number; seq: number; ledgerName: string; billName: string; billType: string | null; amountPaise: number | null; data: Record<string, string> }[]
  issues: VoucherIssue[]
}

const int = (s?: string) => (s && /^\s*\d{1,9}\s*$/.test(s) ? Number(s) : null)
const text = (s?: string) => (s && s.trim() ? s.trim() : null)

/** Tally record → what is stored. Lines are numbered in the order Tally sent them, per revision. */
export function normaliseVoucher(r: TallyVoucherRecord): NormalisedVoucher {
  const issues: VoucherIssue[] = []
  const lines: NormalisedVoucher['lines'] = []
  const inventory: NormalisedVoucher['inventory'] = []
  const bills: NormalisedVoucher['bills'] = []
  const date = tallyDate(r.date)
  if (!date) issues.push({ code: 'bad_date', message: 'The voucher date is missing or not a date.' })
  const amount = (s: string | undefined, where: string) => {
    const p = s && s.trim() ? amountToPaise(s) : 0
    if (p === null) issues.push({ code: 'bad_amount', message: `An amount (${where}) is not a plain signed amount.` })
    return p
  }
  const addLine = (e: TallyLedgerEntry, source: 'ledger' | 'inventory', inventorySeq: number | null) => {
    const seq = lines.length + 1
    const ledgerName = text(e.ledgerName) ?? ''
    if (!ledgerName) issues.push({ code: 'no_ledger', message: `Accounting line ${seq} names no ledger.` })
    lines.push({ seq, source, inventorySeq, ledgerName, amountPaise: amount(e.amount, `line ${seq}`) ?? 0, isDeemedPositive: yes(e.isDeemedPositive), isPartyLedger: yes(e.isPartyLedger), data: { ...(e.extra ?? {}), ...(e.amount ? { amountText: e.amount } : {}) } })
    ;(e.bills ?? []).forEach((b, i) => bills.push({
      lineSeq: seq, seq: i + 1, ledgerName, billName: text(b.name) ?? '', billType: text(b.billType), amountPaise: b.amount ? amount(b.amount, `bill on line ${seq}`) : null, data: b.extra ?? {},
    }))
  }
  for (const e of r.ledgerEntries ?? []) addLine(e, 'ledger', null)
  ;(r.inventoryEntries ?? []).forEach((e, i) => {
    const seq = i + 1
    const q = parseQty(e.actualQty)
    const bq = parseQty(e.billedQty)
    const rate = parseRate(e.rate)
    if (e.actualQty && !q) issues.push({ code: 'bad_quantity', message: `The quantity of inventory line ${seq} is not understood.` })
    if (e.rate && !rate) issues.push({ code: 'bad_rate', message: `The rate of inventory line ${seq} is not understood.` })
    inventory.push({
      seq, stockItemName: text(e.stockItemName) ?? '', actualQty: q?.qty ?? null, billedQty: bq?.qty ?? null, unit: q?.unit ?? bq?.unit ?? null,
      ratePaise: rate?.paise ?? null, rateUnit: rate?.unit ?? null, amountPaise: e.amount ? amount(e.amount, `inventory line ${seq}`) : null,
      isDeemedPositive: yes(e.isDeemedPositive), godownName: text(e.batches?.[0]?.godownName),
      data: { ...(e.extra ?? {}), batches: e.batches ?? [], qtyText: e.actualQty ?? null, billedQtyText: e.billedQty ?? null, rateText: e.rate ?? null },
    })
    for (const a of e.accountingAllocations ?? []) addLine(a, 'inventory', seq)
  })
  const sumPositivePaise = lines.reduce((s, l) => s + (l.amountPaise > 0 ? l.amountPaise : 0), 0)
  const sumNegativePaise = lines.reduce((s, l) => s + (l.amountPaise < 0 ? l.amountPaise : 0), 0)
  if (lines.length && sumPositivePaise + sumNegativePaise !== 0) issues.push({ code: 'not_balanced', message: 'The accounting lines of this voucher do not add up to zero.' })
  return {
    header: {
      guid: text(r.guid), masterId: int(r.masterId), alterId: int(r.alterId), voucherType: text(r.voucherType) ?? '', voucherNumber: text(r.voucherNumber),
      date, effectiveDate: tallyDate(r.effectiveDate), reference: text(r.reference), referenceDate: tallyDate(r.referenceDate), partyLedger: text(r.partyLedger),
      narration: text(r.narration), isCancelled: yes(r.isCancelled) === true, isOptional: yes(r.isOptional) === true, isInvoice: yes(r.isInvoice) === true,
      sumPositivePaise, sumNegativePaise, data: r.extra ?? {},
    },
    lines, inventory, bills, issues,
  }
}

/**
 * SHA-256 of everything that describes the voucher's content, in the order Tally sent it. Identity fields are left
 * out: GUID / MASTERID (a voucher that gains a GUID is not a changed voucher) and ALTERID (Tally can re-save a voucher
 * without changing it). Line order is kept in (a reordered voucher is a new revision — lines are never matched across
 * revisions).
 */
export function contentHash(v: NormalisedVoucher): string {
  const { guid: _g, masterId: _m, alterId: _a, ...header } = v.header
  return sha256(JSON.stringify([header, v.lines, v.inventory, v.bills]))
}

// ---------------------------------------------------------------- read slices and completeness

export type SliceStatus = 'pending' | 'reading' | 'read' | 'staged' | 'failed' | 'cancelled'
export interface ReadSlice extends DateRange { status: SliceStatus; jobId: string | null; attempts: number }

/** A period is read one month at a time. */
export function planSlices(period: DateRange): ReadSlice[] {
  return monthRanges(period).map((m) => ({ ...m, status: 'pending', jobId: null, attempts: 0 }))
}

/** A month too large for one read is replaced by one slice per day (same dates, nothing lost or doubled). */
export function splitSlice(slices: ReadSlice[], index: number): ReadSlice[] {
  const s = slices[index]
  const days: ReadSlice[] = []
  for (let d = new Date(`${s.from}T00:00:00Z`); d.toISOString().slice(0, 10) <= s.to; d.setUTCDate(d.getUTCDate() + 1)) {
    const day = d.toISOString().slice(0, 10)
    days.push({ from: day, to: day, status: 'pending', jobId: null, attempts: 0 })
  }
  return [...slices.slice(0, index), ...days, ...slices.slice(index + 1)]
}

/** Do the slices cover the period exactly, with no gap or overlap? */
export function coversExactly(period: DateRange, slices: DateRange[]): boolean {
  const sorted = [...slices].sort((a, b) => a.from.localeCompare(b.from))
  if (!sorted.length || sorted[0].from !== period.from || sorted[sorted.length - 1].to !== period.to) return false
  for (let i = 1; i < sorted.length; i++) {
    const next = new Date(`${sorted[i - 1].to}T00:00:00Z`)
    next.setUTCDate(next.getUTCDate() + 1)
    if (next.toISOString().slice(0, 10) !== sorted[i].from) return false
  }
  return true
}

/**
 * The read is complete — and only then may vouchers of the period that it did not see be marked missing — when the
 * slices cover the whole period AND every slice was read and staged. Any slice pending, reading, read-but-not-staged,
 * failed (error, timeout, too large) or cancelled → not complete.
 */
export function readComplete(period: DateRange, slices: ReadSlice[]): boolean {
  return coversExactly(period, slices) && slices.every((s) => s.status === 'staged')
}
