import { ok, handleError, companyRequired, r2, requireFinancialReports } from '@/lib/erp-helpers'
import { listTransactions, parsePeriod } from '@/lib/accounting'

// GET /api/reports/daybook?companyId=&date=YYYY-MM-DD  (or from=&to=; default current FY → today)
// Every document of the period in time order with money in / out (see listTransactions in src/lib/accounting.ts).
export async function GET(req: Request) {
  try {
    requireFinancialReports(req) // Phase 5: financial read permission
    const companyId = await companyRequired(req)
    const { searchParams } = new URL(req.url)
    const { fromStr, toStr, from, to } = parsePeriod(searchParams)
    const items = await listTransactions(companyId, from, to)
    const totals = {
      count: items.length,
      moneyIn: r2(items.reduce((s, r) => s + r.moneyIn, 0)),
      moneyOut: r2(items.reduce((s, r) => s + r.moneyOut, 0)),
      net: 0,
    }
    totals.net = r2(totals.moneyIn - totals.moneyOut)
    return ok({ items, totals, from: fromStr, to: toStr })
  } catch (e) {
    return handleError(e)
  }
}
