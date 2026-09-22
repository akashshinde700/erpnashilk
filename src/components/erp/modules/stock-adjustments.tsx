'use client'

import * as React from 'react'
import { toast } from 'sonner'
import { Plus, SlidersHorizontal, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DataTable, DateCell, Field, NumberInput, PageHeader, SectionCard, SelectInput, TextInput, type Column,
} from '@/components/erp/kit'
import { apiPost, useList } from '@/lib/use-api'
import { fmtNum } from '@/lib/erp-constants'

const todayISO = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const rowsOf = <T,>(d: T[] | { items?: T[] } | null | undefined): T[] => (Array.isArray(d) ? d : d?.items || [])

// ---------- types ----------
interface ItemRow { id: string; code?: string; name?: string; uom?: string }
interface WarehouseRow { id: string; code?: string; name?: string; type?: string }
interface LineDraft { key: number; itemId: string; qty: number }
interface AdjRow {
  id: string; date: string; type?: string
  qtyIn?: number; qtyOut?: number; qty?: number
  reason?: string | null; notes?: string | null
  itemId?: string
  item?: { code?: string; name?: string; uom?: string } | null
  warehouse?: { code?: string; name?: string } | null
}

let lineKey = 0

export default function StockAdjustmentsModule({ companyId }: { companyId: string }) {
  const items = useList<{ items?: ItemRow[] } | ItemRow[]>(`/api/items?companyId=${companyId}`)
  const whs = useList<{ items?: WarehouseRow[] } | WarehouseRow[]>(`/api/warehouses?companyId=${companyId}`)
  const list = useList<{ items?: AdjRow[] } | AdjRow[]>(`/api/stock-adjustments?companyId=${companyId}`)

  const itemRows = rowsOf(items.data)
  const whRows = rowsOf(whs.data)
  const adjRows = rowsOf(list.data)

  const [warehouseId, setWarehouseId] = React.useState('')
  const [date, setDate] = React.useState(todayISO())
  const [reason, setReason] = React.useState('')
  const [lines, setLines] = React.useState<LineDraft[]>([{ key: ++lineKey, itemId: '', qty: 0 }])
  const [saving, setSaving] = React.useState(false)

  const itemOptions = itemRows.filter((i) => i.id).map((i) => ({ value: i.id, label: `${i.code || ''} — ${i.name || ''}`.trim() }))
  const whOptions = whRows.map((w) => ({ value: w.id, label: `${w.code || ''} — ${w.name || ''} (${w.type || 'GENERAL'})`.trim() }))
  const itemLabel = (id: string) => itemOptions.find((o) => o.value === id)?.label || id

  function updateLine(key: number, patch: Partial<LineDraft>) {
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)))
  }

  function removeLine(key: number) {
    setLines((ls) => (ls.length > 1 ? ls.filter((l) => l.key !== key) : ls))
  }

  async function submit() {
    if (!warehouseId) { toast.error('Select a warehouse'); return }
    const toPost = lines.filter((l) => l.itemId && l.qty !== 0)
    if (toPost.length === 0) { toast.error('Add at least one line with an item and a non-zero qty'); return }
    setSaving(true)
    try {
      await apiPost('/api/stock-adjustments', {
        companyId, warehouseId, date,
        reason: reason || undefined,
        notes: reason || undefined,
        lines: toPost.map((l) => ({ itemId: l.itemId, qty: l.qty })),
      })
      toast.success('Stock adjustment posted')
      setLines([{ key: ++lineKey, itemId: '', qty: 0 }])
      setReason(''); setDate(todayISO())
      void list.refetch()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to post adjustment')
    } finally { setSaving(false) }
  }

  const columns: Column<AdjRow>[] = [
    { key: 'date', header: 'Date', render: (r) => <DateCell value={r.date} /> },
    {
      key: 'item', header: 'Item', render: (r) => {
        const label = r.item ? `${r.item.code || ''} — ${r.item.name || ''}`.trim() : r.itemId ? itemLabel(r.itemId) : '—'
        return <span className="truncate block max-w-56">{label}</span>
      },
    },
    { key: 'warehouse', header: 'Warehouse', render: (r) => r.warehouse?.name || r.warehouse?.code || '—' },
    {
      key: 'qty', header: 'Qty', className: 'text-right', render: (r) => {
        const q = (r.qtyIn || 0) > 0 ? (r.qtyIn || 0) : (r.qtyOut || 0) > 0 ? -(r.qtyOut || 0) : (r.qty || 0)
        const isIn = q > 0
        const isOut = q < 0
        if (q === 0) return <span className="text-muted-foreground">—</span>
        return (
          <span className={`tabular-nums font-medium ${isIn ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>
            {isIn ? '+' : ''}{fmtNum(q)}{r.item?.uom ? ` ${r.item.uom}` : ''}
          </span>
        )
      },
    },
    { key: 'type', header: 'Type', hideOnMobile: true, render: (r) => <span className="text-xs text-muted-foreground">{(r.type || '').replaceAll('_', ' ') || '—'}</span> },
    { key: 'reason', header: 'Reason / Notes', hideOnMobile: true, render: (r) => <span className="truncate block max-w-64 text-muted-foreground">{r.reason || r.notes || '—'}</span> },
  ]

  return (
    <div>
      <PageHeader title="Stock Adjustments" description="Correct stock levels — positive qty adds stock, negative removes it" />

      <SectionCard title="New adjustment" className="mb-4">
        <form onSubmit={(e) => { e.preventDefault(); void submit() }} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Warehouse" required>
              <SelectInput value={warehouseId} onChange={setWarehouseId} options={whOptions} placeholder="Select warehouse…" />
            </Field>
            <Field label="Date" required>
              <TextInput type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </Field>
            <Field label="Reason">
              <TextInput value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Physical count correction" />
            </Field>
          </div>

          <div className="space-y-2">
            {lines.map((l, idx) => (
              <div key={l.key} className="flex flex-col sm:flex-row gap-2 sm:items-end">
                <Field label={idx === 0 ? 'Item' : ''} className="flex-1">
                  <SelectInput value={l.itemId} onChange={(v) => updateLine(l.key, { itemId: v })} options={itemOptions} placeholder="Select item…" />
                </Field>
                <Field label={idx === 0 ? 'Qty (+in / -out)' : ''} className="sm:w-40">
                  <NumberInput value={l.qty} step="any" onChange={(n) => updateLine(l.key, { qty: n })} placeholder="0" />
                </Field>
                <Button type="button" variant="ghost" size="icon" className="h-9 w-9 text-red-600 hover:text-red-700 shrink-0" onClick={() => removeLine(l.key)} aria-label="Remove line">
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
            <Button type="button" variant="outline" size="sm" onClick={() => setLines((ls) => [...ls, { key: ++lineKey, itemId: '', qty: 0 }])}>
              <Plus className="h-3.5 w-3.5 mr-1" />Add line
            </Button>
          </div>

          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <p className="text-xs text-muted-foreground">+ve qty = stock in (ADJUST_IN) · -ve qty = stock out (ADJUST_OUT). Zero-qty lines are skipped.</p>
            <Button type="submit" disabled={saving}>
              <SlidersHorizontal className="h-4 w-4 mr-1.5" />{saving ? 'Posting…' : 'Post Adjustment'}
            </Button>
          </div>
        </form>
      </SectionCard>

      <SectionCard title={`Recent adjustments (${adjRows.length})`}>
        <DataTable
          columns={columns} rows={adjRows} loading={list.loading}
          searchPlaceholder="Search adjustments…" emptyText="No adjustments posted yet"
        />
      </SectionCard>
    </div>
  )
}
