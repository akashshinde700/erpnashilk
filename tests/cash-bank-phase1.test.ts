import { afterEach, beforeEach, describe, expect, setSystemTime, test } from 'bun:test'
import { db } from '@/lib/db'
import { accountBalances, ensureCashAccount } from '@/lib/accounts'
import { cashFlow, endOfDayStr, positionAsOf } from '@/lib/accounting'
import { businessDate, istDay } from '@/lib/business-date'
import { GET as listAccounts, POST as createAccount } from '@/app/api/accounts/route'
import { PATCH as patchAccount } from '@/app/api/accounts/[id]/route'
import { GET as statement } from '@/app/api/accounts/[id]/statement/route'
import { PATCH as reconcile } from '@/app/api/accounts/[id]/reconcile/route'
import { POST as createTxn } from '@/app/api/account-txns/route'
import { POST as createPayment } from '@/app/api/payments/route'
import { PATCH as chequeAction } from '@/app/api/payments/[id]/route'
import { POST as createExpense } from '@/app/api/expenses/route'
import { PATCH as patchExpense } from '@/app/api/expenses/[id]/route'
import { POST as createLoan } from '@/app/api/loans/route'
import { POST as payEmi } from '@/app/api/loans/[id]/emi/route'
import { GET as dashboard } from '@/app/api/dashboard/route'
import { POST as createSalesInvoice } from '@/app/api/sales-invoices/route'
import { POST as createPurchaseInvoice } from '@/app/api/purchase-invoices/route'
import { apiRequest, call, ctx, type TestUser } from './helpers/api'
import { resetDb } from './helpers/db'
import { seedTenant, seedUser } from './helpers/seed'

/** Phase 1 regression tests: opening dates, account selection, post-dated cheques, Cash in Hand creation, IST dates. */

type Tenant = Awaited<ReturnType<typeof seedTenant>>
const DAY = 86_400_000

async function post(handler: (r: Request) => Promise<Response>, path: string, user: TestUser, body: Record<string, unknown>) {
  return call(handler(apiRequest(path, { user, body })))
}
const patch = (handler: (r: Request, c: { params: Promise<{ id: string }> }) => Promise<Response>, path: string, id: string, user: TestUser, body: Record<string, unknown>) =>
  call(handler(apiRequest(path, { method: 'PATCH', user, body }), ctx({ id })))

async function balances(t: Tenant): Promise<Record<string, number>> {
  const r = await call(listAccounts(apiRequest(`/api/accounts?companyId=${t.company.id}`, { user: t.user })))
  expect(r.status).toBe(200)
  return Object.fromEntries(r.json.data.items.map((a: { name: string; balance: number }) => [a.name, a.balance]))
}

async function addAccount(t: Tenant, body: Record<string, unknown>) {
  const r = await post(createAccount, '/api/accounts', t.user, { companyId: t.company.id, ...body })
  expect([r.status, r.json.error?.message]).toEqual([200, undefined])
  return r.json.data.id as string
}
const addBank = (t: Tenant, name = 'Test Bank', openingBalance = 0, openingDate: string | null = '2026-04-01', extra: Record<string, unknown> = {}) =>
  addAccount(t, { type: 'BANK', name, openingBalance, openingDate, ...extra })
const addCash = (t: Tenant, openingBalance = 0, openingDate: string | null = '2026-04-01') =>
  addAccount(t, { type: 'CASH', name: 'Cash in Hand', isDefault: true, openingBalance, openingDate })

async function parties(t: Tenant) {
  const [customer, supplier, item] = await Promise.all([
    db.customer.create({ data: { companyId: t.company.id, code: 'C-1', name: 'Test Customer' } }),
    db.supplier.create({ data: { companyId: t.company.id, code: 'S-1', name: 'Test Supplier' } }),
    db.item.create({ data: { companyId: t.company.id, code: 'IT-1', name: 'Test Part', uom: 'NOS' } }),
  ])
  return { customer, supplier, item }
}
const line = (itemId: string) => [{ itemId, qty: 10, rate: 100, discountPct: 0, gstRate: 0 }]
const salesInvoice = (t: Tenant, customerId: string, itemId: string, extra: Record<string, unknown> = {}) =>
  post(createSalesInvoice, '/api/sales-invoices', t.user, { companyId: t.company.id, customerId, date: '2026-05-10', lines: line(itemId), ...extra })
const purchaseInvoice = (t: Tenant, supplierId: string, itemId: string, extra: Record<string, unknown> = {}) =>
  post(createPurchaseInvoice, '/api/purchase-invoices', t.user, { companyId: t.company.id, supplierId, date: '2026-05-10', lines: line(itemId), ...extra })
const receipt = (t: Tenant, customerId: string, invoiceId: string, amount: number, extra: Record<string, unknown> = {}) =>
  post(createPayment, '/api/payments', t.user, { companyId: t.company.id, type: 'RECEIPT', customerId, invoiceType: 'SALES', invoiceId, amount, date: '2026-05-11', ...extra })
const expense = (t: Tenant, body: Record<string, unknown>) =>
  post(createExpense, '/api/expenses', t.user, { companyId: t.company.id, date: '2026-05-12', description: 'Test expense', category: 'UTILITIES', ...body })

beforeEach(resetDb)
afterEach(() => { setSystemTime() })

// ============================== 1. Opening balance and date ==============================

describe('opening balance and date', () => {
  test('an opening balance needs its opening date (create and edit); zero balance needs none', async () => {
    const t = await seedTenant()
    const r = await post(createAccount, '/api/accounts', t.user, { companyId: t.company.id, type: 'BANK', name: 'No Date', openingBalance: 5000 })
    expect([r.status, r.json.error?.message]).toEqual([400, 'Opening date is required when there is an opening balance'])
    const zero = await addBank(t, 'Zero Bank', 0, null)

    expect((await patch(patchAccount, `/api/accounts/${zero}`, zero, t.user, { companyId: t.company.id, openingBalance: 100 })).status).toBe(400)
    expect((await patch(patchAccount, `/api/accounts/${zero}`, zero, t.user, { companyId: t.company.id, openingBalance: 100, openingDate: '2026-04-01' })).status).toBe(200)
    expect((await patch(patchAccount, `/api/accounts/${zero}`, zero, t.user, { companyId: t.company.id, openingDate: null })).status).toBe(400)
  })

  test('an older account with a balance but no date can still be renamed; setting its balance asks for the date', async () => {
    const t = await seedTenant()
    // as saved before Phase 1 (synthetic, test database only)
    const legacy = await db.moneyAccount.create({ data: { companyId: t.company.id, type: 'BANK', name: 'Legacy Bank', openingBalance: 900 } })
    expect((await patch(patchAccount, `/api/accounts/${legacy.id}`, legacy.id, t.user, { companyId: t.company.id, name: 'Legacy Bank 2' })).status).toBe(200)
    expect((await patch(patchAccount, `/api/accounts/${legacy.id}`, legacy.id, t.user, { companyId: t.company.id, openingBalance: 950 })).status).toBe(400)
    expect((await balances(t))['Legacy Bank 2']).toBe(900)
  })

  test('money dated before the opening date is refused everywhere; the opening day itself is accepted', async () => {
    const t = await seedTenant()
    const bank = await addBank(t, 'Test Bank', 10000, '2026-05-01')
    const cash = await addCash(t, 0, '2026-05-01')
    const { customer, supplier, item } = await parties(t)
    const before = '2026-04-30'
    const tooEarly = [
      await post(createTxn, '/api/account-txns', t.user, { companyId: t.company.id, type: 'ADJUST_IN', toAccountId: bank, amount: 10, date: before }),
      await post(createTxn, '/api/account-txns', t.user, { companyId: t.company.id, type: 'CONTRA', fromAccountId: cash, toAccountId: bank, amount: 10, date: before }),
      await expense(t, { amount: 10, paymentMode: 'NEFT', accountId: bank, date: before }),
      await expense(t, { amount: 10, paymentMode: 'CASH', date: before }), // default cash account
      await salesInvoice(t, customer.id, item.id, { date: before, receivedAmount: 100, receivedMode: 'UPI', receivedAccountId: bank }),
      await purchaseInvoice(t, supplier.id, item.id, { date: before, paidNow: 100, paymentMode: 'CASH' }),
      await post(createLoan, '/api/loans', t.user, { companyId: t.company.id, name: 'L', principal: 1000, startDate: before, receivedAccountId: bank }),
    ]
    expect(tooEarly.map((r) => r.status)).toEqual([400, 400, 400, 400, 400, 400, 400])
    expect(tooEarly.every((r) => r.json.error?.message?.includes('before the opening date'))).toBe(true)
    // nothing half-saved by the refused invoice / bill
    expect(await db.salesInvoice.count({ where: { companyId: t.company.id } }) + await db.purchaseInvoice.count({ where: { companyId: t.company.id } })).toBe(0)

    const inv = await salesInvoice(t, customer.id, item.id, { date: '2026-05-01' })
    expect((await receipt(t, customer.id, inv.json.data.id, 100, { mode: 'UPI', accountId: bank, date: before })).status).toBe(400)
    expect((await receipt(t, customer.id, inv.json.data.id, 100, { mode: 'UPI', accountId: bank, date: '2026-05-01' })).status).toBe(200)

    const loan = await post(createLoan, '/api/loans', t.user, { companyId: t.company.id, name: 'L2', principal: 1000, startDate: '2026-05-01', receivedAccountId: bank })
    expect(loan.status).toBe(200)
    const emi = await call(payEmi(apiRequest(`/api/loans/${loan.json.data.id}/emi`, { user: t.user, body: { companyId: t.company.id, date: before, principal: 100, interest: 0, fromAccountId: bank } }), ctx({ id: loan.json.data.id })))
    expect(emi.status).toBe(400)
    expect(await balances(t)).toEqual({ 'Cash in Hand': 0, 'Test Bank': 11100 })
  })

  test('the opening date cannot move after existing entries; moving it earlier is fine', async () => {
    const t = await seedTenant()
    const bank = await addBank(t, 'Test Bank', 1000, '2026-04-01')
    await post(createTxn, '/api/account-txns', t.user, { companyId: t.company.id, type: 'ADJUST_IN', toAccountId: bank, amount: 50, date: '2026-04-10' })
    const later = await patch(patchAccount, `/api/accounts/${bank}`, bank, t.user, { companyId: t.company.id, openingDate: '2026-04-15' })
    expect([later.status, later.json.error?.message]).toEqual([400, '1 entry is dated before 2026-04-15 in this account — the opening date cannot be after them'])
    expect((await patch(patchAccount, `/api/accounts/${bank}`, bank, t.user, { companyId: t.company.id, openingDate: '2026-04-10' })).status).toBe(200)
    expect((await patch(patchAccount, `/api/accounts/${bank}`, bank, t.user, { companyId: t.company.id, openingDate: '2026-03-01' })).status).toBe(200)
  })

  test('audit log keeps old → new opening balance and date with the user and time', async () => {
    const t = await seedTenant()
    const bank = await addBank(t, 'Test Bank', 50000, '2026-04-01')
    const t0 = Date.now()
    // outside Next.js there is no session, so logAudit records the name sent; in the app it is the signed-in user
    await patch(patchAccount, `/api/accounts/${bank}`, bank, t.user, { companyId: t.company.id, openingBalance: 45000, openingDate: '2026-03-15', userName: t.user.name })
    const log = await db.auditLog.findFirstOrThrow({ where: { companyId: t.company.id, entity: 'MoneyAccount', action: 'UPDATE' } })
    expect(log.details).toBe('Account "Test Bank" updated: opening balance ₹50000.00 → ₹45000.00; opening date 2026-04-01 → 2026-03-15')
    expect(log.userName).toBe(t.user.name)
    expect(log.createdAt.getTime()).toBeGreaterThanOrEqual(t0 - 1000)
    const created = await db.auditLog.findFirstOrThrow({ where: { companyId: t.company.id, entity: 'MoneyAccount', action: 'CREATE' } })
    expect(created.details).toContain('opening ₹50000.00 as of 2026-04-01')
  })

  test('historical balances, statement and cash-flow report use the opening date', async () => {
    const t = await seedTenant()
    const bank = await addBank(t, 'Test Bank', 50000, '2026-05-01')
    await post(createTxn, '/api/account-txns', t.user, { companyId: t.company.id, type: 'ADJUST_IN', toAccountId: bank, amount: 700, date: '2026-05-05' })
    const at = async (d: string) => (await accountBalances(t.company.id, endOfDayStr(d))).find((b) => b.id === bank)?.balance
    expect([await at('2026-04-30'), await at('2026-05-01'), await at('2026-05-04'), await at('2026-05-05')]).toEqual([0, 50000, 50000, 50700])

    const s = await call(statement(apiRequest(`/api/accounts/${bank}/statement?companyId=${t.company.id}&from=2026-04-01&to=2026-05-31`, { user: t.user }), ctx({ id: bank })))
    expect(s.json.data.opening).toBe(0)
    expect(s.json.data.rows.map((r: { kind: string; in: number; balance: number }) => [r.kind, r.in, r.balance])).toEqual([['opening', 50000, 50000], ['txn', 700, 50700]])

    const cf = await cashFlow(t.company.id, new Date('2026-04-01'), endOfDayStr('2026-05-31'))
    expect([cf.opening, cf.closing, cf.difference]).toEqual([0, 50700, 0])
  })
})

// ============================== 2. Expenses and account selection ==============================

describe('expenses and account selection', () => {
  test('DRAFT moves no money; posting it does; cancelling it takes it back out — balance, cash flow and P&L agree', async () => {
    const t = await seedTenant()
    await addCash(t, 1000)
    const e = await expense(t, { amount: 300, paymentMode: 'CASH', status: 'DRAFT' })
    expect((await balances(t))['Cash in Hand']).toBe(1000)
    let cf = await cashFlow(t.company.id, new Date('2026-04-01'), endOfDayStr('2026-05-31'))
    expect([cf.closing, cf.difference]).toEqual([1000, 0])

    const id = e.json.data.id
    expect((await patch(patchExpense, `/api/expenses/${id}`, id, t.user, { companyId: t.company.id, status: 'POSTED' })).status).toBe(200)
    expect((await balances(t))['Cash in Hand']).toBe(700)
    cf = await cashFlow(t.company.id, new Date('2026-04-01'), endOfDayStr('2026-05-31'))
    expect([cf.closing, cf.difference]).toEqual([700, 0])
    const pos = await positionAsOf(t.company.id, endOfDayStr('2026-05-31'))
    expect(pos.pl.netProfit).toBe(-300)

    expect((await patch(patchExpense, `/api/expenses/${id}`, id, t.user, { companyId: t.company.id, status: 'CANCELLED' })).status).toBe(200)
    expect((await balances(t))['Cash in Hand']).toBe(1000)
  })

  test('changing the payment mode moves the expense to an account of the new kind; audit shows the change', async () => {
    const t = await seedTenant()
    await addCash(t)
    const bank = await addBank(t, 'Main Bank', 0, '2026-04-01', { isDefault: true })
    const e = await expense(t, { amount: 200, paymentMode: 'CASH', allowNegativeCash: true }) // Tenant Admin override (Phase 5)
    const id = e.json.data.id
    expect(await balances(t)).toEqual({ 'Cash in Hand': -200, 'Main Bank': 0 })

    expect((await patch(patchExpense, `/api/expenses/${id}`, id, t.user, { companyId: t.company.id, paymentMode: 'NEFT' })).status).toBe(200)
    expect((await db.expense.findUniqueOrThrow({ where: { id } })).accountId).toBe(bank)
    expect(await balances(t)).toEqual({ 'Cash in Hand': 0, 'Main Bank': -200 })

    // bank → bank mode change keeps the chosen bank
    const other = await addBank(t, 'Other Bank')
    await patch(patchExpense, `/api/expenses/${id}`, id, t.user, { companyId: t.company.id, accountId: other })
    await patch(patchExpense, `/api/expenses/${id}`, id, t.user, { companyId: t.company.id, paymentMode: 'UPI' })
    expect((await db.expense.findUniqueOrThrow({ where: { id } })).accountId).toBe(other)

    const logs = await db.auditLog.findMany({ where: { companyId: t.company.id, entity: 'EXPENSE', action: 'UPDATE' }, orderBy: { createdAt: 'asc' } })
    expect(logs[0].details).toContain('mode CASH → NEFT')
    expect(logs[0].details).toContain('account Cash in Hand → Main Bank')
  })

  test('an unknown, inactive or other company\'s account is refused everywhere — never swapped for the default', async () => {
    const t = await seedTenant()
    const other = await seedTenant()
    await addCash(t)
    const inactive = await addBank(t, 'Closed Bank')
    await patch(patchAccount, `/api/accounts/${inactive}`, inactive, t.user, { companyId: t.company.id, active: false })
    const foreign = await addBank(other, 'Their Bank')
    const { customer, supplier, item } = await parties(t)
    const inv = await salesInvoice(t, customer.id, item.id)

    for (const [acc, status] of [[inactive, 400], ['no-such-account', 404], [foreign, 404]] as const) {
      expect((await receipt(t, customer.id, inv.json.data.id, 10, { mode: 'UPI', accountId: acc })).status).toBe(status)
      expect((await expense(t, { amount: 10, paymentMode: 'NEFT', accountId: acc })).status).toBe(status)
      expect((await salesInvoice(t, customer.id, item.id, { receivedAmount: 10, receivedMode: 'UPI', receivedAccountId: acc })).status).toBe(status)
      expect((await purchaseInvoice(t, supplier.id, item.id, { paidNow: 10, paymentMode: 'NEFT', accountId: acc })).status).toBe(status)
    }
    expect(await db.payment.count({ where: { companyId: t.company.id } })).toBe(0)
    expect(await db.expense.count({ where: { companyId: t.company.id } })).toBe(0)
    expect(await db.salesInvoice.count({ where: { companyId: t.company.id } })).toBe(1) // only the first, plain invoice
    expect(await db.purchaseInvoice.count({ where: { companyId: t.company.id } })).toBe(0)
    expect((await balances(other))['Their Bank']).toBe(0)
  })

  test('an expense may keep its account after that account was deactivated', async () => {
    const t = await seedTenant()
    const bank = await addBank(t)
    const e = await expense(t, { amount: 100, paymentMode: 'NEFT', accountId: bank })
    await patch(patchAccount, `/api/accounts/${bank}`, bank, t.user, { companyId: t.company.id, active: false })
    const id = e.json.data.id
    expect((await patch(patchExpense, `/api/expenses/${id}`, id, t.user, { companyId: t.company.id, accountId: bank, description: 'Edited' })).status).toBe(200)
  })
})

// ============================== 3. Post-dated cheques ==============================

describe('post-dated cheques', () => {
  test('received with the invoice: settles it at once, reaches the bank on its clearing date', async () => {
    const t = await seedTenant()
    const bank = await addBank(t)
    const { customer, item } = await parties(t)
    setSystemTime(new Date('2026-05-10T06:00:00Z'))
    const inv = await salesInvoice(t, customer.id, item.id, { receivedAmount: 1000, receivedMode: 'CHEQUE', receivedAccountId: bank, receivedChequeNo: '123456', receivedChequeDate: '2026-05-20' })
    expect(inv.status).toBe(200)
    const pay = await db.payment.findFirstOrThrow({ where: { companyId: t.company.id, invoiceId: inv.json.data.id } })
    expect([pay.chequeStatus, pay.chequeNo, istDay(pay.chequeDate!)]).toEqual(['PENDING', '123456', '2026-05-20'])
    expect((await db.salesInvoice.findUniqueOrThrow({ where: { id: inv.json.data.id } })).status).toBe('PAID')
    expect((await balances(t))['Test Bank']).toBe(0)
    expect((await positionAsOf(t.company.id, endOfDayStr('2026-05-10'))).chequesInHand).toBe(1000)

    const clear = (date?: string) => patch(chequeAction, `/api/payments/${pay.id}`, pay.id, t.user, { companyId: t.company.id, action: 'clear', ...(date ? { date } : {}) })
    expect((await clear()).json.error?.message).toContain('before its cheque date') // today is 10 May
    setSystemTime(new Date('2026-05-22T06:00:00Z'))
    expect((await clear('2026-05-25')).json.error?.message).toBe('The clearing date cannot be in the future')
    expect((await clear('2026-05-21')).status).toBe(200)

    const at = async (d: string) => (await accountBalances(t.company.id, endOfDayStr(d))).find((b) => b.id === bank)?.balance
    expect([await at('2026-05-20'), await at('2026-05-21')]).toEqual([0, 1000])
    expect((await positionAsOf(t.company.id, endOfDayStr('2026-05-20'))).chequesInHand).toBe(1000) // still in hand that day
    expect((await positionAsOf(t.company.id, endOfDayStr('2026-05-21'))).chequesInHand).toBe(0)
    const s = await call(statement(apiRequest(`/api/accounts/${bank}/statement?companyId=${t.company.id}&from=2026-05-01&to=2026-05-31`, { user: t.user }), ctx({ id: bank })))
    expect(s.json.data.rows.map((r: { date: string; in: number }) => [String(r.date).slice(0, 10), r.in])).toEqual([['2026-05-21', 1000]])
    const cf = await cashFlow(t.company.id, new Date('2026-05-01'), endOfDayStr('2026-05-20'))
    expect([cf.closing, cf.difference]).toEqual([0, 0])
    const cf2 = await cashFlow(t.company.id, new Date('2026-05-21'), endOfDayStr('2026-05-31'))
    expect([cf2.opening, cf2.closing, cf2.difference]).toEqual([0, 1000, 0])
  })

  test('paid with a bill: leaves the bank only when cleared; bounce reopens the bill and never touches the bank', async () => {
    const t = await seedTenant()
    const bank = await addBank(t, 'Test Bank', 5000)
    const { supplier, item } = await parties(t)
    setSystemTime(new Date('2026-05-10T06:00:00Z'))
    const bill = await purchaseInvoice(t, supplier.id, item.id, { paidNow: 1000, paymentMode: 'CHEQUE', accountId: bank, chequeNo: '777', chequeDate: '2026-06-01' })
    expect(bill.status).toBe(200)
    const pay = await db.payment.findFirstOrThrow({ where: { companyId: t.company.id, invoiceId: bill.json.data.id } })
    expect(pay.chequeStatus).toBe('PENDING')
    expect((await balances(t))['Test Bank']).toBe(5000)
    const b = await patch(chequeAction, `/api/payments/${pay.id}`, pay.id, t.user, { companyId: t.company.id, action: 'bounce' })
    expect(b.status).toBe(200)
    expect((await balances(t))['Test Bank']).toBe(5000)
    expect((await db.purchaseInvoice.findUniqueOrThrow({ where: { id: bill.json.data.id } })).status).toBe('UNPAID')
  })

  test('the clearing date cannot be before the payment date; reconciliation cannot bypass the cheque actions', async () => {
    const t = await seedTenant()
    const bank = await addBank(t)
    const { customer, item } = await parties(t)
    setSystemTime(new Date('2026-05-10T06:00:00Z'))
    const inv = await salesInvoice(t, customer.id, item.id, { date: '2026-05-10' })
    const r = await receipt(t, customer.id, inv.json.data.id, 500, { mode: 'CHEQUE', accountId: bank, chequeNo: '1', chequeDate: '2026-05-12', date: '2026-05-10' })
    const id = r.json.data.id
    expect((await call(reconcile(apiRequest(`/api/accounts/${bank}/reconcile`, { method: 'PATCH', user: t.user, body: { companyId: t.company.id, kind: 'payment', id, clearedDate: '2026-05-12' } }), ctx({ id: bank })))).status).toBe(400)
    setSystemTime(new Date('2026-05-15T06:00:00Z'))
    expect((await patch(chequeAction, `/api/payments/${id}`, id, t.user, { companyId: t.company.id, action: 'clear', date: '2026-05-09' })).status).toBe(400)
    expect((await patch(chequeAction, `/api/payments/${id}`, id, t.user, { companyId: t.company.id, action: 'clear', date: '2026-05-13' })).status).toBe(200)
    // a cleared cheque keeps a clearing date; it can be corrected to another valid day
    const rec = (clearedDate: string | null) => call(reconcile(apiRequest(`/api/accounts/${bank}/reconcile`, { method: 'PATCH', user: t.user, body: { companyId: t.company.id, kind: 'payment', id, clearedDate } }), ctx({ id: bank })))
    expect((await rec(null)).status).toBe(400)
    expect((await rec('2026-05-11')).status).toBe(400)
    expect((await rec('2026-05-14')).status).toBe(200)
    expect((await accountBalances(t.company.id, endOfDayStr('2026-05-13'))).find((x) => x.id === bank)?.balance).toBe(0)
    expect((await accountBalances(t.company.id, endOfDayStr('2026-05-14'))).find((x) => x.id === bank)?.balance).toBe(500)
  })

  test('a cheque dated on or before today is not post-dated and counts on the payment date', async () => {
    const t = await seedTenant()
    const bank = await addBank(t)
    const { customer, item } = await parties(t)
    setSystemTime(new Date('2026-05-10T06:00:00Z'))
    await salesInvoice(t, customer.id, item.id, { receivedAmount: 300, receivedMode: 'CHEQUE', receivedAccountId: bank, receivedChequeDate: '2026-05-10' })
    expect((await accountBalances(t.company.id, endOfDayStr('2026-05-10'))).find((b) => b.id === bank)?.balance).toBe(300)
  })
})

// ============================== 4. Cash in Hand creation ==============================

describe('Cash in Hand creation', () => {
  test('reading accounts, statements and the dashboard creates no account', async () => {
    const t = await seedTenant()
    await balances(t)
    await balances(t)
    const d = await call(dashboard(apiRequest(`/api/dashboard?companyId=${t.company.id}`, { user: t.user })))
    expect(d.status).toBe(200)
    await accountBalances(t.company.id)
    expect(await db.moneyAccount.count({ where: { companyId: t.company.id } })).toBe(0)
  })

  test('ten simultaneous ensureCashAccount calls create exactly one Cash in Hand', async () => {
    const t = await seedTenant()
    await Promise.all(Array.from({ length: 10 }, () => ensureCashAccount(t.company.id)))
    const cash = await db.moneyAccount.findMany({ where: { companyId: t.company.id, type: 'CASH' } })
    expect(cash.map((c) => [c.name, c.isDefault])).toEqual([['Cash in Hand', true]])
  })

  // 6 at once — more than the test pool (5 connections); numbering runs inside the transaction since CB-R1
  test('the first cash postings, sent together, share one Cash in Hand', async () => {
    const t = await seedTenant()
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => expense(t, { amount: 10 + i, paymentMode: 'CASH', allowNegativeCash: true })))
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200, 200])
    const cash = await db.moneyAccount.findMany({ where: { companyId: t.company.id, type: 'CASH' } })
    expect(cash.map((c) => [c.name, c.isDefault])).toEqual([['Cash in Hand', true]])
    expect((await balances(t))['Cash in Hand']).toBe(-75)
  })

  test('concurrent invoices with cash received also share one Cash in Hand', async () => {
    const t = await seedTenant()
    const { customer, item } = await parties(t)
    const results = await Promise.all(Array.from({ length: 6 }, () => salesInvoice(t, customer.id, item.id, { receivedAmount: 100, receivedMode: 'CASH' })))
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200, 200])
    expect(await db.moneyAccount.count({ where: { companyId: t.company.id, type: 'CASH' } })).toBe(1)
    expect((await balances(t))['Cash in Hand']).toBe(600)
  })

  test('an explicitly created cash account is used; a second "Cash in Hand" is refused', async () => {
    const t = await seedTenant()
    const petty = await addAccount(t, { type: 'CASH', name: 'Petty Cash', isDefault: true })
    await expense(t, { amount: 50, paymentMode: 'CASH', allowNegativeCash: true })
    expect(await balances(t)).toEqual({ 'Petty Cash': -50 })
    expect(petty).toBeTruthy()
    await addCash(t)
    expect((await post(createAccount, '/api/accounts', t.user, { companyId: t.company.id, type: 'CASH', name: 'Cash in Hand' })).status).toBe(409)
  })
})

// ============================== 5. Dates and time zone (IST) ==============================

describe('business dates in IST', () => {
  test('businessDate: a day stays that day; a timestamp becomes its IST day; empty is today in IST', () => {
    expect(businessDate('2026-05-10').toISOString()).toBe('2026-05-10T00:00:00.000Z')
    expect(businessDate('2026-05-10T18:29:00.000Z').toISOString()).toBe('2026-05-10T00:00:00.000Z') // 23:59 IST on the 10th
    expect(businessDate('2026-05-10T18:30:00.000Z').toISOString()).toBe('2026-05-11T00:00:00.000Z') // 00:00 IST on the 11th
    expect(businessDate(new Date('2026-05-10T23:00:00Z')).toISOString()).toBe('2026-05-11T00:00:00.000Z')
    setSystemTime(new Date('2026-05-10T19:00:00Z')) // 00:30 IST on 11 May
    expect(businessDate(undefined).toISOString()).toBe('2026-05-11T00:00:00.000Z')
    expect(() => businessDate('2026-02-30')).toThrow('not a valid date')
    expect(() => businessDate('banana')).toThrow('valid date')
  })

  test('an entry saved at 00:30 IST without a date belongs to that IST day in balances, statement and cash flow', async () => {
    const t = await seedTenant()
    const bank = await addBank(t, 'Test Bank', 1000, '2026-04-01')
    setSystemTime(new Date('2026-05-10T19:00:00Z')) // 11 May, 00:30 IST
    const r = await post(createTxn, '/api/account-txns', t.user, { companyId: t.company.id, type: 'ADJUST_IN', toAccountId: bank, amount: 250 })
    expect(r.status).toBe(200)
    expect(new Date(r.json.data.date).toISOString()).toBe('2026-05-11T00:00:00.000Z')

    const at = async (d: string) => (await accountBalances(t.company.id, endOfDayStr(d))).find((b) => b.id === bank)?.balance
    expect([await at('2026-05-10'), await at('2026-05-11')]).toEqual([1000, 1250])
    const day = async (d: string) => (await call(statement(apiRequest(`/api/accounts/${bank}/statement?companyId=${t.company.id}&from=${d}&to=${d}`, { user: t.user }), ctx({ id: bank })))).json.data.totalIn
    expect([await day('2026-05-10'), await day('2026-05-11')]).toEqual([0, 250])
    const cf = await cashFlow(t.company.id, new Date('2026-05-11'), endOfDayStr('2026-05-11'))
    expect([cf.opening, cf.closing, cf.difference]).toEqual([1000, 1250, 0])
  })

  test('payments, expenses, cheque dates and opening dates sent as timestamps are stored as their IST day', async () => {
    const t = await seedTenant()
    const bank = await addBank(t, 'TZ Bank', 100, '2026-03-31T18:30:00.000Z') // 1 Apr 00:00 IST
    expect((await db.moneyAccount.findUniqueOrThrow({ where: { id: bank } })).openingDate?.toISOString()).toBe('2026-04-01T00:00:00.000Z')
    const { customer, item } = await parties(t)
    const inv = await salesInvoice(t, customer.id, item.id)
    const p = await receipt(t, customer.id, inv.json.data.id, 50, { mode: 'UPI', accountId: bank, date: '2026-05-11T20:00:00.000Z' })
    expect(new Date(p.json.data.date).toISOString()).toBe('2026-05-12T00:00:00.000Z')
    const e = await expense(t, { amount: 5, paymentMode: 'NEFT', accountId: bank, date: '2026-05-12T19:15:00.000Z' })
    expect(new Date(e.json.data.date).toISOString()).toBe('2026-05-13T00:00:00.000Z')
  })
})

// ============================== 6. Permissions, rollback, isolation ==============================

describe('permissions and rollback', () => {
  test('accountant may post Cash & Bank entries; a sales executive may not', async () => {
    const t = await seedTenant()
    const bank = await addBank(t)
    const accountant = await seedUser(t.company.id, 'ACCOUNTANT')
    const sales = await seedUser(t.company.id, 'SALES_EXECUTIVE')
    const body = { companyId: t.company.id, type: 'ADJUST_IN', toAccountId: bank, amount: 10, date: '2026-05-01' }
    expect((await post(createTxn, '/api/account-txns', accountant, body)).status).toBe(200)
    expect((await post(createTxn, '/api/account-txns', sales, body)).status).toBe(403)
    expect((await balances(t))['Test Bank']).toBe(10)
  })

  test('a refused post-dated receipt on the invoice leaves no invoice, no receipt and no number used', async () => {
    const t = await seedTenant()
    const bank = await addBank(t, 'Test Bank', 0, '2026-05-15')
    const { customer, item } = await parties(t)
    const bad = await salesInvoice(t, customer.id, item.id, { receivedAmount: 100, receivedMode: 'CHEQUE', receivedAccountId: bank, receivedChequeDate: '2099-01-01' })
    expect(bad.status).toBe(400) // invoice dated 10 May, before the account opened
    const ok = await salesInvoice(t, customer.id, item.id, { date: '2026-05-16' })
    expect(ok.json.data.number).toMatch(/0*1$/)
    expect(await db.payment.count({ where: { companyId: t.company.id } })).toBe(0)
  })
})
