'use client'

import * as React from 'react'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { ROLES, ROLE_LABEL } from '@/lib/erp-constants'
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

interface UserRow {
  id: string
  name: string
  email: string
  phone?: string | null
  role: string
  active: boolean
}

interface UsersResponse {
  items: UserRow[]
  total?: number
}

interface FormState {
  name: string
  email: string
  phone: string
  role: string
  active: string // 'ACTIVE' | 'INACTIVE' — mapped to boolean on submit
}

const emptyForm: FormState = { name: '', email: '', phone: '', role: 'OPERATOR', active: 'ACTIVE' }

export default function UsersModule({ companyId }: { companyId: string }) {
  const { data, loading, refetch } = useList<UsersResponse>(`/api/users?companyId=${companyId}`)
  const rows = data?.items ?? []

  const [open, setOpen] = React.useState(false)
  const [editing, setEditing] = React.useState<UserRow | null>(null)
  const [saving, setSaving] = React.useState(false)
  const [form, setForm] = React.useState<FormState>(emptyForm)

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }))

  function openCreate() {
    setEditing(null)
    setForm(emptyForm)
    setOpen(true)
  }

  function openEdit(row: UserRow) {
    setEditing(row)
    setForm({
      name: row.name,
      email: row.email,
      phone: row.phone ?? '',
      role: row.role,
      active: row.active ? 'ACTIVE' : 'INACTIVE',
    })
    setOpen(true)
  }

  async function submit() {
    if (!form.name.trim() || !form.email.trim()) {
      toast.error('Name and email are required')
      return
    }
    setSaving(true)
    try {
      const body = {
        companyId,
        name: form.name.trim(),
        email: form.email.trim(),
        phone: form.phone.trim() || null,
        role: form.role,
        active: form.active === 'ACTIVE',
      }
      if (editing) await apiPatch(`/api/users/${editing.id}`, body)
      else await apiPost('/api/users', body)
      toast.success('Saved')
      setOpen(false)
      await refetch()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save user')
    } finally {
      setSaving(false)
    }
  }

  async function remove(row: UserRow) {
    try {
      await apiDelete(`/api/users/${row.id}?companyId=${companyId}`)
      toast.success('Deleted')
      await refetch()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to delete user')
    }
  }

  const columns: Column<UserRow>[] = [
    {
      key: 'name',
      header: 'Name',
      render: (r) => (
        <div className="min-w-0">
          <p className="max-w-40 truncate font-medium">{r.name}</p>
          <p className="max-w-40 truncate text-xs text-muted-foreground">{r.email}</p>
        </div>
      ),
    },
    {
      key: 'email',
      header: 'Email',
      hideOnMobile: true,
      render: (r) => <span className="block max-w-52 truncate">{r.email}</span>,
    },
    {
      key: 'role',
      header: 'Role',
      render: (r) => <StatusBadge status={ROLE_LABEL[r.role] ?? r.role} />,
    },
    { key: 'phone', header: 'Phone', hideOnMobile: true, render: (r) => <span>{r.phone || '—'}</span> },
    { key: 'active', header: 'Active', render: (r) => <StatusBadge status={r.active ? 'ACTIVE' : 'INACTIVE'} /> },
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
            title="Delete user"
            message={`Remove ${r.name} (${r.email})? This cannot be undone.`}
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
        title="Users"
        description="Team members and their roles for this company"
        actions={
          <Button size="sm" onClick={openCreate}>
            <Plus className="h-4 w-4 mr-1.5" /> New User
          </Button>
        }
      />

      <DataTable columns={columns} rows={rows} loading={loading} searchPlaceholder="Search users…" emptyText="No users yet" />

      <FormDialog
        open={open}
        onOpenChange={setOpen}
        title={editing ? 'Edit User' : 'New User'}
        description={editing ? `Updating ${editing.email}` : 'Invite a team member to this company'}
        onSubmit={submit}
        loading={saving}
        submitLabel={editing ? 'Update' : 'Create'}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" required>
            <TextInput value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="Priya Sharma" />
          </Field>
          <Field label="Email" required>
            <TextInput type="email" value={form.email} onChange={(e) => set('email', e.target.value)} placeholder="priya@acme.com" />
          </Field>
          <Field label="Phone">
            <TextInput value={form.phone} onChange={(e) => set('phone', e.target.value)} placeholder="9876543210" />
          </Field>
          <Field label="Role">
            <SelectInput
              value={form.role}
              onChange={(v) => set('role', v)}
              options={ROLES.map((r) => ({ value: r, label: ROLE_LABEL[r] }))}
            />
          </Field>
          <Field label="Active">
            <SelectInput
              value={form.active}
              onChange={(v) => set('active', v)}
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
