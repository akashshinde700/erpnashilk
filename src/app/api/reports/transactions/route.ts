import { ok, handleError, companyRequired, r2 } from '@/lib/erp-helpers'
import { listTransactions, parsePeriod, TXN_TYPE_LABEL } from '@/lib/accounting'

// GET /api/reports/transactions?companyId=&from=&to=&type=SALE,PAYMENT_IN&partyId=&q=
// All transactions of the period (same sources as the daybook) with filters and per-type totals.
export async function GET(req: Request) {
  try {
    const companyId = await companyRequired(req)
    const { searchParams } = new URL(req.url)
    const { fromStr, toStr, from, to } = parsePeriod(searchParams)
    const types = (searchParams.get('type') || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
    const partyId = (searchParams.get('partyId') || '').trim()
    const q = (searchParams.get('q') || '').trim().toLowerCase()

    let items = await listTransactions(companyId, from, to)
    if (types.length) items = items.filter((r) => types.includes(r.type))
    if (partyId) items = items.filter((r) => r.partyId === partyId)
    if (q) items = items.filter((r) => `${r.party} ${r.number} ${r.description}`.toLowerCase().includes(q))

    const byTypeMap = new Map<string, { type: string; label: string; count: number; amount: number; moneyIn: number; moneyOut: number }>()
    for (const r of items) {
      const g = byTypeMap.get(r.type) ?? { type: r.type, label: TXN_TYPE_LABEL[r.type] || r.type, count: 0, amount: 0, moneyIn: 0, moneyOut: 0 }
      g.count += 1
      g.amount = r2(g.amount + r.amount)
      g.moneyIn = r2(g.moneyIn + r.moneyIn)
      g.moneyOut = r2(g.moneyOut + r.moneyOut)
      byTypeMap.set(r.type, g)
    }
    const totals = {
      count: items.length,
      amount: r2(items.reduce((s, r) => s + r.amount, 0)),
      moneyIn: r2(items.reduce((s, r) => s + r.moneyIn, 0)),
      moneyOut: r2(items.reduce((s, r) => s + r.moneyOut, 0)),
    }
    // Parties seen in the period (for the party filter)
    const partyMap = new Map<string, string>()
    for (const r of items) if (r.partyId) partyMap.set(r.partyId, r.party)
    return ok({
      items,
      totals,
      byType: [...byTypeMap.values()].sort((a, b) => b.amount - a.amount),
      parties: [...partyMap.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)),
      types: Object.entries(TXN_TYPE_LABEL).map(([value, label]) => ({ value, label })),
      from: fromStr,
      to: toStr,
    })
  } catch (e) {
    return handleError(e)
  }
}
