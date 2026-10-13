import { db } from '@/lib/db'
import { ApiError, companyRequired, handleError, ok, r2 } from '@/lib/erp-helpers'
import { accountBalances, defaultAccounts } from '@/lib/accounts'
import { CATEGORY_LABEL, TXN_TYPE_LABEL, parseDate } from '../../_shared'

type Params = { params: Promise<{ id: string }> }

interface StatementRow {
  id: string
  kind: 'opening' | 'payment' | 'expense' | 'txn'
  date: Date
  type: string
  ref: string
  party: string
  in: number
  out: number
  balance: number
  clearedDate: Date | null
}

const NON_MONEY_MODES = ['CREDIT_NOTE', 'DEBIT_NOTE']

// GET /api/accounts/[id]/statement?companyId=&from=YYYY-MM-DD&to=YYYY-MM-DD
// → { account, from, to, opening, closing, totalIn, totalOut, rows } (chronological, running balance)
// Same rules as accountBalances(): no credit/debit notes, post-dated cheques only once CLEARED,
// cancelled expenses excluded, legacy rows without an account fall back to the default cash/bank account.
export async function GET(req: Request, { params }: Params) {
  try {
    const { id } = await params
    const companyId = await companyRequired(req)
    const { searchParams } = new URL(req.url)
    const from = parseDate(searchParams.get('from'), 'from')
    const to = parseDate(searchParams.get('to'), 'to', true)
    if (from && to && from > to) throw new ApiError('from must be on or before to', 400)

    const account = await db.moneyAccount.findFirst({ where: { id, companyId } })
    if (!account) throw new ApiError('Account not found', 404)

    const { cash, bank } = await defaultAccounts(db, companyId)
    const fallback = (mode?: string | null) => ((mode || 'CASH') === 'CASH' ? cash.id : (bank?.id ?? cash.id))
    const takesLegacy = id === cash.id || id === bank?.id
    const ownerOr = takesLegacy ? [{ accountId: id }, { accountId: null }] : [{ accountId: id }]

    const date: { gte?: Date; lte?: Date } = {}
    if (from) date.gte = from
    if (to) date.lte = to
    const dateWhere = from || to ? { date } : {}

    const [payments, expenses, txns] = await Promise.all([
      db.payment.findMany({
        where: {
          companyId, mode: { notIn: NON_MONEY_MODES }, ...dateWhere,
          AND: [{ OR: ownerOr }, { OR: [{ chequeStatus: null }, { chequeStatus: 'CLEARED' }] }],
        },
        orderBy: [{ date: 'asc' }, { createdAt: 'asc' }],
      }),
      db.expense.findMany({
        where: { companyId, status: { not: 'CANCELLED' }, ...dateWhere, OR: ownerOr },
        orderBy: [{ date: 'asc' }, { createdAt: 'asc' }],
      }),
      db.accountTxn.findMany({
        where: { companyId, ...dateWhere, OR: [{ fromAccountId: id }, { toAccountId: id }] },
        orderBy: [{ date: 'asc' }, { createdAt: 'asc' }],
      }),
    ])
    const myPayments = payments.filter((p) => (p.accountId ?? fallback(p.mode)) === id)
    const myExpenses = expenses.filter((e) => (e.accountId ?? fallback(e.paymentMode)) === id)

    // Party / account names
    const customerIds = Array.from(new Set(myPayments.map((p) => p.customerId).filter((x): x is string => !!x)))
    const supplierIds = Array.from(new Set(myPayments.map((p) => p.supplierId).filter((x): x is string => !!x)))
    const [customers, suppliers, accounts, loans] = await Promise.all([
      customerIds.length ? db.customer.findMany({ where: { companyId, id: { in: customerIds } }, select: { id: true, name: true } }) : Promise.resolve([] as { id: string; name: string }[]),
      supplierIds.length ? db.supplier.findMany({ where: { companyId, id: { in: supplierIds } }, select: { id: true, name: true } }) : Promise.resolve([] as { id: string; name: string }[]),
      db.moneyAccount.findMany({ where: { companyId }, select: { id: true, name: true } }),
      db.loan.findMany({ where: { companyId }, select: { id: true, name: true } }),
    ])
    const partyName = new Map<string, string>([...customers, ...suppliers].map((p) => [p.id, p.name]))
    const accountName = new Map(accounts.map((a) => [a.id, a.name]))
    const loanName = new Map(loans.map((l) => [l.id, l.name]))

    // Opening balance at `from` (balance as of the instant before it); no `from` → the account's opening balance
    let opening = account.openingBalance
    if (from) {
      const before = (await accountBalances(companyId, new Date(from.getTime() - 1))).find((b) => b.id === id)
      opening = before?.balance ?? 0
    }

    type Draft = Omit<StatementRow, 'balance'> & { createdAt: Date }
    const drafts: Draft[] = []
    // An opening date inside the period: the opening balance enters as a row on that date
    if (from && account.openingDate && account.openingDate >= from && (!to || account.openingDate <= to) && account.openingBalance) {
      drafts.push({
        id: `opening-${id}`, kind: 'opening', date: account.openingDate, createdAt: account.createdAt, type: 'Opening balance', ref: '', party: '',
        in: account.openingBalance > 0 ? account.openingBalance : 0, out: account.openingBalance < 0 ? -account.openingBalance : 0, clearedDate: null,
      })
    }
    for (const p of myPayments) {
      const isIn = p.type === 'RECEIPT'
      const pid = p.customerId || p.supplierId
      drafts.push({
        id: p.id, kind: 'payment', date: p.date, createdAt: p.createdAt,
        type: `${isIn ? 'Payment In' : 'Payment Out'} (${p.mode}${p.chequeNo ? ` #${p.chequeNo}` : ''})`,
        ref: p.number, party: (pid && partyName.get(pid)) || p.reference || '',
        in: isIn ? p.amount : 0, out: isIn ? 0 : p.amount, clearedDate: p.clearedDate,
      })
    }
    for (const e of myExpenses) {
      drafts.push({
        id: e.id, kind: 'expense', date: e.date, createdAt: e.createdAt,
        type: `Expense (${(e.category || 'OTHER').replaceAll('_', ' ')})`, ref: e.number,
        party: [e.paidTo, e.description].filter(Boolean).join(' — '),
        in: 0, out: e.amount || 0, clearedDate: e.clearedDate,
      })
    }
    for (const t of txns) {
      const isIn = t.toAccountId === id
      const other = isIn ? t.fromAccountId : t.toAccountId
      let party = ''
      if (t.type === 'CONTRA') party = `${isIn ? 'From' : 'To'} ${(other && accountName.get(other)) || '—'}`
      else if (t.loanId) party = loanName.get(t.loanId) || 'Loan'
      else party = (t.category && CATEGORY_LABEL[t.category]) || ''
      if (t.notes) party = party ? `${party} — ${t.notes}` : t.notes
      drafts.push({
        id: t.id, kind: 'txn', date: t.date, createdAt: t.createdAt, type: TXN_TYPE_LABEL[t.type] || t.type,
        ref: t.number, party, in: isIn ? t.amount : 0, out: isIn ? 0 : t.amount, clearedDate: t.clearedDate,
      })
    }
    drafts.sort((a, b) => a.date.getTime() - b.date.getTime() || a.createdAt.getTime() - b.createdAt.getTime())

    let running = opening
    let totalIn = 0
    let totalOut = 0
    const rows: StatementRow[] = drafts.map(({ createdAt: _c, ...d }) => {
      running = r2(running + d.in - d.out)
      totalIn += d.in
      totalOut += d.out
      return { ...d, in: r2(d.in), out: r2(d.out), balance: running }
    })

    return ok({
      account,
      from, to,
      opening: r2(opening),
      closing: r2(running),
      totalIn: r2(totalIn),
      totalOut: r2(totalOut),
      rows,
    })
  } catch (e) {
    return handleError(e)
  }
}
