import { db } from '@/lib/db'
import { ApiError, r2 } from '@/lib/erp-helpers'
import { POSTED_EXPENSE, accountBalances, moneyPaymentWhere, type AccountBalance } from '@/lib/accounts'
import { istDay } from '@/lib/business-date'
import { partyCreditsAsOf } from '@/lib/party-credits'
import { GST_STATES } from '@/lib/erp-constants'
import { fxToInr, toInrAmount } from '@/lib/gst-reports'

/**
 * Shared accounting computations for the financial reports (P&L, Balance Sheet, Cash Flow,
 * Trial Balance, Daybook, GST returns) and the dashboard money cards.
 *
 * The ERP has no general ledger: every figure is derived from the source documents —
 *   sales invoices / returns, purchase bills / returns, payments, expenses, account txns
 *   (adjustments, contra, loans, EMIs), loans and the stock ledger.
 * Cash & bank balances always come from accountBalances() (src/lib/accounts.ts).
 */

// ============ dates ============

const NOT_CANCELLED = { not: 'CANCELLED' }
const NON_MONEY_MODES = ['CREDIT_NOTE', 'DEBIT_NOTE', 'ADVANCE_ADJ']
const LOSS_REASONS = ['DAMAGE', 'EXPIRY', 'THEFT']
/** "Beginning of data" for cumulative figures (retained profit). */
export const EARLY = new Date('2000-01-01T00:00:00.000Z')

export interface DateRange { gte: Date; lte: Date }
export interface Period { fromStr: string; toStr: string; from: Date; to: Date }

const isoDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** First day (YYYY-MM-DD) of the Indian financial year containing `d`. */
export function fyStartStr(d: Date = new Date()): string {
  const y = d.getMonth() + 1 >= 4 ? d.getFullYear() : d.getFullYear() - 1
  return `${y}-04-01`
}

/**
 * Indian financial year `fy` (= the calendar year it starts in): 1 Apr fy → 31 Mar fy+1 (end of day).
 * Default (fy omitted / blank): the FY containing today. Label like "2024-25".
 */
export function fyRange(fy?: string | number | null): Period & { fy: number; label: string } {
  const raw = fy === undefined || fy === null || fy === '' ? Number(fyStartStr().slice(0, 4)) : Number(fy)
  if (!Number.isInteger(raw) || raw < 2000 || raw > 2100) throw new ApiError('fy must be a year like 2024 (FY starting April)', 400)
  const fromStr = `${raw}-04-01`
  const toStr = `${raw + 1}-03-31`
  return { fy: raw, label: `${raw}-${String((raw + 1) % 100).padStart(2, '0')}`, fromStr, toStr, from: new Date(fromStr), to: endOfDayStr(toStr) }
}

/** End of the given YYYY-MM-DD day (same convention as the existing /api/reports routes). */
export function endOfDayStr(s: string, label = 'date'): Date {
  const d = new Date(s)
  if (isNaN(d.getTime())) throw new ApiError(`Invalid ${label}`, 400)
  if (s.length <= 10) d.setHours(23, 59, 59, 999)
  return d
}

/** from/to query params (YYYY-MM-DD). Default: current Indian FY start → today. `date=` sets a single day. */
export function parsePeriod(sp: URLSearchParams): Period {
  const today = new Date()
  const single = sp.get('date')
  const fromStr = sp.get('from') || single || fyStartStr(today)
  const toStr = sp.get('to') || single || isoDay(today)
  const from = new Date(fromStr)
  if (isNaN(from.getTime())) throw new ApiError('Invalid from date', 400)
  const to = endOfDayStr(toStr, 'to date')
  if (from > to) throw new ApiError('From date must be on or before the to date', 400)
  return { fromStr, toStr, from, to }
}

/** asOf query param (YYYY-MM-DD, default today) → end of that day. */
export function parseAsOf(sp: URLSearchParams): { asOfStr: string; asOf: Date } {
  const asOfStr = sp.get('asOf') || sp.get('to') || isoDay(new Date())
  return { asOfStr, asOf: endOfDayStr(asOfStr, 'asOf date') }
}

const sum = (n: number | null | undefined) => n || 0

// ============ stock ============

/**
 * Stock value just BEFORE `cutoff`.
 * APPROXIMATION: qty-at-date = current StockBalance.qty − (qtyIn − qtyOut) of ledger movements dated ≥ cutoff,
 * valued at the CURRENT moving-average rate (StockBalance.avgRate) — historical average rates are not stored.
 * Negative reconstructed quantities are treated as 0.
 */
export async function stockValueBefore(companyId: string, cutoff: Date): Promise<number> {
  const [balances, moves] = await Promise.all([
    db.stockBalance.findMany({ where: { companyId }, select: { itemId: true, warehouseId: true, qty: true, avgRate: true } }),
    db.stockLedger.groupBy({
      by: ['itemId', 'warehouseId'],
      where: { companyId, date: { gte: cutoff } },
      _sum: { qtyIn: true, qtyOut: true },
    }),
  ])
  const delta = new Map(moves.map((m) => [`${m.itemId}|${m.warehouseId}`, sum(m._sum.qtyIn) - sum(m._sum.qtyOut)]))
  let value = 0
  for (const b of balances) {
    const qty = Math.max(0, b.qty - (delta.get(`${b.itemId}|${b.warehouseId}`) || 0))
    value += qty * (b.avgRate || 0)
  }
  return r2(value)
}

/** Stock value at the end of `asOf` (inclusive). */
export const stockValueAt = (companyId: string, asOf: Date) => stockValueBefore(companyId, new Date(asOf.getTime() + 1))

// ============ Profit & Loss ============

export interface AmountRow { key: string; label: string; amount: number }

const EXPENSE_LABEL: Record<string, string> = {
  UTILITIES: 'Utilities', FREIGHT: 'Freight', RENT: 'Rent', SALARY: 'Salary', MAINTENANCE: 'Maintenance',
  TOOLING: 'Tooling', OTHER: 'Other', GENERAL: 'General', OTHER_EXPENSE_ADJ: 'Other expense (cash/bank)',
}
const labelOf = (k: string) => EXPENSE_LABEL[k] || k.charAt(0) + k.slice(1).toLowerCase().replaceAll('_', ' ')

export interface ProfitLoss {
  sales: { gross: number; returns: number; net: number }
  purchases: { gross: number; returns: number; net: number }
  directExpenses: { total: number; byCategory: AmountRow[] }
  openingStock: number
  closingStock: number
  stockLoss: number
  cogs: number
  grossProfit: number
  indirectExpenses: { total: number; byCategory: AmountRow[] }
  loanInterest: number
  processingFees: number
  otherIncome: number
  roundOff: number
  netProfit: number
}

/**
 * Taxable value of a bill = grandTotal − GST − cess − roundOff (freight / packing are taxable supplies too).
 * Sales / purchases are shown net of returns (credit / debit note taxable value = return subtotal).
 * Expenses: amount − gstAmount when ITC is claimable, else the full amount.
 * COGS = opening stock + purchases + direct expenses − closing stock − stock loss
 * (stock loss is taken out of COGS and shown as its own line, so it isn't counted twice).
 */
export async function profitAndLoss(companyId: string, from: Date, to: Date): Promise<ProfitLoss> {
  const date = { gte: from, lte: to }
  const billSum = { grandTotal: true, cgst: true, sgst: true, igst: true, cess: true, roundOff: true } as const
  const [si, sr, pi, pr, expenses, lossRows, adjusts, emis, loans, openingStock, closingStock] = await Promise.all([
    db.salesInvoice.aggregate({ where: { companyId, status: NOT_CANCELLED, date }, _sum: billSum }),
    db.salesReturn.aggregate({ where: { companyId, status: NOT_CANCELLED, date }, _sum: { subtotal: true } }),
    db.purchaseInvoice.aggregate({ where: { companyId, status: NOT_CANCELLED, date }, _sum: billSum }),
    db.purchaseReturn.aggregate({ where: { companyId, status: NOT_CANCELLED, date }, _sum: { subtotal: true } }),
    db.expense.groupBy({
      by: ['expenseType', 'category', 'itcEligible'],
      where: { companyId, status: POSTED_EXPENSE, date },
      _sum: { amount: true, gstAmount: true },
    }),
    db.stockLedger.findMany({
      where: { companyId, type: 'ADJUST_OUT', reasonType: { in: LOSS_REASONS }, date },
      select: { qtyOut: true, rate: true },
    }),
    db.accountTxn.groupBy({
      by: ['type', 'category'],
      where: { companyId, type: { in: ['ADJUST_IN', 'ADJUST_OUT'] }, date },
      _sum: { amount: true },
    }),
    db.accountTxn.aggregate({ where: { companyId, type: 'LOAN_EMI', date }, _sum: { interest: true } }),
    db.loan.aggregate({ where: { companyId, startDate: date }, _sum: { processingFee: true } }),
    stockValueBefore(companyId, from),
    stockValueAt(companyId, to),
  ])

  const taxable = (s: typeof si._sum) =>
    sum(s.grandTotal) - sum(s.cgst) - sum(s.sgst) - sum(s.igst) - sum(s.cess) - sum(s.roundOff)

  const salesGross = r2(taxable(si._sum))
  const salesReturns = r2(sum(sr._sum.subtotal))
  const purchGross = r2(taxable(pi._sum))
  const purchReturns = r2(sum(pr._sum.subtotal))

  const direct = new Map<string, number>()
  const indirect = new Map<string, number>()
  for (const e of expenses) {
    const amt = sum(e._sum.amount) - (e.itcEligible ? sum(e._sum.gstAmount) : 0)
    const m = e.expenseType === 'DIRECT' ? direct : indirect
    m.set(e.category, (m.get(e.category) || 0) + amt)
  }
  let otherIncome = 0
  for (const a of adjusts) {
    if (a.type === 'ADJUST_IN' && a.category === 'OTHER_INCOME') otherIncome += sum(a._sum.amount)
    if (a.type === 'ADJUST_OUT' && a.category === 'OTHER_EXPENSE') {
      indirect.set('OTHER_EXPENSE_ADJ', (indirect.get('OTHER_EXPENSE_ADJ') || 0) + sum(a._sum.amount))
    }
  }
  const rows = (m: Map<string, number>): AmountRow[] =>
    [...m.entries()].map(([key, amount]) => ({ key, label: labelOf(key), amount: r2(amount) })).filter((r) => r.amount !== 0).sort((a, b) => b.amount - a.amount)
  const directRows = rows(direct)
  const indirectRows = rows(indirect)
  const directTotal = r2(directRows.reduce((s, r) => s + r.amount, 0))
  const indirectTotal = r2(indirectRows.reduce((s, r) => s + r.amount, 0))

  const stockLoss = r2(lossRows.reduce((s, l) => s + (l.qtyOut || 0) * (l.rate || 0), 0))
  const salesNet = r2(salesGross - salesReturns)
  const purchNet = r2(purchGross - purchReturns)
  const cogs = r2(openingStock + purchNet + directTotal - closingStock - stockLoss)
  const grossProfit = r2(salesNet - cogs)
  const loanInterest = r2(sum(emis._sum.interest))
  const processingFees = r2(sum(loans._sum.processingFee))
  // Sales round-off earned − purchase round-off paid
  const roundOff = r2(sum(si._sum.roundOff) - sum(pi._sum.roundOff))
  otherIncome = r2(otherIncome)
  const netProfit = r2(grossProfit - indirectTotal - stockLoss - loanInterest - processingFees + otherIncome + roundOff)

  return {
    sales: { gross: salesGross, returns: salesReturns, net: salesNet },
    purchases: { gross: purchGross, returns: purchReturns, net: purchNet },
    directExpenses: { total: directTotal, byCategory: directRows },
    openingStock, closingStock, stockLoss, cogs, grossProfit,
    indirectExpenses: { total: indirectTotal, byCategory: indirectRows },
    loanInterest, processingFees, otherIncome, roundOff, netProfit,
  }
}

// ============ Parties (receivables / payables) ============

/**
 * Receivable = Σ customer opening balances + Σ (grandTotal − paidAmount) of non-cancelled sales invoices
 * (same as the party 360 "outstanding"); payable likewise for suppliers / purchase bills.
 * As of a past date: only invoices dated ≤ asOf, adding back settlements (receipts, credit notes,
 * not bounced cheques) dated after asOf.
 */
export async function partyOutstanding(companyId: string, asOf?: Date): Promise<{ receivable: number; payable: number; customerOpening: number; supplierOpening: number }> {
  const date = asOf ? { lte: asOf } : undefined
  const [co, so, si, pi, later] = await Promise.all([
    db.customer.aggregate({ where: { companyId }, _sum: { openingBalance: true } }),
    db.supplier.aggregate({ where: { companyId }, _sum: { openingBalance: true } }),
    db.salesInvoice.aggregate({ where: { companyId, status: NOT_CANCELLED, ...(date ? { date } : {}) }, _sum: { grandTotal: true, paidAmount: true } }),
    db.purchaseInvoice.aggregate({ where: { companyId, status: NOT_CANCELLED, ...(date ? { date } : {}) }, _sum: { grandTotal: true, paidAmount: true } }),
    asOf
      ? db.payment.findMany({
        where: { companyId, date: { gt: asOf }, invoiceId: { not: null }, OR: [{ chequeStatus: null }, { chequeStatus: { not: 'BOUNCED' } }] },
        select: { invoiceId: true, invoiceType: true, amount: true },
      })
      : Promise.resolve([] as { invoiceId: string | null; invoiceType: string | null; amount: number }[]),
  ])
  let laterSales = 0
  let laterPurch = 0
  if (asOf && later.length) {
    const sIds = [...new Set(later.filter((p) => p.invoiceType === 'SALES' && p.invoiceId).map((p) => p.invoiceId as string))]
    const pIds = [...new Set(later.filter((p) => p.invoiceType === 'PURCHASE' && p.invoiceId).map((p) => p.invoiceId as string))]
    const [sOld, pOld] = await Promise.all([
      sIds.length ? db.salesInvoice.findMany({ where: { companyId, id: { in: sIds }, date: { lte: asOf }, status: NOT_CANCELLED }, select: { id: true } }) : [],
      pIds.length ? db.purchaseInvoice.findMany({ where: { companyId, id: { in: pIds }, date: { lte: asOf }, status: NOT_CANCELLED }, select: { id: true } }) : [],
    ])
    const sSet = new Set(sOld.map((x) => x.id))
    const pSet = new Set(pOld.map((x) => x.id))
    for (const p of later) {
      if (p.invoiceType === 'SALES' && p.invoiceId && sSet.has(p.invoiceId)) laterSales += p.amount
      if (p.invoiceType === 'PURCHASE' && p.invoiceId && pSet.has(p.invoiceId)) laterPurch += p.amount
    }
  }
  const customerOpening = r2(sum(co._sum.openingBalance))
  const supplierOpening = r2(sum(so._sum.openingBalance))
  return {
    customerOpening,
    supplierOpening,
    receivable: r2(customerOpening + sum(si._sum.grandTotal) - sum(si._sum.paidAmount) + laterSales),
    payable: r2(supplierOpening + sum(pi._sum.grandTotal) - sum(pi._sum.paidAmount) + laterPurch),
  }
}

// ============ GST ============

export interface TaxHeads { cgst: number; sgst: number; igst: number; cess: number }
const zeroHeads = (): TaxHeads => ({ cgst: 0, sgst: 0, igst: 0, cess: 0 })
export const headsTotal = (h: TaxHeads) => r2(h.cgst + h.sgst + h.igst + h.cess)
const roundHeads = (h: TaxHeads): TaxHeads => ({ cgst: r2(h.cgst), sgst: r2(h.sgst), igst: r2(h.igst), cess: r2(h.cess) })

/** State code ("27") from a state name or code string; null when unknown. */
export function stateCodeOf(v?: string | null): string | null {
  if (!v) return null
  const s = v.trim()
  if (/^\d{2}$/.test(s)) return s
  const hit = GST_STATES.find((g) => g.name.toLowerCase() === s.toLowerCase())
  return hit ? hit.code : null
}

/**
 * Output and input tax for a date range.
 * Output = sales invoice GST + cess − credit-note GST. Input = bill GST + cess − debit-note GST
 * + GST on ITC-eligible expenses (split CGST/SGST, or IGST when the vendor GSTIN is from another state).
 * `registeredOnly` limits bill ITC to suppliers with a GSTIN (GSTR-3B view), but a reverse-charge
 * bill is always included: the tax is self-assessed, so credit is available even without a GSTIN.
 *
 * Sales invoices are stored in their document currency, so every amount is converted to INR at
 * the invoice's recorded exchange rate. The reverse-charge invoices are also returned on their own
 * (`reverseCharge`) for the GSTR-3B 3.1(d) / 4(A)(3) rows.
 */
export async function gstTotals(companyId: string, date: { gte?: Date; lte: Date }, opts: { registeredOnly?: boolean } = {}) {
  const heads = { cgst: true, sgst: true, igst: true } as const
  // Rows (not aggregates) because sales amounts are in the document currency and have to be
  // converted one by one, and because reverse-charge bills need to be told apart.
  // Only sales invoices carry a currency — a purchase bill is always recorded in INR.
  const saleRow = {
    cgst: true, sgst: true, igst: true, cess: true, grandTotal: true, currency: true, fxRate: true, reverseCharge: true,
  } as const
  const billRow = { cgst: true, sgst: true, igst: true, cess: true, grandTotal: true, reverseCharge: true } as const
  const [company, siRows, sr, piRows, pr, exp] = await Promise.all([
    db.company.findUnique({ where: { id: companyId }, select: { stateCode: true, state: true, gstin: true } }),
    db.salesInvoice.findMany({ where: { companyId, status: NOT_CANCELLED, date }, select: saleRow }),
    db.salesReturn.aggregate({ where: { companyId, status: NOT_CANCELLED, date }, _sum: heads }),
    db.purchaseInvoice.findMany({
      where: {
        companyId, status: NOT_CANCELLED, date,
        ...(opts.registeredOnly ? { OR: [{ supplier: { gstin: { not: null } } }, { reverseCharge: true }] } : {}),
      },
      select: billRow,
    }),
    db.purchaseReturn.aggregate({ where: { companyId, status: NOT_CANCELLED, date }, _sum: heads }),
    db.expense.findMany({
      where: { companyId, status: POSTED_EXPENSE, itcEligible: true, gstAmount: { gt: 0 }, date },
      select: { gstAmount: true, vendorGstin: true },
    }),
  ])
  type BillRow = { cgst?: number | null; sgst?: number | null; igst?: number | null; cess?: number | null; grandTotal?: number | null; currency?: string | null; fxRate?: number | null; reverseCharge?: boolean | null }
  const sales = siRows as unknown as BillRow[]
  const bills = piRows as unknown as BillRow[]
  // Ordinary outward tax; a reverse-charge invoice is reported on its own (the buyer pays that tax).
  const salesNonRcm = sales.filter((r) => !r.reverseCharge)
  const inrSales = (pick: (r: BillRow) => number | null | undefined) =>
    salesNonRcm.reduce((total, r) => total + toInrAmount(pick(r), fxToInr(r.currency, r.fxRate)), 0)

  const own = company?.stateCode || company?.gstin?.slice(0, 2) || stateCodeOf(company?.state)
  const output: TaxHeads = {
    cgst: inrSales((r) => r.cgst) - sum(sr._sum.cgst),
    sgst: inrSales((r) => r.sgst) - sum(sr._sum.sgst),
    igst: inrSales((r) => r.igst) - sum(sr._sum.igst),
    cess: inrSales((r) => r.cess),
  }
  const expenseItc = zeroHeads()
  for (const e of exp) {
    const vendorState = e.vendorGstin ? e.vendorGstin.slice(0, 2) : null
    if (vendorState && own && vendorState !== own) expenseItc.igst += e.gstAmount
    else { expenseItc.cgst += e.gstAmount / 2; expenseItc.sgst += e.gstAmount / 2 }
  }
  // A purchase bill is always in INR, so no rate is applied.
  const billSum = (pick: (r: BillRow) => number | null | undefined) =>
    bills.reduce((total, r) => total + (Number(pick(r)) || 0), 0)
  const billItc: TaxHeads = {
    cgst: billSum((r) => r.cgst) - sum(pr._sum.cgst),
    sgst: billSum((r) => r.sgst) - sum(pr._sum.sgst),
    igst: billSum((r) => r.igst) - sum(pr._sum.igst),
    cess: billSum((r) => r.cess),
  }
  const input: TaxHeads = {
    cgst: billItc.cgst + expenseItc.cgst, sgst: billItc.sgst + expenseItc.sgst,
    igst: billItc.igst + expenseItc.igst, cess: billItc.cess,
  }
  const o = roundHeads(output)
  const i = roundHeads(input)

  // Reverse-charge documents: the recipient pays the tax, so they are reported on their own
  // (GSTR-3B 3.1(d) outward / 4(A)(3) self-assessed ITC) instead of looking like ordinary tax.
  const rcmBlock = (rows: BillRow[]) => {
    const sumOf = (pick: (r: BillRow) => number | null | undefined) =>
      rows.reduce((total, r) => total + toInrAmount(pick(r), fxToInr(r.currency, r.fxRate)), 0)
    // (bills carry no currency — fxToInr returns 1 for them)
    const tax = roundHeads({ cgst: sumOf((r) => r.cgst), sgst: sumOf((r) => r.sgst), igst: sumOf((r) => r.igst), cess: sumOf((r) => r.cess) })
    const taxable = r2(rows.reduce((total, r) => {
      const fx = fxToInr(r.currency, r.fxRate)
      const net = (r.grandTotal || 0) - (r.cgst || 0) - (r.sgst || 0) - (r.igst || 0) - (r.cess || 0)
      return total + toInrAmount(net, fx)
    }, 0))
    return { docs: rows.length, taxable, tax, totalTax: headsTotal(tax) }
  }

  const reverseCharge = {
    outward: rcmBlock(sales.filter((r) => r.reverseCharge)),
    inward: rcmBlock(bills.filter((r) => r.reverseCharge)),
  }
  return {
    output: o,
    input: i,
    billItc: roundHeads(billItc),
    expenseItc: roundHeads(expenseItc),
    outputTotal: headsTotal(o),
    inputTotal: headsTotal(i),
    /**
     * + = payable to government, − = credit.
     * The inward reverse-charge tax is added back: it is self-assessed (3.1(d)) and paid in cash,
     * while the same amount is claimed as ITC, so leaving it out would understate the liability.
     */
    net: r2(headsTotal(o) - headsTotal(i) + reverseCharge.inward.totalTax),
    reverseCharge,
  }
}

// ============ Position as of a date (Balance Sheet / Trial Balance) ============

export interface Position {
  accounts: AccountBalance[]
  cash: number
  bank: number
  chequesInHand: number
  chequesIssued: number
  receivable: number
  payable: number
  /** Customer advances not yet applied (liability) */
  customerAdvances: number
  /** Sales-return credit not yet applied / refunded (liability: refunds due to customers) */
  customerCredits: number
  /** Purchase-return excess not yet received (asset: refunds due from suppliers) */
  supplierRefunds: number
  customerOpening: number
  supplierOpening: number
  stock: number
  gst: Awaited<ReturnType<typeof gstTotals>>
  loans: number
  capital: number
  drawings: number
  pl: ProfitLoss
}

export async function positionAsOf(companyId: string, asOf: Date): Promise<Position> {
  const [accounts, parties, gst, loanRows, emiRows, adj, chq, pl, credits] = await Promise.all([
    accountBalances(companyId, asOf),
    partyOutstanding(companyId, asOf),
    gstTotals(companyId, { lte: asOf }),
    db.loan.findMany({ where: { companyId, startDate: { lte: asOf } }, select: { id: true, principal: true, status: true, updatedAt: true } }),
    db.accountTxn.groupBy({ by: ['loanId'], where: { companyId, type: 'LOAN_EMI', date: { lte: asOf } }, _sum: { principal: true } }),
    db.accountTxn.groupBy({
      by: ['type', 'category'],
      where: { companyId, type: { in: ['ADJUST_IN', 'ADJUST_OUT'] }, category: { in: ['CAPITAL', 'DRAWINGS'] }, date: { lte: asOf } },
      _sum: { amount: true },
    }),
    // Post-dated / deposited cheques: the party is already settled but the money hasn't reached the bank
    // (on asOf: still pending / deposited, or cleared only after asOf)
    db.payment.groupBy({
      by: ['type'],
      where: {
        companyId, date: { lte: asOf }, mode: { notIn: NON_MONEY_MODES },
        OR: [{ chequeStatus: { in: ['PENDING', 'DEPOSITED'] } }, { chequeStatus: 'CLEARED', clearedDate: { gt: asOf } }],
      },
      _sum: { amount: true },
    }),
    profitAndLoss(companyId, EARLY, asOf),
    partyCreditsAsOf(companyId, asOf),
  ])
  const paid = new Map(emiRows.map((e) => [e.loanId, sum(e._sum.principal)]))
  let loans = 0
  for (const l of loanRows) {
    // A loan closed on/before asOf owes nothing even when its EMIs weren't all recorded
    if (l.status === 'CLOSED' && l.updatedAt <= asOf) continue
    loans += Math.max(0, l.principal - (paid.get(l.id) || 0))
  }
  let capital = 0
  let drawings = 0
  for (const a of adj) {
    if (a.type === 'ADJUST_IN' && a.category === 'CAPITAL') capital += sum(a._sum.amount)
    if (a.type === 'ADJUST_OUT' && a.category === 'DRAWINGS') drawings += sum(a._sum.amount)
  }
  return {
    accounts,
    cash: r2(accounts.filter((a) => a.type === 'CASH').reduce((s, a) => s + a.balance, 0)),
    bank: r2(accounts.filter((a) => a.type !== 'CASH').reduce((s, a) => s + a.balance, 0)),
    chequesInHand: r2(sum(chq.find((c) => c.type === 'RECEIPT')?._sum.amount)),
    chequesIssued: r2(sum(chq.find((c) => c.type === 'PAYMENT')?._sum.amount)),
    receivable: parties.receivable,
    customerAdvances: credits.customerAdvances,
    customerCredits: credits.customerCredits,
    supplierRefunds: credits.supplierRefunds,
    payable: parties.payable,
    customerOpening: parties.customerOpening,
    supplierOpening: parties.supplierOpening,
    stock: pl.closingStock,
    gst,
    loans: r2(loans),
    capital: r2(capital),
    drawings: r2(drawings),
    pl,
  }
}

export interface StatementLine { key: string; label: string; amount: number; note?: string; children?: StatementLine[] }

/** Balance Sheet: Assets = Liabilities + Equity, with the opening-balance difference as the explicit plug. */
export function balanceSheetFrom(p: Position) {
  const assets: StatementLine[] = [
    { key: 'cash', label: 'Cash in hand', amount: p.cash, children: p.accounts.filter((a) => a.type === 'CASH').map((a) => ({ key: a.id, label: a.name, amount: a.balance })) },
    { key: 'bank', label: 'Bank accounts', amount: p.bank, children: p.accounts.filter((a) => a.type !== 'CASH').map((a) => ({ key: a.id, label: a.name, amount: a.balance })) },
  ]
  if (p.chequesInHand) assets.push({ key: 'chequesInHand', label: 'Cheques in hand (uncleared)', amount: p.chequesInHand })
  assets.push({ key: 'receivable', label: 'Sundry debtors (receivables)', amount: p.receivable, note: 'Customer opening balances + unpaid sales invoices' })
  if (p.supplierRefunds) assets.push({ key: 'supplierRefunds', label: 'Refunds due from suppliers', amount: p.supplierRefunds, note: 'Purchase-return excess not yet received' })
  assets.push({ key: 'stock', label: 'Closing stock', amount: p.stock, note: 'Qty at date × current average rate' })
  if (p.gst.net < 0) assets.push({ key: 'gstCredit', label: 'Input GST credit (net)', amount: r2(-p.gst.net) })

  const liabilities: StatementLine[] = [
    { key: 'payable', label: 'Sundry creditors (payables)', amount: p.payable, note: 'Supplier opening balances + unpaid bills' },
  ]
  if (p.customerAdvances) liabilities.push({ key: 'customerAdvances', label: 'Customer advances', amount: p.customerAdvances, note: 'Received before an invoice, not yet applied' })
  if (p.customerCredits) liabilities.push({ key: 'customerCredits', label: 'Refunds due to customers', amount: p.customerCredits, note: 'Sales-return credit not yet applied or refunded' })
  if (p.loans) liabilities.push({ key: 'loans', label: 'Loans outstanding', amount: p.loans })
  if (p.gst.net > 0) liabilities.push({ key: 'gstPayable', label: 'GST payable (net)', amount: p.gst.net })
  if (p.chequesIssued) liabilities.push({ key: 'chequesIssued', label: 'Cheques issued (uncleared)', amount: p.chequesIssued })

  const totalAssets = r2(assets.reduce((s, a) => s + a.amount, 0))
  const totalLiabilities = r2(liabilities.reduce((s, a) => s + a.amount, 0))
  const capitalNet = r2(p.capital - p.drawings)
  const retained = p.pl.netProfit
  const openingDiff = r2(totalAssets - totalLiabilities - capitalNet - retained)
  const equity: StatementLine[] = [
    { key: 'capital', label: 'Capital (introduced − drawings)', amount: capitalNet, children: [
      { key: 'capitalIn', label: 'Capital introduced', amount: p.capital },
      { key: 'drawings', label: 'Less: drawings', amount: r2(-p.drawings) },
    ] },
    { key: 'retained', label: 'Retained profit (net profit to date)', amount: retained },
    { key: 'openingDiff', label: 'Opening balance difference', amount: openingDiff, note: 'Balancing figure: opening balances of parties / cash & bank and anything not captured by documents' },
  ]
  const totalEquity = r2(equity.reduce((s, a) => s + a.amount, 0))
  return { assets, liabilities, equity, totalAssets, totalLiabilities, totalEquity, totalLiabilitiesAndEquity: r2(totalLiabilities + totalEquity) }
}

export interface TbLine { key: string; label: string; debit: number; credit: number; group: string }

/** Trial balance heads from the same position; natural-debit amounts become Cr when negative and vice versa. */
export function trialBalanceFrom(p: Position) {
  const lines: TbLine[] = []
  const dr = (key: string, label: string, v: number, group: string) => {
    if (Math.abs(v) < 0.005) return
    lines.push({ key, label, group, debit: v > 0 ? r2(v) : 0, credit: v < 0 ? r2(-v) : 0 })
  }
  const cr = (key: string, label: string, v: number, group: string) => dr(key, label, -v, group)
  const pl = p.pl
  for (const a of p.accounts) dr(`acc-${a.id}`, a.name, a.balance, a.type === 'CASH' ? 'Cash' : 'Bank')
  dr('chequesInHand', 'Cheques in hand (uncleared)', p.chequesInHand, 'Current assets')
  dr('receivable', 'Sundry debtors', p.receivable, 'Current assets')
  dr('supplierRefunds', 'Refunds due from suppliers', p.supplierRefunds, 'Current assets')
  cr('customerAdvances', 'Customer advances', p.customerAdvances, 'Current liabilities')
  cr('customerCredits', 'Refunds due to customers', p.customerCredits, 'Current liabilities')
  dr('stock', 'Stock in hand (closing)', p.stock, 'Current assets')
  dr('inputGst', 'Input GST', p.gst.inputTotal, 'Duties & taxes')
  cr('outputGst', 'Output GST', p.gst.outputTotal, 'Duties & taxes')
  cr('payable', 'Sundry creditors', p.payable, 'Current liabilities')
  cr('chequesIssued', 'Cheques issued (uncleared)', p.chequesIssued, 'Current liabilities')
  cr('loans', 'Loans', p.loans, 'Loans (liability)')
  cr('capital', 'Capital', p.capital, 'Capital')
  dr('drawings', 'Drawings', p.drawings, 'Capital')
  cr('sales', 'Sales (net of returns)', pl.sales.net, 'Income')
  dr('purchases', 'Purchases (net of returns)', pl.purchases.net, 'Expenses')
  dr('openingStock', 'Opening stock', pl.openingStock, 'Expenses')
  // closing − opening stock is credited to the trading account (stock loss is shown on its own)
  cr('stockChange', 'Closing stock transferred (less stock loss)', r2(pl.closingStock + pl.stockLoss), 'Income')
  dr('stockLoss', 'Stock loss (damage / expiry / theft)', pl.stockLoss, 'Expenses')
  dr('directExp', 'Direct expenses', pl.directExpenses.total, 'Expenses')
  dr('indirectExp', 'Indirect expenses', pl.indirectExpenses.total, 'Expenses')
  dr('interest', 'Loan interest', pl.loanInterest, 'Expenses')
  dr('fees', 'Loan processing fees', pl.processingFees, 'Expenses')
  cr('otherIncome', 'Other income', pl.otherIncome, 'Income')
  cr('roundOff', 'Round off (net)', pl.roundOff, 'Income')
  const totalDebit = r2(lines.reduce((s, l) => s + l.debit, 0))
  const totalCredit = r2(lines.reduce((s, l) => s + l.credit, 0))
  return { lines, totalDebit, totalCredit, difference: r2(totalDebit - totalCredit) }
}

// ============ Cash flow ============

export async function cashFlow(companyId: string, from: Date, to: Date) {
  const date = { gte: from, lte: to }
  // Payments by the day their money moved (a cleared post-dated cheque on its clearing date) — as accountBalances()
  const moneyWhere = moneyPaymentWhere(companyId, date)
  const [openingAcc, closingAcc, payments, expenses, txns, accounts] = await Promise.all([
    accountBalances(companyId, new Date(from.getTime() - 1)),
    accountBalances(companyId, to),
    db.payment.groupBy({ by: ['type', 'partyType', 'mode'], where: moneyWhere, _sum: { amount: true } }),
    db.expense.groupBy({ by: ['expenseType'], where: { companyId, status: POSTED_EXPENSE, date }, _sum: { amount: true } }),
    db.accountTxn.findMany({ where: { companyId, date }, select: { type: true, category: true, amount: true, fromAccountId: true, toAccountId: true } }),
    db.moneyAccount.findMany({ where: { companyId }, select: { id: true, openingBalance: true, openingDate: true } }),
  ])
  const known = new Set(accounts.map((a) => a.id))
  const inflows: AmountRow[] = []
  const outflows: AmountRow[] = []
  const add = (list: AmountRow[], key: string, label: string, amount: number) => {
    if (Math.abs(amount) < 0.005) return
    const row = list.find((r) => r.key === key)
    if (row) row.amount = r2(row.amount + amount)
    else list.push({ key, label, amount: r2(amount) })
  }
  for (const p of payments) {
    const amt = sum(p._sum.amount)
    if (p.type === 'RECEIPT') add(inflows, `rcpt-${p.mode}`, `Receipts from ${p.partyType === 'SUPPLIER' ? 'suppliers' : 'customers'} — ${p.mode}`, amt)
    else add(outflows, `pay-${p.mode}`, `Payments to ${p.partyType === 'CUSTOMER' ? 'customers' : 'suppliers'} — ${p.mode}`, amt)
  }
  for (const e of expenses) add(outflows, `exp-${e.expenseType}`, `${e.expenseType === 'DIRECT' ? 'Direct' : 'Indirect'} expenses`, sum(e._sum.amount))
  const CAT: Record<string, string> = { CAPITAL: 'Capital introduced', OTHER_INCOME: 'Other income', DRAWINGS: 'Drawings', OTHER_EXPENSE: 'Other expenses (cash/bank)', OTHER: 'Other adjustments' }
  for (const t of txns) {
    const into = t.toAccountId && known.has(t.toAccountId)
    const outOf = t.fromAccountId && known.has(t.fromAccountId)
    if (into && outOf) continue // contra — moves money between own accounts
    if (into) {
      if (t.type === 'LOAN_IN') add(inflows, 'loanIn', 'Loans received (net of processing fee)', t.amount)
      else add(inflows, `adj-${t.category || 'OTHER'}`, CAT[t.category || 'OTHER'] || 'Other adjustments', t.amount)
    } else if (outOf) {
      if (t.type === 'LOAN_EMI') add(outflows, 'emi', 'Loan EMIs (principal + interest)', t.amount)
      else add(outflows, `adj-${t.category || 'OTHER'}`, CAT[t.category || 'OTHER'] || 'Other adjustments', t.amount)
    }
  }
  // Accounts whose opening date falls inside the period: their opening balance appears between the two snapshots
  const openedInPeriod = r2(accounts.filter((a) => a.openingDate && a.openingDate >= from && a.openingDate <= to).reduce((s, a) => s + a.openingBalance, 0))
  if (openedInPeriod) add(inflows, 'accOpening', 'Opening balance of accounts started in period', openedInPeriod)

  const opening = r2(openingAcc.reduce((s, a) => s + a.balance, 0))
  const closing = r2(closingAcc.reduce((s, a) => s + a.balance, 0))
  const totalIn = r2(inflows.reduce((s, r) => s + r.amount, 0))
  const totalOut = r2(outflows.reduce((s, r) => s + r.amount, 0))
  const computedClosing = r2(opening + totalIn - totalOut)
  const byAccount = closingAcc.map((a) => ({ id: a.id, name: a.name, type: a.type, opening: openingAcc.find((o) => o.id === a.id)?.balance ?? 0, closing: a.balance }))
  return {
    opening, closing, totalIn, totalOut, netChange: r2(totalIn - totalOut), computedClosing,
    difference: r2(closing - computedClosing),
    inflows: inflows.sort((a, b) => b.amount - a.amount),
    outflows: outflows.sort((a, b) => b.amount - a.amount),
    byAccount,
  }
}

// ============ Daybook / all transactions ============

export interface TxnRow {
  id: string
  date: Date
  type: string // SALE | PURCHASE | PAYMENT_IN | PAYMENT_OUT | EXPENSE | CREDIT_NOTE | DEBIT_NOTE | ADJUST_IN | ADJUST_OUT | CONTRA | LOAN_IN | LOAN_EMI
  typeLabel: string
  number: string
  partyId: string | null
  party: string
  description: string
  mode: string | null
  account: string | null
  status: string | null
  moneyIn: number
  moneyOut: number
  amount: number
}

export const TXN_TYPE_LABEL: Record<string, string> = {
  SALE: 'Sale', PURCHASE: 'Purchase', PAYMENT_IN: 'Payment In', PAYMENT_OUT: 'Payment Out', EXPENSE: 'Expense',
  CREDIT_NOTE: 'Credit Note', DEBIT_NOTE: 'Debit Note', ADJUST_IN: 'Add Money', ADJUST_OUT: 'Reduce Money',
  CONTRA: 'Contra', LOAN_IN: 'Loan Received', LOAN_EMI: 'Loan EMI', CHEQUE_CLEARED: 'Cheque Cleared',
}

/**
 * Every document of the period in time order. Invoices / bills / notes carry only an amount — the money
 * moving against them is the Payment row (incl. "received / paid now"). Money columns follow
 * accountBalances(): uncleared or bounced cheques show no money in/out, and a cleared post-dated cheque
 * shows its money on a CHEQUE_CLEARED row dated on its clearing date.
 */
export async function listTransactions(companyId: string, from: Date, to: Date): Promise<TxnRow[]> {
  const date = { gte: from, lte: to }
  const [si, pi, pays, exps, srs, prs, txns, accounts, loans] = await Promise.all([
    db.salesInvoice.findMany({ where: { companyId, date }, select: { id: true, number: true, date: true, customerId: true, grandTotal: true, status: true, customer: { select: { name: true } } } }),
    db.purchaseInvoice.findMany({ where: { companyId, date }, select: { id: true, number: true, date: true, supplierId: true, supplierInvNo: true, grandTotal: true, status: true, supplier: { select: { name: true } } } }),
    // Payments of the period, plus post-dated cheques cleared in it (their money row is on the clearing date)
    db.payment.findMany({
      where: { companyId, mode: { notIn: NON_MONEY_MODES }, OR: [{ date }, { chequeStatus: 'CLEARED', clearedDate: date }] },
      select: { id: true, number: true, date: true, type: true, partyType: true, customerId: true, supplierId: true, amount: true, mode: true, accountId: true, chequeStatus: true, chequeNo: true, clearedDate: true, reference: true },
    }),
    db.expense.findMany({ where: { companyId, date, status: POSTED_EXPENSE }, select: { id: true, number: true, date: true, category: true, description: true, amount: true, paymentMode: true, paidTo: true, accountId: true, expenseType: true } }),
    db.salesReturn.findMany({ where: { companyId, date }, select: { id: true, number: true, date: true, customerId: true, grandTotal: true, status: true } }),
    db.purchaseReturn.findMany({ where: { companyId, date }, select: { id: true, number: true, date: true, supplierId: true, grandTotal: true, status: true } }),
    db.accountTxn.findMany({ where: { companyId, date }, select: { id: true, number: true, date: true, type: true, category: true, amount: true, fromAccountId: true, toAccountId: true, loanId: true, notes: true } }),
    db.moneyAccount.findMany({ where: { companyId }, select: { id: true, name: true } }),
    db.loan.findMany({ where: { companyId }, select: { id: true, name: true } }),
  ])
  const custIds = new Set<string>()
  const suppIds = new Set<string>()
  for (const p of pays) { if (p.customerId) custIds.add(p.customerId); if (p.supplierId) suppIds.add(p.supplierId) }
  for (const r of srs) custIds.add(r.customerId)
  for (const r of prs) suppIds.add(r.supplierId)
  const [custs, supps] = await Promise.all([
    custIds.size ? db.customer.findMany({ where: { companyId, id: { in: [...custIds] } }, select: { id: true, name: true } }) : [],
    suppIds.size ? db.supplier.findMany({ where: { companyId, id: { in: [...suppIds] } }, select: { id: true, name: true } }) : [],
  ])
  const custName = new Map(custs.map((c) => [c.id, c.name] as const))
  const suppName = new Map(supps.map((s) => [s.id, s.name] as const))
  const accName = new Map(accounts.map((a) => [a.id, a.name] as const))
  const loanName = new Map(loans.map((l) => [l.id, l.name] as const))

  const rows: TxnRow[] = []
  const push = (r: Omit<TxnRow, 'typeLabel'>) => rows.push({ ...r, typeLabel: TXN_TYPE_LABEL[r.type] || r.type, amount: r2(r.amount), moneyIn: r2(r.moneyIn), moneyOut: r2(r.moneyOut) })

  for (const i of si) push({ id: `si-${i.id}`, date: i.date, type: 'SALE', number: i.number, partyId: i.customerId, party: i.customer?.name || '—', description: 'Sales invoice', mode: null, account: null, status: i.status, moneyIn: 0, moneyOut: 0, amount: i.status === 'CANCELLED' ? 0 : i.grandTotal })
  for (const b of pi) push({ id: `pi-${b.id}`, date: b.date, type: 'PURCHASE', number: b.number, partyId: b.supplierId, party: b.supplier?.name || '—', description: b.supplierInvNo ? `Purchase bill (supplier inv ${b.supplierInvNo})` : 'Purchase bill', mode: null, account: null, status: b.status, moneyIn: 0, moneyOut: 0, amount: b.status === 'CANCELLED' ? 0 : b.grandTotal })
  const inPeriod = (d: Date) => d >= from && d <= to
  for (const p of pays) {
    const isIn = p.type === 'RECEIPT'
    const partyId = p.customerId || p.supplierId
    const party = (p.customerId && custName.get(p.customerId)) || (p.supplierId && suppName.get(p.supplierId)) || '—'
    const account = p.accountId ? accName.get(p.accountId) ?? null : null
    // A cleared post-dated cheque moves money on its clearing date (as accountBalances / cashFlow):
    // the payment row settles the party with no money; a "Cheque Cleared" row carries the money
    const clearedLater = p.chequeStatus === 'CLEARED' && !!p.clearedDate
    const counted = p.chequeStatus === null || (p.chequeStatus === 'CLEARED' && !p.clearedDate)
    if (inPeriod(p.date)) {
      push({
        id: `pay-${p.id}`, date: p.date, type: isIn ? 'PAYMENT_IN' : 'PAYMENT_OUT', number: p.number, partyId, party,
        description: `${isIn ? 'Received' : 'Paid'} by ${p.mode}${p.reference ? ` · ${p.reference}` : ''}${p.chequeStatus && p.chequeStatus !== 'CLEARED' ? ` · cheque ${p.chequeStatus.toLowerCase()}` : ''}${clearedLater ? ` · cheque cleared ${istDay(p.clearedDate!)}` : ''}`,
        mode: p.mode, account, status: p.chequeStatus,
        moneyIn: isIn && counted ? p.amount : 0, moneyOut: !isIn && counted ? p.amount : 0, amount: p.amount,
      })
    }
    if (clearedLater && inPeriod(p.clearedDate!)) {
      push({
        id: `chq-${p.id}`, date: p.clearedDate!, type: 'CHEQUE_CLEARED', number: p.number, partyId, party,
        description: `Cheque${p.chequeNo ? ` ${p.chequeNo}` : ''} ${isIn ? 'received' : 'issued'} on ${istDay(p.date)} cleared`,
        mode: p.mode, account, status: 'CLEARED',
        moneyIn: isIn ? p.amount : 0, moneyOut: isIn ? 0 : p.amount, amount: p.amount,
      })
    }
  }
  for (const e of exps) push({ id: `exp-${e.id}`, date: e.date, type: 'EXPENSE', number: e.number, partyId: null, party: e.paidTo || labelOf(e.category), description: `${e.expenseType === 'DIRECT' ? 'Direct' : 'Indirect'} · ${labelOf(e.category)} · ${e.description}`, mode: e.paymentMode, account: e.accountId ? accName.get(e.accountId) ?? null : null, status: null, moneyIn: 0, moneyOut: e.amount, amount: e.amount })
  for (const r of srs) push({ id: `sr-${r.id}`, date: r.date, type: 'CREDIT_NOTE', number: r.number, partyId: r.customerId, party: custName.get(r.customerId) || '—', description: 'Sales return / credit note', mode: null, account: null, status: r.status, moneyIn: 0, moneyOut: 0, amount: r.status === 'CANCELLED' ? 0 : r.grandTotal })
  for (const r of prs) push({ id: `pr-${r.id}`, date: r.date, type: 'DEBIT_NOTE', number: r.number, partyId: r.supplierId, party: suppName.get(r.supplierId) || '—', description: 'Purchase return / debit note', mode: null, account: null, status: r.status, moneyIn: 0, moneyOut: 0, amount: r.status === 'CANCELLED' ? 0 : r.grandTotal })
  for (const t of txns) {
    const fromN = t.fromAccountId ? accName.get(t.fromAccountId) ?? '—' : null
    const toN = t.toAccountId ? accName.get(t.toAccountId) ?? '—' : null
    const loan = t.loanId ? loanName.get(t.loanId) ?? null : null
    const desc = t.type === 'CONTRA' ? `${fromN} → ${toN}`
      : t.type === 'LOAN_IN' || t.type === 'LOAN_EMI' ? `${loan || 'Loan'}${t.notes ? ` · ${t.notes}` : ''}`
        : `${t.category ? labelOf(t.category === 'OTHER_EXPENSE' ? 'OTHER_EXPENSE_ADJ' : t.category) : 'Adjustment'}${t.notes ? ` · ${t.notes}` : ''}`
    const contra = t.type === 'CONTRA'
    push({
      id: `atx-${t.id}`, date: t.date, type: t.type, number: t.number, partyId: null, party: loan || (contra ? 'Contra' : t.category ? labelOf(t.category) : '—'),
      description: desc, mode: null, account: contra ? `${fromN} → ${toN}` : (toN || fromN),
      status: null, moneyIn: !contra && t.toAccountId ? t.amount : 0, moneyOut: !contra && t.fromAccountId ? t.amount : 0, amount: t.amount,
    })
  }
  return rows.sort((a, b) => a.date.getTime() - b.date.getTime() || a.number.localeCompare(b.number))
}
