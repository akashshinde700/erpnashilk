import { db } from '@/lib/db'
import { ApiError } from '@/lib/erp-helpers'

/**
 * Go-live (cutover) date: the first day the company's books are kept in ManuFlow.
 *
 * Stored as Company.goLiveDate at UTC midnight of that day — the same convention the reports use for
 * a `from` date (new Date('YYYY-MM-DD')). Imported opening figures are dated at noon UTC of the day
 * before (openingDateFor):
 *  - before the go-live day's UTC midnight → a report for a period starting on the go-live date counts
 *    them as opening values, never as movements of the period;
 *  - before the previous day's local end of day (endOfDayStr), which under TZ=Asia/Kolkata is 18:29:59Z
 *    → an "as at <previous day>" report includes them (one second before midnight UTC would not);
 *  - shown as the previous calendar day both in India (17:30 IST) and in UTC.
 *
 * Once opening stock has been imported against the date it is locked (changing it would leave those
 * ledger rows on the wrong side of the cutover).
 */

/** Stock ledger refNumber prefix of opening-stock imports (also the lock check). */
export const OPENING_IMPORT_PREFIX = 'OSI-'

export function parseGoLiveDate(v: unknown): Date {
  const s = String(v ?? '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new ApiError('Go-live date must be a date like 2026-04-01', 400)
  const d = new Date(s)
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) throw new ApiError('Go-live date is not a valid date', 400)
  const y = d.getUTCFullYear()
  if (y < 2000 || y > 2100) throw new ApiError('Go-live date is out of range', 400)
  return d
}

export const goLiveString = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null)

const HALF_DAY_MS = 12 * 60 * 60 * 1000

/** Timestamp opening figures are posted at: noon UTC of the day before the go-live date. */
export const openingDateFor = (goLive: Date) => new Date(goLive.getTime() - HALF_DAY_MS)

/** Go-live date (YYYY-MM-DD) an opening timestamp belongs to — the inverse of openingDateFor. */
export const goLiveForOpening = (opening: Date) => goLiveString(new Date(opening.getTime() + HALF_DAY_MS))

/** Today's date (YYYY-MM-DD) in India, where the books are kept. */
export const todayIst = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10)

export async function goLiveState(companyId: string) {
  const company = await db.company.findUnique({ where: { id: companyId }, select: { goLiveDate: true } })
  const goLive = company?.goLiveDate ?? null
  const importedRows = await db.stockLedger.count({ where: { companyId, type: 'OPENING', refNumber: { startsWith: OPENING_IMPORT_PREFIX } } })
  return { goLive, goLiveDate: goLiveString(goLive), locked: importedRows > 0, importedRows }
}

/** Configured go-live date for imports of opening figures; refuses when missing. */
export async function requireGoLive(companyId: string): Promise<Date> {
  const { goLive } = await goLiveState(companyId)
  if (!goLive) throw new ApiError('Set the go-live date first (Import Center → Go-live date)', 400)
  return goLive
}
