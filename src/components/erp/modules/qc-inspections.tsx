'use client'

import * as React from 'react'
import { toast } from 'sonner'
import { AlertTriangle, CheckCircle2, ClipboardCheck, Eye, History, PencilLine, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import {
  DataTable, DateCell, Field, FormDialog, NumberInput, PageHeader, SelectInput, StatCard, StatusBadge, TextInput, type Column,
} from '@/components/erp/kit'
import { apiGet, apiPatch, apiPost, currentRole, useList } from '@/lib/use-api'
import { QC_CORRECTION_ROLES, fmtDate, fmtDateTime, fmtNum } from '@/lib/erp-constants'

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
  lineSerials?: string | null
  grnStatus?: string | null; correctionCount?: number
}
interface QcCorrectionRow {
  id: string; createdAt: string; correctedBy: string; inspectedBy: string; reason: string
  previousAccepted: number; previousRejected: number; previousStatus: string
  newAccepted: number; newRejected: number; newStatus: string
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

function parseParams(raw?: string | null): { name: string; expected: string; actual: string; ok: boolean }[] {
  try {
    const parsed = raw ? (JSON.parse(raw) as { name?: string; expected?: unknown; actual?: unknown; ok?: boolean }[]) : []
    return (Array.isArray(parsed) ? parsed : []).map((p) => ({
      name: p.name || '', expected: p.expected != null ? String(p.expected) : '',
      actual: p.actual != null ? String(p.actual) : '', ok: p.ok !== false,
    }))
  } catch { return [] }
}

const statusFromQty = (accepted: number, rejected: number) => (rejected <= 0 ? 'PASSED' : accepted <= 0 ? 'FAILED' : 'PARTIAL')
const r2 = (n: number) => Math.round(n * 100) / 100
const lines = (s?: string | null) => (s || '').split(/[\n,]+/).map((x) => x.trim()).filter(Boolean)

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
  const [acceptedSerials, setAcceptedSerials] = React.useState('')
  const [viewRow, setViewRow] = React.useState<QcRow | null>(null)
  const [resRemarks, setResRemarks] = React.useState('')
  const [resInspector, setResInspector] = React.useState('')
  const [params, setParams] = React.useState<ParamDraft[]>([{ key: ++paramKey, name: '', expected: '', actual: '', ok: true }])

  function openResult(r: QcRow) {
    setResRow(r)
    setQtyAccepted(r.qtyChecked ?? 0)
    setQtyRejected(0)
    setAcceptedSerials('')
    setResRemarks(r.remarks || '')
    setResInspector(r.inspector && r.inspector !== 'pending' ? r.inspector : '')
    const initial: ParamDraft[] = parseParams(r.parameters).map((p) => ({ key: ++paramKey, ...p }))
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
    if (Math.abs(r2(accepted + rejected) - r2(resRow.qtyChecked)) > 0.01) {
      toast.error(`Accepted + rejected must equal the checked qty ${fmtNum(resRow.qtyChecked)}`); return
    }
    setResSaving(true)
    try {
      await apiPatch(`/api/qc-inspections/${resRow.id}`, {
        companyId,
        qtyAccepted: accepted,
        qtyRejected: rejected,
        ...(needSerials ? { acceptedSerials } : {}),
        parameters: JSON.stringify(params.filter((p) => p.name.trim()).map((p) => ({ name: p.name.trim(), expected: p.expected, actual: p.actual, ok: p.ok }))),
        remarks: resRemarks || undefined,
        inspector: resInspector || undefined,
        userName: 'QC Inspector',
      })
      toast.success(`Result recorded — ${resRow.number} ${resStatus}`)
      setResOpen(false); setResRow(null); void list.refetch()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to submit result')
    } finally { setResSaving(false) }
  }

  const unaccounted = resRow ? r2(resRow.qtyChecked - (qtyAccepted || 0) - (qtyRejected || 0)) : 0
  const resStatus = statusFromQty(qtyAccepted || 0, qtyRejected || 0)
  const lineSerials = lines(resRow?.lineSerials)
  // Serial-tracked and only partly accepted: stock needs to know which serials stay
  const needSerials = lineSerials.length > 0 && (qtyAccepted || 0) > 0 && (qtyAccepted || 0) < lineSerials.length

  // ---- correction of a submitted result (GRN not posted yet) ----
  const [history, setHistory] = React.useState<QcCorrectionRow[]>([])
  const [fix, setFix] = React.useState<{ row: QcRow; accepted: number; rejected: number; inspectedBy: string; reason: string; checked: boolean; serials: string } | null>(null)
  const [fixSaving, setFixSaving] = React.useState(false)

  const viewId = viewRow?.id
  React.useEffect(() => {
    setHistory([])
    if (!viewId) return
    apiGet<{ corrections?: QcCorrectionRow[] }>(`/api/qc-inspections/${viewId}?companyId=${companyId}`)
      .then((d) => setHistory(d.corrections ?? []))
      .catch(() => toast.error('Could not load the correction history'))
  }, [viewId, companyId])

  const unaccountedOf = (r: QcRow) => r2((r.qtyChecked || 0) - (r.qtyAccepted || 0) - (r.qtyRejected || 0))
  const canCorrect = (r: QcRow) => r.refType === 'GRN' && r.status !== 'PENDING' && ['PENDING_QC', 'QC_COMPLETED'].includes(r.grnStatus || '') && QC_CORRECTION_ROLES.includes(currentRole())
  // The form starts from the recorded result, never from a guess about the missing qty
  const openFix = (r: QcRow) => setFix({ row: r, accepted: r.qtyAccepted || 0, rejected: r.qtyRejected || 0, inspectedBy: '', reason: '', checked: false, serials: '' })
  const fixGap = fix ? r2(fix.row.qtyChecked - (fix.accepted || 0) - (fix.rejected || 0)) : 0

  async function saveFix() {
    if (!fix) return
    if (fixGap !== 0) { toast.error(`Accepted + rejected must equal the checked qty ${fmtNum(fix.row.qtyChecked)}`); return }
    if (!fix.inspectedBy.trim()) { toast.error('Enter who inspected the material'); return }
    if (fix.reason.trim().length < 10) { toast.error('Explain the correction (at least 10 characters)'); return }
    if (!fix.checked) { toast.error('Confirm that the material was physically inspected'); return }
    setFixSaving(true)
    try {
      await apiPost(`/api/qc-inspections/${fix.row.id}/corrections`, {
        companyId, qtyAccepted: fix.accepted, qtyRejected: fix.rejected,
        basedOn: { qtyAccepted: fix.row.qtyAccepted || 0, qtyRejected: fix.row.qtyRejected || 0 },
        inspectedBy: fix.inspectedBy, reason: fix.reason, physicalCheckConfirmed: fix.checked,
        ...(fix.serials ? { acceptedSerials: fix.serials } : {}),
      })
      toast.success(`Result corrected — ${fix.row.number}`)
      setFix(null); setViewRow(null); void list.refetch()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not correct the result')
    } finally { setFixSaving(false) }
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
    {
      key: 'status', header: 'Status', render: (r) => (
        <div className="flex flex-col items-start gap-0.5">
          <StatusBadge status={r.status} />
          {r.status !== 'PENDING' && unaccountedOf(r) !== 0 && <span className="text-[11px] font-medium text-destructive whitespace-nowrap">Needs reconciliation</span>}
          {!!r.correctionCount && <span className="text-[11px] text-muted-foreground whitespace-nowrap">Corrected</span>}
        </div>
      ),
    },
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
        onRowClick={(r) => { if (r.status === 'PENDING') openResult(r); else setViewRow(r) }}
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
            <NumberInput value={qtyAccepted} min={0} step="any" onChange={setQtyAccepted} />
          </Field>
          <Field label="Qty Rejected" required>
            <NumberInput value={qtyRejected} min={0} step="any" onChange={setQtyRejected} />
          </Field>
          <Field label="Result">
            <div className="flex h-9 items-center"><StatusBadge status={resStatus} /></div>
          </Field>
        </div>
        {resRow && (
          <p className={`text-xs ${unaccounted !== 0 ? 'text-destructive' : 'text-muted-foreground'}`} role="status">
            Checked qty: <b className="tabular-nums">{fmtNum(resRow.qtyChecked)}</b> · accepted + rejected must equal it
            {unaccounted > 0 ? ` — ${fmtNum(unaccounted)} unaccounted for` : unaccounted < 0 ? ` — over by ${fmtNum(-unaccounted)}` : ''}.
          </p>
        )}
        {needSerials && (
          <Field label={`Accepted serial nos — one per line (${lines(acceptedSerials).length} of ${qtyAccepted})`} required>
            <Textarea rows={3} value={acceptedSerials} onChange={(e) => setAcceptedSerials(e.target.value)} placeholder={lineSerials.join('\n')} />
          </Field>
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
          <CheckCircle2 className="h-3.5 w-3.5" />Incoming QC result sets the GRN line's accepted and rejected qty. It cannot be changed after submitting.
        </p>
      </FormDialog>

      {/* ---- Completed inspection: read only ---- */}
      <Dialog open={!!viewRow} onOpenChange={(o) => { if (!o) setViewRow(null) }}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex flex-wrap items-center gap-2">
              <Eye className="h-4 w-4" aria-hidden="true" />QC Details — {viewRow?.number}
              {viewRow && <StatusBadge status={viewRow.status} />}
            </DialogTitle>
            <DialogDescription>Read only: this is the submitted result. Any correction is recorded separately and the earlier values stay in its history.</DialogDescription>
          </DialogHeader>
          {viewRow && (
            <div className="space-y-4 text-sm">
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
                {([
                  ['Item', viewRow.itemId ? itemLabel(viewRow.itemId) : '—'],
                  ['Type', viewRow.type.replaceAll('_', ' ')],
                  ['Reference', viewRow.refNumber || '—'],
                  ['Date', fmtDate(viewRow.date)],
                  ['Inspector', viewRow.inspector && viewRow.inspector !== 'pending' ? viewRow.inspector : '—'],
                  ['Remarks', viewRow.remarks || '—'],
                ] as const).map(([k, v]) => (
                  <div key={k} className="min-w-0">
                    <dt className="text-xs text-muted-foreground">{k}</dt>
                    <dd className="break-words">{v}</dd>
                  </div>
                ))}
              </dl>
              <div className="grid grid-cols-3 gap-2 rounded-lg border p-3 text-center">
                <div><p className="text-xs text-muted-foreground">Checked</p><p className="font-semibold tabular-nums">{fmtNum(viewRow.qtyChecked)}</p></div>
                <div><p className="text-xs text-muted-foreground">Accepted</p><p className="font-semibold tabular-nums text-success">{fmtNum(viewRow.qtyAccepted)}</p></div>
                <div><p className="text-xs text-muted-foreground">Rejected</p><p className="font-semibold tabular-nums text-destructive">{fmtNum(viewRow.qtyRejected)}</p></div>
              </div>
              {unaccountedOf(viewRow) !== 0 && (
                <p className="flex items-start gap-1.5 rounded-lg border border-danger-border bg-danger-soft p-2.5 text-destructive" role="alert">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                  <span>{fmtNum(Math.abs(unaccountedOf(viewRow)))} of the checked qty {unaccountedOf(viewRow) > 0 ? 'is unaccounted for' : 'is over-counted'}. This GRN cannot be posted until an authorized user inspects the material and corrects the result.</span>
                </p>
              )}
              {canCorrect(viewRow) && (
                <Button type="button" variant="outline" onClick={() => openFix(viewRow)}>
                  <PencilLine className="h-4 w-4 mr-1.5" aria-hidden="true" />Correct result
                </Button>
              )}
              {history.length > 0 && (
                <div>
                  <p className="mb-1.5 flex items-center gap-1.5 font-medium"><History className="h-4 w-4" aria-hidden="true" />Correction history</p>
                  <ol className="space-y-2">
                    {history.map((c) => (
                      <li key={c.id} className="rounded-lg border p-2.5 text-xs">
                        <p className="font-medium">
                          Accepted {fmtNum(c.previousAccepted)} / rejected {fmtNum(c.previousRejected)} ({c.previousStatus}) → accepted {fmtNum(c.newAccepted)} / rejected {fmtNum(c.newRejected)} ({c.newStatus})
                        </p>
                        <p className="mt-0.5 text-muted-foreground">{fmtDateTime(c.createdAt)} · corrected by {c.correctedBy} · inspected by {c.inspectedBy}</p>
                        <p className="mt-0.5">{c.reason}</p>
                      </li>
                    ))}
                  </ol>
                </div>
              )}
              <div>
                <p className="mb-1.5 flex items-center gap-1.5 font-medium"><ClipboardCheck className="h-4 w-4" aria-hidden="true" />Parameters</p>
                {parseParams(viewRow.parameters).length === 0 ? (
                  <p className="text-muted-foreground">No parameters recorded.</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow><TableHead>Name</TableHead><TableHead>Expected</TableHead><TableHead>Actual</TableHead><TableHead>Result</TableHead></TableRow>
                    </TableHeader>
                    <TableBody>
                      {parseParams(viewRow.parameters).map((p, i) => (
                        <TableRow key={i}>
                          <TableCell className="whitespace-normal">{p.name}</TableCell>
                          <TableCell>{p.expected || '—'}</TableCell>
                          <TableCell>{p.actual || '—'}</TableCell>
                          <TableCell className={p.ok ? 'text-success' : 'text-destructive'}>{p.ok ? 'OK' : 'Not OK'}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* ---- Correct a submitted result ---- */}
      <FormDialog
        open={!!fix} onOpenChange={(o) => { if (!o) setFix(null) }}
        title={`Correct Result — ${fix?.row.number || ''}`}
        description={`${fix?.row.refNumber || ''} · ${fix ? itemLabel(fix.row.itemId) : ''}. Recorded in the audit log and the correction history; the earlier values are kept.`}
        submitLabel="Save Correction" loading={fixSaving} onSubmit={saveFix} wide
      >
        {fix && (
          <>
            <p className="text-sm">
              Recorded now: checked <b className="tabular-nums">{fmtNum(fix.row.qtyChecked)}</b>, accepted <b className="tabular-nums">{fmtNum(fix.row.qtyAccepted)}</b>, rejected <b className="tabular-nums">{fmtNum(fix.row.qtyRejected)}</b>.
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Qty Accepted" required>
                <NumberInput value={fix.accepted} min={0} step="any" onChange={(n) => setFix({ ...fix, accepted: n })} />
              </Field>
              <Field label="Qty Rejected" required>
                <NumberInput value={fix.rejected} min={0} step="any" onChange={(n) => setFix({ ...fix, rejected: n })} />
              </Field>
            </div>
            <p className={`text-xs ${fixGap !== 0 ? 'text-destructive' : 'text-muted-foreground'}`} role="status">
              Accepted + rejected must equal {fmtNum(fix.row.qtyChecked)}
              {fixGap > 0 ? ` — ${fmtNum(fixGap)} unaccounted for` : fixGap < 0 ? ` — over by ${fmtNum(-fixGap)}` : ''}. Count the material; nothing is assumed about the rest.
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Inspected by" required>
                <TextInput value={fix.inspectedBy} onChange={(e) => setFix({ ...fix, inspectedBy: e.target.value })} placeholder="Who checked the material" />
              </Field>
              <Field label="Reason for correction" required>
                <TextInput value={fix.reason} onChange={(e) => setFix({ ...fix, reason: e.target.value })} placeholder="What was found" />
              </Field>
            </div>
            {lines(fix.row.lineSerials).length > (fix.accepted || 0) && (fix.accepted || 0) > 0 && (
              <Field label={`Accepted serial nos — one per line (${lines(fix.serials).length} of ${fix.accepted})`} required>
                <Textarea rows={3} value={fix.serials} onChange={(e) => setFix({ ...fix, serials: e.target.value })} />
              </Field>
            )}
            <label className="flex items-start gap-2 text-sm">
              <Checkbox checked={fix.checked} onCheckedChange={(v) => setFix({ ...fix, checked: v === true })} aria-label="Material was physically inspected" className="mt-0.5" />
              <span>I confirm the material was physically inspected and these quantities are the count.</span>
            </label>
          </>
        )}
      </FormDialog>
    </div>
  )
}
