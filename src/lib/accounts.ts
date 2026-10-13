import { db } from '@/lib/db'
import { r2 } from '@/lib/erp-helpers'

/**
 * Cash & Bank helpers. Account balances are derived from the documents themselves:
 *   opening balance
 *   + Payment In (receipts)       − Payment Out           (credit/debit notes excluded — no money moves;
 *                                                            post-dated cheques count only once CLEARED)
 *   − expenses
 *   + AccountTxn into the account − AccountTxn out of it  (adjustments, contra, loans, EMIs)
 * Payments / expenses saved before accounts existed (accountId null) count against the company's
 * default CASH account when their mode is CASH, otherwise the default BANK account (else cash).
 */

type Tx = typeof db

const NON_MONEY_MODES = ['CREDIT_NOTE', 'DEBIT_NOTE']

/** The company's default cash account (created on first use) and default bank account (may be null). */
export async function defaultAccounts(tx: Tx | Parameters<Parameters<typeof db.$transaction>[0]>[0], companyId: string) {
  const t = tx as Tx
  let cash = await t.moneyAccount.findFirst({ where: { companyId, type: 'CASH' }, orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }] })
  if (!cash) cash = await t.moneyAccount.create({ data: { companyId, type: 'CASH', name: 'Cash in Hand', isDefault: true } })
  const bank = await t.moneyAccount.findFirst({ where: { companyId, type: 'BANK', active: true }, orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }] })
  return { cash, bank }
}

/** Account to use when none was chosen: CASH mode → cash, anything else → default bank (else cash). */
export async function accountForMode(tx: Parameters<typeof defaultAccounts>[0], companyId: string, mode: string | null | undefined, chosen?: string | null) {
  const t = tx as Tx
  if (chosen) {
    const a = await t.moneyAccount.findFirst({ where: { id: chosen, companyId }, select: { id: true } })
    if (a) return a.id
  }
  const { cash, bank } = await defaultAccounts(tx, companyId)
  return (mode || 'CASH') === 'CASH' ? cash.id : (bank?.id ?? cash.id)
}

export interface AccountBalance { id: string; name: string; type: string; opening: number; inflow: number; outflow: number; balance: number }

/** Balance of every account as of `upTo` (inclusive; default now). */
export async function accountBalances(companyId: string, upTo?: Date): Promise<AccountBalance[]> {
  const { cash, bank } = await defaultAccounts(db, companyId)
  const accounts = await db.moneyAccount.findMany({ where: { companyId }, orderBy: [{ type: 'asc' }, { name: 'asc' }] })
  const date = upTo ? { lte: upTo } : undefined
  const [payments, expenses, txns] = await Promise.all([
    db.payment.findMany({
      where: { companyId, mode: { notIn: NON_MONEY_MODES }, ...(date ? { date } : {}), OR: [{ chequeStatus: null }, { chequeStatus: 'CLEARED' }] },
      select: { type: true, amount: true, mode: true, accountId: true },
    }),
    db.expense.findMany({ where: { companyId, status: { not: 'CANCELLED' }, ...(date ? { date } : {}) }, select: { amount: true, paymentMode: true, accountId: true } }),
    db.accountTxn.findMany({ where: { companyId, ...(date ? { date } : {}) }, select: { fromAccountId: true, toAccountId: true, amount: true } }),
  ])
  const fallback = (mode?: string | null) => ((mode || 'CASH') === 'CASH' ? cash.id : (bank?.id ?? cash.id))
  const flow = new Map(accounts.map((a) => [a.id, { inflow: 0, outflow: 0 }]))
  const add = (id: string | null | undefined, k: 'inflow' | 'outflow', amt: number) => { const f = id ? flow.get(id) : undefined; if (f) f[k] += amt }
  for (const p of payments) add(p.accountId ?? fallback(p.mode), p.type === 'RECEIPT' ? 'inflow' : 'outflow', p.amount)
  // Expense.amount is what was paid (gstAmount is the ITC part inside it)
  for (const e of expenses) add(e.accountId ?? fallback(e.paymentMode), 'outflow', e.amount || 0)
  for (const t of txns) { add(t.toAccountId, 'inflow', t.amount); add(t.fromAccountId, 'outflow', t.amount) }
  return accounts.map((a) => {
    const f = flow.get(a.id)!
    const opening = a.openingDate && upTo && a.openingDate > upTo ? 0 : a.openingBalance
    return { id: a.id, name: a.name, type: a.type, opening: r2(opening), inflow: r2(f.inflow), outflow: r2(f.outflow), balance: r2(opening + f.inflow - f.outflow) }
  })
}
