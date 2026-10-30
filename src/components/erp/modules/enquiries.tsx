'use client'

import * as React from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { FileText, Plus, Trash2 } from 'lucide-react'
import {
  Column, ConfirmAction, DataTable, DateCell, DateInput, Field, FormDialog, NumberInput,
  Money, PageHeader, SelectInput, StatusBadge, TextInput, openCreate, useCreatePreset
} from '@/components/erp/kit'
import { apiDelete, apiPatch, apiPost, useList } from '@/lib/use-api'
import { fmtNum } from '@/lib/erp-constants'
import { ItemPicker, pickIntoLines } from '@/components/erp/item-picker'

const ENQ_STATUSES = ['OPEN', 'QUOTED', 'WON', 'LOST', 'CLOSED']
const SOURCES = ['PHONE', 'WEB', 'WALK_IN', 'REFERRAL']

interface EnquiryItemRow {
  id: string; itemId: string; qty: number
  item?: { code?: string | null; name?: string | null; uom?: string | null } | null
}
interface EnquiryRow {
  id: string; number: string; date: string; customerId: string
  requiredBy?: string | null; expectedValue?: number | null
  contactName?: string | null; source?: string | null; notes?: string | null; status: string
  customer?: { name?: string | null } | null
  items?: EnquiryItemRow[] | null
}
interface PartyRow { id: string; name?: string | null; code?: string | null }
interface ItemRow { id: string; code?: string | null; name?: string | null; uom?: string | null; barcode?: string | null; partNo?: string | null }

interface DraftLine { itemId: string; qty: number }

const today = () => new Date().toISOString().slice(0, 10)

export default function EnquiriesModule({ companyId }: { companyId: string }) {
  const list = useList<{ items: EnquiryRow[] }>(`/api/enquiries?companyId=${companyId}`)
  const customers = useList<{ items: PartyRow[] }>(`/api/customers?companyId=${companyId}`)
  const items = useList<{ items: ItemRow[] }>(`/api/items?companyId=${companyId}`)

  const [open, setOpen] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [customerId, setCustomerId] = React.useState('')
  const [date, setDate] = React.useState(today)
  const [contactName, setContactName] = React.useState('')
  const [source, setSource] = React.useState('PHONE')
  const [notes, setNotes] = React.useState('')
  const [requiredBy, setRequiredBy] = React.useState('')
  const [expectedValue, setExpectedValue] = React.useState(0)
  const [lines, setLines] = React.useState<DraftLine[]>([{ itemId: '', qty: 1 }])

  const rows = list.data?.items ?? []
  const customerOpts = (customers.data?.items ?? []).map((c) => ({ value: c.id, label: c.name || c.code || c.id }))
  const itemRows = items.data?.items ?? []

  /** Set a line's item; an item already on another line adds this qty there instead. */
  function pickItem(idx: number, itemId: string) {
    const r = pickIntoLines(lines, idx, itemId, (x) => ({ ...x, itemId }))
    if (r.merged) toast.info('Item already on this enquiry — quantity added to that line')
    setLines(r.lines)
  }

  function resetForm() {
    setCustomerId(''); setDate(today()); setContactName(''); setSource('PHONE'); setNotes('')
    setRequiredBy(''); setExpectedValue(0)
    setLines([{ itemId: '', qty: 1 }])
  }

  // Shortcuts from other screens (party view, row actions, quick actions) open this form pre-filled
  useCreatePreset('enquiries', (d) => {
    resetForm()
    if (d.customerId) setCustomerId(String(d.customerId))
    setOpen(true)
  })

  async function submit() {
    if (!customerId) { toast.error('Select a customer'); return }
    const valid = lines.filter((l) => l.itemId && l.qty > 0)
    if (!valid.length) { toast.error('Add at least one item line'); return }
    setSaving(true)
    try {
      await apiPost('/api/enquiries', {
        companyId, customerId, date, contactName: contactName || undefined,
        source, notes: notes || undefined, items: valid,
        requiredBy: requiredBy || undefined, expectedValue: expectedValue > 0 ? expectedValue : undefined,
      })
      toast.success('Enquiry created')
      setOpen(false); resetForm(); void list.refetch()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to create enquiry')
    } finally { setSaving(false) }
  }

  async function setStatus(row: EnquiryRow, status: string) {
    try {
      await apiPatch(`/api/enquiries/${row.id}`, { status, companyId })
      toast.success(`Enquiry ${row.number} → ${status.replaceAll('_', ' ')}`)
      void list.refetch()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to update status') }
  }

  async function remove(row: EnquiryRow) {
    try {
      await apiDelete(`/api/enquiries/${row.id}?companyId=${companyId}`)
      toast.success('Enquiry deleted'); void list.refetch()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to delete') }
  }

  const columns: Column<EnquiryRow>[] = [
    { key: 'number', header: 'Enquiry #', render: (r) => <span className="font-medium">{r.number}</span> },
    { key: 'date', header: 'Date', render: (r) => <DateCell value={r.date} /> },
    { key: 'customer', header: 'Customer', render: (r) => r.customer?.name || '—' },
    { key: 'items', header: 'Items', render: (r) => <span className="tabular-nums">{r.items?.length ?? 0}</span> },
    { key: 'contact', header: 'Contact', hideOnMobile: true, render: (r) => r.contactName || '—' },
    { key: 'requiredBy', header: 'Required By', hideOnMobile: true, render: (r) => r.requiredBy ? <DateCell value={r.requiredBy} /> : '—' },
    { key: 'expectedValue', header: 'Exp. Value', hideOnMobile: true, render: (r) => r.expectedValue ? <Money value={r.expectedValue} /> : '—' },
    { key: 'source', header: 'Source', hideOnMobile: true, render: (r) => (r.source ? r.source.replaceAll('_', ' ') : '—') },
    {
      key: 'status', header: 'Status',
      render: (r) => r.status === 'OPEN' ? (
        <div onClick={(e) => e.stopPropagation()} className="w-36">
          <SelectInput value={r.status} onChange={(v) => void setStatus(r, v)} options={ENQ_STATUSES.map((s) => ({ value: s, label: s.replaceAll('_', ' ') }))} />
        </div>
      ) : <StatusBadge status={r.status} />,
    },
    {
      key: 'actions', header: 'Actions',
      render: (r) => r.status === 'OPEN' || r.status === 'QUOTED' ? (
        <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
          <Button variant="ghost" size="sm" className="h-7" onClick={() => openCreate('quotations', { customerId: r.customerId, enquiryId: r.id })}>
            <FileText className="h-3.5 w-3.5 mr-1" />Quote
          </Button>
          {r.status === 'OPEN' && (
            <ConfirmAction
              trigger={<Button variant="ghost" size="sm" className="h-7 text-destructive hover:text-destructive"><Trash2 className="h-3.5 w-3.5" /></Button>}
              title="Delete enquiry?" message={`Delete enquiry ${r.number}? This cannot be undone.`}
              tone="destructive" onConfirm={() => remove(r)}
            />
          )}
        </div>
      ) : <span className="text-xs text-muted-foreground">—</span>,
    },
  ]

  return (
    <div>
      <PageHeader
        title="Enquiries"
        description="Track inbound customer enquiries from call to conversion"
        actions={<Button onClick={() => setOpen(true)}><Plus className="h-4 w-4 mr-1.5" />Enquiry</Button>}
      />
      <DataTable columns={columns} rows={rows} loading={list.loading} searchPlaceholder="Search enquiries…" />

      <FormDialog
        open={open} onOpenChange={setOpen} title="Enquiry" submitLabel="Create Enquiry"
        description="Log a new customer enquiry with required items" loading={saving} onSubmit={submit}
      >
        <div className="grid sm:grid-cols-2 gap-4">
          <Field label="Customer" required>
            <SelectInput value={customerId} onChange={setCustomerId} options={customerOpts} placeholder="Select customer…" />
          </Field>
          <Field label="Date" required><DateInput value={date} onChange={setDate} /></Field>
          <Field label="Contact Name"><TextInput value={contactName} onChange={(e) => setContactName(e.target.value)} placeholder="e.g. Ravi Sharma" /></Field>
          <Field label="Source">
            <SelectInput value={source} onChange={setSource} options={SOURCES.map((s) => ({ value: s, label: s.replaceAll('_', ' ') }))} />
          </Field>
          <Field label="Required By"><DateInput value={requiredBy} onChange={setRequiredBy} /></Field>
          <Field label="Expected Value (₹)"><NumberInput value={expectedValue} onChange={setExpectedValue} min={0} placeholder="0" /></Field>
          <Field label="Notes" className="sm:col-span-2">
            <TextInput value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Requirements / context…" />
          </Field>
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
                <ItemPicker items={itemRows} value={l.itemId} onChange={(id) => pickItem(idx, id)} />
              </div>
              <NumberInput
                value={l.qty} className="w-24" min={0} placeholder="Qty"
                onChange={(n) => setLines((ls) => ls.map((x, i) => (i === idx ? { ...x, qty: n } : x)))}
              />
              <Button type="button" variant="ghost" size="sm" disabled={lines.length <= 1}
                onClick={() => setLines((ls) => ls.filter((_, i) => i !== idx))}>
                <Trash2 className="h-3.5 w-3.5 text-destructive" />
              </Button>
            </div>
          ))}
          <p className="text-xs text-muted-foreground">
            {lines.filter((l) => l.itemId).length} line(s) · total qty {fmtNum(lines.reduce((s, l) => s + (l.itemId ? l.qty : 0), 0))}
          </p>
        </div>
      </FormDialog>
    </div>
  )
}
