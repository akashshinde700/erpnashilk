'use client'

import * as React from 'react'
import { toast } from 'sonner'
import { AlertTriangle, FileText, IndianRupee, ReceiptText } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Column, DataTable, DateCell, DateInput, Money, PageHeader, PrintButton, SectionCard, StatCard, StatusBadge, printHtml,
} from '@/components/erp/kit'
import { fmtDate, fmtMoney } from '@/lib/erp-constants'
import { apiGet, useList } from '@/lib/use-api'
import { amountInWords } from '@/lib/number-to-words'

interface InvoiceRow {
  id: string
  number: string
  date: string
  dueDate?: string | null
  customerId?: string | null
  grandTotal: number
  paidAmount: number
  status: string
  customer?: { name?: string | null } | null
}

interface CompanyProfile {
  name?: string | null
  gstin?: string | null
  addressLine?: string | null
  city?: string | null
  state?: string | null
  phone?: string | null
  email?: string | null
}

interface StatementRow { date: string; type: 'INVOICE' | 'PAYMENT'; ref: string; particulars: string; debit: number; credit: number; balance: number }
interface StatementData {
  customer: { id: string; name: string; code: string; gstin?: string | null; phone?: string | null }
  period: { from: string; to: string }
  openingBalance: number
  rows: StatementRow[]
  totals: { debits: number; credits: number; closing: number }
}

type Aging = '0-30' | '31-60' | '60+'

const DAY_MS = 86_400_000

const r2 = (n: number) => Math.round(n * 100) / 100

const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// Join non-empty address parts with ', ' (raw — wrap the result in esc() before injecting).
const joinAddr = (...parts: (string | null | undefined)[]) =>
  parts.filter((p): p is string => !!p && p.trim() !== '').join(', ')

// Default statement period: current Indian financial year (1 Apr) → today (reports.tsx convention).
const todayISO = () => new Date().toISOString().slice(0, 10)
const fyStartISO = () => {
  const d = new Date()
  const y = d.getMonth() + 1 >= 4 ? d.getFullYear() : d.getFullYear() - 1
  return `${y}-04-01`
}

const outstandingOf = (inv: InvoiceRow) => Math.max(0, r2((inv.grandTotal || 0) - (inv.paidAmount || 0)))

const daysOverdue = (inv: InvoiceRow) => {
  const ref = inv.dueDate || inv.date
  return Math.floor((Date.now() - new Date(ref).getTime()) / DAY_MS)
}

const agingOf = (inv: InvoiceRow): Aging => {
  const d = daysOverdue(inv)
  if (d <= 30) return '0-30'
  if (d <= 60) return '31-60'
  return '60+'
}

const AGING_CLS: Record<Aging, string> = {
  '0-30': 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300',
  '31-60': 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300',
  '60+': 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300',
}

function AgingBadge({ aging }: { aging: Aging }) {
  return (
    <span className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium ${AGING_CLS[aging]}`}>
      {aging}
    </span>
  )
}

export default function ReceivablesModule({ companyId }: { companyId: string }) {
  const { data, loading } = useList<{ items?: InvoiceRow[]; total?: number }>(`/api/sales-invoices?companyId=${companyId}`)
  const [stmtFrom, setStmtFrom] = React.useState(fyStartISO)
  const [stmtTo, setStmtTo] = React.useState(todayISO)
  const open = React.useMemo(
    () => (data?.items ?? []).filter((r) => r.status === 'UNPAID' || r.status === 'PARTIALLY_PAID'),
    [data],
  )

  const totalOutstanding = open.reduce((s, r) => s + outstandingOf(r), 0)
  const overdue = open.filter((r) => daysOverdue(r) > 30)
  const overdueAmount = overdue.reduce((s, r) => s + outstandingOf(r), 0)

  function printSummary() {
    const rowsHtml = open
      .map(
        (r) => `<tr><td>${esc(r.number)}</td><td>${esc(fmtDate(r.date))}</td><td>${esc(r.customer?.name || '—')}</td><td>${esc(fmtDate(r.dueDate))}</td><td class="num">${fmtMoney(outstandingOf(r))}</td><td>${agingOf(r)}</td></tr>`,
      )
      .join('')
    printHtml(
      'Receivables Summary',
      `<div class="head">
        <div><h1>Receivables Summary</h1><div class="muted">${open.length} open invoices · generated ${esc(fmtDate(new Date()))}</div></div>
        <span class="badge">AR AGING</span>
      </div>
      <table>
        <thead><tr><th>Invoice</th><th>Date</th><th>Customer</th><th>Due Date</th><th class="num">Outstanding</th><th>Aging</th></tr></thead>
        <tbody>${rowsHtml || '<tr><td colspan="6" class="muted">No outstanding invoices</td></tr>'}
        <tr class="grand"><td colspan="4">Total Outstanding</td><td class="num">${fmtMoney(totalOutstanding)}</td><td></td></tr></tbody>
      </table>`,
    )
  }

  async function printStatement(row: InvoiceRow) {
    const customerId = row.customerId
    if (!customerId) return
    try {
      // Company header for the print (best-effort — the doc degrades gracefully without it).
      let company: CompanyProfile | undefined
      try {
        company = await apiGet<CompanyProfile>(`/api/settings?companyId=${companyId}`)
      } catch { /* fall back to no header block values */ }
      const stmt = await apiGet<StatementData>(
        `/api/customers/${customerId}/statement?companyId=${companyId}&from=${encodeURIComponent(stmtFrom)}&to=${encodeURIComponent(stmtTo)}`,
      )
      const c = stmt.customer
      const rowsHtml = stmt.rows
        .map(
          (r) => `<tr><td>${esc(fmtDate(r.date))}</td><td>${esc(r.particulars)}</td><td class="num">${r.debit ? fmtMoney(r.debit) : ''}</td><td class="num">${r.credit ? fmtMoney(r.credit) : ''}</td><td class="num">${fmtMoney(r.balance)}</td></tr>`,
        )
        .join('')
      const html = `
      <style>
        .stmt { border: 1.5px solid #333; }
        .stmt table { margin-top: 0; }
        .stmt th, .stmt td { border-color: #444; }
        .stmt .grid td { vertical-align: top; padding: 8px 10px; }
        .stmt .bare td { border: none; padding: 4px 10px; vertical-align: top; }
        .stmt .sec { font-size: 9px; font-weight: 700; letter-spacing: 1px; text-transform: uppercase; color: #555; margin-bottom: 4px; }
        .stmt .title { text-align: center; font-size: 15px; font-weight: 800; letter-spacing: 4px; padding: 7px 10px; border-bottom: 1.5px solid #333; }
        .stmt .words { font-weight: 700; font-size: 12px; margin-top: 8px; line-height: 1.5; }
        .stmt .footer { border-top: 1.5px solid #333; padding: 6px 10px; font-size: 10px; color: #444; text-align: center; line-height: 1.6; }
      </style>
      <div class="stmt">
        <div class="title">STATEMENT OF ACCOUNT</div>
        <div class="head" style="padding:10px 12px">
          <div>
            <h1 style="font-size:17px">${esc(company?.name || '—')}</h1>
            <div class="muted">${esc(joinAddr(company?.addressLine, company?.city, company?.state)) || '&nbsp;'}</div>
            ${company?.gstin ? `<div class="muted">GSTIN: ${esc(company.gstin)}</div>` : ''}
            ${joinAddr(company?.phone, company?.email) ? `<div class="muted">${esc(joinAddr(company?.phone, company?.email))}</div>` : ''}
          </div>
          <div style="text-align:right">
            <div style="font-size:13px"><strong>Statement of Account</strong></div>
            <div class="muted">From: ${esc(fmtDate(stmt.period.from))} &nbsp;·&nbsp; To: ${esc(fmtDate(stmt.period.to))}</div>
            <div class="muted">Generated: ${esc(fmtDate(new Date()))}</div>
            <span class="badge">CUSTOMER LEDGER</span>
          </div>
        </div>
        <table class="grid"><tr>
          <td style="width:58%">
            <div class="sec">Customer</div>
            <strong style="font-size:13px">${esc(c.name)}</strong> <span class="muted">(${esc(c.code)})</span>
            ${c.gstin ? `<div class="muted">GSTIN: ${esc(c.gstin)}</div>` : ''}
            ${c.phone ? `<div class="muted">Phone: ${esc(c.phone)}</div>` : ''}
          </td>
          <td style="width:42%">
            <div class="sec">Account Summary</div>
            <table class="bare">
              <tr><td class="muted">Opening Balance</td><td style="text-align:right"><strong>${fmtMoney(stmt.openingBalance)}</strong></td></tr>
              <tr><td class="muted">Invoices (Debit)</td><td style="text-align:right">${fmtMoney(stmt.totals.debits)}</td></tr>
              <tr><td class="muted">Receipts (Credit)</td><td style="text-align:right">${fmtMoney(stmt.totals.credits)}</td></tr>
              <tr><td class="muted">Closing Balance</td><td style="text-align:right"><strong>${fmtMoney(stmt.totals.closing)}</strong></td></tr>
            </table>
          </td>
        </tr></table>
        <table>
          <thead><tr><th style="width:80px">Date</th><th>Particulars</th><th class="num" style="width:100px">Debit</th><th class="num" style="width:100px">Credit</th><th class="num" style="width:110px">Balance</th></tr></thead>
          <tbody>
            <tr><td>—</td><td><strong>Opening Balance</strong></td><td></td><td></td><td class="num">${fmtMoney(stmt.openingBalance)}</td></tr>
            ${rowsHtml || '<tr><td colspan="5" class="muted" style="text-align:center">No transactions in this period</td></tr>'}
          </tbody>
          <tfoot><tr style="background:#f4f4f5;font-weight:600"><td colspan="2" style="text-align:right">Total</td><td class="num">${fmtMoney(stmt.totals.debits)}</td><td class="num">${fmtMoney(stmt.totals.credits)}</td><td class="num">${fmtMoney(stmt.totals.closing)}</td></tr></tfoot>
        </table>
        <div style="padding:8px 12px">
          <div style="font-size:13px"><strong>Closing Balance: ${fmtMoney(stmt.totals.closing)}</strong></div>
          <div class="words">Amount in words: Rupees ${amountInWords(stmt.totals.closing)} Only</div>
        </div>
        <div class="footer">
          This is a system-generated statement of account and is valid without signature.<br/>
          Please reconcile it against your records and bring any discrepancy to our notice within 7 days. E&amp;OE.
        </div>
      </div>`
      printHtml(`Statement of Account — ${c.name}`, html)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to build statement')
    }
  }

  const columns: Column<InvoiceRow>[] = [
    { key: 'number', header: 'Invoice', render: (r) => <span className="font-mono text-xs">{r.number}</span> },
    { key: 'date', header: 'Date', hideOnMobile: true, render: (r) => <DateCell value={r.date} /> },
    { key: 'dueDate', header: 'Due Date', render: (r) => <DateCell value={r.dueDate} /> },
    { key: 'customer', header: 'Customer', render: (r) => <span className="truncate block max-w-[180px]">{r.customer?.name || '—'}</span> },
    { key: 'grandTotal', header: 'Total', className: 'text-right', hideOnMobile: true, render: (r) => <Money value={r.grandTotal} /> },
    { key: 'paidAmount', header: 'Paid', className: 'text-right', hideOnMobile: true, render: (r) => <Money value={r.paidAmount} /> },
    { key: 'outstanding', header: 'Outstanding', className: 'text-right', render: (r) => <Money value={outstandingOf(r)} className="font-medium" /> },
    { key: 'aging', header: 'Aging', render: (r) => <AgingBadge aging={agingOf(r)} /> },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
    {
      key: 'actions', header: 'Actions',
      render: (r) => (
        <Button variant="ghost" size="sm" className="h-7" title="Print statement of account" onClick={() => void printStatement(r)}>
          <FileText className="h-3.5 w-3.5" />
        </Button>
      ),
    },
  ]

  return (
    <div>
      <PageHeader
        title="Receivables"
        description="Unpaid & partially paid sales invoices with aging buckets"
        actions={
          <>
            <div className="flex items-center gap-1.5" title="Period used by the per-row statement print">
              <span className="text-xs text-muted-foreground">Statement</span>
              <DateInput value={stmtFrom} onChange={setStmtFrom} className="w-[132px]" />
              <span className="text-xs text-muted-foreground">→</span>
              <DateInput value={stmtTo} onChange={setStmtTo} className="w-[132px]" />
            </div>
            <PrintButton onClick={printSummary} label="Print Summary" />
          </>
        }
      />
      <div className="grid gap-3 sm:grid-cols-3 mb-4">
        <StatCard
          title="Total Outstanding"
          value={fmtMoney(totalOutstanding)}
          sub={`${open.length} open invoices`}
          icon={<IndianRupee className="h-4 w-4" />}
        />
        <StatCard
          title="Overdue 30+ Days"
          value={fmtMoney(overdueAmount)}
          sub={`${overdue.length} invoices past due by more than 30 days`}
          icon={<AlertTriangle className="h-4 w-4" />}
          toneClass="bg-amber-100 text-amber-600"
        />
        <StatCard
          title="Open Invoices"
          value={open.length}
          sub="UNPAID + PARTIALLY_PAID"
          icon={<ReceiptText className="h-4 w-4" />}
          toneClass="bg-sky-100 text-sky-600"
        />
      </div>
      <SectionCard title="Aging buckets — 0–30 / 31–60 / 60+ days from due date">
        <DataTable
          columns={columns}
          rows={open}
          loading={loading}
          searchPlaceholder="Search invoices…"
          emptyText="No outstanding receivables — all invoices settled"
        />
      </SectionCard>
    </div>
  )
}
