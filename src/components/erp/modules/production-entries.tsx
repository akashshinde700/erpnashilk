'use client'

import * as React from 'react'
import { toast } from 'sonner'
import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import {
  DataTable, DateCell, DateInput, Field, FormDialog, NumberInput, PageHeader, Qty, SelectInput, StatCard, TextInput, type Column,
  useCreatePreset,
} from '@/components/erp/kit'
import { apiPost, useList } from '@/lib/use-api'
import { fmtNum } from '@/lib/erp-constants'

const todayISO = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
// newline / comma separated → unique non-empty serials (case-insensitive, mirrors parseSerials on the server)
function serialList(t: string): string[] {
  const seen = new Set<string>()
  return t.split(/[\r\n,;]+/).map((x) => x.trim()).filter((x) => {
    if (!x || seen.has(x.toUpperCase())) return false
    seen.add(x.toUpperCase()); return true
  })
}
const rowsOf = <T,>(d: T[] | { items?: T[] } | null | undefined): T[] => (Array.isArray(d) ? d : d?.items || [])

// ---------- types ----------
interface PeRow {
  id: string; workOrderId: string; date: string
  producedQty: number; rejectedQty: number; scrapQty: number
  operator?: string | null; downtimeMins?: number | null; notes?: string | null
  workOrder?: {
    id?: string; number?: string; plannedQty?: number; producedQty?: number; rejectedQty?: number
    item?: { code?: string; name?: string; uom?: string } | null
  } | null
}

interface ItemFlags { id: string; batchTracked?: boolean | null; trackSerial?: boolean | null }

interface WoLite {
  id: string; itemId?: string; number?: string; status?: string; plannedQty?: number; producedQty?: number; rejectedQty?: number
  item?: { code?: string; name?: string; uom?: string } | null
}

export default function ProductionEntriesModule({ companyId }: { companyId: string }) {
  const list = useList<{ items?: PeRow[] } | PeRow[]>(`/api/production-entries?companyId=${companyId}`)
  const wos = useList<{ items?: WoLite[] } | WoLite[]>(`/api/work-orders?companyId=${companyId}`)
  // Work-order rows carry no tracking flags — read them from the item master
  const items = useList<{ items?: ItemFlags[] } | ItemFlags[]>(`/api/items?companyId=${companyId}`)
  // Operators = active users with the Operator role (Users & Roles)
  const operators = useList<{ items: { id: string; name: string }[] }>(`/api/users?companyId=${companyId}&role=OPERATOR&active=true`)
  const operatorOpts = [{ value: '', label: '— Select operator —' }, ...(operators.data?.items ?? []).map((u) => ({ value: u.name, label: u.name }))]

  const peRows = rowsOf(list.data)
  const woRows = rowsOf(wos.data)
  const openWos = woRows.filter((w) => w.status === 'RELEASED' || w.status === 'IN_PROGRESS')

  // ---- create dialog ----
  const [open, setOpen] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [woId, setWoId] = React.useState('')
  const [producedQty, setProducedQty] = React.useState(0)
  const [rejectedQty, setRejectedQty] = React.useState(0)
  const [scrapQty, setScrapQty] = React.useState(0)
  const [operator, setOperator] = React.useState('')
  const [downtimeMins, setDowntimeMins] = React.useState(0)
  const [notes, setNotes] = React.useState('')
  const [serials, setSerials] = React.useState('')
  const [batchNo, setBatchNo] = React.useState('')
  const [expiryDate, setExpiryDate] = React.useState('')

  const pickedWo = openWos.find((w) => w.id === woId) || null
  const pendingOnWo = pickedWo
    ? Math.max(0, (pickedWo.plannedQty || 0) - (pickedWo.producedQty || 0) - (pickedWo.rejectedQty || 0))
    : 0
  const woItem = pickedWo?.itemId ? rowsOf(items.data).find((i) => i.id === pickedWo.itemId) : undefined
  const needSerials = !!woItem?.trackSerial
  const isBatched = !!woItem?.batchTracked
  const serialCount = serialList(serials).length

  const stats = React.useMemo(() => ({
    entries: peRows.length,
    produced: peRows.reduce((s, r) => s + (r.producedQty || 0), 0),
    rejected: peRows.reduce((s, r) => s + (r.rejectedQty || 0), 0),
    downtime: peRows.reduce((s, r) => s + (r.downtimeMins || 0), 0),
  }), [peRows])

  function resetForm() {
    setWoId(''); setProducedQty(0); setRejectedQty(0); setScrapQty(0)
    setOperator(''); setDowntimeMins(0); setNotes('')
    setSerials(''); setBatchNo(''); setExpiryDate('')
  }

  // A different work order → its own serials / batch
  function pickWo(id: string) {
    setWoId(id); setSerials(''); setBatchNo(''); setExpiryDate('')
  }

  // Shortcut from a work-order row: open the form with that WO selected
  useCreatePreset('production-entries', (d) => {
    resetForm()
    if (d.woId) setWoId(String(d.woId))
    setOpen(true)
  })

  async function create() {
    if (!woId) { toast.error('Select a work order'); return }
    if (needSerials && producedQty > 0 && serialCount !== producedQty) {
      toast.error(`Enter exactly ${producedQty} serial no(s) — one per produced unit (${serialCount} entered)`); return
    }
    setSaving(true)
    try {
      const res = await apiPost<{ consumed?: { itemId: string; qty: number }[] }>('/api/production-entries', {
        companyId, workOrderId: woId, producedQty, rejectedQty, scrapQty,
        operator: operator || undefined, downtimeMins, notes: notes || undefined,
        ...(needSerials && producedQty > 0 ? { serials: serialList(serials).join('\n') } : {}),
        ...(isBatched && producedQty > 0 ? { batchNo: batchNo.trim() || undefined, expiryDate: expiryDate || undefined } : {}),
      })
      const n = res?.consumed?.length || 0
      toast.success('Production entry posted', {
        description: `${producedQty > 0 ? 'Finished goods added to stock' : 'Work details recorded'}${n ? ` · ${n} raw material(s) auto-consumed from stock (BOM)` : ''}`,
      })
      setOpen(false); resetForm(); void list.refetch(); void wos.refetch()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to post production entry')
    } finally { setSaving(false) }
  }

  const columns: Column<PeRow>[] = [
    { key: 'date', header: 'Date', render: (r) => <DateCell value={r.date} /> },
    { key: 'wo', header: 'Work Order', render: (r) => r.workOrder?.number || '—' },
    {
      key: 'item', header: 'Item', render: (r) => (
        <div className="min-w-36">
          <p className="truncate">{r.workOrder?.item?.name || '—'}</p>
          <p className="text-xs text-muted-foreground">{r.workOrder?.item?.code}</p>
        </div>
      ),
    },
    { key: 'producedQty', header: 'Produced', className: 'text-right', render: (r) => <Qty value={r.producedQty} /> },
    { key: 'rejectedQty', header: 'Rejected', className: 'text-right', render: (r) => <Qty value={r.rejectedQty} /> },
    { key: 'scrapQty', header: 'Scrap', className: 'text-right', hideOnMobile: true, render: (r) => <Qty value={r.scrapQty} /> },
    { key: 'operator', header: 'Operator', hideOnMobile: true, render: (r) => r.operator || '—' },
    { key: 'downtimeMins', header: 'Downtime', className: 'text-right', hideOnMobile: true, render: (r) => <span className="tabular-nums">{fmtNum(r.downtimeMins)} min</span> },
  ]

  return (
    <div>
      <PageHeader
        title="Production Entries"
        description="Record shop-floor output against released work orders"
        actions={
          <Button onClick={() => { resetForm(); setOpen(true) }}>
            <Plus className="h-4 w-4 mr-1.5" />Entry
          </Button>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 mb-4">
        <StatCard title="Entries" value={stats.entries} sub="All time" />
        <StatCard title="Total Produced" value={fmtNum(stats.produced)} sub="Good quantity" />
        <StatCard title="Total Rejected" value={fmtNum(stats.rejected)} sub="QC rejected qty" />
        <StatCard title="Downtime" value={`${fmtNum(stats.downtime)} min`} sub="Reported across entries" />
      </div>

      <DataTable columns={columns} rows={peRows} loading={list.loading} searchPlaceholder="Search production entries…" />

      <FormDialog
        open={open} onOpenChange={setOpen} title="Production Entry"
        description="Report output against a released / in-progress work order"
        submitLabel="Post Entry" loading={saving} onSubmit={create}
      >
        <Field label="Work Order" required>
          <SelectInput
            value={woId} onChange={pickWo}
            options={openWos.map((w) => ({ value: w.id, label: `${w.number} — ${w.item?.name || ''} (${w.status})` }))}
            placeholder="Select work order…"
          />
        </Field>
        {pickedWo && (
          <div className="rounded-lg border bg-muted/40 px-3 py-2 text-sm flex flex-wrap gap-x-6 gap-y-1">
            <span className="text-muted-foreground">Planned: <b className="text-foreground tabular-nums">{fmtNum(pickedWo.plannedQty)}</b></span>
            <span className="text-muted-foreground">Produced so far: <b className="text-foreground tabular-nums">{fmtNum(pickedWo.producedQty)}</b></span>
            <span className="text-muted-foreground">Pending: <b className="text-foreground tabular-nums">{fmtNum(pendingOnWo)}</b></span>
          </div>
        )}
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Produced Qty">
            <NumberInput value={producedQty} onChange={setProducedQty} min={0} step="any" />
          </Field>
          <Field label="Rejected Qty">
            <NumberInput value={rejectedQty} onChange={setRejectedQty} min={0} step="any" />
          </Field>
          <Field label="Scrap Qty">
            <NumberInput value={scrapQty} onChange={setScrapQty} min={0} step="any" />
          </Field>
        </div>
        {needSerials && producedQty > 0 && (
          <Field label={`Serial numbers — ${serialCount} of ${producedQty} entered`} required>
            <Textarea rows={3} value={serials} onChange={(e) => setSerials(e.target.value)}
              placeholder="One serial / IMEI per line (scan or paste)"
              className={serialCount !== producedQty ? 'border-warning-border' : ''} />
          </Field>
        )}
        {isBatched && producedQty > 0 && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Batch No">
              <TextInput value={batchNo} onChange={(e) => setBatchNo(e.target.value)} placeholder={pickedWo?.number ? `Blank = ${pickedWo.number}` : 'Blank = work order no.'} />
            </Field>
            <Field label="Expiry">
              <DateInput value={expiryDate} onChange={setExpiryDate} />
            </Field>
          </div>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Operator">
            <SelectInput value={operator} onChange={setOperator} options={operatorOpts} />
            {!operators.loading && !(operators.data?.items ?? []).length && (
              <p className="text-[11px] text-muted-foreground">No operators yet — add a user with role “Operator” in Users &amp; Roles</p>
            )}
          </Field>
          <Field label="Downtime (mins)">
            <NumberInput value={downtimeMins} onChange={setDowntimeMins} min={0} step="1" />
          </Field>
        </div>
        <Field label="Work Details">
          <TextInput value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Work done, machine, shift…" />
        </Field>
        <p className="text-xs text-muted-foreground">
          FG stock is posted at standard cost and BOM raw materials not yet issued are consumed from stock automatically; WO completes automatically at planned qty.
        </p>
      </FormDialog>
    </div>
  )
}
