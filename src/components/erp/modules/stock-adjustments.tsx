'use client'

import * as React from 'react'
import { toast } from 'sonner'
import { Plus, SlidersHorizontal, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import {
  DataTable, DateCell, DateInput, Field, NumberInput, PageHeader, SectionCard, SelectInput, TextInput, useCreatePreset, type Column,
} from '@/components/erp/kit'
import { apiPost, useList } from '@/lib/use-api'
import { fmtNum } from '@/lib/erp-constants'
import { ItemPicker, ScanToAdd, pickIntoLines, scanIntoLines } from '@/components/erp/item-picker'

const todayISO = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const rowsOf = <T,>(d: T[] | { items?: T[] } | null | undefined): T[] => (Array.isArray(d) ? d : d?.items || [])

// ---------- types ----------
interface ItemRow { id: string; code?: string; name?: string; uom?: string; barcode?: string | null; partNo?: string | null; batchTracked?: boolean | null; trackSerial?: boolean | null; type?: string | null }
interface WarehouseRow { id: string; code?: string; name?: string; type?: string }
interface LineDraft {
  key: number; itemId: string; qty: number; reasonType: string
  // batch items: IN → batch no / mfg / expiry, OUT → optional batch (blank = FEFO); serial items: serial nos
  batchNo?: string; mfgDate?: string; expiryDate?: string; serials?: string
}

// newline / comma separated → unique non-empty serials (mirrors parseSerials on the server)
const serialList = (t: string | undefined) => Array.from(new Set(String(t || '').split(/[\r\n,;]+/).map((x) => x.trim()).filter(Boolean)))
function OutBatchPick({ companyId, itemId, warehouseId, value, onChange }: {
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

const REASON_TYPES = [
  { value: 'CORRECTION', label: 'Count correction' },
  { value: 'DAMAGE', label: 'Damage' },
  { value: 'EXPIRY', label: 'Expiry' },
  { value: 'THEFT', label: 'Theft / loss' },
  { value: 'SAMPLE', label: 'Sample' },
  { value: 'OTHER', label: 'Other' },
]
const REASON_LABEL: Record<string, string> = Object.fromEntries(REASON_TYPES.map((r) => [r.value, r.label]))
let lineKey = 0
const blankLine = (itemId = ''): LineDraft => ({ key: ++lineKey, itemId, qty: 0, reasonType: 'CORRECTION' })
interface AdjRow {
  id: string; date: string; type?: string
  qtyIn?: number; qtyOut?: number; qty?: number
  reason?: string | null; notes?: string | null; reasonType?: string | null
  itemId?: string
  item?: { code?: string; name?: string; uom?: string } | null
  warehouse?: { code?: string; name?: string } | null
}


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
  const [lines, setLines] = React.useState<LineDraft[]>(() => [blankLine()])
  const [saving, setSaving] = React.useState(false)
  const formRef = React.useRef<HTMLDivElement | null>(null)

  // "Adjust stock" from the Items screen (or the `n` shortcut): start a fresh adjustment, optionally pre-filled
  useCreatePreset('stock-adjustments', (d) => {
    setLines([blankLine(d.itemId ? String(d.itemId) : '')])
    if (d.warehouseId) setWarehouseId(String(d.warehouseId))
    setTimeout(() => formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50)
  })

  const itemOptions = itemRows.filter((i) => i.id).map((i) => ({ value: i.id, label: `${i.code || ''} — ${i.name || ''}`.trim() }))
  const whOptions = whRows.map((w) => ({ value: w.id, label: `${w.code || ''} — ${w.name || ''} (${w.type || 'GENERAL'})`.trim() }))
  const itemLabel = (id: string) => itemOptions.find((o) => o.value === id)?.label || id
  const flagsOf = (id: string) => {
    const it = itemRows.find((i) => i.id === id)
    const svc = it?.type === 'SERVICE'
    return { batch: !!it?.batchTracked && !svc, serial: !!it?.trackSerial && !svc }
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

  // Barcode scan: +1 on the item's line, or a new line with qty 1
  function scanItem(it: ItemRow) {
    setLines((ls) => scanIntoLines(ls, it.id, () => ({ ...blankLine(it.id), qty: 1 })))
  }

  function removeLine(key: number) {
    setLines((ls) => (ls.length > 1 ? ls.filter((l) => l.key !== key) : ls))
  }

  async function submit() {
    if (!warehouseId) { toast.error('Select a warehouse'); return }
    const toPost = lines.filter((l) => l.itemId && l.qty !== 0)
    if (toPost.length === 0) { toast.error('Add at least one line with an item and a non-zero qty'); return }
    const badSerial = toPost.find((l) => flagsOf(l.itemId).serial && serialList(l.serials).length !== Math.abs(l.qty))
    if (badSerial) { toast.error(`${itemLabel(badSerial.itemId)}: enter exactly ${Math.abs(badSerial.qty)} serial no(s)`); return }
    setSaving(true)
    try {
      await apiPost('/api/stock-adjustments', {
        companyId, warehouseId, date,
        reason: reason || undefined,
        notes: reason || undefined,
        lines: toPost.map((l) => {
          const f = flagsOf(l.itemId)
          return {
            itemId: l.itemId, qty: l.qty, reasonType: l.reasonType,
            ...(f.batch ? { batchNo: l.batchNo?.trim() || undefined, ...(l.qty > 0 ? { mfgDate: l.mfgDate || undefined, expiryDate: l.expiryDate || undefined } : {}) } : {}),
            ...(f.serial ? { serials: l.serials || '' } : {}),
          }
        }),
      })
      toast.success('Stock adjustment posted')
      setLines([blankLine()])
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
          <span className={`tabular-nums font-medium ${isIn ? 'text-success' : 'text-destructive'}`}>
            {isIn ? '+' : ''}{fmtNum(q)}{r.item?.uom ? ` ${r.item.uom}` : ''}
          </span>
        )
      },
    },
    { key: 'type', header: 'Type', hideOnMobile: true, render: (r) => <span className="text-xs text-muted-foreground">{(r.type || '').replaceAll('_', ' ') || '—'}</span> },
    {
      key: 'reasonType', header: 'Reason', sortValue: (r) => r.reasonType || '', render: (r) => r.reasonType
        ? <span className="inline-flex rounded-full border px-2 py-0.5 text-xs font-medium">{REASON_LABEL[r.reasonType] ?? r.reasonType}</span>
        : <span className="text-muted-foreground">—</span>,
    },
    { key: 'reason', header: 'Notes', hideOnMobile: true, render: (r) => <span className="truncate block max-w-64 text-muted-foreground">{r.reason || r.notes || '—'}</span> },
  ]

  return (
    <div>
      <PageHeader title="Stock Adjustments" description="Correct stock levels — positive qty adds stock, negative removes it" />

      <div ref={formRef} className="scroll-mt-4">
      <SectionCard title="Adjustment" className="mb-4">
        <form onSubmit={(e) => { e.preventDefault(); void submit() }} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Warehouse" required>
              <SelectInput value={warehouseId} onChange={setWarehouseId} options={whOptions} placeholder="Select warehouse…" />
            </Field>
            <Field label="Date" required>
              <TextInput type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </Field>
            <Field label="Notes">
              <TextInput value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Physical count on 31-Mar" />
            </Field>
          </div>

          <div className="space-y-2">
            <ScanToAdd items={itemRows} onScan={scanItem} className="sm:w-72" />
            {lines.map((l, idx) => (
              <div key={l.key} className="space-y-2">
              <div className="flex flex-col sm:flex-row gap-2 sm:items-end">
                <Field label={idx === 0 ? 'Item' : ''} className="flex-1">
                  <ItemPicker items={itemRows} value={l.itemId} onChange={(id) => pickItem(l.key, id)} />
                </Field>
                <Field label={idx === 0 ? 'Qty (+in / -out)' : ''} className="sm:w-40">
                  <NumberInput value={l.qty} step="any" onChange={(n) => updateLine(l.key, { qty: n })} placeholder="0" />
                </Field>
                <Field label={idx === 0 ? 'Reason' : ''} className="sm:w-44">
                  <SelectInput value={l.reasonType} onChange={(v) => updateLine(l.key, { reasonType: v })} options={REASON_TYPES} />
                </Field>
                <Button type="button" variant="ghost" size="icon" className="h-9 w-9 text-destructive hover:text-destructive shrink-0" onClick={() => removeLine(l.key)} aria-label="Remove line">
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
              {l.itemId && flagsOf(l.itemId).batch && l.qty > 0 && (
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 sm:pl-2">
                  <Field label="Batch no"><TextInput value={l.batchNo ?? ''} onChange={(e) => updateLine(l.key, { batchNo: e.target.value })} placeholder="Blank = adjustment number" /></Field>
                  <Field label="Mfg date"><DateInput value={l.mfgDate ?? ''} onChange={(v) => updateLine(l.key, { mfgDate: v })} /></Field>
                  <Field label="Expiry date"><DateInput value={l.expiryDate ?? ''} onChange={(v) => updateLine(l.key, { expiryDate: v })} /></Field>
                </div>
              )}
              {l.itemId && flagsOf(l.itemId).batch && l.qty < 0 && (
                <Field label="Batch to remove from" className="sm:w-80 sm:pl-2">
                  <OutBatchPick companyId={companyId} itemId={l.itemId} warehouseId={warehouseId} value={l.batchNo ?? ''} onChange={(v) => updateLine(l.key, { batchNo: v })} />
                </Field>
              )}
              {l.itemId && flagsOf(l.itemId).serial && l.qty !== 0 && (
                <Field label={`Serial nos ${l.qty > 0 ? 'coming in' : 'to write off'} — ${serialList(l.serials).length} of ${Math.abs(l.qty)} entered`} className="sm:pl-2">
                  <Textarea rows={2} value={l.serials ?? ''} onChange={(e) => updateLine(l.key, { serials: e.target.value })}
                    placeholder="One serial / IMEI per line"
                    className={serialList(l.serials).length !== Math.abs(l.qty) ? 'border-warning-border' : ''} />
                </Field>
              )}
              </div>
            ))}
            <Button type="button" variant="outline" size="sm" onClick={() => setLines((ls) => [...ls, blankLine()])}>
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
      </div>

      <SectionCard title={`Recent adjustments (${adjRows.length})`}>
        <DataTable
          columns={columns} rows={adjRows} loading={list.loading}
          searchPlaceholder="Search adjustments…" emptyText="No adjustments posted yet"
        />
      </SectionCard>
    </div>
  )
}
