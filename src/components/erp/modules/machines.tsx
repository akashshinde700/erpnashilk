'use client'

import * as React from 'react'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
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

interface MachineRow {
  id: string
  code: string
  name: string
  workCenter?: string | null
  capacityPerDay?: number
  hourlyRate?: number
  notes?: string | null
  status: string // RUNNING | IDLE | MAINTENANCE | BREAKDOWN
}

interface MachinesResponse {
  items: MachineRow[]
  total?: number
}

interface FormState {
  code: string
  name: string
  workCenter: string
  capacityPerDay: number
  hourlyRate: number
  notes: string
}

const emptyForm: FormState = { code: '', name: '', workCenter: '', capacityPerDay: 0, hourlyRate: 0, notes: '' }

const MACHINE_STATUSES = [
  { value: 'RUNNING', label: 'Running' },
  { value: 'IDLE', label: 'Idle' },
  { value: 'MAINTENANCE', label: 'Maintenance' },
  { value: 'BREAKDOWN', label: 'Breakdown' },
]

export default function MachinesModule({ companyId }: { companyId: string }) {
  const { data, loading, refetch } = useList<MachinesResponse>(`/api/machines?companyId=${companyId}`)
  const rows = data?.items ?? []

  const [open, setOpen] = React.useState(false)
  const [editing, setEditing] = React.useState<MachineRow | null>(null)
  const [saving, setSaving] = React.useState(false)
  const [form, setForm] = React.useState<FormState>(emptyForm)

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }))

  function openCreate() {
    setEditing(null)
    setForm(emptyForm)
    setOpen(true)
  }

  function openEdit(row: MachineRow) {
    setEditing(row)
    setForm({
      code: row.code,
      name: row.name,
      workCenter: row.workCenter ?? '',
      capacityPerDay: row.capacityPerDay ?? 0,
      hourlyRate: row.hourlyRate ?? 0,
      notes: row.notes ?? '',
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
        workCenter: form.workCenter.trim() || null,
        capacityPerDay: form.capacityPerDay,
        hourlyRate: form.hourlyRate,
        notes: form.notes.trim() || null,
      }
      if (editing) await apiPatch(`/api/machines/${editing.id}`, body)
      else await apiPost('/api/machines', body)
      toast.success('Saved')
      setOpen(false)
      await refetch()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save machine')
    } finally {
      setSaving(false)
    }
  }

  async function remove(row: MachineRow) {
    try {
      await apiDelete(`/api/machines/${row.id}?companyId=${companyId}`)
      toast.success('Deleted')
      await refetch()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to delete machine')
    }
  }

  async function changeStatus(row: MachineRow, status: string) {
    if (status === row.status) return
    try {
      await apiPatch(`/api/machines/${row.id}`, { companyId, status })
      toast.success('Status updated')
      await refetch()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to update status')
    }
  }

  const columns: Column<MachineRow>[] = [
    { key: 'code', header: 'Code', render: (r) => <span className="font-medium">{r.code}</span> },
    { key: 'name', header: 'Name', render: (r) => <span className="block max-w-44 truncate">{r.name}</span> },
    {
      key: 'wc',
      header: 'Work Center',
      hideOnMobile: true,
      render: (r) => <span className="text-muted-foreground">{r.workCenter || '—'}</span>,
    },
    {
      key: 'capacity',
      header: 'Capacity/day',
      render: (r) => <span className="tabular-nums">{fmtNum(r.capacityPerDay)}</span>,
    },
    { key: 'rate', header: 'Hourly Rate', hideOnMobile: true, render: (r) => <Money value={r.hourlyRate} /> },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
    {
      key: 'setstatus',
      header: 'Set Status',
      hideOnMobile: true,
      render: (r) => (
        <div className="w-40">
          <SelectInput value={r.status} onChange={(v) => void changeStatus(r, v)} options={MACHINE_STATUSES} />
        </div>
      ),
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
            title="Delete machine"
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
        title="Machines"
        description="Work centers, capacities and live machine status"
        actions={
          <Button size="sm" onClick={openCreate}>
            <Plus className="h-4 w-4 mr-1.5" /> New Machine
          </Button>
        }
      />

      <DataTable
        columns={columns}
        rows={rows}
        loading={loading}
        searchPlaceholder="Search machines…"
        emptyText="No machines yet"
      />

      <FormDialog
        open={open}
        onOpenChange={setOpen}
        title={editing ? 'Edit Machine' : 'New Machine'}
        description={editing ? `Updating ${editing.code}` : 'Register a machine or work center'}
        onSubmit={submit}
        loading={saving}
        submitLabel={editing ? 'Update' : 'Create'}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Code" required>
            <TextInput value={form.code} onChange={(e) => set('code', e.target.value)} placeholder="MC-CNC-01" />
          </Field>
          <Field label="Name" required>
            <TextInput value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="CNC Lathe 1" />
          </Field>
          <Field label="Work Center">
            <TextInput value={form.workCenter} onChange={(e) => set('workCenter', e.target.value)} placeholder="WC-MACHINING" />
          </Field>
          <Field label="Capacity Per Day">
            <NumberInput value={form.capacityPerDay} onChange={(n) => set('capacityPerDay', n)} />
          </Field>
          <Field label="Hourly Rate">
            <NumberInput value={form.hourlyRate} onChange={(n) => set('hourlyRate', n)} />
          </Field>
          <div className="hidden sm:block" />
          <Field label="Notes" className="sm:col-span-2">
            <Textarea value={form.notes} onChange={(e) => set('notes', e.target.value)} rows={2} placeholder="Optional remarks" />
          </Field>
        </div>
      </FormDialog>
    </div>
  )
}
