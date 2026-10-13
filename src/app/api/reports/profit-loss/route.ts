import { ok, handleError, companyRequired } from '@/lib/erp-helpers'
import { parsePeriod, profitAndLoss } from '@/lib/accounting'

// GET /api/reports/profit-loss?companyId=&from=&to=
// Profit & Loss statement derived from documents (see profitAndLoss in src/lib/accounting.ts).
// Stock values use qty-at-date × CURRENT average rate (approximation — historical rates aren't stored).
export async function GET(req: Request) {
  try {
    const companyId = await companyRequired(req)
    const { searchParams } = new URL(req.url)
    const { fromStr, toStr, from, to } = parsePeriod(searchParams)
    const pl = await profitAndLoss(companyId, from, to)
    return ok({ ...pl, from: fromStr, to: toStr })
  } catch (e) {
    return handleError(e)
  }
}
