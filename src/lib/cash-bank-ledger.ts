import { db } from '@/lib/db'
import { r2 } from '@/lib/erp-helpers'
import { POSTED_EXPENSE, fallbackAccounts, fallbackId, moneyDate, moneyPaymentWhere } from '@/lib/accounts'

/**
 * Cash & Bank ledger: every money movement of every account, one row per account touched (a transfer is an
 * "out" row on one account and an "in" row on the other), with the account's running balance after the row.
 * Same rules as accountBalances() — opening balance on its opening date, payments on their money date
 * (cleared post-dated cheque on its clearing date; pending / bounced cheques and credit / debit notes excluded),
 * POSTED expenses only, legacy rows without an account on the default cash / bank account — so the last row of
 * an account always carries its current balance.
 */

export const LEDGER_TYPE_LABEL: Record<string, string> = {
  OPENING: 'Opening balance',
  PAYMENT_IN: 'Payment In',
  PAYMENT_OUT: 'Payment Out',
  EXPENSE: 'Expense',
  ADJUST_IN: 'Money added',
  ADJUST_OUT: 'Money taken out',
  TRANSFER: 'Transfer',
  LOAN_IN: 'Loan received',
  LOAN_EMI: 'Loan EMI',
}

const CATEGORY_LABEL: Record<string, string> = {
  CAPITAL: 'Owner capital', DRAWINGS: 'Drawings', OTHER_INCOME: 'Other income', OTHER_EXPENSE: 'Other expense', OTHER: 'Other', LOAN: 'Loan',
}
const labelOf = (s: string | null | undefined) => (s ? CATEGORY_LABEL[s] ?? s.replaceAll('_', ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase()) : '')

export interface LedgerRow {
  id: string
  source: 'opening' | 'payment' | 'expense' | 'txn'
  sourceId: string
  /** Day the money moved; null = opening balance without an opening date (counts from the very start). */
  date: Date | null
  type: string
  typeLabel: string
  number: string
  partyId: string | null
  party: string
  description: string
  mode: string | null
  accountId: string
  accountName: string
  accountType: string
  moneyIn: number
  moneyOut: number
  /** Balance of this row's account right after it. */
  balance: number
}

type Draft = Omit<LedgerRow, 'balance' | 'typeLabel'> & { createdAt: Date; rank: number }

export interface LedgerAccount { id: string; name: string; type: string; active: boolean }

/** All ledger rows of the company in time order (oldest first) with running balances per account. */
export async function cashBankLedger(companyId: string): Promise<{ accounts: LedgerAccount[]; rows: LedgerRow[] }> {
  const fb = await fallbackAccounts(db, companyId)
  const [accounts, payments, expenses, txns, loans] = await Promise.all([
    db.moneyAccount.findMany({ where: { companyId }, orderBy: [{ type: 'asc' }, { name: 'asc' }] }),
    db.payment.findMany({
      where: moneyPaymentWhere(companyId),
      select: { id: true, number: true, date: true, type: true, customerId: true, supplierId: true, amount: true, mode: true, accountId: true, chequeNo: true, chequeStatus: true, clearedDate: true, reference: true, createdAt: true },
    }),
    db.expense.findMany({
      where: { companyId, status: POSTED_EXPENSE },
      select: { id: true, number: true, date: true, category: true, description: true, amount: true, paymentMode: true, paidTo: true, accountId: true, createdAt: true },
    }),
    db.accountTxn.findMany({ where: { companyId } }),
    db.loan.findMany({ where: { companyId }, select: { id: true, name: true } }),
  ])
  const custIds = [...new Set(payments.map((p) => p.customerId).filter((x): x is string => !!x))]
  const suppIds = [...new Set(payments.map((p) => p.supplierId).filter((x): x is string => !!x))]
  const [custs, supps] = await Promise.all([
    custIds.length ? db.customer.findMany({ where: { companyId, id: { in: custIds } }, select: { id: true, name: true } }) : [],
    suppIds.length ? db.supplier.findMany({ where: { companyId, id: { in: suppIds } }, select: { id: true, name: true } }) : [],
  ])
  const partyName = new Map<string, string>([...custs, ...supps].map((p) => [p.id, p.name]))
  const acc = new Map(accounts.map((a) => [a.id, a]))
  const loanName = new Map(loans.map((l) => [l.id, l.name]))

  const drafts: Draft[] = []
  const base = (accountId: string) => {
    const a = acc.get(accountId)!
    return { accountId, accountName: a.name, accountType: a.type }
  }

  for (const a of accounts) {
    if (Math.abs(a.openingBalance) < 0.005) continue
    drafts.push({
      id: `open-${a.id}`, source: 'opening', sourceId: a.id, date: a.openingDate, createdAt: a.createdAt, rank: 0,
      type: 'OPENING', number: '', partyId: null, party: '', description: 'Opening balance', mode: null, ...base(a.id),
      moneyIn: a.openingBalance > 0 ? a.openingBalance : 0, moneyOut: a.openingBalance < 0 ? -a.openingBalance : 0,
    })
  }
  for (const p of payments) {
    const accountId = p.accountId ?? fallbackId(fb, p.mode)
    if (!accountId || !acc.has(accountId)) continue
    const isIn = p.type === 'RECEIPT'
    const partyId = p.customerId || p.supplierId
    const cleared = p.chequeStatus === 'CLEARED' && p.clearedDate
    drafts.push({
      id: `pay-${p.id}`, source: 'payment', sourceId: p.id, date: moneyDate(p), createdAt: p.createdAt, rank: 1,
      type: isIn ? 'PAYMENT_IN' : 'PAYMENT_OUT', number: p.number, partyId, party: (partyId && partyName.get(partyId)) || '—',
      description: [p.mode, p.chequeNo ? `cheque ${p.chequeNo}` : '', cleared ? `cleared (dated ${p.date.toISOString().slice(0, 10)})` : '', p.reference || ''].filter(Boolean).join(' · '),
      mode: p.mode, ...base(accountId),
      moneyIn: isIn ? p.amount : 0, moneyOut: isIn ? 0 : p.amount,
    })
  }
  for (const e of expenses) {
    const accountId = e.accountId ?? fallbackId(fb, e.paymentMode)
    if (!accountId || !acc.has(accountId)) continue
    drafts.push({
      id: `exp-${e.id}`, source: 'expense', sourceId: e.id, date: e.date, createdAt: e.createdAt, rank: 1,
      type: 'EXPENSE', number: e.number, partyId: null, party: e.paidTo || labelOf(e.category),
      description: [labelOf(e.category), e.description].filter(Boolean).join(' · '), mode: e.paymentMode, ...base(accountId),
      moneyIn: 0, moneyOut: e.amount || 0,
    })
  }
  for (const t of txns) {
    const loan = t.loanId ? loanName.get(t.loanId) || 'Loan' : ''
    const note = t.notes ? ` · ${t.notes}` : ''
    const common = { source: 'txn' as const, sourceId: t.id, date: t.date, createdAt: t.createdAt, rank: 1, number: t.number, partyId: null, mode: null }
    if (t.type === 'CONTRA') {
      if (t.fromAccountId && acc.has(t.fromAccountId)) {
        drafts.push({ ...common, id: `atx-${t.id}-out`, type: 'TRANSFER', party: `To ${t.toAccountId ? acc.get(t.toAccountId)?.name ?? '—' : '—'}`, description: `${t.reference ? `Ref ${t.reference}` : 'Transfer'}${note}`, ...base(t.fromAccountId), moneyIn: 0, moneyOut: t.amount })
      }
      if (t.toAccountId && acc.has(t.toAccountId)) {
        drafts.push({ ...common, id: `atx-${t.id}-in`, type: 'TRANSFER', party: `From ${t.fromAccountId ? acc.get(t.fromAccountId)?.name ?? '—' : '—'}`, description: `${t.reference ? `Ref ${t.reference}` : 'Transfer'}${note}`, ...base(t.toAccountId), moneyIn: t.amount, moneyOut: 0 })
      }
      continue
    }
    const intoId = t.toAccountId && acc.has(t.toAccountId) ? t.toAccountId : null
    const outOfId = t.fromAccountId && acc.has(t.fromAccountId) ? t.fromAccountId : null
    const type = t.type === 'LOAN_IN' || t.type === 'LOAN_EMI' ? t.type : intoId ? 'ADJUST_IN' : 'ADJUST_OUT'
    const description = t.type === 'LOAN_EMI'
      ? `Principal ₹${r2(t.principal || 0).toFixed(2)} + interest ₹${r2(t.interest || 0).toFixed(2)}${note}`
      : `${t.type === 'LOAN_IN' ? 'Loan amount received' : labelOf(t.category) || 'Adjustment'}${note}`
    if (intoId) drafts.push({ ...common, id: `atx-${t.id}`, type, party: loan || labelOf(t.category), description, ...base(intoId), moneyIn: t.amount, moneyOut: 0 })
    else if (outOfId) drafts.push({ ...common, id: `atx-${t.id}`, type, party: loan || labelOf(t.category), description, ...base(outOfId), moneyIn: 0, moneyOut: t.amount })
  }

  // Oldest first: undated opening balances first; on the same day the opening row comes first, then entry order
  const key = (d: Draft) => (d.date ? d.date.getTime() : Number.NEGATIVE_INFINITY)
  drafts.sort((a, b) => key(a) - key(b) || a.rank - b.rank || a.createdAt.getTime() - b.createdAt.getTime() || a.number.localeCompare(b.number))

  const running = new Map<string, number>()
  const rows: LedgerRow[] = drafts.map(({ createdAt: _c, rank: _r, ...d }) => {
    const balance = r2((running.get(d.accountId) ?? 0) + d.moneyIn - d.moneyOut)
    running.set(d.accountId, balance)
    return { ...d, typeLabel: LEDGER_TYPE_LABEL[d.type] || d.type, moneyIn: r2(d.moneyIn), moneyOut: r2(d.moneyOut), balance }
  })
  return { accounts: accounts.map((a) => ({ id: a.id, name: a.name, type: a.type, active: a.active })), rows }
}

/** Balance per account from ledger rows dated on or before `upTo` (null rows = undated opening, always included). */
export function ledgerBalancesAt(rows: LedgerRow[], upTo: Date | null, before = false): Map<string, number> {
  const out = new Map<string, number>()
  for (const r of rows) {
    if (upTo && r.date && (before ? r.date >= upTo : r.date > upTo)) continue
    out.set(r.accountId, r.balance)
  }
  return out
}
