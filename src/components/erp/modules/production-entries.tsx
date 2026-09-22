'use client'

import * as React from 'react'
import { toast } from 'sonner'
import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DataTable, DateCell, Field, FormDialog, NumberInput, PageHeader, Qty, SelectInput, StatCard, TextInput, type Column,
} from '@/components/erp/kit'
import { apiPost, useList } from '@/lib/use-api'
import { fmtNum } from '@/lib/erp-constants'

const todayISO = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
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

interface WoLite {
  id: string; number?: string; status?: string; plannedQty?: number; producedQty?: number; rejectedQty?: number
  item?: { code?: string; name?: string; uom?: string } | null
}

export default function ProductionEntriesModule({ companyId }: { companyId: string }) {
  const list = useList<{ items?: PeRow[] } | PeRow[]>(`/api/production-entries?companyId=${companyId}`)
  const wos = useList<{ items?: WoLite[] } | WoLite[]>(`/api/work-orders?companyId=${companyId}`)

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
  const [operator, setOperator] = React.useState('Operator')
  const [downtimeMins, setDowntimeMins] = React.useState(0)
  const [notes, setNotes] = React.useState('')

  const pickedWo = openWos.find((w) => w.id === woId) || null
  const pendingOnWo = pickedWo
    ? Math.max(0, (pickedWo.plannedQty || 0) - (pickedWo.producedQty || 0) - (pickedWo.rejectedQty || 0))
    : 0

  const stats = React.useMemo(() => ({
    entries: peRows.length,
    produced: peRows.reduce((s, r) => s + (r.producedQty || 0), 0),
    rejected: peRows.reduce((s, r) => s + (r.rejectedQty || 0), 0),
    downtime: peRows.reduce((s, r) => s + (r.downtimeMins || 0), 0),
  }), [peRows])

  function resetForm() {
    setWoId(''); setProducedQty(0); setRejectedQty(0); setScrapQty(0)
    setOperator('Operator'); setDowntimeMins(0); setNotes('')
  }

  async function create() {
    if (!woId) { toast.error('Select a work order'); return }
    if (producedQty + rejectedQty <= 0) { toast.error('Produced + rejected qty must be greater than 0'); return }
    setSaving(true)
    try {
      await apiPost('/api/production-entries', {
        companyId, workOrderId: woId, producedQty, rejectedQty, scrapQty,
        operator: operator || undefined, downtimeMins, notes: notes || undefined,
      })
      toast.success('Production entry posted — FG stock updated')
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
            <Plus className="h-4 w-4 mr-1.5" />New Entry
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
        open={open} onOpenChange={setOpen} title="New Production Entry"
        description="Report output against a released / in-progress work order"
        submitLabel="Post Entry" loading={saving} onSubmit={create}
      >
        <Field label="Work Order" required>
          <SelectInput
            value={woId} onChange={setWoId}
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
          <Field label="Produced Qty" required>
            <NumberInput value={producedQty} onChange={setProducedQty} min={0} step="any" />
          </Field>
          <Field label="Rejected Qty">
            <NumberInput value={rejectedQty} onChange={setRejectedQty} min={0} step="any" />
          </Field>
          <Field label="Scrap Qty">
            <NumberInput value={scrapQty} onChange={setScrapQty} min={0} step="any" />
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Operator">
            <TextInput value={operator} onChange={(e) => setOperator(e.target.value)} placeholder="Operator name" />
          </Field>
          <Field label="Downtime (mins)">
            <NumberInput value={downtimeMins} onChange={setDowntimeMins} min={0} step="1" />
          </Field>
        </div>
        <Field label="Notes">
          <TextInput value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional remarks" />
        </Field>
        <p className="text-xs text-muted-foreground">
          FG stock is posted automatically at standard cost; WO completes automatically at planned qty.
        </p>
      </FormDialog>
    </div>
  )
}
