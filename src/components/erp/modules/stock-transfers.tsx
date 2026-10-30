'use client'

import * as React from 'react'
import { toast } from 'sonner'
import { ArrowRightLeft, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import {
  DataTable, DateCell, Field, PageHeader, NumberInput, SectionCard, SelectInput, TextInput, type Column,
} from '@/components/erp/kit'
import { apiPost, useList } from '@/lib/use-api'
import { fmtNum } from '@/lib/erp-constants'
import { ItemPicker, pickIntoLines } from '@/components/erp/item-picker'

const todayISO = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const rowsOf = <T,>(d: T[] | { items?: T[] } | null | undefined): T[] => (Array.isArray(d) ? d : d?.items || [])

// ---------- types ----------
interface ItemRow { id: string; code?: string; name?: string; uom?: string; barcode?: string | null; partNo?: string | null; batchTracked?: boolean | null; trackSerial?: boolean | null; type?: string | null }
interface WarehouseRow { id: string; code?: string; name?: string; type?: string }
// batchNo: source batch to move ('' = FEFO); serials: the serial nos being moved (serial-tracked items)
interface LineDraft { key: number; itemId: string; qty: number; batchNo?: string; serials?: string }
// newline / comma separated → unique non-empty serials (mirrors parseSerials on the server)
const serialList = (t: string | undefined) => Array.from(new Set(String(t || '').split(/[\r\n,;]+/).map((x) => x.trim()).filter(Boolean)))
function LineBatchPick({ companyId, itemId, warehouseId, value, onChange }: {
  companyId: string; itemId: string; warehouseId: string; value: string; onChange: (v: string) => void
}) {
  const batches = useList<{ items: { id: string; batchNo: string; qty: number; expiryDate?: string | null }[] }>(
    warehouseId ? `/api/batches?companyId=${companyId}&itemId=${itemId}&warehouseId=${warehouseId}` : null,
  )
  const opts = [
    { value: '', label: 'Auto (earliest expiry first)' },
    ...(batches.data?.items ?? []).map((b) => ({
      value: b.batchNo, label: `${b.batchNo} · qty ${b.qty}${b.expiryDate ? ` · exp ${new Date(b.expiryDate).toLocaleDateString('en-IN')}` : ''}`,
    })),
  ]
  return <SelectInput value={value} onChange={onChange} options={opts} disabled={!warehouseId} placeholder="Batch…" />
}
function LineSerialPick({ companyId, itemId, warehouseId, qty, value, onChange }: {
  companyId: string; itemId: string; warehouseId: string; qty: number; value: string; onChange: (v: string) => void
}) {
  const inStock = useList<{ items: { id: string; serialNo: string }[] }>(
    warehouseId ? `/api/serials?companyId=${companyId}&itemId=${itemId}&warehouseId=${warehouseId}&status=IN_STOCK` : null,
  )
  const avail = (inStock.data?.items ?? []).map((s) => s.serialNo).sort()
  const entered = serialList(value)
  const need = Math.round(qty)
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <span className={entered.length === need ? 'text-[10px] text-muted-foreground uppercase' : 'text-[10px] text-warning uppercase'}>
          Serial nos — {entered.length} of {need} entered · {avail.length} in stock
        </span>
        {avail.length > 0 && (
          <Button type="button" variant="ghost" size="sm" className="h-6 text-xs"
            onClick={() => onChange(avail.filter((s) => !entered.includes(s)).slice(0, Math.max(0, need - entered.length)).concat(entered).join('\n'))}>
            Fill from stock
          </Button>
        )}
      </div>
      <Textarea rows={2} value={value} onChange={(e) => onChange(e.target.value)} placeholder="One serial / IMEI per line" />
    </div>
  )
}

interface TrfRow {
  id: string; date: string; type?: string
  qtyOut?: number; qtyIn?: number; qty?: number
  refNumber?: string | null; notes?: string | null
  itemId?: string
  item?: { code?: string; name?: string; uom?: string } | null
  warehouse?: { code?: string; name?: string } | null
  fromWarehouse?: { name?: string } | null
}

let lineKey = 0

export default function StockTransfersModule({ companyId }: { companyId: string }) {
  const items = useList<{ items?: ItemRow[] } | ItemRow[]>(`/api/items?companyId=${companyId}`)
  const whs = useList<{ items?: WarehouseRow[] } | WarehouseRow[]>(`/api/warehouses?companyId=${companyId}`)
  const list = useList<{ items?: TrfRow[] } | TrfRow[]>(`/api/stock-transfers?companyId=${companyId}`)

  const itemRows = rowsOf(items.data)
  const whRows = rowsOf(whs.data)
  const trfRows = rowsOf(list.data)

  const [fromWh, setFromWh] = React.useState('')
  const [toWh, setToWh] = React.useState('')
  const [date, setDate] = React.useState(todayISO())
  const [notes, setNotes] = React.useState('')
  const [lines, setLines] = React.useState<LineDraft[]>([{ key: ++lineKey, itemId: '', qty: 0 }])
  const [saving, setSaving] = React.useState(false)

  const itemOptions = itemRows.filter((i) => i.id).map((i) => ({ value: i.id, label: `${i.code || ''} — ${i.name || ''}`.trim() }))
  const whOptions = whRows.map((w) => ({ value: w.id, label: `${w.code || ''} — ${w.name || ''} (${w.type || 'GENERAL'})`.trim() }))
  const itemLabel = (id: string) => itemOptions.find((o) => o.value === id)?.label || id
  const flagsOf = (id: string) => {
    const it = itemRows.find((i) => i.id === id)
    const svc = it?.type === 'SERVICE'
    return { batch: !!it?.batchTracked && !svc, serial: !!it?.trackSerial && !svc }
  }

  function addLine() {
    setLines((ls) => [...ls, { key: ++lineKey, itemId: '', qty: 0 }])
  }

  function updateLine(key: number, patch: Partial<LineDraft>) {
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)))
  }

  /** Set a line's item; an item already on another line adds this qty there instead. */
  function pickItem(key: number, itemId: string) {
    const idx = lines.findIndex((l) => l.key === key)
    if (idx < 0) return
    const r = pickIntoLines(lines, idx, itemId, (l) => ({ ...l, itemId }))
    if (r.merged) toast.info('Item already on another line — quantity added to that line')
    setLines(r.lines)
  }

  function removeLine(key: number) {
    setLines((ls) => (ls.length > 1 ? ls.filter((l) => l.key !== key) : ls))
  }

  async function submit() {
    if (!fromWh) { toast.error('Select the source warehouse'); return }
    if (!toWh) { toast.error('Select the destination warehouse'); return }
    if (fromWh === toWh) { toast.error('Source and destination warehouse must be different'); return }
    const toPost = lines.filter((l) => l.itemId && l.qty > 0)
    if (toPost.length === 0) { toast.error('Add at least one line with an item and qty > 0'); return }
    const badSerial = toPost.find((l) => flagsOf(l.itemId).serial && serialList(l.serials).length !== l.qty)
    if (badSerial) { toast.error(`${itemLabel(badSerial.itemId)}: enter exactly ${badSerial.qty} serial no(s) to move`); return }
    setSaving(true)
    try {
      await apiPost('/api/stock-transfers', {
        companyId,
        fromWarehouseId: fromWh,
        toWarehouseId: toWh,
        date,
        notes: notes || undefined,
        lines: toPost.map((l) => {
          const f = flagsOf(l.itemId)
          return {
            itemId: l.itemId, qty: l.qty,
            ...(f.batch && l.batchNo ? { batchNo: l.batchNo } : {}),
            ...(f.serial ? { serials: l.serials || '' } : {}),
          }
        }),
      })
      toast.success('Stock transfer posted')
      setLines([{ key: ++lineKey, itemId: '', qty: 0 }])
      setNotes(''); setDate(todayISO())
      void list.refetch()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to post transfer')
    } finally { setSaving(false) }
  }

  const columns: Column<TrfRow>[] = [
    { key: 'date', header: 'Date', render: (r) => <DateCell value={r.date} /> },
    {
      key: 'item', header: 'Item', render: (r) => {
        const label = r.item ? `${r.item.code || ''} — ${r.item.name || ''}`.trim() : r.itemId ? itemLabel(r.itemId) : '—'
        return <span className="truncate block max-w-56">{label}</span>
      },
    },
    { key: 'warehouse', header: 'From Warehouse', render: (r) => r.fromWarehouse?.name || r.warehouse?.name || '—' },
    {
      key: 'qty', header: 'Qty', className: 'text-right', render: (r) => {
        const q = r.qtyOut ?? r.qty ?? 0
        return <span className="tabular-nums">{fmtNum(q)}{r.item?.uom ? ` ${r.item.uom}` : ''}</span>
      },
    },
    { key: 'type', header: 'Type', hideOnMobile: true, render: (r) => <span className="text-xs text-muted-foreground">{(r.type || 'TRANSFER_OUT').replaceAll('_', ' ')}</span> },
    { key: 'ref', header: 'Ref #', hideOnMobile: true, render: (r) => <span className="whitespace-nowrap text-muted-foreground">{r.refNumber || '—'}</span> },
  ]

  return (
    <div>
      <PageHeader title="Stock Transfers" description="Move stock between warehouses — posts TRANSFER_OUT and TRANSFER_IN pairs" />

      <SectionCard title="Transfer" className="mb-4">
        <form onSubmit={(e) => { e.preventDefault(); void submit() }} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="From Warehouse" required>
              <SelectInput value={fromWh} onChange={setFromWh} options={whOptions} placeholder="Source…" />
            </Field>
            <Field label="To Warehouse" required>
              <SelectInput value={toWh} onChange={setToWh} options={whOptions} placeholder="Destination…" />
            </Field>
            <Field label="Date" required>
              <TextInput type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </Field>
          </div>

          <div className="space-y-2">
            {lines.map((l, idx) => (
              <div key={l.key} className="space-y-2">
              <div className="flex flex-col sm:flex-row gap-2 sm:items-end">
                <Field label={idx === 0 ? 'Item' : ''} className="flex-1">
                  <ItemPicker items={itemRows} value={l.itemId} onChange={(id) => pickItem(l.key, id)} />
                </Field>
                <Field label={idx === 0 ? 'Qty' : ''} className="sm:w-36">
                  <NumberInput value={l.qty} min={0} step="any" onChange={(n) => updateLine(l.key, { qty: n })} placeholder="0" />
                </Field>
                <Button type="button" variant="ghost" size="icon" className="h-9 w-9 text-destructive hover:text-destructive shrink-0" onClick={() => removeLine(l.key)} aria-label="Remove line">
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
              {l.itemId && flagsOf(l.itemId).batch && (
                <Field label="Batch to move" className="sm:w-80 sm:pl-2">
                  <LineBatchPick companyId={companyId} itemId={l.itemId} warehouseId={fromWh} value={l.batchNo ?? ''} onChange={(v) => updateLine(l.key, { batchNo: v })} />
                </Field>
              )}
              {l.itemId && flagsOf(l.itemId).serial && l.qty > 0 && (
                <div className="sm:pl-2">
                  <LineSerialPick companyId={companyId} itemId={l.itemId} warehouseId={fromWh} qty={l.qty} value={l.serials ?? ''} onChange={(v) => updateLine(l.key, { serials: v })} />
                </div>
              )}
              </div>
            ))}
            <Button type="button" variant="outline" size="sm" onClick={addLine}>
              <Plus className="h-3.5 w-3.5 mr-1" />Add line
            </Button>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Notes">
              <TextInput value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional remarks" />
            </Field>
            <div className="flex items-end justify-end">
              <Button type="submit" disabled={saving}>
                <ArrowRightLeft className="h-4 w-4 mr-1.5" />{saving ? 'Posting…' : 'Post Transfer'}
              </Button>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">Transferring more than available stock will be rejected by the server.</p>
        </form>
      </SectionCard>

      <SectionCard title={`Recent transfers (${trfRows.length})`}>
        <DataTable
          columns={columns} rows={trfRows} loading={list.loading}
          searchPlaceholder="Search transfers…" emptyText="No transfers posted yet"
        />
      </SectionCard>
    </div>
  )
}
