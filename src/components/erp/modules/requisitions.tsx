'use client'

import * as React from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Check, FileText, Plus, Trash2, X } from 'lucide-react'
import {
  Column, ConfirmAction, DataTable, DateCell, DateInput, Field, FormDialog, NumberInput,
  PageHeader, SelectInput, StatusBadge, TextInput, openCreate,
} from '@/components/erp/kit'
import { apiDelete, apiPatch, apiPost, useList } from '@/lib/use-api'

interface PrItem { id: string; itemId: string; qty: number; item?: { code?: string | null; name?: string | null; uom?: string | null } | null }
interface PrRow {
  id: string; number: string; date: string; requiredBy?: string | null
  department?: string | null; raisedBy?: string | null; status: string; notes?: string | null
  items?: PrItem[] | null
}
interface ItemRow { id: string; code?: string | null; name?: string | null }

interface DraftLine { itemId: string; qty: number }
const today = () => new Date().toISOString().slice(0, 10)

export default function RequisitionsModule({ companyId }: { companyId: string }) {
  const list = useList<{ items: PrRow[] }>(`/api/purchase-requisitions?companyId=${companyId}`)
  const items = useList<{ items: ItemRow[] }>(`/api/items?companyId=${companyId}`)

  const [open, setOpen] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [date, setDate] = React.useState(today)
  const [requiredBy, setRequiredBy] = React.useState('')
  const [department, setDepartment] = React.useState('')
  const [raisedBy, setRaisedBy] = React.useState('')
  const [notes, setNotes] = React.useState('')
  const [lines, setLines] = React.useState<DraftLine[]>([{ itemId: '', qty: 1 }])

  const rows = list.data?.items ?? []
  const itemOpts = (items.data?.items ?? []).map((i) => ({ value: i.id, label: i.code && i.name ? `${i.code} — ${i.name}` : i.name || i.id }))

  function resetForm() {
    setDate(today()); setRequiredBy(''); setDepartment(''); setRaisedBy(''); setNotes('')
    setLines([{ itemId: '', qty: 1 }])
  }

  async function submit() {
    const valid = lines.filter((l) => l.itemId && l.qty > 0)
    if (!valid.length) { toast.error('Add at least one item line'); return }
    setSaving(true)
    try {
      await apiPost('/api/purchase-requisitions', {
        companyId, date, requiredBy: requiredBy || undefined, department: department || undefined,
        raisedBy: raisedBy || undefined, notes: notes || undefined, items: valid,
      })
      toast.success('Purchase requisition created')
      setOpen(false); resetForm(); void list.refetch()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to create requisition') } finally { setSaving(false) }
  }

  async function act(row: PrRow, action: string, msg: string) {
    try {
      await apiPatch(`/api/purchase-requisitions/${row.id}`, { companyId, action })
      toast.success(msg); void list.refetch()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed') }
  }

  async function remove(row: PrRow) {
    try {
      await apiDelete(`/api/purchase-requisitions/${row.id}?companyId=${companyId}`)
      toast.success('Requisition deleted'); void list.refetch()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to delete') }
  }

  const columns: Column<PrRow>[] = [
    { key: 'number', header: 'PR #', render: (r) => <span className="font-medium">{r.number}</span> },
    { key: 'date', header: 'Date', render: (r) => <DateCell value={r.date} /> },
    { key: 'department', header: 'Department', render: (r) => r.department || '—' },
    { key: 'raisedBy', header: 'Raised By', hideOnMobile: true, render: (r) => r.raisedBy || '—' },
    { key: 'requiredBy', header: 'Required By', hideOnMobile: true, render: (r) => <DateCell value={r.requiredBy} /> },
    { key: 'items', header: 'Items', render: (r) => <span className="tabular-nums">{r.items?.length ?? 0}</span> },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
    {
      key: 'actions', header: 'Actions',
      render: (r) => r.status === 'PENDING' ? (
        <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
          <Button variant="outline" size="sm" className="h-7 text-emerald-700" onClick={() => void act(r, 'approve', `PR ${r.number} approved`)}>
            <Check className="h-3.5 w-3.5 mr-0.5" />Approve
          </Button>
          <Button variant="ghost" size="sm" className="h-7 text-red-600" onClick={() => void act(r, 'reject', `PR ${r.number} rejected`)}>
            <X className="h-3.5 w-3.5 mr-0.5" />Reject
          </Button>
          <ConfirmAction
            trigger={<Button variant="ghost" size="sm" className="h-7"><Trash2 className="h-3.5 w-3.5" /></Button>}
            title="Delete requisition?" message={`Delete pending requisition ${r.number}?`} tone="destructive" onConfirm={() => remove(r)}
          />
        </div>
      ) : r.status === 'APPROVED' ? (
        <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
          <Button variant="ghost" size="sm" className="h-7" title="Convert this requisition into a purchase order" onClick={() => openCreate('purchase-orders', { prId: r.id })}>
            <FileText className="h-3.5 w-3.5 mr-0.5" />Create PO
          </Button>
        </div>
      ) : <span className="text-xs text-muted-foreground">—</span>,
    },
  ]

  return (
    <div>
      <PageHeader
        title="Purchase Requisitions"
        description="Internal material requests pending approval"
        actions={<Button onClick={() => { resetForm(); setOpen(true) }}><Plus className="h-4 w-4 mr-1.5" />Requisition</Button>}
      />
      <DataTable columns={columns} rows={rows} loading={list.loading} searchPlaceholder="Search requisitions…" />

      <FormDialog
        open={open} onOpenChange={setOpen} wide title="Purchase Requisition" submitLabel="Create Requisition"
        description="Request materials for production or maintenance" loading={saving} onSubmit={submit}
      >
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <Field label="Date" required><DateInput value={date} onChange={setDate} /></Field>
          <Field label="Required By"><DateInput value={requiredBy} onChange={setRequiredBy} /></Field>
          <Field label="Department"><TextInput value={department} onChange={(e) => setDepartment(e.target.value)} placeholder="e.g. Production" /></Field>
          <Field label="Raised By"><TextInput value={raisedBy} onChange={(e) => setRaisedBy(e.target.value)} placeholder="Your name" /></Field>
          <Field label="Notes" className="sm:col-span-2 lg:col-span-4"><TextInput value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Purpose / remarks…" /></Field>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Requested Items</span>
            <Button type="button" variant="outline" size="sm" onClick={() => setLines((ls) => [...ls, { itemId: '', qty: 1 }])}>
              <Plus className="h-3.5 w-3.5 mr-1" />Add Line
            </Button>
          </div>
          {lines.map((l, idx) => (
            <div key={idx} className="flex gap-2 items-center">
              <div className="flex-1 min-w-0">
                <SelectInput
                  value={l.itemId} options={itemOpts} placeholder="Select item…"
                  onChange={(v) => setLines((ls) => ls.map((x, i) => (i === idx ? { ...x, itemId: v } : x)))}
                />
              </div>
              <NumberInput
                className="w-24" value={l.qty} min={0} placeholder="Qty"
                onChange={(n) => setLines((ls) => ls.map((x, i) => (i === idx ? { ...x, qty: n } : x)))}
              />
              <Button type="button" variant="ghost" size="sm" disabled={lines.length <= 1}
                onClick={() => setLines((ls) => ls.filter((_, i) => i !== idx))}>
                <Trash2 className="h-3.5 w-3.5 text-red-600" />
              </Button>
            </div>
          ))}
        </div>
      </FormDialog>
    </div>
  )
}
