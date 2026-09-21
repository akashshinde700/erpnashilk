'use client'

import * as React from 'react'
import { Pencil, Plus, Trash2, Upload } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
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
} from '@/components/erp/kit'
import type { Column } from '@/components/erp/kit'

// ---------- API shapes ----------

interface CustomerRow {
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
  creditLimit?: number
  status: string
}

interface CustomersResponse {
  items: CustomerRow[]
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
  creditLimit: number
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
  creditLimit: 0,
  status: 'ACTIVE',
}

export default function CustomersModule({ companyId }: { companyId: string }) {
  const { data, loading, refetch } = useList<CustomersResponse>(`/api/customers?companyId=${companyId}`)
  const rows = data?.items ?? []

  const [open, setOpen] = React.useState(false)
  const [importOpen, setImportOpen] = React.useState(false)
  const [editing, setEditing] = React.useState<CustomerRow | null>(null)
  const [saving, setSaving] = React.useState(false)
  const [form, setForm] = React.useState<FormState>(emptyForm)

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }))

  function openCreate() {
    setEditing(null)
    setForm(emptyForm)
    setOpen(true)
  }

  function openEdit(row: CustomerRow) {
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
      creditLimit: row.creditLimit ?? 0,
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
        creditLimit: form.creditLimit,
        status: form.status,
      }
      if (editing) await apiPatch(`/api/customers/${editing.id}`, body)
      else await apiPost('/api/customers', body)
      toast.success('Saved')
      setOpen(false)
      await refetch()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save customer')
    } finally {
      setSaving(false)
    }
  }

  async function remove(row: CustomerRow) {
    try {
      await apiDelete(`/api/customers/${row.id}?companyId=${companyId}`)
      toast.success('Deleted')
      await refetch()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to delete customer')
    }
  }

  const columns: Column<CustomerRow>[] = [
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
    { key: 'credit', header: 'Credit Limit', render: (r) => <Money value={r.creditLimit} /> },
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
            title="Delete customer"
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
        title="Customers"
        description="Customer master with GST and credit terms"
        actions={
          <>
            <Button size="sm" variant="outline" onClick={() => setImportOpen(true)}>
              <Upload className="h-4 w-4 mr-1.5" /> Import CSV
            </Button>
            <Button size="sm" onClick={openCreate}>
              <Plus className="h-4 w-4 mr-1.5" /> New Customer
            </Button>
          </>
        }
      />

      <DataTable
        columns={columns}
        rows={rows}
        loading={loading}
        searchPlaceholder="Search customers…"
        emptyText="No customers yet"
        csvExport={{
          filename: 'customers',
          pick: (r) => [r.code, r.name, r.gstin || '', r.contactPerson || '', r.phone || '', r.email || '', r.city || '', r.state || '', r.paymentTermsDays ?? 0, r.creditLimit ?? 0, r.status],
        }}
      />

      <FormDialog
        open={open}
        onOpenChange={setOpen}
        title={editing ? 'Edit Customer' : 'New Customer'}
        description={editing ? `Updating ${editing.code}` : 'Add a new customer to the master'}
        onSubmit={submit}
        loading={saving}
        submitLabel={editing ? 'Update' : 'Create'}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Code" required>
            <TextInput value={form.code} onChange={(e) => set('code', e.target.value)} placeholder="CUST-001" />
          </Field>
          <Field label="Name" required>
            <TextInput value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="Acme Industries" />
          </Field>
          <Field label="GSTIN">
            <TextInput value={form.gstin} onChange={(e) => set('gstin', e.target.value)} placeholder="27ABCDE1234F1Z5" />
          </Field>
          <Field label="Contact Person">
            <TextInput value={form.contactPerson} onChange={(e) => set('contactPerson', e.target.value)} />
          </Field>
          <Field label="Phone">
            <TextInput value={form.phone} onChange={(e) => set('phone', e.target.value)} placeholder="9876543210" />
          </Field>
          <Field label="Email">
            <TextInput type="email" value={form.email} onChange={(e) => set('email', e.target.value)} placeholder="buyer@company.com" />
          </Field>
          <Field label="Address" className="sm:col-span-2">
            <TextInput value={form.addressLine} onChange={(e) => set('addressLine', e.target.value)} placeholder="Street, area" />
          </Field>
          <Field label="City">
            <TextInput value={form.city} onChange={(e) => set('city', e.target.value)} placeholder="Pune" />
          </Field>
          <Field label="State">
            <TextInput value={form.state} onChange={(e) => set('state', e.target.value)} placeholder="Maharashtra" />
          </Field>
          <Field label="State Code">
            <TextInput value={form.stateCode} onChange={(e) => set('stateCode', e.target.value)} placeholder="27" />
          </Field>
          <Field label="Payment Terms (days)">
            <NumberInput value={form.paymentTermsDays} onChange={(n) => set('paymentTermsDays', n)} />
          </Field>
          <Field label="Credit Limit">
            <NumberInput value={form.creditLimit} onChange={(n) => set('creditLimit', n)} />
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

      <ImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        companyId={companyId}
        apiPath="/api/customers/import"
        entityLabel="customers"
        templateHeaders={['name', 'gstin', 'city', 'state', 'stateCode', 'phone', 'email', 'addressLine']}
        templateSample={[
          ['Precision Tools Pvt Ltd', '27ABCDE1234F1Z5', 'Pune', 'Maharashtra', '27', '9876543210', 'sales@precisiontools.in', 'Plot 14, MIDC Bhosari'],
          ['Vadodara Bearings', '', 'Vadodara', 'Gujarat', '24', '', 'orders@vdbearings.com', 'GIDC Makarpura'],
        ]}
        onImported={() => void refetch()}
      />
    </div>
  )
}
