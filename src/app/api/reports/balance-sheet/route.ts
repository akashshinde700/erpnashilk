import { ok, handleError, companyRequired } from '@/lib/erp-helpers'
import { balanceSheetFrom, parseAsOf, positionAsOf } from '@/lib/accounting'

// GET /api/reports/balance-sheet?companyId=&asOf=YYYY-MM-DD (default today)
// Assets = Liabilities + Equity; "Opening balance difference" is the explicit balancing figure.
export async function GET(req: Request) {
  try {
    const companyId = await companyRequired(req)
    const { searchParams } = new URL(req.url)
    const { asOfStr, asOf } = parseAsOf(searchParams)
    const p = await positionAsOf(companyId, asOf)
    return ok({ ...balanceSheetFrom(p), netProfitToDate: p.pl.netProfit, gst: p.gst, asOf: asOfStr })
  } catch (e) {
    return handleError(e)
  }
}
