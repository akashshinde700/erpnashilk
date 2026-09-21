'use client'

import * as React from 'react'
import { AlertTriangle, IndianRupee, ReceiptText } from 'lucide-react'
import {
  Column, DataTable, DateCell, Money, PageHeader, PrintButton, SectionCard, StatCard, StatusBadge, printHtml,
} from '@/components/erp/kit'
import { fmtDate, fmtMoney } from '@/lib/erp-constants'
import { useList } from '@/lib/use-api'

interface InvoiceRow {
  id: string
  number: string
  date: string
  dueDate?: string | null
  grandTotal: number
  paidAmount: number
  status: string
  customer?: { name?: string | null } | null
}

type Aging = '0-30' | '31-60' | '60+'

const DAY_MS = 86_400_000

const r2 = (n: number) => Math.round(n * 100) / 100

const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

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
  ]

  return (
    <div>
      <PageHeader
        title="Receivables"
        description="Unpaid & partially paid sales invoices with aging buckets"
        actions={<PrintButton onClick={printSummary} label="Print Summary" />}
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
