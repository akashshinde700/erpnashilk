import { afterEach, beforeEach, describe, expect, setSystemTime, test } from 'bun:test'
import { db } from '@/lib/db'
import { accountBalances } from '@/lib/accounts'
import { balanceSheetFrom, cashFlow, endOfDayStr, positionAsOf, profitAndLoss, trialBalanceFrom } from '@/lib/accounting'
import { accountsForMode } from '@/lib/erp-constants'
import { POST as createAccount } from '@/app/api/accounts/route'
import { POST as createTxn } from '@/app/api/account-txns/route'
import { POST as createPayment } from '@/app/api/payments/route'
import { POST as createExpense } from '@/app/api/expenses/route'
import { PATCH as patchExpense } from '@/app/api/expenses/[id]/route'
import { POST as createSalesInvoice } from '@/app/api/sales-invoices/route'
import { POST as createPurchaseInvoice } from '@/app/api/purchase-invoices/route'
import { apiRequest, call, ctx } from './helpers/api'
import { resetDb } from './helpers/db'
import { seedTenant } from './helpers/seed'

/**
 * Cash & Bank Phase 3: payment mode ↔ account type (CB-R5: CASH → cash account, UPI / NEFT / RTGS / CHEQUE / BANK →
 * bank account, no fallback to cash, legacy records keep their account) and Adjust Cash (counted cash: excess = Other
 * income, shortage = Other expense, through the existing Add / Reduce money entries).
 */

const NOW = new Date('2026-06-01T06:00:00Z')
const BANK_MODES = ['UPI', 'NEFT', 'RTGS', 'CHEQUE', 'BANK']

async function setup(opts: { cash?: boolean; bank?: boolean } = {}) {
  const t = await seedTenant()
  const c = t.company.id
  const send = (handler: (r: Request) => Promise<Response>, path: string, body: Record<string, unknown>) =>
    call(handler(apiRequest(path, { user: t.user, body: { companyId: c, ...body } })))
  const mk = async (body: Record<string, unknown>) => {
    const r = await send(createAccount, '/api/accounts', body)
    expect([r.status, r.json.error?.message]).toEqual([200, undefined])
    return r.json.data.id as string
  }
  const cash = opts.cash === false ? null : await mk({ type: 'CASH', name: 'Cash in Hand', isDefault: true, openingBalance: 5000, openingDate: '2026-04-01' })
  const bank = opts.bank === false ? null : await mk({ type: 'BANK', name: 'Main Bank', isDefault: true, openingBalance: 10000, openingDate: '2026-04-01' })
  const [customer, supplier, item] = await Promise.all([
    db.customer.create({ data: { companyId: c, code: 'C-1', name: 'Test Customer' } }),
    db.supplier.create({ data: { companyId: c, code: 'S-1', name: 'Test Supplier' } }),
    db.item.create({ data: { companyId: c, code: 'IT-1', name: 'Test Part', uom: 'NOS' } }),
  ])
  const line = [{ itemId: item.id, qty: 1, rate: 1000, discountPct: 0, gstRate: 0 }]
  const invoice = async () => {
    const r = await send(createSalesInvoice, '/api/sales-invoices', { customerId: customer.id, date: '2026-05-10', lines: line })
    expect(r.status).toBe(200)
    return r.json.data.id as string
  }
  const counts = async () => ({
    payments: await db.payment.count({ where: { companyId: c } }),
    expenses: await db.expense.count({ where: { companyId: c } }),
    invoices: await db.salesInvoice.count({ where: { companyId: c } }),
    bills: await db.purchaseInvoice.count({ where: { companyId: c } }),
    accounts: await db.moneyAccount.count({ where: { companyId: c } }),
  })
  // One money document per route, with a given mode and (optional) chosen account
  // These check account selection only; money out may take a new, empty cash account below zero (Phase 5 override)
  const routes: Record<string, (mode: string, accountId?: string | null) => ReturnType<typeof send>> = {
    payment: async (mode, accountId) => send(createPayment, '/api/payments', { type: 'RECEIPT', customerId: customer.id, invoiceType: 'SALES', invoiceId: await invoice(), amount: 100, mode, accountId: accountId ?? undefined, date: '2026-05-11' }),
    expense: (mode, accountId) => send(createExpense, '/api/expenses', { date: '2026-05-12', description: 'Test', category: 'OTHER', amount: 100, paymentMode: mode, accountId: accountId ?? undefined, allowNegativeCash: true }),
    salesInvoice: (mode, accountId) => send(createSalesInvoice, '/api/sales-invoices', { customerId: customer.id, date: '2026-05-10', lines: line, receivedAmount: 100, receivedMode: mode, receivedAccountId: accountId ?? undefined }),
    purchaseBill: (mode, accountId) => send(createPurchaseInvoice, '/api/purchase-invoices', { supplierId: supplier.id, date: '2026-05-10', lines: [{ itemId: item.id, qty: 1, rate: 1000, gstRate: 0 }], paidNow: 100, paymentMode: mode, accountId: accountId ?? undefined, allowNegativeCash: true }),
  }
  return { t, c, cash, bank, send, mk, routes, counts }
}

beforeEach(async () => { setSystemTime(NOW); await resetDb() })
afterEach(() => { setSystemTime() })

describe('CB-R5: payment mode must match the account type', () => {
  test('matching pairs are accepted on every route (cash → cash account, bank modes → bank account)', async () => {
    const s = await setup()
    for (const [name, route] of Object.entries(s.routes)) {
      expect([name, 'CASH', (await route('CASH', s.cash)).status]).toEqual([name, 'CASH', 200])
      for (const mode of ['UPI', 'NEFT']) expect([name, mode, (await route(mode, s.bank)).status]).toEqual([name, mode, 200])
    }
  })

  test('a bank mode into a cash account, or cash into a bank account, is refused on every route — nothing saved', async () => {
    const s = await setup()
    for (const [name, route] of Object.entries(s.routes)) {
      const before = await s.counts()
      const a = await route('UPI', s.cash)
      expect([name, a.status, a.json.error?.message]).toEqual([name, 400, 'UPI payments must use a bank account — Cash in Hand is a cash account'])
      const b = await route('CASH', s.bank)
      expect([name, b.status, b.json.error?.message]).toEqual([name, 400, 'Cash payments must use a cash account — Main Bank is a bank account'])
      const after = await s.counts()
      // the payment route's helper invoice is the only new row
      expect([name, after.payments, after.expenses, after.bills]).toEqual([name, before.payments, before.expenses, before.bills])
      if (name === 'salesInvoice') expect(after.invoices).toBe(before.invoices)
    }
    expect(await accountBalances(s.c)).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'Cash in Hand', balance: 5000 }), expect.objectContaining({ name: 'Main Bank', balance: 10000 })]))
  })

  test('no bank account: every bank mode is refused with a clear message — never posted to cash, no account created', async () => {
    const s = await setup({ bank: false })
    for (const [name, route] of Object.entries(s.routes)) {
      for (const mode of BANK_MODES) {
        const before = await s.counts()
        const r = await route(mode)
        expect([name, mode, r.status, r.json.error?.message]).toEqual([name, mode, 400, `No active bank account for ${mode} payments — add a bank account in Cash & Bank first`])
        const after = await s.counts()
        expect([name, mode, after.payments, after.expenses, after.bills, after.accounts]).toEqual([name, mode, before.payments, before.expenses, before.bills, before.accounts])
      }
    }
    expect((await accountBalances(s.c)).map((b) => [b.name, b.balance])).toEqual([['Cash in Hand', 5000]])
  })

  test('no cash account at all: a cash payment still creates Cash in Hand (unchanged); a bank payment does not', async () => {
    const s = await setup({ cash: false, bank: false })
    expect((await s.routes.expense('UPI')).status).toBe(400)
    expect(await db.moneyAccount.count({ where: { companyId: s.c } })).toBe(0)
    expect((await s.routes.expense('CASH')).status).toBe(200)
    expect((await db.moneyAccount.findMany({ where: { companyId: s.c } })).map((a) => [a.type, a.name])).toEqual([['CASH', 'Cash in Hand']])
  })

  test('default account when none is chosen: the default of the right type, else the oldest — same as the form shows', async () => {
    const s = await setup()
    const second = await s.mk({ type: 'BANK', name: 'Second Bank' })
    const e1 = await s.routes.expense('NEFT')
    expect((await db.expense.findUniqueOrThrow({ where: { id: e1.json.data.id } })).accountId).toBe(s.bank)
    const e2 = await s.routes.expense('CASH')
    expect((await db.expense.findUniqueOrThrow({ where: { id: e2.json.data.id } })).accountId).toBe(s.cash)
    // the UI helper picks the same account
    const accounts = (await db.moneyAccount.findMany({ where: { companyId: s.c } })).map((a) => ({ ...a, createdAt: a.createdAt.toISOString() }))
    expect(accountsForMode(accounts, 'NEFT').fallback?.id).toBe(s.bank!)
    expect(accountsForMode(accounts, 'NEFT').matching.map((a) => a.id).sort()).toEqual([s.bank!, second].sort())
    expect(accountsForMode(accounts, 'CASH').matching.map((a) => a.id)).toEqual([s.cash!])
    // without a default flag the oldest bank account is used
    await db.moneyAccount.updateMany({ where: { companyId: s.c, type: 'BANK' }, data: { isDefault: false } })
    const e3 = await s.routes.expense('UPI')
    expect((await db.expense.findUniqueOrThrow({ where: { id: e3.json.data.id } })).accountId).toBe(s.bank)
  })
})

describe('CB-R5: editing records saved before the rule', () => {
  test('an expense with a mismatched account keeps it while mode and account are unchanged; a new mismatch is refused', async () => {
    const s = await setup()
    // saved before the rule: UPI paid from the cash account (synthetic, test database only)
    const legacy = await db.expense.create({ data: { companyId: s.c, number: 'EXP-OLD-1', date: new Date('2026-05-05T00:00:00Z'), category: 'OTHER', description: 'Old', amount: 50, paymentMode: 'UPI', accountId: s.cash, status: 'POSTED' } })
    const edit = (body: Record<string, unknown>) => call(patchExpense(apiRequest(`/api/expenses/${legacy.id}`, { method: 'PATCH', user: s.t.user, body: { companyId: s.c, ...body } }), ctx({ id: legacy.id })))
    const r1 = await edit({ description: 'Old (edited)', paymentMode: 'UPI', accountId: s.cash })
    expect([r1.status, r1.json.error?.message]).toEqual([200, undefined])
    expect((await db.expense.findUniqueOrThrow({ where: { id: legacy.id } })).accountId).toBe(s.cash)
    const r2 = await edit({ paymentMode: 'NEFT', accountId: s.cash })
    expect(r2.status).toBe(400)
    const r3 = await edit({ paymentMode: 'NEFT', accountId: s.bank })
    expect(r3.status).toBe(200)
    expect((await db.expense.findUniqueOrThrow({ where: { id: legacy.id } })).accountId).toBe(s.bank)
  })

  test('an expense saved without any account stays without one when edited (no bank needed, nothing moves)', async () => {
    const s = await setup({ bank: false })
    const legacy = await db.expense.create({ data: { companyId: s.c, number: 'EXP-OLD-2', date: new Date('2026-05-05T00:00:00Z'), category: 'OTHER', description: 'Older', amount: 70, paymentMode: 'UPI', status: 'POSTED' } })
    const before = await accountBalances(s.c)
    const r = await call(patchExpense(apiRequest(`/api/expenses/${legacy.id}`, { method: 'PATCH', user: s.t.user, body: { companyId: s.c, description: 'Older (edited)', paymentMode: 'UPI', accountId: '' } }), ctx({ id: legacy.id })))
    expect([r.status, r.json.error?.message]).toEqual([200, undefined])
    expect((await db.expense.findUniqueOrThrow({ where: { id: legacy.id } })).accountId).toBeNull()
    expect(await accountBalances(s.c)).toEqual(before)
  })

  test('a mode change alone moves the expense to an account of the new type; refused when that type has no account', async () => {
    const s = await setup()
    const e = await s.routes.expense('CASH')
    const id = e.json.data.id
    const r = await call(patchExpense(apiRequest(`/api/expenses/${id}`, { method: 'PATCH', user: s.t.user, body: { companyId: s.c, paymentMode: 'UPI' } }), ctx({ id })))
    expect(r.status).toBe(200)
    expect((await db.expense.findUniqueOrThrow({ where: { id } })).accountId).toBe(s.bank)
    await db.moneyAccount.update({ where: { id: s.bank! }, data: { active: false, isDefault: false } })
    const r2 = await call(patchExpense(apiRequest(`/api/expenses/${id}`, { method: 'PATCH', user: s.t.user, body: { companyId: s.c, paymentMode: 'CASH' } }), ctx({ id })))
    expect(r2.status).toBe(200) // back to cash is fine
    const r3 = await call(patchExpense(apiRequest(`/api/expenses/${id}`, { method: 'PATCH', user: s.t.user, body: { companyId: s.c, paymentMode: 'RTGS' } }), ctx({ id })))
    expect([r3.status, r3.json.error?.message]).toEqual([400, 'No active bank account for RTGS payments — add a bank account in Cash & Bank first'])
  })
})

describe('Adjust Cash (counted cash vs books)', () => {
  // What the Adjust Cash popup posts: the existing Add / Reduce money entries
  const adjust = async (s: Awaited<ReturnType<typeof setup>>, counted: number) => {
    const books = (await accountBalances(s.c, endOfDayStr('2026-05-20'))).find((b) => b.id === s.cash)!.balance
    const diff = Math.round((counted - books) * 100) / 100
    if (Math.abs(diff) < 0.005) return { diff, saved: false }
    const r = await s.send(createTxn, '/api/account-txns', diff > 0
      ? { type: 'ADJUST_IN', toAccountId: s.cash, amount: diff, category: 'OTHER_INCOME', date: '2026-05-20', notes: 'Cash count' }
      : { type: 'ADJUST_OUT', fromAccountId: s.cash, amount: -diff, category: 'OTHER_EXPENSE', date: '2026-05-20', notes: 'Cash count' })
    expect(r.status).toBe(200)
    return { diff, saved: true }
  }
  const reports = async (c: string) => {
    const asOf = endOfDayStr('2026-05-31')
    const pos = await positionAsOf(c, asOf)
    return { pos, bs: balanceSheetFrom(pos), tb: trialBalanceFrom(pos), pl: await profitAndLoss(c, new Date('2026-04-01'), asOf), cf: await cashFlow(c, new Date('2026-04-01'), asOf) }
  }

  test('excess: cash rises to the counted amount, P&L other income, books stay balanced', async () => {
    const s = await setup({ bank: false })
    const before = await reports(s.c)
    expect(await adjust(s, 5250)).toEqual({ diff: 250, saved: true })
    expect((await accountBalances(s.c)).find((b) => b.id === s.cash)?.balance).toBe(5250)
    const r = await reports(s.c)
    expect([r.pl.otherIncome, r.pl.netProfit]).toEqual([250, before.pl.netProfit + 250])
    expect(r.bs.equity.find((e) => e.key === 'openingDiff')?.amount).toBe(before.bs.equity.find((e) => e.key === 'openingDiff')?.amount)
    // trial balance: unchanged by the adjustment (its existing difference = the account opening balance, AC-B5)
    expect([r.tb.difference, r.cf.difference]).toEqual([before.tb.difference, 0])
    expect(r.cf.inflows.find((x) => x.key === 'adj-OTHER_INCOME')?.amount).toBe(250)
  })

  test('shortage: cash falls to the counted amount, P&L other expense, books stay balanced', async () => {
    const s = await setup({ bank: false })
    const before = await reports(s.c)
    expect(await adjust(s, 4880)).toEqual({ diff: -120, saved: true })
    expect((await accountBalances(s.c)).find((b) => b.id === s.cash)?.balance).toBe(4880)
    const r = await reports(s.c)
    expect(r.pl.indirectExpenses.byCategory.find((x) => x.key === 'OTHER_EXPENSE_ADJ')?.amount).toBe(120)
    expect(r.pl.netProfit).toBe(before.pl.netProfit - 120)
    expect(r.bs.equity.find((e) => e.key === 'openingDiff')?.amount).toBe(before.bs.equity.find((e) => e.key === 'openingDiff')?.amount)
    expect([r.tb.difference, r.cf.difference]).toEqual([before.tb.difference, 0])
  })

  test('KNOWN GAP AC-B5 (pre-existing, not Phase 3): the trial balance has no line for account opening balances', async () => {
    const s = await setup({ bank: false }) // cash opening balance ₹5000, no other entries
    const r = await reports(s.c)
    expect([r.tb.totalDebit, r.tb.totalCredit, r.tb.difference]).toEqual([5000, 0, 5000])
    expect(r.bs.equity.find((e) => e.key === 'openingDiff')?.amount).toBe(5000) // the balance sheet absorbs it in its balancing line
  })

  test('zero difference: nothing is saved', async () => {
    const s = await setup({ bank: false })
    const n = await db.accountTxn.count({ where: { companyId: s.c } })
    expect(await adjust(s, 5000)).toEqual({ diff: 0, saved: false })
    expect(await db.accountTxn.count({ where: { companyId: s.c } })).toBe(n)
  })

  test('KNOWN RISK (kept by decision, Phase 5): Add money with category "Other" lands in the balance-sheet balancing figure', async () => {
    const s = await setup({ bank: false })
    const before = (await reports(s.c)).bs.equity.find((e) => e.key === 'openingDiff')!.amount
    const r = await s.send(createTxn, '/api/account-txns', { type: 'ADJUST_IN', toAccountId: s.cash, amount: 300, category: 'OTHER', date: '2026-05-20' })
    expect(r.status).toBe(200)
    const after = await reports(s.c)
    expect(after.bs.equity.find((e) => e.key === 'openingDiff')!.amount).toBe(before + 300) // not income, not capital
    expect(after.pl.otherIncome).toBe(0)
  })
})
