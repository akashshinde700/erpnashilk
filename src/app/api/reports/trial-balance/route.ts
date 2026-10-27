import { ok, handleError, companyRequired, requireFinancialReports } from '@/lib/erp-helpers'
import { parseAsOf, positionAsOf, trialBalanceFrom } from '@/lib/accounting'

// GET /api/reports/trial-balance?companyId=&asOf=YYYY-MM-DD (default today)
// Ledger heads with Debit / Credit columns. Opening balances of parties and cash/bank accounts have no
// contra entry in the documents, so they show up as the "difference" line when the totals don't agree.
export async function GET(req: Request) {
  try {
    requireFinancialReports(req) // Phase 5: financial read permission
    const companyId = await companyRequired(req)
    const { searchParams } = new URL(req.url)
    const { asOfStr, asOf } = parseAsOf(searchParams)
    const p = await positionAsOf(companyId, asOf)
    return ok({ ...trialBalanceFrom(p), asOf: asOfStr })
  } catch (e) {
    return handleError(e)
  }
}
