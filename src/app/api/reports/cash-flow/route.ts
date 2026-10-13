import { ok, handleError, companyRequired } from '@/lib/erp-helpers'
import { cashFlow, parsePeriod } from '@/lib/accounting'

// GET /api/reports/cash-flow?companyId=&from=&to=
// Opening cash+bank (accountBalances at the day before `from`) + inflows − outflows = closing
// (accountBalances at `to`). `difference` is non-zero only if the two don't reconcile.
export async function GET(req: Request) {
  try {
    const companyId = await companyRequired(req)
    const { searchParams } = new URL(req.url)
    const { fromStr, toStr, from, to } = parsePeriod(searchParams)
    const cf = await cashFlow(companyId, from, to)
    return ok({ ...cf, from: fromStr, to: toStr })
  } catch (e) {
    return handleError(e)
  }
}
