'use client'

import * as React from 'react'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { apiDelete, apiPatch, apiPost, useList } from '@/lib/use-api'
import {
  ConfirmAction,
  DataTable,
  Field,
  FormDialog,
  PageHeader,
  SelectInput,
  StatusBadge,
  TextInput,
} from '@/components/erp/kit'
import type { Column } from '@/components/erp/kit'

// ---------- API shapes ----------

interface WarehouseRow {
  id: string
  code: string
  name: string
  type: string
  location?: string | null
  address?: string | null
  inCharge?: string | null
}

interface WarehousesResponse {
  items: WarehouseRow[]
  total?: number
}

interface FormState {
  code: string
  name: string
  type: string
  location: string
  address: string
  inCharge: string
}

const emptyForm: FormState = { code: '', name: '', type: 'GENERAL', location: '', address: '', inCharge: '' }

const WAREHOUSE_TYPES = [
  { value: 'RM', label: 'RM — Raw Material' },
  { value: 'FG', label: 'FG — Finished Goods' },
  { value: 'GENERAL', label: 'General' },
  { value: 'SCRAP', label: 'Scrap' },
]

export default function WarehousesModule({ companyId }: { companyId: string }) {
  const { data, loading, refetch } = useList<WarehousesResponse>(`/api/warehouses?companyId=${companyId}`)
  const rows = data?.items ?? []

  const [open, setOpen] = React.useState(false)
  const [editing, setEditing] = React.useState<WarehouseRow | null>(null)
  const [saving, setSaving] = React.useState(false)
  const [form, setForm] = React.useState<FormState>(emptyForm)

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }))

  function openCreate() {
    setEditing(null)
    setForm(emptyForm)
    setOpen(true)
  }

  function openEdit(row: WarehouseRow) {
    setEditing(row)
    setForm({
      code: row.code,
      name: row.name,
      type: row.type,
      location: row.location ?? '',
      address: row.address ?? '',
      inCharge: row.inCharge ?? '',
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
      const body = {
        companyId,
        code: form.code.trim(),
        name: form.name.trim(),
        type: form.type,
        location: form.location.trim() || null,
        address: form.address.trim() || null,
        inCharge: form.inCharge.trim() || null,
      }
      if (editing) await apiPatch(`/api/warehouses/${editing.id}`, body)
      else await apiPost('/api/warehouses', body)
      toast.success('Saved')
      setOpen(false)
      await refetch()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save warehouse')
    } finally {
      setSaving(false)
    }
  }

  async function remove(row: WarehouseRow) {
    try {
      await apiDelete(`/api/warehouses/${row.id}?companyId=${companyId}`)
      toast.success('Deleted')
      await refetch()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to delete warehouse')
    }
  }

  const columns: Column<WarehouseRow>[] = [
    { key: 'code', header: 'Code', render: (r) => <span className="font-medium">{r.code}</span> },
    { key: 'name', header: 'Name', render: (r) => <span className="block max-w-52 truncate">{r.name}</span> },
    { key: 'type', header: 'Type', render: (r) => <StatusBadge status={r.type} /> },
    {
      key: 'location',
      header: 'Location',
      hideOnMobile: true,
      render: (r) => <span className="text-muted-foreground">{r.location || '—'}</span>,
    },
    {
      key: 'inCharge',
      header: 'In-charge',
      hideOnMobile: true,
      render: (r) => <span className="text-muted-foreground">{r.inCharge || '—'}</span>,
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
            title="Delete warehouse"
            message={`Delete ${r.code} — ${r.name}? Stock linked to it may block deletion.`}
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
        title="Warehouses"
        description="Storage locations for raw material, finished goods and scrap"
        actions={
          <Button size="sm" onClick={openCreate}>
            <Plus className="h-4 w-4 mr-1.5" /> Warehouse
          </Button>
        }
      />

      <DataTable
        columns={columns}
        rows={rows}
        loading={loading}
        searchPlaceholder="Search warehouses…"
        emptyText="No warehouses yet"
      />

      <FormDialog
        open={open}
        onOpenChange={setOpen}
        title={editing ? 'Edit Warehouse' : 'Warehouse'}
        description={editing ? `Updating ${editing.code}` : 'Add a new storage location'}
        onSubmit={submit}
        loading={saving}
        submitLabel={editing ? 'Update' : 'Create'}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Code" required>
            <TextInput value={form.code} onChange={(e) => set('code', e.target.value)} placeholder="WH-RM-01" />
          </Field>
          <Field label="Name" required>
            <TextInput value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="Main RM Store" />
          </Field>
          <Field label="Type">
            <SelectInput value={form.type} onChange={(v) => set('type', v)} options={WAREHOUSE_TYPES} />
          </Field>
          <Field label="Location">
            <TextInput value={form.location} onChange={(e) => set('location', e.target.value)} placeholder="Plant 1, Bay A" />
          </Field>
          <Field label="In-charge">
            <TextInput value={form.inCharge} onChange={(e) => set('inCharge', e.target.value)} placeholder="Store keeper name" />
          </Field>
          <div className="hidden sm:block" />
          <Field label="Address" className="sm:col-span-2">
            <Textarea
              value={form.address}
              onChange={(e) => set('address', e.target.value)}
              rows={2}
              placeholder="Full address (for delivery challans / transfers)"
            />
          </Field>
        </div>
      </FormDialog>
    </div>
  )
}
