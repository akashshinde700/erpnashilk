import { afterEach, beforeEach, describe, expect, setSystemTime, test } from 'bun:test'
import { db } from '@/lib/db'
import { accountBalances } from '@/lib/accounts'
import { cashFlow, endOfDayStr, gstTotals, listTransactions, profitAndLoss } from '@/lib/accounting'
import { cashBankLedger } from '@/lib/cash-bank-ledger'
import { POST as createAccount } from '@/app/api/accounts/route'
import { POST as createTxn } from '@/app/api/account-txns/route'
import { POST as createPayment } from '@/app/api/payments/route'
import { PATCH as chequeAction } from '@/app/api/payments/[id]/route'
import { POST as createExpense } from '@/app/api/expenses/route'
import { POST as createLoan } from '@/app/api/loans/route'
import { GET as history } from '@/app/api/cash-bank/transactions/route'
import { GET as daybook } from '@/app/api/reports/daybook/route'
import { GET as txnReport } from '@/app/api/reports/transactions/route'
import { POST as createSalesInvoice } from '@/app/api/sales-invoices/route'
import { PATCH as patchSalesInvoice } from '@/app/api/sales-invoices/[id]/route'
import { POST as createPurchaseInvoice } from '@/app/api/purchase-invoices/route'
import { PATCH as patchPurchaseInvoice } from '@/app/api/purchase-invoices/[id]/route'
import { POST as createSalesReturn } from '@/app/api/sales-returns/route'
import { apiRequest, call, ctx, type TestUser } from './helpers/api'
import { resetDb } from './helpers/db'
import { seedTenant } from './helpers/seed'

/** Cash & Bank Phase 2: unified transaction history (+ filters), CB-R3 (invoice / bill IST dates), CB-R4 (daybook cheque dates). */

type Tenant = Awaited<ReturnType<typeof seedTenant>>
interface Item { id: string; date: string | null; type: string; number: string; party: string; accountId: string; accountName: string; moneyIn: number; moneyOut: number; balance: number }

async function post(handler: (r: Request) => Promise<Response>, path: string, user: TestUser, body: Record<string, unknown>) {
  const r = await call(handler(apiRequest(path, { user, body })))
  return r
}
async function must(handler: (r: Request) => Promise<Response>, path: string, user: TestUser, body: Record<string, unknown>) {
  const r = await post(handler, path, user, body)
  expect([r.status, r.json.error?.message]).toEqual([200, undefined])
  return r.json.data
}
async function hist(t: Tenant, qs: Record<string, string> = {}) {
  const r = await call(history(apiRequest(`/api/cash-bank/transactions?${new URLSearchParams({ companyId: t.company.id, ...qs })}`, { user: t.user })))
  return r
}
async function histData(t: Tenant, qs: Record<string, string> = {}) {
  const r = await hist(t, qs)
  expect([r.status, r.json.error?.message]).toEqual([200, undefined])
  return r.json.data as { items: Item[]; totals: { count: number; moneyIn: number; moneyOut: number }; opening: number; closing: number; filtered: boolean; pendingCheques: { count: number; toReceive: number; toPay: number }; parties: { id: string; name: string }[] }
}
const day = (d: string | null) => (d ? String(d).slice(0, 10) : null)

/** A company with cash + bank, a customer, a supplier and one money movement of every kind. */
async function seedBooks() {
  const t = await seedTenant()
  const c = t.company.id
  const cash = (await must(createAccount, '/api/accounts', t.user, { companyId: c, type: 'CASH', name: 'Cash in Hand', isDefault: true, openingBalance: 2000, openingDate: '2026-04-01' })).id as string
  const bank = (await must(createAccount, '/api/accounts', t.user, { companyId: c, type: 'BANK', name: 'Main Bank', isDefault: true, openingBalance: 10000, openingDate: '2026-04-01' })).id as string
  const [customer, supplier, item] = await Promise.all([
    db.customer.create({ data: { companyId: c, code: 'C-1', name: 'Asha Traders' } }),
    db.supplier.create({ data: { companyId: c, code: 'S-1', name: 'Bharat Steels' } }),
    db.item.create({ data: { companyId: c, code: 'IT-1', name: 'Test Part', uom: 'NOS' } }),
  ])
  const line = [{ itemId: item.id, qty: 10, rate: 100, discountPct: 0, gstRate: 0 }]
  const inv = await must(createSalesInvoice, '/api/sales-invoices', t.user, { companyId: c, customerId: customer.id, date: '2026-05-02', lines: line, receivedAmount: 300, receivedMode: 'CASH' })
  await must(createPayment, '/api/payments', t.user, { companyId: c, type: 'RECEIPT', customerId: customer.id, invoiceType: 'SALES', invoiceId: inv.id, amount: 500, mode: 'UPI', accountId: bank, date: '2026-05-05' })
  const bill = await must(createPurchaseInvoice, '/api/purchase-invoices', t.user, { companyId: c, supplierId: supplier.id, date: '2026-05-03', lines: line })
  await must(createPayment, '/api/payments', t.user, { companyId: c, type: 'PAYMENT', supplierId: supplier.id, invoiceType: 'PURCHASE', invoiceId: bill.id, amount: 400, mode: 'NEFT', accountId: bank, date: '2026-05-06' })
  await must(createExpense, '/api/expenses', t.user, { companyId: c, date: '2026-05-07', description: 'Electricity', category: 'UTILITIES', amount: 150, paymentMode: 'CASH' })
  await must(createExpense, '/api/expenses', t.user, { companyId: c, date: '2026-05-07', description: 'Draft only', category: 'OTHER', amount: 999, paymentMode: 'CASH', status: 'DRAFT' })
  await must(createTxn, '/api/account-txns', t.user, { companyId: c, type: 'ADJUST_IN', toAccountId: cash, amount: 1000, category: 'CAPITAL', date: '2026-05-08' })
  await must(createTxn, '/api/account-txns', t.user, { companyId: c, type: 'ADJUST_OUT', fromAccountId: cash, amount: 100, category: 'DRAWINGS', date: '2026-05-09' })
  await must(createTxn, '/api/account-txns', t.user, { companyId: c, type: 'CONTRA', fromAccountId: cash, toAccountId: bank, amount: 700, date: '2026-05-10' })
  await must(createLoan, '/api/loans', t.user, { companyId: c, name: 'Machine Loan', principal: 5000, startDate: '2026-05-11', receivedAccountId: bank })
  return { t, cash, bank, customer, supplier, item, inv, bill, line }
}

beforeEach(resetDb)
afterEach(() => { setSystemTime() })

// ============================== Unified history ==============================

describe('unified transaction history', () => {
  test('every money movement appears once per account, with the right direction; non-money entries are left out', async () => {
    const { t, cash, bank } = await seedBooks()
    const d = await histData(t)
    const rows = d.items.map((r) => [day(r.date), r.type, r.accountName, r.moneyIn, r.moneyOut])
    expect(rows).toEqual([
      ['2026-05-11', 'LOAN_IN', 'Main Bank', 5000, 0],
      ['2026-05-10', 'TRANSFER', 'Main Bank', 700, 0],
      ['2026-05-10', 'TRANSFER', 'Cash in Hand', 0, 700],
      ['2026-05-09', 'ADJUST_OUT', 'Cash in Hand', 0, 100],
      ['2026-05-08', 'ADJUST_IN', 'Cash in Hand', 1000, 0],
      ['2026-05-07', 'EXPENSE', 'Cash in Hand', 0, 150], // the DRAFT expense is not here
      ['2026-05-06', 'PAYMENT_OUT', 'Main Bank', 0, 400],
      ['2026-05-05', 'PAYMENT_IN', 'Main Bank', 500, 0],
      ['2026-05-02', 'PAYMENT_IN', 'Cash in Hand', 300, 0], // received with the invoice
      ['2026-04-01', 'OPENING', 'Main Bank', 10000, 0],
      ['2026-04-01', 'OPENING', 'Cash in Hand', 2000, 0],
    ])
    // the newest row of each account carries its current balance
    const live = await accountBalances(t.company.id)
    for (const id of [cash, bank]) expect(d.items.find((r) => r.accountId === id)?.balance).toBe(live.find((b) => b.id === id)?.balance)
    expect([d.opening, d.closing]).toEqual([0, live.reduce((s, b) => s + b.balance, 0)])
    expect(d.closing).toBe(18150) // 2000+300-150+1000-100-700 = 2350 cash; 10000+500-400+700+5000 = 15800 bank
  })

  test('running balance of every row equals the account balance at the end of that row (same-day rows in entry order)', async () => {
    const { t } = await seedBooks()
    const { rows } = await cashBankLedger(t.company.id)
    for (const r of rows) {
      const lastOfDay = [...rows].reverse().find((x) => x.accountId === r.accountId && day(x.date?.toISOString() ?? null) === day(r.date?.toISOString() ?? null))
      if (lastOfDay !== r || !r.date) continue
      const b = (await accountBalances(t.company.id, endOfDayStr(r.date.toISOString().slice(0, 10)))).find((x) => x.id === r.accountId)
      expect([r.id, r.balance]).toEqual([r.id, b!.balance])
    }
  })

  test('filters: account, type, party, dates and search — balances stay the whole account\'s', async () => {
    const { t, bank, customer } = await seedBooks()

    const onlyBank = await histData(t, { accountId: bank })
    expect(onlyBank.items.every((r) => r.accountId === bank)).toBe(true)
    expect([onlyBank.opening, onlyBank.closing]).toEqual([0, 15800])
    expect(onlyBank.items.map((r) => r.balance)).toEqual([15800, 10800, 10100, 10500, 10000])

    const period = await histData(t, { accountId: bank, from: '2026-05-05', to: '2026-05-10' })
    expect(period.items.map((r) => r.type)).toEqual(['TRANSFER', 'PAYMENT_OUT', 'PAYMENT_IN'])
    expect([period.opening, period.totals.moneyIn, period.totals.moneyOut, period.closing]).toEqual([10000, 1200, 400, 10800])
    expect(period.opening + period.totals.moneyIn - period.totals.moneyOut).toBe(period.closing)
    expect(period.filtered).toBe(false)

    const typed = await histData(t, { type: 'PAYMENT_IN,EXPENSE' })
    expect(typed.items.map((r) => r.type).sort()).toEqual(['EXPENSE', 'PAYMENT_IN', 'PAYMENT_IN'])
    expect([typed.filtered, typed.closing]).toEqual([true, 18150]) // balance is not narrowed by the type filter

    const party = await histData(t, { partyId: customer.id })
    expect(party.items.map((r) => [r.type, r.party, r.moneyIn])).toEqual([['PAYMENT_IN', 'Asha Traders', 500], ['PAYMENT_IN', 'Asha Traders', 300]])
    expect(party.parties.map((p) => p.name)).toEqual(['Asha Traders', 'Bharat Steels'])

    const search = await histData(t, { q: 'electricity' })
    expect(search.items.map((r) => r.type)).toEqual(['EXPENSE'])
    const byNumber = await histData(t, { q: search.items[0].number.toLowerCase() })
    expect(byNumber.items).toHaveLength(1)

    const oneDay = await histData(t, { from: '2026-05-07', to: '2026-05-07' })
    expect(oneDay.items.map((r) => r.type)).toEqual(['EXPENSE'])
  })

  test('bad input: unknown type 400, from after to 400, unknown or other company\'s account 404', async () => {
    const { t } = await seedBooks()
    const other = await seedTenant()
    const otherBank = (await must(createAccount, '/api/accounts', other.user, { companyId: other.company.id, type: 'BANK', name: 'Their Bank' })).id
    expect((await hist(t, { type: 'SALE' })).status).toBe(400)
    expect((await hist(t, { from: '2026-05-10', to: '2026-05-01' })).status).toBe(400)
    expect((await hist(t, { accountId: 'nope' })).status).toBe(404)
    expect((await hist(t, { accountId: otherBank })).status).toBe(404)
    // the other company sees only its own (empty) books
    const theirs = await histData(other)
    expect([theirs.items.length, theirs.closing]).toEqual([0, 0])
  })

  test('post-dated cheques: listed as "not cleared yet", then in the history on the clearing date', async () => {
    const { t, bank, customer, line } = await seedBooks()
    setSystemTime(new Date('2026-05-12T06:00:00Z'))
    const inv = await must(createSalesInvoice, '/api/sales-invoices', t.user, { companyId: t.company.id, customerId: customer.id, date: '2026-05-12', lines: line })
    const pay = await must(createPayment, '/api/payments', t.user, { companyId: t.company.id, type: 'RECEIPT', customerId: customer.id, invoiceType: 'SALES', invoiceId: inv.id, amount: 800, mode: 'CHEQUE', accountId: bank, chequeNo: '4455', chequeDate: '2026-05-20', date: '2026-05-12' })
    let d = await histData(t, { accountId: bank })
    expect(d.pendingCheques).toEqual({ count: 1, toReceive: 800, toPay: 0 })
    expect(d.items.some((r) => r.number === pay.number)).toBe(false)

    setSystemTime(new Date('2026-05-22T06:00:00Z'))
    expect((await call(chequeAction(apiRequest(`/api/payments/${pay.id}`, { method: 'PATCH', user: t.user, body: { companyId: t.company.id, action: 'clear', date: '2026-05-21' } }), ctx({ id: pay.id })))).status).toBe(200)
    d = await histData(t, { accountId: bank })
    expect(d.pendingCheques.count).toBe(0)
    expect([day(d.items[0].date), d.items[0].type, d.items[0].moneyIn, d.items[0].balance]).toEqual(['2026-05-21', 'PAYMENT_IN', 800, 16600])
    expect((await histData(t, { accountId: bank, from: '2026-05-12', to: '2026-05-20' })).items).toHaveLength(0)
  })

  test('a legacy payment without an account shows on the default account, like the balance', async () => {
    const { t, cash, customer, inv } = await seedBooks()
    await db.payment.create({ data: { companyId: t.company.id, number: 'LEGACY-1', type: 'RECEIPT', partyType: 'CUSTOMER', customerId: customer.id, invoiceType: 'SALES', invoiceId: inv.id, amount: 50, mode: 'CASH', date: new Date('2026-05-04T00:00:00Z') } })
    const d = await histData(t, { accountId: cash })
    expect(d.items.find((r) => r.number === 'LEGACY-1')?.moneyIn).toBe(50)
    expect(d.closing).toBe((await accountBalances(t.company.id)).find((b) => b.id === cash)!.balance)
  })

  test('credit notes and bounced cheques never show as money', async () => {
    const { t, bank, customer, line } = await seedBooks()
    const inv = await must(createSalesInvoice, '/api/sales-invoices', t.user, { companyId: t.company.id, customerId: customer.id, date: '2026-05-12', lines: line })
    const invItem = await db.salesInvoiceItem.findFirstOrThrow({ where: { invoiceId: inv.id } })
    await must(createSalesReturn, '/api/sales-returns', t.user, { companyId: t.company.id, invoiceId: inv.id, date: '2026-05-13', lines: [{ invoiceItemId: invItem.id, qty: 1 }] })
    const chq = await must(createPayment, '/api/payments', t.user, { companyId: t.company.id, type: 'RECEIPT', customerId: customer.id, invoiceType: 'SALES', invoiceId: inv.id, amount: 200, mode: 'CHEQUE', accountId: bank, date: '2026-05-13' })
    await call(chequeAction(apiRequest(`/api/payments/${chq.id}`, { method: 'PATCH', user: t.user, body: { companyId: t.company.id, action: 'bounce' } }), ctx({ id: chq.id })))
    const d = await histData(t, { from: '2026-05-12', to: '2026-05-31' })
    expect(d.items).toHaveLength(0)
  })
})

// ============================== CB-R3: invoice and bill dates ==============================

describe('CB-R3: invoice and bill dates use the IST business day', () => {
  test('an invoice and a bill saved at 00:30 IST without a date belong to that IST day — documents, payments and reports', async () => {
    const { t, customer, supplier, line } = await seedBooks()
    setSystemTime(new Date('2026-05-14T19:00:00Z')) // 15 May, 00:30 IST
    const inv = await must(createSalesInvoice, '/api/sales-invoices', t.user, { companyId: t.company.id, customerId: customer.id, lines: line, receivedAmount: 100, receivedMode: 'CASH' })
    const bill = await must(createPurchaseInvoice, '/api/purchase-invoices', t.user, { companyId: t.company.id, supplierId: supplier.id, lines: line, paidNow: 50, paymentMode: 'CASH' })
    expect(new Date(inv.date).toISOString()).toBe('2026-05-15T00:00:00.000Z')
    expect(new Date(bill.date).toISOString()).toBe('2026-05-15T00:00:00.000Z')
    const pays = await db.payment.findMany({ where: { companyId: t.company.id, invoiceId: { in: [inv.id, bill.id] } } })
    expect(pays.map((p) => p.date.toISOString())).toEqual(['2026-05-15T00:00:00.000Z', '2026-05-15T00:00:00.000Z'])

    const pl = await profitAndLoss(t.company.id, new Date('2026-05-15'), endOfDayStr('2026-05-15'))
    expect([pl.sales.gross, pl.purchases.gross]).toEqual([1000, 1000])
    const before = await profitAndLoss(t.company.id, new Date('2026-05-14'), endOfDayStr('2026-05-14'))
    expect([before.sales.gross, before.purchases.gross]).toEqual([0, 0])
    const types = (await listTransactions(t.company.id, new Date('2026-05-15'), endOfDayStr('2026-05-15'))).map((r) => r.type).sort()
    expect(types).toEqual(['PAYMENT_IN', 'PAYMENT_OUT', 'PURCHASE', 'SALE'])
  })

  test('GST totals for the IST day include an invoice and a bill saved at 00:30 IST without a date', async () => {
    const { t, customer, supplier, item } = await seedBooks()
    const gstLine = [{ itemId: item.id, qty: 10, rate: 100, discountPct: 0, gstRate: 18 }]
    setSystemTime(new Date('2026-05-14T19:00:00Z')) // 15 May, 00:30 IST
    await must(createSalesInvoice, '/api/sales-invoices', t.user, { companyId: t.company.id, customerId: customer.id, lines: gstLine })
    await must(createPurchaseInvoice, '/api/purchase-invoices', t.user, { companyId: t.company.id, supplierId: supplier.id, lines: gstLine })
    const on15 = await gstTotals(t.company.id, { gte: new Date('2026-05-15'), lte: endOfDayStr('2026-05-15') })
    const on14 = await gstTotals(t.company.id, { gte: new Date('2026-05-14'), lte: endOfDayStr('2026-05-14') })
    expect([on15.outputTotal, on15.inputTotal]).toEqual([180, 180])
    expect([on14.outputTotal, on14.inputTotal]).toEqual([0, 0])
  })

  test('date-only input is unchanged; a timestamp becomes its IST day; an invalid date is refused (nothing saved)', async () => {
    const { t, customer, supplier, line } = await seedBooks()
    const a = await must(createSalesInvoice, '/api/sales-invoices', t.user, { companyId: t.company.id, customerId: customer.id, date: '2026-05-16', lines: line })
    expect(new Date(a.date).toISOString()).toBe('2026-05-16T00:00:00.000Z')
    const b = await must(createPurchaseInvoice, '/api/purchase-invoices', t.user, { companyId: t.company.id, supplierId: supplier.id, date: '2026-05-16T20:00:00.000Z', lines: line })
    expect(new Date(b.date).toISOString()).toBe('2026-05-17T00:00:00.000Z')
    const n = await db.purchaseInvoice.count({ where: { companyId: t.company.id } })
    expect((await post(createPurchaseInvoice, '/api/purchase-invoices', t.user, { companyId: t.company.id, supplierId: supplier.id, date: 'not-a-date', lines: line })).status).toBe(400)
    expect((await post(createSalesInvoice, '/api/sales-invoices', t.user, { companyId: t.company.id, customerId: customer.id, date: '2026-02-30', lines: line })).status).toBe(400)
    expect(await db.purchaseInvoice.count({ where: { companyId: t.company.id } })).toBe(n)
  })

  test('editing an invoice or a bill stores the new date as its IST day', async () => {
    const { t, customer, supplier, line } = await seedBooks()
    const inv = await must(createSalesInvoice, '/api/sales-invoices', t.user, { companyId: t.company.id, customerId: customer.id, date: '2026-05-16', lines: line })
    const e1 = await call(patchSalesInvoice(apiRequest(`/api/sales-invoices/${inv.id}`, { method: 'PATCH', user: t.user, body: { companyId: t.company.id, action: 'edit', customerId: customer.id, date: '2026-05-17T19:30:00.000Z', lines: line } }), ctx({ id: inv.id })))
    expect([e1.status, e1.json.error?.message]).toEqual([200, undefined])
    expect((await db.salesInvoice.findUniqueOrThrow({ where: { id: inv.id } })).date.toISOString()).toBe('2026-05-18T00:00:00.000Z')

    const bill = await must(createPurchaseInvoice, '/api/purchase-invoices', t.user, { companyId: t.company.id, supplierId: supplier.id, date: '2026-05-16', lines: line })
    const e2 = await call(patchPurchaseInvoice(apiRequest(`/api/purchase-invoices/${bill.id}`, { method: 'PATCH', user: t.user, body: { companyId: t.company.id, action: 'edit', supplierId: supplier.id, date: '2026-05-19', lines: line } }), ctx({ id: bill.id })))
    expect([e2.status, e2.json.error?.message]).toEqual([200, undefined])
    expect((await db.purchaseInvoice.findUniqueOrThrow({ where: { id: bill.id } })).date.toISOString()).toBe('2026-05-19T00:00:00.000Z')
  })
})

// ============================== CB-R4: daybook cheque dates ==============================

describe('CB-R4: daybook shows post-dated cheque money on its clearing date', () => {
  async function pdcCleared() {
    const b = await seedBooks()
    setSystemTime(new Date('2026-05-12T06:00:00Z'))
    const inv = await must(createSalesInvoice, '/api/sales-invoices', b.t.user, { companyId: b.t.company.id, customerId: b.customer.id, date: '2026-05-12', lines: b.line })
    const pay = await must(createPayment, '/api/payments', b.t.user, { companyId: b.t.company.id, type: 'RECEIPT', customerId: b.customer.id, invoiceType: 'SALES', invoiceId: inv.id, amount: 800, mode: 'CHEQUE', accountId: b.bank, chequeNo: '4455', chequeDate: '2026-05-20', date: '2026-05-12' })
    setSystemTime(new Date('2026-05-22T06:00:00Z'))
    await call(chequeAction(apiRequest(`/api/payments/${pay.id}`, { method: 'PATCH', user: b.t.user, body: { companyId: b.t.company.id, action: 'clear', date: '2026-05-21' } }), ctx({ id: pay.id })))
    return { ...b, pay }
  }

  test('payment day: settlement row with no money; clearing day: a Cheque Cleared row with the money', async () => {
    const { t, pay } = await pdcCleared()
    const a = await listTransactions(t.company.id, new Date('2026-05-12'), endOfDayStr('2026-05-12'))
    const settle = a.find((r) => r.id === `pay-${pay.id}`)!
    expect([settle.type, settle.moneyIn, settle.amount]).toEqual(['PAYMENT_IN', 0, 800])
    expect(settle.description).toContain('cheque cleared 2026-05-21')
    expect(a.some((r) => r.type === 'CHEQUE_CLEARED')).toBe(false)

    const b = await listTransactions(t.company.id, new Date('2026-05-21'), endOfDayStr('2026-05-21'))
    expect(b.map((r) => [r.type, r.number, r.moneyIn, r.party])).toEqual([['CHEQUE_CLEARED', pay.number, 800, 'Asha Traders']])
  })

  test('daybook money totals equal the cash-flow movement for any period (and the history agrees)', async () => {
    const { t } = await pdcCleared()
    for (const [from, to] of [['2026-05-01', '2026-05-31'], ['2026-05-12', '2026-05-20'], ['2026-05-21', '2026-05-21'], ['2026-04-01', '2026-05-11']]) {
      const r = await call(daybook(apiRequest(`/api/reports/daybook?companyId=${t.company.id}&from=${from}&to=${to}`, { user: t.user })))
      const cf = await cashFlow(t.company.id, new Date(from), endOfDayStr(to))
      const opened = cf.inflows.find((x) => x.key === 'accOpening')?.amount ?? 0 // opening balances are not daybook documents
      expect([from, r.json.data.totals.net]).toEqual([from, Math.round((cf.closing - cf.opening - opened) * 100) / 100])
      const h = await histData(t, { from, to })
      expect([from, Math.round((h.totals.moneyIn - h.totals.moneyOut) * 100) / 100]).toEqual([from, Math.round((cf.closing - cf.opening) * 100) / 100])
    }
  })

  test('the transactions report lists and filters the Cheque Cleared type', async () => {
    const { t } = await pdcCleared()
    const r = await call(txnReport(apiRequest(`/api/reports/transactions?companyId=${t.company.id}&from=2026-05-01&to=2026-05-31&type=CHEQUE_CLEARED`, { user: t.user })))
    expect(r.json.data.items.map((x: { type: string; moneyIn: number }) => [x.type, x.moneyIn])).toEqual([['CHEQUE_CLEARED', 800]])
    expect(r.json.data.types.some((x: { value: string; label: string }) => x.value === 'CHEQUE_CLEARED' && x.label === 'Cheque Cleared')).toBe(true)
  })
})
