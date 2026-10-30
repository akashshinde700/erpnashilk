'use client'

import * as React from 'react'
import { ArrowDownToLine, ArrowUpFromLine, FileJson, FileSpreadsheet, Scale } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import {
  Column, DataTable, DateCell, Money, PageHeader, PrintButton, SectionCard, SelectInput, StatCard, downloadXlsx, printHtml,
} from '@/components/erp/kit'
import { fmtDate, fmtMoney, fmtNum } from '@/lib/erp-constants'
import { apiGet, useList } from '@/lib/use-api'

interface PartyRef {
  name?: string | null
  gstin?: string | null
}

interface GstInvoiceRow {
  id: string
  number: string
  date: string
  status?: string
  subtotal: number
  discountTotal?: number
  cgst: number
  sgst: number
  igst: number
  grandTotal: number
  customer?: PartyRef | null
  supplier?: PartyRef | null
}

interface DetailItem {
  id: string
  hsn?: string | null
  qty: number
  rate: number
  discountPct?: number
  gstRate: number
  lineTotal: number
  item?: { code?: string | null; name?: string | null; uom?: string | null } | null
}

interface InvoiceDetail {
  id: string
  number?: string
  items?: DetailItem[]
  customer?: PartyRef | null
  supplier?: PartyRef | null
}

interface Gstr2Bill {
  id: string; number: string; supplierInvNo?: string | null; date: string
  supplierName: string; gstin: string | null; isInterState: boolean
  taxable: number; cgst: number; sgst: number; igst: number; cess: number; totalTax: number; grandTotal: number
  itcEligible: boolean
  reverseCharge: boolean
}
interface Gstr2Data {
  items: Gstr2Bill[]
  debitNotes: { id: string; number: string; date: string; invoiceNumber: string; supplierName: string; gstin: string | null; taxable: number; cgst: number; sgst: number; igst: number; grandTotal: number }[]
  bySupplier: { key: string; gstin: string | null; name: string; bills: number; rcmBills: number; taxable: number; cgst: number; sgst: number; igst: number; cess: number; total: number; itcEligible: boolean }[]
  totals: { bills: number; taxable: number; cgst: number; sgst: number; igst: number; cess: number; grandTotal: number; itcEligibleTax: number; itcIneligibleTax: number; rcmBills: number; rcmTaxable: number; rcmTax: number; debitNotes: number; debitNoteTax: number }
}
interface Heads { igst: number; cgst: number; sgst: number; cess: number }
interface ReverseChargeBlock { docs: number; taxable: number; tax: Heads; totalTax: number }
interface Gstr3bData {
  outward: { taxable: number; salesTaxable: number; returnsTaxable: number; invoices: number; creditNotes: number; tax: Heads; totalTax: number }
  itc: { bills: Heads; expenses: Heads; total: Heads; totalTax: number; ineligible: Heads; ineligibleTotal: number }
  reverseCharge?: { outward: ReverseChargeBlock; inward: ReverseChargeBlock }
  net: Heads; payable: Heads; credit: Heads; totalPayable: number; totalCredit: number; netTotal: number
}
interface Gstr1Json {
  json: { gstin: string; fp: string } & Record<string, unknown>
  summary: {
    invoices: number; b2bInvoices: number; b2clInvoices?: number; b2csRows: number; creditNotes: number; hsnRows: number
    reverseChargeInvoices?: number; foreignCurrencyInvoices?: number; missingGstin: boolean
  }
}
interface Gstr9Row extends Heads { count: number; taxable: number }
interface Gstr9Hsn { hsn: string; desc: string; uqc: string; rate: number; qty: number; taxable: number; igst: number; cgst: number; sgst: number; cess: number; totalTax: number }
interface Gstr9Data {
  fy: number; fyLabel: string; from: string; to: string
  company: { name: string; gstin: string }
  table4: { b2b: Gstr9Row; b2c: Gstr9Row; creditNotesB2b: Gstr9Row; creditNotesB2c: Gstr9Row; net: Gstr9Row; totalTax: number }
  table6: { bills: Heads; expenses: Heads; total: Heads; totalTax: number; ineligible: Heads; ineligibleTotal: number }
  table9: { heads: Record<keyof Heads, { payable: number; itc: number; cash: number; credit: number }>; totalPayable: number; totalItc: number; totalCash: number; totalCredit: number }
  table17: { rows: Gstr9Hsn[]; totals: { qty: number; taxable: number; totalTax: number } }
}

const HEADS: { key: keyof Heads; label: string }[] = [
  { key: 'igst', label: 'IGST' }, { key: 'cgst', label: 'CGST' }, { key: 'sgst', label: 'SGST' }, { key: 'cess', label: 'Cess' },
]

/** First and last day (YYYY-MM-DD) of a YYYY-MM month. */
function monthRange(month: string): { from: string; to: string } {
  const [y, m] = month.split('-').map(Number)
  const last = new Date(y, m, 0).getDate()
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` }
}

interface DrillState {
  type: 'sales' | 'purchase'
  inv: GstInvoiceRow
  items: DetailItem[]
}

const r2 = (n: number) => Math.round(n * 100) / 100

const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const taxableOf = (r: GstInvoiceRow) => r2((r.subtotal || 0) - (r.discountTotal || 0))
const taxOf = (r: GstInvoiceRow) => r2((r.cgst || 0) + (r.sgst || 0) + (r.igst || 0))

/** Last 6 Indian financial years (value = start year, label "FY 2024-25"). */
function fyOptions(): { value: string; label: string }[] {
  const d = new Date()
  const cur = d.getMonth() + 1 >= 4 ? d.getFullYear() : d.getFullYear() - 1
  return Array.from({ length: 6 }, (_, i) => {
    const y = cur - i
    return { value: String(y), label: `FY ${y}-${String((y + 1) % 100).padStart(2, '0')}` }
  })
}

function monthOptions(): { value: string; label: string }[] {
  const out: { value: string; label: string }[] = []
  const d = new Date()
  d.setDate(1)
  for (let i = 0; i < 12; i++) {
    out.push({
      value: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
      label: d.toLocaleString('en-IN', { month: 'short', year: 'numeric' }),
    })
    d.setMonth(d.getMonth() - 1)
  }
  return out
}

function TypeChip({ gstin }: { gstin?: string | null }) {
  const b2b = !!gstin
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium ${
        b2b ? 'bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300' : 'bg-muted text-muted-foreground'
      }`}
    >
      {b2b ? 'B2B' : 'B2C'}
    </span>
  )
}

function TotalsStrip({ rows, label }: { rows: GstInvoiceRow[]; label: string }) {
  const cells: [string, string][] = [
    ['Invoices', String(rows.length)],
    ['Taxable', fmtMoney(rows.reduce((s, r) => s + taxableOf(r), 0))],
    ['CGST', fmtMoney(rows.reduce((s, r) => s + (r.cgst || 0), 0))],
    ['SGST', fmtMoney(rows.reduce((s, r) => s + (r.sgst || 0), 0))],
    ['IGST', fmtMoney(rows.reduce((s, r) => s + (r.igst || 0), 0))],
    ['Total', fmtMoney(rows.reduce((s, r) => s + (r.grandTotal || 0), 0))],
  ]
  return (
    <div className="mb-3 flex flex-wrap items-center gap-x-5 gap-y-1.5 rounded-lg border bg-muted/40 px-3 py-2 text-xs">
      <span className="font-medium text-muted-foreground">{label}</span>
      {cells.map(([k, v]) => (
        <span key={k} className="text-muted-foreground">
          {k}: <span className="font-medium tabular-nums text-foreground">{v}</span>
        </span>
      ))}
    </div>
  )
}

function GstInvoiceTable({
  rows, party, loading, onDrill, emptyText,
}: {
  rows: GstInvoiceRow[]
  party: 'customer' | 'supplier'
  loading?: boolean
  onDrill: (inv: GstInvoiceRow) => void
  emptyText?: string
}) {
  const columns: Column<GstInvoiceRow>[] = [
    {
      key: 'number',
      header: 'Invoice No',
      render: (r) => (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onDrill(r)
          }}
          className="font-mono text-xs underline-offset-2 hover:underline"
        >
          {r.number}
        </button>
      ),
    },
    { key: 'date', header: 'Date', hideOnMobile: true, render: (r) => <DateCell value={r.date} /> },
    {
      key: 'party',
      header: party === 'customer' ? 'Customer' : 'Supplier',
      render: (r) => (
        <div className="min-w-0">
          <div className="truncate text-sm">{r[party]?.name || '—'}</div>
          {r[party]?.gstin ? <div className="text-[11px] text-muted-foreground font-mono">{r[party]?.gstin}</div> : null}
        </div>
      ),
    },
    { key: 'type', header: 'Type', render: (r) => <TypeChip gstin={r[party]?.gstin} /> },
    { key: 'taxable', header: 'Taxable', className: 'text-right', render: (r) => <Money value={taxableOf(r)} /> },
    { key: 'cgst', header: 'CGST', className: 'text-right', hideOnMobile: true, render: (r) => <Money value={r.cgst} /> },
    { key: 'sgst', header: 'SGST', className: 'text-right', hideOnMobile: true, render: (r) => <Money value={r.sgst} /> },
    { key: 'igst', header: 'IGST', className: 'text-right', hideOnMobile: true, render: (r) => <Money value={r.igst} /> },
    { key: 'total', header: 'Total', className: 'text-right', render: (r) => <Money value={r.grandTotal} className="font-medium" /> },
  ]
  return (
    <DataTable
      columns={columns}
      rows={rows}
      loading={loading}
      onRowClick={onDrill}
      searchPlaceholder="Search invoices…"
      emptyText={emptyText}
      pageSize={8}
    />
  )
}

export default function GstReportModule({ companyId }: { companyId: string }) {
  const months = React.useMemo(() => monthOptions(), [])
  const [month, setMonth] = React.useState(() => monthOptions()[0]?.value || '')

  const sales = useList<{ items?: GstInvoiceRow[]; total?: number }>(`/api/sales-invoices?companyId=${companyId}`)
  const purchases = useList<{ items?: GstInvoiceRow[]; total?: number }>(`/api/purchase-invoices?companyId=${companyId}`)
  const company = useList<{ id: string; name: string; gstin?: string | null; state?: string | null }>(
    `/api/settings?companyId=${companyId}`,
  )

  const [tab, setTab] = React.useState('gstr1')
  const range = monthRange(month)
  const rangeQs = `companyId=${companyId}&from=${range.from}&to=${range.to}`
  const gstr2 = useList<Gstr2Data>(tab === 'gstr2' ? `/api/reports/gstr2?${rangeQs}` : null)
  const gstr3b = useList<Gstr3bData>(tab === 'gstr3b' ? `/api/reports/gstr3b?${rangeQs}` : null)
  const fys = React.useMemo(() => fyOptions(), [])
  const [fy, setFy] = React.useState(() => fyOptions()[0]?.value || '')
  const gstr9 = useList<Gstr9Data>(tab === 'gstr9' ? `/api/reports/gstr9?companyId=${companyId}&fy=${fy}` : null)
  const [jsonBusy, setJsonBusy] = React.useState(false)

  async function downloadGstr1Json() {
    setJsonBusy(true)
    try {
      const d = await apiGet<Gstr1Json>(`/api/reports/gstr1-json?companyId=${companyId}&month=${month}`)
      const blob = new Blob([JSON.stringify(d.json, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `GSTR1_${d.json.gstin || 'NOGSTIN'}_${d.json.fp}.json`
      a.click()
      URL.revokeObjectURL(url)
      if (d.summary.missingGstin) toast.warning('Company GSTIN is not set (Settings) — add it before uploading')
      else {
        const extra = [
          d.summary.reverseChargeInvoices ? `${d.summary.reverseChargeInvoices} reverse-charge` : '',
          d.summary.foreignCurrencyInvoices ? `${d.summary.foreignCurrencyInvoices} in foreign currency (converted to INR)` : '',
        ].filter(Boolean).join(' · ')
        toast.success(
          `GSTR-1 JSON: ${d.summary.b2bInvoices} B2B invoice(s), ${d.summary.b2clInvoices ?? 0} B2CL invoice(s), ${d.summary.b2csRows} B2CS row(s), ${d.summary.creditNotes} credit note(s), ${d.summary.hsnRows} HSN row(s)`,
          extra ? { description: extra, duration: 7000 } : undefined,
        )
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to build GSTR-1 JSON')
    } finally {
      setJsonBusy(false)
    }
  }

  function printGstr2() {
    const d = gstr2.data
    if (!d) return
    const c = company.data
    const rows = d.items.map((b) => `<tr><td>${esc(fmtDate(b.date))}</td><td>${esc(b.number)}${b.supplierInvNo ? `<br/><span class="muted">${esc(b.supplierInvNo)}</span>` : ''}</td><td>${esc(b.supplierName)}<br/><span class="muted">${esc(b.gstin || 'Unregistered')}</span></td><td class="num">${fmtMoney(b.taxable)}</td><td class="num">${fmtMoney(b.cgst)}</td><td class="num">${fmtMoney(b.sgst)}</td><td class="num">${fmtMoney(b.igst)}</td><td class="num">${fmtMoney(b.cess)}</td><td class="num">${fmtMoney(b.grandTotal)}</td><td>${b.reverseCharge ? 'RCM' : '—'}</td><td>${b.itcEligible ? 'Yes' : 'No'}</td></tr>`).join('')
    printHtml(`GSTR-2 Purchase Register — ${monthLabel}`, `<div class="head"><div><h1>${esc(c?.name || 'Company')}</h1><div class="muted">GSTIN: ${esc(c?.gstin || '—')} · Purchase register (GSTR-2) · ${esc(monthLabel)}</div></div><span class="badge">GSTR-2</span></div>
      <table><thead><tr><th>Date</th><th>Bill</th><th>Supplier</th><th class="num">Taxable</th><th class="num">CGST</th><th class="num">SGST</th><th class="num">IGST</th><th class="num">Cess</th><th class="num">Total</th><th>RCM</th><th>ITC</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="11" class="muted">No bills in this month</td></tr>'}
      <tr class="grand"><td colspan="3">Total</td><td class="num">${fmtMoney(d.totals.taxable)}</td><td class="num">${fmtMoney(d.totals.cgst)}</td><td class="num">${fmtMoney(d.totals.sgst)}</td><td class="num">${fmtMoney(d.totals.igst)}</td><td class="num">${fmtMoney(d.totals.cess)}</td><td class="num">${fmtMoney(d.totals.grandTotal)}</td><td></td><td></td></tr></tbody></table>
      <p class="muted" style="margin-top:10px">ITC-eligible tax: ${fmtMoney(d.totals.itcEligibleTax)} · Ineligible (unregistered suppliers): ${fmtMoney(d.totals.itcIneligibleTax)} · Debit notes: ${d.totals.debitNotes} (tax ${fmtMoney(d.totals.debitNoteTax)})</p>
      <p class="muted">Reverse charge (self-assessed, claim under 3.1(d) / 4(A)(3)): ${d.totals.rcmBills} bill(s) · taxable ${fmtMoney(d.totals.rcmTaxable)} · tax ${fmtMoney(d.totals.rcmTax)}</p>`)
  }

  function printGstr3b() {
    const d = gstr3b.data
    if (!d) return
    const c = company.data
    const row = (label: string, h: Heads, taxable?: number) => `<tr><td>${esc(label)}</td><td class="num">${taxable === undefined ? '' : fmtMoney(taxable)}</td>${HEADS.map((x) => `<td class="num">${fmtMoney(h[x.key])}</td>`).join('')}</tr>`
    printHtml(`GSTR-3B Summary — ${monthLabel}`, `<div class="head"><div><h1>${esc(c?.name || 'Company')}</h1><div class="muted">GSTIN: ${esc(c?.gstin || '—')} · GSTR-3B summary · ${esc(monthLabel)}</div></div><span class="badge">GSTR-3B</span></div>
      <table><thead><tr><th>Section</th><th class="num">Taxable value</th>${HEADS.map((x) => `<th class="num">${x.label}</th>`).join('')}</tr></thead><tbody>
      ${row('3.1(a) Outward taxable supplies (net of credit notes)', d.outward.tax, d.outward.taxable)}
      ${row('4(A)(5) ITC — purchase bills (net of debit notes)', d.itc.bills)}
      ${row('4(A)(5) ITC — expenses', d.itc.expenses)}
      ${row('4(C) Net ITC available', d.itc.total)}
      ${row('4(D) Ineligible ITC (unregistered suppliers)', d.itc.ineligible)}
      ${d.reverseCharge?.inward.docs ? row('3.1(d) Inward supplies liable to reverse charge (self-assessed)', d.reverseCharge.inward.tax, d.reverseCharge.inward.taxable) : ''}
      ${d.reverseCharge?.outward.docs ? row('Outward reverse-charge invoices (tax payable by the buyer)', d.reverseCharge.outward.tax, d.reverseCharge.outward.taxable) : ''}
      ${row('6.1 Tax payable', d.payable)}
      ${row('Credit carried forward', d.credit)}
      </tbody></table>
      <p class="muted" style="margin-top:10px">Net payable: ${fmtMoney(d.totalPayable)} · Credit: ${fmtMoney(d.totalCredit)}. Per-head figures; cross-head set-off (IGST credit against CGST/SGST) is not applied.</p>`)
  }

  function printGstr9() {
    const d = gstr9.data
    if (!d) return
    const t4 = d.table4
    const r4 = (label: string, r: Gstr9Row, neg = false) => `<tr><td>${esc(label)}</td><td class="num">${r.count}</td><td class="num">${neg ? '−' : ''}${fmtMoney(r.taxable)}</td>${HEADS.map((x) => `<td class="num">${neg ? '−' : ''}${fmtMoney(r[x.key])}</td>`).join('')}</tr>`
    const r6 = (label: string, h: Heads) => `<tr><td>${esc(label)}</td>${HEADS.map((x) => `<td class="num">${fmtMoney(h[x.key])}</td>`).join('')}<td class="num">${fmtMoney(HEADS.reduce((s, x) => s + h[x.key], 0))}</td></tr>`
    const hsnRows = d.table17.rows.map((h) => `<tr><td>${esc(h.hsn)}</td><td>${esc(h.desc)}</td><td>${esc(h.uqc)}</td><td class="num">${fmtNum(h.qty)}</td><td class="num">${h.rate}%</td><td class="num">${fmtMoney(h.taxable)}</td><td class="num">${fmtMoney(h.igst)}</td><td class="num">${fmtMoney(h.cgst)}</td><td class="num">${fmtMoney(h.sgst)}</td><td class="num">${fmtMoney(h.cess)}</td></tr>`).join('')
    printHtml(`GSTR-9 Annual Summary — FY ${d.fyLabel}`, `<div class="head"><div><h1>${esc(company.data?.name || d.company.name || 'Company')}</h1><div class="muted">GSTIN: ${esc(d.company.gstin || '—')} · GSTR-9 annual summary · FY ${esc(d.fyLabel)} (${esc(fmtDate(d.from))} – ${esc(fmtDate(d.to))})</div></div><span class="badge">GSTR-9</span></div>
      <h3>Table 4 — Outward supplies</h3>
      <table><thead><tr><th>Nature</th><th class="num">Docs</th><th class="num">Taxable</th>${HEADS.map((x) => `<th class="num">${x.label}</th>`).join('')}</tr></thead><tbody>
      ${r4('B2B — to registered persons', t4.b2b)}${r4('B2C — to unregistered persons', t4.b2c)}
      ${r4('Credit notes — registered', t4.creditNotesB2b, true)}${r4('Credit notes — unregistered', t4.creditNotesB2c, true)}
      <tr class="grand"><td>Net outward supplies</td><td class="num">${t4.net.count}</td><td class="num">${fmtMoney(t4.net.taxable)}</td>${HEADS.map((x) => `<td class="num">${fmtMoney(t4.net[x.key])}</td>`).join('')}</tr></tbody></table>
      <h3>Table 6 — ITC availed</h3>
      <table><thead><tr><th>Source</th>${HEADS.map((x) => `<th class="num">${x.label}</th>`).join('')}<th class="num">Total</th></tr></thead><tbody>
      ${r6('Inputs — purchase bills, registered suppliers (net of debit notes)', d.table6.bills)}${r6('Input services / expenses marked ITC eligible', d.table6.expenses)}
      <tr class="grand"><td>Total ITC availed</td>${HEADS.map((x) => `<td class="num">${fmtMoney(d.table6.total[x.key])}</td>`).join('')}<td class="num">${fmtMoney(d.table6.totalTax)}</td></tr>
      ${r6('Not availed — bills from unregistered suppliers', d.table6.ineligible)}</tbody></table>
      <h3>Table 9 — Tax payable vs ITC</h3>
      <table><thead><tr><th>Head</th><th class="num">Tax payable</th><th class="num">ITC</th><th class="num">Net cash payable</th><th class="num">Credit left</th></tr></thead><tbody>
      ${HEADS.map((x) => { const h = d.table9.heads[x.key]; return `<tr><td>${x.label}</td><td class="num">${fmtMoney(h.payable)}</td><td class="num">${fmtMoney(h.itc)}</td><td class="num">${fmtMoney(h.cash)}</td><td class="num">${fmtMoney(h.credit)}</td></tr>` }).join('')}
      <tr class="grand"><td>Total</td><td class="num">${fmtMoney(d.table9.totalPayable)}</td><td class="num">${fmtMoney(d.table9.totalItc)}</td><td class="num">${fmtMoney(d.table9.totalCash)}</td><td class="num">${fmtMoney(d.table9.totalCredit)}</td></tr></tbody></table>
      <h3>Table 17 — HSN summary of outward supplies</h3>
      <table><thead><tr><th>HSN</th><th>Description</th><th>UQC</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">Taxable</th><th class="num">IGST</th><th class="num">CGST</th><th class="num">SGST</th><th class="num">Cess</th></tr></thead><tbody>
      ${hsnRows || '<tr><td colspan="10" class="muted">No outward supplies in this FY</td></tr>'}
      <tr class="grand"><td colspan="3">Total</td><td class="num">${fmtNum(d.table17.totals.qty)}</td><td></td><td class="num">${fmtMoney(d.table17.totals.taxable)}</td><td colspan="4" class="num">Tax ${fmtMoney(d.table17.totals.totalTax)}</td></tr></tbody></table>
      <p class="muted" style="margin-top:10px">${esc(GSTR9_NOTE)}</p>`)
  }

  const [detail, setDetail] = React.useState<DrillState | null>(null)
  const [detailLoading, setDetailLoading] = React.useState(false)

  const inMonth = React.useCallback((r: GstInvoiceRow) => String(r.date).slice(0, 7) === month, [month])
  const salesRows = (sales.data?.items ?? []).filter((r) => r.status !== 'CANCELLED' && inMonth(r))
  const purchaseRows = (purchases.data?.items ?? []).filter((r) => r.status !== 'CANCELLED' && inMonth(r))

  const outputTax = r2(salesRows.reduce((s, r) => s + taxOf(r), 0))
  const inputTax = r2(purchaseRows.reduce((s, r) => s + taxOf(r), 0))
  const netPayable = r2(outputTax - inputTax)
  const monthLabel = months.find((m) => m.value === month)?.label || month

  async function openDetail(type: 'sales' | 'purchase', inv: GstInvoiceRow) {
    setDetail({ type, inv, items: [] })
    setDetailLoading(true)
    try {
      const d = await apiGet<InvoiceDetail>(`/api/${type === 'sales' ? 'sales-invoices' : 'purchase-invoices'}/${inv.id}`)
      setDetail({ type, inv, items: d?.items ?? [] })
    } catch (e) {
      setDetail(null)
      toast.error(e instanceof Error ? e.message : 'Failed to load invoice items')
    } finally {
      setDetailLoading(false)
    }
  }

  function printGstr1() {
    const c = company.data
    const rowHtml = (r: GstInvoiceRow) =>
      `<tr><td>${esc(r.number)}</td><td>${esc(fmtDate(r.date))}</td><td>${esc(r.customer?.name || '—')}<br/><span class="muted">${esc(r.customer?.gstin || '')}</span></td><td>${r.customer?.gstin ? 'B2B' : 'B2C'}</td><td class="num">${fmtMoney(taxableOf(r))}</td><td class="num">${fmtMoney(r.cgst)}</td><td class="num">${fmtMoney(r.sgst)}</td><td class="num">${fmtMoney(r.igst)}</td><td class="num">${fmtMoney(r.grandTotal)}</td></tr>`
    const tot = (fn: (r: GstInvoiceRow) => number) => fmtMoney(salesRows.reduce((s, r) => s + fn(r), 0))
    printHtml(
      `GSTR-1 Summary — ${monthLabel}`,
      `<div class="head">
        <div>
          <h1>${esc(c?.name || 'Company')}</h1>
          <div class="muted">GSTIN: ${esc(c?.gstin || '—')}${c?.state ? ' · ' + esc(c.state) : ''} · GSTR-1 Outward Supplies · ${esc(monthLabel)}</div>
        </div>
        <span class="badge">GSTR-1</span>
      </div>
      <table>
        <thead><tr><th>Invoice</th><th>Date</th><th>Customer</th><th>Type</th><th class="num">Taxable</th><th class="num">CGST</th><th class="num">SGST</th><th class="num">IGST</th><th class="num">Total</th></tr></thead>
        <tbody>${salesRows.map(rowHtml).join('') || '<tr><td colspan="9" class="muted">No sales invoices in selected month</td></tr>'}
        <tr class="grand"><td colspan="4">Total</td><td class="num">${tot(taxableOf)}</td><td class="num">${tot((r) => r.cgst || 0)}</td><td class="num">${tot((r) => r.sgst || 0)}</td><td class="num">${tot((r) => r.igst || 0)}</td><td class="num">${tot((r) => r.grandTotal || 0)}</td></tr>
        </tbody>
      </table>
      <p class="muted" style="margin-top:10px">Output Tax: ${fmtMoney(outputTax)} · Input Tax Credit (purchases): ${fmtMoney(inputTax)} · Net GST ${netPayable >= 0 ? 'payable' : 'credit'}: ${fmtMoney(Math.abs(netPayable))}</p>`,
    )
  }

  return (
    <div>
      <PageHeader
        title="GST Report"
        description="GSTR-1 outward supplies, GSTR-2 purchase register, GSTR-3B summary and GSTR-9 annual summary"
        actions={
          <>
            <div className="w-36">
              {tab === 'gstr9'
                ? <SelectInput value={fy} onChange={setFy} options={fys} />
                : <SelectInput value={month} onChange={setMonth} options={months} />}
            </div>
            <Button variant="outline" size="sm" onClick={() => void downloadGstr1Json()} disabled={jsonBusy}>
              <FileJson className="h-4 w-4 mr-1.5" />{jsonBusy ? 'Building…' : 'Download GSTR-1 JSON'}
            </Button>
            <PrintButton
              onClick={tab === 'gstr2' ? printGstr2 : tab === 'gstr3b' ? printGstr3b : tab === 'gstr9' ? printGstr9 : printGstr1}
              label={tab === 'gstr2' ? 'Print GSTR-2' : tab === 'gstr3b' ? 'Print GSTR-3B' : tab === 'gstr9' ? 'Print GSTR-9' : 'Print GSTR-1'}
            />
          </>
        }
      />
      <Tabs value={tab} onValueChange={setTab} className="gap-4">
        <TabsList className="flex-wrap h-auto">
          <TabsTrigger value="gstr1">GSTR-1</TabsTrigger>
          <TabsTrigger value="gstr2">GSTR-2</TabsTrigger>
          <TabsTrigger value="gstr3b">GSTR-3B</TabsTrigger>
          <TabsTrigger value="gstr9">GSTR-9 (Annual)</TabsTrigger>
        </TabsList>
        <TabsContent value="gstr1">
      <div className="grid gap-3 sm:grid-cols-3 mb-4">
        <StatCard
          title="Output Tax (Sales)"
          value={fmtMoney(outputTax)}
          sub={`${salesRows.length} invoices · CGST+SGST+IGST`}
          icon={<ArrowUpFromLine className="h-4 w-4" />}
        />
        <StatCard
          title="Input Tax (Purchases)"
          value={fmtMoney(inputTax)}
          sub={`${purchaseRows.length} invoices`}
          icon={<ArrowDownToLine className="h-4 w-4" />}
          toneClass="bg-sky-100 text-sky-600"
        />
        <StatCard
          title={netPayable >= 0 ? 'Net GST Payable' : 'Net GST Credit'}
          value={fmtMoney(Math.abs(netPayable))}
          sub={netPayable >= 0 ? 'Payable to government' : 'Credit carried forward'}
          icon={<Scale className="h-4 w-4" />}
          toneClass={netPayable >= 0 ? 'bg-red-100 text-red-600' : 'bg-emerald-100 text-emerald-600'}
        />
      </div>
      <div className="space-y-4">
        <SectionCard title={`GSTR-1 — Sales / Outward Supplies (${monthLabel})`}>
          <TotalsStrip rows={salesRows} label="Sales totals" />
          <GstInvoiceTable
            rows={salesRows}
            party="customer"
            loading={sales.loading}
            onDrill={(inv) => void openDetail('sales', inv)}
            emptyText="No sales invoices in this month"
          />
        </SectionCard>
        <SectionCard title={`Purchase Invoices — Input Tax (${monthLabel})`}>
          <TotalsStrip rows={purchaseRows} label="Purchase totals" />
          <GstInvoiceTable
            rows={purchaseRows}
            party="supplier"
            loading={purchases.loading}
            onDrill={(inv) => void openDetail('purchase', inv)}
            emptyText="No purchase invoices in this month"
          />
        </SectionCard>
      </div>
        </TabsContent>

        <TabsContent value="gstr2" className="space-y-4">
          <Gstr2View data={gstr2.data} loading={gstr2.loading} monthLabel={monthLabel} />
        </TabsContent>

        <TabsContent value="gstr3b" className="space-y-4">
          <Gstr3bView data={gstr3b.data} loading={gstr3b.loading} monthLabel={monthLabel} />
        </TabsContent>

        <TabsContent value="gstr9" className="space-y-4">
          <Gstr9View data={gstr9.data} loading={gstr9.loading} />
        </TabsContent>
      </Tabs>

      <Dialog open={!!detail} onOpenChange={(o) => { if (!o) setDetail(null) }}>
        <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{detail?.inv.number} — line items</DialogTitle>
            <DialogDescription>
              {detail?.inv.customer?.name || detail?.inv.supplier?.name || '—'}
              {detail ? ` · ${fmtDate(detail.inv.date)}` : ''} · HSN-wise breakup
            </DialogDescription>
          </DialogHeader>
          {detailLoading ? (
            <div className="py-10 text-center text-sm text-muted-foreground">Loading items…</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Item</TableHead>
                  <TableHead>HSN</TableHead>
                  <TableHead className="text-right">Qty</TableHead>
                  <TableHead className="text-right">Rate</TableHead>
                  <TableHead className="text-right">Taxable</TableHead>
                  <TableHead className="text-right">GST</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(detail?.items ?? []).length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center text-sm text-muted-foreground py-8">
                      No line items
                    </TableCell>
                  </TableRow>
                ) : (
                  detail?.items.map((it) => {
                    const taxable = it.lineTotal || r2((it.qty || 0) * (it.rate || 0))
                    const gst = r2(taxable * ((it.gstRate || 0) / 100))
                    return (
                      <TableRow key={it.id}>
                        <TableCell className="text-sm">{it.item?.name || '—'}</TableCell>
                        <TableCell className="text-xs font-mono">{it.hsn || '—'}</TableCell>
                        <TableCell className="text-right tabular-nums whitespace-nowrap">{fmtNum(it.qty)}</TableCell>
                        <TableCell className="text-right tabular-nums whitespace-nowrap">{fmtMoney(it.rate)}</TableCell>
                        <TableCell className="text-right tabular-nums whitespace-nowrap">{fmtMoney(taxable)}</TableCell>
                        <TableCell className="text-right tabular-nums whitespace-nowrap">
                          {fmtMoney(gst)} <span className="text-[10px] text-muted-foreground">@{it.gstRate || 0}%</span>
                        </TableCell>
                        <TableCell className="text-right tabular-nums whitespace-nowrap font-medium">{fmtMoney(r2(taxable + gst))}</TableCell>
                      </TableRow>
                    )
                  })
                )}
              </TableBody>
            </Table>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ---------------- GSTR-2 (purchase register) ----------------

type Gstr2SupplierRow = Gstr2Data['bySupplier'][number] & { id: string }
type Gstr2NoteRow = Gstr2Data['debitNotes'][number]

const GSTR2_HEADERS = ['Date', 'Bill', 'Supplier Inv No', 'Supplier', 'GSTIN', 'Taxable', 'CGST', 'SGST', 'IGST', 'Cess', 'Total', 'Reverse charge', 'ITC eligible']
const gstr2Pick = (r: Gstr2Bill): (string | number)[] => [
  String(r.date).slice(0, 10), r.number, r.supplierInvNo || '', r.supplierName, r.gstin || '',
  r.taxable, r.cgst, r.sgst, r.igst, r.cess, r.grandTotal, r.reverseCharge ? 'Yes' : 'No', r.itcEligible ? 'Yes' : 'No',
]

function Gstr2View({ data, loading, monthLabel }: { data: Gstr2Data | null; loading: boolean; monthLabel: string }) {
  const t = data?.totals
  const billCols: Column<Gstr2Bill>[] = [
    { key: 'date', header: 'Date', render: (r) => <DateCell value={r.date} /> },
    {
      key: 'number', header: 'Bill',
      render: (r) => (
        <div>
          <p className="font-mono text-xs">{r.number}</p>
          {r.supplierInvNo && <p className="text-[11px] text-muted-foreground">Inv {r.supplierInvNo}</p>}
        </div>
      ),
    },
    {
      key: 'supplierName', header: 'Supplier',
      render: (r) => (
        <div className="min-w-0">
          <p className="truncate max-w-48">{r.supplierName}</p>
          <p className="text-[11px] font-mono text-muted-foreground">{r.gstin || 'Unregistered'}</p>
        </div>
      ),
    },
    { key: 'taxable', header: 'Taxable', className: 'text-right', sum: true, sumFormat: 'money', render: (r) => <Money value={r.taxable} /> },
    { key: 'cgst', header: 'CGST', className: 'text-right', hideOnMobile: true, sum: true, sumFormat: 'money', render: (r) => <Money value={r.cgst} /> },
    { key: 'sgst', header: 'SGST', className: 'text-right', hideOnMobile: true, sum: true, sumFormat: 'money', render: (r) => <Money value={r.sgst} /> },
    { key: 'igst', header: 'IGST', className: 'text-right', hideOnMobile: true, sum: true, sumFormat: 'money', render: (r) => <Money value={r.igst} /> },
    { key: 'cess', header: 'Cess', className: 'text-right', hideOnMobile: true, sum: true, sumFormat: 'money', render: (r) => <Money value={r.cess} /> },
    { key: 'grandTotal', header: 'Total', className: 'text-right', sum: true, sumFormat: 'money', render: (r) => <Money value={r.grandTotal} className="font-medium" /> },
    {
      key: 'reverseCharge', header: 'RCM', hideOnMobile: true,
      render: (r) => (
        r.reverseCharge
          ? <span className="inline-flex whitespace-nowrap rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:bg-amber-950 dark:text-amber-300" title="Reverse charge — self-assessed tax, claim under 3.1(d)">RCM</span>
          : <span className="text-muted-foreground">—</span>
      ),
    },
    {
      key: 'itcEligible', header: 'ITC',
      render: (r) => (
        <span className={`inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium ${r.itcEligible ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300' : 'bg-muted text-muted-foreground'}`}>
          {r.itcEligible ? 'Eligible' : 'No GSTIN'}
        </span>
      ),
    },
  ]
  const supplierCols: Column<Gstr2SupplierRow>[] = [
    {
      key: 'name', header: 'Supplier',
      render: (r) => (
        <div>
          <p className="truncate max-w-56">{r.name}</p>
          <p className="text-[11px] font-mono text-muted-foreground">{r.gstin || 'Unregistered'}</p>
        </div>
      ),
    },
    {
      key: 'bills', header: 'Bills', className: 'text-right',
      render: (r) => (
        <span className="tabular-nums">
          {r.bills}
          {r.rcmBills ? <span className="ml-1 text-[11px] text-amber-700 dark:text-amber-400">({r.rcmBills} RCM)</span> : null}
        </span>
      ),
    },
    { key: 'taxable', header: 'Taxable', className: 'text-right', render: (r) => <Money value={r.taxable} /> },
    { key: 'tax', header: 'GST + Cess', className: 'text-right', render: (r) => <Money value={r2(r.cgst + r.sgst + r.igst + r.cess)} /> },
    { key: 'total', header: 'Total', className: 'text-right', render: (r) => <Money value={r.total} className="font-medium" /> },
  ]
  const noteCols: Column<Gstr2NoteRow>[] = [
    { key: 'date', header: 'Date', render: (r) => <DateCell value={r.date} /> },
    { key: 'number', header: 'Debit note', render: (r) => <span className="font-mono text-xs">{r.number}</span> },
    { key: 'invoiceNumber', header: 'Against bill', hideOnMobile: true, render: (r) => <span className="font-mono text-xs">{r.invoiceNumber}</span> },
    { key: 'supplierName', header: 'Supplier', render: (r) => <span className="truncate block max-w-40">{r.supplierName}</span> },
    { key: 'taxable', header: 'Taxable', className: 'text-right', render: (r) => <Money value={r.taxable} /> },
    { key: 'tax', header: 'GST', className: 'text-right', render: (r) => <Money value={r2(r.cgst + r.sgst + r.igst)} /> },
  ]
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard title="Bills" value={t ? t.bills : '—'} sub={monthLabel} icon={<ArrowDownToLine className="h-4 w-4" />} />
        <StatCard title="Taxable Value" value={t ? fmtMoney(t.taxable) : '—'} sub="Net of bill discounts" icon={<Scale className="h-4 w-4" />} toneClass="bg-sky-100 text-sky-600" />
        <StatCard title="ITC Eligible Tax" value={t ? fmtMoney(t.itcEligibleTax) : '—'} sub="Bills from registered suppliers" icon={<ArrowDownToLine className="h-4 w-4" />} toneClass="bg-emerald-100 text-emerald-600" />
        <StatCard title="Ineligible Tax" value={t ? fmtMoney(t.itcIneligibleTax) : '—'} sub={t ? `Debit notes ${t.debitNotes} · tax ${fmtMoney(t.debitNoteTax)}` : 'Unregistered suppliers'} icon={<ArrowUpFromLine className="h-4 w-4" />} toneClass="bg-amber-100 text-amber-600" />
      </div>
      {t && t.rcmBills > 0 && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
          <strong>{t.rcmBills} reverse-charge bill(s)</strong> this month · taxable {fmtMoney(t.rcmTaxable)} · self-assessed tax {fmtMoney(t.rcmTax)} —
          credit is claimed under 3.1(d) / 4(A)(3), not as ordinary ITC.
        </p>
      )}
      <SectionCard title={`Purchase register (${monthLabel})`}>
        <DataTable
          columns={billCols}
          rows={data?.items ?? []}
          loading={loading}
          searchPlaceholder="Search bills…"
          emptyText="No purchase bills in this month"
          csvExport={{ filename: `gstr2-${monthLabel}`, headers: GSTR2_HEADERS, pick: gstr2Pick }}
          xlsxExport={{ filename: `gstr2-${monthLabel}`, headers: GSTR2_HEADERS, pick: gstr2Pick }}
        />
      </SectionCard>
      <div className="grid gap-4 lg:grid-cols-2">
        <SectionCard title="Supplier GSTIN-wise summary">
          <DataTable columns={supplierCols} rows={(data?.bySupplier ?? []).map((r) => ({ ...r, id: r.key }))} loading={loading} pageSize={8} emptyText="No suppliers" />
        </SectionCard>
        <SectionCard title="Debit notes (purchase returns)">
          <DataTable columns={noteCols} rows={data?.debitNotes ?? []} loading={loading} pageSize={8} emptyText="No debit notes in this month" />
        </SectionCard>
      </div>
    </>
  )
}

// ---------------- GSTR-3B (summary) ----------------

function Gstr3bView({ data, loading, monthLabel }: { data: Gstr3bData | null; loading: boolean; monthLabel: string }) {
  if (!data) {
    return <div className="py-12 text-center text-sm text-muted-foreground">{loading ? 'Loading GSTR-3B…' : 'No data'}</div>
  }
  const rows: { label: string; sub?: string; h: Heads; taxable?: number; strong?: boolean }[] = [
    { label: '3.1(a) Outward taxable supplies', sub: `${data.outward.invoices} invoice(s), ${data.outward.creditNotes} credit note(s) deducted`, h: data.outward.tax, taxable: data.outward.taxable, strong: true },
    { label: '4(A)(5) ITC — purchase bills', sub: 'Registered suppliers, net of debit notes', h: data.itc.bills },
    { label: '4(A)(5) ITC — expenses', sub: 'Expenses marked ITC eligible', h: data.itc.expenses },
    { label: '4(C) Net ITC available', h: data.itc.total, strong: true },
    { label: '4(D) Ineligible ITC', sub: 'Bills from suppliers without a GSTIN', h: data.itc.ineligible },
    ...(data.reverseCharge?.inward.docs
      ? [{
        label: '3.1(d) Inward supplies liable to reverse charge',
        sub: `${data.reverseCharge.inward.docs} bill(s) — self-assessed, claimed back as ITC`,
        h: data.reverseCharge.inward.tax,
        taxable: data.reverseCharge.inward.taxable,
      }]
      : []),
    ...(data.reverseCharge?.outward.docs
      ? [{
        label: 'Outward reverse-charge invoices',
        sub: `${data.reverseCharge.outward.docs} invoice(s) — tax payable by the buyer, not collected by you`,
        h: data.reverseCharge.outward.tax,
        taxable: data.reverseCharge.outward.taxable,
      }]
      : []),
    { label: '6.1 Tax payable', h: data.payable, strong: true },
    { label: 'Credit carried forward', h: data.credit },
  ]
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard title="Output Tax" value={fmtMoney(data.outward.totalTax)} sub={`Taxable ${fmtMoney(data.outward.taxable)}`} icon={<ArrowUpFromLine className="h-4 w-4" />} />
        <StatCard title="Net ITC" value={fmtMoney(data.itc.totalTax)} sub="Bills + eligible expenses" icon={<ArrowDownToLine className="h-4 w-4" />} toneClass="bg-sky-100 text-sky-600" />
        <StatCard
          title={data.netTotal >= 0 ? 'Net GST Payable' : 'Net GST Credit'}
          value={fmtMoney(Math.abs(data.netTotal))}
          sub={`Payable ${fmtMoney(data.totalPayable)} · credit ${fmtMoney(data.totalCredit)}`}
          icon={<Scale className="h-4 w-4" />}
          toneClass={data.netTotal >= 0 ? 'bg-red-100 text-red-600' : 'bg-emerald-100 text-emerald-600'}
        />
      </div>
      <SectionCard title={`GSTR-3B summary (${monthLabel})`}>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Section</TableHead>
                <TableHead className="text-right">Taxable</TableHead>
                {HEADS.map((x) => <TableHead key={x.key} className="text-right">{x.label}</TableHead>)}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.label} className={r.strong ? 'font-medium bg-muted/30' : undefined}>
                  <TableCell>
                    <p className="text-sm">{r.label}</p>
                    {r.sub && <p className="text-[11px] font-normal text-muted-foreground">{r.sub}</p>}
                  </TableCell>
                  <TableCell className="text-right tabular-nums whitespace-nowrap">{r.taxable === undefined ? '' : fmtMoney(r.taxable)}</TableCell>
                  {HEADS.map((x) => <TableCell key={x.key} className="text-right tabular-nums whitespace-nowrap">{fmtMoney(r.h[x.key])}</TableCell>)}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          Best-effort figures from saved documents. Payable is per tax head; cross-head set-off of IGST credit,
          interest and late fee are not computed — verify on the GST portal before filing. Foreign-currency
          invoices are converted to INR at their recorded exchange rate, and reverse-charge tax is kept out of
          3.1(a) because the buyer pays it.
        </p>
      </SectionCard>
    </>
  )
}

// ---------------- GSTR-9 (annual summary) ----------------

const GSTR9_NOTE =
  'Helper summary to fill GSTR-9 on the GST portal — NOT a filing. Figures are computed from saved documents (sales invoices, ' +
  'credit notes, purchase bills, debit notes, ITC-eligible expenses) for the whole FY. Tax actually paid through challans / the ' +
  'electronic cash ledger is not recorded in the ERP, so Table 9 shows tax payable vs ITC per head only (no cross-head set-off, ' +
  'interest or late fee). The HSN summary is from invoice lines before credit notes; freight / packing are not in it. ' +
  'Reconcile with your filed GSTR-1 / GSTR-3B and GSTR-2B before filing.'

const GSTR9_XLSX_HEADERS = ['Table', 'Description', 'HSN', 'UQC', 'Qty', 'Rate %', 'Docs', 'Taxable', 'IGST', 'CGST', 'SGST', 'Cess', 'Total tax']

function gstr9Rows(d: Gstr9Data): (string | number)[][] {
  const rows: (string | number)[][] = []
  const hTot = (h: Heads) => r2(h.igst + h.cgst + h.sgst + h.cess)
  const row4 = (label: string, r: Gstr9Row, sign = 1) =>
    rows.push(['4', label, '', '', '', '', r.count, r2(sign * r.taxable), r2(sign * r.igst), r2(sign * r.cgst), r2(sign * r.sgst), r2(sign * r.cess), r2(sign * hTot(r))])
  row4('B2B — to registered persons', d.table4.b2b)
  row4('B2C — to unregistered persons', d.table4.b2c)
  row4('Credit notes — registered', d.table4.creditNotesB2b, -1)
  row4('Credit notes — unregistered', d.table4.creditNotesB2c, -1)
  row4('Net outward supplies', d.table4.net)
  rows.push([])
  const row6 = (label: string, h: Heads) => rows.push(['6', label, '', '', '', '', '', '', h.igst, h.cgst, h.sgst, h.cess, hTot(h)])
  row6('Inputs — purchase bills, registered suppliers (net of debit notes)', d.table6.bills)
  row6('Input services / expenses marked ITC eligible', d.table6.expenses)
  row6('Total ITC availed', d.table6.total)
  row6('Not availed — bills from unregistered suppliers', d.table6.ineligible)
  rows.push([])
  const h9 = d.table9.heads
  const row9 = (label: string, k: 'payable' | 'itc' | 'cash' | 'credit') =>
    rows.push(['9', label, '', '', '', '', '', '', h9.igst[k], h9.cgst[k], h9.sgst[k], h9.cess[k], r2(h9.igst[k] + h9.cgst[k] + h9.sgst[k] + h9.cess[k])])
  row9('Tax payable', 'payable')
  row9('ITC available', 'itc')
  row9('Net cash payable', 'cash')
  row9('Credit left', 'credit')
  rows.push([])
  for (const h of d.table17.rows) rows.push(['17', h.desc, h.hsn, h.uqc, h.qty, h.rate, '', h.taxable, h.igst, h.cgst, h.sgst, h.cess, h.totalTax])
  rows.push([])
  rows.push(['Note', GSTR9_NOTE])
  return rows
}

function Gstr9View({ data, loading }: { data: Gstr9Data | null; loading: boolean }) {
  if (!data) {
    return <div className="py-12 text-center text-sm text-muted-foreground">{loading ? 'Loading GSTR-9…' : 'No data'}</div>
  }
  const t4 = data.table4
  const t9 = data.table9
  const num = 'text-right tabular-nums whitespace-nowrap'
  const rows4: { label: string; r: Gstr9Row; neg?: boolean; strong?: boolean }[] = [
    { label: 'B2B — to registered persons', r: t4.b2b },
    { label: 'B2C — to unregistered persons', r: t4.b2c },
    { label: 'Credit notes — registered', r: t4.creditNotesB2b, neg: true },
    { label: 'Credit notes — unregistered', r: t4.creditNotesB2c, neg: true },
    { label: 'Net outward supplies', r: t4.net, strong: true },
  ]
  const rows6: { label: string; h: Heads; strong?: boolean }[] = [
    { label: 'Inputs — purchase bills (registered suppliers, net of debit notes)', h: data.table6.bills },
    { label: 'Input services — expenses marked ITC eligible', h: data.table6.expenses },
    { label: 'Total ITC availed', h: data.table6.total, strong: true },
    { label: 'Not availed — bills from unregistered suppliers', h: data.table6.ineligible },
  ]
  const hsnCols: Column<Gstr9Hsn & { id: string }>[] = [
    { key: 'hsn', header: 'HSN', render: (r) => <span className="font-mono text-xs">{r.hsn}</span> },
    { key: 'desc', header: 'Description', hideOnMobile: true, render: (r) => <span className="block max-w-48 truncate">{r.desc || '—'}</span> },
    { key: 'uqc', header: 'UQC', render: (r) => <span className="text-xs">{r.uqc}</span> },
    { key: 'qty', header: 'Qty', className: 'text-right', render: (r) => <span className="tabular-nums">{fmtNum(r.qty)}</span> },
    { key: 'rate', header: 'Rate', className: 'text-right', render: (r) => <span className="tabular-nums">{r.rate}%</span> },
    { key: 'taxable', header: 'Taxable', className: 'text-right', sum: true, sumFormat: 'money', render: (r) => <Money value={r.taxable} /> },
    { key: 'igst', header: 'IGST', className: 'text-right', hideOnMobile: true, sum: true, sumFormat: 'money', render: (r) => <Money value={r.igst} /> },
    { key: 'cgst', header: 'CGST', className: 'text-right', hideOnMobile: true, sum: true, sumFormat: 'money', render: (r) => <Money value={r.cgst} /> },
    { key: 'sgst', header: 'SGST', className: 'text-right', hideOnMobile: true, sum: true, sumFormat: 'money', render: (r) => <Money value={r.sgst} /> },
    { key: 'cess', header: 'Cess', className: 'text-right', hideOnMobile: true, sum: true, sumFormat: 'money', render: (r) => <Money value={r.cess} /> },
    { key: 'totalTax', header: 'Total tax', className: 'text-right', sum: true, sumFormat: 'money', render: (r) => <Money value={r.totalTax} className="font-medium" /> },
  ]
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard title="Net Outward Taxable" value={fmtMoney(t4.net.taxable)} sub={`Tax ${fmtMoney(t4.totalTax)} · FY ${data.fyLabel}`} icon={<ArrowUpFromLine className="h-4 w-4" />} />
        <StatCard title="ITC Availed" value={fmtMoney(data.table6.totalTax)} sub="Bills + eligible expenses" icon={<ArrowDownToLine className="h-4 w-4" />} toneClass="bg-sky-100 text-sky-600" />
        <StatCard
          title="Net Cash Payable"
          value={fmtMoney(t9.totalCash)}
          sub={`Credit left ${fmtMoney(t9.totalCredit)} (per head)`}
          icon={<Scale className="h-4 w-4" />}
          toneClass={t9.totalCash > 0 ? 'bg-red-100 text-red-600' : 'bg-emerald-100 text-emerald-600'}
        />
      </div>

      <SectionCard
        title={`Table 4 — Outward supplies (FY ${data.fyLabel})`}
        actions={
          <Button variant="outline" size="sm" onClick={() => downloadXlsx(`gstr9-FY${data.fyLabel}`, GSTR9_XLSX_HEADERS, gstr9Rows(data))}>
            <FileSpreadsheet className="h-4 w-4 mr-1.5" />Excel
          </Button>
        }
      >
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Nature of supply</TableHead>
                <TableHead className="text-right">Docs</TableHead>
                <TableHead className="text-right">Taxable</TableHead>
                {HEADS.map((x) => <TableHead key={x.key} className="text-right">{x.label}</TableHead>)}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows4.map(({ label, r, neg, strong }) => (
                <TableRow key={label} className={strong ? 'font-medium bg-muted/30' : undefined}>
                  <TableCell className="text-sm">{label}</TableCell>
                  <TableCell className={num}>{r.count}</TableCell>
                  <TableCell className={num}>{neg ? '−' : ''}{fmtMoney(r.taxable)}</TableCell>
                  {HEADS.map((x) => <TableCell key={x.key} className={num}>{neg ? '−' : ''}{fmtMoney(r[x.key])}</TableCell>)}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </SectionCard>

      <div className="grid gap-4 lg:grid-cols-2">
        <SectionCard title="Table 6 — ITC availed">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Source</TableHead>
                  {HEADS.map((x) => <TableHead key={x.key} className="text-right">{x.label}</TableHead>)}
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows6.map(({ label, h, strong }) => (
                  <TableRow key={label} className={strong ? 'font-medium bg-muted/30' : undefined}>
                    <TableCell className="text-sm">{label}</TableCell>
                    {HEADS.map((x) => <TableCell key={x.key} className={num}>{fmtMoney(h[x.key])}</TableCell>)}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </SectionCard>
        <SectionCard title="Table 9 — Tax payable vs ITC">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Head</TableHead>
                  <TableHead className="text-right">Payable</TableHead>
                  <TableHead className="text-right">ITC</TableHead>
                  <TableHead className="text-right">Net cash</TableHead>
                  <TableHead className="text-right">Credit left</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {HEADS.map((x) => {
                  const h = t9.heads[x.key]
                  return (
                    <TableRow key={x.key}>
                      <TableCell className="text-sm">{x.label}</TableCell>
                      <TableCell className={num}>{fmtMoney(h.payable)}</TableCell>
                      <TableCell className={num}>{fmtMoney(h.itc)}</TableCell>
                      <TableCell className={num}>{fmtMoney(h.cash)}</TableCell>
                      <TableCell className={num}>{fmtMoney(h.credit)}</TableCell>
                    </TableRow>
                  )
                })}
                <TableRow className="font-medium bg-muted/30">
                  <TableCell>Total</TableCell>
                  <TableCell className={num}>{fmtMoney(t9.totalPayable)}</TableCell>
                  <TableCell className={num}>{fmtMoney(t9.totalItc)}</TableCell>
                  <TableCell className={num}>{fmtMoney(t9.totalCash)}</TableCell>
                  <TableCell className={num}>{fmtMoney(t9.totalCredit)}</TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>
          <p className="mt-2 text-[11px] text-muted-foreground">Tax actually paid via challans (cash ledger) is not recorded in the ERP — take paid amounts from the portal.</p>
        </SectionCard>
      </div>

      <SectionCard title="Table 17 — HSN summary of outward supplies">
        <DataTable
          columns={hsnCols}
          rows={data.table17.rows.map((r) => ({ ...r, id: `${r.hsn}|${r.rate}` }))}
          loading={loading}
          searchPlaceholder="Search HSN…"
          emptyText="No outward supplies in this FY"
          pageSize={10}
        />
      </SectionCard>

      <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
        {GSTR9_NOTE}
      </p>
    </>
  )
}
