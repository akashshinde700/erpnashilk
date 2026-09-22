'use client'

import * as React from 'react'
import { Pencil, Plus, Trash2, Upload } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { ITEM_TYPES, ITEM_TYPE_LABEL, UOMS } from '@/lib/erp-constants'
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
  useRowHighlight,
} from '@/components/erp/kit'
import type { Column } from '@/components/erp/kit'

// ---------- API shapes ----------

interface ItemRow {
  id: string
  code: string
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
  description?: string | null
  status: string
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
  description: string
  status: string
  openingQty: number
  openingRate: number
  openingWarehouseId: string
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
  description: '',
  status: 'ACTIVE',
  openingQty: 0,
  openingRate: 0,
  openingWarehouseId: '',
}

export default function ItemsModule({ companyId }: { companyId: string }) {
  const highlightId = useRowHighlight('items')
  const { data, loading, refetch } = useList<ItemsResponse>(`/api/items?companyId=${companyId}`)
  const rows = data?.items ?? []

  const [open, setOpen] = React.useState(false)
  const [importOpen, setImportOpen] = React.useState(false)
  const [editing, setEditing] = React.useState<ItemRow | null>(null)
  const [saving, setSaving] = React.useState(false)
  const [form, setForm] = React.useState<FormState>(emptyForm)

  // Load warehouses only while creating (for the optional opening stock section)
  const warehouses = useList<{ items: WarehouseLite[] }>(
    open && !editing ? `/api/warehouses?companyId=${companyId}` : null,
  )

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }))

  function openCreate() {
    setEditing(null)
    setForm(emptyForm)
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
      description: row.description ?? '',
      status: row.status,
      openingQty: 0,
      openingRate: 0,
      openingWarehouseId: '',
    })
    setOpen(true)
  }

  async function submit() {
    if (!form.code.trim() || !form.name.trim()) {
      toast.error('Code and name are required')
      return
    }
    setSaving(true)
    try {
      const body: Record<string, unknown> = {
        companyId,
        code: form.code.trim(),
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
        description: form.description.trim() || null,
        status: form.status,
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
    { key: 'name', header: 'Name', render: (r) => <span className="block max-w-44 truncate">{r.name}</span> },
    { key: 'type', header: 'Type', render: (r) => <StatusBadge status={ITEM_TYPE_LABEL[r.type] ?? r.type} /> },
    { key: 'uom', header: 'UOM', render: (r) => <span className="text-muted-foreground">{r.uom}</span> },
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
            <Button size="sm" variant="outline" onClick={() => setImportOpen(true)}>
              <Upload className="h-4 w-4 mr-1.5" /> Import CSV
            </Button>
            <Button size="sm" onClick={openCreate}>
              <Plus className="h-4 w-4 mr-1.5" /> New Item
            </Button>
          </>
        }
      />

      <DataTable
        columns={columns}
        rows={rows}
        loading={loading}
        highlightId={highlightId}
        searchPlaceholder="Search items…"
        emptyText="No items yet"
        csvExport={{
          filename: 'items',
          pick: (r) => [r.code, r.name, r.type, r.uom, r.hsn || '', r.gstRate ?? 0, r.purchasePrice ?? 0, r.sellingPrice ?? 0, r.standardCost ?? 0, r.reorderLevel ?? 0, r.status],
        }}
        xlsxExport={{
          filename: 'items',
          pick: (r) => [r.code, r.name, r.type, r.uom, r.hsn || '', r.gstRate ?? 0, r.purchasePrice ?? 0, r.sellingPrice ?? 0, r.standardCost ?? 0, r.reorderLevel ?? 0, r.status],
        }}
      />

      <FormDialog
        open={open}
        onOpenChange={setOpen}
        title={editing ? 'Edit Item' : 'New Item'}
        description={editing ? `Updating ${editing.code}` : 'Add a new item to the master'}
        onSubmit={submit}
        loading={saving}
        submitLabel={editing ? 'Update' : 'Create'}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Code" required>
            <TextInput value={form.code} onChange={(e) => set('code', e.target.value)} placeholder="RM-001" />
          </Field>
          <Field label="Name" required>
            <TextInput value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="Hex Bolt M8" />
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
          <Field label="UOM">
            <SelectInput value={form.uom} onChange={(v) => set('uom', v)} options={UOMS.map((u) => ({ value: u, label: u }))} />
          </Field>
          <Field label="HSN Code">
            <TextInput value={form.hsn} onChange={(e) => set('hsn', e.target.value)} placeholder="7318" />
          </Field>
          <Field label="GST Rate %">
            <NumberInput value={form.gstRate} onChange={(n) => set('gstRate', n)} />
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
          <Field label="Purchase Price">
            <NumberInput value={form.purchasePrice} onChange={(n) => set('purchasePrice', n)} />
          </Field>
          <Field label="Selling Price">
            <NumberInput value={form.sellingPrice} onChange={(n) => set('sellingPrice', n)} />
          </Field>
          <Field label="Standard Cost">
            <NumberInput value={form.standardCost} onChange={(n) => set('standardCost', n)} />
          </Field>
          <Field label="Reorder Level">
            <NumberInput value={form.reorderLevel} onChange={(n) => set('reorderLevel', n)} />
          </Field>
          <Field label="Min Stock">
            <NumberInput value={form.minStock} onChange={(n) => set('minStock', n)} />
          </Field>
          <Field label="Description" className="sm:col-span-2">
            <Textarea
              value={form.description}
              onChange={(e) => set('description', e.target.value)}
              rows={2}
              placeholder="Optional notes about this item"
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
      </FormDialog>

      <ImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        companyId={companyId}
        apiPath="/api/items/import"
        entityLabel="items"
        templateHeaders={['code', 'name', 'type', 'uom', 'standardCost', 'sellPrice', 'reorderLevel', 'openingStock']}
        templateSample={[
          ['RM-STEEL-1', 'Steel Rod 10mm', 'RAW', 'KG', '120', '185', '50', '100'],
          ['FG-MOTOR-2', 'Motor Assembly 5HP', 'FINISHED', 'NOS', '9500', '12500', '10', '5'],
        ]}
        onImported={() => void refetch()}
      />
    </div>
  )
}
