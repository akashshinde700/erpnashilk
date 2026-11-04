/**
 * Import periods for Tally data: current financial year, last financial year, all data, or a custom range.
 *
 * Dates are calendar dates, 'YYYY-MM-DD', compared as text (no time zones involved). The company facts come from
 * Tally's own company list (job list-companies): STARTINGFROM = the financial year beginning, BOOKSFROM = the date the
 * books begin. When Tally does not report the financial year beginning, 1 April (the Indian financial year) is
 * assumed and the period says so.
 *
 *  - Current FY: the financial year containing today, from the start of the books if they begin later.
 *  - Last FY: the one before it; refused when the books begin after it ended.
 *  - All data: from the start of the books to the end of the current financial year, every year included. Needs
 *    BOOKSFROM; without it "all" cannot be worked out and is refused (never guessed).
 *  - Custom: any valid range up to the end of the current financial year; a start before the books is moved to the
 *    start of the books (and says so).
 *
 * Only vouchers carry dates. Masters (customers, suppliers, stock items) are read as they are in Tally today.
 */

export const PERIOD_KINDS = ['current-fy', 'last-fy', 'all', 'custom'] as const
export type PeriodKind = (typeof PERIOD_KINDS)[number]

export interface DateRange { from: string; to: string }
export interface FinancialYear extends DateRange { label: string }

export interface TallyPeriod extends DateRange {
  kind: PeriodKind
  label: string
  /** Every financial year the period touches, clipped to the period. */
  financialYears: FinancialYear[]
  /** Calendar months in the period (vouchers are to be read one month at a time). */
  months: number
  notes: string[]
}

export interface TallyCompanyDates { booksFrom?: string | null; startingFrom?: string | null }

export class PeriodError extends Error {}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/

/** A real calendar date in 'YYYY-MM-DD' form. */
export function isDate(s: unknown): s is string {
  if (typeof s !== 'string') return false
  const m = DATE_RE.exec(s)
  if (!m) return false
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const t = new Date(Date.UTC(y, mo - 1, d))
  return y >= 1900 && t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d
}

const ymd = (s: string) => s.split('-').map(Number) as [number, number, number]
const fmt = (t: Date) => t.toISOString().slice(0, 10)
/** y-m-d with overflow normalised (month 13 → next January, day 0 → last day of the previous month). */
const make = (y: number, m: number, d: number) => fmt(new Date(Date.UTC(y, m - 1, d)))
export const addDays = (s: string, n: number) => { const [y, m, d] = ymd(s); return make(y, m, d + n) }
const max = (a: string, b: string) => (a > b ? a : b)
const min = (a: string, b: string) => (a < b ? a : b)

/** Tally's date format in requests and replies: YYYYMMDD. */
export const toTallyDate = (s: string) => s.replaceAll('-', '')

/** Today in India (the books' calendar), as 'YYYY-MM-DD'. */
export function todayInIndia(now = new Date(Date.now())) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}

/** Month and day the company's financial year begins; 1 April when Tally does not say. */
export function fyStartOf(company: TallyCompanyDates): { month: number; day: number; assumed: boolean } {
  if (isDate(company.startingFrom)) {
    const [, m, d] = ymd(company.startingFrom)
    return { month: m, day: Math.min(d, 28), assumed: false }
  }
  return { month: 4, day: 1, assumed: true }
}

/** The financial year containing `date`. */
export function financialYearOf(date: string, start: { month: number; day: number }): FinancialYear {
  const [y] = ymd(date)
  const thisYear = make(y, start.month, start.day)
  const from = date >= thisYear ? thisYear : make(y - 1, start.month, start.day)
  const to = addDays(make(ymd(from)[0] + 1, start.month, start.day), -1)
  const [y1] = ymd(from)
  const [y2] = ymd(to)
  return { from, to, label: y1 === y2 ? `FY ${y1}` : `FY ${y1}-${String(y2).slice(2)}` }
}

/** Every financial year a range touches, each clipped to the range. */
export function financialYears(range: DateRange, start: { month: number; day: number }): FinancialYear[] {
  const out: FinancialYear[] = []
  for (let fy = financialYearOf(range.from, start); fy.from <= range.to; fy = financialYearOf(addDays(fy.to, 1), start)) {
    out.push({ ...fy, from: max(fy.from, range.from), to: min(fy.to, range.to) })
  }
  return out
}

/** Calendar months of a range, each clipped to the range. */
export function monthRanges(range: DateRange): DateRange[] {
  const out: DateRange[] = []
  let [y, m] = ymd(range.from)
  for (;;) {
    const first = make(y, m, 1)
    if (first > range.to) break
    out.push({ from: max(first, range.from), to: min(make(y, m + 1, 0), range.to) })
    m += 1
    if (m === 13) { m = 1; y += 1 }
  }
  return out
}

const LONG = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
const long = (s: string) => LONG.format(new Date(`${s}T00:00:00Z`))

/** Works out a period for one Tally company. Throws PeriodError with a message for the user. */
export function resolvePeriod(
  input: { kind: unknown; from?: unknown; to?: unknown }, company: TallyCompanyDates, today = todayInIndia(),
): TallyPeriod {
  if (!PERIOD_KINDS.includes(input.kind as PeriodKind)) throw new PeriodError('Choose a period')
  const kind = input.kind as PeriodKind
  const start = fyStartOf(company)
  const books = isDate(company.booksFrom) ? company.booksFrom : null
  const current = financialYearOf(today, start)
  const notes: string[] = []
  if (start.assumed) notes.push('Tally did not report when the financial year begins; 1 April is assumed.')
  let from: string
  let to: string
  let label: string

  if (kind === 'current-fy') {
    from = books ? max(current.from, books) : current.from
    to = current.to
    label = `Current financial year (${current.label})`
  } else if (kind === 'last-fy') {
    const last = financialYearOf(addDays(current.from, -1), start)
    if (books && books > last.to) throw new PeriodError(`The books in Tally begin on ${long(books)}, so there is no previous financial year.`)
    from = books ? max(last.from, books) : last.from
    to = last.to
    label = `Last financial year (${last.label})`
  } else if (kind === 'all') {
    if (!books) throw new PeriodError('Tally did not report when this company’s books begin, so “All data” cannot be worked out. Choose a custom range instead.')
    from = books
    to = current.to
    label = 'All data (every financial year)'
  } else {
    if (!isDate(input.from) || !isDate(input.to)) throw new PeriodError('Enter both dates of the custom range')
    if (input.from > input.to) throw new PeriodError('The start date must be on or before the end date')
    if (input.to > current.to) throw new PeriodError(`The range can end on ${long(current.to)} at the latest (the end of the current financial year)`)
    if (books && input.to < books) throw new PeriodError(`The books in Tally begin on ${long(books)}; the whole range is before that.`)
    from = books ? max(input.from, books) : input.from
    to = input.to
    if (from !== input.from) notes.push(`The books begin on ${long(books!)}, so the range starts there.`)
    label = 'Custom range'
  }
  if (from > to) throw new PeriodError('This period has no dates in it')
  return { kind, from, to, label, financialYears: financialYears({ from, to }, start), months: monthRanges({ from, to }).length, notes }
}
