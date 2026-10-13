'use client'

import * as React from 'react'
import { Button } from '@/components/ui/button'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import {
  DataTable,
  Field,
  FormDialog,
  PageHeader,
  StatCard,
  TextInput,
  type Column,
} from '@/components/erp/kit'
import { apiDelete, apiPatch, apiPost, useList } from '@/lib/use-api'
import { toast } from 'sonner'
import { Boxes, Building2, Info, Pencil, Plus, Unlink, Users } from 'lucide-react'

interface CompanyRow {
  id: string
  name: string
  gstin: string | null
  pan?: string | null
  addressLine?: string | null
  city: string | null
  state: string | null
  stateCode: string | null
  logoText: string | null
  phone: string | null
  email: string | null
  createdAt?: string
  userCount: number
  itemCount: number
  isHome?: boolean
}

/** Ask the app shell to switch the active company (handled in erp-app.tsx). */
export const SWITCH_COMPANY_EVENT = 'erp:switch-company'

export interface CreatedFirm {
  id: string
  name: string
}

const EMPTY_FIRM = { name: '', gstin: '', state: '', stateCode: '', city: '' }

/**
 * "Create new firm" dialog — another company under the same login and subscription
 * (TENANT_ADMIN only; the server enforces this). Used by the topbar switcher and Company Setup.
 */
export function CreateFirmDialog({ open, onOpenChange, onCreated }: {
  open: boolean
  onOpenChange: (o: boolean) => void
  onCreated?: (firm: CreatedFirm) => void
}) {
  const [f, setF] = React.useState(EMPTY_FIRM)
  const [saving, setSaving] = React.useState(false)
  React.useEffect(() => { if (open) setF(EMPTY_FIRM) }, [open])
  const bind = (k: keyof typeof EMPTY_FIRM, transform?: (v: string) => string) => ({
    value: f[k],
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
      const v = transform ? transform(e.target.value) : e.target.value
      setF((x) => ({ ...x, [k]: v }))
    },
  })

  async function submit() {
    const name = f.name.trim()
    if (!name) { toast.error('Firm name is required'); return }
    if (f.gstin.trim() && f.gstin.trim().length !== 15) { toast.error('GSTIN must be exactly 15 characters'); return }
    if (f.stateCode.trim() && !/^\d{2}$/.test(f.stateCode.trim())) { toast.error('State code must be 2 digits'); return }
    setSaving(true)
    try {
      const firm = await apiPost<CreatedFirm>('/api/firms', {
        name, gstin: f.gstin.trim(), state: f.state.trim(), stateCode: f.stateCode.trim(), city: f.city.trim(),
      })
      toast.success(`Firm "${firm.name}" created`)
      onOpenChange(false)
      window.dispatchEvent(new CustomEvent('erp:companies-changed'))
      onCreated?.(firm)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to create firm')
    } finally {
      setSaving(false)
    }
  }

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Create new firm"
      description="A separate company with its own books, stock and documents, on your current plan. Default warehouses (RM / FG / General) are added."
      submitLabel="Create Firm"
      loading={saving}
      onSubmit={submit}
    >
      <Field label="Firm name" required>
        <TextInput {...bind('name')} placeholder="Acme Traders" autoFocus />
      </Field>
      <Field label="GSTIN">
        <TextInput {...bind('gstin', (v) => v.toUpperCase())} placeholder="27ABCDE1234F1Z9" maxLength={15} className="font-mono" />
      </Field>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="City">
          <TextInput {...bind('city')} placeholder="Pune" />
        </Field>
        <Field label="State">
          <TextInput {...bind('state')} placeholder="Maharashtra" />
        </Field>
        <Field label="State code">
          <TextInput {...bind('stateCode', (v) => v.replace(/\D/g, '').slice(0, 2))} placeholder="27" maxLength={2} />
        </Field>
      </div>
    </FormDialog>
  )
}

interface CompanyForm {
  name: string
  gstin: string
  pan: string
  addressLine: string
  city: string
  state: string
  stateCode: string
  phone: string
  email: string
  logoText: string
  adminName: string
  adminEmail: string
  adminPassword: string
}

const EMPTY_FORM: CompanyForm = {
  name: '', gstin: '', pan: '', addressLine: '', city: '', state: '', stateCode: '',
  phone: '', email: '', logoText: '', adminName: '', adminEmail: '', adminPassword: '',
}

const toForm = (c: CompanyRow): CompanyForm => ({
  name: c.name || '',
  gstin: c.gstin || '',
  pan: c.pan || '',
  addressLine: c.addressLine || '',
  city: c.city || '',
  state: c.state || '',
  stateCode: c.stateCode || '',
  phone: c.phone || '',
  email: c.email || '',
  logoText: c.logoText || '',
  adminName: '',
  adminEmail: '',
  adminPassword: '',
})

// Company Setup module — tenant-scoped admin screen (ignores companyId except for display).
export default function CompanySetupModule({ companyId }: { companyId: string }) {
  const { data, loading, error, refetch } = useList<{ companies: CompanyRow[] }>('/api/companies')
  const companies = data?.companies || []

  const [createOpen, setCreateOpen] = React.useState(false)
  const [editOpen, setEditOpen] = React.useState(false)
  const [editId, setEditId] = React.useState<string | null>(null)
  const [form, setForm] = React.useState<CompanyForm>(EMPTY_FORM)
  const [saving, setSaving] = React.useState(false)
  // Creating tenants is a platform-admin action (the server enforces this too).
  const [isPlatformAdmin, setIsPlatformAdmin] = React.useState(false)
  // Tenant admins can add more firms under the same login (Vyapar-style "Create new company").
  const [isTenantAdmin, setIsTenantAdmin] = React.useState(false)
  const [firmOpen, setFirmOpen] = React.useState(false)
  React.useEffect(() => {
    try {
      const s = JSON.parse(window.localStorage.getItem('erp_user') || '{}') as { user?: { role?: string } }
      setIsPlatformAdmin(s.user?.role === 'SUPER_ADMIN')
      setIsTenantAdmin(s.user?.role === 'TENANT_ADMIN')
    } catch { /* ignore */ }
  }, [])

  async function removeFirm(row: CompanyRow) {
    if (!window.confirm(`Remove "${row.name}" from your firm list? Its data is kept, but you will no longer be able to open it.`)) return
    try {
      await apiDelete(`/api/firms/${row.id}`)
      toast.success('Firm removed from your list')
      if (row.id === companyId) {
        const home = companies.find((c) => c.isHome)
        if (home) window.dispatchEvent(new CustomEvent(SWITCH_COMPANY_EVENT, { detail: home.id }))
      }
      await refetch()
      window.dispatchEvent(new CustomEvent('erp:companies-changed'))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to remove firm')
    }
  }

  const set = (k: keyof CompanyForm) => (v: string) => setForm((f) => ({ ...f, [k]: v }))
  const textProps = (k: keyof CompanyForm) => ({
    value: form[k],
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => set(k)(e.target.value),
  })

  const totals = React.useMemo(() => {
    return {
      tenants: companies.length,
      users: companies.reduce((s, c) => s + (c.userCount || 0), 0),
      items: companies.reduce((s, c) => s + (c.itemCount || 0), 0),
    }
  }, [companies])

  const activeTenant = companies.find((c) => c.id === companyId)

  function openCreate() {
    setForm(EMPTY_FORM)
    setCreateOpen(true)
  }

  function openEdit(row: CompanyRow) {
    setEditId(row.id)
    setForm(toForm(row))
    setEditOpen(true)
  }

  function payload(includeAdmin: boolean) {
    const base = {
      name: form.name.trim(),
      gstin: form.gstin.trim(),
      pan: form.pan.trim(),
      addressLine: form.addressLine.trim(),
      city: form.city.trim(),
      state: form.state.trim(),
      stateCode: form.stateCode.trim(),
      phone: form.phone.trim(),
      email: form.email.trim(),
      logoText: form.logoText.trim(),
    }
    if (!includeAdmin) return base
    return { ...base, adminName: form.adminName.trim(), adminEmail: form.adminEmail.trim(), adminPassword: form.adminPassword }
  }

  async function submitCreate() {
    if (!form.name.trim()) {
      toast.error('Company name is required')
      return
    }
    if (form.gstin.trim() && form.gstin.trim().length !== 15) {
      toast.error('GSTIN must be exactly 15 characters')
      return
    }
    if (form.adminEmail.trim() && form.adminPassword.length < 8) {
      toast.error('Admin password must be at least 8 characters')
      return
    }
    setSaving(true)
    try {
      await apiPost('/api/companies', payload(true))
      toast.success('Tenant created')
      setCreateOpen(false)
      await refetch()
      window.dispatchEvent(new CustomEvent('erp:companies-changed'))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to create tenant')
    } finally {
      setSaving(false)
    }
  }

  async function submitEdit() {
    if (!editId) return
    if (!form.name.trim()) {
      toast.error('Company name cannot be empty')
      return
    }
    if (form.gstin.trim() && form.gstin.trim().length !== 15) {
      toast.error('GSTIN must be exactly 15 characters')
      return
    }
    setSaving(true)
    try {
      await apiPatch(`/api/companies/${editId}`, payload(false))
      toast.success('Company profile updated')
      setEditOpen(false)
      await refetch()
      window.dispatchEvent(new CustomEvent('erp:companies-changed'))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to update tenant')
    } finally {
      setSaving(false)
    }
  }

  const columns: Column<CompanyRow>[] = [
    {
      key: 'logo',
      header: '',
      render: (row) => (
        <span
          className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-emerald-100 text-xs font-bold text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
          aria-hidden="true"
        >
          {row.logoText || row.name.slice(0, 2).toUpperCase()}
        </span>
      ),
    },
    {
      key: 'name',
      header: 'Company',
      render: (row) => (
        <div className="min-w-0">
          <p className="font-medium truncate">
            {row.name}
            {row.isHome && !isPlatformAdmin && (
              <span className="ml-1.5 rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">HOME</span>
            )}
          </p>
          <p className="text-xs text-muted-foreground truncate">
            {[row.city, row.state].filter(Boolean).join(', ') || '—'}
          </p>
        </div>
      ),
    },
    {
      key: 'gstin',
      header: 'GSTIN',
      hideOnMobile: true,
      render: (row) => <span className="font-mono text-xs">{row.gstin || '—'}</span>,
    },
    {
      key: 'contact',
      header: 'Contact',
      hideOnMobile: true,
      render: (row) => (
        <div className="min-w-0 text-xs">
          {row.phone && <p className="tabular-nums">{row.phone}</p>}
          {row.email && <p className="text-muted-foreground truncate">{row.email}</p>}
          {!row.phone && !row.email && <span className="text-muted-foreground">—</span>}
        </div>
      ),
    },
    {
      key: 'userCount',
      header: 'Users',
      render: (row) => <span className="tabular-nums">{row.userCount}</span>,
    },
    {
      key: 'itemCount',
      header: 'Items',
      render: (row) => <span className="tabular-nums">{row.itemCount}</span>,
    },
    {
      key: 'actions',
      header: '',
      className: 'text-right',
      render: (row) => (
        <div className="inline-flex gap-1.5">
          <Button variant="outline" size="sm" className="h-8" onClick={() => openEdit(row)}>
            <Pencil className="h-3.5 w-3.5 mr-1" aria-hidden="true" />
            Edit
          </Button>
          {isTenantAdmin && row.isHome === false && (
            <Button variant="outline" size="sm" className="h-8" onClick={() => void removeFirm(row)} title="Remove from my firms (data is kept)">
              <Unlink className="h-3.5 w-3.5" aria-hidden="true" />
              <span className="sr-only">Remove firm</span>
            </Button>
          )}
        </div>
      ),
    },
  ]

  const companyFields = (
    <>
      <Field label="Company name" required>
        <TextInput {...textProps('name')} placeholder="Acme Precision Manufacturing Pvt Ltd" />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="GSTIN">
          <TextInput {...textProps('gstin')} placeholder="27ABCDE1234F1Z9" maxLength={15} className="font-mono" />
          <p className="text-[11px] text-muted-foreground">15-character GST identification number</p>
        </Field>
        <Field label="PAN">
          <TextInput {...textProps('pan')} placeholder="ABCDE1234F" maxLength={10} className="font-mono" />
        </Field>
      </div>
      <Field label="Address">
        <TextInput {...textProps('addressLine')} placeholder="Plot 14, MIDC Industrial Area" />
      </Field>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="City">
          <TextInput {...textProps('city')} placeholder="Pune" />
        </Field>
        <Field label="State">
          <TextInput {...textProps('state')} placeholder="Maharashtra" />
        </Field>
        <Field label="State code">
          <TextInput {...textProps('stateCode')} placeholder="27" maxLength={2} />
          <p className="text-[11px] text-muted-foreground">GST state code (e.g. 27 = Maharashtra)</p>
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Phone">
          <TextInput {...textProps('phone')} placeholder="+91 98765 43210" />
        </Field>
        <Field label="Email">
          <TextInput {...textProps('email')} type="email" placeholder="accounts@company.in" />
        </Field>
      </div>
      <Field label="Logo text">
        <TextInput
          value={form.logoText}
          onChange={(e) => set('logoText')(e.target.value.toUpperCase().slice(0, 2))}
          placeholder="AP"
          maxLength={2}
          className="uppercase w-24"
        />
        <p className="text-[11px] text-muted-foreground">2-letter monogram shown in the tenant switcher</p>
      </Field>
    </>
  )

  return (
    <div>
      <PageHeader
        title="Company Setup"
        description="Manage tenant companies — profile, GST identity and admin access."
        actions={isPlatformAdmin ? (
          <Button onClick={openCreate} className="h-9">
            <Plus className="h-4 w-4 mr-1.5" aria-hidden="true" />
            Tenant
          </Button>
        ) : isTenantAdmin ? (
          <Button onClick={() => setFirmOpen(true)} className="h-9">
            <Plus className="h-4 w-4 mr-1.5" aria-hidden="true" />
            Create firm
          </Button>
        ) : undefined}
      />

      <div className="grid gap-4 sm:grid-cols-3 mb-4">
        <StatCard title="Total Tenants" value={totals.tenants} icon={<Building2 className="h-4 w-4" />} toneClass="bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300" />
        <StatCard title="Total Users" value={totals.users} icon={<Users className="h-4 w-4" />} toneClass="bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300" />
        <StatCard title="Total Items" value={totals.items} icon={<Boxes className="h-4 w-4" />} toneClass="bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300" />
      </div>

      {error && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400 mb-3">
          {error}{' '}
          <button type="button" className="underline" onClick={() => void refetch()}>
            Retry
          </button>
        </p>
      )}

      <DataTable
        columns={columns}
        rows={companies}
        loading={loading}
        emptyText="No tenants yet — create your first one"
        searchPlaceholder="Search tenants…"
        maxHeight="max-h-[32rem]"
      />

      <Alert className="mt-4">
        <Info className="h-4 w-4" aria-hidden="true" />
        <AlertTitle>Multi-tenant isolation</AlertTitle>
        <AlertDescription>
          Tenants are fully isolated — switching via the topbar selector.
          {activeTenant ? ` Currently active: ${activeTenant.name}.` : ''}
        </AlertDescription>
      </Alert>

      {/* Create firm (tenant admin) — switches to the new firm once created */}
      <CreateFirmDialog
        open={firmOpen}
        onOpenChange={setFirmOpen}
        onCreated={(firm) => {
          void refetch()
          window.dispatchEvent(new CustomEvent(SWITCH_COMPANY_EVENT, { detail: firm.id }))
        }}
      />

      {/* Create tenant */}
      <FormDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        title="Tenant"
        description="Creates the company, its default warehouses (RM / FG / General) and an optional admin user."
        wide
        submitLabel="Create Tenant"
        loading={saving}
        onSubmit={submitCreate}
      >
        {companyFields}
        <div className="grid gap-4 sm:grid-cols-2 rounded-lg border bg-muted/40 p-4">
          <Field label="Admin name">
            <TextInput {...textProps('adminName')} placeholder="Rajesh Kumar" />
          </Field>
          <Field label="Admin email">
            <TextInput {...textProps('adminEmail')} type="email" placeholder="admin@newtenant.in" />
          </Field>
          <Field label="Admin password">
            <TextInput {...textProps('adminPassword')} type="password" autoComplete="new-password" placeholder="Min. 8 characters" />
            <p className="text-[11px] text-muted-foreground">Share it with the admin securely; they can change it after signing in.</p>
          </Field>
        </div>
      </FormDialog>

      {/* Edit tenant */}
      <FormDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        title="Edit Tenant"
        description="Update the company profile and GST identity."
        wide
        submitLabel="Save Changes"
        loading={saving}
        onSubmit={submitEdit}
      >
        {companyFields}
      </FormDialog>
    </div>
  )
}
