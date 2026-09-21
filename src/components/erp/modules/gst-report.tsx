'use client'

import * as React from 'react'
import { ArrowDownToLine, ArrowUpFromLine, Scale } from 'lucide-react'
import { toast } from 'sonner'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import {
  Column, DataTable, DateCell, Money, PageHeader, PrintButton, SectionCard, SelectInput, StatCard, printHtml,
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

interface DrillState {
  type: 'sales' | 'purchase'
  inv: GstInvoiceRow
  items: DetailItem[]
}

const r2 = (n: number) => Math.round(n * 100) / 100

const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const taxableOf = (r: GstInvoiceRow) => r2((r.subtotal || 0) - (r.discountTotal || 0))
const taxOf = (r: GstInvoiceRow) => r2((r.cgst || 0) + (r.sgst || 0) + (r.igst || 0))

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
  const months = React.useMemo(monthOptions, [])
  const [month, setMonth] = React.useState(() => monthOptions()[0]?.value || '')

  const sales = useList<{ items?: GstInvoiceRow[]; total?: number }>(`/api/sales-invoices?companyId=${companyId}`)
  const purchases = useList<{ items?: GstInvoiceRow[]; total?: number }>(`/api/purchase-invoices?companyId=${companyId}`)
  const company = useList<{ id: string; name: string; gstin?: string | null; state?: string | null }>(
    `/api/settings?companyId=${companyId}`,
  )

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
        description="GSTR-1 style outward supply summary with input tax credit comparison"
        actions={
          <>
            <div className="w-36">
              <SelectInput value={month} onChange={setMonth} options={months} />
            </div>
            <PrintButton onClick={printGstr1} label="Print GSTR-1" />
          </>
        }
      />
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
