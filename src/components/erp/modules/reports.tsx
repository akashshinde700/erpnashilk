'use client'

import * as React from 'react'
import {
  AlertTriangle, BadgeCheck, Boxes, Calculator, Clock, IndianRupee,
  Layers, Package, PiggyBank, ReceiptText, TrendingUp, Wallet,
} from 'lucide-react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Column, DataTable, DateCell, DateInput, Field, Money, PageHeader, PrintButton,
  Qty, SelectInput, StatCard, printHtml,
} from '@/components/erp/kit'
import { useList } from '@/lib/use-api'
import { fmtDate, fmtMoney, fmtNum, ITEM_TYPES, ITEM_TYPE_LABEL } from '@/lib/erp-constants'

const todayISO = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const fyStartISO = () => {
  const d = new Date()
  const y = d.getMonth() + 1 >= 4 ? d.getFullYear() : d.getFullYear() - 1
  return `${y}-04-01`
}
const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// ---------- report payload types ----------

interface PartyRow {
  customerId?: string; supplierId?: string
  name: string; city: string | null; state: string | null
  invoices: number; base: number; tax: number; grand: number
  received?: number; paid?: number; outstanding: number
}
interface PartyTotals {
  invoices: number; base: number; tax: number; grand: number
  received?: number; paid?: number; outstanding: number
}
interface PartyReport { items: PartyRow[]; totals: PartyTotals; from: string; to: string }

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
interface Profitability {
  items: ProfitRow[]
  totals: { revenue: number; cost: number; margin: number; marginPct: number }
  from: string; to: string
}

type SalesGridRow = PartyRow & { id: string }
type StockGridRow = StockValItem & { id: string }
type ProfitGridRow = ProfitRow & { id: string }

const MARGIN_CLS = (v: number) => (v >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400')

function TypeChip({ type }: { type?: string }) {
  if (!type) return <span className="text-muted-foreground">—</span>
  return (
    <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground whitespace-nowrap">
      {ITEM_TYPE_LABEL[type] || type}
    </span>
  )
}

function LowBadge({ low }: { low: boolean }) {
  if (!low) return <span className="text-xs text-muted-foreground">—</span>
  return (
    <span className="inline-flex items-center rounded-full bg-red-100 px-2 py-0.5 text-[11px] font-medium text-red-700 dark:bg-red-950 dark:text-red-300">
      LOW
    </span>
  )
}

const whSummary = (r: StockValItem) => r.warehouses.map((w) => `${w.code} ${fmtNum(w.qty)}`).join(' · ')

export default function ReportsModule({ companyId }: { companyId: string }) {
  const [tab, setTab] = React.useState('sales')
  const [from, setFrom] = React.useState(fyStartISO())
  const [to, setTo] = React.useState(todayISO())

  // ---- stock tab filters (valuation is a point-in-time snapshot; dates don't apply) ----
  const [whFilter, setWhFilter] = React.useState('__ALL__')
  const [typeFilter, setTypeFilter] = React.useState('__ALL__')
  const warehouses = useList<{ items?: { id: string; code: string; name: string; type: string }[] }>(`/api/warehouses?companyId=${companyId}`)

  // ---- on-demand fetch per tab (null url when inactive — no fetch until the tab is opened) ----
  const qs = `companyId=${companyId}&from=${from}&to=${to}`
  const stockQs = `companyId=${companyId}`
    + (whFilter !== '__ALL__' ? `&warehouseId=${whFilter}` : '')
    + (typeFilter !== '__ALL__' ? `&type=${typeFilter}` : '')

  const sales = useList<PartyReport>(tab === 'sales' ? `/api/reports/sales-by-customer?${qs}` : null)
  const purchase = useList<PartyReport>(tab === 'purchase' ? `/api/reports/purchase-by-supplier?${qs}` : null)
  const stockVal = useList<StockValuation>(tab === 'stock' ? `/api/reports/stock-valuation?${stockQs}` : null)
  const profit = useList<Profitability>(tab === 'profit' ? `/api/reports/profitability?${qs}` : null)

  const salesRows = React.useMemo<SalesGridRow[]>(
    () => (sales.data?.items || []).map((r) => ({ ...r, id: r.customerId || r.name })),
    [sales.data],
  )
  const purchaseRows = React.useMemo<SalesGridRow[]>(
    () => (purchase.data?.items || []).map((r) => ({ ...r, id: r.supplierId || r.name })),
    [purchase.data],
  )
  const stockRows = React.useMemo<StockGridRow[]>(
    () => (stockVal.data?.items || []).map((r) => ({ ...r, id: r.itemId })),
    [stockVal.data],
  )
  const profitRows = React.useMemo<ProfitGridRow[]>(
    () => (profit.data?.items || []).map((r, i) => ({ ...r, id: `${r.invoiceId}-${r.itemId}-${i}` })),
    [profit.data],
  )

  // ---------- print (active tab) ----------

  function printSalesReport() {
    const d = sales.data
    if (!d) return
    const rows = d.items.map((r) =>
      `<tr><td>${esc(r.name)}</td><td>${esc(r.city || '—')}</td><td class="num">${r.invoices}</td><td class="num">${fmtMoney(r.base)}</td><td class="num">${fmtMoney(r.tax)}</td><td class="num">${fmtMoney(r.grand)}</td><td class="num">${fmtMoney(r.received)}</td><td class="num">${fmtMoney(r.outstanding)}</td></tr>`,
    ).join('')
    printHtml('Sales by Customer',
      `<div class="head"><div><h1>Sales by Customer</h1><div class="muted">Period ${fmtDate(d.from)} – ${fmtDate(d.to)} · ${d.totals.invoices} invoice(s) · generated ${esc(fmtDate(new Date()))}</div></div><span class="badge">SALES REPORT</span></div>
      <table><thead><tr><th>Customer</th><th>City</th><th class="num">Invoices</th><th class="num">Taxable</th><th class="num">GST</th><th class="num">Grand Total</th><th class="num">Received</th><th class="num">Outstanding</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="8" class="muted">No invoices in this period</td></tr>'}
      <tr class="grand"><td colspan="5">Total</td><td class="num">${fmtMoney(d.totals.grand)}</td><td class="num">${fmtMoney(d.totals.received)}</td><td class="num">${fmtMoney(d.totals.outstanding)}</td></tr></tbody></table>`)
  }

  function printPurchaseReport() {
    const d = purchase.data
    if (!d) return
    const rows = d.items.map((r) =>
      `<tr><td>${esc(r.name)}</td><td>${esc(r.city || '—')}</td><td class="num">${r.invoices}</td><td class="num">${fmtMoney(r.base)}</td><td class="num">${fmtMoney(r.tax)}</td><td class="num">${fmtMoney(r.grand)}</td><td class="num">${fmtMoney(r.paid)}</td><td class="num">${fmtMoney(r.outstanding)}</td></tr>`,
    ).join('')
    printHtml('Purchase by Supplier',
      `<div class="head"><div><h1>Purchase by Supplier</h1><div class="muted">Period ${fmtDate(d.from)} – ${fmtDate(d.to)} · ${d.totals.invoices} invoice(s) · generated ${esc(fmtDate(new Date()))}</div></div><span class="badge">PURCHASE REPORT</span></div>
      <table><thead><tr><th>Supplier</th><th>City</th><th class="num">Invoices</th><th class="num">Taxable</th><th class="num">GST</th><th class="num">Grand Total</th><th class="num">Paid</th><th class="num">Outstanding</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="8" class="muted">No invoices in this period</td></tr>'}
      <tr class="grand"><td colspan="5">Total</td><td class="num">${fmtMoney(d.totals.grand)}</td><td class="num">${fmtMoney(d.totals.paid)}</td><td class="num">${fmtMoney(d.totals.outstanding)}</td></tr></tbody></table>`)
  }

  function printStockReport() {
    const d = stockVal.data
    if (!d) return
    const rows = d.items.map((r) =>
      `<tr><td>${esc(r.code)}</td><td>${esc(r.name)}</td><td>${esc(ITEM_TYPE_LABEL[r.type] || r.type)}</td><td>${esc(r.uom)}</td><td class="num">${fmtNum(r.totalQty)}</td><td class="num">${fmtMoney(r.avgRate)}</td><td class="num">${fmtMoney(r.value)}</td><td>${esc(whSummary(r) || '—')}</td><td>${r.low ? 'LOW' : ''}</td></tr>`,
    ).join('')
    printHtml('Stock Valuation',
      `<div class="head"><div><h1>Stock Valuation</h1><div class="muted">${d.totals.skus} SKU(s) · total qty ${fmtNum(d.totals.totalQty)} · generated ${esc(fmtDate(new Date()))}</div></div><span class="badge">INVENTORY</span></div>
      <table><thead><tr><th>Code</th><th>Item</th><th>Type</th><th>UOM</th><th class="num">Qty</th><th class="num">Avg Rate</th><th class="num">Value</th><th>Warehouses</th><th>Alert</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="9" class="muted">No stock balances</td></tr>'}
      <tr class="grand"><td colspan="6">Total Stock Value</td><td class="num">${fmtMoney(d.totals.value)}</td><td colspan="2"></td></tr></tbody></table>`)
  }

  function printProfitReport() {
    const d = profit.data
    if (!d) return
    const rows = d.items.map((r) =>
      `<tr><td>${esc(fmtDate(r.date))}</td><td>${esc(r.invoiceNumber)}</td><td>${esc(r.customerName)}</td><td>${esc(r.itemCode)}</td><td class="num">${fmtNum(r.qty)}</td><td class="num">${fmtMoney(r.rate)}</td><td class="num">${fmtMoney(r.taxable)}</td><td class="num">${fmtMoney(r.cost)}</td><td class="num">${fmtMoney(r.margin)}</td><td class="num">${fmtNum(r.marginPct)}%</td></tr>`,
    ).join('')
    printHtml('Profitability Report',
      `<div class="head"><div><h1>Profitability Report</h1><div class="muted">Period ${fmtDate(d.from)} – ${fmtDate(d.to)} · margin ${fmtNum(d.totals.marginPct)}% · generated ${esc(fmtDate(new Date()))}</div></div><span class="badge">MARGIN</span></div>
      <table><thead><tr><th>Date</th><th>Invoice</th><th>Customer</th><th>Item</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">Taxable</th><th class="num">Cost</th><th class="num">Margin</th><th class="num">Margin %</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="10" class="muted">No invoice lines in this period</td></tr>'}
      <tr class="grand"><td colspan="6">Total</td><td class="num">${fmtMoney(d.totals.revenue)}</td><td class="num">${fmtMoney(d.totals.cost)}</td><td class="num">${fmtMoney(d.totals.margin)}</td><td class="num">${fmtNum(d.totals.marginPct)}%</td></tr></tbody></table>`)
  }

  function printActive() {
    if (tab === 'sales') printSalesReport()
    else if (tab === 'purchase') printPurchaseReport()
    else if (tab === 'stock') printStockReport()
    else printProfitReport()
  }

  // ---------- columns ----------

  const partyColumns = (paidKey: 'received' | 'paid'): Column<SalesGridRow>[] => [
    {
      key: 'name', header: paidKey === 'received' ? 'Customer' : 'Supplier',
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
    { key: paidKey, header: paidKey === 'received' ? 'Received' : 'Paid', className: 'text-right', render: (r) => <Money value={r[paidKey]} /> },
    {
      key: 'outstanding', header: 'Outstanding', className: 'text-right',
      render: (r) => <Money value={r.outstanding} className={r.outstanding > 0 ? 'font-medium text-amber-600 dark:text-amber-400' : 'font-medium'} />,
    },
  ]

  const salesColumns = partyColumns('received')
  const purchaseColumns = partyColumns('paid')

  const stockColumns: Column<StockGridRow>[] = [
    { key: 'code', header: 'Code', render: (r) => <span className="font-medium whitespace-nowrap">{r.code}</span> },
    {
      key: 'name', header: 'Item',
      render: (r) => (
        <div className="flex items-center gap-2">
          <span className="truncate block max-w-52">{r.name}</span>
          <TypeChip type={r.type} />
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
          <LowBadge low={r.low} />
        </div>
      ),
    },
  ]

  const profitColumns: Column<ProfitGridRow>[] = [
    { key: 'date', header: 'Date', hideOnMobile: true, render: (r) => <DateCell value={r.date} /> },
    { key: 'invoiceNumber', header: 'Invoice', render: (r) => <span className="font-mono text-xs whitespace-nowrap">{r.invoiceNumber}</span> },
    { key: 'customerName', header: 'Customer', render: (r) => <span className="truncate block max-w-[150px]">{r.customerName}</span> },
    {
      key: 'item', header: 'Item',
      render: (r) => (
        <div>
          <p className="truncate max-w-48">{r.itemName}</p>
          <p className="text-xs text-muted-foreground">{r.itemCode}</p>
        </div>
      ),
    },
    { key: 'qty', header: 'Qty', className: 'text-right', render: (r) => <span className="tabular-nums">{fmtNum(r.qty)}</span> },
    { key: 'rate', header: 'Rate', className: 'text-right', hideOnMobile: true, render: (r) => <Money value={r.rate} /> },
    { key: 'taxable', header: 'Taxable', className: 'text-right', hideOnMobile: true, render: (r) => <Money value={r.taxable} /> },
    { key: 'cost', header: 'Cost', className: 'text-right', hideOnMobile: true, render: (r) => <Money value={r.cost} /> },
    { key: 'margin', header: 'Margin', className: 'text-right', render: (r) => <Money value={r.margin} className={`font-medium ${MARGIN_CLS(r.margin)}`} /> },
    {
      key: 'marginPct', header: 'Margin %', className: 'text-right',
      render: (r) => <span className={`tabular-nums font-medium ${MARGIN_CLS(r.margin)}`}>{fmtNum(r.marginPct)}%</span>,
    },
  ]

  // ---------- render ----------

  return (
    <div>
      <PageHeader
        title="Reports Center"
        description="Business reports across sales, purchase, inventory and margins"
        actions={<PrintButton onClick={printActive} label="Print Report" />}
      />

      {/* shared date range header — applies to the three period-based tabs */}
      <div className="flex flex-wrap items-end gap-3 mb-4">
        <Field label="From" className="w-40">
          <DateInput value={from} onChange={setFrom} />
        </Field>
        <Field label="To" className="w-40">
          <DateInput value={to} onChange={setTo} />
        </Field>
        {tab === 'stock' && (
          <p className="text-xs text-muted-foreground pb-2">Stock valuation is a point-in-time snapshot — date range not applied.</p>
        )}
      </div>

      <Tabs value={tab} onValueChange={setTab} className="gap-4">
        <TabsList className="flex-wrap h-auto">
          <TabsTrigger value="sales">Sales by Customer</TabsTrigger>
          <TabsTrigger value="purchase">Purchase by Supplier</TabsTrigger>
          <TabsTrigger value="stock">Stock Valuation</TabsTrigger>
          <TabsTrigger value="profit">Profitability</TabsTrigger>
        </TabsList>

        {/* ---------------- SALES BY CUSTOMER ---------------- */}
        <TabsContent value="sales" className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard title="Grand Total" value={sales.data ? fmtMoney(sales.data.totals.grand) : '—'} sub="Invoiced in period (incl. GST)" icon={<IndianRupee className="h-4 w-4" />} />
            <StatCard title="Received" value={sales.data ? fmtMoney(sales.data.totals.received) : '—'} sub="Payments against invoices" toneClass="bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300" icon={<BadgeCheck className="h-4 w-4" />} />
            <StatCard title="Outstanding" value={sales.data ? fmtMoney(sales.data.totals.outstanding) : '—'} sub="Grand total − received" toneClass="bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300" icon={<Clock className="h-4 w-4" />} />
            <StatCard title="Invoices" value={sales.data ? sales.data.totals.invoices : '—'} sub="Non-cancelled in period" toneClass="bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300" icon={<ReceiptText className="h-4 w-4" />} />
          </div>
          <DataTable
            columns={salesColumns}
            rows={salesRows}
            loading={sales.loading}
            searchPlaceholder="Search customers…"
            emptyText="No sales in this period — adjust the date range"
            csvExport={{ filename: 'sales-by-customer', pick: (r) => [r.name, r.invoices, r.base, r.tax, r.grand, r.received ?? 0, r.outstanding] }}
          />
        </TabsContent>

        {/* ---------------- PURCHASE BY SUPPLIER ---------------- */}
        <TabsContent value="purchase" className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard title="Grand Total" value={purchase.data ? fmtMoney(purchase.data.totals.grand) : '—'} sub="Invoiced in period (incl. GST)" icon={<IndianRupee className="h-4 w-4" />} />
            <StatCard title="Paid" value={purchase.data ? fmtMoney(purchase.data.totals.paid) : '—'} sub="Payments to suppliers" toneClass="bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300" icon={<Wallet className="h-4 w-4" />} />
            <StatCard title="Outstanding" value={purchase.data ? fmtMoney(purchase.data.totals.outstanding) : '—'} sub="Grand total − paid" toneClass="bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300" icon={<Clock className="h-4 w-4" />} />
            <StatCard title="Invoices" value={purchase.data ? purchase.data.totals.invoices : '—'} sub="Non-cancelled in period" toneClass="bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300" icon={<ReceiptText className="h-4 w-4" />} />
          </div>
          <DataTable
            columns={purchaseColumns}
            rows={purchaseRows}
            loading={purchase.loading}
            searchPlaceholder="Search suppliers…"
            emptyText="No purchases in this period — adjust the date range"
            csvExport={{ filename: 'purchase-by-supplier', pick: (r) => [r.name, r.invoices, r.base, r.tax, r.grand, r.paid ?? 0, r.outstanding] }}
          />
        </TabsContent>

        {/* ---------------- STOCK VALUATION ---------------- */}
        <TabsContent value="stock" className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard title="Stock Value" value={stockVal.data ? fmtMoney(stockVal.data.totals.value) : '—'} sub="At moving average cost" toneClass="bg-primary/10 text-primary" icon={<Boxes className="h-4 w-4" />} />
            <StatCard title="SKUs" value={stockVal.data ? stockVal.data.totals.skus : '—'} sub="Distinct items" toneClass="bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300" icon={<Package className="h-4 w-4" />} />
            <StatCard title="Low Stock" value={stockVal.data ? stockVal.data.totals.lowStock : '—'} sub="At / below reorder level" toneClass="bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300" icon={<AlertTriangle className="h-4 w-4" />} />
            <StatCard title="Total Qty" value={stockVal.data ? fmtNum(stockVal.data.totals.totalQty) : '—'} sub="Across all warehouses" toneClass="bg-teal-100 text-teal-700 dark:bg-teal-950 dark:text-teal-300" icon={<Layers className="h-4 w-4" />} />
          </div>

          {stockVal.data && stockVal.data.byType.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {stockVal.data.byType.map((t) => (
                <div key={t.type} className="rounded-lg border bg-card px-3 py-2">
                  <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">{ITEM_TYPE_LABEL[t.type] || t.type}</p>
                  <p className="text-sm font-semibold tabular-nums">{fmtMoney(t.value)}</p>
                </div>
              ))}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <div className="w-48">
              <SelectInput
                value={whFilter} onChange={setWhFilter}
                options={[
                  { value: '__ALL__', label: 'All warehouses' },
                  ...(warehouses.data?.items || []).map((w) => ({ value: w.id, label: w.name || w.code })),
                ]}
              />
            </div>
            <div className="w-44">
              <SelectInput
                value={typeFilter} onChange={setTypeFilter}
                options={[{ value: '__ALL__', label: 'All item types' }, ...ITEM_TYPES.map((t) => ({ value: t, label: ITEM_TYPE_LABEL[t] || t }))]}
              />
            </div>
          </div>

          <DataTable
            columns={stockColumns}
            rows={stockRows}
            loading={stockVal.loading}
            searchPlaceholder="Search stock…"
            emptyText="No stock balances for the selected filters"
            csvExport={{ filename: 'stock-valuation', pick: (r) => [r.code, r.name, r.type, r.uom, r.totalQty, r.avgRate, r.value, whSummary(r), r.low ? 'LOW' : ''] }}
          />
        </TabsContent>

        {/* ---------------- PROFITABILITY ---------------- */}
        <TabsContent value="profit" className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard title="Revenue" value={profit.data ? fmtMoney(profit.data.totals.revenue) : '—'} sub="Taxable invoice value" toneClass="bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300" icon={<TrendingUp className="h-4 w-4" />} />
            <StatCard title="Cost" value={profit.data ? fmtMoney(profit.data.totals.cost) : '—'} sub="Standard cost × qty" toneClass="bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300" icon={<Calculator className="h-4 w-4" />} />
            <StatCard title="Margin" value={profit.data ? fmtMoney(profit.data.totals.margin) : '—'} sub="Revenue − standard cost" toneClass="bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300" icon={<PiggyBank className="h-4 w-4" />} />
            <StatCard title="Margin %" value={profit.data ? `${fmtNum(profit.data.totals.marginPct)}%` : '—'} sub="Margin / revenue" toneClass="bg-teal-100 text-teal-700 dark:bg-teal-950 dark:text-teal-300" icon={<ReceiptText className="h-4 w-4" />} />
          </div>
          <DataTable
            columns={profitColumns}
            rows={profitRows}
            loading={profit.loading}
            searchPlaceholder="Search lines…"
            emptyText="No invoice lines in this period — adjust the date range"
            csvExport={{ filename: 'profitability', pick: (r) => [r.date.slice(0, 10), r.invoiceNumber, r.customerName, r.itemCode, r.qty, r.rate, r.taxable, r.cost, r.margin, r.marginPct] }}
          />
          <p className="text-xs text-muted-foreground">
            Cost uses the item master standard cost at report time; up to 300 lines shown (totals cover the full period).
          </p>
        </TabsContent>
      </Tabs>
    </div>
  )
}
