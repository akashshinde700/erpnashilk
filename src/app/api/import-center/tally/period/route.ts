import { ApiError, companyRequired, handleError, ok, requireWrite } from '@/lib/erp-helpers'
import { assertConnectorEnabled } from '@/lib/tally/connector'
import { tallyCompanyDates } from '@/lib/tally/jobs'
import { PeriodError, resolvePeriod, todayInIndia, type PeriodKind } from '@/lib/tally/period'

// GET /api/import-center/tally/period?tallyCompany=
//   → { today, options: { 'current-fy' | 'last-fy' | 'all': { ok: true, period } | { ok: false, message } } }
// GET /api/import-center/tally/period?tallyCompany=&kind=custom&from=YYYY-MM-DD&to=YYYY-MM-DD → TallyPeriod (or 400)
// The dates come from Tally's own latest company list (books from / financial year from), never from the request.
// Reading only: a period applies to vouchers, which cannot be read from Tally yet.
export async function GET(req: Request) {
  try {
    requireWrite(req, 'import-center')
    const companyId = await companyRequired(req)
    assertConnectorEnabled()
    const q = new URL(req.url).searchParams
    const dates = await tallyCompanyDates(companyId, q.get('tallyCompany'))
    if (!dates) throw new ApiError('That company is not in the latest list from Tally — refresh the company list and choose again', 400, 'TALLY_COMPANY_UNKNOWN')
    const today = todayInIndia()
    if (q.get('kind') === 'custom') {
      try {
        return ok(resolvePeriod({ kind: 'custom', from: q.get('from'), to: q.get('to') }, dates, today))
      } catch (e) {
        if (e instanceof PeriodError) throw new ApiError(e.message, 400, 'INVALID_PERIOD')
        throw e
      }
    }
    const option = (kind: PeriodKind) => {
      try {
        return { ok: true as const, period: resolvePeriod({ kind }, dates, today) }
      } catch (e) {
        if (e instanceof PeriodError) return { ok: false as const, message: e.message }
        throw e
      }
    }
    return ok({ today, options: { 'current-fy': option('current-fy'), 'last-fy': option('last-fy'), all: option('all') } })
  } catch (e) {
    return handleError(e)
  }
}
