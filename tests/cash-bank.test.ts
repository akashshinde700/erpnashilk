import { afterEach, beforeEach, describe, expect, setSystemTime, test } from 'bun:test'
import { db } from '@/lib/db'
import { accountBalances } from '@/lib/accounts'
import { GET as listAccounts, POST as createAccount } from '@/app/api/accounts/route'
import { PATCH as patchAccount, GET as getAccount } from '@/app/api/accounts/[id]/route'
import { GET as statement } from '@/app/api/accounts/[id]/statement/route'
import { POST as createTxn } from '@/app/api/account-txns/route'
import { DELETE as deleteTxn } from '@/app/api/account-txns/[id]/route'
import { POST as createPayment } from '@/app/api/payments/route'
import { DELETE as voidPayment, PATCH as chequeAction } from '@/app/api/payments/[id]/route'
import { POST as createExpense } from '@/app/api/expenses/route'
import { POST as createLoan } from '@/app/api/loans/route'
import { POST as payEmi } from '@/app/api/loans/[id]/emi/route'
import { POST as createSalesInvoice } from '@/app/api/sales-invoices/route'
import { POST as createPurchaseInvoice } from '@/app/api/purchase-invoices/route'
import { POST as createSalesReturn } from '@/app/api/sales-returns/route'
import { POST as createPurchaseReturn } from '@/app/api/purchase-returns/route'
import { apiRequest, call, ctx, type TestUser } from './helpers/api'
import { resetDb } from './helpers/db'
import { seedTenant, seedUser } from './helpers/seed'

/**
 * Cash & Bank characterization tests (Phase 0), updated where Phase 1 changed the business rules.
 * Tests named "CURRENT BEHAVIOUR (Phase …)" document behaviour the audit flagged as a risk that a later
 * phase will change. Phase 1 regression tests are in cash-bank-phase1.test.ts.
 */

type Tenant = Awaited<ReturnType<typeof seedTenant>>

const futureDay = (days: number) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10)

async function post(handler: (r: Request) => Promise<Response>, path: string, user: TestUser, body: Record<string, unknown>) {
  return call(handler(apiRequest(path, { user, body })))
}

/** Balance of every account by name, through the same API the Cash & Bank screen uses. */
async function balances(t: Tenant): Promise<Record<string, number>> {
  const r = await call(listAccounts(apiRequest(`/api/accounts?companyId=${t.company.id}`, { user: t.user })))
  expect(r.status).toBe(200)
  return Object.fromEntries(r.json.data.items.map((a: { name: string; balance: number }) => [a.name, a.balance]))
}

/** Sets up "Cash in Hand" explicitly (reading balances never creates it). */
async function cashAccountId(t: Tenant) {
  const r = await post(createAccount, '/api/accounts', t.user, { companyId: t.company.id, type: 'CASH', name: 'Cash in Hand', isDefault: true })
  expect(r.status).toBe(200)
  return r.json.data.id as string
}

async function addBank(t: Tenant, name = 'Test Bank', openingBalance = 50000, extra: Record<string, unknown> = {}) {
  const r = await post(createAccount, '/api/accounts', t.user, { companyId: t.company.id, type: 'BANK', name, openingBalance, openingDate: '2026-04-01', ...extra })
  expect(r.status).toBe(200)
  return r.json.data.id as string
}

async function parties(t: Tenant) {
  const [customer, supplier, item] = await Promise.all([
    db.customer.create({ data: { companyId: t.company.id, code: 'C-1', name: 'Test Customer' } }),
    db.supplier.create({ data: { companyId: t.company.id, code: 'S-1', name: 'Test Supplier' } }),
    db.item.create({ data: { companyId: t.company.id, code: 'IT-1', name: 'Test Part', uom: 'NOS' } }),
  ])
  return { customer, supplier, item }
}

async function salesInvoice(t: Tenant, customerId: string, itemId: string, extra: Record<string, unknown> = {}) {
  const r = await post(createSalesInvoice, '/api/sales-invoices', t.user, {
    companyId: t.company.id, customerId, date: '2026-05-10', lines: [{ itemId, qty: 10, rate: 100, discountPct: 0, gstRate: 0 }], ...extra,
  })
  expect([r.status, r.json.error?.message]).toEqual([200, undefined])
  return r.json.data as { id: string; grandTotal: number }
}

async function purchaseInvoice(t: Tenant, supplierId: string, itemId: string, extra: Record<string, unknown> = {}) {
  const r = await post(createPurchaseInvoice, '/api/purchase-invoices', t.user, {
    companyId: t.company.id, supplierId, date: '2026-05-10', lines: [{ itemId, qty: 10, rate: 100, gstRate: 0 }], ...extra,
  })
  expect([r.status, r.json.error?.message]).toEqual([200, undefined])
  return r.json.data as { id: string; grandTotal: number; items: { id: string }[] }
}

const receipt = (t: Tenant, customerId: string, invoiceId: string, amount: number, extra: Record<string, unknown> = {}) =>
  post(createPayment, '/api/payments', t.user, { companyId: t.company.id, type: 'RECEIPT', customerId, invoiceType: 'SALES', invoiceId, amount, date: '2026-05-11', ...extra })

const paymentOut = (t: Tenant, supplierId: string, invoiceId: string, amount: number, extra: Record<string, unknown> = {}) =>
  post(createPayment, '/api/payments', t.user, { companyId: t.company.id, type: 'PAYMENT', supplierId, invoiceType: 'PURCHASE', invoiceId, amount, date: '2026-05-11', ...extra })

beforeEach(resetDb)
afterEach(() => { setSystemTime() })

describe('opening balance', () => {
  test('reading balances creates nothing; bank and cash opening balances set the starting balance', async () => {
    const t = await seedTenant()
    expect(await balances(t)).toEqual({})
    expect(await db.moneyAccount.count({ where: { companyId: t.company.id } })).toBe(0)

    await addBank(t, 'Test Bank', 50000)
    const cashId = await cashAccountId(t)
    const r = await call(patchAccount(apiRequest(`/api/accounts/${cashId}`, { method: 'PATCH', user: t.user, body: { companyId: t.company.id, openingBalance: 10000, openingDate: '2026-04-01' } }), ctx({ id: cashId })))
    expect(r.status).toBe(200)
    expect(await balances(t)).toEqual({ 'Cash in Hand': 10000, 'Test Bank': 50000 })

    // statement without a period starts at the opening balance and closes at the live balance
    const s = await call(statement(apiRequest(`/api/accounts/${cashId}/statement?companyId=${t.company.id}`, { user: t.user }), ctx({ id: cashId })))
    expect([s.json.data.opening, s.json.data.closing]).toEqual([10000, 10000])
  })

  test('a balance asked for before the opening date leaves the opening balance out', async () => {
    const t = await seedTenant()
    const bankId = await addBank(t, 'Test Bank', 50000)
    const before = (await accountBalances(t.company.id, new Date('2026-03-31T23:59:59Z'))).find((b) => b.id === bankId)
    const after = (await accountBalances(t.company.id, new Date('2026-04-01T12:00:00Z'))).find((b) => b.id === bankId)
    expect([before?.balance, after?.balance]).toEqual([0, 50000])
  })

  test('validation: duplicate account name 409, bad IFSC 400, type cannot change', async () => {
    const t = await seedTenant()
    const bankId = await addBank(t)
    expect((await post(createAccount, '/api/accounts', t.user, { companyId: t.company.id, type: 'BANK', name: 'Test Bank' })).status).toBe(409)
    expect((await post(createAccount, '/api/accounts', t.user, { companyId: t.company.id, type: 'BANK', name: 'B2', ifsc: 'BAD' })).status).toBe(400)
    const r = await call(patchAccount(apiRequest(`/api/accounts/${bankId}`, { method: 'PATCH', user: t.user, body: { companyId: t.company.id, type: 'CASH' } }), ctx({ id: bankId })))
    expect(r.status).toBe(400)
  })

  test('an entry dated before the opening date is refused and the balance is unchanged (Phase 1)', async () => {
    const t = await seedTenant()
    const bankId = await addBank(t, 'Test Bank', 50000) // opening date 2026-04-01
    const r = await post(createTxn, '/api/account-txns', t.user, { companyId: t.company.id, type: 'ADJUST_IN', toAccountId: bankId, amount: 700, category: 'OTHER', date: '2026-03-15' })
    expect(r.status).toBe(400)
    expect(r.json.error?.message).toContain('before the opening date')
    expect((await balances(t))['Test Bank']).toBe(50000)
  })

  test('editing the opening balance records old and new values in the audit log (Phase 1)', async () => {
    const t = await seedTenant()
    const bankId = await addBank(t, 'Test Bank', 50000)
    await post(createTxn, '/api/account-txns', t.user, { companyId: t.company.id, type: 'ADJUST_IN', toAccountId: bankId, amount: 1000, category: 'OTHER', date: '2026-05-01' })
    await call(patchAccount(apiRequest(`/api/accounts/${bankId}`, { method: 'PATCH', user: t.user, body: { companyId: t.company.id, openingBalance: 20000, userName: t.user.name } }), ctx({ id: bankId })))
    expect((await balances(t))['Test Bank']).toBe(21000)
    const log = await db.auditLog.findFirstOrThrow({ where: { companyId: t.company.id, entity: 'MoneyAccount', action: 'UPDATE' } })
    expect(log.details).toContain('opening balance ₹50000.00 → ₹20000.00')
    expect(log.userName).toBe(t.user.name)
  })
})

describe('customer Payment In', () => {
  test('cash and bank receipts raise the chosen account; voiding reverses both the balance and the invoice', async () => {
    const t = await seedTenant()
    const bankId = await addBank(t, 'Test Bank', 0)
    const { customer, item } = await parties(t)
    const inv = await salesInvoice(t, customer.id, item.id)
    expect(inv.grandTotal).toBe(1000)

    const cashR = await receipt(t, customer.id, inv.id, 500, { mode: 'CASH' })
    const upiR = await receipt(t, customer.id, inv.id, 300, { mode: 'UPI', accountId: bankId })
    expect([cashR.status, upiR.status]).toEqual([200, 200])
    expect(await balances(t)).toEqual({ 'Cash in Hand': 500, 'Test Bank': 300 })
    expect(await db.salesInvoice.findUniqueOrThrow({ where: { id: inv.id }, select: { paidAmount: true, status: true } })).toEqual({ paidAmount: 800, status: 'PARTIALLY_PAID' })

    // more than the outstanding is refused, nothing moves
    expect((await receipt(t, customer.id, inv.id, 201, { mode: 'CASH' })).status).toBe(400)
    expect(await balances(t)).toEqual({ 'Cash in Hand': 500, 'Test Bank': 300 })

    const v = await call(voidPayment(apiRequest(`/api/payments/${cashR.json.data.id}`, { method: 'DELETE', user: t.user, body: { companyId: t.company.id } }), ctx({ id: cashR.json.data.id })))
    expect(v.status).toBe(200)
    expect(await balances(t)).toEqual({ 'Cash in Hand': 0, 'Test Bank': 300 })
    expect(await db.salesInvoice.findUniqueOrThrow({ where: { id: inv.id }, select: { paidAmount: true, status: true } })).toEqual({ paidAmount: 300, status: 'PARTIALLY_PAID' })
  })

  test('"Received now" on a sales invoice is a receipt into the chosen account', async () => {
    const t = await seedTenant()
    const bankId = await addBank(t, 'Test Bank', 0)
    const { customer, item } = await parties(t)
    await salesInvoice(t, customer.id, item.id, { receivedAmount: 200, receivedMode: 'CASH' })
    await salesInvoice(t, customer.id, item.id, { receivedAmount: 1000, receivedMode: 'UPI', receivedAccountId: bankId })
    expect(await balances(t)).toEqual({ 'Cash in Hand': 200, 'Test Bank': 1000 })
  })

  test('an inactive account chosen at billing is refused; nothing is saved (Phase 1)', async () => {
    const t = await seedTenant()
    await addBank(t, 'Main Bank', 0, { isDefault: true })
    const oldId = await addBank(t, 'Old Bank', 0)
    await call(patchAccount(apiRequest(`/api/accounts/${oldId}`, { method: 'PATCH', user: t.user, body: { companyId: t.company.id, active: false } }), ctx({ id: oldId })))
    const { customer, item } = await parties(t)
    const r = await post(createSalesInvoice, '/api/sales-invoices', t.user, {
      companyId: t.company.id, customerId: customer.id, date: '2026-05-10', lines: [{ itemId: item.id, qty: 10, rate: 100, discountPct: 0, gstRate: 0 }],
      receivedAmount: 400, receivedMode: 'UPI', receivedAccountId: oldId,
    })
    expect(r.status).toBe(400)
    expect(r.json.error?.message).toContain('inactive')
    expect(await db.salesInvoice.count({ where: { companyId: t.company.id } })).toBe(0)
    expect(await db.payment.count({ where: { companyId: t.company.id } })).toBe(0)
    expect(await balances(t)).toEqual({ 'Main Bank': 0, 'Old Bank': 0 })
  })

  test('a credit-note mode cannot be used for a manual payment', async () => {
    const t = await seedTenant()
    const { customer, item } = await parties(t)
    const inv = await salesInvoice(t, customer.id, item.id)
    expect((await receipt(t, customer.id, inv.id, 100, { mode: 'CREDIT_NOTE' })).status).toBe(400)
  })
})

describe('supplier Payment Out', () => {
  test('"Paid now" on a bill and later payments lower the chosen account', async () => {
    const t = await seedTenant()
    const bankId = await addBank(t, 'Test Bank', 50000)
    const cashId = await cashAccountId(t)
    await post(createTxn, '/api/account-txns', t.user, { companyId: t.company.id, type: 'ADJUST_IN', toAccountId: cashId, amount: 5000, category: 'CAPITAL', date: '2026-05-01' })
    const { supplier, item } = await parties(t)
    const bill = await purchaseInvoice(t, supplier.id, item.id, { paidNow: 400, paymentMode: 'CASH' })
    expect(await balances(t)).toEqual({ 'Cash in Hand': 4600, 'Test Bank': 50000 })

    const r = await paymentOut(t, supplier.id, bill.id, 600, { mode: 'NEFT', accountId: bankId })
    expect(r.status).toBe(200)
    expect(await balances(t)).toEqual({ 'Cash in Hand': 4600, 'Test Bank': 49400 })
    expect(await db.purchaseInvoice.findUniqueOrThrow({ where: { id: bill.id }, select: { paidAmount: true, status: true } })).toEqual({ paidAmount: 1000, status: 'PAID' })
  })

  test('a payment to another supplier\'s bill is refused', async () => {
    const t = await seedTenant()
    const { supplier, item } = await parties(t)
    const other = await db.supplier.create({ data: { companyId: t.company.id, code: 'S-2', name: 'Other Supplier' } })
    const bill = await purchaseInvoice(t, supplier.id, item.id)
    expect((await paymentOut(t, other.id, bill.id, 100, { mode: 'CASH' })).status).toBe(400)
  })
})

describe('expenses', () => {
  test('posted expenses lower the paying account; cancelled ones do not', async () => {
    const t = await seedTenant()
    const bankId = await addBank(t, 'Test Bank', 10000)
    const exp = (body: Record<string, unknown>) => post(createExpense, '/api/expenses', t.user, { companyId: t.company.id, date: '2026-05-12', description: 'Test expense', category: 'UTILITIES', ...body })
    expect((await exp({ amount: 250, paymentMode: 'CASH', allowNegativeCash: true })).status).toBe(200) // Tenant Admin override (Phase 5)
    expect((await exp({ amount: 1200, paymentMode: 'NEFT', accountId: bankId })).status).toBe(200)
    expect((await exp({ amount: 999, paymentMode: 'CASH', status: 'CANCELLED' })).status).toBe(200)
    expect(await balances(t)).toEqual({ 'Cash in Hand': -250, 'Test Bank': 8800 })
  })

  test('a DRAFT expense does not change the balance (Phase 1)', async () => {
    const t = await seedTenant()
    await post(createExpense, '/api/expenses', t.user, { companyId: t.company.id, date: '2026-05-12', description: 'Draft', amount: 300, paymentMode: 'CASH', status: 'DRAFT' })
    expect((await balances(t))['Cash in Hand']).toBe(0)
  })
})

describe('cash adjustment (Add / Reduce money)', () => {
  test('ADJUST_IN raises, ADJUST_OUT lowers, deleting the entry restores the balance', async () => {
    const t = await seedTenant()
    const cashId = await cashAccountId(t)
    const add = await post(createTxn, '/api/account-txns', t.user, { companyId: t.company.id, type: 'ADJUST_IN', toAccountId: cashId, amount: 1000, category: 'CAPITAL', date: '2026-05-01' })
    const out = await post(createTxn, '/api/account-txns', t.user, { companyId: t.company.id, type: 'ADJUST_OUT', fromAccountId: cashId, amount: 300, category: 'DRAWINGS', date: '2026-05-02' })
    expect([add.status, out.status]).toEqual([200, 200])
    expect((await balances(t))['Cash in Hand']).toBe(700)

    const d = await call(deleteTxn(apiRequest(`/api/account-txns/${out.json.data.id}`, { method: 'DELETE', user: t.user, body: { companyId: t.company.id } }), ctx({ id: out.json.data.id })))
    expect(d.status).toBe(200)
    expect((await balances(t))['Cash in Hand']).toBe(1000)
  })

  test('validation: zero amount, wrong category and unknown type are refused', async () => {
    const t = await seedTenant()
    const cashId = await cashAccountId(t)
    const base = { companyId: t.company.id, toAccountId: cashId, date: '2026-05-01' }
    expect((await post(createTxn, '/api/account-txns', t.user, { ...base, type: 'ADJUST_IN', amount: 0 })).status).toBe(400)
    expect((await post(createTxn, '/api/account-txns', t.user, { ...base, type: 'ADJUST_IN', amount: 10, category: 'DRAWINGS' })).status).toBe(400)
    expect((await post(createTxn, '/api/account-txns', t.user, { ...base, type: 'LOAN_IN', amount: 10 })).status).toBe(400)
    expect((await balances(t))['Cash in Hand']).toBe(0)
  })

  test('Phase 5: reducing cash below zero is refused; a Tenant Admin may save it anyway', async () => {
    const t = await seedTenant()
    const cashId = await cashAccountId(t)
    const body = { companyId: t.company.id, type: 'ADJUST_OUT', fromAccountId: cashId, amount: 500, category: 'OTHER', date: '2026-05-01' }
    const r = await post(createTxn, '/api/account-txns', t.user, body)
    expect([r.status, r.json.error?.code]).toEqual([409, 'NEGATIVE_CASH'])
    expect((await balances(t))['Cash in Hand']).toBe(0)
    expect((await post(createTxn, '/api/account-txns', t.user, { ...body, allowNegativeCash: true })).status).toBe(200)
    expect((await balances(t))['Cash in Hand']).toBe(-500)
  })
})

describe('bank transfer (contra)', () => {
  test('moves money between own accounts; the total is unchanged', async () => {
    const t = await seedTenant()
    const bankId = await addBank(t, 'Test Bank', 10000)
    const cashId = await cashAccountId(t)
    await post(createTxn, '/api/account-txns', t.user, { companyId: t.company.id, type: 'ADJUST_IN', toAccountId: cashId, amount: 5000, category: 'CAPITAL', date: '2026-05-01' })
    const r = await post(createTxn, '/api/account-txns', t.user, { companyId: t.company.id, type: 'CONTRA', fromAccountId: cashId, toAccountId: bankId, amount: 2000, date: '2026-05-02' })
    expect(r.status).toBe(200)
    expect(await balances(t)).toEqual({ 'Cash in Hand': 3000, 'Test Bank': 12000 })
  })

  test('same account on both sides and an inactive account are refused', async () => {
    const t = await seedTenant()
    const bankId = await addBank(t, 'Test Bank', 10000)
    const oldId = await addBank(t, 'Old Bank', 0)
    await call(patchAccount(apiRequest(`/api/accounts/${oldId}`, { method: 'PATCH', user: t.user, body: { companyId: t.company.id, active: false } }), ctx({ id: oldId })))
    expect((await post(createTxn, '/api/account-txns', t.user, { companyId: t.company.id, type: 'CONTRA', fromAccountId: bankId, toAccountId: bankId, amount: 10 })).status).toBe(400)
    expect((await post(createTxn, '/api/account-txns', t.user, { companyId: t.company.id, type: 'CONTRA', fromAccountId: bankId, toAccountId: oldId, amount: 10 })).status).toBe(400)
    expect(await balances(t)).toEqual({ 'Test Bank': 10000, 'Old Bank': 0 })
  })
})

describe('post-dated cheques', () => {
  test('a post-dated cheque settles the invoice at once but reaches the bank only when cleared', async () => {
    const t = await seedTenant()
    const bankId = await addBank(t, 'Test Bank', 0)
    const { customer, item } = await parties(t)
    const inv = await salesInvoice(t, customer.id, item.id)
    const r = await receipt(t, customer.id, inv.id, 600, { mode: 'CHEQUE', accountId: bankId, chequeNo: '000111', chequeDate: futureDay(30) })
    expect([r.status, r.json.data.chequeStatus]).toEqual([200, 'PENDING'])
    expect((await balances(t))['Test Bank']).toBe(0)
    expect((await db.salesInvoice.findUniqueOrThrow({ where: { id: inv.id } })).paidAmount).toBe(600)

    const id = r.json.data.id
    const act = (action: string) => call(chequeAction(apiRequest(`/api/payments/${id}`, { method: 'PATCH', user: t.user, body: { companyId: t.company.id, action } }), ctx({ id })))
    expect((await act('deposit')).status).toBe(200)
    expect((await balances(t))['Test Bank']).toBe(0)
    setSystemTime(new Date(Date.now() + 31 * 86400000)) // the cheque date has arrived
    expect((await act('clear')).status).toBe(200)
    expect((await balances(t))['Test Bank']).toBe(600)
    expect((await act('clear')).status).toBe(400) // already cleared
  })

  test('a bounced post-dated cheque never reaches the bank and reopens the invoice', async () => {
    const t = await seedTenant()
    const bankId = await addBank(t, 'Test Bank', 0)
    const { customer, item } = await parties(t)
    const inv = await salesInvoice(t, customer.id, item.id)
    const r = await receipt(t, customer.id, inv.id, 1000, { mode: 'CHEQUE', accountId: bankId, chequeNo: '000222', chequeDate: futureDay(10) })
    expect((await db.salesInvoice.findUniqueOrThrow({ where: { id: inv.id } })).status).toBe('PAID')
    const id = r.json.data.id
    const b = await call(chequeAction(apiRequest(`/api/payments/${id}`, { method: 'PATCH', user: t.user, body: { companyId: t.company.id, action: 'bounce' } }), ctx({ id })))
    expect(b.status).toBe(200)
    expect((await balances(t))['Test Bank']).toBe(0)
    expect(await db.salesInvoice.findUniqueOrThrow({ where: { id: inv.id }, select: { paidAmount: true, status: true } })).toEqual({ paidAmount: 0, status: 'UNPAID' })
  })

  test('a cheque dated today counts at once; bouncing it later takes it back out', async () => {
    const t = await seedTenant()
    const bankId = await addBank(t, 'Test Bank', 0)
    const { customer, item } = await parties(t)
    const inv = await salesInvoice(t, customer.id, item.id)
    const r = await receipt(t, customer.id, inv.id, 400, { mode: 'CHEQUE', accountId: bankId, chequeNo: '000333' })
    expect(r.json.data.chequeStatus).toBeNull()
    expect((await balances(t))['Test Bank']).toBe(400)
    const id = r.json.data.id
    await call(chequeAction(apiRequest(`/api/payments/${id}`, { method: 'PATCH', user: t.user, body: { companyId: t.company.id, action: 'bounce' } }), ctx({ id })))
    expect((await balances(t))['Test Bank']).toBe(0)
  })
})

describe('loans and EMIs', () => {
  test('loan credits principal minus fee; an EMI debits principal plus interest; loan entries cannot be deleted as adjustments', async () => {
    const t = await seedTenant()
    const bankId = await addBank(t, 'Test Bank', 0)
    const l = await post(createLoan, '/api/loans', t.user, { companyId: t.company.id, name: 'Machine Loan', principal: 100000, processingFee: 1000, interestRate: 10, startDate: '2026-05-01', receivedAccountId: bankId })
    expect(l.status).toBe(200)
    expect((await balances(t))['Test Bank']).toBe(99000)

    const loanId = l.json.data.id
    const e = await call(payEmi(apiRequest(`/api/loans/${loanId}/emi`, { user: t.user, body: { companyId: t.company.id, date: '2026-06-01', principal: 5000, interest: 800, fromAccountId: bankId } }), ctx({ id: loanId })))
    expect(e.status).toBe(200)
    expect((await balances(t))['Test Bank']).toBe(93200)

    const loanIn = await db.accountTxn.findFirstOrThrow({ where: { companyId: t.company.id, loanId, type: 'LOAN_IN' } })
    const d = await call(deleteTxn(apiRequest(`/api/account-txns/${loanIn.id}`, { method: 'DELETE', user: t.user, body: { companyId: t.company.id } }), ctx({ id: loanIn.id })))
    expect(d.status).toBe(400)
    expect((await balances(t))['Test Bank']).toBe(93200)
  })

  test('an EMI with more principal than outstanding is refused', async () => {
    const t = await seedTenant()
    const bankId = await addBank(t, 'Test Bank', 0)
    const l = await post(createLoan, '/api/loans', t.user, { companyId: t.company.id, name: 'Small Loan', principal: 1000, startDate: '2026-05-01', receivedAccountId: bankId })
    const loanId = l.json.data.id
    const e = await call(payEmi(apiRequest(`/api/loans/${loanId}/emi`, { user: t.user, body: { companyId: t.company.id, principal: 1500, interest: 0, fromAccountId: bankId } }), ctx({ id: loanId })))
    expect(e.status).toBe(400)
    expect((await balances(t))['Test Bank']).toBe(1000)
  })
})

describe('credit notes and debit notes', () => {
  test('a sales return settles the invoice with a credit note and moves no money', async () => {
    const t = await seedTenant()
    const { customer, item } = await parties(t)
    const inv = await salesInvoice(t, customer.id, item.id, { receivedAmount: 300, receivedMode: 'CASH' })
    const invItem = await db.salesInvoiceItem.findFirstOrThrow({ where: { invoiceId: inv.id } })
    const before = await balances(t)
    const r = await post(createSalesReturn, '/api/sales-returns', t.user, { companyId: t.company.id, invoiceId: inv.id, date: '2026-05-15', lines: [{ invoiceItemId: invItem.id, qty: 2 }] })
    expect([r.status, r.json.error?.message]).toEqual([200, undefined])
    expect(r.json.data.creditApplied).toBe(200)
    expect(await balances(t)).toEqual(before)
    expect((await db.salesInvoice.findUniqueOrThrow({ where: { id: inv.id } })).paidAmount).toBe(500)
    expect(await db.payment.count({ where: { companyId: t.company.id, mode: 'CREDIT_NOTE' } })).toBe(1)
  })

  test('CURRENT BEHAVIOUR (Phase 4): a refund due on a fully paid invoice is not recorded anywhere as money', async () => {
    const t = await seedTenant()
    const { customer, item } = await parties(t)
    const inv = await salesInvoice(t, customer.id, item.id, { receivedAmount: 1000, receivedMode: 'CASH' })
    const invItem = await db.salesInvoiceItem.findFirstOrThrow({ where: { invoiceId: inv.id } })
    const r = await post(createSalesReturn, '/api/sales-returns', t.user, { companyId: t.company.id, invoiceId: inv.id, date: '2026-05-15', lines: [{ invoiceItemId: invItem.id, qty: 3 }] })
    expect([r.json.data.creditApplied, r.json.data.refundDue]).toEqual([0, 300])
    expect((await balances(t))['Cash in Hand']).toBe(1000)
    expect(await db.payment.count({ where: { companyId: t.company.id, customerId: customer.id, type: 'PAYMENT' } })).toBe(0)
  })

  test('a purchase return settles the bill with a debit note and moves no money', async () => {
    const t = await seedTenant()
    const { supplier, item } = await parties(t)
    const bill = await purchaseInvoice(t, supplier.id, item.id, { receiveStock: true, warehouseId: t.warehouse.id })
    const before = await balances(t)
    const r = await post(createPurchaseReturn, '/api/purchase-returns', t.user, { companyId: t.company.id, invoiceId: bill.id, date: '2026-05-15', warehouseId: t.warehouse.id, lines: [{ invoiceItemId: bill.items[0].id, qty: 4 }] })
    expect([r.status, r.json.error?.message]).toEqual([200, undefined])
    expect(await balances(t)).toEqual(before)
    expect((await db.purchaseInvoice.findUniqueOrThrow({ where: { id: bill.id } })).paidAmount).toBe(400)
    expect(await db.payment.count({ where: { companyId: t.company.id, mode: 'DEBIT_NOTE' } })).toBe(1)
  })
})

describe('legacy rows without an account', () => {
  test('CURRENT BEHAVIOUR (Phase 1b data backfill): a payment with no accountId follows whichever bank is default now', async () => {
    const t = await seedTenant()
    const oldBank = await addBank(t, 'First Bank', 0)
    const { customer, item } = await parties(t)
    const inv = await salesInvoice(t, customer.id, item.id)
    // a row saved before Cash & Bank existed (synthetic, test database only)
    await db.payment.create({ data: { companyId: t.company.id, number: 'LEGACY-1', type: 'RECEIPT', partyType: 'CUSTOMER', customerId: customer.id, invoiceType: 'SALES', invoiceId: inv.id, amount: 750, mode: 'UPI', date: new Date('2026-05-11T00:00:00Z') } })
    expect((await balances(t))['First Bank']).toBe(750)

    const newBank = await addBank(t, 'New Bank', 0, { isDefault: true })
    const b = await balances(t)
    expect([b['First Bank'], b['New Bank']]).toEqual([0, 750])
    expect(oldBank).not.toBe(newBank)
  })
})

describe('tenant isolation and permissions', () => {
  test('another company cannot see, use or change these accounts', async () => {
    const a = await seedTenant()
    const b = await seedTenant()
    const bankA = await addBank(a, 'A Bank', 1000)

    expect(Object.keys(await balances(b))).toEqual([])
    const get = await call(getAccount(apiRequest(`/api/accounts/${bankA}?companyId=${b.company.id}`, { user: b.user }), ctx({ id: bankA })))
    expect(get.status).toBe(404)
    const st = await call(statement(apiRequest(`/api/accounts/${bankA}/statement?companyId=${b.company.id}`, { user: b.user }), ctx({ id: bankA })))
    expect(st.status).toBe(404)
    const patch = await call(patchAccount(apiRequest(`/api/accounts/${bankA}`, { method: 'PATCH', user: b.user, body: { companyId: b.company.id, openingBalance: 0 } }), ctx({ id: bankA })))
    expect(patch.status).toBe(404)
    expect((await post(createTxn, '/api/account-txns', b.user, { companyId: b.company.id, type: 'ADJUST_IN', toAccountId: bankA, amount: 10 })).status).toBe(404)
    // B's user cannot act inside company A at all
    expect((await post(createTxn, '/api/account-txns', b.user, { companyId: a.company.id, type: 'ADJUST_IN', toAccountId: bankA, amount: 10 })).status).toBe(403)

    const { customer, item } = await parties(b)
    const inv = await salesInvoice(b, customer.id, item.id)
    expect((await receipt(b, customer.id, inv.id, 100, { mode: 'UPI', accountId: bankA })).status).toBe(404)
    expect((await balances(a))['A Bank']).toBe(1000)
  })

  test('a viewer can neither write nor read Cash & Bank balances (Phase 5)', async () => {
    const t = await seedTenant()
    await addBank(t, 'Test Bank', 1000)
    const viewer = await seedUser(t.company.id, 'VIEWER')
    const w = await post(createAccount, '/api/accounts', viewer, { companyId: t.company.id, type: 'BANK', name: 'X' })
    expect(w.status).toBe(403)
    const r = await call(listAccounts(apiRequest(`/api/accounts?companyId=${t.company.id}`, { user: viewer })))
    expect([r.status, r.json.data]).toEqual([403, undefined])
  })
})
