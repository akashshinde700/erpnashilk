'use client'

import * as React from 'react'
import { toast } from 'sonner'
import { CheckCircle2, ClipboardCheck, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import {
  DataTable, DateCell, Field, FormDialog, NumberInput, PageHeader, SelectInput, StatCard, StatusBadge, TextInput, type Column,
} from '@/components/erp/kit'
import { apiPatch, apiPost, useList } from '@/lib/use-api'
import { fmtNum } from '@/lib/erp-constants'

const todayISO = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const rowsOf = <T,>(d: T[] | { items?: T[] } | null | undefined): T[] => (Array.isArray(d) ? d : d?.items || [])

// ---------- types ----------
interface QcRow {
  id: string; number: string; date: string
  type: string; status: string
  refType?: string | null; refNumber?: string | null
  itemId: string; qtyChecked: number
  qtyAccepted?: number | null; qtyRejected?: number | null
  parameters?: string | null
  inspector?: string | null; remarks?: string | null
}
interface ItemRow { id: string; code?: string; name?: string; uom?: string }
interface ParamDraft { key: number; name: string; expected: string; actual: string; ok: boolean }

const QC_TYPES = ['INCOMING', 'IN_PROCESS', 'FINAL'] as const
const QC_STATUSES = ['PENDING', 'PASSED', 'FAILED', 'PARTIAL'] as const

function TypeChip({ t }: { t: string }) {
  const cls: Record<string, string> = {
    INCOMING: 'bg-info-soft text-info ring-1 ring-inset ring-info-border',
    IN_PROCESS: 'bg-info-soft text-info ring-1 ring-inset ring-info-border',
    FINAL: 'bg-success-soft text-success ring-1 ring-inset ring-success-border',
  }
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap ${cls[t] || 'bg-muted text-muted-foreground'}`}>
      {t.replaceAll('_', ' ')}
    </span>
  )
}

let paramKey = 0

export default function QcInspectionsModule({ companyId }: { companyId: string }) {
  const list = useList<{ items?: QcRow[] } | QcRow[]>(`/api/qc-inspections?companyId=${companyId}`)
  const items = useList<{ items?: ItemRow[] } | ItemRow[]>(`/api/items?companyId=${companyId}`)

  const qcRows = rowsOf(list.data)
  const itemRows = rowsOf(items.data)
  const itemLabel = (id: string) => {
    const it = itemRows.find((x) => x.id === id)
    return it ? `${it.code || ''} — ${it.name || ''}`.trim() : id
  }

  const [typeFilter, setTypeFilter] = React.useState('__ALL__')
  const [statusFilter, setStatusFilter] = React.useState('__ALL__')

  const filtered = React.useMemo(
    () => qcRows.filter((r) =>
      (typeFilter === '__ALL__' || r.type === typeFilter) &&
      (statusFilter === '__ALL__' || r.status === statusFilter),
    ),
    [qcRows, typeFilter, statusFilter],
  )

  // ---- ad-hoc create dialog ----
  const [open, setOpen] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [type, setType] = React.useState<string>('INCOMING')
  const [cItemId, setCItemId] = React.useState('')
  const [qtyChecked, setQtyChecked] = React.useState(0)
  const [inspector, setInspector] = React.useState('')
  const [date, setDate] = React.useState(todayISO())
  const [remarks, setRemarks] = React.useState('')

  function resetCreate() {
    setType('INCOMING'); setCItemId(''); setQtyChecked(0)
    setInspector(''); setDate(todayISO()); setRemarks('')
  }

  async function create() {
    if (!cItemId) { toast.error('Select an item'); return }
    if (!(qtyChecked > 0)) { toast.error('Checked qty must be greater than 0'); return }
    setSaving(true)
    try {
      await apiPost('/api/qc-inspections', {
        companyId, type, itemId: cItemId, qtyChecked,
        inspector: inspector || undefined, date, remarks: remarks || undefined,
      })
      toast.success('Inspection created')
      setOpen(false); resetCreate(); void list.refetch()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to create inspection')
    } finally { setSaving(false) }
  }

  // ---- submit result dialog ----
  const [resOpen, setResOpen] = React.useState(false)
  const [resSaving, setResSaving] = React.useState(false)
  const [resRow, setResRow] = React.useState<QcRow | null>(null)
  const [qtyAccepted, setQtyAccepted] = React.useState(0)
  const [qtyRejected, setQtyRejected] = React.useState(0)
  const [status, setStatus] = React.useState<string>('PASSED')
  const [resRemarks, setResRemarks] = React.useState('')
  const [resInspector, setResInspector] = React.useState('')
  const [params, setParams] = React.useState<ParamDraft[]>([{ key: ++paramKey, name: '', expected: '', actual: '', ok: true }])

  // auto-suggest: rejected==0 → PASSED, accepted==0 → FAILED, else PARTIAL
  function applyQty(a: number, rj: number) {
    const suggested = rj === 0 ? 'PASSED' : a === 0 ? 'FAILED' : 'PARTIAL'
    setStatus(suggested)
  }

  function openResult(r: QcRow) {
    setResRow(r)
    setQtyAccepted(r.qtyAccepted ?? r.qtyChecked ?? 0)
    setQtyRejected(r.qtyRejected ?? 0)
    setStatus('PASSED')
    setResRemarks(r.remarks || '')
    setResInspector(r.inspector || '')
    let initial: ParamDraft[] = []
    try {
      const parsed = r.parameters ? (JSON.parse(r.parameters) as { name?: string; expected?: string; actual?: string; ok?: boolean }[]) : []
      initial = (Array.isArray(parsed) ? parsed : []).map((p) => ({
        key: ++paramKey, name: p.name || '', expected: p.expected != null ? String(p.expected) : '',
        actual: p.actual != null ? String(p.actual) : '', ok: p.ok !== false,
      }))
    } catch { initial = [] }
    setParams(initial.length > 0 ? initial : [{ key: ++paramKey, name: '', expected: '', actual: '', ok: true }])
    setResOpen(true)
  }

  function updateParam(key: number, patch: Partial<ParamDraft>) {
    setParams((ps) => ps.map((p) => (p.key === key ? { ...p, ...patch } : p)))
  }

  async function submitResult() {
    if (!resRow) return
    const accepted = qtyAccepted || 0
    const rejected = qtyRejected || 0
    if (accepted + rejected <= 0) { toast.error('Accepted + rejected must be greater than 0'); return }
    setResSaving(true)
    try {
      await apiPatch(`/api/qc-inspections/${resRow.id}`, {
        companyId,
        qtyAccepted: accepted,
        qtyRejected: rejected,
        status,
        parameters: JSON.stringify(params.filter((p) => p.name.trim()).map((p) => ({ name: p.name.trim(), expected: p.expected, actual: p.actual, ok: p.ok }))),
        remarks: resRemarks || undefined,
        inspector: resInspector || undefined,
        userName: 'QC Inspector',
      })
      toast.success(`Result recorded — ${resRow.number} ${status}`)
      setResOpen(false); setResRow(null); void list.refetch()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to submit result')
    } finally { setResSaving(false) }
  }

  const pendingCount = qcRows.filter((r) => r.status === 'PENDING').length

  const columns: Column<QcRow>[] = [
    { key: 'number', header: 'QC #', render: (r) => <span className="font-medium whitespace-nowrap">{r.number}</span> },
    { key: 'date', header: 'Date', hideOnMobile: true, render: (r) => <DateCell value={r.date} /> },
    { key: 'type', header: 'Type', render: (r) => <TypeChip t={r.type} /> },
    { key: 'ref', header: 'Reference', hideOnMobile: true, render: (r) => <span className="whitespace-nowrap text-muted-foreground">{r.refNumber || '—'}</span> },
    {
      key: 'item', header: 'Item', render: (r) => (
        <div className="min-w-36">
          <p className="truncate">{itemRows.find((i) => i.id === r.itemId)?.name || '—'}</p>
          <p className="text-xs text-muted-foreground">{itemRows.find((i) => i.id === r.itemId)?.code || ''}</p>
        </div>
      ),
    },
    { key: 'qtyChecked', header: 'Checked', className: 'text-right', render: (r) => <span className="tabular-nums">{fmtNum(r.qtyChecked)}</span> },
    {
      key: 'accRej', header: 'Acc / Rej', className: 'text-right', render: (r) => (
        <span className="tabular-nums whitespace-nowrap">
          <span className="text-success">{fmtNum(r.qtyAccepted)}</span>
          {' / '}
          <span className="text-destructive">{fmtNum(r.qtyRejected)}</span>
        </span>
      ),
    },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
    { key: 'inspector', header: 'Inspector', hideOnMobile: true, render: (r) => r.inspector || '—' },
  ]

  return (
    <div>
      <PageHeader
        title="QC Inspections"
        description="Incoming, in-process and final quality checks with parameter results"
        actions={
          <Button onClick={() => { resetCreate(); setOpen(true) }}>
            <Plus className="h-4 w-4 mr-1.5" />Inspection
          </Button>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 mb-4">
        <StatCard title="Total Inspections" value={qcRows.length} sub="All records" />
        <StatCard title="Pending" value={pendingCount} sub="Awaiting result" toneClass="bg-warning-soft text-warning ring-1 ring-inset ring-warning-border" />
        <StatCard title="Passed" value={qcRows.filter((r) => r.status === 'PASSED').length} sub="Fully accepted" toneClass="bg-success-soft text-success ring-1 ring-inset ring-success-border" />
        <StatCard title="Failed" value={qcRows.filter((r) => r.status === 'FAILED').length} sub="Fully rejected" toneClass="bg-danger-soft text-destructive ring-1 ring-inset ring-danger-border" />
      </div>

      <div className="flex flex-wrap items-center gap-3 mb-3">
        <div className="w-44">
          <SelectInput
            value={typeFilter} onChange={setTypeFilter}
            options={[{ value: '__ALL__', label: 'All types' }, ...QC_TYPES.map((t) => ({ value: t, label: t.replaceAll('_', ' ') }))]}
          />
        </div>
        <div className="w-44">
          <SelectInput
            value={statusFilter} onChange={setStatusFilter}
            options={[{ value: '__ALL__', label: 'All statuses' }, ...QC_STATUSES.map((s) => ({ value: s, label: s }))]}
          />
        </div>
      </div>

      <DataTable
        columns={columns} rows={filtered} loading={list.loading}
        searchPlaceholder="Search inspections…"
        onRowClick={(r) => { if (r.status === 'PENDING') openResult(r) }}
      />

      {/* ---- Ad-hoc create dialog ---- */}
      <FormDialog
        open={open} onOpenChange={setOpen} title="QC Inspection"
        description="Ad-hoc inspection — GRN inspections are created automatically at posting"
        submitLabel="Create" loading={saving} onSubmit={create}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Type" required>
            <SelectInput value={type} onChange={setType} options={QC_TYPES.map((t) => ({ value: t, label: t.replaceAll('_', ' ') }))} />
          </Field>
          <Field label="Item" required>
            <SelectInput
              value={cItemId} onChange={setCItemId}
              options={itemRows.map((i) => ({ value: i.id, label: `${i.code || ''} — ${i.name || ''}`.trim() }))}
              placeholder="Select item…"
            />
          </Field>
          <Field label="Qty Checked" required>
            <NumberInput value={qtyChecked} onChange={setQtyChecked} min={0} step="any" />
          </Field>
          <Field label="Inspector">
            <TextInput value={inspector} onChange={(e) => setInspector(e.target.value)} placeholder="Inspector name" />
          </Field>
          <Field label="Date" required>
            <TextInput type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label="Remarks">
            <TextInput value={remarks} onChange={(e) => setRemarks(e.target.value)} placeholder="Optional remarks" />
          </Field>
        </div>
      </FormDialog>

      {/* ---- Submit result dialog ---- */}
      <FormDialog
        open={resOpen} onOpenChange={(o) => { if (!o) { setResOpen(false); setResRow(null) } }}
        title={`Submit Result — ${resRow?.number || ''}`}
        description={resRow?.refNumber ? `${resRow.type} inspection against ${resRow.refNumber}` : `${resRow?.type || ''} inspection`}
        submitLabel="Submit Result" loading={resSaving} onSubmit={submitResult} wide
      >
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Qty Accepted" required>
            <NumberInput value={qtyAccepted} min={0} step="any" onChange={(n) => { setQtyAccepted(n); applyQty(n, qtyRejected) }} />
          </Field>
          <Field label="Qty Rejected" required>
            <NumberInput value={qtyRejected} min={0} step="any" onChange={(n) => { setQtyRejected(n); applyQty(qtyAccepted, n) }} />
          </Field>
          <Field label="Status" required>
            <SelectInput
              value={status} onChange={setStatus}
              options={[{ value: 'PASSED', label: 'PASSED' }, { value: 'FAILED', label: 'FAILED' }, { value: 'PARTIAL', label: 'PARTIAL' }]}
            />
          </Field>
        </div>
        {resRow && (
          <p className="text-xs text-muted-foreground">
            Checked qty: <b className="text-foreground tabular-nums">{fmtNum(resRow.qtyChecked)}</b> · accepted + rejected should not exceed it.
          </p>
        )}

        <div className="space-y-2">
          <p className="text-sm font-medium flex items-center gap-1.5"><ClipboardCheck className="h-4 w-4" />Parameters</p>
          {params.map((p, idx) => (
            <div key={p.key} className="flex flex-col sm:flex-row gap-2 sm:items-end">
              <Field label={idx === 0 ? 'Name' : ''} className="flex-1">
                <TextInput value={p.name} onChange={(e) => updateParam(p.key, { name: e.target.value })} placeholder="e.g. Diameter" />
              </Field>
              <Field label={idx === 0 ? 'Expected' : ''} className="sm:w-32">
                <TextInput value={p.expected} onChange={(e) => updateParam(p.key, { expected: e.target.value })} placeholder="10 ±0.1" />
              </Field>
              <Field label={idx === 0 ? 'Actual' : ''} className="sm:w-32">
                <TextInput value={p.actual} onChange={(e) => updateParam(p.key, { actual: e.target.value })} placeholder="Measured" />
              </Field>
              <div className="flex items-center gap-2 h-9 pb-0 sm:pb-0.5">
                <Checkbox checked={p.ok} onCheckedChange={(v) => updateParam(p.key, { ok: v === true })} aria-label="Parameter OK" />
                <span className="text-xs text-muted-foreground">OK</span>
                <Button type="button" variant="ghost" size="icon" className="h-8 w-8 text-destructive hover:text-destructive" onClick={() => setParams((ps) => (ps.length > 1 ? ps.filter((x) => x.key !== p.key) : ps))} aria-label="Remove parameter">
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          ))}
          <Button type="button" variant="outline" size="sm" onClick={() => setParams((ps) => [...ps, { key: ++paramKey, name: '', expected: '', actual: '', ok: true }])}>
            <Plus className="h-3.5 w-3.5 mr-1" />Add parameter
          </Button>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Inspector">
            <TextInput value={resInspector} onChange={(e) => setResInspector(e.target.value)} placeholder="Inspector name" />
          </Field>
          <Field label="Remarks">
            <TextInput value={resRemarks} onChange={(e) => setResRemarks(e.target.value)} placeholder="Optional remarks" />
          </Field>
        </div>
        <p className="text-xs text-muted-foreground flex items-center gap-1.5">
          <CheckCircle2 className="h-3.5 w-3.5" />Incoming QC result syncs to GRN line status.
        </p>
      </FormDialog>
    </div>
  )
}
