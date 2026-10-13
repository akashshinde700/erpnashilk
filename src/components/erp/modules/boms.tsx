'use client'

import * as React from 'react'
import { Eye, Pencil, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { fmtNum } from '@/lib/erp-constants'
import { apiDelete, apiPatch, apiPost, useList } from '@/lib/use-api'
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
} from '@/components/erp/kit'
import type { Column } from '@/components/erp/kit'

// ---------- API shapes ----------

interface ItemLite {
  id: string
  code: string
  name: string
  type: string
  uom: string
  purchasePrice?: number
}

interface ItemsResponse {
  items: ItemLite[]
  total?: number
}

interface BomComponent {
  id: string
  itemId: string
  qty: number
  scrapPct?: number
  item?: { code?: string; name?: string; uom?: string; purchasePrice?: number } | null
}

interface BomRow {
  id: string
  code: string
  outputItemId: string
  outputQty: number
  version?: string
  scrapPct?: number
  status: string
  notes?: string | null
  outputItem?: { code?: string; name?: string; uom?: string } | null
  items?: BomComponent[] | null
}

interface BomsResponse {
  items: BomRow[]
  total?: number
}

interface BomForm {
  code: string
  outputItemId: string
  outputQty: number
  version: string
  scrapPct: number
  status: string
  notes: string
}

interface CompLine {
  key: string
  itemId: string
  qty: number
  scrapPct: number
}

const emptyForm: BomForm = {
  code: '',
  outputItemId: '',
  outputQty: 1,
  version: 'V1',
  scrapPct: 0,
  status: 'ACTIVE',
  notes: '',
}

const newLine = (): CompLine => ({ key: Math.random().toString(36).slice(2, 10), itemId: '', qty: 1, scrapPct: 0 })

const BOM_STATUSES = [
  { value: 'DRAFT', label: 'Draft' },
  { value: 'ACTIVE', label: 'Active' },
  { value: 'RETIRED', label: 'Retired' },
]

export default function BomsModule({ companyId }: { companyId: string }) {
  const { data, loading, refetch } = useList<BomsResponse>(`/api/boms?companyId=${companyId}`)
  const rows = data?.items ?? []

  const [viewing, setViewing] = React.useState<BomRow | null>(null)
  const [formOpen, setFormOpen] = React.useState(false)
  const [editing, setEditing] = React.useState<BomRow | null>(null)
  const [saving, setSaving] = React.useState(false)
  const [form, setForm] = React.useState<BomForm>(emptyForm)
  const [lines, setLines] = React.useState<CompLine[]>([])

  // Items for the output / component selects — loaded while the form dialog is open
  const items = useList<ItemsResponse>(formOpen ? `/api/items?companyId=${companyId}` : null)
  const allItems = items.data?.items ?? []
  const outputOptions = allItems
    .filter((i) => i.type === 'FINISHED' || i.type === 'SEMI')
    .map((i) => ({ value: i.id, label: `${i.code} — ${i.name}` }))
  const componentOptions = allItems.map((i) => ({ value: i.id, label: `${i.code} — ${i.name}` }))

  const set = <K extends keyof BomForm>(key: K, value: BomForm[K]) =>
    setForm((f) => ({ ...f, [key]: value }))

  function openCreate() {
    setEditing(null)
    setForm(emptyForm)
    setLines([newLine()])
    setFormOpen(true)
  }

  function openEdit(row: BomRow) {
    setEditing(row)
    setForm({
      code: row.code,
      outputItemId: row.outputItemId,
      outputQty: row.outputQty ?? 1,
      version: row.version ?? 'V1',
      scrapPct: row.scrapPct ?? 0,
      status: row.status,
      notes: row.notes ?? '',
    })
    setLines((row.items ?? []).map((c) => ({ key: Math.random().toString(36).slice(2, 10), itemId: c.itemId, qty: c.qty, scrapPct: c.scrapPct ?? 0 })))
    setFormOpen(true)
  }

  function updateLine(key: string, patch: Partial<CompLine>) {
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)))
  }

  async function submit() {
    if (!form.code.trim() || !form.outputItemId) {
      toast.error('Code and output item are required')
      return
    }
    if (lines.length === 0) {
      toast.error('Add at least one component line')
      return
    }
    if (lines.some((l) => !l.itemId || l.qty <= 0)) {
      toast.error('Every component needs an item and a quantity above zero')
      return
    }
    setSaving(true)
    try {
      const body = {
        companyId,
        code: form.code.trim(),
        outputItemId: form.outputItemId,
        outputQty: form.outputQty,
        version: form.version.trim() || 'V1',
        scrapPct: form.scrapPct,
        status: form.status,
        notes: form.notes.trim() || null,
        items: lines.map((l) => ({ itemId: l.itemId, qty: l.qty, scrapPct: l.scrapPct })),
      }
      if (editing) await apiPatch(`/api/boms/${editing.id}`, body)
      else await apiPost('/api/boms', body)
      toast.success('Saved')
      setFormOpen(false)
      await refetch()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save BOM')
    } finally {
      setSaving(false)
    }
  }

  async function remove(row: BomRow) {
    try {
      await apiDelete(`/api/boms/${row.id}?companyId=${companyId}`)
      toast.success('Deleted')
      await refetch()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to delete BOM')
    }
  }

  const columns: Column<BomRow>[] = [
    { key: 'code', header: 'Code', render: (r) => <span className="font-medium">{r.code}</span> },
    {
      key: 'output',
      header: 'Output Item',
      render: (r) => (
        <div className="min-w-0">
          <p className="max-w-44 truncate">{r.outputItem?.name ?? '—'}</p>
          <p className="text-xs text-muted-foreground">{r.outputItem?.code ?? ''}</p>
        </div>
      ),
    },
    { key: 'version', header: 'Version', render: (r) => <span>{r.version ?? 'V1'}</span> },
    { key: 'qty', header: 'Output Qty', render: (r) => <span className="tabular-nums">{fmtNum(r.outputQty)}</span> },
    { key: 'scrap', header: 'Scrap %', render: (r) => <span className="tabular-nums">{r.scrapPct ?? 0}%</span> },
    {
      key: 'components',
      header: 'Components',
      render: (r) => <span className="tabular-nums">{(r.items ?? []).length}</span>,
    },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
    {
      key: 'actions',
      header: '',
      className: 'text-right',
      render: (r) => (
        <div className="flex items-center justify-end gap-1">
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setViewing(r)} title="View">
            <Eye className="h-3.5 w-3.5" />
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
            title="Delete BOM"
            message={`Delete ${r.code}? This cannot be undone.`}
            tone="destructive"
            onConfirm={() => remove(r)}
          />
        </div>
      ),
    },
  ]

  // Estimated cost of the BOM being viewed (only where component purchase price is available)
  const viewItems = viewing?.items ?? []
  const hasAnyPrice = viewItems.some((c) => c.item?.purchasePrice != null)
  const totalCost = viewItems.reduce((sum, c) => {
    const price = c.item?.purchasePrice
    return price != null ? sum + c.qty * price : sum
  }, 0)

  return (
    <div>
      <PageHeader
        title="Bills of Material"
        description="Recipe of components used to produce finished and semi-finished items"
        actions={
          <Button size="sm" onClick={openCreate}>
            <Plus className="h-4 w-4 mr-1.5" /> BOM
          </Button>
        }
      />

      <DataTable columns={columns} rows={rows} loading={loading} searchPlaceholder="Search BOMs…" emptyText="No BOMs yet" />

      {/* View dialog */}
      <Dialog open={!!viewing} onOpenChange={(o) => { if (!o) setViewing(null) }}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>BOM {viewing?.code ?? ''}</DialogTitle>
            <DialogDescription>
              {viewing?.outputItem?.name ? `${viewing.outputItem.name} (${viewing.outputItem.code ?? ''}) · ` : ''}
              Version {viewing?.version ?? 'V1'} · Output {fmtNum(viewing?.outputQty)} · Scrap {viewing?.scrapPct ?? 0}%
            </DialogDescription>
          </DialogHeader>
          <div className="overflow-hidden rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/50 hover:bg-muted/50">
                  <TableHead>Item</TableHead>
                  <TableHead className="text-right">Qty</TableHead>
                  <TableHead className="text-right">Scrap %</TableHead>
                  <TableHead className="text-right">Est. Cost</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {viewItems.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={4} className="h-20 text-center text-muted-foreground">
                      No components defined
                    </TableCell>
                  </TableRow>
                ) : (
                  viewItems.map((c) => {
                    const price = c.item?.purchasePrice
                    const cost = price != null ? c.qty * price : null
                    return (
                      <TableRow key={c.id}>
                        <TableCell>
                          <span className="font-medium">{c.item?.code ?? '—'}</span>
                          <span className="block text-xs text-muted-foreground">{c.item?.name ?? ''}</span>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {fmtNum(c.qty)}
                          {c.item?.uom ? ` ${c.item.uom}` : ''}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{c.scrapPct ?? 0}%</TableCell>
                        <TableCell className="text-right">
                          {cost != null ? <Money value={cost} /> : <span className="text-muted-foreground">—</span>}
                        </TableCell>
                      </TableRow>
                    )
                  })
                )}
                {viewItems.length > 0 && hasAnyPrice && (
                  <TableRow>
                    <TableCell colSpan={3} className="text-right font-medium">
                      Total estimated cost
                    </TableCell>
                    <TableCell className="text-right font-semibold">
                      <Money value={totalCost} />
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
          {viewing?.notes && <p className="text-xs text-muted-foreground">Notes: {viewing.notes}</p>}
        </DialogContent>
      </Dialog>

      {/* Create / edit dialog */}
      <FormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        title={editing ? 'Edit BOM' : 'BOM'}
        description={editing ? `Updating ${editing.code}` : 'Define the component recipe for an item'}
        onSubmit={submit}
        loading={saving}
        submitLabel={editing ? 'Update' : 'Create'}
        wide
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Code" required>
            <TextInput value={form.code} onChange={(e) => set('code', e.target.value)} placeholder="BOM-FG-001" />
          </Field>
          <Field label="Output Item" required>
            <SelectInput
              value={form.outputItemId}
              onChange={(v) => set('outputItemId', v)}
              options={outputOptions}
              placeholder={items.loading ? 'Loading items…' : 'Select finished / semi item'}
              disabled={items.loading}
            />
          </Field>
          <Field label="Output Qty">
            <NumberInput value={form.outputQty} onChange={(n) => set('outputQty', n)} min={0.0001} step="any" />
          </Field>
          <Field label="Version">
            <TextInput value={form.version} onChange={(e) => set('version', e.target.value)} placeholder="V1" />
          </Field>
          <Field label="Scrap %">
            <NumberInput value={form.scrapPct} onChange={(n) => set('scrapPct', n)} min={0} step="any" />
          </Field>
          <Field label="Status">
            <SelectInput value={form.status} onChange={(v) => set('status', v)} options={BOM_STATUSES} />
          </Field>

          <div className="space-y-2 rounded-lg border p-3 sm:col-span-2">
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Components</p>
              <Button type="button" variant="outline" size="sm" onClick={() => setLines((ls) => [...ls, newLine()])}>
                <Plus className="h-3.5 w-3.5 mr-1" /> Add Row
              </Button>
            </div>

            {lines.length === 0 ? (
              <p className="py-2 text-sm text-muted-foreground">No components yet — click Add Row.</p>
            ) : (
              <>
                <div className="hidden gap-2 px-1 text-[11px] font-medium text-muted-foreground sm:grid sm:grid-cols-12">
                  <span className="col-span-6">Item</span>
                  <span className="col-span-2">Qty</span>
                  <span className="col-span-2">Scrap %</span>
                  <span className="col-span-2" />
                </div>
                {lines.map((l, idx) => (
                  <div key={l.key} className="grid grid-cols-12 items-center gap-2">
                    <div className="col-span-12 sm:col-span-6">
                      <SelectInput
                        value={l.itemId}
                        onChange={(v) => updateLine(l.key, { itemId: v })}
                        options={componentOptions}
                        placeholder={`Component ${idx + 1}`}
                        disabled={items.loading}
                      />
                    </div>
                    <div className="col-span-5 sm:col-span-2">
                      <NumberInput value={l.qty} onChange={(n) => updateLine(l.key, { qty: n })} min={0.0001} step="any" />
                    </div>
                    <div className="col-span-4 sm:col-span-2">
                      <NumberInput value={l.scrapPct} onChange={(n) => updateLine(l.key, { scrapPct: n })} min={0} step="any" />
                    </div>
                    <div className="col-span-3 flex justify-end sm:col-span-2">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-9 w-9 text-red-600 hover:text-red-700"
                        onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
                        title="Remove"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                ))}
              </>
            )}
          </div>

          <Field label="Notes" className="sm:col-span-2">
            <Textarea value={form.notes} onChange={(e) => set('notes', e.target.value)} rows={2} placeholder="Optional remarks" />
          </Field>
        </div>
      </FormDialog>
    </div>
  )
}
