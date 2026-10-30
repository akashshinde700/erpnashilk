'use client'

import * as React from 'react'
import { toast } from 'sonner'
import { AlertTriangle, Barcode, ChevronDown, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, SelectInput, TextInput } from '@/components/erp/kit'
import { apiPost } from '@/lib/use-api'
import { ITEM_TYPES, UOMS } from '@/lib/erp-constants'
import { findSimilarItems, normalizeItemName } from '@/lib/item-match'
import { cn } from '@/lib/utils'

export interface PickerItem {
  id: string
  code?: string | null
  name?: string | null
  uom?: string | null
  purchasePrice?: number | null
  sellingPrice?: number | null
  gstRate?: number | null
  barcode?: string | null
  partNo?: string | null
}

const labelOf = (i: PickerItem) => (i.code ? `${i.code} — ${i.name ?? ''}` : i.name || i.id)

/** Exact (case-insensitive) barcode or item-code match — what a USB/Bluetooth scanner types. */
export function findByScan<T extends PickerItem>(items: T[], raw: string): T | undefined {
  const code = raw.trim().toLowerCase()
  if (!code) return undefined
  return items.find((i) => (i.barcode ?? '').trim().toLowerCase() === code)
    ?? items.find((i) => (i.code ?? '').trim().toLowerCase() === code)
}

/**
 * Put an item on line `idx`. If the item is already on another line, that line's qty grows by this
 * line's qty instead (and line `idx` is dropped unless it is the only one). `apply` sets the item on a line.
 */
export function pickIntoLines<L extends { itemId: string; qty: number }>(lines: L[], idx: number, itemId: string, apply: (line: L) => L): { lines: L[]; merged: boolean } {
  const dup = lines.findIndex((x, i) => i !== idx && x.itemId === itemId)
  if (dup >= 0) {
    const add = lines[idx]?.qty ?? 0
    return {
      merged: true,
      lines: lines
        .map((x, i) => (i === dup ? { ...x, qty: Math.round((x.qty + add) * 1000) / 1000 } : x))
        .filter((_, i) => i !== idx || lines.length === 1),
    }
  }
  return { merged: false, lines: lines.map((x, i) => (i === idx ? apply(x) : x)) }
}

/**
 * A scanned item: +1 on its existing line, else fill the only (empty) line, else append a new line.
 * `make` builds a fresh line for the item with qty 1.
 */
export function scanIntoLines<L extends { itemId: string; qty: number }>(lines: L[], itemId: string, make: () => L): L[] {
  const at = lines.findIndex((x) => x.itemId === itemId)
  if (at >= 0) return lines.map((x, i) => (i === at ? { ...x, qty: Math.round((x.qty + 1) * 1000) / 1000 } : x))
  if (lines.length === 1 && !lines[0].itemId) return [make()]
  return [...lines, make()]
}

/**
 * Scan bar for barcode scanners: Enter looks the typed code up by barcode / item code (exact,
 * case-insensitive), calls `onScan`, then clears itself and keeps focus for the next scan.
 */
export function ScanToAdd<T extends PickerItem>({ items, onScan, className }: {
  items: T[]
  onScan: (item: T) => void
  className?: string
}) {
  const [code, setCode] = React.useState('')
  const ref = React.useRef<HTMLInputElement>(null)
  return (
    <div className={cn('relative', className)}>
      <Barcode className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        ref={ref}
        className="h-9 pl-8"
        value={code}
        placeholder="Scan barcode…"
        aria-label="Scan barcode"
        autoComplete="off"
        onChange={(e) => setCode(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return
          e.preventDefault() // never submit the surrounding form
          const typed = code.trim()
          if (!typed) return
          const it = findByScan(items, typed)
          if (it) onScan(it)
          else toast.error(`No item with barcode ${typed}`)
          setCode('')
          ref.current?.focus()
        }}
      />
    </div>
  )
}

/**
 * Searchable item select with "+ Add new item". Typing matches code, name, barcode or part no. (ignoring case/spaces);
 * when nothing fits, the typed text can be created as a new item (`onCreate`).
 * Renders inline (no portal) so it works inside dialogs.
 */
export function ItemPicker({ items, value, onChange, onCreate, placeholder = 'Search or add item…' }: {
  items: PickerItem[]
  value: string
  onChange: (id: string) => void
  onCreate?: (typed: string) => void
  placeholder?: string
}) {
  const [open, setOpen] = React.useState(false)
  const [q, setQ] = React.useState('')
  const [hi, setHi] = React.useState(0)
  const boxRef = React.useRef<HTMLDivElement>(null)
  const selected = items.find((i) => i.id === value)

  const nq = normalizeItemName(q)
  const matches = nq
    ? items.filter((i) => normalizeItemName(`${i.code ?? ''}${i.name ?? ''}`).includes(nq) || normalizeItemName(i.name ?? '').includes(nq)
      || normalizeItemName(i.barcode ?? '').includes(nq) || normalizeItemName(i.partNo ?? '').includes(nq))
    : items
  const shown = matches.slice(0, 50)
  const canCreate = !!onCreate && q.trim().length >= 2 && !items.some((i) => normalizeItemName(i.name ?? '') === nq)
  const total = shown.length + (canCreate ? 1 : 0)

  React.useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (!boxRef.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  function choose(idx: number) {
    if (idx < shown.length) { onChange(shown[idx].id); setOpen(false); setQ('') }
    else if (canCreate) { onCreate?.(q.trim()); setOpen(false); setQ('') }
  }

  return (
    <div ref={boxRef} className="relative">
      <div className="relative">
        <Input
          className="h-9 pr-8"
          value={open ? q : selected ? labelOf(selected) : ''}
          placeholder={selected ? labelOf(selected) : placeholder}
          onFocus={() => { setOpen(true); setHi(0) }}
          onChange={(e) => { setQ(e.target.value); setOpen(true); setHi(0) }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setHi((h) => Math.min(h + 1, total - 1)) }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)) }
            else if (e.key === 'Enter') {
              // A scanner types the full barcode/code then Enter — pick that exact item even if not highlighted
              const scanned = q.trim() ? findByScan(items, q) : undefined
              if (scanned) { e.preventDefault(); onChange(scanned.id); setOpen(false); setQ('') }
              else if (open && total) { e.preventDefault(); choose(hi) }
            }
            else if (e.key === 'Escape' && open) { e.stopPropagation(); setOpen(false) }
          }}
        />
        <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      </div>
      {open && (
        <div className="absolute z-50 mt-1 max-h-64 w-full min-w-64 overflow-y-auto rounded-md border bg-popover p-1 text-sm shadow-md">
          {shown.map((it, idx) => (
            <button
              key={it.id} type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => choose(idx)}
              onMouseEnter={() => setHi(idx)}
              className={cn('block w-full truncate rounded px-2 py-1.5 text-left', idx === hi ? 'bg-accent' : '', it.id === value && 'font-medium')}
            >
              {labelOf(it)}{it.uom ? <span className="ml-1 text-xs text-muted-foreground">· {it.uom}</span> : null}
            </button>
          ))}
          {!shown.length && !canCreate && <p className="px-2 py-1.5 text-muted-foreground">No matching items</p>}
          {canCreate && (
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => choose(shown.length)}
              onMouseEnter={() => setHi(shown.length)}
              className={cn('mt-1 flex w-full items-center gap-1.5 rounded border-t px-2 py-1.5 text-left text-success', hi === shown.length && 'bg-accent')}
            >
              <Plus className="h-3.5 w-3.5" />Add new item “{q.trim()}”
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * Quick "new item" form used from document lines. Warns about existing items with the same or a
 * similar name (likely spelling variants) and offers to use one of those instead.
 */
export function QuickItemDialog({ open, onOpenChange, initialName, items, defaultType = 'RAW', onCreated, onUseExisting }: {
  open: boolean
  onOpenChange: (o: boolean) => void
  initialName: string
  items: PickerItem[]
  defaultType?: string
  onCreated: (item: PickerItem) => void
  onUseExisting: (item: PickerItem) => void
}) {
  const [name, setName] = React.useState(initialName)
  const [code, setCode] = React.useState('')
  const [type, setType] = React.useState(defaultType)
  const [uom, setUom] = React.useState('NOS')
  const [hsn, setHsn] = React.useState('')
  const [gst, setGst] = React.useState('18')
  const [price, setPrice] = React.useState('')
  const [saving, setSaving] = React.useState(false)

  React.useEffect(() => {
    if (!open) return
    setName(initialName); setCode(''); setType(defaultType); setUom('NOS'); setHsn(''); setGst('18'); setPrice('')
  }, [open, initialName, defaultType])

  const { exact, similar } = findSimilarItems(items, name)

  async function save() {
    if (!name.trim()) { toast.error('Item name is required'); return }
    if (exact) { onUseExisting(exact); onOpenChange(false); return }
    setSaving(true)
    try {
      const created = await apiPost<PickerItem>('/api/items', {
        name: name.trim(), code: code.trim() || undefined, type, uom, hsn: hsn.trim() || undefined,
        gstRate: gst === '' ? 18 : Number(gst), purchasePrice: price === '' ? 0 : Number(price),
      })
      toast.success(`Item ${created.code} added to Items`)
      onCreated(created)
      onOpenChange(false)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to add item')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add new item</DialogTitle>
          <DialogDescription>Saved to the Items master and selected on this line.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Item name" required className="sm:col-span-2">
            <TextInput value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </Field>
          {(exact || similar.length > 0) && (
            <div className="sm:col-span-2 rounded-lg border border-warning-border bg-warning-soft p-3 text-sm dark:border-warning-border dark:bg-warning-soft">
              <p className="mb-2 flex items-center gap-1.5 font-medium text-warning">
                <AlertTriangle className="h-4 w-4" />{exact ? 'This item already exists' : 'Similar items already exist — check the spelling'}
              </p>
              <div className="grid gap-1.5">
                {(exact ? [exact] : similar).map((it) => (
                  <div key={it.id} className="flex items-center justify-between gap-2">
                    <span className="truncate">{labelOf(it)}</span>
                    <Button type="button" size="sm" variant="outline" className="h-7" onClick={() => { onUseExisting(it); onOpenChange(false) }}>Use this</Button>
                  </div>
                ))}
              </div>
            </div>
          )}
          <Field label="Code"><TextInput value={code} onChange={(e) => setCode(e.target.value)} placeholder="Auto" /></Field>
          <Field label="Type"><SelectInput value={type} onChange={setType} options={ITEM_TYPES.map((t) => ({ value: t, label: t }))} /></Field>
          <Field label="UOM"><SelectInput value={uom} onChange={setUom} options={UOMS.map((u) => ({ value: u, label: u }))} /></Field>
          <Field label="HSN"><TextInput value={hsn} onChange={(e) => setHsn(e.target.value)} /></Field>
          <Field label="GST %"><TextInput type="number" min={0} value={gst} onChange={(e) => setGst(e.target.value)} /></Field>
          <Field label="Purchase price (₹)"><TextInput type="number" min={0} value={price} onChange={(e) => setPrice(e.target.value)} /></Field>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="button" disabled={saving} onClick={() => void save()}>{exact ? 'Use existing item' : saving ? 'Saving…' : 'Add item'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
