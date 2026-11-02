import { Prisma } from '@prisma/client'
import { joinSerials, parseSerials } from '@/lib/batches'
import { ApiError, r2 } from '@/lib/erp-helpers'

/**
 * Incoming QC ↔ GRN rules, shared by the QC and GRN routes.
 *
 * Each GRN line has one INCOMING inspection (QcInspection.grnItemId). The inspection result is the only source of a
 * line's accepted / rejected qty, and only the accepted qty enters stock:
 *
 *   PENDING_QC → (last inspection result) → QC_COMPLETED → (post) → POSTED
 *
 * Inspections created before grnItemId existed have it empty: they are matched to a line by item AND qty, and linked
 * when next saved. A match that is not certain is refused instead of guessed.
 */

/** Both routes lock the GRN row first and then read what other transactions committed while they waited. */
export const QC_TX = { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted }

/** Quantities are stored rounded to 2 decimals (r2); this is the rounding slack allowed when comparing them. */
export const QC_QTY_TOLERANCE = 0.01

function qtyField(v: unknown, label: string): number {
  const blank = v === undefined || v === null || (typeof v === 'string' && !v.trim())
  const n = typeof v === 'number' || typeof v === 'string' ? Number(v) : NaN
  if (blank || !Number.isFinite(n)) throw new ApiError(`${label} qty must be a number`, 400, 'QC_QTY_INVALID')
  if (n < 0) throw new ApiError(`${label} qty cannot be negative`, 400, 'QC_QTY_INVALID')
  return r2(n)
}

export function qcStatusOf(accepted: number, rejected: number): 'PASSED' | 'FAILED' | 'PARTIAL' {
  if (rejected <= 0) return 'PASSED'
  return accepted <= 0 ? 'FAILED' : 'PARTIAL'
}

/** False for an older result that leaves part of the checked qty unaccounted for: someone has to reconcile it. */
export function qcResultAddsUp(q: { status: string; qtyChecked: number; qtyAccepted: number; qtyRejected: number }) {
  return q.status === 'PENDING' || Math.abs(r2(q.qtyAccepted + q.qtyRejected) - r2(q.qtyChecked)) <= QC_QTY_TOLERANCE
}

/** All inspections have a result and every result adds up: the GRN can be posted. */
export function qcComplete(inspections: { status: string; qtyChecked: number; qtyAccepted: number; qtyRejected: number }[]) {
  return inspections.every((q) => q.status !== 'PENDING' && qcResultAddsUp(q))
}

/**
 * The serials a GRN line keeps after a QC result. Stock takes one serial per accepted unit, so a partly accepted line
 * must name the accepted ones. Rejected serials are not kept on the line: a later correction cannot accept more units
 * than the line still has serials for.
 */
export function serialsAfterResult(item: { code: string; name: string }, lineSerials: string | null, qtyAccepted: number, acceptedSerials: unknown): string | null {
  if (Math.abs(qtyAccepted - Math.round(qtyAccepted)) > 0.0005) throw new ApiError(`${item.code} ${item.name} is serial-tracked — accepted qty must be a whole number`, 400, 'QC_QTY_INVALID')
  if (qtyAccepted === 0) return null
  const onLine = parseSerials(lineSerials)
  if (onLine.length === Math.round(qtyAccepted)) return lineSerials
  if (onLine.length < qtyAccepted) throw new ApiError(`${item.code} ${item.name}: only ${onLine.length} serial no(s) are left on this line, so ${qtyAccepted} cannot be accepted`, 409, 'QC_SERIALS_INVALID')
  const chosen = parseSerials(acceptedSerials as string | string[] | null | undefined)
  const foreign = chosen.find((s) => !onLine.includes(s))
  if (foreign) throw new ApiError(`Serial ${foreign} was not received on this line`, 400, 'QC_SERIALS_INVALID')
  if (chosen.length !== Math.round(qtyAccepted)) throw new ApiError(`Choose exactly ${Math.round(qtyAccepted)} accepted serial no(s) for ${item.code} (got ${chosen.length})`, 400, 'QC_SERIALS_INVALID')
  return joinSerials(chosen)
}

/** Checks a submitted result. Every checked unit must be accepted or rejected; the status follows from the qty. */
export function readQcResult(body: { qtyAccepted?: unknown; qtyRejected?: unknown; status?: unknown }, qtyChecked: number) {
  const qtyAccepted = qtyField(body.qtyAccepted, 'Accepted')
  const qtyRejected = qtyField(body.qtyRejected, 'Rejected')
  const checked = r2(qtyChecked)
  if (qtyAccepted > checked + QC_QTY_TOLERANCE) throw new ApiError(`Accepted qty cannot exceed checked qty ${checked}`, 400, 'QC_QTY_INVALID')
  if (qtyRejected > checked + QC_QTY_TOLERANCE) throw new ApiError(`Rejected qty cannot exceed checked qty ${checked}`, 400, 'QC_QTY_INVALID')
  const total = r2(qtyAccepted + qtyRejected)
  if (Math.abs(total - checked) > QC_QTY_TOLERANCE) {
    const gap = r2(checked - total)
    throw new ApiError(
      gap > 0
        ? `Accepted + rejected must equal checked qty ${checked} — ${gap} is unaccounted for`
        : `Accepted + rejected must equal checked qty ${checked} — it is over by ${r2(-gap)}`,
      400, 'QC_QTY_MISMATCH',
    )
  }
  const status = qcStatusOf(qtyAccepted, qtyRejected)
  if (body.status !== undefined && body.status !== null && body.status !== '' && body.status !== status) {
    throw new ApiError(`Status ${String(body.status)} does not match the quantities — they mean ${status}`, 400, 'QC_STATUS_CONFLICT')
  }
  return { qtyAccepted, qtyRejected, status }
}

interface LineRef { id: string; itemId: string; receivedQty: number; batchNo?: string | null; serials?: string | null }
interface InspectionRef { id: string; number: string; itemId: string; qtyChecked: number; grnItemId?: string | null }

/**
 * Pairs a GRN's inspections with its lines. grnItemId wins. Older inspections pair by item and qty, in creation order;
 * lines that are identical except for a batch or serial list cannot be told apart, so those stay unmatched.
 */
export function matchInspectionsToLines<L extends LineRef, I extends InspectionRef>(lines: L[], inspections: I[]) {
  const byLine = new Map<string, I>()
  const unmatched: I[] = []
  const lineIds = new Set(lines.map((l) => l.id))
  const older: I[] = []
  for (const qc of [...inspections].sort((a, b) => a.number.localeCompare(b.number))) {
    if (!qc.grnItemId) { older.push(qc); continue }
    if (!lineIds.has(qc.grnItemId) || byLine.has(qc.grnItemId)) unmatched.push(qc)
    else byLine.set(qc.grnItemId, qc)
  }
  for (const qc of older) {
    const same = lines.filter((l) => !byLine.has(l.id) && l.itemId === qc.itemId && Math.abs(l.receivedQty - qc.qtyChecked) <= QC_QTY_TOLERANCE)
    const distinct = new Set(same.map((l) => `${l.batchNo || ''}|${l.serials || ''}`))
    if (same.length === 0 || distinct.size > 1) unmatched.push(qc)
    else byLine.set(same[0].id, qc)
  }
  return { byLine, unmatched }
}
