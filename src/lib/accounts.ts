import { db } from '@/lib/db'
import { ApiError, r2 } from '@/lib/erp-helpers'
import { todayIst } from '@/lib/go-live'
import { businessDate, istDay } from '@/lib/business-date'
import { accountTypeForMode } from '@/lib/erp-constants'

/**
 * Cash & Bank helpers. Account balances are derived from the documents themselves:
 *   opening balance (from its opening date)
 *   + Payment In (receipts)       − Payment Out           (credit/debit notes excluded — no money moves)
 *   − POSTED expenses                                     (DRAFT and CANCELLED move no money)
 *   + AccountTxn into the account − AccountTxn out of it  (adjustments, contra, loans, EMIs)
 *
 * Cheques: a cheque dated after the day it was recorded is post-dated (PENDING). It settles the invoice at once
 * but reaches the account only when CLEARED, on its clearing date; DEPOSITED / BOUNCED never count. A cheque
 * dated on or before the day it was recorded counts at once on the payment date (and drops out if it bounces).
 *
 * Payments / expenses saved before accounts existed (accountId null) count against the company's default
 * CASH account when their mode is CASH, otherwise the default BANK account (else cash) — a reporting rule for
 * those old rows only. New money always goes through postingAccount(): CASH mode → a cash account, every other
 * mode → a bank account, never a fallback to cash (CB-R5).
 *
 * Reading balances never creates anything. "Cash in Hand" is created when the first money document needs a
 * cash account (ensureCashAccount) or explicitly from Cash & Bank.
 */

type Tx = typeof db
type AnyTx = Tx | Parameters<Parameters<typeof db.$transaction>[0]>[0]

// Rows that settle a party without moving money: credit / debit notes and advance applications
export const NON_MONEY_MODES = ['CREDIT_NOTE', 'DEBIT_NOTE', 'ADVANCE_ADJ']

/** Expense statuses that move money. */
export const POSTED_EXPENSE = 'POSTED'

/** Account type a payment mode moves money through (shared with the UI). */
export { accountTypeForMode }

/** Accounts legacy rows without an accountId are attributed to. Read-only. */
export async function fallbackAccounts(tx: AnyTx, companyId: string) {
  const t = tx as Tx
  const [cash, bank] = await Promise.all([
    t.moneyAccount.findFirst({ where: { companyId, type: 'CASH' }, orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }] }),
    t.moneyAccount.findFirst({ where: { companyId, type: 'BANK', active: true }, orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }] }),
  ])
  return { cash, bank }
}

/** Account id a legacy row (no accountId) counts against, or null when the company has no account for it. */
export function fallbackId(f: Awaited<ReturnType<typeof fallbackAccounts>>, mode: string | null | undefined) {
  return accountTypeForMode(mode) === 'CASH' ? f.cash?.id ?? null : f.bank?.id ?? f.cash?.id ?? null
}

/**
 * Creates "Cash in Hand" when the company has no cash account yet. Call it BEFORE opening the transaction that
 * posts the money (auto-committed; the unique (companyId, name) index lets concurrent calls create one row).
 */
export async function ensureCashAccount(companyId: string) {
  if (await db.moneyAccount.count({ where: { companyId, type: 'CASH' } })) return
  await db.moneyAccount.createMany({ data: [{ companyId, type: 'CASH', name: 'Cash in Hand', isDefault: true }], skipDuplicates: true })
}

/** ensureCashAccount, only when postingAccount() would need the cash account (nothing chosen, CASH mode). */
export async function ensureCashFor(companyId: string, mode: string | null | undefined, chosen?: string | null) {
  if (chosen || accountTypeForMode(mode) !== 'CASH') return
  await ensureCashAccount(companyId)
}

const modeLabel = (mode: string | null | undefined) => (mode || 'CASH').replaceAll('_', ' ')

/**
 * Account a payment / expense moves money through (CB-R5: the account type must match the payment mode).
 *  - chosen: must belong to the company, be active and be of the mode's type (404 / 400) — never swapped.
 *    `keepInactiveId`: an existing document may keep its (now inactive) account. `keepExistingId`: an existing
 *    document whose mode and account are unchanged keeps the account it has, even if it was saved before this rule.
 *  - not chosen: CASH mode → the default active cash account; any other mode → the default active bank account,
 *    refused when the company has none (never a fallback to cash). Call ensureCashFor() before the transaction so a
 *    company's first cash posting has its account.
 */
export async function postingAccount(tx: AnyTx, companyId: string, mode: string | null | undefined, chosen?: string | null, opts: { keepInactiveId?: string | null; keepExistingId?: string | null } = {}) {
  const t = tx as Tx
  const need = accountTypeForMode(mode)
  if (chosen) {
    const a = await t.moneyAccount.findFirst({ where: { id: String(chosen), companyId } })
    if (!a) throw new ApiError('Account not found', 404)
    if (a.id === opts.keepExistingId) return a
    if (!a.active && a.id !== opts.keepInactiveId) throw new ApiError(`Account ${a.name} is inactive — choose another account`, 400)
    if (a.type !== need) {
      throw new ApiError(need === 'CASH'
        ? `Cash payments must use a cash account — ${a.name} is a bank account`
        : `${modeLabel(mode)} payments must use a bank account — ${a.name} is a cash account`, 400)
    }
    return a
  }
  const found = await t.moneyAccount.findFirst({ where: { companyId, type: need, active: true }, orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }] })
  if (found) return found
  throw new ApiError(need === 'BANK'
    ? `No active bank account for ${modeLabel(mode)} payments — add a bank account in Cash & Bank first`
    : 'Add an active cash account first (Cash & Bank)', 400)
}

/** Refuses money dated before the account's opening date (that period belongs to the opening balance). */
export function assertOnOrAfterOpening(account: { name: string; openingDate: Date | null }, date: Date, what = 'This entry') {
  if (account.openingDate && istDay(date) < istDay(account.openingDate)) {
    throw new ApiError(`${what} is dated ${istDay(date)}, before the opening date of ${account.name} (${istDay(account.openingDate)})`, 400)
  }
}

/** Cheque fields of a payment: a cheque dated after today (IST) is post-dated → PENDING. */
export function chequeDetails(mode: string, chequeNo: unknown, chequeDate: unknown) {
  if (mode !== 'CHEQUE') return { chequeNo: null, chequeDate: null, chequeStatus: null }
  const date = chequeDate === undefined || chequeDate === null || chequeDate === '' ? null : businessDate(chequeDate, 'Cheque date')
  return {
    chequeNo: chequeNo ? String(chequeNo).trim() || null : null,
    chequeDate: date,
    chequeStatus: date && istDay(date) > todayIst() ? 'PENDING' : null,
  }
}

/** Day a payment's money moves: a cleared post-dated cheque on its clearing date, anything else on its date. */
export const moneyDate = (p: { date: Date; chequeStatus: string | null; clearedDate: Date | null }) =>
  (p.chequeStatus === 'CLEARED' && p.clearedDate ? p.clearedDate : p.date)

/** Prisma filter: payments that move money, by money date (see moneyDate) within `range`. */
export function moneyPaymentWhere(companyId: string, range?: { gte?: Date; lte?: Date }) {
  const r = range && (range.gte || range.lte) ? range : null
  return {
    companyId,
    mode: { notIn: NON_MONEY_MODES },
    OR: r
      ? [{ chequeStatus: null, date: r }, { chequeStatus: 'CLEARED', clearedDate: r }, { chequeStatus: 'CLEARED', clearedDate: null, date: r }]
      : [{ chequeStatus: null }, { chequeStatus: 'CLEARED' }],
  }
}

export interface AccountBalance { id: string; name: string; type: string; opening: number; inflow: number; outflow: number; balance: number }

/** Balance of every account as of `upTo` (inclusive; default now). Read-only. */
export async function accountBalances(companyId: string, upTo?: Date): Promise<AccountBalance[]> {
  const fb = await fallbackAccounts(db, companyId)
  const accounts = await db.moneyAccount.findMany({ where: { companyId }, orderBy: [{ type: 'asc' }, { name: 'asc' }] })
  const date = upTo ? { lte: upTo } : undefined
  const [payments, expenses, txns] = await Promise.all([
    db.payment.findMany({ where: moneyPaymentWhere(companyId, date), select: { type: true, amount: true, mode: true, accountId: true } }),
    db.expense.findMany({ where: { companyId, status: POSTED_EXPENSE, ...(date ? { date } : {}) }, select: { amount: true, paymentMode: true, accountId: true } }),
    db.accountTxn.findMany({ where: { companyId, ...(date ? { date } : {}) }, select: { fromAccountId: true, toAccountId: true, amount: true } }),
  ])
  const flow = new Map(accounts.map((a) => [a.id, { inflow: 0, outflow: 0 }]))
  const add = (id: string | null | undefined, k: 'inflow' | 'outflow', amt: number) => { const f = id ? flow.get(id) : undefined; if (f) f[k] += amt }
  for (const p of payments) add(p.accountId ?? fallbackId(fb, p.mode), p.type === 'RECEIPT' ? 'inflow' : 'outflow', p.amount)
  // Expense.amount is what was paid (gstAmount is the ITC part inside it)
  for (const e of expenses) add(e.accountId ?? fallbackId(fb, e.paymentMode), 'outflow', e.amount || 0)
  for (const t of txns) { add(t.toAccountId, 'inflow', t.amount); add(t.fromAccountId, 'outflow', t.amount) }
  return accounts.map((a) => {
    const f = flow.get(a.id)!
    const opening = a.openingDate && upTo && a.openingDate > upTo ? 0 : a.openingBalance
    return { id: a.id, name: a.name, type: a.type, opening: r2(opening), inflow: r2(f.inflow), outflow: r2(f.outflow), balance: r2(opening + f.inflow - f.outflow) }
  })
}

/**
 * Money documents of an account dated before `day` (IST): payments (any cheque state), non-cancelled expenses,
 * account entries — including legacy rows that fall back to this account. Used before moving an opening date later.
 */
export async function entriesBefore(tx: AnyTx, companyId: string, accountId: string, day: Date) {
  const t = tx as Tx
  const fb = await fallbackAccounts(tx, companyId)
  const takesLegacy = fb.cash?.id === accountId || fb.bank?.id === accountId
  const owner = takesLegacy ? [{ accountId }, { accountId: null }] : [{ accountId }]
  // One extra day of margin for legacy timestamps; the IST day comparison below decides
  const lt = new Date(day.getTime() + 86_400_000)
  const before = (d: Date) => istDay(d) < istDay(day)
  const [payments, expenses, txns] = await Promise.all([
    t.payment.findMany({ where: { companyId, mode: { notIn: NON_MONEY_MODES }, date: { lt }, OR: owner }, select: { date: true, mode: true, accountId: true } }),
    t.expense.findMany({ where: { companyId, status: { not: 'CANCELLED' }, date: { lt }, OR: owner }, select: { date: true, paymentMode: true, accountId: true } }),
    t.accountTxn.findMany({ where: { companyId, date: { lt }, OR: [{ fromAccountId: accountId }, { toAccountId: accountId }] }, select: { date: true } }),
  ])
  return payments.filter((p) => (p.accountId ?? fallbackId(fb, p.mode)) === accountId && before(p.date)).length
    + expenses.filter((e) => (e.accountId ?? fallbackId(fb, e.paymentMode)) === accountId && before(e.date)).length
    + txns.filter((x) => before(x.date)).length
}
