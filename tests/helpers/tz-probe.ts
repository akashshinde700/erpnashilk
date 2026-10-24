/**
 * Run in a child process with TZ set (see opening-dates.test.ts): prints how the real app helpers
 * place and display an opening timestamp in that time zone. Makes no database queries.
 * Usage: bun tests/helpers/tz-probe.ts 2025-04-01
 */
import { endOfDayStr } from '@/lib/accounting'
import { fmtDate } from '@/lib/erp-constants'
import { goLiveForOpening, openingDateFor, parseGoLiveDate } from '@/lib/go-live'

const goLiveStr = process.argv[2]
const goLive = parseGoLiveDate(goLiveStr)
const prevDay = new Date(goLive.getTime() - 86_400_000).toISOString().slice(0, 10)
const opening = openingDateFor(goLive)
const oneSecondBefore = new Date(goLive.getTime() - 1000) // the earlier choice, kept for comparison
const prevDayEnd = endOfDayStr(prevDay) // "to <previous day>" as the reports compute it
const periodFrom = new Date(goLiveStr) // "from <go-live>" as the reports compute it

console.log(JSON.stringify({
  tz: process.env.TZ,
  opening: opening.toISOString(),
  shownOpening: fmtDate(opening),
  shownGoLive: fmtDate(goLiveStr),
  roundTrip: goLiveForOpening(opening),
  prevDayEnd: prevDayEnd.toISOString(),
  inAsAtPreviousDay: opening <= prevDayEnd,
  beforePeriodFrom: opening < periodFrom,
  oneSecondBefore: { shown: fmtDate(oneSecondBefore), inAsAtPreviousDay: oneSecondBefore <= prevDayEnd },
}))
