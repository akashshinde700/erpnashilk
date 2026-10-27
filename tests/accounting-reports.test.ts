import { afterEach, beforeEach, describe, expect, setSystemTime, test } from 'bun:test'
import { db } from '@/lib/db'
import { balanceSheetFrom, cashFlow, endOfDayStr, positionAsOf, profitAndLoss, trialBalanceFrom } from '@/lib/accounting'
import { POST as createAccount } from '@/app/api/accounts/route'
import { POST as createTxn } from '@/app/api/account-txns/route'
import { POST as createPayment } from '@/app/api/payments/route'
import { POST as createExpense } from '@/app/api/expenses/route'
import { POST as createLoan } from '@/app/api/loans/route'
import { POST as payEmi } from '@/app/api/loans/[id]/emi/route'
import { POST as createSalesInvoice } from '@/app/api/sales-invoices/route'
import { POST as createPurchaseInvoice } from '@/app/api/purchase-invoices/route'
import { POST as createSalesReturn } from '@/app/api/sales-returns/route'
import { POST as createPurchaseReturn } from '@/app/api/purchase-returns/route'
import { apiRequest, call, ctx } from './helpers/api'
import { resetDb } from './helpers/db'
import { seedTenant } from './helpers/seed'

/**
 * Accounting report consistency (PROJECT_STATUS.md — Accounting audit, AC-11 / AC-12 / AC-13, AC-B1).
 *
 * A fresh company with NO opening balances, so every figure comes from documents and the balance-sheet
 * "Opening balance difference" plug must be exactly 0. Every amount below is hand-checked.
 *
 * AC-B1 (fixed): a sales return puts the goods back into stock at the ORIGINAL inventory cost of the sale (stored on
 * the sale's outward stock row), not the selling price. Detailed cases are in sales-return-cost.test.ts.
 */

const NOW = new Date('2026-06-01T06:00:00Z') // fixed "today" (IST 1 Jun 2026): dates and cheque status are deterministic
const AS_OF = '2026-05-31'

type Tenant = Awaited<ReturnType<typeof seedTenant>>

async function api(t: Tenant, handler: (r: Request) => Promise<Response>, path: string, body: Record<string, unknown>) {
  const r = await call(handler(apiRequest(path, { user: t.user, body: { companyId: t.company.id, ...body } })))
  expect([path, r.status, r.json.error?.message]).toEqual([path, 200, undefined])
  return r.json.data
}

async function baseCompany() {
  const t = await seedTenant()
  const c = t.company.id
  const [customer, supplier, item] = await Promise.all([
    db.customer.create({ data: { companyId: c, code: 'C-1', name: 'Test Customer' } }),
    db.supplier.create({ data: { companyId: c, code: 'S-1', name: 'Test Supplier' } }),
    db.item.create({ data: { companyId: c, code: 'FG-1', name: 'Test Part', uom: 'NOS' } }),
  ])
  return { t, customer, supplier, item }
}

/**
 * Every kind of document (all synthetic, test database only):
 *  capital 100000 cash · bill 10 × 100 + 18% GST (1180) received into stock, 500 paid in cash ·
 *  invoice A 5 × 200 + 18% (1180) from stock, fully received in cash · invoice B 2 × 200 + 18% (472) on credit ·
 *  rent 300 cash · loan 50000 (fee 1000) into bank · EMI 2000 principal + 500 interest from bank ·
 *  contra 1000 cash → bank · drawings 200 · sales return 1 unit of invoice B (credit note 236) ·
 *  purchase return 1 unit of the bill (debit note 118) · post-dated cheque 100 on invoice B (not cleared).
 */
async function fullScenario() {
  const { t, customer, supplier, item } = await baseCompany()
  const cash = (await api(t, createAccount, '/api/accounts', { type: 'CASH', name: 'Cash in Hand', isDefault: true })).id
  const bank = (await api(t, createAccount, '/api/accounts', { type: 'BANK', name: 'Main Bank', isDefault: true })).id
  const wh = t.warehouse.id
  await api(t, createTxn, '/api/account-txns', { type: 'ADJUST_IN', toAccountId: cash, amount: 100000, category: 'CAPITAL', date: '2026-05-01' })
  const bill = await api(t, createPurchaseInvoice, '/api/purchase-invoices', {
    supplierId: supplier.id, date: '2026-05-02', lines: [{ itemId: item.id, qty: 10, rate: 100, gstRate: 18 }],
    receiveStock: true, warehouseId: wh, paidNow: 500, paymentMode: 'CASH',
  })
  await api(t, createSalesInvoice, '/api/sales-invoices', {
    customerId: customer.id, date: '2026-05-03', lines: [{ itemId: item.id, qty: 5, rate: 200, discountPct: 0, gstRate: 18 }],
    deductStock: true, stockWarehouseId: wh, receivedAmount: 1180, receivedMode: 'CASH',
  })
  const invB = await api(t, createSalesInvoice, '/api/sales-invoices', {
    customerId: customer.id, date: '2026-05-04', lines: [{ itemId: item.id, qty: 2, rate: 200, discountPct: 0, gstRate: 18 }],
    deductStock: true, stockWarehouseId: wh,
  })
  await api(t, createExpense, '/api/expenses', { date: '2026-05-05', description: 'Rent', category: 'RENT', amount: 300, paymentMode: 'CASH' })
  const loan = await api(t, createLoan, '/api/loans', { name: 'Machine Loan', principal: 50000, processingFee: 1000, interestRate: 12, startDate: '2026-05-06', receivedAccountId: bank })
  const emi = await call(payEmi(apiRequest(`/api/loans/${loan.id}/emi`, { user: t.user, body: { companyId: t.company.id, date: '2026-05-07', principal: 2000, interest: 500, fromAccountId: bank } }), ctx({ id: loan.id })))
  expect(emi.status).toBe(200)
  await api(t, createTxn, '/api/account-txns', { type: 'CONTRA', fromAccountId: cash, toAccountId: bank, amount: 1000, date: '2026-05-08' })
  await api(t, createTxn, '/api/account-txns', { type: 'ADJUST_OUT', fromAccountId: cash, amount: 200, category: 'DRAWINGS', date: '2026-05-09' })
  const invBItem = await db.salesInvoiceItem.findFirstOrThrow({ where: { invoiceId: invB.id } })
  await api(t, createSalesReturn, '/api/sales-returns', { invoiceId: invB.id, date: '2026-05-10', lines: [{ invoiceItemId: invBItem.id, qty: 1 }] })
  await api(t, createPurchaseReturn, '/api/purchase-returns', { invoiceId: bill.id, date: '2026-05-10', warehouseId: wh, lines: [{ invoiceItemId: bill.items[0].id, qty: 1 }] })
  await api(t, createPayment, '/api/payments', {
    type: 'RECEIPT', customerId: customer.id, invoiceType: 'SALES', invoiceId: invB.id, amount: 100,
    mode: 'CHEQUE', accountId: bank, chequeNo: '000111', chequeDate: '2026-06-15', date: '2026-05-11',
  })
  return reports(t.company.id)
}

/** Minimal AC-B1 case: buy 10 at ₹100 (no GST), sell 2 at ₹200, the customer returns 1. */
async function returnScenario() {
  const { t, customer, supplier, item } = await baseCompany()
  const wh = t.warehouse.id
  await api(t, createPurchaseInvoice, '/api/purchase-invoices', {
    supplierId: supplier.id, date: '2026-05-02', lines: [{ itemId: item.id, qty: 10, rate: 100, gstRate: 0 }], receiveStock: true, warehouseId: wh,
  })
  const inv = await api(t, createSalesInvoice, '/api/sales-invoices', {
    customerId: customer.id, date: '2026-05-03', lines: [{ itemId: item.id, qty: 2, rate: 200, discountPct: 0, gstRate: 0 }], deductStock: true, stockWarehouseId: wh,
  })
  const invItem = await db.salesInvoiceItem.findFirstOrThrow({ where: { invoiceId: inv.id } })
  await api(t, createSalesReturn, '/api/sales-returns', { invoiceId: inv.id, date: '2026-05-04', lines: [{ invoiceItemId: invItem.id, qty: 1 }] })
  return reports(t.company.id)
}

async function reports(companyId: string) {
  const asOf = endOfDayStr(AS_OF)
  const pos = await positionAsOf(companyId, asOf)
  return {
    pos,
    bs: balanceSheetFrom(pos),
    tb: trialBalanceFrom(pos),
    pl: await profitAndLoss(companyId, new Date('2026-04-01'), asOf),
    cf: await cashFlow(companyId, new Date('2026-04-01'), asOf),
  }
}

beforeEach(async () => { setSystemTime(NOW); await resetDb() })
afterEach(() => { setSystemTime() })

describe('accounting reports agree with each other (no opening balances)', () => {
  test('balance-sheet plug is 0, trial balance and cash flow have no difference, P&L equals retained profit', async () => {
    const { bs, tb, pl, cf, pos } = await fullScenario()
    expect(bs.equity.find((e) => e.key === 'openingDiff')?.amount).toBe(0)
    expect(bs.totalAssets).toBe(bs.totalLiabilitiesAndEquity)
    expect([tb.difference, tb.totalDebit === tb.totalCredit]).toEqual([0, true])
    expect([cf.difference, cf.opening, cf.closing]).toEqual([0, 0, pos.cash + pos.bank])
    expect(pl.netProfit).toBe(pos.pl.netProfit)
  })

  test('hand-checked positions: cash, bank, receivable, payable, GST, loans, cheques in hand, capital, drawings', async () => {
    const { pos } = await fullScenario()
    expect({
      cash: pos.cash, // 100000 − 500 + 1180 − 300 − 1000 − 200
      bank: pos.bank, // 49000 (loan less fee) − 2500 (EMI) + 1000 (contra); the post-dated cheque is not in yet
      receivable: pos.receivable, // invoice B 472 − credit note 236 − cheque 100 (party settled)
      payable: pos.payable, // bill 1180 − 500 paid − debit note 118
      chequesInHand: pos.chequesInHand,
      gstNet: pos.gst.net, // output 180 + 72 − 36 = 216; input 180 − 18 = 162
      loans: pos.loans, // 50000 − 2000
      capital: pos.capital,
      drawings: pos.drawings,
    }).toEqual({ cash: 99180, bank: 47500, receivable: 136, payable: 562, chequesInHand: 100, gstNet: 54, loans: 48000, capital: 100000, drawings: 200 })
  })

  test('P&L lines: sales, purchases, expenses, loan interest and fee', async () => {
    const { pl } = await fullScenario()
    expect({ sales: pl.sales, purchases: pl.purchases, opening: pl.openingStock, indirect: pl.indirectExpenses.total, interest: pl.loanInterest, fees: pl.processingFees })
      .toEqual({ sales: { gross: 1400, returns: 200, net: 1200 }, purchases: { gross: 1000, returns: 100, net: 900 }, opening: 0, indirect: 300, interest: 500, fees: 1000 })
  })
})

describe('AC-B1 — sales return stock valuation', () => {
  // ---- Correct accounting: returned goods come back at the original sale cost (AC-B1 fixed) ----
  test('AC-B1: minimal case — returned goods come back at cost', async () => {
    const { pos, pl } = await returnScenario()
    // 9 units at ₹100 cost = ₹900; sold 1 net unit: COGS 100; sales net 200 → gross profit 100
    expect({ stock: pos.stock, closing: pl.closingStock, cogs: pl.cogs, gross: pl.grossProfit })
      .toEqual({ stock: 900, closing: 900, cogs: 100, gross: 100 })
  })

  test('AC-B1: full scenario — stock, COGS, gross and net profit at cost', async () => {
    const { pos, pl, bs } = await fullScenario()
    // 3 units at ₹100 = 300; COGS 0 + 900 − 300 = 600; gross 1200 − 600 = 600; net 600 − 300 − 500 − 1000 = −1200
    expect({ stock: pos.stock, closing: pl.closingStock, cogs: pl.cogs, gross: pl.grossProfit, net: pl.netProfit })
      .toEqual({ stock: 300, closing: 300, cogs: 600, gross: 600, net: -1200 })
    expect(bs.equity.find((e) => e.key === 'openingDiff')?.amount).toBe(0)
  })
})
