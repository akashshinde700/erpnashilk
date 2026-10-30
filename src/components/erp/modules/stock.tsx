'use client'

import * as React from 'react'
import { AlertTriangle, Boxes, Warehouse } from 'lucide-react'
import {
  DataTable, Money, PageHeader, Qty, SelectInput, StatCard, StatusBadge, TextInput, type Column,
} from '@/components/erp/kit'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useList } from '@/lib/use-api'
import { fmtMoney, fmtNum, ITEM_TYPES, ITEM_TYPE_LABEL } from '@/lib/erp-constants'
import { cn } from '@/lib/utils'

const rowsOf = <T,>(d: T[] | { items?: T[] } | null | undefined): T[] => (Array.isArray(d) ? d : d?.items || [])

// ---------- types ----------
interface StockRow {
  itemId: string; warehouseId: string; qty: number; avgRate: number
  item?: { code?: string; name?: string; uom?: string; type?: string; reorderLevel?: number } | null
  warehouse?: { code?: string; name?: string } | null
}
interface GridRow extends StockRow { id: string }
interface StockResponse { items?: StockRow[]; totalValue?: number; lowStockCount?: number }

function TypeChip({ type }: { type?: string }) {
  if (!type) return <span className="text-muted-foreground">—</span>
  return (
    <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground whitespace-nowrap">
      {ITEM_TYPE_LABEL[type] || type}
    </span>
  )
}

export default function StockModule({ companyId }: { companyId: string }) {
  return (
    <div>
      <PageHeader title="Stock" description="On-hand balances across warehouses with moving-average valuation, batches & expiry, serial numbers" />
      <Tabs defaultValue="balances">
        <TabsList className="mb-3">
          <TabsTrigger value="balances">Balances</TabsTrigger>
          <TabsTrigger value="batches">Batches &amp; Expiry</TabsTrigger>
          <TabsTrigger value="serials">Serial numbers</TabsTrigger>
        </TabsList>
        <TabsContent value="balances"><BalancesTab companyId={companyId} /></TabsContent>
        <TabsContent value="batches"><BatchesTab companyId={companyId} /></TabsContent>
        <TabsContent value="serials"><SerialsTab companyId={companyId} /></TabsContent>
      </Tabs>
    </div>
  )
}

// ---------- Batches & expiry ----------
interface BatchRow {
  id: string; itemId: string; warehouseId: string; batchNo: string; qty: number
  mfgDate?: string | null; expiryDate?: string | null; daysToExpiry?: number | null
  item?: { code?: string; name?: string; uom?: string } | null
  warehouse?: { code?: string; name?: string } | null
}
const dayFmt = (d?: string | null) => (d ? new Date(d).toLocaleDateString('en-IN') : '—')

function ExpiryBadge({ days }: { days?: number | null }) {
  if (days === null || days === undefined) return <span className="text-muted-foreground text-xs">No expiry</span>
  if (days < 0) {
    return <span className="inline-flex rounded-full bg-danger-soft px-2 py-0.5 text-[11px] font-medium text-destructive whitespace-nowrap">EXPIRED {Math.abs(days)}d</span>
  }
  if (days <= 30) {
    return <span className="inline-flex rounded-full bg-warning-soft px-2 py-0.5 text-[11px] font-medium text-warning whitespace-nowrap">{days === 0 ? 'Expires today' : `${days}d left`}</span>
  }
  return <span className="text-xs text-muted-foreground whitespace-nowrap">{days}d left</span>
}

function BatchesTab({ companyId }: { companyId: string }) {
  const [range, setRange] = React.useState('__ALL__')
  const url = `/api/batches?companyId=${companyId}${range === '__ALL__' ? '' : `&expiringInDays=${range}`}`
  const { data, loading } = useList<{ items: BatchRow[] }>(url)
  const rows = data?.items ?? []
  const expired = rows.filter((r) => r.daysToExpiry !== null && r.daysToExpiry !== undefined && r.daysToExpiry < 0).length
  const soon = rows.filter((r) => r.daysToExpiry !== null && r.daysToExpiry !== undefined && r.daysToExpiry >= 0 && r.daysToExpiry <= 30).length

  const columns: Column<BatchRow>[] = [
    { key: 'code', header: 'Item', render: (r) => <span className="whitespace-nowrap"><span className="font-medium">{r.item?.code || '—'}</span> <span className="text-muted-foreground">{r.item?.name || ''}</span></span>, sortValue: (r) => r.item?.code || '' },
    { key: 'batchNo', header: 'Batch', render: (r) => <span className="font-medium">{r.batchNo}</span> },
    { key: 'warehouse', header: 'Warehouse', hideOnMobile: true, render: (r) => r.warehouse?.name || r.warehouse?.code || '—' },
    { key: 'mfgDate', header: 'Mfg', hideOnMobile: true, render: (r) => dayFmt(r.mfgDate) },
    { key: 'expiryDate', header: 'Expiry', render: (r) => dayFmt(r.expiryDate), sortValue: (r) => r.expiryDate || '9999' },
    { key: 'status', header: 'Status', render: (r) => <ExpiryBadge days={r.daysToExpiry} />, sortValue: (r) => r.daysToExpiry ?? 999999 },
    { key: 'qty', header: 'Qty', className: 'text-right', render: (r) => <Qty value={r.qty} uom={r.item?.uom} />, sum: true },
  ]

  return (
    <div>
      <div className="grid gap-3 sm:grid-cols-3 mb-4">
        <StatCard title="Batches in stock" value={rows.length} sub={range === '__ALL__' ? 'All batches with qty' : `Expiring within ${range} days`} />
        <StatCard title="Expired" value={expired} sub="Past expiry, still in stock" toneClass="bg-danger-soft text-destructive ring-1 ring-inset ring-danger-border" icon={<AlertTriangle className="h-4 w-4" />} />
        <StatCard title="Expiring ≤ 30 days" value={soon} sub="Sell / use first" toneClass="bg-warning-soft text-warning ring-1 ring-inset ring-warning-border" />
      </div>
      <div className="flex flex-wrap items-center gap-3 mb-3">
        <div className="w-56">
          <SelectInput value={range} onChange={setRange} options={[
            { value: '__ALL__', label: 'All batches' },
            { value: '0', label: 'Expired (incl. today)' },
            { value: '30', label: 'Expiring within 30 days' },
            { value: '60', label: 'Expiring within 60 days' },
            { value: '90', label: 'Expiring within 90 days' },
          ]} />
        </div>
        <p className={cn('text-xs text-muted-foreground', loading && 'animate-pulse')}>{loading ? 'Loading batches…' : `${rows.length} batch(es), earliest expiry first`}</p>
      </div>
      <DataTable
        columns={columns} rows={rows} loading={loading} sortable
        searchPlaceholder="Search batch / item…"
        emptyText="No batches in stock — receive batch-tracked items on a GRN"
        csvExport={{ filename: 'batches', pick: (r) => [r.item?.code || '', r.item?.name || '', r.batchNo, r.warehouse?.code || '', r.mfgDate ? r.mfgDate.slice(0, 10) : '', r.expiryDate ? r.expiryDate.slice(0, 10) : '', r.qty] }}
      />
    </div>
  )
}

// ---------- Serial numbers ----------
interface DocRefOut { type: string; id: string; number?: string | null; date?: string | null }
interface SerialRow {
  id: string; serialNo: string; status: string; itemId: string; warehouseId?: string | null; updatedAt: string
  item?: { code?: string; name?: string } | null
  warehouse?: { code?: string; name?: string } | null
  inRef?: DocRefOut | null; outRef?: DocRefOut | null
}
const REF_LABEL: Record<string, string> = {
  GRN: 'GRN', DELIVERY: 'Delivery challan', SALES_INVOICE: 'Sales invoice', SALES_RETURN: 'Sales return',
  PURCHASE_RETURN: 'Purchase return', PURCHASE_INVOICE: 'Purchase bill',
}
function RefCell({ r }: { r?: DocRefOut | null }) {
  if (!r) return <span className="text-muted-foreground">—</span>
  return (
    <span className="whitespace-nowrap">
      <span className="text-muted-foreground">{REF_LABEL[r.type] || r.type}</span> <span className="font-medium">{r.number || '—'}</span>
      {r.date ? <span className="text-muted-foreground text-xs"> · {dayFmt(r.date)}</span> : null}
    </span>
  )
}

function SerialsTab({ companyId }: { companyId: string }) {
  const [q, setQ] = React.useState('')
  const [debounced, setDebounced] = React.useState('')
  const [status, setStatus] = React.useState('__ALL__')
  React.useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 300)
    return () => clearTimeout(t)
  }, [q])
  const url = `/api/serials?companyId=${companyId}${debounced ? `&q=${encodeURIComponent(debounced)}` : ''}${status === '__ALL__' ? '' : `&status=${status}`}`
  const { data, loading } = useList<{ items: SerialRow[] }>(url)
  const rows = data?.items ?? []

  const columns: Column<SerialRow>[] = [
    { key: 'serialNo', header: 'Serial no', render: (r) => <span className="font-medium font-mono">{r.serialNo}</span> },
    { key: 'item', header: 'Item', render: (r) => <span className="whitespace-nowrap">{r.item?.code || ''} <span className="text-muted-foreground">{r.item?.name || ''}</span></span>, sortValue: (r) => r.item?.code || '' },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
    { key: 'warehouse', header: 'Warehouse', hideOnMobile: true, render: (r) => r.warehouse?.name || r.warehouse?.code || '—' },
    { key: 'in', header: 'Came in on', render: (r) => <RefCell r={r.inRef} /> },
    { key: 'out', header: 'Went out on', render: (r) => <RefCell r={r.outRef} /> },
  ]

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3 mb-3">
        <div className="w-64"><TextInput value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search a serial / IMEI…" /></div>
        <div className="w-48">
          <SelectInput value={status} onChange={setStatus} options={[
            { value: '__ALL__', label: 'All statuses' },
            { value: 'IN_STOCK', label: 'In stock' },
            { value: 'SOLD', label: 'Sold' },
            { value: 'RETURNED_TO_SUPPLIER', label: 'Returned to supplier' },
          ]} />
        </div>
        <p className={cn('text-xs text-muted-foreground', loading && 'animate-pulse')}>{loading ? 'Searching…' : `${rows.length} serial(s)${rows.length >= 500 ? ' — showing the latest 500, refine the search' : ''}`}</p>
      </div>
      <DataTable columns={columns} rows={rows} loading={loading} emptyText="No serial numbers found — serials are recorded on GRNs for serial-tracked items" />
    </div>
  )
}

// ---------- Balances (original stock view) ----------
function BalancesTab({ companyId }: { companyId: string }) {
  const { data, loading } = useList<StockResponse | StockRow[]>(`/api/stock?companyId=${companyId}`)

  const [whFilter, setWhFilter] = React.useState('__ALL__')
  const [typeFilter, setTypeFilter] = React.useState('__ALL__')

  const rawRows = React.useMemo<StockRow[]>(() => rowsOf(data), [data])

  const gridRows = React.useMemo<GridRow[]>(
    () => rawRows.map((r, i) => ({ ...r, id: `${r.itemId}-${r.warehouseId}-${i}` })),
    [rawRows],
  )

  const warehouseOptions = React.useMemo(() => {
    const seen = new Map<string, string>()
    for (const r of rawRows) {
      if (r.warehouseId && !seen.has(r.warehouseId)) seen.set(r.warehouseId, r.warehouse?.name || r.warehouse?.code || r.warehouseId)
    }
    return [{ value: '__ALL__', label: 'All warehouses' }, ...Array.from(seen.entries()).map(([id, name]) => ({ value: id, label: name }))]
  }, [rawRows])

  const filtered = React.useMemo(
    () => gridRows.filter((r) =>
      (whFilter === '__ALL__' || r.warehouseId === whFilter) &&
      (typeFilter === '__ALL__' || (r.item?.type || '') === typeFilter),
    ),
    [gridRows, whFilter, typeFilter],
  )

  const totalValue = React.useMemo(() => {
    if (whFilter === '__ALL__' && typeFilter === '__ALL__' && data && !Array.isArray(data) && typeof data.totalValue === 'number') return data.totalValue
    return filtered.reduce((s, r) => s + (r.qty || 0) * (r.avgRate || 0), 0)
  }, [data, filtered, whFilter, typeFilter])

  const skuCount = React.useMemo(() => new Set(filtered.map((r) => r.itemId)).size, [filtered])

  const lowStockCount = React.useMemo(
    () => new Set(filtered.filter((r) => (r.item?.reorderLevel || 0) > 0 && (r.qty || 0) <= (r.item?.reorderLevel || 0)).map((r) => r.itemId)).size,
    [filtered],
  )

  const columns: Column<GridRow>[] = [
    { key: 'code', header: 'Code', render: (r) => <span className="font-medium whitespace-nowrap">{r.item?.code || '—'}</span> },
    { key: 'name', header: 'Item', render: (r) => <span className="truncate block max-w-56">{r.item?.name || '—'}</span> },
    { key: 'type', header: 'Type', hideOnMobile: true, render: (r) => <TypeChip type={r.item?.type} /> },
    { key: 'warehouse', header: 'Warehouse', render: (r) => r.warehouse?.name || r.warehouse?.code || '—' },
    { key: 'qty', header: 'Qty', className: 'text-right', render: (r) => <Qty value={r.qty} uom={r.item?.uom} /> },
    { key: 'avgRate', header: 'Avg Rate', className: 'text-right', hideOnMobile: true, render: (r) => <Money value={r.avgRate} /> },
    { key: 'value', header: 'Value', className: 'text-right', render: (r) => <Money value={(r.qty || 0) * (r.avgRate || 0)} className="font-medium" /> },
    {
      key: 'reorder', header: 'Reorder', className: 'text-right', hideOnMobile: true, render: (r) => {
        const rl = r.item?.reorderLevel || 0
        const low = rl > 0 && (r.qty || 0) <= rl
        return (
          <div className="flex items-center justify-end gap-2">
            <span className="tabular-nums text-muted-foreground">{rl > 0 ? fmtNum(rl) : '—'}</span>
            {low && (
              <span className="inline-flex items-center rounded-full bg-danger-soft px-2 py-0.5 text-[11px] font-medium text-destructive">
                LOW
              </span>
            )}
          </div>
        )
      },
    },
  ]

  return (
    <div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 mb-4">
        <StatCard title="Stock Value" value={fmtMoney(totalValue)} sub="At moving average cost" toneClass="bg-primary/10 text-primary" icon={<Boxes className="h-4 w-4" />} />
        <StatCard title="SKUs In Stock" value={skuCount} sub="Distinct items with balance" toneClass="bg-info-soft text-info ring-1 ring-inset ring-info-border" icon={<Warehouse className="h-4 w-4" />} />
        <StatCard title="Low Stock" value={lowStockCount} sub="At / below reorder level" toneClass="bg-warning-soft text-warning ring-1 ring-inset ring-warning-border" icon={<AlertTriangle className="h-4 w-4" />} />
        <StatCard title="Balance Rows" value={filtered.length} sub="Item × warehouse lines" />
      </div>

      <div className="flex flex-wrap items-center gap-3 mb-3">
        <div className="w-48">
          <SelectInput value={whFilter} onChange={setWhFilter} options={warehouseOptions} />
        </div>
        <div className="w-44">
          <SelectInput
            value={typeFilter} onChange={setTypeFilter}
            options={[{ value: '__ALL__', label: 'All item types' }, ...ITEM_TYPES.map((t) => ({ value: t, label: ITEM_TYPE_LABEL[t] || t }))]}
          />
        </div>
        <p className={cn('text-xs text-muted-foreground', loading && 'animate-pulse')}>
          {loading ? 'Loading balances…' : `${filtered.length} balance row(s)`}
        </p>
      </div>

      <DataTable
        columns={columns}
        rows={filtered}
        loading={loading}
        moduleKey="stock"
        savedViewsKey={`${companyId}:stock`}
        searchPlaceholder="Search stock…"
        emptyText="No stock balances yet — post GRNs, productions or opening stock"
        csvExport={{
          filename: 'stock-balances',
          pick: (r) => [r.item?.code || '', r.item?.name || '', r.item?.type || '', r.warehouse?.code || '', r.qty, r.avgRate, Math.round(r.qty * r.avgRate * 100) / 100, r.item?.reorderLevel ?? 0],
        }}
        xlsxExport={{
          filename: 'stock-balances',
          pick: (r) => [r.item?.code || '', r.item?.name || '', r.item?.type || '', r.warehouse?.code || '', r.qty, r.avgRate, Math.round(r.qty * r.avgRate * 100) / 100, r.item?.reorderLevel ?? 0],
        }}
      />
    </div>
  )
}
