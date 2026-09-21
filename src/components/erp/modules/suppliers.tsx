'use client'

import * as React from 'react'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { apiDelete, apiPatch, apiPost, useList } from '@/lib/use-api'
import {
  ConfirmAction,
  DataTable,
  Field,
  FormDialog,
  NumberInput,
  PageHeader,
  SelectInput,
  StatusBadge,
  TextInput,
} from '@/components/erp/kit'
import type { Column } from '@/components/erp/kit'

// ---------- API shapes ----------

interface SupplierRow {
  id: string
  code: string
  name: string
  gstin?: string | null
  contactPerson?: string | null
  phone?: string | null
  email?: string | null
  addressLine?: string | null
  city?: string | null
  state?: string | null
  stateCode?: string | null
  paymentTermsDays?: number
  status: string
}

interface SuppliersResponse {
  items: SupplierRow[]
  total?: number
}

interface FormState {
  code: string
  name: string
  gstin: string
  contactPerson: string
  phone: string
  email: string
  addressLine: string
  city: string
  state: string
  stateCode: string
  paymentTermsDays: number
  status: string
}

const emptyForm: FormState = {
  code: '',
  name: '',
  gstin: '',
  contactPerson: '',
  phone: '',
  email: '',
  addressLine: '',
  city: '',
  state: '',
  stateCode: '',
  paymentTermsDays: 30,
  status: 'ACTIVE',
}

export default function SuppliersModule({ companyId }: { companyId: string }) {
  const { data, loading, refetch } = useList<SuppliersResponse>(`/api/suppliers?companyId=${companyId}`)
  const rows = data?.items ?? []

  const [open, setOpen] = React.useState(false)
  const [editing, setEditing] = React.useState<SupplierRow | null>(null)
  const [saving, setSaving] = React.useState(false)
  const [form, setForm] = React.useState<FormState>(emptyForm)

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }))

  function openCreate() {
    setEditing(null)
    setForm(emptyForm)
    setOpen(true)
  }

  function openEdit(row: SupplierRow) {
    setEditing(row)
    setForm({
      code: row.code,
      name: row.name,
      gstin: row.gstin ?? '',
      contactPerson: row.contactPerson ?? '',
      phone: row.phone ?? '',
      email: row.email ?? '',
      addressLine: row.addressLine ?? '',
      city: row.city ?? '',
      state: row.state ?? '',
      stateCode: row.stateCode ?? '',
      paymentTermsDays: row.paymentTermsDays ?? 30,
      status: row.status,
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
        gstin: form.gstin.trim() || null,
        contactPerson: form.contactPerson.trim() || null,
        phone: form.phone.trim() || null,
        email: form.email.trim() || null,
        addressLine: form.addressLine.trim() || null,
        city: form.city.trim() || null,
        state: form.state.trim() || null,
        stateCode: form.stateCode.trim() || null,
        paymentTermsDays: form.paymentTermsDays,
        status: form.status,
      }
      if (editing) await apiPatch(`/api/suppliers/${editing.id}`, body)
      else await apiPost('/api/suppliers', body)
      toast.success('Saved')
      setOpen(false)
      await refetch()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save supplier')
    } finally {
      setSaving(false)
    }
  }

  async function remove(row: SupplierRow) {
    try {
      await apiDelete(`/api/suppliers/${row.id}?companyId=${companyId}`)
      toast.success('Deleted')
      await refetch()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to delete supplier')
    }
  }

  const columns: Column<SupplierRow>[] = [
    { key: 'code', header: 'Code', render: (r) => <span className="font-medium">{r.code}</span> },
    { key: 'name', header: 'Name', render: (r) => <span className="block max-w-44 truncate">{r.name}</span> },
    { key: 'city', header: 'City', render: (r) => <span>{r.city || '—'}</span> },
    { key: 'state', header: 'State', hideOnMobile: true, render: (r) => <span>{r.state || '—'}</span> },
    {
      key: 'gstin',
      header: 'GSTIN',
      hideOnMobile: true,
      render: (r) => <span className="font-mono text-xs">{r.gstin || '—'}</span>,
    },
    { key: 'phone', header: 'Phone', hideOnMobile: true, render: (r) => <span>{r.phone || '—'}</span> },
    {
      key: 'terms',
      header: 'Terms (days)',
      render: (r) => <span className="tabular-nums">{r.paymentTermsDays ?? 0}</span>,
    },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
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
            title="Delete supplier"
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
        title="Suppliers"
        description="Supplier and vendor master"
        actions={
          <Button size="sm" onClick={openCreate}>
            <Plus className="h-4 w-4 mr-1.5" /> New Supplier
          </Button>
        }
      />

      <DataTable
        columns={columns}
        rows={rows}
        loading={loading}
        searchPlaceholder="Search suppliers…"
        emptyText="No suppliers yet"
      />

      <FormDialog
        open={open}
        onOpenChange={setOpen}
        title={editing ? 'Edit Supplier' : 'New Supplier'}
        description={editing ? `Updating ${editing.code}` : 'Add a new supplier to the master'}
        onSubmit={submit}
        loading={saving}
        submitLabel={editing ? 'Update' : 'Create'}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Code" required>
            <TextInput value={form.code} onChange={(e) => set('code', e.target.value)} placeholder="SUP-001" />
          </Field>
          <Field label="Name" required>
            <TextInput value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="Steel Traders Ltd" />
          </Field>
          <Field label="GSTIN">
            <TextInput value={form.gstin} onChange={(e) => set('gstin', e.target.value)} placeholder="24AABCU9603R1ZM" />
          </Field>
          <Field label="Contact Person">
            <TextInput value={form.contactPerson} onChange={(e) => set('contactPerson', e.target.value)} />
          </Field>
          <Field label="Phone">
            <TextInput value={form.phone} onChange={(e) => set('phone', e.target.value)} placeholder="9876543210" />
          </Field>
          <Field label="Email">
            <TextInput type="email" value={form.email} onChange={(e) => set('email', e.target.value)} placeholder="sales@vendor.com" />
          </Field>
          <Field label="Address" className="sm:col-span-2">
            <TextInput value={form.addressLine} onChange={(e) => set('addressLine', e.target.value)} placeholder="Street, area" />
          </Field>
          <Field label="City">
            <TextInput value={form.city} onChange={(e) => set('city', e.target.value)} placeholder="Rajkot" />
          </Field>
          <Field label="State">
            <TextInput value={form.state} onChange={(e) => set('state', e.target.value)} placeholder="Gujarat" />
          </Field>
          <Field label="State Code">
            <TextInput value={form.stateCode} onChange={(e) => set('stateCode', e.target.value)} placeholder="24" />
          </Field>
          <Field label="Payment Terms (days)">
            <NumberInput value={form.paymentTermsDays} onChange={(n) => set('paymentTermsDays', n)} />
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
        </div>
      </FormDialog>
    </div>
  )
}
