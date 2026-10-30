import type { Page, Route } from '@playwright/test'
import { ADMIN_EMAIL, ADMIN_PASSWORD, COMPANY_ID, SECOND_COMPANY_ID, createStore, type Store } from './store'

/**
 * A stateful, in-browser fake of the ManuFlow ERP API.
 *
 * Every `/api/**` request the UI makes is answered here from an in-memory store, so the whole
 * single-page app can be driven without MySQL or the Prisma engine. Endpoints that the UI reads
 * on boot or on a specific screen return the same shapes as the real route handlers; anything else
 * falls back to the standard list envelope, so a screen that has no seed data still renders.
 *
 * The fake is intentionally faithful about *behaviour* (auth, validation, errors, paging, writes)
 * because the E2E suite asserts on those.
 */

interface Json {
  [key: string]: unknown
}

const ok = (data: unknown, status = 200) => ({ status, body: { success: true, data } })
const fail = (message: string, code = 'BAD_REQUEST', status = 400) => ({
  status,
  body: { success: false, error: { code, message } },
})

type Reply = {
  status: number
  body: Json
  /** Raw (file) response instead of the JSON envelope — used by the download endpoints. */
  file?: { body: string; contentType: string; filename: string; headers?: Record<string, string> }
}

const iso = (d = new Date()) => d.toISOString()
const today = () => iso().slice(0, 10)

const heads = (n = 0) => ({ cgst: n, sgst: n, igst: 0, cess: 0 })

function dashboard(store: Store) {
  const sales = store.collections['sales-invoices'] as Json[]
  const purchases = store.collections['purchase-invoices'] as Json[]
  const sum = (rows: Json[], key: string) => rows.reduce((t, r) => t + Number(r[key] || 0), 0)
  const openSalesOrders = (store.collections['sales-orders'] as Json[]).filter((r) => r.status !== 'CANCELLED')
  return {
    kpis: {
      salesThisMonth: sum(sales, 'grandTotal'),
      purchasesThisMonth: sum(purchases, 'grandTotal'),
      receivables: 47200 + 15000,
      payables: 21240 + 8024,
      stockValue: 512340,
      openOrders: openSalesOrders.length,
      openSalesOrders: openSalesOrders.length,
      wipQty: 60,
      lowStockCount: 2,
    },
    money: { youWillReceive: 62200, youWillPay: 29264, cashInHand: 42350, bankBalance: 318400 },
    charts: {
      salesTrend: [
        { month: 'May', key: '2026-05', value: 198000 },
        { month: 'Jun', key: '2026-06', value: 244500 },
        { month: 'Jul', key: '2026-07', value: 210300 },
        { month: 'Aug', key: '2026-08', value: 289900 },
        { month: 'Sep', key: '2026-09', value: 331200 },
        { month: 'Oct', key: '2026-10', value: 156800 },
      ],
      productionTrend: [
        { month: 'Aug', key: '2026-08', value: 210, qty: 210 },
        { month: 'Sep', key: '2026-09', value: 260, qty: 260 },
        { month: 'Oct', key: '2026-10', value: 120, qty: 120 },
      ],
    },
    lists: {
      recentSalesOrders: openSalesOrders.slice(0, 3),
      pendingApprovals: [
        { id: 'po_2', type: 'PO', number: 'PO/26-27/0002', date: '2026-09-20', grandTotal: 21240, amount: 21240 },
        { id: 'pr_1', type: 'PR', number: 'PR/26-27/0001', date: '2026-09-02', amount: 0 },
      ],
      lowStock: [
        { id: 'itm_5', item: { code: 'FG-FLG', name: 'Flange Coupling FC-90', uom: 'NOS' }, onHand: 12, qty: 12, reorderLevel: 15 },
        { id: 'itm_3', item: { code: 'RM-OIL', name: 'Cutting Oil 5L', uom: 'LTR' }, onHand: 22, qty: 22, reorderLevel: 40 },
      ],
      notifications: (store.collections.notifications as Json[]).slice(0, 3),
    },
  }
}

function profitLoss() {
  const zero = { total: 0, byCategory: [] as Json[] }
  return {
    sales: { gross: 82600, returns: 2950, net: 79650 },
    purchases: { gross: 56400, returns: 1416, net: 54984 },
    directExpenses: { total: 4200, byCategory: [{ category: 'FREIGHT', label: 'Freight', amount: 4200 }] },
    openingStock: 480000, closingStock: 512340, stockLoss: 0, cogs: 471460, grossProfit: -396794,
    indirectExpenses: { total: 18400, byCategory: [{ category: 'POWER', label: 'Power & fuel', amount: 18400 }] },
    loanInterest: 27000, processingFees: 5000, otherIncome: 0, roundOff: 0, netProfit: -447194,
    from: '', to: '',
    ...zero,
  }
}

function balanceSheet() {
  const line = (label: string, amount: number) => ({ label, amount, key: label.toLowerCase() })
  return {
    assets: [line('Cash in Hand', 42350), line('HDFC Current', 318400), line('Stock', 512340), line('Receivables', 62200)],
    liabilities: [line('Payables', 29264), line('Term Loan', 414000)],
    equity: [line('Capital', 400000), line('Retained earnings', -457974)],
    totalAssets: 935290, totalLiabilities: 443264, totalEquity: -57974, totalLiabilitiesAndEquity: 385290,
    netProfitToDate: -447194, asOf: today(),
  }
}

function cashFlow() {
  const inflow = (label: string, amount: number) => ({ label, amount, category: label, key: label.toLowerCase() })
  return {
    opening: 265000, closing: 360750, totalIn: 411516, totalOut: 315766, netChange: 95750, computedClosing: 360750, difference: 0,
    inflows: [inflow('Receipts from customers', 49500), inflow('Bank transfers in', 10000)],
    outflows: [outflow('Payments to suppliers', 36816), outflow('Expenses', 18400)],
    byAccount: [
      { id: 'acc_cash', name: 'Cash in Hand', type: 'CASH', opening: 15000, closing: 42350 },
      { id: 'acc_bank', name: 'HDFC Current', type: 'BANK', opening: 250000, closing: 318400 },
    ],
    from: '', to: '',
  }
  function outflow(label: string, amount: number) {
    return { label, amount, category: label, key: label.toLowerCase() }
  }
}

function trialBalance() {
  const lines = [
    { key: 'cash', label: 'Cash in Hand', debit: 42350, credit: 0, group: 'Assets' },
    { key: 'bank', label: 'HDFC Current', debit: 318400, credit: 0, group: 'Assets' },
    { key: 'sales', label: 'Sales', debit: 0, credit: 82600, group: 'Revenue' },
  ]
  return { lines, totalDebit: 360750, totalCredit: 82600, difference: 278150, asOf: today() }
}

const txnRows = [
  { id: 'day_1', date: '2026-10-01', type: 'SALES_INVOICE', typeLabel: 'Sales invoice', number: 'INV/26-27/0002', party: 'Deccan Auto Systems', amount: 47200, moneyIn: 47200, moneyOut: 0, account: 'HDFC Current' },
  { id: 'day_2', date: '2026-10-01', type: 'PRODUCTION_ENTRY', typeLabel: 'Production', number: 'PRD/26-27/0001', party: '—', amount: 0, moneyIn: 0, moneyOut: 0, account: '' },
  { id: 'day_3', date: '2026-10-02', type: 'EXPENSE', typeLabel: 'Expense', number: 'EXP/26-27/0002', party: 'VRL Logistics', amount: 4200, moneyIn: 0, moneyOut: 4200, account: 'Cash in Hand' },
]

function daybook() {
  return { items: txnRows, totals: { count: txnRows.length, moneyIn: 47200, moneyOut: 4200, net: 43000 }, from: '', to: '' }
}

function transactions() {
  return {
    items: txnRows,
    totals: { count: txnRows.length, amount: 51400, moneyIn: 47200, moneyOut: 4200 },
    byType: [
      { type: 'SALES_INVOICE', label: 'Sales invoice', count: 1, amount: 47200, moneyIn: 47200, moneyOut: 0 },
      { type: 'EXPENSE', label: 'Expense', count: 1, amount: 4200, moneyIn: 0, moneyOut: 4200 },
    ],
    parties: [
      { id: 'cus_2', name: 'Deccan Auto Systems' },
      { id: 'sup_1', name: 'Bharat Steel Depot' },
    ],
    types: [
      { value: 'SALES_INVOICE', label: 'Sales invoice' },
      { value: 'EXPENSE', label: 'Expense' },
    ],
    from: '', to: '',
  }
}

function salesByCustomer() {
  return {
    items: [
      { id: 'cus_1', name: 'Precision Tools Pvt Ltd', invoices: 1, base: 25000, tax: 4500, grand: 29500, received: 29500, outstanding: 0 },
      { id: 'cus_2', name: 'Deccan Auto Systems', invoices: 1, base: 42000, tax: 7200, grand: 49200, received: 20000, outstanding: 29200 },
    ],
    totals: { invoices: 2, base: 67000, tax: 11700, grand: 78700, received: 49500, outstanding: 29200 },
    from: '', to: '',
  }
}

function stockValuation() {
  return {
    items: [
      { id: 'itm_1', code: 'RM-EN8', name: 'EN8 Round Bar 40mm', uom: 'KG', qty: 480, rate: 78, value: 37440, reorderLevel: 250, type: 'RAW', warehouse: 'Main store', low: false },
      { id: 'itm_5', code: 'FG-FLG', name: 'Flange Coupling FC-90', uom: 'NOS', qty: 12, rate: 410, value: 4920, reorderLevel: 15, type: 'FINISHED', warehouse: 'Finished goods store', low: true },
    ],
    totals: { skus: 2, value: 42360, lowStock: 1, totalQty: 492 },
    byType: [{ type: 'RAW', value: 37440 }, { type: 'FINISHED', value: 4920 }],
  }
}

function profitability() {
  return {
    items: [
      { id: 'itm_4', code: 'FG-SFT', name: 'Shaft Assembly SF-220', qty: 40, revenue: 50000, cost: 25600, margin: 24400, marginPct: 48.8 },
      { id: 'itm_5', code: 'FG-FLG', name: 'Flange Coupling FC-90', qty: 12, revenue: 9360, cost: 4920, margin: 4440, marginPct: 47.4 },
    ],
    totals: { revenue: 59360, cost: 30520, margin: 28840, marginPct: 48.6 },
    from: '', to: '',
  }
}

function itemDetail() {
  return {
    item: { id: 'itm_4', code: 'FG-SFT', name: 'Shaft Assembly SF-220', uom: 'NOS', type: 'FINISHED', hsn: '8483' },
    from: '', to: '', openingQty: 45, openingValue: 28800,
    items: [
      { id: 'id_1', date: '2026-10-01', type: 'PRODUCTION', refType: 'PRODUCTION_ENTRY', refNumber: 'PRD/26-27/0001', warehouse: 'Finished goods store', qtyIn: 40, qtyOut: 0, runningQty: 85, rate: 640, notes: null },
    ],
    totals: { in: 40, out: 0 }, closingQty: 85, avgRate: 640, closingValue: 54400,
    sales: { qty: 40, value: 50000 }, salesReturns: { qty: 0, value: 0 },
    purchases: { qty: 0, value: 0 }, purchaseReturns: { qty: 0, value: 0 },
  }
}

function gstr2(store: Store) {
  const bills = (store.collections['purchase-invoices'] as Json[]).filter((b) => b.status === 'POSTED')
  const items = bills.map((b) => ({
    id: b.id, number: b.number, supplierInvNo: b.supplierInvNo, date: b.date,
    supplierName: (b.supplier as Json)?.name ?? '', gstin: (b.supplier as Json)?.gstin ?? null,
    isInterState: !!b.isInterState, taxable: Number(b.subtotal) - Number(b.discountTotal || 0),
    cgst: b.cgst, sgst: b.sgst, igst: b.igst, cess: b.cess ?? 0,
    totalTax: Number(b.cgst) + Number(b.sgst) + Number(b.igst) + Number(b.cess ?? 0),
    grandTotal: b.grandTotal, itcEligible: b.itcEligible !== false,
  }))
  const tot = items.reduce((t, r) => ({
    bills: t.bills + 1, taxable: t.taxable + r.taxable, cgst: t.cgst + r.cgst, sgst: t.sgst + r.sgst,
    igst: t.igst + r.igst, cess: t.cess + r.cess, grandTotal: t.grandTotal + Number(r.grandTotal),
    itcEligibleTax: t.itcEligibleTax + (r.itcEligible ? r.totalTax : 0),
    itcIneligibleTax: t.itcIneligibleTax + (r.itcEligible ? 0 : r.totalTax),
  }), { bills: 0, taxable: 0, cgst: 0, sgst: 0, igst: 0, cess: 0, grandTotal: 0, itcEligibleTax: 0, itcIneligibleTax: 0 })
  return {
    items,
    debitNotes: [],
    bySupplier: items.map((r) => ({
      key: r.gstin ?? r.supplierName, gstin: r.gstin, name: r.supplierName, bills: 1,
      taxable: r.taxable, cgst: r.cgst, sgst: r.sgst, igst: r.igst, cess: r.cess, total: r.grandTotal, itcEligible: r.itcEligible,
    })),
    totals: { ...tot, debitNotes: 0, debitNoteTax: 0 },
  }
}

function gstr3b() {
  const outwardHeads = { taxable: 67000, cgst: 5850, sgst: 5850, igst: 7200, cess: 0 }
  const itcHeads = { taxable: 49600, cgst: 2808, sgst: 2808, igst: 0, cess: 0 }
  const expHeads = { taxable: 4200, cgst: 378, sgst: 378, igst: 0, cess: 0 }
  return {
    outward: { taxable: 67000, salesTaxable: 67000, returnsTaxable: 0, invoices: 2, creditNotes: 0, tax: outwardHeads, totalTax: 18900 },
    itc: {
      bills: itcHeads, expenses: expHeads,
      total: { taxable: 53800, cgst: 3186, sgst: 3186, igst: 0, cess: 0 },
      totalTax: 6372,
      ineligible: heads(0), ineligibleTotal: 0,
    },
    net: { taxable: 13200, cgst: 2664, sgst: 2664, igst: 7200, cess: 0 },
    payable: { taxable: 0, cgst: 2664, sgst: 2664, igst: 7200, cess: 0 },
    credit: heads(0),
    totalPayable: 12528, totalCredit: 0, netTotal: 12528,
  }
}

function gstr9() {
  const row = (taxable: number) => ({ taxable, cgst: 0, sgst: 0, igst: 0, cess: 0, total: taxable })
  const zero = row(0)
  return {
    fy: 2026, fyLabel: '2026-27', from: '2026-04-01', to: '2027-03-31',
    company: { name: 'Nashilk Precision Works', gstin: '27ABCDE1234F1Z5' },
    table4: { b2b: row(67000), b2c: row(0), creditNotesB2b: zero, creditNotesB2c: zero, net: row(67000), totalTax: 18900 },
    table6: { bills: heads(6372), expenses: heads(0), total: heads(6372), totalTax: 6372, ineligible: heads(0), ineligibleTotal: 0 },
    table9: {
      heads: {
        taxable: { payable: 0, itc: 0, cash: 0, credit: 0 },
        cgst: { payable: 2664, itc: 3186, cash: 0, credit: 0 },
        sgst: { payable: 2664, itc: 3186, cash: 0, credit: 0 },
        igst: { payable: 7200, itc: 0, cash: 7200, credit: 0 },
        cess: { payable: 0, itc: 0, cash: 0, credit: 0 },
      },
      totalPayable: 12528, totalItc: 6372, totalCash: 7200, totalCredit: 0,
    },
    table17: { rows: [{ hsn: '8483', description: 'Shaft assembly', uqc: 'NOS', qty: 40, taxable: 50000, cgst: 4500, sgst: 4500, igst: 0, cess: 0, totalTax: 9000 }], totals: { qty: 40, taxable: 50000, totalTax: 9000 } },
  }
}

function gstr1Json(store: Store) {
  const rows = (store.collections['sales-invoices'] as Json[]).filter((r) => r.status === 'POSTED')
  return {
    json: {
      gstin: '27ABCDE1234F1Z5',
      fp: '102026',
      b2b: rows.map((r) => ({ ctin: (r.customer as Json)?.gstin, inv: [{ inum: r.number, idt: '03-09-2026', val: r.grandTotal, itms: [] }] })),
      b2cs: [{ sply_ty: 'INTRA', rt: 18, txval: 25000, camt: 2250, samt: 2250 }],
      hsn: { data: [{ hsn_sc: '8483', uqc: 'NOS', qty: 40, txval: 50000, camt: 4500, samt: 4500 }] },
    },
    summary: { invoices: rows.length, b2bInvoices: rows.length, b2clInvoices: 0, b2csRows: 1, creditNotes: 0, hsnRows: 1, missingGstin: false },
  }
}

function customerStatement(id: string) {
  const name = id === 'cus_2' ? 'Deccan Auto Systems' : 'Precision Tools Pvt Ltd'
  const rows = [
    { date: '2026-09-03', type: 'INVOICE', ref: 'INV/26-27/0001', particulars: 'Tax invoice', debit: 29500, credit: 0, balance: 29500 },
    { date: '2026-09-04', type: 'PAYMENT', ref: 'RCPT/26-27/0001', particulars: 'Payment received (BANK)', debit: 0, credit: 29500, balance: 0 },
  ]
  return {
    customer: { id, name, code: id === 'cus_2' ? 'CUST-0002' : 'CUST-0001', gstin: '27AABCP1234C1ZU', phone: '9890011223' },
    period: { from: '2026-04-01', to: today() },
    openingBalance: 0,
    rows,
    totals: { debits: 29500, credits: 29500, closing: 0 },
  }
}

function supplierStatement(id: string) {
  return {
    supplier: { id, name: 'Bharat Steel Depot', code: 'SUPP-0001', gstin: '27AABCB1111D1ZR', phone: '9870011223' },
    period: { from: '2026-04-01', to: today() },
    openingBalance: 0,
    rows: [
      { date: '2026-09-05', type: 'INVOICE', ref: 'BILL/26-27/0001', particulars: 'Purchase bill', debit: 0, credit: 36816, balance: 36816 },
      { date: '2026-09-06', type: 'PAYMENT', ref: 'PMT/26-27/0001', particulars: 'Payment made (BANK)', debit: 36816, credit: 0, balance: 0 },
    ],
    totals: { debits: 36816, credits: 36816, closing: 0 },
  }
}

function cashBankHistory(store: Store) {
  const rows = [
    { id: 'cb_1', date: '2026-09-04', type: 'PAYMENT_IN', typeLabel: 'Payment In', number: 'RCPT/26-27/0001', party: 'Precision Tools Pvt Ltd', description: 'NEFT-8891', accountId: 'acc_bank', accountName: 'HDFC Current', moneyIn: 29500, moneyOut: 0, balance: 318400 },
    { id: 'cb_2', date: '2026-09-06', type: 'PAYMENT_OUT', typeLabel: 'Payment Out', number: 'PMT/26-27/0001', party: 'Bharat Steel Depot', description: 'RTGS-2210', accountId: 'acc_bank', accountName: 'HDFC Current', moneyIn: 0, moneyOut: 36816, balance: 281584 },
    { id: 'cb_3', date: '2026-09-07', type: 'EXPENSE', typeLabel: 'Expense', number: 'EXP/26-27/0001', party: 'MSEDCL', description: 'MSEB electricity bill', accountId: 'acc_bank', accountName: 'HDFC Current', moneyIn: 0, moneyOut: 18400, balance: 263184 },
  ]
  return {
    items: rows,
    totals: { count: rows.length, moneyIn: 29500, moneyOut: 55216 },
    opening: 265000,
    closing: 318400,
    filtered: false,
    pendingCheques: { count: 1, toReceive: 12000, toPay: 0 },
    parties: [{ id: 'cus_1', name: 'Precision Tools Pvt Ltd' }, { id: 'sup_1', name: 'Bharat Steel Depot' }],
    types: [
      { value: 'PAYMENT_IN', label: 'Payment In' },
      { value: 'PAYMENT_OUT', label: 'Payment Out' },
      { value: 'EXPENSE', label: 'Expense' },
    ],
    accounts: store.collections.accounts,
  }
}

function accountStatement(id: string) {
  const account = (cashBankHistory({ collections: { accounts: [] } } as unknown as Store).accounts as Json[])[0]
  return {
    account: account ?? { id, type: 'BANK', name: 'HDFC Current', openingBalance: 250000, openingDate: '2026-04-01', printOnInvoice: true, isDefault: false, active: true, balance: 318400 },
    opening: 250000,
    closing: 318400,
    totalIn: 29500,
    totalOut: 55216,
    rows: [
      { id: 'st_1', kind: 'opening', date: '2026-04-01', type: 'OPENING', ref: '—', party: '—', in: 250000, out: 0, balance: 250000 },
      { id: 'st_2', kind: 'payment', date: '2026-09-04', type: 'PAYMENT_IN', ref: 'RCPT/26-27/0001', party: 'Precision Tools Pvt Ltd', in: 29500, out: 0, balance: 279500 },
      { id: 'st_3', kind: 'payment', date: '2026-09-06', type: 'PAYMENT_OUT', ref: 'PMT/26-27/0001', party: 'Bharat Steel Depot', in: 0, out: 36816, balance: 242684 },
    ],
  }
}

const IMPORT_PREVIEW = {
  jobId: 'job_1',
  fileName: 'customers-sep.csv',
  kind: 'CUSTOMERS',
  headers: ['Name', 'Phone', 'GSTIN', 'City'],
  detected: { name: 'Name', phone: 'Phone', gstin: 'GSTIN', city: 'City' },
  mapping: { name: 'name', phone: 'phone', gstin: 'gstin', city: 'city' },
  rows: [
    { row: 2, values: { name: 'Kothrud Engineering', phone: '9822000111', gstin: '27AAKCE1111A1Z5', city: 'Pune' }, action: 'CREATE', valid: true },
    { row: 3, values: { name: 'Hadapsar Fabricators', phone: '9822000222', gstin: '', city: 'Pune' }, action: 'CREATE', valid: true },
    { row: 4, values: { name: '', phone: '9822000333', gstin: '', city: 'Pune' }, action: 'SKIP', valid: false, error: 'Name is required' },
  ],
  summary: { total: 3, create: 2, update: 0, skip: 1, invalid: 1 },
  canCommit: true,
}

/**
 * Route table. Returns a reply for a request, or `null` when the path is not an API call
 * this fake knows about (the caller then answers with the generic envelope).
 */
export function makeApi(store: Store) {
  const col = (name: string) => (store.collections[name] ||= [])

  function dispatch(method: string, path: string, query: URLSearchParams, body: any): Reply | null {
    const seg = path.replace(/^\/api\/?/, '').split('/').filter(Boolean)
    const [head, second, third] = seg

    // ---------------- auth ----------------
    if (head === 'auth') {
      if (second === 'login' && method === 'POST') {
        const email = String(body?.email || '').trim().toLowerCase()
        const password = String(body?.password || '')
        const user = (col('users') as Json[]).find((u) => String(u.email).toLowerCase() === email)
        if (!user || password !== ADMIN_PASSWORD) return fail('Invalid email or password', 'UNAUTHORIZED', 401)
        if (user.active === false) return fail('Account is inactive', 'FORBIDDEN', 403)
        const company = (col('companies') as Json[]).find((c) => c.id === user.companyId) ?? col('companies')[0]
        const { passwordHash: _ph, ...safeUser } = user
        store.session = { user: safeUser, company }
        return ok(store.session)
      }
      if (second === 'logout') {
        store.session = null
        return ok({ ok: true })
      }
      if (second === 'me') {
        if (!store.session) return fail('Sign in to continue', 'UNAUTHORIZED', 401)
        return ok(store.session)
      }
      if (second === 'change-password' && method === 'POST') {
        if (!store.session) return fail('Sign in to continue', 'UNAUTHORIZED', 401)
        if (body?.currentPassword !== ADMIN_PASSWORD) return fail('Current password is incorrect', 'BAD_REQUEST', 400)
        if (!body?.newPassword || String(body.newPassword).length < 8) return fail('New password must be at least 8 characters', 'BAD_REQUEST', 400)
        return ok({ ok: true })
      }
    }

    // Public endpoints used before a session exists.
    if (head === 'platform' && second === 'orgs') return ok({ items: [], total: 0 })
    if (head === 'platform' && second === 'plans') return ok({ items: [{ id: 'plan_1', name: 'Growth', priceMonthly: 1499, maxUsers: 10 }], total: 1 })

    // Everything else needs a session — mirrors middleware.ts.
    if (!store.session && head !== 'auth') return fail('Sign in to continue', 'UNAUTHORIZED', 401)

    // ---------------- singleton screens ----------------
    if (head === 'companies' && !second) return ok({ companies: col('companies') })
    if (head === 'settings' && !second) return ok(col('companies')[0])
    if (head === 'numbering' && !second) return ok({ seqs: col('numbering'), prefixes: [] })
    if (head === 'dashboard') return ok(dashboard(store))
    if (head === 'search') {
      const q = String(query.get('q') || '').toLowerCase()
      const results: Json[] = []
      if (q) {
        const pool: [string, string, string][] = [
          ['customers', 'CUSTOMER', 'name'],
          ['suppliers', 'SUPPLIER', 'name'],
          ['items', 'ITEM', 'name'],
          ['sales-invoices', 'SALES_INVOICE', 'number'],
        ]
        for (const [coll, type, field] of pool) {
          for (const row of col(coll) as Json[]) {
            if (String(row[field] || '').toLowerCase().includes(q)) {
              results.push({ id: row.id, type, label: String(row[field]), sub: String(row.code ?? row.gstin ?? ''), module: coll === 'items' ? 'items' : coll })
            }
          }
        }
      }
      return ok({ results })
    }
    if (head === 'notifications') {
      const items = col('notifications') as Json[]
      if (method === 'PATCH' && !second) {
        // The shell's "Mark all read" calls PATCH /api/notifications { all: true }.
        for (const n of items) n.read = true
        return ok({ updated: items.length })
      }
      if (method === 'PATCH' && second) {
        const row = items.find((n) => n.id === second)
        if (row) row.read = true
        return ok(row ?? { ok: true })
      }
      const unread = items.filter((n) => !n.read)
      const onlyUnread = query.get('unread') === '1'
      return ok({ items: onlyUnread ? unread : items, unreadCount: unread.length })
    }
    if (head === 'mrp') {
      return ok({
        items: [
          { id: 'itm_4', code: 'FG-SFT', name: 'Shaft Assembly SF-220', uom: 'NOS', demandQty: 60, onHand: 85, shortfall: 0, plannedQty: 0 },
          { id: 'itm_5', code: 'FG-FLG', name: 'Flange Coupling FC-90', uom: 'NOS', demandQty: 50, onHand: 12, shortfall: 38, plannedQty: 50 },
        ],
      })
    }
    if (head === 'parties' && second === 'last-rates') return ok({ rates: {} })
    if (head === 'batches') return ok({ items: col('batches') })
    if (head === 'serials') return ok({ items: col('serials') })

    // ---------------- cash & bank ----------------
    if (head === 'cash-bank' && second === 'transactions') return ok(cashBankHistory(store))
    if (head === 'accounts' && second && third === 'statement') return ok(accountStatement(second))
    if (head === 'customers' && second && third === 'statement') return ok(customerStatement(second))
    if (head === 'suppliers' && second && third === 'statement') return ok(supplierStatement(second))

    // ---------------- reports ----------------
    if (head === 'reports') {
      switch (second) {
        case 'gstr2': return ok(gstr2(store))
        case 'gstr3b': return ok(gstr3b())
        case 'gstr9': return ok(gstr9())
        case 'gstr1-json': return ok(gstr1Json(store))
        case 'profit-loss': return ok(profitLoss())
        case 'balance-sheet': return ok(balanceSheet())
        case 'cash-flow': return ok(cashFlow())
        case 'trial-balance': return ok(trialBalance())
        case 'daybook': return ok(daybook())
        case 'transactions': return ok(transactions())
        case 'sales-by-customer': return ok(salesByCustomer())
        case 'purchase-by-supplier': return ok(salesByCustomer())
        case 'profitability': return ok(profitability())
        case 'stock-valuation': return ok(stockValuation())
        case 'item-detail': return ok(itemDetail())
        default: return ok({})
      }
    }

    // ---------------- import center ----------------
    if (head === 'import-center') {
      if (second === 'parse') {
        return ok({
          fileName: 'customers-sep.csv',
          format: 'csv',
          sheetNames: ['Sheet1'],
          sheet: 'Sheet1',
          table: [IMPORT_PREVIEW.headers, ['Kothrud Engineering', '9822000111', '27AAKCE1111A1Z5', 'Pune'], ['Hadapsar Fabricators', '9822000222', '', 'Pune']],
          headerRow: 0,
          suggestion: { kind: 'CUSTOMERS', mapping: IMPORT_PREVIEW.mapping, confidence: 0.94 },
        })
      }
      if (second === 'preview') return ok(IMPORT_PREVIEW)
      if (second === 'commit') return ok({ jobId: 'job_1', committed: 2, created: 2, updated: 0, skipped: 1, failed: 0 })
      if (second === 'history') return ok({ items: col('import-history'), total: col('import-history').length, page: 1 })
      if (second === 'go-live') return ok({ ok: true })
      if (second === 'tally') {
        if (third === 'status') return ok({ configured: true, reachable: true, endpoint: 'http://127.0.0.1:9000', checkedAt: iso(), version: 'Tally Prime 4.1' })
        if (third === 'jobs') return ok({ items: [] })
        if (third === 'connector') return ok({ paired: true, code: '8421', expiresAt: iso(new Date(Date.now() + 900000)) })
        if (third === 'import') return ok({ jobId: 'job_tally_1' })
      }
    }

    // All-Masters import for TallyPrime (Settings → Tally export / invoice menu)
    if (head === 'tally' && second === 'masters') {
      const company = (col('companies') as Json[])[0] || {}
      const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>` +
        `<BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>All Masters</REPORTNAME></REQUESTDESC><REQUESTDATA>` +
        `<TALLYMESSAGE><LEDGER NAME="Sales"><PARENT>Sales Accounts</PARENT></LEDGER></TALLYMESSAGE>` +
        `<TALLYMESSAGE><LEDGER NAME="Central Tax on Sales @ 9%"><PARENT>Duties &amp; Taxes</PARENT></LEDGER></TALLYMESSAGE>` +
        `</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`
      return {
        status: 200, body: {},
        file: { body: xml, contentType: 'application/xml', filename: `tally-masters-${String(company.name || 'company').toLowerCase().replace(/[^a-z0-9]+/g, '-')}.xml` },
      }
    }

    // ---------------- Tally / e-Invoice exports ----------------
    // Mirrors src/app/api/sales-invoices/[id]/{tally,einvoice}/route.ts.
    if (head === 'sales-invoices' && second && (third === 'tally' || third === 'einvoice')) {
      const invoice = (col('sales-invoices') as Json[]).find((r) => r.id === second)
      if (!invoice) return fail('Invoice not found', 'NOT_FOUND', 404)
      const customer = (col('customers') as Json[]).find((c) => c.id === invoice.customerId) as Json | undefined
      const number = String(invoice.number || 'INV')
      const safe = number.replace(/[\\/:*?"<>|]+/g, '-')
      const grandTotal = Number(invoice.grandTotal || 0)
      const items = (invoice.items as Json[] | undefined) ?? []
      const warnings = customer && !customer.gstin ? [`Customer "${customer.name}" has no GSTIN.`] : []

      if (third === 'tally') {
        if (method === 'POST' || method === 'PATCH') {
          const action = String(body?.action || 'mark-sent')
          invoice.tallySentAt = action === 'unmark' ? null : iso()
          return ok(invoice)
        }
        const voucher = {
          voucherType: 'Sales',
          voucherNumber: number,
          remoteId: `MANUFLOW-INV-${invoice.id}`,
          date: String(invoice.date || today()).replace(/-/g, ''),
          dateISO: String(invoice.date || today()),
          party: String(customer?.name || 'Customer'),
          partyGstin: String(customer?.gstin || ''),
          company: 'Nashilk Precision Works',
          entries: [
            { ledger: String(customer?.name || 'Customer'), amount: grandTotal, isParty: true, isDebit: true },
            { ledger: 'Sales', amount: Number(invoice.subtotal || 0), isParty: false, isDebit: false },
            { ledger: 'Central Tax on Sales @ 9%', amount: Number(invoice.cgst || 0), isParty: false, isDebit: false },
            { ledger: 'State Tax on Sales @ 9%', amount: Number(invoice.sgst || 0), isParty: false, isDebit: false },
          ].filter((e) => e.amount > 0),
          items,
          subtotal: Number(invoice.subtotal || 0),
          grandTotal,
          warnings,
        }
        if (query.get('preview') === '1') return ok({ voucher, ledgerNames: { sales: 'Sales' } })
        const format = (query.get('format') || 'xml').toLowerCase()
        if (format === 'json') {
          return { status: 200, body: {}, file: { body: JSON.stringify(voucher, null, 2), contentType: 'application/json', filename: `${safe}_tally.json` } }
        }
        if (format === 'excel') {
          return { status: 200, body: {}, file: { body: 'xlsx-bytes', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', filename: `${safe}_tally.xlsx` } }
        }
        const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<ENVELOPE>\n  <HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>\n  <BODY><IMPORTDATA><REQUESTDATA>\n` +
          `  <TALLYMESSAGE><VOUCHER REMOTEID="${voucher.remoteId}" VCHTYPE="Sales" ACTION="Create">\n` +
          `    <DATE>${voucher.date}</DATE><VOUCHERNUMBER>${number}</VOUCHERNUMBER>\n` +
          `    <PARTYLEDGERNAME>${voucher.party}</PARTYLEDGERNAME>\n` +
          `  </VOUCHER></TALLYMESSAGE>\n</REQUESTDATA></IMPORTDATA></BODY>\n</ENVELOPE>`
        return { status: 200, body: {}, file: { body: xml, contentType: 'application/xml', filename: `${safe}_tally.xml` } }
      }

      // e-Invoice (IRP bulk upload JSON, NIC schema v1.1)
      const problems: string[] = []
      if (!String(customer?.gstin || '').match(/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/)) problems.push('Buyer has an invalid GSTIN')
      if (String(number).length > 16) problems.push('Invoice number is longer than 16 characters')
      if (query.get('check') === '1') return ok({ ready: problems.length === 0, problems })
      const json = [{
        Version: '1.1',
        TranDtls: { TaxSch: 'GST', SupTyp: 'B2B', RegRev: invoice.reverseCharge ? 'Y' : 'N', IgstOnIntra: 'N' },
        DocDtls: { Typ: 'INV', No: number, Dt: String(invoice.date || today()).split('-').reverse().join('/') },
        SellerDtls: { Gstin: '27AABCN1234M1Z8', LglNm: 'Nashilk Precision Works', Stcd: '27' },
        BuyerDtls: { Gstin: String(customer?.gstin || ''), LglNm: String(customer?.name || ''), Pos: String(customer?.gstin || '').slice(0, 2) },
        ItemList: items.map((it, i) => ({ SlNo: String(i + 1), HsnCd: String(it.hsn || '84836090'), Qty: Number(it.qty || 0), Unit: 'NOS', UnitPrice: Number(it.rate || 0), AssAmt: Number(it.lineTotal || 0), GstRt: Number(it.gstRate || 18), TotItemVal: Number(it.lineTotal || 0) })),
        ValDtls: { AssVal: Number(invoice.subtotal || 0), CgstVal: Number(invoice.cgst || 0), SgstVal: Number(invoice.sgst || 0), IgstVal: Number(invoice.igst || 0), TotInvVal: grandTotal },
      }]
      return {
        status: 200, body: {},
        file: {
          body: JSON.stringify(json, null, 2), contentType: 'application/json', filename: `${safe}_einvoice.json`,
          headers: problems.length ? { 'x-einvoice-warnings': encodeURIComponent(JSON.stringify(problems)) } : undefined,
        },
      }
    }

    // ---------------- audit log ----------------
    if (head === 'audit-logs') {
      const page = Number(query.get('page') || 1)
      const pageSize = Number(query.get('pageSize') || 50)
      const items = col('audit-logs') as Json[]
      return ok({ items: items.slice((page - 1) * pageSize, page * pageSize), total: items.length, page, pageSize })
    }

    // ---------------- generic CRUD over collections ----------------
    const collection = head
    if (!collection) return null

    if (!second) {
      if (method === 'GET') {
        let items = col(collection) as Json[]
        const q = query.get('q')
        if (q) items = items.filter((r) => JSON.stringify(r).toLowerCase().includes(q.toLowerCase()))
        const page = Number(query.get('page') || 1)
        const pageSize = Number(query.get('pageSize') || 0)
        if (pageSize > 0) items = items.slice((page - 1) * pageSize, page * pageSize)
        return ok({ items, total: (col(collection) as Json[]).length, page, pageSize: pageSize || undefined })
      }
      if (method === 'POST') {
        const now = iso()
        const created = {
          id: store.nextId(collection.replace(/-/g, '_')),
          createdAt: now,
          updatedAt: now,
          ...body,
        }
        if (!created.status) created.status = 'DRAFT'
        if (!created.number) created.number = `${collection.slice(0, 3).toUpperCase()}/${now.slice(0, 4)}/${String(col(collection).length + 1).padStart(4, '0')}`
        if (!created.date) created.date = today()
        col(collection).unshift(created as Json)
        return ok(created, 201)
      }
    }

    if (second && !third) {
      const rows = col(collection) as Json[]
      const idx = rows.findIndex((r) => r.id === second)
      if (method === 'GET') {
        if (idx >= 0) return ok(rows[idx])
        return fail('Not found', 'NOT_FOUND', 404)
      }
      if (method === 'PATCH' || method === 'PUT') {
        if (idx < 0) return fail('Not found', 'NOT_FOUND', 404)
        rows[idx] = { ...rows[idx], ...body, updatedAt: iso() }
        return ok(rows[idx])
      }
      if (method === 'DELETE') {
        if (idx >= 0) rows.splice(idx, 1)
        return ok({ id: second })
      }
    }

    // Sub-resources (e.g. /api/loans/:id/emi) — answer success so the UI can move on.
    if (third) return ok({ ok: true })
    return null
  }

  async function handler(route: Route) {
    const req = route.request()
    const url = new URL(req.url())
    const path = url.pathname
    const method = req.method()

    let body: any = null
    const raw = req.postData()
    if (raw && (req.headers()['content-type'] || '').includes('json')) {
      try { body = JSON.parse(raw) } catch { body = null }
    } else if (raw) {
      body = { _raw: raw.slice(0, 200) }
    }

    let reply: Reply | null = null
    try {
      reply = dispatch(method, path, url.searchParams, body)
    } catch (e) {
      reply = fail(e instanceof Error ? e.message : 'Fake API crashed', 'FAKE_API_ERROR', 500)
    }

    // Generic envelope for anything not modelled: empty lists, successful writes.
    if (!reply) {
      reply = method === 'GET' ? ok({ items: [], total: 0 }) : ok({ id: store.nextId('gen'), ...(body || {}) })
    }

    if (reply.file) {
      await route.fulfill({
        status: reply.status,
        contentType: reply.file.contentType,
        headers: {
          'cache-control': 'no-store',
          'content-disposition': `attachment; filename="${reply.file.filename}"`,
          ...(reply.file.headers || {}),
        },
        body: reply.file.body,
      })
      return
    }

    await route.fulfill({
      status: reply.status,
      contentType: 'application/json',
      headers: { 'cache-control': 'no-store' },
      body: JSON.stringify(reply.body),
    })
  }

  return { handler, dispatch, store }
}

export interface MockApi {
  handler: (route: Route) => Promise<void>
  dispatch: (method: string, path: string, query: URLSearchParams, body: unknown) => Reply | null
  store: Store
}

/** Install the fake API on a page. Returns a handle so tests can inspect or override the store. */
export async function installMockApi(page: Page, store: Store = createStore()): Promise<MockApi> {
  const api = makeApi(store)
  await page.route('**/api/**', api.handler)
  return api as MockApi
}

/** Seed the client-side session so a test can start on the dashboard without filling the login form. */
export async function seedSession(page: Page, store: Store, opts: { email?: string; password?: string } = {}) {
  const email = opts.email ?? ADMIN_EMAIL
  const password = opts.password ?? ADMIN_PASSWORD
  const user = (store.collections.users as any[]).find((u) => u.email === email)
  const company = (store.collections.companies as any[]).find((c) => c.id === user?.companyId) ?? (store.collections.companies as any[])[0]
  if (!user) throw new Error(`No seeded user with email ${email}`)
  const { passwordHash: _ph, ...safeUser } = user
  store.session = { user: safeUser, company }
  await page.addInitScript(
    ([session, companyId]) => {
      window.localStorage.setItem('erp_user', JSON.stringify(session))
      window.localStorage.setItem('erp_company_id', companyId)
    },
    [{ user: safeUser, company }, company.id] as const,
  )
  return { user: safeUser, company, secondCompanyId: SECOND_COMPANY_ID, companyId: COMPANY_ID }
}
