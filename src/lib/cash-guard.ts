import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { ApiError, getActor, logAudit, r2 } from '@/lib/erp-helpers'
import { istDay } from '@/lib/business-date'
import { NON_MONEY_MODES, POSTED_EXPENSE, fallbackAccounts, fallbackId, moneyDate } from '@/lib/accounts'

/**
 * Cash & Bank Phase 5 guards.
 *
 * Negative cash: an entry that takes money out of a CASH account (or removes money that came in) is refused with
 * 409 NEGATIVE_CASH when the account's end-of-day balance would drop below zero on the entry's day or any later
 * day. Bank accounts are never checked (overdrafts are real). A Tenant Admin / Super Admin may save it anyway with
 * `allowNegativeCash: true`; that is written to the audit log. Any other role sending the flag gets 403.
 *
 * Concurrency: assertCashNotNegative() is the LAST step of the business transaction. It locks the cash account
 * rows (FOR UPDATE, id order) and only then reads the balances. The transaction must run with CASH_TX (READ
 * COMMITTED) so those reads see every entry committed by an earlier lock holder — under REPEATABLE READ the
 * snapshot would date from the transaction's first read and two concurrent outflows could both pass.
 *
 * Duplicates: refuseDuplicate() turns "same party / account, amount, mode on the same IST day" matches into
 * 409 POSSIBLE_DUPLICATE unless the user confirmed with `confirmDuplicate: true`.
 */

type Tx = Prisma.TransactionClient

/** Transaction options for any transaction that calls assertCashNotNegative(). */
export const CASH_TX = { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted }

const OVERRIDE_ROLES = ['TENANT_ADMIN', 'SUPER_ADMIN']

/** Who may save below zero on this request (from the verified session headers), or false when not asked. */
export type CashOverride = false | { userName: string; role: string }

/** Whether this request asks to save below zero; 403 unless the user is a Tenant Admin / Super Admin. */
export function negativeCashOverride(req: Request, body: { allowNegativeCash?: unknown } | null | undefined): CashOverride {
  if (body?.allowNegativeCash !== true) return false
  const actor = getActor(req)
  if (!actor || !OVERRIDE_ROLES.includes(actor.role)) {
    throw new ApiError('Only a Tenant Admin can save an entry that takes cash below zero', 403, 'NEGATIVE_CASH_OVERRIDE_DENIED')
  }
  return { userName: actor.userName, role: actor.role }
}

export interface CashCheck {
  companyId: string
  /** Accounts the entry touched (legacy rows: accountId null + mode → the default account). Non-cash ones are skipped. */
  accounts: { accountId?: string | null; mode?: string | null }[]
  /** First day whose balance can have dropped (the entry's date; the earlier one on an edit). null = from the start. */
  from: Date | null
  override: CashOverride
  /** "This payment", "Deleting RCPT-2627-000004", … */
  what: string
  entity: string
  entityId?: string
  userName?: string
}

const fmt = (n: number) => `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/** Refuses (409 NEGATIVE_CASH) or audit-logs an override when a checked cash account would end a day below zero. */
export async function assertCashNotNegative(tx: Tx, c: CashCheck) {
  const fb = await fallbackAccounts(tx, c.companyId)
  const wanted = [...new Set(c.accounts.map((a) => a.accountId ?? fallbackId(fb, a.mode)).filter((x): x is string => !!x))].sort()
  if (!wanted.length) return
  const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM MoneyAccount WHERE companyId = ${c.companyId} AND type = 'CASH' AND id IN (${Prisma.join(wanted)}) ORDER BY id FOR UPDATE`
  if (!locked.length) return
  const lows = await lowestCash(tx, c.companyId, locked.map((r) => r.id), c.from)
  for (const low of lows) {
    if (low.balance >= -0.005) continue
    const msg = `${c.what} takes ${low.name} below zero: ${fmt(low.balance)} at the end of ${low.date}. Short by ${fmt(-low.balance)}.`
    if (!c.override) {
      throw new ApiError(msg, 409, 'NEGATIVE_CASH', { accountId: low.id, accountName: low.name, date: low.date, balance: low.balance, shortfall: r2(-low.balance) })
    }
    await logAudit(tx as never, {
      companyId: c.companyId, userName: c.override.userName, action: 'NEGATIVE_CASH_OVERRIDE', entity: c.entity, entityId: c.entityId,
      details: `${msg} Saved anyway by ${c.override.userName} (${c.override.role}).`,
    })
  }
}

/**
 * Net change per IST day of each account ('' = the opening balance without a date, before every day), using the
 * same rules as accountBalances(): opening balance on its opening date, payments on their money date (pending /
 * deposited / bounced cheques and notes excluded), POSTED expenses, account entries; legacy rows on the default
 * account. Reads through `tx`, so it sees the transaction's own writes.
 */
async function dailyChanges(tx: Tx | typeof db, companyId: string, accountIds: string[]) {
  const t = tx as typeof db
  const fb = await fallbackAccounts(tx, companyId)
  const legacy = fb.cash && accountIds.includes(fb.cash.id) ? [{ accountId: null }] : []
  const owner = { OR: [{ accountId: { in: accountIds } }, ...legacy] }
  const [accounts, payments, expenses, txns] = await Promise.all([
    t.moneyAccount.findMany({ where: { companyId, id: { in: accountIds } }, select: { id: true, name: true, openingBalance: true, openingDate: true } }),
    t.payment.findMany({
      where: { companyId, mode: { notIn: NON_MONEY_MODES }, AND: [owner, { OR: [{ chequeStatus: null }, { chequeStatus: 'CLEARED' }] }] },
      select: { type: true, amount: true, mode: true, accountId: true, date: true, chequeStatus: true, clearedDate: true },
    }),
    t.expense.findMany({ where: { companyId, status: POSTED_EXPENSE, ...owner }, select: { amount: true, paymentMode: true, accountId: true, date: true } }),
    t.accountTxn.findMany({ where: { companyId, OR: [{ fromAccountId: { in: accountIds } }, { toAccountId: { in: accountIds } }] }, select: { fromAccountId: true, toAccountId: true, amount: true, date: true } }),
  ])
  const days = new Map(accountIds.map((id) => [id, new Map<string, number>()]))
  const add = (id: string | null | undefined, day: string, amt: number) => {
    const m = id ? days.get(id) : undefined
    if (m) m.set(day, (m.get(day) || 0) + amt)
  }
  for (const a of accounts) add(a.id, a.openingDate ? istDay(a.openingDate) : '', a.openingBalance)
  for (const p of payments) add(p.accountId ?? fallbackId(fb, p.mode), istDay(moneyDate(p)), p.type === 'RECEIPT' ? p.amount : -p.amount)
  for (const e of expenses) add(e.accountId ?? fallbackId(fb, e.paymentMode), istDay(e.date), -(e.amount || 0))
  for (const x of txns) { add(x.toAccountId, istDay(x.date), x.amount); add(x.fromAccountId, istDay(x.date), -x.amount) }
  const sorted = (id: string) => [...days.get(id)!.entries()].sort((x, y) => x[0].localeCompare(y[0]))
  return { accounts, sorted }
}

/** Lowest end-of-day balance of each account on or after `from` (IST day; null = all days). */
export async function lowestCash(tx: Tx | typeof db, companyId: string, accountIds: string[], from: Date | null) {
  const { accounts, sorted } = await dailyChanges(tx, companyId, accountIds)
  const fromDay = from ? istDay(from) : null
  return accounts.map((a) => {
    let running = 0
    let low: { balance: number; date: string } | null = null
    const seen = (balance: number, date: string) => { if (!low || balance < low.balance - 0.005) low = { balance: r2(balance), date } }
    // The end of `from` itself counts even when nothing else happened that day
    let fromSeen = !fromDay
    for (const [day, delta] of sorted(a.id)) {
      if (!fromSeen && day > fromDay!) { seen(running, fromDay!); fromSeen = true }
      running += delta
      if (!fromDay || day >= fromDay) seen(running, day || 'the start')
      if (day === fromDay) fromSeen = true
    }
    if (!fromSeen) seen(running, fromDay!)
    const l = (low as { balance: number; date: string } | null) ?? { balance: r2(running), date: istDay(new Date()) }
    return { id: a.id, name: a.name, balance: l.balance, date: l.date }
  })
}

/**
 * Adjust Cash: the balance the user reviewed (`expected`, end of `date`, before this entry) must still be the
 * balance — otherwise 409 BALANCE_CHANGED with the current figure. Call it at the end of the transaction, after the
 * entry (`change`: + in / − out) is written: it locks the account row and compares the balance including the entry.
 */
export async function assertBalanceUnchanged(tx: Tx, companyId: string, accountId: string, date: Date, expected: number, change: number) {
  await tx.$queryRaw`SELECT id FROM MoneyAccount WHERE companyId = ${companyId} AND id = ${accountId} FOR UPDATE`
  const { sorted } = await dailyChanges(tx, companyId, [accountId])
  const day = istDay(date)
  const now = r2(sorted(accountId).filter(([d]) => d <= day).reduce((s, [, v]) => s + v, 0) - change)
  if (Math.abs(now - r2(expected)) > 0.005) {
    throw new ApiError(`The balance changed meanwhile: it is now ${fmt(now)}, not ${fmt(expected)}. Review the difference again.`, 409, 'BALANCE_CHANGED', { balance: now })
  }
}

/**
 * Range around an IST day that also catches legacy timestamps (filter the rows with sameIstDay afterwards).
 */
export function dayWindow(date: Date) {
  return { gte: new Date(date.getTime() - 86_400_000), lt: new Date(date.getTime() + 2 * 86_400_000) }
}
export const sameIstDay = (a: Date, b: Date) => istDay(a) === istDay(b)

/** 409 POSSIBLE_DUPLICATE listing the matching entries, unless the user confirmed. */
export function refuseDuplicate(numbers: string[], confirmed: unknown, what: string) {
  if (!numbers.length || confirmed === true) return
  throw new ApiError(
    `Possible duplicate: ${numbers.join(', ')} ${numbers.length === 1 ? 'has' : 'have'} the same ${what} on the same day. Save anyway?`,
    409, 'POSSIBLE_DUPLICATE', { matches: numbers },
  )
}
