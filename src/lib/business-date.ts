import { ApiError } from '@/lib/erp-helpers'
import { todayIst } from '@/lib/go-live'

/**
 * Business dates of money documents (payments, expenses, Cash & Bank entries).
 *
 * The books are kept in India, so a document belongs to its IST calendar day. It is stored at UTC midnight
 * of that day — the convention of date-only inputs (new Date('YYYY-MM-DD')) and of Company.goLiveDate.
 * A UTC-midnight value sits inside that day's report window whatever the server time zone
 * (reports: from = UTC midnight, to = local end of day, 18:29:59.999Z under TZ=Asia/Kolkata).
 * A raw "now" timestamp does not: between 00:00 and 05:30 IST it falls after the previous day's
 * window and before the next day's.
 */

const IST_OFFSET_MS = 330 * 60_000

/** IST calendar day (YYYY-MM-DD) of an instant. */
export const istDay = (d: Date) => new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10)

const midnight = (day: string) => new Date(`${day}T00:00:00.000Z`)

/**
 * Normalises a business date: 'YYYY-MM-DD' → that day; a full timestamp → its IST day; empty → today in IST.
 * Always returns UTC midnight of the day.
 */
export function businessDate(v: unknown, field = 'date'): Date {
  if (v === undefined || v === null || (typeof v === 'string' && !v.trim())) return midnight(todayIst())
  let day: string
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) throw new ApiError(`${field} must be a valid date`, 400)
    day = istDay(v)
  } else {
    const s = String(v).trim()
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
      const d = midnight(s)
      if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) throw new ApiError(`${field} is not a valid date`, 400)
      day = s
    } else {
      const d = new Date(s)
      if (Number.isNaN(d.getTime())) throw new ApiError(`${field} must be a valid date`, 400)
      day = istDay(d)
    }
  }
  const y = Number(day.slice(0, 4))
  if (y < 2000 || y > 2100) throw new ApiError(`${field} is out of range`, 400)
  return midnight(day)
}

/** businessDate for optional fields: empty → null. */
export const optBusinessDate = (v: unknown, field = 'date'): Date | null =>
  v === undefined || v === null || (typeof v === 'string' && !v.trim()) ? null : businessDate(v, field)
