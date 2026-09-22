'use client'

import * as React from 'react'
import { AlertTriangle, Boxes, Warehouse } from 'lucide-react'
import {
  DataTable, Money, PageHeader, Qty, SelectInput, StatCard, type Column,
} from '@/components/erp/kit'
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
              <span className="inline-flex items-center rounded-full bg-red-100 px-2 py-0.5 text-[11px] font-medium text-red-700 dark:bg-red-950 dark:text-red-300">
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
      <PageHeader title="Stock" description="On-hand balances across warehouses with moving-average valuation" />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 mb-4">
        <StatCard title="Stock Value" value={fmtMoney(totalValue)} sub="At moving average cost" toneClass="bg-primary/10 text-primary" icon={<Boxes className="h-4 w-4" />} />
        <StatCard title="SKUs In Stock" value={skuCount} sub="Distinct items with balance" toneClass="bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300" icon={<Warehouse className="h-4 w-4" />} />
        <StatCard title="Low Stock" value={lowStockCount} sub="At / below reorder level" toneClass="bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300" icon={<AlertTriangle className="h-4 w-4" />} />
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
