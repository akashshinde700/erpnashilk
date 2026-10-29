'use client'

import * as React from 'react'
import {
  AlertTriangle, ArrowLeft, ArrowLeftRight, BadgeCheck, Boxes, Calculator, CalendarDays, ChevronDown, ChevronRight,
  Clock, CreditCard, Download, FileSpreadsheet, FileText, HandCoins, IndianRupee, Layers, ListChecks, ListOrdered,
  Package, PackageSearch, Percent, PiggyBank, ReceiptText, Scale, TrendingUp, Truck, Users, Wallet,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import {
  Column, DataTable, DateCell, DateInput, Field, Money, PageHeader, PrintButton,
  Qty, SectionCard, SelectInput, StatCard, downloadCsv, downloadXlsx, printHtml,
} from '@/components/erp/kit'
import { ItemPicker, type PickerItem } from '@/components/erp/item-picker'
import { useList } from '@/lib/use-api'
import { cn } from '@/lib/utils'
import { canAccessModule, fmtDate, fmtMoney, fmtNum, ITEM_TYPES, ITEM_TYPE_LABEL, canSeeFinancialReports } from '@/lib/erp-constants'

// ============================================================
// helpers
// ============================================================

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const todayISO = () => iso(new Date())
const fyStartISO = () => {
  const d = new Date()
  const y = d.getMonth() + 1 >= 4 ? d.getFullYear() : d.getFullYear() - 1
  return `${y}-04-01`
}
const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const r2 = (n: number) => Math.round(n * 100) / 100
const MARGIN_CLS = (v: number) => (v >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400')

type PresetKey = 'today' | 'month' | 'lastMonth' | 'quarter' | 'fy' | 'custom'
const PRESETS: { key: PresetKey; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: 'month', label: 'This month' },
  { key: 'lastMonth', label: 'Last month' },
  { key: 'quarter', label: 'This quarter' },
  { key: 'fy', label: 'This FY' },
  { key: 'custom', label: 'Custom' },
]

function presetRange(p: PresetKey): { from: string; to: string } | null {
  const now = new Date()
  const today = iso(now)
  switch (p) {
    case 'today': return { from: today, to: today }
    case 'month': return { from: iso(new Date(now.getFullYear(), now.getMonth(), 1)), to: today }
    case 'lastMonth': return { from: iso(new Date(now.getFullYear(), now.getMonth() - 1, 1)), to: iso(new Date(now.getFullYear(), now.getMonth(), 0)) }
    case 'quarter': return { from: iso(new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1)), to: today }
    case 'fy': return { from: fyStartISO(), to: today }
    default: return null
  }
}

/** Preset buttons + (Custom) date inputs. `asOf` mode edits a single "as of" date (the preset's end date). */
function DateRangeBar({ from, to, onChange, asOf, onAsOf }: {
  from: string; to: string; onChange: (from: string, to: string) => void
  asOf?: string; onAsOf?: (d: string) => void
}) {
  const single = onAsOf !== undefined
  const [preset, setPreset] = React.useState<PresetKey>(() => {
    for (const p of PRESETS) {
      const r = presetRange(p.key)
      if (r && (single ? r.to === asOf : r.from === from && r.to === to)) return p.key
    }
    return 'custom'
  })
  function pick(p: PresetKey) {
    setPreset(p)
    const r = presetRange(p)
    if (!r) return
    if (single) onAsOf?.(r.to)
    else onChange(r.from, r.to)
  }
  return (
    <div className="mb-4 flex flex-wrap items-end gap-3 rounded-lg border bg-muted/30 p-3">
      <div className="flex flex-wrap gap-1">
        {PRESETS.map((p) => (
          <Button
            key={p.key}
            size="sm"
            variant={preset === p.key ? 'default' : 'outline'}
            className={cn('h-8', preset === p.key && 'bg-emerald-600 text-white hover:bg-emerald-600')}
            onClick={() => pick(p.key)}
          >
            {p.label}
          </Button>
        ))}
      </div>
      {single ? (
        <Field label="As of" className="w-40">
          <DateInput value={asOf || ''} onChange={(v) => { setPreset('custom'); onAsOf?.(v) }} />
        </Field>
      ) : (
        <>
          <Field label="From" className="w-40">
            <DateInput value={from} onChange={(v) => { setPreset('custom'); onChange(v, to) }} />
          </Field>
          <Field label="To" className="w-40">
            <DateInput value={to} onChange={(v) => { setPreset('custom'); onChange(from, v) }} />
          </Field>
        </>
      )}
    </div>
  )
}

/** Excel / CSV / Print buttons for statement-style reports (no DataTable). */
function ExportBar({ filename, headers, rows, onPrint }: {
  filename: string; headers: string[]; rows: (string | number)[][]; onPrint: () => void
}) {
  return (
    <div className="flex flex-wrap gap-2">
      <Button variant="outline" size="sm" onClick={() => downloadXlsx(filename, headers, rows)} disabled={!rows.length}>
        <FileSpreadsheet className="h-4 w-4 mr-1.5" />Excel
      </Button>
      <Button variant="outline" size="sm" onClick={() => downloadCsv(filename, headers, rows)} disabled={!rows.length}>
        <Download className="h-4 w-4 mr-1.5" />CSV
      </Button>
      <PrintButton onClick={onPrint} label="Print / PDF" />
    </div>
  )
}

function Loading({ loading, text = 'No data' }: { loading: boolean; text?: string }) {
  return <div className="py-12 text-center text-sm text-muted-foreground">{loading ? 'Loading…' : text}</div>
}

const printHead = (title: string, sub: string, badge: string) =>
  `<div class="head"><div><h1>${esc(title)}</h1><div class="muted">${esc(sub)} · generated ${esc(fmtDate(new Date()))}</div></div><span class="badge">${esc(badge)}</span></div>`

// ============================================================
// statement table (P&L, Balance Sheet, Cash Flow)
// ============================================================

interface SRow {
  label: string
  amount?: number
  kind?: 'header' | 'line' | 'sub' | 'total' | 'grand'
  note?: string
  children?: SRow[]
}

function StatementTable({ rows, amountHeader = 'Amount' }: { rows: SRow[]; amountHeader?: string }) {
  const [open, setOpen] = React.useState<Record<string, boolean>>({})
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Particulars</TableHead>
          <TableHead className="text-right">{amountHeader}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r, i) => {
          const id = `${i}-${r.label}`
          const kids = r.children?.filter((c) => c.amount !== 0) ?? []
          const expandable = kids.length > 0
          const isOpen = !!open[id]
          if (r.kind === 'header') {
            return (
              <TableRow key={id} className="bg-muted/40 hover:bg-muted/40">
                <TableCell colSpan={2} className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{r.label}</TableCell>
              </TableRow>
            )
          }
          const strong = r.kind === 'sub' || r.kind === 'total' || r.kind === 'grand'
          return (
            <React.Fragment key={id}>
              <TableRow
                className={cn(
                  strong && 'font-semibold',
                  r.kind === 'grand' && 'border-t-2 border-foreground/40 text-base',
                  expandable && 'cursor-pointer',
                )}
                onClick={expandable ? () => setOpen((o) => ({ ...o, [id]: !o[id] })) : undefined}
              >
                <TableCell className={cn(!strong && 'pl-6')}>
                  <div className="flex items-center gap-1">
                    {expandable && (isOpen ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />)}
                    <span>{r.label}</span>
                  </div>
                  {r.note && <p className="text-[11px] font-normal text-muted-foreground">{r.note}</p>}
                </TableCell>
                <TableCell className={cn('text-right tabular-nums whitespace-nowrap', (r.amount ?? 0) < 0 && 'text-red-600 dark:text-red-400')}>
                  {r.amount === undefined ? '' : fmtMoney(r.amount)}
                </TableCell>
              </TableRow>
              {expandable && isOpen && kids.map((c, j) => (
                <TableRow key={`${id}-${j}`} className="text-muted-foreground">
                  <TableCell className="pl-12 text-xs">{c.label}</TableCell>
                  <TableCell className="text-right text-xs tabular-nums whitespace-nowrap">{fmtMoney(c.amount)}</TableCell>
                </TableRow>
              ))}
            </React.Fragment>
          )
        })}
      </TableBody>
    </Table>
  )
}

/** Flatten statement rows (incl. children) for export / print. */
function flatRows(rows: SRow[]): (string | number)[][] {
  const out: (string | number)[][] = []
  for (const r of rows) {
    out.push([r.kind === 'header' ? r.label.toUpperCase() : r.label, r.amount === undefined ? '' : r.amount])
    for (const c of r.children ?? []) if (c.amount !== 0) out.push([`    ${c.label}`, c.amount ?? ''])
  }
  return out
}

function statementHtml(rows: SRow[], amountHeader = 'Amount') {
  const body = rows.map((r) => {
    if (r.kind === 'header') return `<tr><th colspan="2">${esc(r.label)}</th></tr>`
    const cls = r.kind === 'grand' ? ' class="grand"' : ''
    const b = r.kind === 'sub' || r.kind === 'total' || r.kind === 'grand'
    const main = `<tr${cls}><td style="${b ? 'font-weight:600' : 'padding-left:22px'}">${esc(r.label)}${r.note ? `<div class="muted">${esc(r.note)}</div>` : ''}</td><td class="num"${b ? ' style="font-weight:600"' : ''}>${r.amount === undefined ? '' : fmtMoney(r.amount)}</td></tr>`
    const kids = (r.children ?? []).filter((c) => c.amount !== 0).map((c) => `<tr><td style="padding-left:40px" class="muted">${esc(c.label)}</td><td class="num muted">${fmtMoney(c.amount)}</td></tr>`).join('')
    return main + kids
  }).join('')
  return `<table><thead><tr><th>Particulars</th><th class="num">${esc(amountHeader)}</th></tr></thead><tbody>${body}</tbody></table>`
}

// ============================================================
// report payload types
// ============================================================

interface AmountRow { key: string; label: string; amount: number }

interface PL {
  sales: { gross: number; returns: number; net: number }
  purchases: { gross: number; returns: number; net: number }
  directExpenses: { total: number; byCategory: AmountRow[] }
  openingStock: number; closingStock: number; stockLoss: number; cogs: number; grossProfit: number
  indirectExpenses: { total: number; byCategory: AmountRow[] }
  loanInterest: number; processingFees: number; otherIncome: number; roundOff: number; netProfit: number
  from: string; to: string
}

interface BsLine { key: string; label: string; amount: number; note?: string; children?: BsLine[] }
interface BS {
  assets: BsLine[]; liabilities: BsLine[]; equity: BsLine[]
  totalAssets: number; totalLiabilities: number; totalEquity: number; totalLiabilitiesAndEquity: number
  netProfitToDate: number; asOf: string
}

interface CF {
  opening: number; closing: number; totalIn: number; totalOut: number; netChange: number; computedClosing: number; difference: number
  inflows: AmountRow[]; outflows: AmountRow[]
  byAccount: { id: string; name: string; type: string; opening: number; closing: number }[]
  from: string; to: string
}

interface TB {
  lines: { key: string; label: string; debit: number; credit: number; group: string }[]
  totalDebit: number; totalCredit: number; difference: number; asOf: string
}

interface TxnRow {
  id: string; date: string; type: string; typeLabel: string; number: string; partyId: string | null; party: string
  description: string; mode: string | null; account: string | null; status: string | null
  moneyIn: number; moneyOut: number; amount: number
}
interface Daybook { items: TxnRow[]; totals: { count: number; moneyIn: number; moneyOut: number; net: number }; from: string; to: string }
interface Transactions {
  items: TxnRow[]
  totals: { count: number; amount: number; moneyIn: number; moneyOut: number }
  byType: { type: string; label: string; count: number; amount: number; moneyIn: number; moneyOut: number }[]
  parties: { id: string; name: string }[]
  types: { value: string; label: string }[]
  from: string; to: string
}

interface PartyRow {
  customerId?: string; supplierId?: string
  name: string; city: string | null; state: string | null
  invoices: number; base: number; tax: number; grand: number
  received?: number; paid?: number; outstanding: number
}
interface PartyReport {
  items: PartyRow[]
  totals: { invoices: number; base: number; tax: number; grand: number; received?: number; paid?: number; outstanding: number }
  from: string; to: string
}

interface StockValItem {
  itemId: string; code: string; name: string; type: string; uom: string; reorderLevel: number
  totalQty: number; avgRate: number; value: number; low: boolean
  warehouses: { code: string; name: string; qty: number; value: number }[]
}
interface StockValuation {
  items: StockValItem[]
  totals: { skus: number; value: number; lowStock: number; totalQty: number }
  byType: { type: string; value: number }[]
}

interface ProfitRow {
  invoiceId: string; invoiceNumber: string; date: string
  customerId: string; customerName: string
  itemId: string; itemCode: string; itemName: string
  qty: number; rate: number; taxable: number; cost: number; margin: number; marginPct: number
}
interface Profitability { items: ProfitRow[]; totals: { revenue: number; cost: number; margin: number; marginPct: number }; from: string; to: string }

interface ItemDetail {
  item: { id: string; code: string; name: string; uom: string; type: string; hsn: string | null }
  from: string; to: string
  openingQty: number; openingValue: number
  items: { id: string; date: string; type: string; refType: string | null; refNumber: string | null; warehouse: string; qtyIn: number; qtyOut: number; runningQty: number; rate: number; notes: string | null }[]
  totals: { in: number; out: number }
  closingQty: number; avgRate: number; closingValue: number
  sales: { qty: number; value: number }; salesReturns: { qty: number; value: number }
  purchases: { qty: number; value: number }; purchaseReturns: { qty: number; value: number }
}

// ============================================================
// gallery definition
// ============================================================

type RangeKind = 'period' | 'asOf' | 'none'
interface ReportDef {
  key: string; section: string; title: string; description: string; icon: React.ReactNode
  range: RangeKind
  /** Card opens another module instead of a report view */
  goto?: string
  /** Sensitive financial report (Phase 5): needs `reports` plus sales invoices, purchase invoices or Cash & Bank */
  financial?: boolean
}

const SECTIONS = ['Financial', 'Transactions', 'Inventory', 'Party', 'GST']

const REPORTS: ReportDef[] = [
  { key: 'pl', financial: true, section: 'Financial', title: 'Profit & Loss', description: 'Sales, cost of goods sold, expenses and net profit', icon: <TrendingUp className="h-5 w-5" />, range: 'period' },
  { key: 'bs', financial: true, section: 'Financial', title: 'Balance Sheet', description: 'Assets, liabilities and capital as of a date', icon: <Scale className="h-5 w-5" />, range: 'asOf' },
  { key: 'cf', financial: true, section: 'Financial', title: 'Cash Flow', description: 'Money in and out of cash & bank accounts', icon: <ArrowLeftRight className="h-5 w-5" />, range: 'period' },
  { key: 'tb', financial: true, section: 'Financial', title: 'Trial Balance', description: 'Ledger heads with debit / credit totals', icon: <ListChecks className="h-5 w-5" />, range: 'asOf' },
  { key: 'daybook', financial: true, section: 'Transactions', title: 'Daybook', description: 'Every document of the day in time order', icon: <CalendarDays className="h-5 w-5" />, range: 'period' },
  { key: 'transactions', financial: true, section: 'Transactions', title: 'All Transactions', description: 'Filter by type and party with totals', icon: <ListOrdered className="h-5 w-5" />, range: 'period' },
  { key: 'sales', section: 'Transactions', title: 'Sales by Customer', description: 'Invoiced, received and outstanding per customer', icon: <Users className="h-5 w-5" />, range: 'period' },
  { key: 'purchase', section: 'Transactions', title: 'Purchase by Supplier', description: 'Billed, paid and outstanding per supplier', icon: <Truck className="h-5 w-5" />, range: 'period' },
  { key: 'profit', financial: true, section: 'Transactions', title: 'Item Profitability', description: 'Invoice-line margin vs standard cost', icon: <Calculator className="h-5 w-5" />, range: 'period' },
  { key: 'stock', section: 'Inventory', title: 'Stock Valuation', description: 'Quantity and value per item at average cost', icon: <Boxes className="h-5 w-5" />, range: 'none' },
  { key: 'item', section: 'Inventory', title: 'Item Detail', description: 'Opening, every movement and closing of one item', icon: <PackageSearch className="h-5 w-5" />, range: 'period' },
  { key: 'low', section: 'Inventory', title: 'Low Stock', description: 'Items at or below reorder level', icon: <AlertTriangle className="h-5 w-5" />, range: 'none' },
  { key: 'party-statement', section: 'Party', title: 'Party Statement', description: 'Open a customer / supplier ledger in Parties', icon: <FileText className="h-5 w-5" />, range: 'none', goto: 'parties' },
  { key: 'receivables', section: 'Party', title: 'Receivables', description: 'Who owes you, with ageing', icon: <HandCoins className="h-5 w-5" />, range: 'none', goto: 'receivables' },
  { key: 'payables', section: 'Party', title: 'Payables', description: 'Whom you owe, with due dates', icon: <CreditCard className="h-5 w-5" />, range: 'none', goto: 'payables' },
  { key: 'gst', section: 'GST', title: 'GSTR-1 / GSTR-2 / GSTR-3B', description: 'Monthly GST returns and GSTR-1 JSON', icon: <Percent className="h-5 w-5" />, range: 'none', goto: 'gst-report' },
]

function readRole(): string {
  try {
    const raw = window.localStorage.getItem('erp_user')
    return raw ? (JSON.parse(raw) as { user?: { role?: string } }).user?.role || '' : ''
  } catch { return '' }
}

function Gallery({ onOpen }: { onOpen: (r: ReportDef) => void }) {
  const role = React.useMemo(() => readRole(), [])
  return (
    <div>
      <PageHeader title="Reports Center" description="Financial statements, transactions, inventory, party and GST reports" />
      <div className="space-y-6">
        {SECTIONS.map((section) => {
          const cards = REPORTS.filter((r) => r.section === section && (!r.goto || !role || canAccessModule(role, r.goto)) && (!r.financial || !role || canSeeFinancialReports(role)))
          if (!cards.length) return null
          return (
            <div key={section}>
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{section}</h2>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {cards.map((r) => (
                  <button
                    key={r.key}
                    type="button"
                    onClick={() => onOpen(r)}
                    className="flex items-start gap-3 rounded-xl border bg-card p-4 text-left transition hover:border-emerald-300 hover:bg-emerald-50/60 focus:outline-none focus-visible:ring-2 dark:hover:border-emerald-800 dark:hover:bg-emerald-950/30"
                  >
                    <span className="rounded-lg bg-emerald-100 p-2 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">{r.icon}</span>
                    <span className="min-w-0">
                      <span className="block text-sm font-semibold">{r.title}</span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">{r.description}</span>
                      {r.goto && <span className="mt-1 block text-[11px] text-emerald-700 dark:text-emerald-400">Opens module →</span>}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ============================================================
// module
// ============================================================

export default function ReportsModule({ companyId }: { companyId: string }) {
  const [view, setView] = React.useState<string | null>(null)
  const [from, setFrom] = React.useState(fyStartISO())
  const [to, setTo] = React.useState(todayISO())
  const [asOf, setAsOf] = React.useState(todayISO())

  function open(r: ReportDef) {
    if (r.goto) {
      window.dispatchEvent(new CustomEvent('erp:goto', { detail: r.goto }))
      return
    }
    setView(r.key)
  }

  const def = REPORTS.find((r) => r.key === view)
  if (!def) return <Gallery onOpen={open} />

  const period = { companyId, from, to }
  return (
    <div>
      <PageHeader
        title={def.title}
        description={def.description}
        actions={
          <Button variant="outline" size="sm" onClick={() => setView(null)}>
            <ArrowLeft className="h-4 w-4 mr-1.5" />All reports
          </Button>
        }
      />
      {def.range === 'period' && (
        <DateRangeBar key={`p-${def.key}`} from={from} to={to} onChange={(f, t) => { setFrom(f); setTo(t) }} />
      )}
      {def.range === 'asOf' && (
        <DateRangeBar key={`a-${def.key}`} from={from} to={to} onChange={() => undefined} asOf={asOf} onAsOf={setAsOf} />
      )}
      {view === 'pl' && <ProfitLossView {...period} />}
      {view === 'bs' && <BalanceSheetView companyId={companyId} asOf={asOf} />}
      {view === 'cf' && <CashFlowView {...period} />}
      {view === 'tb' && <TrialBalanceView companyId={companyId} asOf={asOf} />}
      {view === 'daybook' && <DaybookView {...period} />}
      {view === 'transactions' && <TransactionsView {...period} />}
      {view === 'sales' && <PartyReportView {...period} kind="sales" />}
      {view === 'purchase' && <PartyReportView {...period} kind="purchase" />}
      {view === 'profit' && <ProfitabilityView {...period} />}
      {view === 'stock' && <StockValuationView companyId={companyId} lowOnly={false} />}
      {view === 'low' && <StockValuationView companyId={companyId} lowOnly />}
      {view === 'item' && <ItemDetailView {...period} />}
    </div>
  )
}

interface PeriodProps { companyId: string; from: string; to: string }

// ============================================================
// Profit & Loss
// ============================================================

function plRows(d: PL): SRow[] {
  return [
    { label: 'Trading account', kind: 'header' },
    { label: 'Sales', amount: d.sales.gross, note: 'Taxable value of sales invoices (excl. GST, cess, round-off)' },
    { label: 'Less: Sales returns (credit notes)', amount: -d.sales.returns },
    { label: 'Net sales', amount: d.sales.net, kind: 'sub' },
    { label: 'Opening stock', amount: d.openingStock },
    {
      label: 'Purchases (net of returns)', amount: d.purchases.net,
      children: [{ label: 'Purchase bills', amount: d.purchases.gross }, { label: 'Less: purchase returns', amount: -d.purchases.returns }],
    },
    { label: 'Direct expenses', amount: d.directExpenses.total, children: d.directExpenses.byCategory.map((c) => ({ label: c.label, amount: c.amount })) },
    { label: 'Less: Closing stock', amount: -d.closingStock },
    { label: 'Less: Stock loss (shown below)', amount: -d.stockLoss },
    { label: 'Cost of goods sold', amount: d.cogs, kind: 'sub' },
    { label: 'Gross profit', amount: d.grossProfit, kind: 'total' },
    { label: 'Expenses', kind: 'header' },
    { label: 'Indirect expenses', amount: d.indirectExpenses.total, children: d.indirectExpenses.byCategory.map((c) => ({ label: c.label, amount: c.amount })) },
    { label: 'Stock loss (damage / expiry / theft)', amount: d.stockLoss },
    { label: 'Loan interest', amount: d.loanInterest },
    { label: 'Loan processing fees', amount: d.processingFees },
    { label: 'Other income', kind: 'header' },
    { label: 'Other income', amount: d.otherIncome },
    { label: 'Round off (net)', amount: d.roundOff },
    { label: d.netProfit >= 0 ? 'Net profit' : 'Net loss', amount: d.netProfit, kind: 'grand' },
  ]
}

const STOCK_NOTE = 'Stock values are approximate: quantity at the date (current balance minus later movements) × current average rate.'

function ProfitLossView({ companyId, from, to }: PeriodProps) {
  const { data, loading } = useList<PL>(`/api/reports/profit-loss?companyId=${companyId}&from=${from}&to=${to}`)
  if (!data) return <Loading loading={loading} />
  const rows = plRows(data)
  const expenseRows = [...data.directExpenses.byCategory.map((c) => ({ ...c, type: 'Direct' })), ...data.indirectExpenses.byCategory.map((c) => ({ ...c, type: 'Indirect' }))]
  return (
    <div className={cn('space-y-4', loading && 'opacity-60')}>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard title="Net Sales" value={fmtMoney(data.sales.net)} sub="Taxable, net of returns" icon={<IndianRupee className="h-4 w-4" />} />
        <StatCard title="Gross Profit" value={fmtMoney(data.grossProfit)} sub={data.sales.net ? `${fmtNum(r2((data.grossProfit / data.sales.net) * 100))}% of sales` : '—'} icon={<TrendingUp className="h-4 w-4" />} toneClass="bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300" />
        <StatCard title="Expenses" value={fmtMoney(r2(data.indirectExpenses.total + data.stockLoss + data.loanInterest + data.processingFees))} sub="Indirect + loss + finance" icon={<Wallet className="h-4 w-4" />} toneClass="bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300" />
        <StatCard title={data.netProfit >= 0 ? 'Net Profit' : 'Net Loss'} value={fmtMoney(data.netProfit)} sub={`${fmtDate(data.from)} – ${fmtDate(data.to)}`} icon={<PiggyBank className="h-4 w-4" />} toneClass={data.netProfit >= 0 ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300' : 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300'} />
      </div>
      <SectionCard
        title={`Profit & Loss · ${fmtDate(data.from)} – ${fmtDate(data.to)}`}
        actions={
          <ExportBar
            filename={`profit-loss-${data.from}-${data.to}`}
            headers={['Particulars', 'Amount']}
            rows={flatRows(rows)}
            onPrint={() => printHtml('Profit & Loss', printHead('Profit & Loss Statement', `Period ${fmtDate(data.from)} – ${fmtDate(data.to)}`, 'P&L') + statementHtml(rows) + `<p class="muted" style="margin-top:10px">${esc(STOCK_NOTE)}</p>`)}
          />
        }
      >
        <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
          <StatementTable rows={rows} />
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Expenses by category</p>
            {expenseRows.length === 0 ? (
              <p className="text-sm text-muted-foreground">No expenses in this period</p>
            ) : (
              <div className="space-y-1.5">
                {expenseRows.map((c) => {
                  const total = data.directExpenses.total + data.indirectExpenses.total
                  const pct = total > 0 ? Math.max(2, Math.round((c.amount / total) * 100)) : 0
                  return (
                    <div key={`${c.type}-${c.key}`} className="text-sm">
                      <div className="flex justify-between gap-2">
                        <span className="truncate">{c.label} <span className="text-[11px] text-muted-foreground">({c.type})</span></span>
                        <span className="tabular-nums whitespace-nowrap">{fmtMoney(c.amount)}</span>
                      </div>
                      <div className="mt-0.5 h-1.5 rounded-full bg-muted">
                        <div className="h-1.5 rounded-full bg-emerald-500" style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          {STOCK_NOTE} Expenses exclude GST when input credit is claimable. Click a row with an arrow to see its break-up.
        </p>
      </SectionCard>
    </div>
  )
}

// ============================================================
// Balance Sheet
// ============================================================

const bsToRows = (lines: BsLine[]): SRow[] =>
  lines.map((l) => ({ label: l.label, amount: l.amount, note: l.note, children: l.children?.map((c) => ({ label: c.label, amount: c.amount })) }))

function BalanceSheetView({ companyId, asOf }: { companyId: string; asOf: string }) {
  const { data, loading } = useList<BS>(`/api/reports/balance-sheet?companyId=${companyId}&asOf=${asOf}`)
  if (!data) return <Loading loading={loading} />
  const left: SRow[] = [
    { label: 'Liabilities', kind: 'header' },
    ...bsToRows(data.liabilities),
    { label: 'Total liabilities', amount: data.totalLiabilities, kind: 'sub' },
    { label: 'Capital & equity', kind: 'header' },
    ...bsToRows(data.equity),
    { label: 'Total capital', amount: data.totalEquity, kind: 'sub' },
    { label: 'Total liabilities & capital', amount: data.totalLiabilitiesAndEquity, kind: 'grand' },
  ]
  const right: SRow[] = [
    { label: 'Assets', kind: 'header' },
    ...bsToRows(data.assets),
    { label: 'Total assets', amount: data.totalAssets, kind: 'grand' },
  ]
  const exportRows = [...flatRows(left), ['', ''], ...flatRows(right)]
  const diff = data.equity.find((e) => e.key === 'openingDiff')?.amount ?? 0
  return (
    <div className={cn('space-y-4', loading && 'opacity-60')}>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard title="Total Assets" value={fmtMoney(data.totalAssets)} sub={`As of ${fmtDate(data.asOf)}`} icon={<Boxes className="h-4 w-4" />} />
        <StatCard title="Liabilities" value={fmtMoney(data.totalLiabilities)} sub="Payables, loans, GST" icon={<CreditCard className="h-4 w-4" />} toneClass="bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300" />
        <StatCard title="Profit to Date" value={fmtMoney(data.netProfitToDate)} sub="Retained profit" icon={<PiggyBank className="h-4 w-4" />} toneClass="bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300" />
        <StatCard title="Opening Bal. Difference" value={fmtMoney(diff)} sub="Balancing figure" icon={<Scale className="h-4 w-4" />} toneClass="bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300" />
      </div>
      <SectionCard
        title={`Balance Sheet as of ${fmtDate(data.asOf)}`}
        actions={
          <ExportBar
            filename={`balance-sheet-${data.asOf}`}
            headers={['Particulars', 'Amount']}
            rows={exportRows}
            onPrint={() => printHtml('Balance Sheet', printHead('Balance Sheet', `As of ${fmtDate(data.asOf)}`, 'BALANCE SHEET')
              + `<div style="display:flex;gap:16px"><div style="flex:1">${statementHtml(left)}</div><div style="flex:1">${statementHtml(right)}</div></div><p class="muted" style="margin-top:10px">${esc(STOCK_NOTE)}</p>`)}
          />
        }
      >
        <div className="grid gap-6 lg:grid-cols-2">
          <StatementTable rows={left} />
          <StatementTable rows={right} />
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          &quot;Opening balance difference&quot; is the balancing figure (as in Vyapar): opening balances of parties and cash / bank
          accounts, and anything not captured by documents (e.g. GST paid to government, refunds due). {STOCK_NOTE}
        </p>
      </SectionCard>
    </div>
  )
}

// ============================================================
// Cash Flow
// ============================================================

function CashFlowView({ companyId, from, to }: PeriodProps) {
  const { data, loading } = useList<CF>(`/api/reports/cash-flow?companyId=${companyId}&from=${from}&to=${to}`)
  if (!data) return <Loading loading={loading} />
  const rows: SRow[] = [
    { label: 'Opening cash & bank balance', amount: data.opening, kind: 'sub' },
    { label: 'Cash inflows', kind: 'header' },
    ...data.inflows.map((r) => ({ label: r.label, amount: r.amount })),
    { label: 'Total inflows', amount: data.totalIn, kind: 'sub' },
    { label: 'Cash outflows', kind: 'header' },
    ...data.outflows.map((r) => ({ label: r.label, amount: r.amount })),
    { label: 'Total outflows', amount: data.totalOut, kind: 'sub' },
    { label: 'Net change', amount: data.netChange, kind: 'total' },
    { label: 'Closing cash & bank balance', amount: data.closing, kind: 'grand' },
  ]
  if (Math.abs(data.difference) >= 0.01) rows.push({ label: 'Unreconciled difference', amount: data.difference, note: 'Closing per accounts − (opening + inflows − outflows)' })
  return (
    <div className={cn('space-y-4', loading && 'opacity-60')}>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard title="Opening" value={fmtMoney(data.opening)} sub={`Before ${fmtDate(data.from)}`} icon={<Wallet className="h-4 w-4" />} />
        <StatCard title="Inflows" value={fmtMoney(data.totalIn)} sub="Money in" icon={<TrendingUp className="h-4 w-4" />} toneClass="bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300" />
        <StatCard title="Outflows" value={fmtMoney(data.totalOut)} sub="Money out" icon={<CreditCard className="h-4 w-4" />} toneClass="bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300" />
        <StatCard title="Closing" value={fmtMoney(data.closing)} sub={`As of ${fmtDate(data.to)}`} icon={<PiggyBank className="h-4 w-4" />} toneClass="bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300" />
      </div>
      <SectionCard
        title={`Cash Flow · ${fmtDate(data.from)} – ${fmtDate(data.to)}`}
        actions={
          <ExportBar
            filename={`cash-flow-${data.from}-${data.to}`}
            headers={['Particulars', 'Amount']}
            rows={flatRows(rows)}
            onPrint={() => printHtml('Cash Flow', printHead('Cash Flow Statement', `Period ${fmtDate(data.from)} – ${fmtDate(data.to)}`, 'CASH FLOW') + statementHtml(rows))}
          />
        }
      >
        <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
          <StatementTable rows={rows} />
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">By account</p>
            <Table>
              <TableHeader>
                <TableRow><TableHead>Account</TableHead><TableHead className="text-right">Opening</TableHead><TableHead className="text-right">Closing</TableHead></TableRow>
              </TableHeader>
              <TableBody>
                {data.byAccount.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell className="text-sm">{a.name} <span className="text-[11px] text-muted-foreground">{a.type}</span></TableCell>
                    <TableCell className="text-right tabular-nums text-sm">{fmtMoney(a.opening)}</TableCell>
                    <TableCell className="text-right tabular-nums text-sm">{fmtMoney(a.closing)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          Same rules as Cash &amp; Bank balances: credit / debit notes move no money, post-dated cheques count once cleared,
          contra transfers between own accounts are left out.
        </p>
      </SectionCard>
    </div>
  )
}

// ============================================================
// Trial Balance
// ============================================================

function TrialBalanceView({ companyId, asOf }: { companyId: string; asOf: string }) {
  const { data, loading } = useList<TB>(`/api/reports/trial-balance?companyId=${companyId}&asOf=${asOf}`)
  if (!data) return <Loading loading={loading} />
  const exportRows: (string | number)[][] = data.lines.map((l) => [l.group, l.label, l.debit || '', l.credit || ''])
  exportRows.push(['', 'Total', data.totalDebit, data.totalCredit])
  if (Math.abs(data.difference) >= 0.01) exportRows.push(['', 'Difference (opening balances)', data.difference < 0 ? -data.difference : '', data.difference > 0 ? data.difference : ''])
  function print() {
    const d = data!
    const body = d.lines.map((l) => `<tr><td class="muted">${esc(l.group)}</td><td>${esc(l.label)}</td><td class="num">${l.debit ? fmtMoney(l.debit) : ''}</td><td class="num">${l.credit ? fmtMoney(l.credit) : ''}</td></tr>`).join('')
    const diff = Math.abs(d.difference) >= 0.01
      ? `<tr><td></td><td>Difference (opening balances)</td><td class="num">${d.difference < 0 ? fmtMoney(-d.difference) : ''}</td><td class="num">${d.difference > 0 ? fmtMoney(d.difference) : ''}</td></tr>` : ''
    printHtml('Trial Balance', printHead('Trial Balance', `As of ${fmtDate(d.asOf)}`, 'TRIAL BALANCE')
      + `<table><thead><tr><th>Group</th><th>Ledger</th><th class="num">Debit</th><th class="num">Credit</th></tr></thead><tbody>${body}<tr class="grand"><td colspan="2">Total</td><td class="num">${fmtMoney(d.totalDebit)}</td><td class="num">${fmtMoney(d.totalCredit)}</td></tr>${diff}</tbody></table>`)
  }
  const unbalanced = Math.abs(data.difference) >= 0.01
  return (
    <SectionCard
      className={cn(loading && 'opacity-60')}
      title={`Trial Balance as of ${fmtDate(data.asOf)}`}
      actions={<ExportBar filename={`trial-balance-${data.asOf}`} headers={['Group', 'Ledger', 'Debit', 'Credit']} rows={exportRows} onPrint={print} />}
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="hidden sm:table-cell">Group</TableHead>
            <TableHead>Ledger</TableHead>
            <TableHead className="text-right">Debit</TableHead>
            <TableHead className="text-right">Credit</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.lines.map((l) => (
            <TableRow key={l.key}>
              <TableCell className="hidden sm:table-cell text-xs text-muted-foreground">{l.group}</TableCell>
              <TableCell className="text-sm">{l.label}</TableCell>
              <TableCell className="text-right tabular-nums whitespace-nowrap">{l.debit ? fmtMoney(l.debit) : ''}</TableCell>
              <TableCell className="text-right tabular-nums whitespace-nowrap">{l.credit ? fmtMoney(l.credit) : ''}</TableCell>
            </TableRow>
          ))}
        </TableBody>
        <TableFooter>
          <TableRow className="font-semibold">
            <TableCell className="hidden sm:table-cell" />
            <TableCell>Total</TableCell>
            <TableCell className="text-right tabular-nums">{fmtMoney(data.totalDebit)}</TableCell>
            <TableCell className="text-right tabular-nums">{fmtMoney(data.totalCredit)}</TableCell>
          </TableRow>
          {unbalanced && (
            <TableRow className="text-amber-700 dark:text-amber-400">
              <TableCell className="hidden sm:table-cell" />
              <TableCell>Difference (opening balances)</TableCell>
              <TableCell className="text-right tabular-nums">{data.difference < 0 ? fmtMoney(-data.difference) : ''}</TableCell>
              <TableCell className="text-right tabular-nums">{data.difference > 0 ? fmtMoney(data.difference) : ''}</TableCell>
            </TableRow>
          )}
        </TableFooter>
      </Table>
      <p className="mt-3 text-xs text-muted-foreground">
        Built from documents (no journal). Opening balances of parties and cash / bank accounts have no contra entry, so they
        appear as the difference line — the same figure as &quot;Opening balance difference&quot; in the Balance Sheet. {STOCK_NOTE}
      </p>
    </SectionCard>
  )
}

// ============================================================
// Daybook / All transactions
// ============================================================

const TYPE_TONE: Record<string, string> = {
  SALE: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300',
  PAYMENT_IN: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300',
  PURCHASE: 'bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300',
  PAYMENT_OUT: 'bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300',
  EXPENSE: 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300',
  CHEQUE_CLEARED: 'bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300',
}

const TXN_HEADERS = ['Date', 'Type', 'Number', 'Party', 'Description', 'Mode', 'Account', 'Money In', 'Money Out', 'Amount']
const txnPick = (r: TxnRow): (string | number)[] => [String(r.date).slice(0, 10), r.typeLabel, r.number, r.party, r.description, r.mode || '', r.account || '', r.moneyIn, r.moneyOut, r.amount]

const txnColumns: Column<TxnRow>[] = [
  { key: 'date', header: 'Date', render: (r) => <DateCell value={r.date} /> },
  {
    key: 'typeLabel', header: 'Type',
    render: (r) => <span className={cn('inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium', TYPE_TONE[r.type] || 'bg-muted text-muted-foreground')}>{r.typeLabel}</span>,
  },
  { key: 'number', header: 'Number', render: (r) => <span className="font-mono text-xs whitespace-nowrap">{r.number}</span> },
  {
    key: 'party', header: 'Party / Description',
    render: (r) => (
      <div className="min-w-0">
        <p className="truncate max-w-56 text-sm">{r.party}</p>
        <p className="truncate max-w-56 text-[11px] text-muted-foreground">{r.description}{r.account ? ` · ${r.account}` : ''}</p>
      </div>
    ),
  },
  { key: 'moneyIn', header: 'Money In', className: 'text-right', sum: true, sumFormat: 'money', render: (r) => (r.moneyIn ? <Money value={r.moneyIn} className="text-emerald-700 dark:text-emerald-400" /> : <span className="text-muted-foreground">—</span>) },
  { key: 'moneyOut', header: 'Money Out', className: 'text-right', sum: true, sumFormat: 'money', render: (r) => (r.moneyOut ? <Money value={r.moneyOut} className="text-red-600 dark:text-red-400" /> : <span className="text-muted-foreground">—</span>) },
  {
    key: 'amount', header: 'Amount', className: 'text-right',
    render: (r) => <span className={cn(r.status === 'CANCELLED' && 'line-through text-muted-foreground')}><Money value={r.amount} className="font-medium" /></span>,
  },
]

function printTxns(title: string, sub: string, rows: TxnRow[], tin: number, tout: number) {
  const body = rows.map((r) => `<tr><td>${esc(fmtDate(r.date))}</td><td>${esc(r.typeLabel)}</td><td>${esc(r.number)}</td><td>${esc(r.party)}<div class="muted">${esc(r.description)}</div></td><td class="num">${r.moneyIn ? fmtMoney(r.moneyIn) : ''}</td><td class="num">${r.moneyOut ? fmtMoney(r.moneyOut) : ''}</td><td class="num">${fmtMoney(r.amount)}</td></tr>`).join('')
  printHtml(title, printHead(title, sub, title.toUpperCase())
    + `<table><thead><tr><th>Date</th><th>Type</th><th>Number</th><th>Party / Description</th><th class="num">Money In</th><th class="num">Money Out</th><th class="num">Amount</th></tr></thead><tbody>${body || '<tr><td colspan="7" class="muted">No transactions</td></tr>'}<tr class="grand"><td colspan="4">Total</td><td class="num">${fmtMoney(tin)}</td><td class="num">${fmtMoney(tout)}</td><td></td></tr></tbody></table>`)
}

function DaybookView({ companyId, from, to }: PeriodProps) {
  const { data, loading } = useList<Daybook>(`/api/reports/daybook?companyId=${companyId}&from=${from}&to=${to}`)
  const t = data?.totals
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard title="Transactions" value={t ? t.count : '—'} sub={data ? `${fmtDate(data.from)} – ${fmtDate(data.to)}` : ''} icon={<ReceiptText className="h-4 w-4" />} />
        <StatCard title="Money In" value={t ? fmtMoney(t.moneyIn) : '—'} sub="Into cash & bank" icon={<TrendingUp className="h-4 w-4" />} toneClass="bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300" />
        <StatCard title="Money Out" value={t ? fmtMoney(t.moneyOut) : '—'} sub="From cash & bank" icon={<CreditCard className="h-4 w-4" />} toneClass="bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300" />
        <StatCard title="Net" value={t ? fmtMoney(t.net) : '—'} sub="In − out" icon={<Scale className="h-4 w-4" />} toneClass="bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300" />
      </div>
      <SectionCard
        title="Daybook"
        actions={<PrintButton label="Print / PDF" onClick={() => data && printTxns('Daybook', `Period ${fmtDate(data.from)} – ${fmtDate(data.to)}`, data.items, data.totals.moneyIn, data.totals.moneyOut)} />}
      >
        <DataTable
          columns={txnColumns}
          rows={data?.items ?? []}
          loading={loading}
          pageSize={25}
          searchPlaceholder="Search daybook…"
          emptyText="No transactions on these dates"
          csvExport={{ filename: `daybook-${from}-${to}`, headers: TXN_HEADERS, pick: txnPick }}
          xlsxExport={{ filename: `daybook-${from}-${to}`, headers: TXN_HEADERS, pick: txnPick }}
        />
      </SectionCard>
    </div>
  )
}

function TransactionsView({ companyId, from, to }: PeriodProps) {
  const [type, setType] = React.useState('__ALL__')
  const [party, setParty] = React.useState('__ALL__')
  const url = `/api/reports/transactions?companyId=${companyId}&from=${from}&to=${to}`
    + (type !== '__ALL__' ? `&type=${type}` : '') + (party !== '__ALL__' ? `&partyId=${party}` : '')
  const { data, loading } = useList<Transactions>(url)
  // party list from the unfiltered period stays available while a party filter is active
  const [parties, setParties] = React.useState<{ id: string; name: string }[]>([])
  React.useEffect(() => {
    if (data && party === '__ALL__') setParties(data.parties)
  }, [data, party])
  const t = data?.totals
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="w-48">
          <SelectInput
            value={type} onChange={setType}
            options={[{ value: '__ALL__', label: 'All types' }, ...(data?.types ?? []).map((x) => ({ value: x.value, label: x.label }))]}
          />
        </div>
        <div className="w-60">
          <SelectInput
            value={party} onChange={setParty}
            options={[{ value: '__ALL__', label: 'All parties' }, ...parties.map((p) => ({ value: p.id, label: p.name }))]}
          />
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard title="Transactions" value={t ? t.count : '—'} sub="Matching filters" icon={<ReceiptText className="h-4 w-4" />} />
        <StatCard title="Total Amount" value={t ? fmtMoney(t.amount) : '—'} sub="Document value" icon={<IndianRupee className="h-4 w-4" />} toneClass="bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300" />
        <StatCard title="Money In" value={t ? fmtMoney(t.moneyIn) : '—'} sub="Into cash & bank" icon={<TrendingUp className="h-4 w-4" />} toneClass="bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300" />
        <StatCard title="Money Out" value={t ? fmtMoney(t.moneyOut) : '—'} sub="From cash & bank" icon={<CreditCard className="h-4 w-4" />} toneClass="bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300" />
      </div>
      {data && data.byType.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {data.byType.map((g) => (
            <div key={g.type} className="rounded-lg border bg-card px-3 py-2">
              <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{g.label} · {g.count}</p>
              <p className="text-sm font-semibold tabular-nums">{fmtMoney(g.amount)}</p>
            </div>
          ))}
        </div>
      )}
      <SectionCard
        title="All transactions"
        actions={<PrintButton label="Print / PDF" onClick={() => data && printTxns('All Transactions', `Period ${fmtDate(data.from)} – ${fmtDate(data.to)}`, data.items, data.totals.moneyIn, data.totals.moneyOut)} />}
      >
        <DataTable
          columns={txnColumns}
          rows={data?.items ?? []}
          loading={loading}
          pageSize={25}
          sortable
          searchPlaceholder="Search transactions…"
          emptyText="No transactions for these filters"
          csvExport={{ filename: `transactions-${from}-${to}`, headers: TXN_HEADERS, pick: txnPick }}
          xlsxExport={{ filename: `transactions-${from}-${to}`, headers: TXN_HEADERS, pick: txnPick }}
        />
      </SectionCard>
    </div>
  )
}

// ============================================================
// Sales by customer / Purchase by supplier (existing reports)
// ============================================================

type PartyGridRow = PartyRow & { id: string }

function PartyReportView({ companyId, from, to, kind }: PeriodProps & { kind: 'sales' | 'purchase' }) {
  const isSales = kind === 'sales'
  const { data, loading } = useList<PartyReport>(`/api/reports/${isSales ? 'sales-by-customer' : 'purchase-by-supplier'}?companyId=${companyId}&from=${from}&to=${to}`)
  const rows = React.useMemo<PartyGridRow[]>(() => (data?.items || []).map((r) => ({ ...r, id: r.customerId || r.supplierId || r.name })), [data])
  const paidKey = isSales ? 'received' : 'paid'
  const paidLabel = isSales ? 'Received' : 'Paid'
  const title = isSales ? 'Sales by Customer' : 'Purchase by Supplier'

  const columns: Column<PartyGridRow>[] = [
    {
      key: 'name', header: isSales ? 'Customer' : 'Supplier',
      render: (r) => (
        <div>
          <p className="font-medium truncate max-w-56">{r.name}</p>
          {r.city && <p className="text-xs text-muted-foreground truncate max-w-56">{r.city}{r.state ? `, ${r.state}` : ''}</p>}
        </div>
      ),
    },
    { key: 'invoices', header: 'Invoices', className: 'text-right', render: (r) => <span className="tabular-nums">{r.invoices}</span> },
    { key: 'base', header: 'Taxable', className: 'text-right', hideOnMobile: true, render: (r) => <Money value={r.base} /> },
    { key: 'tax', header: 'GST', className: 'text-right', hideOnMobile: true, render: (r) => <Money value={r.tax} /> },
    { key: 'grand', header: 'Grand Total', className: 'text-right', render: (r) => <Money value={r.grand} className="font-medium" /> },
    { key: paidKey, header: paidLabel, className: 'text-right', render: (r) => <Money value={r[paidKey]} /> },
    {
      key: 'outstanding', header: 'Outstanding', className: 'text-right',
      render: (r) => <Money value={r.outstanding} className={r.outstanding > 0 ? 'font-medium text-amber-600 dark:text-amber-400' : 'font-medium'} />,
    },
  ]
  const headers = [isSales ? 'Customer' : 'Supplier', 'Invoices', 'Taxable', 'GST', 'Grand Total', paidLabel, 'Outstanding']
  const pick = (r: PartyGridRow) => [r.name, r.invoices, r.base, r.tax, r.grand, r[paidKey] ?? 0, r.outstanding]

  function print() {
    const d = data
    if (!d) return
    const body = d.items.map((r) => `<tr><td>${esc(r.name)}</td><td>${esc(r.city || '—')}</td><td class="num">${r.invoices}</td><td class="num">${fmtMoney(r.base)}</td><td class="num">${fmtMoney(r.tax)}</td><td class="num">${fmtMoney(r.grand)}</td><td class="num">${fmtMoney(r[paidKey])}</td><td class="num">${fmtMoney(r.outstanding)}</td></tr>`).join('')
    printHtml(title, printHead(title, `Period ${fmtDate(d.from)} – ${fmtDate(d.to)} · ${d.totals.invoices} invoice(s)`, isSales ? 'SALES REPORT' : 'PURCHASE REPORT')
      + `<table><thead><tr><th>${isSales ? 'Customer' : 'Supplier'}</th><th>City</th><th class="num">Invoices</th><th class="num">Taxable</th><th class="num">GST</th><th class="num">Grand Total</th><th class="num">${paidLabel}</th><th class="num">Outstanding</th></tr></thead>
      <tbody>${body || '<tr><td colspan="8" class="muted">No invoices in this period</td></tr>'}
      <tr class="grand"><td colspan="5">Total</td><td class="num">${fmtMoney(d.totals.grand)}</td><td class="num">${fmtMoney(d.totals[paidKey])}</td><td class="num">${fmtMoney(d.totals.outstanding)}</td></tr></tbody></table>`)
  }

  const t = data?.totals
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard title="Grand Total" value={t ? fmtMoney(t.grand) : '—'} sub="Invoiced in period (incl. GST)" icon={<IndianRupee className="h-4 w-4" />} />
        <StatCard title={paidLabel} value={t ? fmtMoney(t[paidKey]) : '—'} sub={isSales ? 'Payments against invoices' : 'Payments to suppliers'} toneClass="bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300" icon={isSales ? <BadgeCheck className="h-4 w-4" /> : <Wallet className="h-4 w-4" />} />
        <StatCard title="Outstanding" value={t ? fmtMoney(t.outstanding) : '—'} sub={`Grand total − ${paidLabel.toLowerCase()}`} toneClass="bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300" icon={<Clock className="h-4 w-4" />} />
        <StatCard title="Invoices" value={t ? t.invoices : '—'} sub="Non-cancelled in period" toneClass="bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300" icon={<ReceiptText className="h-4 w-4" />} />
      </div>
      <SectionCard title={title} actions={<PrintButton label="Print / PDF" onClick={print} />}>
        <DataTable
          columns={columns}
          rows={rows}
          loading={loading}
          searchPlaceholder={isSales ? 'Search customers…' : 'Search suppliers…'}
          emptyText={isSales ? 'No sales in this period — adjust the date range' : 'No purchases in this period — adjust the date range'}
          csvExport={{ filename: isSales ? 'sales-by-customer' : 'purchase-by-supplier', headers, pick }}
          xlsxExport={{ filename: isSales ? 'sales-by-customer' : 'purchase-by-supplier', headers, pick }}
        />
      </SectionCard>
    </div>
  )
}

// ============================================================
// Item profitability (existing report)
// ============================================================

type ProfitGridRow = ProfitRow & { id: string }

function ProfitabilityView({ companyId, from, to }: PeriodProps) {
  const { data, loading } = useList<Profitability>(`/api/reports/profitability?companyId=${companyId}&from=${from}&to=${to}`)
  const rows = React.useMemo<ProfitGridRow[]>(() => (data?.items || []).map((r, i) => ({ ...r, id: `${r.invoiceId}-${r.itemId}-${i}` })), [data])
  const columns: Column<ProfitGridRow>[] = [
    { key: 'date', header: 'Date', hideOnMobile: true, render: (r) => <DateCell value={r.date} /> },
    { key: 'invoiceNumber', header: 'Invoice', render: (r) => <span className="font-mono text-xs whitespace-nowrap">{r.invoiceNumber}</span> },
    { key: 'customerName', header: 'Customer', render: (r) => <span className="truncate block max-w-[150px]">{r.customerName}</span> },
    { key: 'item', header: 'Item', render: (r) => <div><p className="truncate max-w-48">{r.itemName}</p><p className="text-xs text-muted-foreground">{r.itemCode}</p></div> },
    { key: 'qty', header: 'Qty', className: 'text-right', render: (r) => <span className="tabular-nums">{fmtNum(r.qty)}</span> },
    { key: 'rate', header: 'Rate', className: 'text-right', hideOnMobile: true, render: (r) => <Money value={r.rate} /> },
    { key: 'taxable', header: 'Taxable', className: 'text-right', hideOnMobile: true, render: (r) => <Money value={r.taxable} /> },
    { key: 'cost', header: 'Cost', className: 'text-right', hideOnMobile: true, render: (r) => <Money value={r.cost} /> },
    { key: 'margin', header: 'Margin', className: 'text-right', render: (r) => <Money value={r.margin} className={`font-medium ${MARGIN_CLS(r.margin)}`} /> },
    { key: 'marginPct', header: 'Margin %', className: 'text-right', render: (r) => <span className={`tabular-nums font-medium ${MARGIN_CLS(r.margin)}`}>{fmtNum(r.marginPct)}%</span> },
  ]
  const headers = ['Date', 'Invoice', 'Customer', 'Item', 'Qty', 'Rate', 'Taxable', 'Cost', 'Margin', 'Margin %']
  const pick = (r: ProfitGridRow) => [String(r.date).slice(0, 10), r.invoiceNumber, r.customerName, r.itemCode, r.qty, r.rate, r.taxable, r.cost, r.margin, r.marginPct]
  function print() {
    const d = data
    if (!d) return
    const body = d.items.map((r) => `<tr><td>${esc(fmtDate(r.date))}</td><td>${esc(r.invoiceNumber)}</td><td>${esc(r.customerName)}</td><td>${esc(r.itemCode)}</td><td class="num">${fmtNum(r.qty)}</td><td class="num">${fmtMoney(r.rate)}</td><td class="num">${fmtMoney(r.taxable)}</td><td class="num">${fmtMoney(r.cost)}</td><td class="num">${fmtMoney(r.margin)}</td><td class="num">${fmtNum(r.marginPct)}%</td></tr>`).join('')
    printHtml('Profitability Report', printHead('Profitability Report', `Period ${fmtDate(d.from)} – ${fmtDate(d.to)} · margin ${fmtNum(d.totals.marginPct)}%`, 'MARGIN')
      + `<table><thead><tr><th>Date</th><th>Invoice</th><th>Customer</th><th>Item</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">Taxable</th><th class="num">Cost</th><th class="num">Margin</th><th class="num">Margin %</th></tr></thead>
      <tbody>${body || '<tr><td colspan="10" class="muted">No invoice lines in this period</td></tr>'}
      <tr class="grand"><td colspan="6">Total</td><td class="num">${fmtMoney(d.totals.revenue)}</td><td class="num">${fmtMoney(d.totals.cost)}</td><td class="num">${fmtMoney(d.totals.margin)}</td><td class="num">${fmtNum(d.totals.marginPct)}%</td></tr></tbody></table>`)
  }
  const t = data?.totals
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard title="Revenue" value={t ? fmtMoney(t.revenue) : '—'} sub="Taxable invoice value" toneClass="bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300" icon={<TrendingUp className="h-4 w-4" />} />
        <StatCard title="Cost" value={t ? fmtMoney(t.cost) : '—'} sub="Standard cost × qty" toneClass="bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300" icon={<Calculator className="h-4 w-4" />} />
        <StatCard title="Margin" value={t ? fmtMoney(t.margin) : '—'} sub="Revenue − standard cost" toneClass="bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300" icon={<PiggyBank className="h-4 w-4" />} />
        <StatCard title="Margin %" value={t ? `${fmtNum(t.marginPct)}%` : '—'} sub="Margin / revenue" toneClass="bg-teal-100 text-teal-700 dark:bg-teal-950 dark:text-teal-300" icon={<ReceiptText className="h-4 w-4" />} />
      </div>
      <SectionCard title="Item profitability" actions={<PrintButton label="Print / PDF" onClick={print} />}>
        <DataTable
          columns={columns}
          rows={rows}
          loading={loading}
          searchPlaceholder="Search lines…"
          emptyText="No invoice lines in this period — adjust the date range"
          csvExport={{ filename: 'profitability', headers, pick }}
          xlsxExport={{ filename: 'profitability', headers, pick }}
        />
        <p className="mt-3 text-xs text-muted-foreground">
          Cost uses the item master standard cost at report time; up to 300 lines shown (totals cover the full period).
        </p>
      </SectionCard>
    </div>
  )
}

// ============================================================
// Stock valuation / Low stock (existing report)
// ============================================================

type StockGridRow = StockValItem & { id: string }
const whSummary = (r: StockValItem) => r.warehouses.map((w) => `${w.code} ${fmtNum(w.qty)}`).join(' · ')

function StockValuationView({ companyId, lowOnly }: { companyId: string; lowOnly: boolean }) {
  const [whFilter, setWhFilter] = React.useState('__ALL__')
  const [typeFilter, setTypeFilter] = React.useState('__ALL__')
  const warehouses = useList<{ items?: { id: string; code: string; name: string }[] }>(`/api/warehouses?companyId=${companyId}`)
  const qs = `companyId=${companyId}` + (whFilter !== '__ALL__' ? `&warehouseId=${whFilter}` : '') + (typeFilter !== '__ALL__' ? `&type=${typeFilter}` : '')
  const { data, loading } = useList<StockValuation>(`/api/reports/stock-valuation?${qs}`)
  const rows = React.useMemo<StockGridRow[]>(
    () => (data?.items || []).filter((r) => !lowOnly || r.low).map((r) => ({ ...r, id: r.itemId })),
    [data, lowOnly],
  )
  const columns: Column<StockGridRow>[] = [
    { key: 'code', header: 'Code', render: (r) => <span className="font-medium whitespace-nowrap">{r.code}</span> },
    {
      key: 'name', header: 'Item',
      render: (r) => (
        <div className="flex items-center gap-2">
          <span className="truncate block max-w-52">{r.name}</span>
          <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground whitespace-nowrap">{ITEM_TYPE_LABEL[r.type] || r.type}</span>
        </div>
      ),
    },
    { key: 'uom', header: 'UOM', hideOnMobile: true, render: (r) => <span className="text-xs text-muted-foreground">{r.uom}</span> },
    { key: 'totalQty', header: 'Qty', className: 'text-right', render: (r) => <Qty value={r.totalQty} uom={r.uom} /> },
    { key: 'avgRate', header: 'Avg Rate', className: 'text-right', hideOnMobile: true, render: (r) => <Money value={r.avgRate} /> },
    { key: 'value', header: 'Value', className: 'text-right', render: (r) => <Money value={r.value} className="font-medium" /> },
    { key: 'warehouses', header: 'Warehouses', hideOnMobile: true, render: (r) => <span className="text-xs text-muted-foreground">{whSummary(r) || '—'}</span> },
    {
      key: 'low', header: 'Reorder', className: 'text-right',
      render: (r) => (
        <div className="flex items-center justify-end gap-2">
          <span className="tabular-nums text-muted-foreground">{r.reorderLevel > 0 ? fmtNum(r.reorderLevel) : '—'}</span>
          {r.low && <span className="inline-flex items-center rounded-full bg-red-100 px-2 py-0.5 text-[11px] font-medium text-red-700 dark:bg-red-950 dark:text-red-300">LOW</span>}
        </div>
      ),
    },
  ]
  const headers = ['Code', 'Item', 'Type', 'UOM', 'Qty', 'Avg Rate', 'Value', 'Warehouses', 'Reorder level', 'Alert']
  const pick = (r: StockGridRow) => [r.code, r.name, r.type, r.uom, r.totalQty, r.avgRate, r.value, whSummary(r), r.reorderLevel, r.low ? 'LOW' : '']
  const title = lowOnly ? 'Low Stock' : 'Stock Valuation'
  function print() {
    const body = rows.map((r) => `<tr><td>${esc(r.code)}</td><td>${esc(r.name)}</td><td>${esc(ITEM_TYPE_LABEL[r.type] || r.type)}</td><td>${esc(r.uom)}</td><td class="num">${fmtNum(r.totalQty)}</td><td class="num">${fmtMoney(r.avgRate)}</td><td class="num">${fmtMoney(r.value)}</td><td>${esc(whSummary(r) || '—')}</td><td class="num">${r.reorderLevel > 0 ? fmtNum(r.reorderLevel) : ''}</td></tr>`).join('')
    const total = rows.reduce((s, r) => s + r.value, 0)
    printHtml(title, printHead(title, `${rows.length} item(s)`, 'INVENTORY')
      + `<table><thead><tr><th>Code</th><th>Item</th><th>Type</th><th>UOM</th><th class="num">Qty</th><th class="num">Avg Rate</th><th class="num">Value</th><th>Warehouses</th><th class="num">Reorder</th></tr></thead>
      <tbody>${body || '<tr><td colspan="9" class="muted">No items</td></tr>'}<tr class="grand"><td colspan="6">Total value</td><td class="num">${fmtMoney(total)}</td><td colspan="2"></td></tr></tbody></table>`)
  }
  const t = data?.totals
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard title="Stock Value" value={t ? fmtMoney(t.value) : '—'} sub="At moving average cost" toneClass="bg-primary/10 text-primary" icon={<Boxes className="h-4 w-4" />} />
        <StatCard title="SKUs" value={t ? t.skus : '—'} sub="Distinct items" toneClass="bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300" icon={<Package className="h-4 w-4" />} />
        <StatCard title="Low Stock" value={t ? t.lowStock : '—'} sub="At / below reorder level" toneClass="bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300" icon={<AlertTriangle className="h-4 w-4" />} />
        <StatCard title="Total Qty" value={t ? fmtNum(t.totalQty) : '—'} sub="Across all warehouses" toneClass="bg-teal-100 text-teal-700 dark:bg-teal-950 dark:text-teal-300" icon={<Layers className="h-4 w-4" />} />
      </div>
      {!lowOnly && data && data.byType.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {data.byType.map((x) => (
            <div key={x.type} className="rounded-lg border bg-card px-3 py-2">
              <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">{ITEM_TYPE_LABEL[x.type] || x.type}</p>
              <p className="text-sm font-semibold tabular-nums">{fmtMoney(x.value)}</p>
            </div>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <div className="w-48">
          <SelectInput
            value={whFilter} onChange={setWhFilter}
            options={[{ value: '__ALL__', label: 'All warehouses' }, ...(warehouses.data?.items || []).map((w) => ({ value: w.id, label: w.name || w.code }))]}
          />
        </div>
        <div className="w-44">
          <SelectInput
            value={typeFilter} onChange={setTypeFilter}
            options={[{ value: '__ALL__', label: 'All item types' }, ...ITEM_TYPES.map((x) => ({ value: x, label: ITEM_TYPE_LABEL[x] || x }))]}
          />
        </div>
        <p className="text-xs text-muted-foreground">Point-in-time snapshot — date range not applied.</p>
      </div>
      <SectionCard title={title} actions={<PrintButton label="Print / PDF" onClick={print} />}>
        <DataTable
          columns={columns}
          rows={rows}
          loading={loading}
          searchPlaceholder="Search stock…"
          emptyText={lowOnly ? 'No items at or below reorder level' : 'No stock balances for the selected filters'}
          csvExport={{ filename: lowOnly ? 'low-stock' : 'stock-valuation', headers, pick }}
          xlsxExport={{ filename: lowOnly ? 'low-stock' : 'stock-valuation', headers, pick }}
        />
      </SectionCard>
    </div>
  )
}

// ============================================================
// Item detail
// ============================================================

type MoveRow = ItemDetail['items'][number]

function ItemDetailView({ companyId, from, to }: PeriodProps) {
  const [itemId, setItemId] = React.useState('')
  const items = useList<{ items?: PickerItem[] }>(`/api/items?companyId=${companyId}&page=1&pageSize=500`)
  const { data, loading } = useList<ItemDetail>(itemId ? `/api/reports/item-detail?companyId=${companyId}&itemId=${itemId}&from=${from}&to=${to}` : null)
  const uom = data?.item.uom
  const columns: Column<MoveRow>[] = [
    { key: 'date', header: 'Date', render: (r) => <DateCell value={r.date} /> },
    { key: 'type', header: 'Type', render: (r) => <span className="text-xs whitespace-nowrap">{r.type.replaceAll('_', ' ')}</span> },
    { key: 'refNumber', header: 'Reference', render: (r) => <div><p className="font-mono text-xs">{r.refNumber || '—'}</p>{r.notes && <p className="text-[11px] text-muted-foreground truncate max-w-48">{r.notes}</p>}</div> },
    { key: 'warehouse', header: 'Store', hideOnMobile: true, render: (r) => <span className="text-xs">{r.warehouse}</span> },
    { key: 'qtyIn', header: 'In', className: 'text-right', sum: true, render: (r) => (r.qtyIn ? <span className="tabular-nums text-emerald-700 dark:text-emerald-400">{fmtNum(r.qtyIn)}</span> : <span className="text-muted-foreground">—</span>) },
    { key: 'qtyOut', header: 'Out', className: 'text-right', sum: true, render: (r) => (r.qtyOut ? <span className="tabular-nums text-red-600 dark:text-red-400">{fmtNum(r.qtyOut)}</span> : <span className="text-muted-foreground">—</span>) },
    { key: 'runningQty', header: 'Balance', className: 'text-right', render: (r) => <Qty value={r.runningQty} uom={uom} /> },
    { key: 'rate', header: 'Rate', className: 'text-right', hideOnMobile: true, render: (r) => <Money value={r.rate} /> },
  ]
  const headers = ['Date', 'Type', 'Reference', 'Store', 'In', 'Out', 'Balance', 'Rate', 'Notes']
  const pick = (r: MoveRow) => [String(r.date).slice(0, 10), r.type, r.refNumber || '', r.warehouse, r.qtyIn, r.qtyOut, r.runningQty, r.rate, r.notes || '']
  function print() {
    const d = data
    if (!d) return
    const body = d.items.map((r) => `<tr><td>${esc(fmtDate(r.date))}</td><td>${esc(r.type)}</td><td>${esc(r.refNumber || '')}</td><td>${esc(r.warehouse)}</td><td class="num">${r.qtyIn ? fmtNum(r.qtyIn) : ''}</td><td class="num">${r.qtyOut ? fmtNum(r.qtyOut) : ''}</td><td class="num">${fmtNum(r.runningQty)}</td><td class="num">${fmtMoney(r.rate)}</td></tr>`).join('')
    printHtml('Item Detail', printHead(`${d.item.code} — ${d.item.name}`, `Item detail · ${fmtDate(d.from)} – ${fmtDate(d.to)}`, 'ITEM DETAIL')
      + `<table><thead><tr><th>Date</th><th>Type</th><th>Reference</th><th>Store</th><th class="num">In</th><th class="num">Out</th><th class="num">Balance</th><th class="num">Rate</th></tr></thead><tbody>
      <tr><td colspan="6"><b>Opening</b></td><td class="num"><b>${fmtNum(d.openingQty)}</b></td><td></td></tr>${body}
      <tr class="grand"><td colspan="4">Closing</td><td class="num">${fmtNum(d.totals.in)}</td><td class="num">${fmtNum(d.totals.out)}</td><td class="num">${fmtNum(d.closingQty)}</td><td class="num">${fmtMoney(d.closingValue)}</td></tr></tbody></table>
      <p class="muted" style="margin-top:10px">Sales ${fmtNum(d.sales.qty)} (${fmtMoney(d.sales.value)}) · Purchases ${fmtNum(d.purchases.qty)} (${fmtMoney(d.purchases.value)}) · Closing value at current avg rate ${fmtMoney(d.avgRate)}</p>`)
  }
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Item" className="w-full sm:w-96">
          <ItemPicker items={items.data?.items ?? []} value={itemId} onChange={setItemId} placeholder="Search item by code or name…" />
        </Field>
        {data && <PrintButton label="Print / PDF" onClick={print} />}
      </div>
      {!itemId ? (
        <SectionCard><p className="py-10 text-center text-sm text-muted-foreground">Pick an item to see its movements in the period</p></SectionCard>
      ) : !data ? (
        <Loading loading={loading} />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard title="Opening Qty" value={`${fmtNum(data.openingQty)} ${data.item.uom}`} sub={`On ${fmtDate(data.from)} · ${fmtMoney(data.openingValue)}`} icon={<Package className="h-4 w-4" />} />
            <StatCard title="In / Out" value={`${fmtNum(data.totals.in)} / ${fmtNum(data.totals.out)}`} sub="Movements in period" icon={<ArrowLeftRight className="h-4 w-4" />} toneClass="bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300" />
            <StatCard title="Closing Qty" value={`${fmtNum(data.closingQty)} ${data.item.uom}`} sub={`Value ${fmtMoney(data.closingValue)} @ ${fmtMoney(data.avgRate)}`} icon={<Boxes className="h-4 w-4" />} toneClass="bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300" />
            <StatCard title="Sales / Purchases" value={`${fmtNum(data.sales.qty)} / ${fmtNum(data.purchases.qty)}`} sub={`${fmtMoney(data.sales.value)} / ${fmtMoney(data.purchases.value)}`} icon={<IndianRupee className="h-4 w-4" />} toneClass="bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300" />
          </div>
          {(data.salesReturns.qty > 0 || data.purchaseReturns.qty > 0) && (
            <p className="text-xs text-muted-foreground">
              Sales returns {fmtNum(data.salesReturns.qty)} ({fmtMoney(data.salesReturns.value)}) · Purchase returns {fmtNum(data.purchaseReturns.qty)} ({fmtMoney(data.purchaseReturns.value)})
            </p>
          )}
          <SectionCard title={`${data.item.code} — ${data.item.name} · opening ${fmtNum(data.openingQty)} ${data.item.uom}`}>
            <DataTable
              columns={columns}
              rows={data.items}
              loading={loading}
              pageSize={25}
              searchPlaceholder="Search movements…"
              emptyText="No stock movements in this period"
              csvExport={{ filename: `item-${data.item.code}-${from}-${to}`, headers, pick }}
              xlsxExport={{ filename: `item-${data.item.code}-${from}-${to}`, headers, pick }}
            />
            <p className="mt-3 text-xs text-muted-foreground">
              Opening qty = current balance minus movements since {fmtDate(data.from)}. Values use the current average rate.
            </p>
          </SectionCard>
        </>
      )}
    </div>
  )
}
