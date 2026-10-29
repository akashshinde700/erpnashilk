import { db } from '@/lib/db'
import { ApiError, companyRequired, handleError, ok, r2, requireRead } from '@/lib/erp-helpers'
import { NON_MONEY_MODES } from '@/lib/accounts'
import { LEDGER_TYPE_LABEL, cashBankLedger, ledgerBalancesAt } from '@/lib/cash-bank-ledger'
import { parseDate } from '../../accounts/_shared'

// GET /api/cash-bank/transactions?companyId=&accountId=&type=PAYMENT_IN,EXPENSE&partyId=&from=YYYY-MM-DD&to=YYYY-MM-DD&q=
// Unified Cash & Bank history (see cashBankLedger): newest first, each row with its account's balance after it.
// → { items, totals: { count, moneyIn, moneyOut }, opening, closing, filtered, pendingCheques, parties, types, from, to }
//   opening / closing: balance of the selected account(s) before `from` / at the end of `to` — the real account
//   balance, not affected by the type / party / search filters (`filtered` tells the screen they are applied).
export async function GET(req: Request) {
  try {
    requireRead(req, 'cash-bank') // Phase 5: financial read permission
    const companyId = await companyRequired(req)
    const { searchParams } = new URL(req.url)
    const accountId = (searchParams.get('accountId') || '').trim()
    const types = (searchParams.get('type') || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
    const unknown = types.filter((t) => !(t in LEDGER_TYPE_LABEL))
    if (unknown.length) throw new ApiError(`Unknown type: ${unknown.join(', ')}`, 400)
    const partyId = (searchParams.get('partyId') || '').trim()
    const q = (searchParams.get('q') || '').trim().toLowerCase()
    const from = parseDate(searchParams.get('from'), 'from')
    const to = parseDate(searchParams.get('to'), 'to', true)
    if (from && to && from > to) throw new ApiError('From date must be on or before the To date', 400)

    const { accounts, rows } = await cashBankLedger(companyId)
    if (accountId && !accounts.some((a) => a.id === accountId)) throw new ApiError('Account not found', 404)
    const scope = accountId ? [accountId] : accounts.map((a) => a.id)

    // Account balance before the period and at its end (whole account, no type / party / search filter)
    const before = from ? ledgerBalancesAt(rows, from, true) : new Map<string, number>()
    const atEnd = ledgerBalancesAt(rows, to)
    const opening = r2(scope.reduce((s, id) => s + (before.get(id) ?? 0), 0))
    const closing = r2(scope.reduce((s, id) => s + (atEnd.get(id) ?? 0), 0))

    // Rows of the selected account(s) in the period; undated opening balances belong before any `from`
    const inPeriod = rows.filter((r) => (!accountId || r.accountId === accountId)
      && (r.date ? (!from || r.date >= from) && (!to || r.date <= to) : !from))
    const partyMap = new Map<string, string>()
    for (const r of inPeriod) if (r.partyId) partyMap.set(r.partyId, r.party)

    const items = inPeriod
      .filter((r) => !types.length || types.includes(r.type))
      .filter((r) => !partyId || r.partyId === partyId)
      .filter((r) => !q || `${r.number} ${r.party} ${r.description} ${r.accountName} ${r.typeLabel}`.toLowerCase().includes(q))
      .reverse()

    // Cheques not yet cleared: the party is settled, the money is not in the account yet
    const pending = await db.payment.groupBy({
      by: ['type'],
      where: { companyId, mode: { notIn: NON_MONEY_MODES }, chequeStatus: { in: ['PENDING', 'DEPOSITED'] }, ...(accountId ? { accountId } : {}) },
      _sum: { amount: true }, _count: { _all: true },
    })
    const pend = (t: string) => pending.find((p) => p.type === t)

    return ok({
      items,
      totals: {
        count: items.length,
        moneyIn: r2(items.reduce((s, r) => s + r.moneyIn, 0)),
        moneyOut: r2(items.reduce((s, r) => s + r.moneyOut, 0)),
      },
      opening,
      closing,
      filtered: types.length > 0 || !!partyId || !!q,
      pendingCheques: {
        count: pending.reduce((s, p) => s + p._count._all, 0),
        toReceive: r2(pend('RECEIPT')?._sum.amount ?? 0),
        toPay: r2(pend('PAYMENT')?._sum.amount ?? 0),
      },
      parties: [...partyMap.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)),
      types: Object.entries(LEDGER_TYPE_LABEL).map(([value, label]) => ({ value, label })),
      from: searchParams.get('from') || null,
      to: searchParams.get('to') || null,
    })
  } catch (e) {
    return handleError(e)
  }
}
