'use client'

import * as React from 'react'
import {
  DataTable, DateCell, Money, PageHeader, SelectInput, StatCard, type Column,
} from '@/components/erp/kit'
import { useList } from '@/lib/use-api'
import { fmtNum, STOCK_TYPES } from '@/lib/erp-constants'
import { cn } from '@/lib/utils'

const rowsOf = <T,>(d: T[] | { items?: T[] } | null | undefined): T[] => (Array.isArray(d) ? d : d?.items || [])

// ---------- types ----------
interface LedgerRow {
  id: string; date: string; type: string
  qtyIn?: number; qtyOut?: number; rate?: number | null
  refType?: string | null; refNumber?: string | null; notes?: string | null
  itemId?: string; warehouseId?: string
  item?: { code?: string; name?: string } | null
  warehouse?: { code?: string; name?: string } | null
}
interface ItemRow { id: string; code?: string; name?: string }

function TypeChip({ t }: { t: string }) {
  const isIn = t.endsWith('_IN')
  const isOut = t.endsWith('_OUT')
  const cls = isIn
    ? 'bg-success-soft text-success ring-1 ring-inset ring-success-border'
    : isOut
      ? 'bg-danger-soft text-destructive ring-1 ring-inset ring-danger-border'
      : 'bg-muted text-muted-foreground'
  return (
    <span className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap', cls)}>
      {t.replaceAll('_', ' ')}
    </span>
  )
}

export default function StockLedgerModule({ companyId }: { companyId: string }) {
  const { data, loading } = useList<{ items?: LedgerRow[] } | LedgerRow[]>(`/api/stock-ledger?companyId=${companyId}`)
  const items = useList<{ items?: ItemRow[] } | ItemRow[]>(`/api/items?companyId=${companyId}`)

  const rows = React.useMemo(() => rowsOf(data), [data])
  const itemRows = rowsOf(items.data)

  const [itemFilter, setItemFilter] = React.useState('__ALL__')
  const [typeFilter, setTypeFilter] = React.useState('__ALL__')

  const itemOptions = React.useMemo(() => {
    const seen = new Map<string, string>()
    for (const r of rows) {
      if (r.itemId && !seen.has(r.itemId)) {
        const it = itemRows.find((i) => i.id === r.itemId)
        seen.set(r.itemId, it ? `${it.code || ''} — ${it.name || ''}`.trim() : r.item?.code || r.itemId)
      }
    }
    return [{ value: '__ALL__', label: 'All items' }, ...Array.from(seen.entries()).map(([id, label]) => ({ value: id, label }))]
  }, [rows, itemRows])

  const filtered = React.useMemo(
    () => rows.filter((r) =>
      (itemFilter === '__ALL__' || r.itemId === itemFilter) &&
      (typeFilter === '__ALL__' || r.type === typeFilter),
    ),
    [rows, itemFilter, typeFilter],
  )

  const totals = React.useMemo(() => ({
    inQty: filtered.reduce((s, r) => s + (r.qtyIn || 0), 0),
    outQty: filtered.reduce((s, r) => s + (r.qtyOut || 0), 0),
  }), [filtered])

  const columns: Column<LedgerRow>[] = [
    { key: 'date', header: 'Date', render: (r) => <DateCell value={r.date} /> },
    { key: 'type', header: 'Type', render: (r) => <TypeChip t={r.type} /> },
    {
      key: 'item', header: 'Item', render: (r) => {
        const it = itemRows.find((i) => i.id === r.itemId)
        return (
          <div className="min-w-36">
            <p className="truncate">{it?.name || r.item?.name || '—'}</p>
            <p className="text-xs text-muted-foreground">{it?.code || r.item?.code}</p>
          </div>
        )
      },
    },
    { key: 'warehouse', header: 'Warehouse', hideOnMobile: true, render: (r) => r.warehouse?.name || r.warehouse?.code || '—' },
    {
      key: 'qtyIn', header: 'In', className: 'text-right', render: (r) => (r.qtyIn || 0) > 0
        ? <span className="text-success font-medium tabular-nums">+{fmtNum(r.qtyIn)}</span>
        : <span className="text-muted-foreground">—</span>,
    },
    {
      key: 'qtyOut', header: 'Out', className: 'text-right', render: (r) => (r.qtyOut || 0) > 0
        ? <span className="text-destructive font-medium tabular-nums">-{fmtNum(r.qtyOut)}</span>
        : <span className="text-muted-foreground">—</span>,
    },
    { key: 'rate', header: 'Rate', className: 'text-right', hideOnMobile: true, render: (r) => (r.rate != null ? <Money value={r.rate} /> : <span className="text-muted-foreground">—</span>) },
    {
      key: 'ref', header: 'Reference', hideOnMobile: true, render: (r) => (
        <span className="whitespace-nowrap text-muted-foreground">{[r.refType, r.refNumber].filter(Boolean).join(' ') || '—'}</span>
      ),
    },
  ]

  return (
    <div>
      <PageHeader title="Stock Ledger" description="Immutable movement log — every stock transaction across the plant" />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 mb-4">
        <StatCard title="Entries" value={filtered.length} sub="In current filter" />
        <StatCard title="Total In" value={fmtNum(totals.inQty)} sub="Sum of inward qty" toneClass="bg-success-soft text-success ring-1 ring-inset ring-success-border" />
        <StatCard title="Total Out" value={fmtNum(totals.outQty)} sub="Sum of outward qty" toneClass="bg-danger-soft text-destructive ring-1 ring-inset ring-danger-border" />
        <StatCard title="Movement Types" value={new Set(filtered.map((r) => r.type)).size} sub="Distinct transaction types" />
      </div>

      <div className="flex flex-wrap items-center gap-3 mb-3">
        <div className="w-56">
          <SelectInput value={itemFilter} onChange={setItemFilter} options={itemOptions} />
        </div>
        <div className="w-48">
          <SelectInput
            value={typeFilter} onChange={setTypeFilter}
            options={[{ value: '__ALL__', label: 'All movement types' }, ...STOCK_TYPES.map((t) => ({ value: t, label: t.replaceAll('_', ' ') }))]}
          />
        </div>
        <p className={cn('text-xs text-muted-foreground', loading && 'animate-pulse')}>
          {loading ? 'Loading ledger…' : `${filtered.length} movement(s), newest first`}
        </p>
      </div>

      <DataTable
        columns={columns} rows={filtered} loading={loading}
        searchPlaceholder="Search ledger…" emptyText="No stock movements yet" pageSize={15}
        csvExport={{
          filename: 'stock-ledger',
          pick: (r) => [new Date(r.date).toISOString().slice(0, 10), r.type, r.item?.code || '', r.item?.name || '', r.warehouse?.code || '', r.qtyIn ?? 0, r.qtyOut ?? 0, r.rate ?? 0, r.refType || '', r.refNumber || ''],
        }}
        xlsxExport={{
          filename: 'stock-ledger',
          pick: (r) => [new Date(r.date).toISOString().slice(0, 10), r.type, r.item?.code || '', r.item?.name || '', r.warehouse?.code || '', r.qtyIn ?? 0, r.qtyOut ?? 0, r.rate ?? 0, r.refType || '', r.refNumber || ''],
        }}
      />
    </div>
  )
}
