import { afterEach, beforeEach, describe, expect, setSystemTime, test } from 'bun:test'
import { db } from '@/lib/db'
import { nextDocNumber } from '@/lib/erp-helpers'
import { POST as createExpense } from '@/app/api/expenses/route'
import { GET as listAccounts, POST as createAccount } from '@/app/api/accounts/route'
import { GET as cbHistory } from '@/app/api/cash-bank/transactions/route'
import { GET as listPayments, POST as createPayment } from '@/app/api/payments/route'
import { DELETE as voidPayment, PATCH as patchPayment } from '@/app/api/payments/[id]/route'
import { GET as listExpenses } from '@/app/api/expenses/route'
import { GET as listSalesReturns, POST as createSalesReturn } from '@/app/api/sales-returns/route'
import { GET as listPurchaseReturns, POST as createPurchaseReturn } from '@/app/api/purchase-returns/route'
import { GET as customerStatement } from '@/app/api/customers/[id]/statement/route'
import { GET as supplierStatement } from '@/app/api/suppliers/[id]/statement/route'
import { GET as balanceSheet } from '@/app/api/reports/balance-sheet/route'
import { GET as profitLoss } from '@/app/api/reports/profit-loss/route'
import { GET as cashFlowReport } from '@/app/api/reports/cash-flow/route'
import { GET as daybook } from '@/app/api/reports/daybook/route'
import { GET as stockValuation } from '@/app/api/reports/stock-valuation/route'
import { GET as gstr3b } from '@/app/api/reports/gstr3b/route'
import { GET as dashboard } from '@/app/api/dashboard/route'
import { GET as listSalesInvoices } from '@/app/api/sales-invoices/route'
import { GET as getSalesInvoice } from '@/app/api/sales-invoices/[id]/route'
import { GET as listPurchaseInvoices } from '@/app/api/purchase-invoices/route'
import { GET as getPurchaseInvoice } from '@/app/api/purchase-invoices/[id]/route'
import { PATCH as patchPurchaseReturn } from '@/app/api/purchase-returns/[id]/route'
import { POST as createSalesInvoice } from '@/app/api/sales-invoices/route'
import { POST as createPurchaseInvoice } from '@/app/api/purchase-invoices/route'
import { DELETE as deleteExpense, PATCH as patchExpense } from '@/app/api/expenses/[id]/route'
import { POST as createTxn } from '@/app/api/account-txns/route'
import { DELETE as deleteTxn } from '@/app/api/account-txns/[id]/route'
import { POST as createLoan } from '@/app/api/loans/route'
import { DELETE as deleteLoan } from '@/app/api/loans/[id]/route'
import { POST as payEmi } from '@/app/api/loans/[id]/emi/route'
import { PATCH as patchAccount } from '@/app/api/accounts/[id]/route'
import { accountBalances } from '@/lib/accounts'
import { claimIdempotency, purgeIdempotencyKeys } from '@/lib/idempotency'
import { partyCreditsAsOf } from '@/lib/party-credits'
import { canSeeFinancialReports } from '@/lib/erp-constants'
import { apiRequest, call, ctx, type ApiResult, type TestUser } from './helpers/api'
import { resetDb } from './helpers/db'
import { seedTenant, seedUser } from './helpers/seed'

/**
 * Cash & Bank Phase 5: CB-R1 numbering, read and payment-kind permissions, negative-cash guard, duplicate warnings,
 * idempotency, supplier statement. Synthetic data on the guarded test database; fixed system time.
 */

const NOW = new Date('2026-06-01T06:00:00Z')

beforeEach(async () => { setSystemTime(NOW); await resetDb() })
afterEach(() => { setSystemTime() })

describe('CB-R1: document numbering inside the transaction', () => {
  test('a burst of first documents larger than the connection pool all succeed with distinct consecutive numbers', async () => {
    const t = await seedTenant()
    await call(createAccount(apiRequest('/api/accounts', { user: t.user, body: { companyId: t.company.id, type: 'CASH', name: 'Cash in Hand', isDefault: true, openingBalance: 1000, openingDate: '2026-04-01' } })))
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) =>
      call(createExpense(apiRequest('/api/expenses', { user: t.user, body: { companyId: t.company.id, date: '2026-05-12', description: `E${i}`, category: 'OTHER', amount: 10 + i, paymentMode: 'CASH' } })))))
    expect(results.map((r) => r.status)).toEqual(Array(10).fill(200))
    const numbers = results.map((r) => r.json.data.number as string).sort()
    expect(numbers).toEqual(Array.from({ length: 10 }, (_, i) => `EXP-2627-${String(i + 1).padStart(6, '0')}`))
  })

  test('two financial years at once, and a custom company prefix, each get their own sequence', async () => {
    const t = await seedTenant()
    await db.company.update({ where: { id: t.company.id }, data: { docPrefixes: JSON.stringify({ EXP: 'XP' }) } })
    const fy = (date: string) => db.$transaction((tx) => nextDocNumber(tx, t.company.id, 'EXP', new Date(date)))
    const got = await Promise.all([fy('2026-05-01'), fy('2027-05-01'), fy('2026-06-01'), fy('2027-06-01')])
    expect(got.sort()).toEqual(['XP-2627-000001', 'XP-2627-000002', 'XP-2728-000001', 'XP-2728-000002'])
  })

  test('a rolled-back transaction gives its number back (no gap) and leaves no counter row behind', async () => {
    const t = await seedTenant()
    await expect(db.$transaction(async (tx) => { await nextDocNumber(tx, t.company.id, 'RCPT', new Date('2026-05-01')); throw new Error('boom') })).rejects.toThrow('boom')
    expect(await db.numberSeq.count({ where: { companyId: t.company.id, docType: 'RCPT' } })).toBe(0)
    const n = await db.$transaction((tx) => nextDocNumber(tx, t.company.id, 'RCPT', new Date('2026-05-01')))
    expect(n).toBe('RCPT-2627-000001')
  })
})

// ============================== Permissions ==============================

/** Company with cash + bank, a customer / supplier / item, an open invoice and bill, and a sales / purchase return. */
async function books() {
  const t = await seedTenant()
  const c = t.company.id
  const as = (user: TestUser) => ({
    get: (handler: (r: Request, x?: never) => Promise<Response>, path: string, id?: string) =>
      call((handler as (r: Request, x: unknown) => Promise<Response>)(apiRequest(`${path}${path.includes('?') ? '&' : '?'}companyId=${c}`, { user }), id ? ctx({ id }) : undefined)),
    send: (handler: (r: Request, x?: never) => Promise<Response>, path: string, body: Record<string, unknown>, method?: string, id?: string) =>
      call((handler as (r: Request, x: unknown) => Promise<Response>)(apiRequest(path, { user, method, body: { companyId: c, ...body } }), id ? ctx({ id }) : undefined)),
  })
  const admin = as(t.user)
  const ok = async (p: Promise<{ status: number; json: { data?: any; error?: { message: string } } }>) => { const r = await p; expect([r.status, r.json.error?.message]).toEqual([200, undefined]); return r.json.data }
  await ok(admin.send(createAccount, '/api/accounts', { type: 'CASH', name: 'Cash in Hand', isDefault: true, openingBalance: 100000, openingDate: '2026-04-01' }))
  await ok(admin.send(createAccount, '/api/accounts', { type: 'BANK', name: 'Main Bank', isDefault: true, openingBalance: 100000, openingDate: '2026-04-01' }))
  const [customer, supplier, item] = await Promise.all([
    db.customer.create({ data: { companyId: c, code: 'C-1', name: 'Asha Traders' } }),
    db.supplier.create({ data: { companyId: c, code: 'S-1', name: 'Bharat Steels' } }),
    db.item.create({ data: { companyId: c, code: 'IT-1', name: 'Test Part', uom: 'NOS' } }),
  ])
  const inv = await ok(admin.send(createSalesInvoice, '/api/sales-invoices', { customerId: customer.id, date: '2026-05-05', lines: [{ itemId: item.id, qty: 10, rate: 100, discountPct: 0, gstRate: 0 }] }))
  const paidInv = await ok(admin.send(createSalesInvoice, '/api/sales-invoices', { customerId: customer.id, date: '2026-05-05', lines: [{ itemId: item.id, qty: 5, rate: 100, discountPct: 0, gstRate: 0 }], receivedAmount: 500, receivedMode: 'CASH' }))
  const bill = await ok(admin.send(createPurchaseInvoice, '/api/purchase-invoices', { supplierId: supplier.id, date: '2026-05-05', lines: [{ itemId: item.id, qty: 10, rate: 100, gstRate: 0 }], receiveStock: true, warehouseId: t.warehouse.id, paidNow: 1000, paymentMode: 'CASH' }))
  const openBill = await ok(admin.send(createPurchaseInvoice, '/api/purchase-invoices', { supplierId: supplier.id, date: '2026-05-05', lines: [{ itemId: item.id, qty: 2, rate: 100, gstRate: 0 }] }))
  const sret = await ok(admin.send(createSalesReturn, '/api/sales-returns', { invoiceId: paidInv.id, date: '2026-05-10', lines: [{ invoiceItemId: (await db.salesInvoiceItem.findFirstOrThrow({ where: { invoiceId: paidInv.id } })).id, qty: 2 }] }))
  const pret = await ok(admin.send(createPurchaseReturn, '/api/purchase-returns', { invoiceId: bill.id, date: '2026-05-10', warehouseId: t.warehouse.id, lines: [{ invoiceItemId: bill.items[0].id, qty: 2 }] }))
  return { t, c, as, admin, ok, customer, supplier, item, inv, bill, openBill, sret, pret }
}
type Books = Awaited<ReturnType<typeof books>>

const READS: Record<string, (b: Books, u: ReturnType<Books['as']>) => ReturnType<ReturnType<Books['as']>['get']>> = {
  cashBank: (b, u) => u.get(listAccounts as never, '/api/accounts'),
  cbHistory: (b, u) => u.get(cbHistory as never, '/api/cash-bank/transactions'),
  payments: (b, u) => u.get(listPayments as never, '/api/payments'),
  expenses: (b, u) => u.get(listExpenses as never, '/api/expenses'),
  salesReturns: (b, u) => u.get(listSalesReturns as never, '/api/sales-returns'),
  purchaseReturns: (b, u) => u.get(listPurchaseReturns as never, '/api/purchase-returns'),
  customerStatement: (b, u) => u.get(customerStatement as never, `/api/customers/${b.customer.id}/statement`, b.customer.id),
  supplierStatement: (b, u) => u.get(supplierStatement as never, `/api/suppliers/${b.supplier.id}/statement`, b.supplier.id),
  balanceSheet: (b, u) => u.get(balanceSheet as never, '/api/reports/balance-sheet'),
  profitLoss: (b, u) => u.get(profitLoss as never, '/api/reports/profit-loss'),
  cashFlow: (b, u) => u.get(cashFlowReport as never, '/api/reports/cash-flow'),
  daybook: (b, u) => u.get(daybook as never, '/api/reports/daybook'),
  stockValuation: (b, u) => u.get(stockValuation as never, '/api/reports/stock-valuation'),
  gst: (b, u) => u.get(gstr3b as never, '/api/reports/gstr3b'),
  salesInvoices: (b, u) => u.get(listSalesInvoices as never, '/api/sales-invoices'),
  salesInvoice: (b, u) => u.get(getSalesInvoice as never, `/api/sales-invoices/${b.inv.id}`, b.inv.id),
  purchaseInvoices: (b, u) => u.get(listPurchaseInvoices as never, '/api/purchase-invoices'),
  purchaseInvoice: (b, u) => u.get(getPurchaseInvoice as never, `/api/purchase-invoices/${b.bill.id}`, b.bill.id),
}
const ALL = Object.keys(READS)
const FIN = ['balanceSheet', 'profitLoss', 'cashFlow', 'daybook']
// Expected access per role — hard-coded on purpose so a change to ROLE_MODULE_KEYS shows up here
const ALLOWED: Record<string, string[]> = {
  VIEWER: [],
  OPERATOR: [],
  STORE_OPERATOR: [],
  PRODUCTION_MANAGER: ['stockValuation'],
  PLANT_MANAGER: ['stockValuation'],
  QUALITY_MANAGER: ['stockValuation'],
  // cashBank for these two = the account picker only (no balances — checked separately)
  SALES_MANAGER: ['cashBank', 'payments', 'salesReturns', 'customerStatement', ...FIN, 'stockValuation', 'salesInvoices', 'salesInvoice'],
  PURCHASE_MANAGER: ['cashBank', 'payments', 'purchaseReturns', 'supplierStatement', ...FIN, 'stockValuation', 'purchaseInvoices', 'purchaseInvoice'],
  ACCOUNTANT: ALL,
  ACCOUNTS_MANAGER: ALL,
  MANAGEMENT: ALL,
  TENANT_ADMIN: ALL,
}

describe('read permissions (existing module permissions, nothing granted)', () => {
  test('financial reads per role: allowed → not 403, denied → 403 with no data', async () => {
    const b = await books()
    for (const [role, allowed] of Object.entries(ALLOWED)) {
      const u = b.as(await seedUser(b.c, role))
      for (const key of ALL) {
        const r = await READS[key](b, u)
        if (allowed.includes(key)) expect([role, key, r.status === 403 ? 403 : 'ok']).toEqual([role, key, 'ok'])
        else expect([role, key, r.status, r.json.data]).toEqual([role, key, 403, undefined])
      }
    }
  }, 60000)

  test('account list: roles without Cash & Bank get the picker only — no balances or opening figures', async () => {
    const b = await books()
    for (const role of ['SALES_MANAGER', 'PURCHASE_MANAGER']) {
      const r = await b.as(await seedUser(b.c, role)).get(listAccounts as never, '/api/accounts')
      expect([role, r.status]).toEqual([role, 200])
      for (const a of r.json.data.items) expect(Object.keys(a).sort()).toEqual(['active', 'createdAt', 'id', 'isDefault', 'name', 'type'])
    }
    const acc = await b.as(await seedUser(b.c, 'ACCOUNTANT')).get(listAccounts as never, '/api/accounts')
    expect(acc.json.data.items.map((a: { name: string; balance: number }) => [a.name, typeof a.balance]).sort()).toEqual([['Cash in Hand', 'number'], ['Main Bank', 'number']])
  })

  test('the shared financial-report rule matches option A (reports + a money module)', () => {
    expect(['PRODUCTION_MANAGER', 'PLANT_MANAGER', 'QUALITY_MANAGER', 'OPERATOR', 'VIEWER'].map(canSeeFinancialReports)).toEqual([false, false, false, false, false])
    expect(['SALES_MANAGER', 'PURCHASE_MANAGER', 'ACCOUNTANT', 'MANAGEMENT', 'TENANT_ADMIN'].map(canSeeFinancialReports)).toEqual([true, true, true, true, true])
  })

  test('statements stay inside the company: another company\'s customer / supplier is 404 for every role', async () => {
    const b = await books()
    const other = await seedTenant()
    const theirC = await db.customer.create({ data: { companyId: other.company.id, code: 'X', name: 'Theirs' } })
    const theirS = await db.supplier.create({ data: { companyId: other.company.id, code: 'X', name: 'Theirs' } })
    for (const role of ['SALES_MANAGER', 'ACCOUNTANT', 'TENANT_ADMIN']) {
      const u = b.as(await seedUser(b.c, role))
      expect([role, (await u.get(customerStatement as never, `/api/customers/${theirC.id}/statement`, theirC.id)).status]).toEqual([role, 404])
    }
    const pm = b.as(await seedUser(b.c, 'PURCHASE_MANAGER'))
    expect((await pm.get(supplierStatement as never, `/api/suppliers/${theirS.id}/statement`, theirS.id)).status).toBe(404)
  })

  test('dashboard money figures only for roles that may see them', async () => {
    const b = await books()
    const op = await b.as(await seedUser(b.c, 'OPERATOR')).get(dashboard as never, '/api/dashboard')
    expect([op.status, op.json.data.money.cashInHand, op.json.data.money.youWillReceive, op.json.data.kpis.receivables]).toEqual([200, undefined, undefined, undefined])
    const sm = await b.as(await seedUser(b.c, 'SALES_MANAGER')).get(dashboard as never, '/api/dashboard')
    expect([sm.json.data.money.cashInHand, sm.json.data.money.youWillPay]).toEqual([undefined, undefined])
    const acc = await b.as(await seedUser(b.c, 'ACCOUNTANT')).get(dashboard as never, '/api/dashboard')
    expect([typeof acc.json.data.money.cashInHand, typeof acc.json.data.money.youWillReceive, typeof acc.json.data.money.youWillPay]).toEqual(['number', 'number', 'number'])
  })
})

describe('payment-kind write permissions', () => {
  const kinds = (b: Books) => ({
    customerReceipt: () => ({ type: 'RECEIPT', customerId: b.customer.id, invoiceType: 'SALES', invoiceId: b.inv.id, amount: 10, mode: 'CASH', date: '2026-05-12' }),
    advance: () => ({ type: 'RECEIPT', customerId: b.customer.id, invoiceType: 'ADVANCE', amount: 10, mode: 'CASH', date: '2026-05-12' }),
    customerRefund: () => ({ type: 'PAYMENT', customerId: b.customer.id, invoiceType: 'SALES_RETURN', invoiceId: b.sret.id, amount: 10, mode: 'CASH', date: '2026-05-12' }),
    supplierPayment: () => ({ type: 'PAYMENT', supplierId: b.supplier.id, invoiceType: 'PURCHASE', invoiceId: b.openBill.id, amount: 10, mode: 'CASH', date: '2026-05-12' }),
    supplierRefund: () => ({ type: 'RECEIPT', supplierId: b.supplier.id, invoiceType: 'PURCHASE_RETURN', invoiceId: b.pret.id, amount: 10, mode: 'CASH', date: '2026-05-12' }),
  })
  const MAY: Record<string, string[]> = {
    SALES_MANAGER: ['customerReceipt', 'advance', 'customerRefund'],
    PURCHASE_MANAGER: ['supplierPayment', 'supplierRefund'],
    ACCOUNTANT: ['customerReceipt', 'advance', 'customerRefund', 'supplierPayment', 'supplierRefund'],
    TENANT_ADMIN: ['customerReceipt', 'advance', 'customerRefund', 'supplierPayment', 'supplierRefund'],
  }

  test('create: each role may record only its own side; a refused request saves nothing', async () => {
    const b = await books()
    for (const [role, may] of Object.entries(MAY)) {
      const u = b.as(await seedUser(b.c, role))
      for (const [kind, body] of Object.entries(kinds(b))) {
        const before = await db.payment.count({ where: { companyId: b.c } })
        const r = await u.send(createPayment as never, '/api/payments', { ...body(), confirmDuplicate: true })
        expect([role, kind, r.status]).toEqual([role, kind, may.includes(kind) ? 200 : 403])
        expect(await db.payment.count({ where: { companyId: b.c } })).toBe(before + (may.includes(kind) ? 1 : 0))
      }
    }
  }, 60000)

  test('apply, void and bounce follow the same side', async () => {
    const b = await books()
    const adv = await b.ok(b.admin.send(createPayment as never, '/api/payments', kinds(b).advance()))
    const supPay = await b.ok(b.admin.send(createPayment as never, '/api/payments', { ...kinds(b).supplierPayment(), mode: 'CHEQUE', accountId: (await db.moneyAccount.findFirstOrThrow({ where: { companyId: b.c, type: 'BANK' } })).id, chequeNo: '5' }))
    const pm = b.as(await seedUser(b.c, 'PURCHASE_MANAGER'))
    const sm = b.as(await seedUser(b.c, 'SALES_MANAGER'))
    expect((await pm.send(patchPayment as never, `/api/payments/${adv.id}`, { action: 'apply', invoiceId: b.inv.id, amount: 5 }, 'PATCH', adv.id)).status).toBe(403)
    expect((await pm.send(voidPayment as never, `/api/payments/${adv.id}`, {}, 'DELETE', adv.id)).status).toBe(403)
    expect((await sm.send(voidPayment as never, `/api/payments/${supPay.id}`, {}, 'DELETE', supPay.id)).status).toBe(403)
    expect((await sm.send(patchPayment as never, `/api/payments/${supPay.id}`, { action: 'bounce' }, 'PATCH', supPay.id)).status).toBe(403)
    expect(await db.payment.count({ where: { companyId: b.c, id: { in: [adv.id, supPay.id] } } })).toBe(2)
    expect((await db.payment.findUniqueOrThrow({ where: { id: supPay.id } })).chequeStatus).toBeNull()
    expect((await sm.send(patchPayment as never, `/api/payments/${adv.id}`, { action: 'apply', invoiceId: b.inv.id, amount: 5 }, 'PATCH', adv.id)).status).toBe(200)
    expect((await pm.send(patchPayment as never, `/api/payments/${supPay.id}`, { action: 'bounce' }, 'PATCH', supPay.id)).status).toBe(200)
  })
})

// ============================== Negative cash ==============================

/** Cash ₹1,000 opening on 1 Apr, an empty bank, a supplier with an open ₹5,000 bill, a customer with an open ₹5,000 invoice. */
async function till() {
  const t = await seedTenant()
  const c = t.company.id
  type Res = ApiResult
  const send = (handler: unknown, path: string, body: Record<string, unknown>, opts: { user?: TestUser; method?: string; id?: string } = {}): Promise<Res> =>
    call((handler as (r: Request, x: unknown) => Promise<Response>)(apiRequest(path, { user: opts.user ?? t.user, method: opts.method, body: { companyId: c, ...body } }), opts.id ? ctx({ id: opts.id }) : undefined))
  const made = async (r: Promise<Res>) => { const x = await r; expect([x.status, x.json.error?.message]).toEqual([200, undefined]); return x.json.data }
  const cash = (await made(send(createAccount, '/api/accounts', { type: 'CASH', name: 'Cash in Hand', isDefault: true, openingBalance: 1000, openingDate: '2026-04-01' }))).id as string
  const bank = (await made(send(createAccount, '/api/accounts', { type: 'BANK', name: 'Main Bank', isDefault: true }))).id as string
  const [customer, supplier, item] = await Promise.all([
    db.customer.create({ data: { companyId: c, code: 'C-1', name: 'Asha Traders' } }),
    db.supplier.create({ data: { companyId: c, code: 'S-1', name: 'Bharat Steels' } }),
    db.item.create({ data: { companyId: c, code: 'IT-1', name: 'Test Part', uom: 'NOS' } }),
  ])
  const bill = await made(send(createPurchaseInvoice, '/api/purchase-invoices', { supplierId: supplier.id, date: '2026-05-01', lines: [{ itemId: item.id, qty: 50, rate: 100, gstRate: 0 }] }))
  const inv = await made(send(createSalesInvoice, '/api/sales-invoices', { customerId: customer.id, date: '2026-05-01', lines: [{ itemId: item.id, qty: 50, rate: 100, discountPct: 0, gstRate: 0 }] }))
  const cashNow = async () => (await accountBalances(c)).find((a) => a.id === cash)!.balance
  const payOut = (amount: number, extra: Record<string, unknown> = {}, user?: TestUser) =>
    send(createPayment, '/api/payments', { type: 'PAYMENT', supplierId: supplier.id, invoiceType: 'PURCHASE', invoiceId: bill.id, amount, mode: 'CASH', date: '2026-05-10', ...extra }, { user })
  const receive = (amount: number, extra: Record<string, unknown> = {}) =>
    send(createPayment, '/api/payments', { type: 'RECEIPT', customerId: customer.id, invoiceType: 'SALES', invoiceId: inv.id, amount, mode: 'CASH', date: '2026-05-10', ...extra })
  const spend = (amount: number, extra: Record<string, unknown> = {}, user?: TestUser) =>
    send(createExpense, '/api/expenses', { date: '2026-05-10', description: 'Test', category: 'OTHER', amount, paymentMode: 'CASH', ...extra }, { user })
  const overrides = () => db.auditLog.findMany({ where: { companyId: c, action: 'NEGATIVE_CASH_OVERRIDE' } })
  return { t, c, send, made, cash, bank, customer, supplier, item, bill, inv, cashNow, payOut, receive, spend, overrides }
}

describe('negative cash protection', () => {
  test('a cash payment beyond the balance is refused with the shortfall; nothing is saved or numbered', async () => {
    const s = await till()
    const r = await s.payOut(1200)
    expect([r.status, r.json.error?.code]).toEqual([409, 'NEGATIVE_CASH'])
    expect((r.json.error as any).details).toEqual({ accountId: s.cash, accountName: 'Cash in Hand', date: '2026-05-10', balance: -200, shortfall: 200 })
    expect(r.json.error?.message).toBe('Payment PYMT-2627-000001 takes Cash in Hand below zero: ₹-200.00 at the end of 2026-05-10. Short by ₹200.00.')
    expect([await db.payment.count({ where: { companyId: s.c } }), (await db.purchaseInvoice.findUniqueOrThrow({ where: { id: s.bill.id } })).paidAmount, await s.cashNow()]).toEqual([0, 0, 1000])
    // The number was not used up
    expect((await s.made(s.payOut(1000))).number).toBe('PYMT-2627-000001')
    expect(await s.cashNow()).toBe(0)
  })

  test('end of day counts: money received the same day covers a larger payment', async () => {
    const s = await till()
    await s.made(s.receive(500))
    expect((await s.payOut(1400)).status).toBe(200)
    expect(await s.cashNow()).toBe(100)
  })

  test('a back-dated entry is refused when it takes a LATER day below zero', async () => {
    const s = await till()
    await s.made(s.spend(800, { date: '2026-05-20' }))
    const r = await s.spend(300, { date: '2026-05-05', paidTo: 'Other' })
    expect([r.status, (r.json.error as any)?.details?.date, (r.json.error as any)?.details?.balance]).toEqual([409, '2026-05-20', -100])
    expect((await s.spend(200, { date: '2026-05-05', paidTo: 'Other' })).status).toBe(200)
  })

  test('bank accounts are never checked (overdraft is allowed)', async () => {
    const s = await till()
    expect((await s.payOut(3000, { mode: 'NEFT', accountId: s.bank })).status).toBe(200)
    expect((await s.spend(500, { paymentMode: 'UPI', accountId: s.bank })).status).toBe(200)
  })

  test('override: only Tenant Admin / Super Admin; the override is audit-logged; others get 403 and nothing is saved', async () => {
    const s = await till()
    for (const role of ['MANAGEMENT', 'ACCOUNTANT', 'ACCOUNTS_MANAGER', 'PURCHASE_MANAGER']) {
      const u = await seedUser(s.c, role)
      const r = await s.payOut(1500, { allowNegativeCash: true }, u)
      expect([role, r.status, r.json.error?.code]).toEqual([role, 403, 'NEGATIVE_CASH_OVERRIDE_DENIED'])
      // Without the flag they get the normal refusal
      expect([role, (await s.payOut(1500, {}, u)).status]).toEqual([role, 409])
    }
    expect(await db.payment.count({ where: { companyId: s.c } })).toBe(0)
    expect((await s.payOut(1500, { allowNegativeCash: true })).status).toBe(200) // TENANT_ADMIN
    const sup = await seedUser(s.c, 'SUPER_ADMIN')
    expect((await s.spend(100, { allowNegativeCash: true }, sup)).status).toBe(200)
    expect(await s.cashNow()).toBe(-600)
    const audit = await s.overrides()
    expect(audit.length).toBe(2)
    expect(audit[0].details).toContain('takes Cash in Hand below zero: ₹-500.00 at the end of 2026-05-10. Short by ₹500.00.')
    // The actor comes from the verified session headers, not from the request body
    expect(audit.map((a) => a.details!.slice(a.details!.indexOf('Saved anyway by')))).toEqual([`Saved anyway by ${s.t.user.name} (TENANT_ADMIN).`, `Saved anyway by ${sup.name} (SUPER_ADMIN).`])
    expect(audit.map((a) => a.userName)).toEqual([s.t.user.name, sup.name])
    // A flag that is not needed writes no override row
    expect((await s.receive(2000, { allowNegativeCash: true })).status).toBe(200)
    expect((await s.overrides()).length).toBe(2)
  })

  test('removing money that came in: voiding a cash receipt, deleting money added, deleting a spent loan', async () => {
    const s = await till()
    const rcpt = await s.made(s.receive(700))
    await s.made(s.spend(1500))
    const v = await s.send(voidPayment, `/api/payments/${rcpt.id}`, {}, { method: 'DELETE', id: rcpt.id })
    expect([v.status, v.json.error?.code]).toEqual([409, 'NEGATIVE_CASH'])
    expect(await db.payment.count({ where: { id: rcpt.id } })).toBe(1)

    const add = await s.made(s.send(createTxn, '/api/account-txns', { type: 'ADJUST_IN', toAccountId: s.cash, amount: 400, category: 'CAPITAL', date: '2026-05-11' }))
    await s.made(s.spend(500, { date: '2026-05-12', paidTo: 'X' }))
    expect((await s.send(deleteTxn, `/api/account-txns/${add.id}`, {}, { method: 'DELETE', id: add.id })).status).toBe(409)

    const loan = await s.made(s.send(createLoan, '/api/loans', { name: 'OD', principal: 3000, receivedAccountId: s.cash, startDate: '2026-05-13' }))
    await s.made(s.spend(3000, { date: '2026-05-14', paidTo: 'Y' }))
    expect((await s.send(deleteLoan, `/api/loans/${loan.id}`, {}, { method: 'DELETE', id: loan.id })).status).toBe(409)
    expect(await db.loan.count({ where: { id: loan.id } })).toBe(1)
    expect(await s.cashNow()).toBe(100)
  })

  test('other money out: contra from cash, reduce cash, loan EMI, bill paid now, lower opening balance', async () => {
    const s = await till()
    const contra = await s.send(createTxn, '/api/account-txns', { type: 'CONTRA', fromAccountId: s.cash, toAccountId: s.bank, amount: 1001, date: '2026-05-10' })
    expect([contra.status, contra.json.error?.code]).toEqual([409, 'NEGATIVE_CASH'])
    expect((await s.send(createTxn, '/api/account-txns', { type: 'ADJUST_OUT', fromAccountId: s.cash, amount: 1001, category: 'DRAWINGS', date: '2026-05-10' })).status).toBe(409)
    const loan = await s.made(s.send(createLoan, '/api/loans', { name: 'Bank loan', principal: 5000, receivedAccountId: s.bank, startDate: '2026-05-01' }))
    expect((await s.send(payEmi, `/api/loans/${loan.id}/emi`, { principal: 1000, interest: 50, fromAccountId: s.cash, date: '2026-05-10' }, { id: loan.id })).status).toBe(409)
    const bills = await db.purchaseInvoice.count({ where: { companyId: s.c } })
    const pb = await s.send(createPurchaseInvoice, '/api/purchase-invoices', { supplierId: s.supplier.id, date: '2026-05-10', lines: [{ itemId: s.item.id, qty: 20, rate: 100, gstRate: 0 }], paidNow: 2000, paymentMode: 'CASH' })
    expect([pb.status, pb.json.error?.code]).toEqual([409, 'NEGATIVE_CASH'])
    expect(await db.purchaseInvoice.count({ where: { companyId: s.c } })).toBe(bills)
    await s.made(s.spend(900))
    expect((await s.send(patchAccount, `/api/accounts/${s.cash}`, { openingBalance: 800 }, { method: 'PATCH', id: s.cash })).status).toBe(409)
    expect((await s.send(patchAccount, `/api/accounts/${s.cash}`, { openingBalance: 950 }, { method: 'PATCH', id: s.cash })).status).toBe(200)
    expect(await s.cashNow()).toBe(50)
  })

  test('expense edits that take more cash are checked; edits that give cash back are not', async () => {
    const s = await till()
    const e = await s.made(s.spend(600))
    const draft = await s.made(s.spend(600, { status: 'DRAFT', paidTo: 'D' }))
    const patch = (id: string, body: Record<string, unknown>) => s.send(patchExpense, `/api/expenses/${id}`, body, { method: 'PATCH', id })
    expect((await patch(e.id, { amount: 1100 })).status).toBe(409)
    expect((await patch(draft.id, { status: 'POSTED' })).status).toBe(409)
    expect((await patch(e.id, { amount: 300 })).status).toBe(200)
    expect((await patch(draft.id, { status: 'POSTED' })).status).toBe(200)
    expect(await s.cashNow()).toBe(100)
    // Spend it all with an override, then a cut / delete of an expense still works below zero
    await s.made(s.spend(500, { allowNegativeCash: true, paidTo: 'Z' }))
    expect((await patch(e.id, { amount: 250 })).status).toBe(200)
    expect((await s.send(deleteExpense, `/api/expenses/${draft.id}`, {}, { method: 'DELETE', id: draft.id })).status).toBe(200)
    expect(await s.cashNow()).toBe(250)
  })

  test('concurrency: five simultaneous ₹300 expenses against ₹1,000 — exactly three are saved', async () => {
    const s = await till()
    const rs = await Promise.all(Array.from({ length: 5 }, (_, i) => s.spend(300, { description: `E${i}`, confirmDuplicate: true })))
    expect(rs.map((r) => r.status).sort()).toEqual([200, 200, 200, 409, 409])
    expect(await s.cashNow()).toBe(100)
  }, 30000)

  test('concurrency: a receipt void and a payment racing for the same cash cannot both pass', async () => {
    const s = await till()
    const rcpt = await s.made(s.receive(500))
    const [v, p] = await Promise.all([
      s.send(voidPayment, `/api/payments/${rcpt.id}`, {}, { method: 'DELETE', id: rcpt.id }),
      s.payOut(1200),
    ])
    expect([v.status, p.status].sort()).toEqual([200, 409])
    expect(await s.cashNow()).toBeGreaterThanOrEqual(0)
  }, 30000)

  test('Adjust Cash: saved only while the reviewed balance is still the balance', async () => {
    const s = await till()
    const count = (counted: number, expectedBalance: number) => {
      const diff = counted - expectedBalance
      return s.send(createTxn, '/api/account-txns', diff > 0
        ? { type: 'ADJUST_IN', toAccountId: s.cash, amount: diff, category: 'OTHER_INCOME', date: '2026-05-10', expectedBalance }
        : { type: 'ADJUST_OUT', fromAccountId: s.cash, amount: -diff, category: 'OTHER_EXPENSE', date: '2026-05-10', expectedBalance })
    }
    await s.made(s.spend(100))
    const stale = await count(850, 1000) // the user reviewed ₹1,000, but ₹100 was spent meanwhile
    expect([stale.status, stale.json.error?.code, (stale.json.error as any).details]).toEqual([409, 'BALANCE_CHANGED', { balance: 900 }])
    expect((await count(850, 900)).status).toBe(200)
    expect(await s.cashNow()).toBe(850)
    expect((await count(870, 850)).status).toBe(200)
    expect(await s.cashNow()).toBe(870)
  })
})

// ============================== Duplicate warning ==============================

describe('possible duplicates', () => {
  test('payments: same party, amount, mode and IST day → 409 listing the match; confirm saves it', async () => {
    const s = await till()
    const first = await s.made(s.receive(250))
    const again = await s.receive(250)
    expect([again.status, again.json.error?.code, (again.json.error as any).details]).toEqual([409, 'POSSIBLE_DUPLICATE', { matches: [first.number] }])
    expect(again.json.error?.message).toBe(`Possible duplicate: ${first.number} has the same party, amount and mode on the same day. Save anyway?`)
    expect((await s.receive(250, { mode: 'UPI', accountId: s.bank })).status).toBe(200) // other mode
    expect((await s.receive(250, { date: '2026-05-11' })).status).toBe(200) // other day
    expect((await s.receive(251)).status).toBe(200) // other amount
    expect((await s.payOut(250)).status).toBe(200) // other direction / party
    expect((await s.receive(250, { confirmDuplicate: true })).status).toBe(200)
    expect(await db.payment.count({ where: { companyId: s.c, customerId: s.customer.id, amount: 250, mode: 'CASH', date: new Date('2026-05-10') } })).toBe(2)
  })

  test('confirming a duplicate bypasses nothing else: negative cash, permissions and validation still apply', async () => {
    const s = await till()
    await s.made(s.payOut(600))
    // Same party / amount / mode / day again, confirmed — but only ₹400 cash is left
    const r = await s.payOut(600, { confirmDuplicate: true })
    expect([r.status, r.json.error?.code]).toEqual([409, 'NEGATIVE_CASH'])
    const sm = await seedUser(s.c, 'SALES_MANAGER')
    expect((await s.payOut(100, { confirmDuplicate: true }, sm)).status).toBe(403)
    expect((await s.payOut(-5, { confirmDuplicate: true })).status).toBe(400)
    expect(await db.payment.count({ where: { companyId: s.c } })).toBe(1)
  })

  test('advances and refunds are checked the same way', async () => {
    const s = await till()
    const adv = { type: 'RECEIPT', customerId: s.customer.id, invoiceType: 'ADVANCE', amount: 300, mode: 'CASH', date: '2026-05-10' }
    await s.made(s.send(createPayment, '/api/payments', adv))
    expect((await s.send(createPayment, '/api/payments', adv)).json.error?.code).toBe('POSSIBLE_DUPLICATE')
    // A receipt against an invoice of the same party / amount / mode / day also matches
    expect((await s.receive(300)).json.error?.code).toBe('POSSIBLE_DUPLICATE')
  })

  test('expenses: same account, paid to, amount and mode on the day; cancelled ones do not count', async () => {
    const s = await till()
    const e = await s.made(s.spend(120, { paidTo: 'MSEB' }))
    expect((await s.spend(120, { paidTo: 'MSEB' })).json.error?.code).toBe('POSSIBLE_DUPLICATE')
    expect((await s.spend(120, { paidTo: 'Water' })).status).toBe(200)
    await s.made(s.send(patchExpense, `/api/expenses/${e.id}`, { status: 'CANCELLED' }, { method: 'PATCH', id: e.id }))
    expect((await s.spend(120, { paidTo: 'MSEB' })).status).toBe(200)
  })

  test('Cash & Bank entries: same type, accounts and amount on the day', async () => {
    const s = await till()
    const body = { type: 'CONTRA', fromAccountId: s.cash, toAccountId: s.bank, amount: 100, date: '2026-05-10' }
    await s.made(s.send(createTxn, '/api/account-txns', body))
    expect((await s.send(createTxn, '/api/account-txns', body)).json.error?.code).toBe('POSSIBLE_DUPLICATE')
    expect((await s.send(createTxn, '/api/account-txns', { ...body, confirmDuplicate: true })).status).toBe(200)
  })
})

// ============================== Idempotency ==============================

describe('Idempotency-Key', () => {
  async function keyed() {
    const s = await till()
    const raw = (handler: unknown, path: string, body: Record<string, unknown>, key: string, user?: TestUser) =>
      (handler as (r: Request) => Promise<Response>)(apiRequest(path, { user: user ?? s.t.user, body: { companyId: s.c, ...body }, headers: { 'Idempotency-Key': key } }))
    const send = async (handler: unknown, path: string, body: Record<string, unknown>, key: string, user?: TestUser) => {
      const res = await raw(handler, path, body, key, user)
      return { status: res.status, replay: res.headers.get('Idempotent-Replay') === 'true', json: await res.json() as any }
    }
    const pay = { type: 'PAYMENT', supplierId: s.supplier.id, invoiceType: 'PURCHASE', invoiceId: s.bill.id, amount: 300, mode: 'CASH', date: '2026-05-10' }
    return { ...s, raw, keyedSend: send, pay }
  }

  test('a retry with the same key returns the first response; nothing is created twice', async () => {
    const s = await keyed()
    const a = await s.keyedSend(createPayment, '/api/payments', s.pay, 'pay-key-0001')
    const b = await s.keyedSend(createPayment, '/api/payments', s.pay, 'pay-key-0001')
    expect([a.status, a.replay, b.status, b.replay]).toEqual([200, false, 200, true])
    expect(b.json).toEqual(a.json)
    expect([await db.payment.count({ where: { companyId: s.c } }), (await db.purchaseInvoice.findUniqueOrThrow({ where: { id: s.bill.id } })).paidAmount, await s.cashNow()]).toEqual([1, 300, 700])
    // A new key is a new request (here: caught by the duplicate warning, as without a key)
    expect((await s.keyedSend(createPayment, '/api/payments', s.pay, 'pay-key-0002')).json.error.code).toBe('POSSIBLE_DUPLICATE')
    const row = await db.idempotencyKey.findFirstOrThrow({ where: { companyId: s.c, key: 'pay-key-0001' } })
    expect([row.status, row.statusCode, row.userId, row.route]).toEqual(['DONE', 200, s.t.user.id, 'POST /api/payments'])
  })

  test('concurrency: eight simultaneous requests with one key create exactly one payment', async () => {
    const s = await keyed()
    const rs = await Promise.all(Array.from({ length: 8 }, () => s.keyedSend(createPayment, '/api/payments', s.pay, 'burst-key-01')))
    const firsts = rs.filter((r) => r.status === 200 && !r.replay)
    expect(firsts.length).toBe(1)
    for (const r of rs) {
      if (r.status === 200) expect(r.json).toEqual(firsts[0].json)
      else expect([r.status, r.json.error.code]).toEqual([409, 'IDEMPOTENCY_IN_PROGRESS'])
    }
    expect([await db.payment.count({ where: { companyId: s.c } }), await s.cashNow(), await db.idempotencyKey.count()]).toEqual([1, 700, 1])
  }, 30000)

  test('concurrency across routes: the same key on an expense and a payment — only the first route runs', async () => {
    const s = await keyed()
    const [a, b] = await Promise.all([
      s.keyedSend(createPayment, '/api/payments', s.pay, 'shared-key-1'),
      s.keyedSend(createExpense, '/api/expenses', { date: '2026-05-10', description: 'X', category: 'OTHER', amount: 300, paymentMode: 'CASH' }, 'shared-key-1'),
    ])
    // One runs; the other is told the key is busy (409) or belongs to another request (422)
    const [won, lost] = a.status === 200 ? [a, b] : [b, a]
    expect([won.status, [409, 422].includes(lost.status)]).toEqual([200, true])
    expect((await db.payment.count({ where: { companyId: s.c } })) + (await db.expense.count({ where: { companyId: s.c } }))).toBe(1)
  }, 30000)

  test('the same key with a different body, route or user is refused (422); a bad key is 400', async () => {
    const s = await keyed()
    await s.keyedSend(createPayment, '/api/payments', s.pay, 'reuse-key-01')
    expect([(await s.keyedSend(createPayment, '/api/payments', { ...s.pay, amount: 301 }, 'reuse-key-01')).status]).toEqual([422])
    expect((await s.keyedSend(createExpense, '/api/expenses', { description: 'X', amount: 1 }, 'reuse-key-01')).json.error.code).toBe('IDEMPOTENCY_KEY_REUSED')
    const other = await seedUser(s.c, 'ACCOUNTANT')
    expect((await s.keyedSend(createPayment, '/api/payments', s.pay, 'reuse-key-01', other)).status).toBe(422)
    expect((await s.keyedSend(createPayment, '/api/payments', s.pay, 'short')).json.error.code).toBe('IDEMPOTENCY_KEY_INVALID')
    expect(await db.payment.count({ where: { companyId: s.c } })).toBe(1)
  })

  test('a failed request frees its key: the corrected retry runs (nothing was saved by the failure)', async () => {
    const s = await keyed()
    const big = { ...s.pay, amount: 1500 }
    const a = await s.keyedSend(createPayment, '/api/payments', big, 'fail-key-001')
    expect([a.status, a.json.error.code, await db.idempotencyKey.count()]).toEqual([409, 'NEGATIVE_CASH', 0])
    // Same key, same body → runs again (and fails the same way) — not a stale "in progress"
    expect((await s.keyedSend(createPayment, '/api/payments', big, 'fail-key-001')).json.error.code).toBe('NEGATIVE_CASH')
    const ok = await s.keyedSend(createPayment, '/api/payments', { ...big, allowNegativeCash: true }, 'fail-key-001')
    expect([ok.status, await db.payment.count({ where: { companyId: s.c } })]).toEqual([200, 1])
  })

  test('crash safety: the DONE mark commits with the documents — a transaction that dies after done() leaves neither', async () => {
    const s = await keyed()
    const body = { date: '2026-05-10', description: 'X', category: 'OTHER', amount: 5, paymentMode: 'CASH' }
    const req = apiRequest('/api/expenses', { user: s.t.user, body: {}, headers: { 'Idempotency-Key': 'crash-key-01' } })
    const idem = await claimIdempotency(req, s.c, 'POST /api/expenses', { companyId: s.c, ...body })
    await expect(db.$transaction(async (tx) => {
      await tx.expense.create({ data: { companyId: s.c, number: 'EXP-X', date: new Date('2026-05-10'), category: 'OTHER', description: 'X', amount: 5, paymentMode: 'CASH', accountId: s.cash, status: 'POSTED' } })
      await idem.done(tx, { id: 'x' }, 'Expense recorded')
      throw new Error('process died before commit')
    })).rejects.toThrow('process died')
    const row = await db.idempotencyKey.findFirstOrThrow({ where: { key: 'crash-key-01' } })
    expect([row.status, await db.expense.count({ where: { companyId: s.c } })]).toEqual(['PENDING', 0])
    // While the claim is fresh, a retry is told to wait; nothing runs
    const wait = await s.keyedSend(createExpense, '/api/expenses', body, 'crash-key-01')
    expect([wait.status, wait.json.error.code]).toEqual([409, 'IDEMPOTENCY_IN_PROGRESS'])
  })

  test('stale claim (process died): after 10 minutes a retry takes the key over; the old claim can no longer commit', async () => {
    const s = await keyed()
    const body = { date: '2026-05-10', description: 'Diesel', category: 'OTHER', amount: 50, paymentMode: 'CASH' }
    const dead = await claimIdempotency(apiRequest('/api/expenses', { user: s.t.user, body: {}, headers: { 'Idempotency-Key': 'stale-key-01' } }), s.c, 'POST /api/expenses', { companyId: s.c, ...body })
    await db.$executeRaw`UPDATE IdempotencyKey SET updatedAt = DATE_SUB(updatedAt, INTERVAL 9 MINUTE) WHERE \`key\` = 'stale-key-01'`
    expect((await s.keyedSend(createExpense, '/api/expenses', body, 'stale-key-01')).json.error.code).toBe('IDEMPOTENCY_IN_PROGRESS')
    await db.$executeRaw`UPDATE IdempotencyKey SET updatedAt = DATE_SUB(updatedAt, INTERVAL 2 MINUTE) WHERE \`key\` = 'stale-key-01'`
    const retry = await s.keyedSend(createExpense, '/api/expenses', body, 'stale-key-01')
    expect([retry.status, retry.replay]).toEqual([200, false])
    // The dead request's transaction (if it ever resumed) cannot mark the key a second time → rolls back
    await expect(db.$transaction((tx) => dead.done(tx, {}, ''))).rejects.toThrow('taken over')
    await dead.release() // and cannot remove the new owner's row
    const again = await s.keyedSend(createExpense, '/api/expenses', body, 'stale-key-01')
    expect([again.status, again.replay, await db.expense.count({ where: { companyId: s.c } })]).toEqual([200, true, 1])
  })

  test('other money routes replay too: expense, Cash & Bank entry, loan + EMI, advance apply, sales invoice, purchase bill', async () => {
    const s = await keyed()
    const loan = await s.made(s.send(createLoan, '/api/loans', { name: 'Car loan', principal: 5000, receivedAccountId: s.bank, startDate: '2026-05-01' }))
    const adv = await s.made(s.send(createPayment, '/api/payments', { type: 'RECEIPT', customerId: s.customer.id, invoiceType: 'ADVANCE', amount: 100, mode: 'CASH', date: '2026-05-02' }))
    const cases: [unknown, string, Record<string, unknown>, () => Promise<number>][] = [
      [createExpense, '/api/expenses', { date: '2026-05-10', description: 'Tea', category: 'OTHER', amount: 20, paymentMode: 'CASH' }, () => db.expense.count({ where: { companyId: s.c } })],
      [createTxn, '/api/account-txns', { type: 'CONTRA', fromAccountId: s.cash, toAccountId: s.bank, amount: 10, date: '2026-05-10' }, () => db.accountTxn.count({ where: { companyId: s.c, type: 'CONTRA' } })],
      [createLoan, '/api/loans', { name: 'Second loan', principal: 1000, receivedAccountId: s.bank, startDate: '2026-05-01' }, () => db.loan.count({ where: { companyId: s.c } })],
      [createSalesInvoice, '/api/sales-invoices', { customerId: s.customer.id, date: '2026-05-10', lines: [{ itemId: s.item.id, qty: 1, rate: 10, discountPct: 0, gstRate: 0 }], receivedAmount: 10, receivedMode: 'CASH' }, () => db.salesInvoice.count({ where: { companyId: s.c } })],
      [createPurchaseInvoice, '/api/purchase-invoices', { supplierId: s.supplier.id, date: '2026-05-10', lines: [{ itemId: s.item.id, qty: 1, rate: 10, gstRate: 0 }], paidNow: 10, paymentMode: 'CASH' }, () => db.purchaseInvoice.count({ where: { companyId: s.c } })],
    ]
    for (const [i, [handler, path, body, count]] of cases.entries()) {
      const a = await s.keyedSend(handler, path, body, `multi-key-${i}0`)
      const before = await count()
      const b = await s.keyedSend(handler, path, body, `multi-key-${i}0`)
      expect([path, a.status, b.status, b.replay, await count()]).toEqual([path, 200, 200, true, before])
      expect(b.json).toEqual(a.json)
    }
    const emi = (key: string) => (payEmi as (r: Request, x: unknown) => Promise<Response>)(apiRequest(`/api/loans/${loan.id}/emi`, { user: s.t.user, body: { companyId: s.c, principal: 100, interest: 5, fromAccountId: s.bank, date: '2026-05-10' }, headers: { 'Idempotency-Key': key } }), ctx({ id: loan.id }))
    const e1 = await emi('emi-key-0001'); const e2 = await emi('emi-key-0001')
    expect([e1.status, e2.headers.get('Idempotent-Replay'), await db.accountTxn.count({ where: { companyId: s.c, type: 'LOAN_EMI' } })]).toEqual([200, 'true', 1])
    const apply = (key: string) => (patchPayment as (r: Request, x: unknown) => Promise<Response>)(apiRequest(`/api/payments/${adv.id}`, { method: 'PATCH', user: s.t.user, body: { companyId: s.c, action: 'apply', invoiceId: s.inv.id, amount: 40 }, headers: { 'Idempotency-Key': key } }), ctx({ id: adv.id }))
    const p1 = await apply('apply-key-01'); const p2 = await apply('apply-key-01')
    expect([p1.status, p2.headers.get('Idempotent-Replay'), await db.payment.count({ where: { companyId: s.c, mode: 'ADVANCE_ADJ' } })]).toEqual([200, 'true', 1])
  }, 30000)

  test('company isolation: the same key in another company is a separate request and never replays this one', async () => {
    const s = await keyed()
    const a = await s.keyedSend(createPayment, '/api/payments', s.pay, 'iso-key-0001')
    const other = await till()
    const r = await call((createPayment as (r: Request) => Promise<Response>)(apiRequest('/api/payments', { user: other.t.user, body: { companyId: other.c, ...s.pay, supplierId: other.supplier.id, invoiceId: other.bill.id }, headers: { 'Idempotency-Key': 'iso-key-0001' } })))
    expect([a.status, r.status]).toEqual([200, 200])
    expect(r.json.data.id).not.toBe(a.json.data.id)
    expect([await db.payment.count({ where: { companyId: s.c } }), await db.payment.count({ where: { companyId: other.c } }), await db.idempotencyKey.count()]).toEqual([1, 1, 2])
    // A user of the other company cannot address this company's key at all (company access is checked first)
    const cross = await call((createPayment as (r: Request) => Promise<Response>)(apiRequest('/api/payments', { user: other.t.user, body: { companyId: s.c, ...s.pay }, headers: { 'Idempotency-Key': 'iso-key-0001' } })))
    expect(cross.status).toBe(403)
  })

  test('keys are purged after 7 days', async () => {
    const s = await keyed()
    await s.keyedSend(createPayment, '/api/payments', s.pay, 'old-key-0001')
    await db.$executeRaw`UPDATE IdempotencyKey SET createdAt = createdAt - INTERVAL 6 DAY`
    await purgeIdempotencyKeys()
    expect(await db.idempotencyKey.count()).toBe(1)
    await db.$executeRaw`UPDATE IdempotencyKey SET createdAt = createdAt - INTERVAL 2 DAY`
    await purgeIdempotencyKeys()
    expect(await db.idempotencyKey.count()).toBe(0)
  })

  test('without the header nothing changes (no key rows)', async () => {
    const s = await keyed()
    expect((await s.payOut(10)).status).toBe(200)
    expect(await db.idempotencyKey.count()).toBe(0)
  })
})

// ============================== Supplier statement ==============================

describe('supplier statement (Phase 5 fix)', () => {
  async function history() {
    const s = await till()
    const statement = async (from = '2026-04-01', to = '2026-05-31') => {
      const r = await call(supplierStatement(apiRequest(`/api/suppliers/${s.supplier.id}/statement?companyId=${s.c}&from=${from}&to=${to}`, { user: s.t.user }), ctx({ id: s.supplier.id })))
      expect(r.status).toBe(200)
      return r.json.data as { openingBalance: number; rows: { type: string; ref: string; particulars: string; debit: number; credit: number; balance: number }[]; totals: { debits: number; credits: number; closing: number } }
    }
    // Bill 1 (₹5,000, open, from till()): a ₹1,000 cheque that bounces, then ₹400 cash
    const chq = await s.made(s.send(createPayment, '/api/payments', { type: 'PAYMENT', supplierId: s.supplier.id, invoiceType: 'PURCHASE', invoiceId: s.bill.id, amount: 1000, mode: 'CHEQUE', accountId: s.bank, chequeNo: '77', date: '2026-05-05' }))
    await s.made(s.send(patchPayment, `/api/payments/${chq.id}`, { action: 'bounce' }, { method: 'PATCH', id: chq.id }))
    await s.made(s.payOut(400, { date: '2026-05-06' }))
    // Bill 2 (₹1,000) paid in full by NEFT, then 3 returned → ₹300 debit note, all due back; ₹120 refund received
    const bill2 = await s.made(s.send(createPurchaseInvoice, '/api/purchase-invoices', { supplierId: s.supplier.id, date: '2026-05-08', lines: [{ itemId: s.item.id, qty: 10, rate: 100, gstRate: 0 }], receiveStock: true, warehouseId: s.t.warehouse.id, paidNow: 1000, paymentMode: 'NEFT', accountId: s.bank }))
    const ret2 = await s.made(s.send(createPurchaseReturn, '/api/purchase-returns', { invoiceId: bill2.id, date: '2026-05-09', warehouseId: s.t.warehouse.id, lines: [{ invoiceItemId: bill2.items[0].id, qty: 3 }] }))
    const refund = await s.made(s.send(createPayment, '/api/payments', { type: 'RECEIPT', supplierId: s.supplier.id, invoiceType: 'PURCHASE_RETURN', invoiceId: ret2.id, amount: 120, mode: 'CASH', date: '2026-05-12' }))
    // Bill 3 (₹500, open), 1 returned → ₹100 debit note adjusted on the bill itself
    const bill3 = await s.made(s.send(createPurchaseInvoice, '/api/purchase-invoices', { supplierId: s.supplier.id, date: '2026-05-10', lines: [{ itemId: s.item.id, qty: 5, rate: 100, gstRate: 0 }], receiveStock: true, warehouseId: s.t.warehouse.id }))
    const ret3 = await s.made(s.send(createPurchaseReturn, '/api/purchase-returns', { invoiceId: bill3.id, date: '2026-05-11', warehouseId: s.t.warehouse.id, lines: [{ invoiceItemId: bill3.items[0].id, qty: 1 }] }))
    return { ...s, statement, chq, ret2, ret3, refund, bill3 }
  }

  test('bounced cheque left out, refund received is a debit, debit-note excess and applied part are credits', async () => {
    const h = await history()
    const st = await h.statement()
    expect(st.rows.some((r) => r.ref === h.chq.number)).toBe(false)
    expect(st.rows.filter((r) => r.type === 'REFUND').map((r) => [r.ref, r.debit, r.credit])).toEqual([[h.refund.number, 120, 0]])
    expect(st.rows.filter((r) => r.type === 'DEBIT_NOTE').map((r) => [r.ref, r.debit, r.credit])).toEqual([[h.ret2.number, 0, 300]])
    expect(st.rows.filter((r) => r.particulars.startsWith('Debit note ') && r.type === 'PAYMENT').map((r) => [r.credit, r.particulars])).toEqual([[100, `Debit note ${h.ret3.number} adjusted on ${h.bill3.number}`]])
    // 5000 + 1000 + 500 bills − 400 − 1000 paid − 100 adjusted − 300 due back + 120 refunded = 4820
    expect([st.totals.debits, st.totals.credits, st.totals.closing]).toEqual([6620, 1800, 4820])
    expect(st.rows.at(-1)!.balance).toBe(4820)
  })

  test('closing reconciles to the books: open bills − refunds still due from the supplier', async () => {
    const h = await history()
    const st = await h.statement()
    const bills = await db.purchaseInvoice.findMany({ where: { companyId: h.c, supplierId: h.supplier.id, status: { not: 'CANCELLED' } } })
    const owed = bills.reduce((x, b) => x + b.grandTotal - b.paidAmount, 0)
    const { supplierRefunds } = await partyCreditsAsOf(h.c, undefined, { supplierId: h.supplier.id })
    expect([owed, supplierRefunds]).toEqual([5000, 180])
    expect(st.totals.closing).toBe(owed - supplierRefunds)
  })

  test('a period split carries everything before it into the opening balance; the closing is unchanged', async () => {
    const h = await history()
    const part = await h.statement('2026-05-07')
    expect(part.openingBalance).toBe(4600) // bill 1 − ₹400 cash (the bounced cheque never counted)
    expect(part.rows.some((r) => r.ref === h.chq.number)).toBe(false)
    expect(part.totals.closing).toBe(4820)
  })

  test('cancelled debit note, several refunds and a "to" date that ends before later rows', async () => {
    const h = await history()
    // A second ₹30 refund on the bill-2 debit note, later in May
    await h.made(h.send(createPayment, '/api/payments', { type: 'RECEIPT', supplierId: h.supplier.id, invoiceType: 'PURCHASE_RETURN', invoiceId: h.ret2.id, amount: 30, mode: 'CASH', date: '2026-05-20' }))
    // Cancel the bill-3 debit note: its ₹100 adjustment goes away, bill 3 owes ₹500 again
    await h.made(h.send(patchPurchaseReturn, `/api/purchase-returns/${h.ret3.id}`, { action: 'cancel' }, { method: 'PATCH', id: h.ret3.id }))
    const st = await h.statement()
    expect(st.rows.filter((r) => r.type === 'REFUND').map((r) => r.debit)).toEqual([120, 30])
    expect(st.rows.some((r) => r.particulars.includes(h.ret3.number))).toBe(false)
    // 6500 − 1400 − 300 + 150 = 4950 = open bills 5100 − refund still due 150
    expect(st.totals.closing).toBe(4950)
    const { supplierRefunds } = await partyCreditsAsOf(h.c, undefined, { supplierId: h.supplier.id })
    expect(supplierRefunds).toBe(150)
    // Up to 15 May: the 20 May refund is not in the period
    const early = await h.statement('2026-04-01', '2026-05-15')
    expect([early.rows.filter((r) => r.type === 'REFUND').length, early.totals.closing]).toEqual([1, 4920])
  })

  test('statement isolation: another company cannot read this supplier', async () => {
    const h = await history()
    const other = await seedTenant()
    const r = await call(supplierStatement(apiRequest(`/api/suppliers/${h.supplier.id}/statement?companyId=${other.company.id}`, { user: other.user }), ctx({ id: h.supplier.id })))
    expect(r.status).toBe(404)
  })
})
