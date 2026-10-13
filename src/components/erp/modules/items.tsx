'use client'

import * as React from 'react'
import { Layers, Pencil, Plus, SlidersHorizontal, Tags, Trash2, Upload, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'
import { ITEM_TYPES, ITEM_TYPE_LABEL, UOMS, fmtMoney } from '@/lib/erp-constants'
import { code128Svg } from '@/lib/barcode'
import { apiDelete, apiPatch, apiPost, useList } from '@/lib/use-api'
import ImportDialog from '@/components/erp/import-dialog'
import {
  ConfirmAction,
  DataTable,
  Field,
  FormDialog,
  Money,
  NumberInput,
  PageHeader,
  SelectInput,
  StatusBadge,
  TextInput,
  openCreate as openCreateIn,
  printHtml,
  useRowHighlight,
} from '@/components/erp/kit'
import type { Column } from '@/components/erp/kit'

// ---------- API shapes ----------

interface ItemRow {
  id: string
  code: string
  stockQty?: number
  stockValue?: number
  stockByStore?: { code: string; name: string; qty: number }[]
  name: string
  type: string
  category?: string | null
  uom: string
  hsn?: string | null
  gstRate?: number
  purchasePrice?: number
  sellingPrice?: number
  standardCost?: number
  reorderLevel?: number
  minStock?: number
  maxStock?: number | null
  batchTracked?: boolean
  brand?: string | null
  partNo?: string | null
  barcode?: string | null
  leadTimeDays?: number | null
  description?: string | null
  status: string
  altUom?: string | null
  altFactor?: number | null
  mrp?: number | null
  priceIncludesTax?: boolean
  rack?: string | null
  cessRate?: number
  trackSerial?: boolean
  variantOf?: string | null
  variantAttrs?: string | null
  variantCount?: number
}

interface ItemsResponse {
  items: ItemRow[]
  total?: number
}

interface WarehouseLite {
  id: string
  code: string
  name: string
}

interface FormState {
  code: string
  name: string
  type: string
  category: string
  uom: string
  hsn: string
  gstRate: number
  purchasePrice: number
  sellingPrice: number
  standardCost: number
  reorderLevel: number
  minStock: number
  maxStock: string // '' = not set
  batchTracked: string // 'YES' | 'NO'
  brand: string
  partNo: string
  barcode: string
  leadTimeDays: string // '' = not set
  description: string
  status: string
  openingQty: number
  openingRate: number
  openingWarehouseId: string
  altUom: string // '' = no secondary unit
  altFactor: string
  mrp: string // '' = not set
  priceIncludesTax: string // 'YES' | 'NO'
  rack: string
  cessRate: number
  trackSerial: string // 'YES' | 'NO'
}

const emptyForm: FormState = {
  code: '',
  name: '',
  type: 'RAW',
  category: '',
  uom: 'NOS',
  hsn: '',
  gstRate: 18,
  purchasePrice: 0,
  sellingPrice: 0,
  standardCost: 0,
  reorderLevel: 0,
  minStock: 0,
  maxStock: '',
  batchTracked: 'NO',
  brand: '',
  partNo: '',
  barcode: '',
  leadTimeDays: '',
  description: '',
  status: 'ACTIVE',
  openingQty: 0,
  openingRate: 0,
  openingWarehouseId: '',
  altUom: '',
  altFactor: '',
  mrp: '',
  priceIncludesTax: 'NO',
  rack: '',
  cessRate: 0,
  trackSerial: 'NO',
}

const YES_NO = [
  { value: 'NO', label: 'No' },
  { value: 'YES', label: 'Yes' },
]

/** "M / Red" from a variant's attribute JSON ('' when absent/malformed). */
function variantLabel(raw: string | null | undefined): string {
  if (!raw) return ''
  try {
    const v = JSON.parse(raw) as unknown
    if (!v || typeof v !== 'object' || Array.isArray(v)) return ''
    return Object.values(v as Record<string, unknown>).map(String).join(' / ')
  } catch {
    return ''
  }
}

interface VariantAttrDraft { key: number; name: string; values: string }
let attrKeySeq = 0
function splitValues(s: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of s.split(',')) {
    const v = raw.trim()
    if (!v || seen.has(v.toLowerCase())) continue
    seen.add(v.toLowerCase())
    out.push(v)
  }
  return out
}

// ---------- Barcode labels ----------

const LABEL_SIZES: Record<string, { w: number; h: number; label: string }> = {
  '50x25': { w: 50, h: 25, label: '50 × 25 mm' },
  '38x25': { w: 38, h: 25, label: '38 × 25 mm' },
}
const MAX_LABEL_ITEMS = 200

const escHtml = (v: string | null | undefined) =>
  (v ?? '').replace(/[&<>"]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'))

/** EAN-13 style number: '200' (in-store prefix) + 9 digits from time/random + check digit. */
function generateBarcode(taken: Set<string>): string {
  for (let attempt = 0; attempt < 20; attempt++) {
    const body = '200' + String(Date.now() % 1000000).padStart(6, '0') + String(Math.floor(Math.random() * 1000)).padStart(3, '0')
    const sum = [...body].reduce((s, d, i) => s + Number(d) * (i % 2 === 0 ? 1 : 3), 0)
    const code = body + ((10 - (sum % 10)) % 10)
    if (!taken.has(code)) return code
  }
  return '200' + String(Math.floor(Math.random() * 1e10)).padStart(10, '0')
}

function labelsHtml(list: { item: ItemRow; copies: number }[], sizeKey: string): string {
  const size = LABEL_SIZES[sizeKey] ?? LABEL_SIZES['50x25']
  const cells: string[] = []
  for (const { item, copies } of list) {
    const value = (item.barcode || item.code || '').trim()
    let svg = ''
    try {
      svg = value ? code128Svg(value, { height: 40, moduleWidth: 1.5, showText: false }).replace('<svg ', '<svg preserveAspectRatio="none" ') : ''
    } catch { svg = '' } // characters outside printable ASCII — label shows the text only
    const price = (item.sellingPrice ?? 0) > 0 ? `<span class="pr">${escHtml(fmtMoney(item.sellingPrice))}</span>` : ''
    const cell = `<div class="lbl"><div class="nm">${escHtml(item.name)}</div>`
      + `<div class="bc">${svg}</div>`
      + `<div class="ft"><span>${escHtml(value)}</span>${price}</div>`
      + (item.barcode && item.barcode !== item.code ? `<div class="cd">${escHtml(item.code)}</div>` : '')
      + `</div>`
    for (let i = 0; i < Math.max(0, Math.floor(copies)); i++) cells.push(cell)
  }
  return `<style>
    @page { size: A4; margin: 8mm; }
    body { padding: 0 !important; }
    .sheet { display: grid; grid-template-columns: repeat(auto-fill, ${size.w}mm); grid-auto-rows: ${size.h}mm; gap: 2mm; }
    .lbl { width: ${size.w}mm; height: ${size.h}mm; border: 1px dashed #bbb; border-radius: 1.5mm; padding: 1.2mm 1.8mm; overflow: hidden;
      display: flex; flex-direction: column; break-inside: avoid; page-break-inside: avoid; }
    .nm { font-size: 8.5px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; line-height: 1.25; }
    .bc { flex: 1; min-height: 0; margin: 0.6mm 0; }
    .bc svg { display: block; width: 100%; height: 100%; }
    .ft { display: flex; justify-content: space-between; gap: 2mm; font-family: monospace; font-size: 8px; line-height: 1.2; white-space: nowrap; }
    .ft span:first-child { overflow: hidden; text-overflow: ellipsis; }
    .pr { font-family: -apple-system, 'Segoe UI', Arial, sans-serif; font-weight: 700; }
    .cd { font-size: 7px; color: #555; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    @media print { .lbl { border-color: transparent; } }
  </style><div class="sheet">${cells.join('')}</div>`
}

export default function ItemsModule({ companyId }: { companyId: string }) {
  const highlightId = useRowHighlight('items')
  // Server-side pagination: the API filters + slices, so page/serverQ drive the url.
  const [page, setPage] = React.useState(0)
  const [serverQ, setServerQ] = React.useState('')
  const [hideVariants, setHideVariants] = React.useState(false)
  const { data, loading, refetch } = useList<ItemsResponse>(
    `/api/items?companyId=${companyId}&page=${page + 1}&pageSize=200${serverQ ? `&q=${encodeURIComponent(serverQ)}` : ''}${hideVariants ? '&hideVariants=1' : ''}`,
  )
  const rows = data?.items ?? []

  const [open, setOpen] = React.useState(false)
  const [importOpen, setImportOpen] = React.useState(false)
  const [editing, setEditing] = React.useState<ItemRow | null>(null)
  const [saving, setSaving] = React.useState(false)
  const [form, setForm] = React.useState<FormState>(emptyForm)
  // Barcode label printing: the items to print + copies per item and the label size preset
  const [labelItems, setLabelItems] = React.useState<ItemRow[] | null>(null)
  const [labelQty, setLabelQty] = React.useState<Record<string, number>>({})
  const [labelSize, setLabelSize] = React.useState('50x25')
  const [labelAll, setLabelAll] = React.useState(1)
  const [formTab, setFormTab] = React.useState('basic')
  // Size/colour variants: the parent item + attribute rows ("Size" → "S, M, L")
  const [variantParent, setVariantParent] = React.useState<ItemRow | null>(null)
  const [variantAttrs, setVariantAttrs] = React.useState<VariantAttrDraft[]>([])
  const [variantSaving, setVariantSaving] = React.useState(false)

  // Load warehouses only while creating (for the optional opening stock section)
  const warehouses = useList<{ items: WarehouseLite[] }>(
    open && !editing ? `/api/warehouses?companyId=${companyId}` : null,
  )

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }))

  function openCreate() {
    setEditing(null)
    setForm(emptyForm)
    setFormTab('basic')
    setOpen(true)
  }

  function openEdit(row: ItemRow) {
    setEditing(row)
    setForm({
      code: row.code,
      name: row.name,
      type: row.type,
      category: row.category ?? '',
      uom: row.uom,
      hsn: row.hsn ?? '',
      gstRate: row.gstRate ?? 0,
      purchasePrice: row.purchasePrice ?? 0,
      sellingPrice: row.sellingPrice ?? 0,
      standardCost: row.standardCost ?? 0,
      reorderLevel: row.reorderLevel ?? 0,
      minStock: row.minStock ?? 0,
      maxStock: row.maxStock == null ? '' : String(row.maxStock),
      batchTracked: row.batchTracked ? 'YES' : 'NO',
      brand: row.brand ?? '',
      partNo: row.partNo ?? '',
      barcode: row.barcode ?? '',
      leadTimeDays: row.leadTimeDays == null ? '' : String(row.leadTimeDays),
      description: row.description ?? '',
      status: row.status,
      openingQty: 0,
      openingRate: 0,
      openingWarehouseId: '',
      altUom: row.altUom ?? '',
      altFactor: row.altFactor == null ? '' : String(row.altFactor),
      mrp: row.mrp == null ? '' : String(row.mrp),
      priceIncludesTax: row.priceIncludesTax ? 'YES' : 'NO',
      rack: row.rack ?? '',
      cessRate: row.cessRate ?? 0,
      trackSerial: row.trackSerial ? 'YES' : 'NO',
    })
    setFormTab('basic')
    setOpen(true)
  }

  async function submit() {
    if (!form.name.trim() || (editing && !form.code.trim())) {
      toast.error(editing ? 'Code and name are required' : 'Item name is required')
      setFormTab('basic')
      return
    }
    const altUom = form.altUom.trim().toUpperCase()
    const altFactor = form.altFactor.trim()
    if (altUom || altFactor) {
      if (!altUom || !altFactor) { toast.error('Secondary unit needs both the unit and the conversion factor'); setFormTab('basic'); return }
      if (altUom === form.uom.toUpperCase()) { toast.error('Secondary unit must differ from the UOM'); setFormTab('basic'); return }
      if (!(Number(altFactor) > 0)) { toast.error('Conversion factor must be greater than 0'); setFormTab('basic'); return }
    }
    if (form.mrp.trim() && !(Number(form.mrp) >= 0)) { toast.error('MRP must be 0 or more'); setFormTab('pricing'); return }
    if (form.cessRate < 0) { toast.error('Cess % cannot be negative'); setFormTab('pricing'); return }
    setSaving(true)
    try {
      const body: Record<string, unknown> = {
        companyId,
        code: form.code.trim() || undefined, // blank on create → auto code (RM-001…)
        name: form.name.trim(),
        type: form.type,
        category: form.category.trim() || null,
        uom: form.uom,
        hsn: form.hsn.trim() || null,
        gstRate: form.gstRate,
        purchasePrice: form.purchasePrice,
        sellingPrice: form.sellingPrice,
        standardCost: form.standardCost,
        reorderLevel: form.reorderLevel,
        minStock: form.minStock,
        maxStock: form.maxStock.trim() === '' ? null : Number(form.maxStock),
        batchTracked: form.batchTracked === 'YES',
        brand: form.brand.trim() || null,
        partNo: form.partNo.trim() || null,
        barcode: form.barcode.trim() || null,
        leadTimeDays: form.leadTimeDays.trim() === '' ? null : Number(form.leadTimeDays),
        description: form.description.trim() || null,
        status: form.status,
        altUom: altUom || null,
        altFactor: altUom ? Number(altFactor) : null,
        mrp: form.mrp.trim() === '' ? null : Number(form.mrp),
        priceIncludesTax: form.priceIncludesTax === 'YES',
        rack: form.rack.trim() || null,
        cessRate: form.cessRate,
        trackSerial: form.trackSerial === 'YES',
      }
      if (!editing) {
        body.openingQty = form.openingQty
        body.openingRate = form.openingRate
        body.openingWarehouseId = form.openingWarehouseId || null
      }
      if (editing) await apiPatch(`/api/items/${editing.id}`, body)
      else await apiPost('/api/items', body)
      toast.success('Saved')
      setOpen(false)
      await refetch()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save item')
    } finally {
      setSaving(false)
    }
  }

  function openLabels(list: ItemRow[]) {
    if (!list.length) { toast.error('No items to print labels for'); return }
    if (list.length > MAX_LABEL_ITEMS) toast.info(`Printing labels for the first ${MAX_LABEL_ITEMS} items`)
    const capped = list.slice(0, MAX_LABEL_ITEMS)
    setLabelQty(Object.fromEntries(capped.map((i) => [i.id, 1])))
    setLabelAll(1)
    setLabelItems(capped)
  }

  function printLabels() {
    if (!labelItems) return
    const list = labelItems.map((item) => ({ item, copies: labelQty[item.id] ?? 1 })).filter((l) => l.copies > 0)
    const total = list.reduce((s, l) => s + Math.floor(l.copies), 0)
    if (!total) { toast.error('Set at least one label to print'); return }
    if (total > 2000) { toast.error('Too many labels — print at most 2000 at a time'); return }
    printHtml(`Item labels (${total})`, labelsHtml(list, labelSize))
    setLabelItems(null)
  }

  function fillBarcode() {
    if (form.barcode.trim()) return
    set('barcode', generateBarcode(new Set(rows.map((r) => r.barcode ?? '').filter(Boolean))))
  }

  function openVariants(row: ItemRow) {
    setVariantParent(row)
    setVariantAttrs([
      { key: ++attrKeySeq, name: 'Size', values: '' },
      { key: ++attrKeySeq, name: 'Color', values: '' },
    ])
  }

  const setAttr = (key: number, patch: Partial<VariantAttrDraft>) =>
    setVariantAttrs((as) => as.map((a) => (a.key === key ? { ...a, ...patch } : a)))

  // Attribute rows with a name + at least one value → the combination matrix preview
  const variantDefs = variantAttrs
    .map((a) => ({ name: a.name.trim(), values: splitValues(a.values) }))
    .filter((a) => a.name && a.values.length > 0)
  const variantCombos = variantDefs.reduce<string[][]>(
    (acc, a) => acc.flatMap((c) => a.values.map((v) => [...c, v])),
    [[]],
  )
  const comboCount = variantDefs.length ? variantCombos.length : 0

  async function createVariants() {
    if (!variantParent) return
    if (!variantDefs.length) { toast.error('Add an attribute with comma-separated values, e.g. Size: S, M, L'); return }
    const names = variantDefs.map((a) => a.name.toLowerCase())
    if (new Set(names).size !== names.length) { toast.error('Each attribute name must be different'); return }
    if (comboCount > 200) { toast.error('Too many combinations — at most 200 at a time'); return }
    setVariantSaving(true)
    try {
      const res = await apiPost<{ created: number; skipped: number }>(`/api/items/${variantParent.id}/variants`, {
        companyId,
        attributes: Object.fromEntries(variantDefs.map((a) => [a.name, a.values])),
      })
      toast.success(res?.created ? `${res.created} variant(s) created${res.skipped ? ` · ${res.skipped} already existed` : ''}` : 'All these variants already exist')
      setVariantParent(null)
      await refetch()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to create variants')
    } finally {
      setVariantSaving(false)
    }
  }

  async function remove(row: ItemRow) {
    try {
      await apiDelete(`/api/items/${row.id}?companyId=${companyId}`)
      toast.success('Deleted')
      await refetch()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to delete item')
    }
  }

  const columns: Column<ItemRow>[] = [
    { key: 'code', header: 'Code', render: (r) => <span className="font-medium">{r.code}</span> },
    {
      key: 'name',
      header: 'Name',
      render: (r) => {
        const attrs = r.variantOf ? variantLabel(r.variantAttrs) : ''
        return (
          <div className="max-w-52">
            <span className="flex items-center gap-1.5">
              <span className="truncate">{r.name}</span>
              {(r.variantCount ?? 0) > 0 && (
                <span className="shrink-0 rounded-full border px-1.5 py-px text-[10px] font-medium text-muted-foreground" title="Size / colour variants of this item">
                  variants: {r.variantCount}
                </span>
              )}
            </span>
            {attrs && <span className="block truncate text-xs text-muted-foreground">↳ {attrs}</span>}
          </div>
        )
      },
    },
    { key: 'type', header: 'Type', render: (r) => <StatusBadge status={ITEM_TYPE_LABEL[r.type] ?? r.type} /> },
    {
      key: 'brand',
      header: 'Brand / Part No',
      hideOnMobile: true,
      render: (r) =>
        r.brand || r.partNo ? (
          <span className="block max-w-40 truncate text-muted-foreground">
            {[r.brand, r.partNo].filter(Boolean).join(' · ')}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      key: 'uom',
      header: 'UOM',
      render: (r) => (
        <span className="text-muted-foreground">
          {r.uom}
          {r.altUom && r.altFactor ? (
            <span className="block whitespace-nowrap text-[11px]">1 {r.altUom} = {r.altFactor} {r.uom}</span>
          ) : null}
        </span>
      ),
    },
    {
      key: 'hsn',
      header: 'HSN',
      hideOnMobile: true,
      render: (r) => <span className="text-muted-foreground">{r.hsn || '—'}</span>,
    },
    { key: 'gst', header: 'GST %', render: (r) => <span className="tabular-nums">{r.gstRate ?? 0}%</span> },
    { key: 'purchase', header: 'Purchase', hideOnMobile: true, render: (r) => <Money value={r.purchasePrice} /> },
    { key: 'selling', header: 'Selling', hideOnMobile: true, render: (r) => <Money value={r.sellingPrice} /> },
    {
      key: 'stock',
      header: 'In Stock',
      render: (r) => {
        const qty = r.stockQty ?? 0
        const low = (r.reorderLevel ?? 0) > 0 && qty <= (r.reorderLevel ?? 0)
        const tip = (r.stockByStore ?? []).map((w) => `${w.code}: ${w.qty}`).join('\n') || 'No stock in any store'
        return (
          <span title={`${tip}${r.stockValue ? `\nValue ≈ ₹${r.stockValue.toLocaleString('en-IN')}` : ''}`}
            className={cn('tabular-nums font-medium', qty <= 0 ? 'text-red-600' : low ? 'text-amber-600' : 'text-emerald-700 dark:text-emerald-400')}>
            {qty} <span className="text-xs font-normal text-muted-foreground">{r.uom}</span>
            {low && qty > 0 && <span className="ml-1 text-[10px] font-normal">low</span>}
          </span>
        )
      },
    },
    {
      key: 'reorder',
      header: 'Reorder',
      hideOnMobile: true,
      render: (r) => <span className="tabular-nums text-muted-foreground">{r.reorderLevel ?? 0}</span>,
    },
    {
      key: 'actions',
      header: '',
      className: 'text-right',
      render: (r) => (
        <div className="flex items-center justify-end gap-1">
          {!r.variantOf && (
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openVariants(r)} title="Variants (size / colour)">
              <Layers className="h-3.5 w-3.5" />
            </Button>
          )}
          {r.type !== 'SERVICE' && (
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openCreateIn('stock-adjustments', { itemId: r.id })} title="Adjust stock">
              <SlidersHorizontal className="h-3.5 w-3.5" />
            </Button>
          )}
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openLabels([r])} title="Print barcode labels">
            <Tags className="h-3.5 w-3.5" />
          </Button>
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openEdit(r)} title="Edit">
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <ConfirmAction
            trigger={
              <Button variant="ghost" size="icon" className="h-8 w-8 text-red-600 hover:text-red-700" title="Delete">
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            }
            title="Delete item"
            message={`Delete ${r.code} — ${r.name}? This cannot be undone.`}
            tone="destructive"
            onConfirm={() => remove(r)}
          />
        </div>
      ),
    },
  ]

  return (
    <div>
      <PageHeader
        title="Items"
        description="Materials, finished goods and services master"
        actions={
          <>
            <Button
              size="sm"
              variant={hideVariants ? 'secondary' : 'outline'}
              onClick={() => { setHideVariants((h) => !h); setPage(0) }}
              title="Show only main items (hide size / colour variants)"
            >
              <Layers className="h-4 w-4 mr-1.5" /> {hideVariants ? 'Variants hidden' : 'Hide variants'}
            </Button>
            <Button size="sm" variant="outline" onClick={() => openLabels(rows)} disabled={!rows.length} title="Barcode labels for the items listed (max 200)">
              <Tags className="h-4 w-4 mr-1.5" /> Print labels
            </Button>
            <Button size="sm" variant="outline" onClick={() => setImportOpen(true)}>
              <Upload className="h-4 w-4 mr-1.5" /> Import CSV
            </Button>
            <Button size="sm" onClick={openCreate}>
              <Plus className="h-4 w-4 mr-1.5" /> Item
            </Button>
          </>
        }
      />

      <DataTable
        columns={columns}
        rows={rows}
        loading={loading}
        highlightId={highlightId}
        moduleKey="items"
        savedViewsKey={`${companyId}:items`}
        searchPlaceholder="Search items…"
        emptyText="No items yet"
        serverPagination={{
          page,
          pageSize: 200,
          total: data?.total ?? rows.length,
          onPageChange: setPage,
          onSearchChange: (s) => {
            setServerQ(s)
            setPage(0)
          },
        }}
        csvExport={{
          filename: 'items',
          headers: ['Code', 'Name', 'Type', 'UOM', 'HSN', 'GST %', 'Purchase price', 'Selling price', 'MRP', 'Standard cost', 'Reorder level', 'In stock', 'Status'],
          pick: (r) => [r.code, r.name, r.type, r.uom, r.hsn || '', r.gstRate ?? 0, r.purchasePrice ?? 0, r.sellingPrice ?? 0, r.mrp ?? '', r.standardCost ?? 0, r.reorderLevel ?? 0, r.stockQty ?? 0, r.status],
        }}
        xlsxExport={{
          filename: 'items',
          headers: ['Code', 'Name', 'Type', 'UOM', 'HSN', 'GST %', 'Purchase price', 'Selling price', 'MRP', 'Standard cost', 'Reorder level', 'In stock', 'Status'],
          pick: (r) => [r.code, r.name, r.type, r.uom, r.hsn || '', r.gstRate ?? 0, r.purchasePrice ?? 0, r.sellingPrice ?? 0, r.mrp ?? '', r.standardCost ?? 0, r.reorderLevel ?? 0, r.stockQty ?? 0, r.status],
        }}
      />

      <FormDialog
        open={open}
        onOpenChange={setOpen}
        title={editing ? 'Edit Item' : 'Item'}
        description={editing ? `Updating ${editing.code}` : 'Add a new item to the master'}
        onSubmit={submit}
        loading={saving}
        submitLabel={editing ? 'Update' : 'Create'}
        wide
      >
        <Tabs value={formTab} onValueChange={setFormTab}>
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="basic">Basic</TabsTrigger>
            <TabsTrigger value="pricing">Pricing</TabsTrigger>
            <TabsTrigger value="stock">Stock</TabsTrigger>
          </TabsList>

          {/* ---- Basic: identity, classification, units ---- */}
          <TabsContent value="basic" className="mt-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Name" required>
                <TextInput value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="Hex Bolt M8" />
              </Field>
              <Field label="Code" required={!!editing}>
                <TextInput value={form.code} onChange={(e) => set('code', e.target.value)} placeholder={editing ? 'RM-001' : 'Auto (RM-001…)'} />
              </Field>
              <Field label="Type">
                <SelectInput
                  value={form.type}
                  onChange={(v) => set('type', v)}
                  options={ITEM_TYPES.map((t) => ({ value: t, label: ITEM_TYPE_LABEL[t] }))}
                />
              </Field>
              <Field label="Category">
                <TextInput value={form.category} onChange={(e) => set('category', e.target.value)} placeholder="Fasteners" />
              </Field>
              <Field label="Brand">
                <TextInput value={form.brand} onChange={(e) => set('brand', e.target.value)} placeholder="Optional" />
              </Field>
              <Field label="HSN / SAC Code">
                <TextInput value={form.hsn} onChange={(e) => set('hsn', e.target.value)} placeholder="7318" />
              </Field>
              <Field label="UOM (primary unit)">
                <SelectInput value={form.uom} onChange={(v) => set('uom', v)} options={UOMS.map((u) => ({ value: u, label: u }))} />
              </Field>
              <Field label="Status">
                <SelectInput
                  value={form.status}
                  onChange={(v) => set('status', v)}
                  options={[
                    { value: 'ACTIVE', label: 'Active' },
                    { value: 'INACTIVE', label: 'Inactive' },
                  ]}
                />
              </Field>
              <div className="space-y-2 rounded-lg border bg-muted/30 p-3 sm:col-span-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Secondary unit (optional)</p>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Secondary unit">
                    <TextInput
                      list="item-alt-uoms"
                      value={form.altUom}
                      onChange={(e) => set('altUom', e.target.value.toUpperCase())}
                      placeholder="e.g. BOX"
                    />
                    <datalist id="item-alt-uoms">
                      {UOMS.filter((u) => u !== form.uom).map((u) => <option key={u} value={u} />)}
                    </datalist>
                  </Field>
                  <Field label={`Conversion (${form.uom} per ${form.altUom.trim() || 'unit'})`}>
                    <TextInput
                      type="number"
                      inputMode="decimal"
                      min={0}
                      step="any"
                      value={form.altFactor}
                      onChange={(e) => set('altFactor', e.target.value)}
                      placeholder="e.g. 24"
                    />
                  </Field>
                </div>
                {form.altUom.trim() && form.altUom.trim().toUpperCase() === form.uom ? (
                  <p className="text-xs text-amber-600">Secondary unit must differ from the UOM.</p>
                ) : form.altUom.trim() && Number(form.altFactor) > 0 ? (
                  <p className="text-xs text-muted-foreground">1 {form.altUom.trim().toUpperCase()} = {Number(form.altFactor)} {form.uom}</p>
                ) : null}
              </div>
              <Field label="Part No">
                <TextInput value={form.partNo} onChange={(e) => set('partNo', e.target.value)} placeholder="Manufacturer / drawing no." />
              </Field>
              <Field label="Barcode">
                <div className="flex gap-2">
                  <TextInput value={form.barcode} onChange={(e) => set('barcode', e.target.value)} placeholder="EAN / internal code" />
                  <Button type="button" variant="outline" size="sm" className="h-9 shrink-0" onClick={fillBarcode} disabled={!!form.barcode.trim()} title="Generate a unique numeric barcode">
                    Generate
                  </Button>
                </div>
              </Field>
              <Field label="Description" className="sm:col-span-2">
                <Textarea
                  value={form.description}
                  onChange={(e) => set('description', e.target.value)}
                  rows={2}
                  placeholder="Optional notes about this item"
                />
              </Field>
            </div>
          </TabsContent>

          {/* ---- Pricing: rates and taxes ---- */}
          <TabsContent value="pricing" className="mt-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Purchase Price">
                <NumberInput value={form.purchasePrice} onChange={(n) => set('purchasePrice', n)} />
              </Field>
              <Field label="Selling Price">
                <NumberInput value={form.sellingPrice} onChange={(n) => set('sellingPrice', n)} />
              </Field>
              <Field label="MRP">
                <TextInput
                  type="number"
                  inputMode="decimal"
                  min={0}
                  step="any"
                  value={form.mrp}
                  onChange={(e) => set('mrp', e.target.value)}
                  placeholder="Optional"
                />
              </Field>
              <Field label="Selling price includes GST">
                <SelectInput value={form.priceIncludesTax} onChange={(v) => set('priceIncludesTax', v)} options={YES_NO} />
              </Field>
              <Field label="GST Rate %">
                <NumberInput value={form.gstRate} onChange={(n) => set('gstRate', n)} />
              </Field>
              <Field label="Cess %">
                <NumberInput value={form.cessRate} min={0} step="any" onChange={(n) => set('cessRate', n)} />
              </Field>
              <Field label="Standard Cost">
                <NumberInput value={form.standardCost} onChange={(n) => set('standardCost', n)} />
              </Field>
              {form.priceIncludesTax === 'YES' && form.sellingPrice > 0 && (
                <p className="self-end pb-2 text-xs text-muted-foreground">
                  Taxable rate = {fmtMoney(Math.round((form.sellingPrice / (1 + (form.gstRate || 0) / 100)) * 100) / 100)}
                </p>
              )}
              {form.mrp.trim() !== '' && Number(form.mrp) > 0 && form.sellingPrice > Number(form.mrp) && (
                <p className="text-xs text-amber-600 sm:col-span-2">Selling price is above the MRP.</p>
              )}
            </div>
          </TabsContent>

          {/* ---- Stock: levels, location, tracking, opening stock ---- */}
          <TabsContent value="stock" className="mt-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Min Stock">
                <NumberInput value={form.minStock} onChange={(n) => set('minStock', n)} />
              </Field>
              <Field label="Reorder Level">
                <NumberInput value={form.reorderLevel} onChange={(n) => set('reorderLevel', n)} />
              </Field>
              <Field label="Max Stock">
                <TextInput
                  type="number"
                  inputMode="decimal"
                  value={form.maxStock}
                  onChange={(e) => set('maxStock', e.target.value)}
                  placeholder="No limit"
                />
              </Field>
              <Field label="Rack / storage location">
                <TextInput value={form.rack} onChange={(e) => set('rack', e.target.value)} placeholder="e.g. A-02-3" />
              </Field>
              <Field label="Track batch & expiry">
                <SelectInput value={form.batchTracked} onChange={(v) => set('batchTracked', v)} options={YES_NO} />
              </Field>
              <Field label="Track serial / IMEI numbers">
                <SelectInput value={form.trackSerial} onChange={(v) => set('trackSerial', v)} options={YES_NO} />
              </Field>
              <Field label="Lead Time (days)">
                <TextInput
                  type="number"
                  inputMode="numeric"
                  min={0}
                  step={1}
                  value={form.leadTimeDays}
                  onChange={(e) => set('leadTimeDays', e.target.value)}
                  placeholder="e.g. 7"
                />
              </Field>

              {!editing && (
                <div className="space-y-3 rounded-lg border bg-muted/30 p-3 sm:col-span-2">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Opening stock (optional)</p>
                  <div className="grid gap-4 sm:grid-cols-3">
                    <Field label="Opening Qty">
                      <NumberInput value={form.openingQty} onChange={(n) => set('openingQty', n)} />
                    </Field>
                    <Field label="Opening Rate">
                      <NumberInput value={form.openingRate} onChange={(n) => set('openingRate', n)} />
                    </Field>
                    <Field label="Warehouse">
                      <SelectInput
                        value={form.openingWarehouseId}
                        onChange={(v) => set('openingWarehouseId', v)}
                        options={(warehouses.data?.items ?? []).map((w) => ({ value: w.id, label: `${w.code} · ${w.name}` }))}
                        placeholder={warehouses.loading ? 'Loading…' : 'Select warehouse'}
                        disabled={warehouses.loading}
                      />
                    </Field>
                  </div>
                  {form.openingQty > 0 && !form.openingWarehouseId && (
                    <p className="text-xs text-amber-600">Select a warehouse to post the opening stock.</p>
                  )}
                </div>
              )}
            </div>
          </TabsContent>
        </Tabs>
      </FormDialog>

      <FormDialog
        open={!!variantParent}
        onOpenChange={(o) => { if (!o) setVariantParent(null) }}
        title="Create variants"
        description={variantParent ? `${variantParent.code} — ${variantParent.name}: one item per combination; existing combinations are skipped` : ''}
        onSubmit={createVariants}
        loading={variantSaving}
        submitLabel={comboCount ? `Create ${comboCount}` : 'Create'}
        wide
      >
        <div className="space-y-2">
          {variantAttrs.map((a, idx) => (
            <div key={a.key} className="flex flex-col gap-2 sm:flex-row sm:items-end">
              <Field label={idx === 0 ? 'Attribute' : ''} className="sm:w-40">
                <TextInput value={a.name} onChange={(e) => setAttr(a.key, { name: e.target.value })} placeholder="Size" />
              </Field>
              <Field label={idx === 0 ? 'Values (comma separated)' : ''} className="flex-1">
                <TextInput value={a.values} onChange={(e) => setAttr(a.key, { values: e.target.value })} placeholder="S, M, L, XL" />
              </Field>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-9 w-9 shrink-0 text-red-600 hover:text-red-700"
                onClick={() => setVariantAttrs((as) => as.filter((x) => x.key !== a.key))}
                aria-label="Remove attribute"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          ))}
          {variantAttrs.length < 3 && (
            <Button type="button" variant="outline" size="sm" onClick={() => setVariantAttrs((as) => [...as, { key: ++attrKeySeq, name: '', values: '' }])}>
              <Plus className="h-3.5 w-3.5 mr-1" />Add attribute
            </Button>
          )}
        </div>
        <div className="rounded-md border">
          <p className="border-b px-2.5 py-1.5 text-xs font-semibold text-muted-foreground">
            Preview · {comboCount} combination{comboCount === 1 ? '' : 's'}{comboCount > 200 ? ' (max 200)' : ''}
          </p>
          {comboCount === 0 ? (
            <p className="px-2.5 py-3 text-sm text-muted-foreground">Enter values like &quot;S, M, L&quot; to see the variants.</p>
          ) : (
            <div className="max-h-56 divide-y overflow-y-auto">
              {variantCombos.slice(0, 200).map((c) => (
                <div key={c.join('|')} className="flex items-center justify-between gap-3 px-2.5 py-1.5 text-sm">
                  <span className="truncate">{variantParent?.name} - {c.join(' / ')}</span>
                  <span className="shrink-0 font-mono text-xs text-muted-foreground">
                    {[variantParent?.code, ...c.map((v) => v.toUpperCase().replace(/[^A-Z0-9]+/g, ''))].filter(Boolean).join('-')}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </FormDialog>

      <FormDialog
        open={!!labelItems}
        onOpenChange={(o) => { if (!o) setLabelItems(null) }}
        title="Print barcode labels"
        description={labelItems ? `${labelItems.length} item(s) · A4 sheet of labels — barcode from the item's Barcode, else its Code` : ''}
        onSubmit={printLabels}
        submitLabel="Print"
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Label size">
            <SelectInput
              value={labelSize}
              onChange={setLabelSize}
              options={Object.entries(LABEL_SIZES).map(([value, s]) => ({ value, label: s.label }))}
            />
          </Field>
          {(labelItems?.length ?? 0) > 1 && (
            <Field label="Same qty for all">
              <NumberInput
                min={0}
                step={1}
                value={labelAll}
                onChange={(n) => {
                  const q = Math.max(0, Math.floor(n))
                  setLabelAll(q)
                  setLabelQty(Object.fromEntries((labelItems ?? []).map((i) => [i.id, q])))
                }}
              />
            </Field>
          )}
        </div>
        <div className="max-h-72 divide-y overflow-y-auto rounded-md border">
          {(labelItems ?? []).map((it) => (
            <div key={it.id} className="flex items-center gap-3 px-2.5 py-1.5 text-sm">
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{it.name}</p>
                <p className="truncate font-mono text-xs text-muted-foreground">{it.barcode || it.code}{(it.sellingPrice ?? 0) > 0 ? ` · ${fmtMoney(it.sellingPrice)}` : ''}</p>
              </div>
              <NumberInput
                className="w-20"
                min={0}
                step={1}
                aria-label={`Labels for ${it.code}`}
                value={labelQty[it.id] ?? 1}
                onChange={(n) => setLabelQty((q) => ({ ...q, [it.id]: Math.max(0, Math.floor(n)) }))}
              />
            </div>
          ))}
        </div>
      </FormDialog>

      <ImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        companyId={companyId}
        apiPath="/api/items/import"
        entityLabel="items"
        templateHeaders={['code', 'name', 'type', 'uom', 'standardCost', 'sellPrice', 'reorderLevel', 'openingStock', 'mrp', 'rack', 'altUom', 'altFactor', 'cessRate', 'barcode', 'brand']}
        templateSample={[
          ['RM-STEEL-1', 'Steel Rod 10mm', 'RAW', 'KG', '120', '185', '50', '100', '', 'A-01', '', '', '0', '', 'Tata'],
          ['FG-MOTOR-2', 'Motor Assembly 5HP', 'FINISHED', 'NOS', '9500', '12500', '10', '5', '14000', 'B-03', 'BOX', '4', '0', '8901234567890', ''],
        ]}
        onImported={() => void refetch()}
      />
    </div>
  )
}
