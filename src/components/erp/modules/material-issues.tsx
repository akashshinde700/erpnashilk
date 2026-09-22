'use client'

import * as React from 'react'
import { toast } from 'sonner'
import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import {
  DataTable, DateCell, Field, FormDialog, NumberInput, PageHeader, SelectInput, StatCard, StatusBadge, TextInput, type Column,
} from '@/components/erp/kit'
import { apiGet, apiPost, useList } from '@/lib/use-api'
import { fmtNum } from '@/lib/erp-constants'

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100
const todayISO = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const rowsOf = <T,>(d: T[] | { items?: T[] } | null | undefined): T[] => (Array.isArray(d) ? d : d?.items || [])

// ---------- types ----------
interface ItemRow { id: string; code?: string; name?: string; uom?: string }
interface WarehouseRow { id: string; code?: string; name?: string; type?: string }
interface BomComponent { id: string; itemId: string; qty: number; scrapPct?: number; item?: { code?: string; name?: string } | null }
interface MiLine { id: string; itemId: string; requiredQty?: number; issuedQty?: number; item?: { code?: string; name?: string } | null }
interface MiRow {
  id: string; number: string; date: string; status: string; notes?: string | null
  workOrder?: { id?: string; number?: string } | null
  warehouse?: { code?: string; name?: string } | null
  items?: MiLine[]
}
interface WoRow {
  id: string; number: string; status: string; plannedQty: number; producedQty: number; rejectedQty: number
  itemId: string
  item?: { code?: string; name?: string; uom?: string } | null
}
interface WoDetail extends WoRow { bom?: { id: string; code?: string; items?: BomComponent[] } | null }
interface LineDraft { itemId: string; gross: number; requiredQty: number; issuedQty: number }

export default function MaterialIssuesModule({ companyId }: { companyId: string }) {
  const list = useList<{ items?: MiRow[] } | MiRow[]>(`/api/material-issues?companyId=${companyId}`)
  const wos = useList<{ items?: WoRow[] } | WoRow[]>(`/api/work-orders?companyId=${companyId}`)
  const items = useList<{ items?: ItemRow[] } | ItemRow[]>(`/api/items?companyId=${companyId}`)
  const whs = useList<{ items?: WarehouseRow[] } | WarehouseRow[]>(`/api/warehouses?companyId=${companyId}`)

  const miRows = rowsOf(list.data)
  const itemRows = rowsOf(items.data)
  const whRows = rowsOf(whs.data)
  const openWos = rowsOf(wos.data).filter((w) => w.status === 'RELEASED' || w.status === 'IN_PROGRESS')

  const itemLabel = React.useCallback(
    (id: string) => {
      const it = itemRows.find((x) => x.id === id)
      return it ? `${it.code || ''} — ${it.name || ''}`.trim() : id
    },
    [itemRows],
  )

  // ---- create dialog ----
  const [open, setOpen] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [woId, setWoId] = React.useState('')
  const [woInfo, setWoInfo] = React.useState<WoDetail | null>(null)
  const [lines, setLines] = React.useState<LineDraft[]>([])
  const [warehouseId, setWarehouseId] = React.useState('')
  const [date, setDate] = React.useState(todayISO())
  const [notes, setNotes] = React.useState('')

  // default warehouse: first of type RM
  React.useEffect(() => {
    if (open && !warehouseId) {
      const rm = whRows.find((w) => w.type === 'RM')
      setWarehouseId(rm?.id || whRows[0]?.id || '')
    }
  }, [open, warehouseId, whRows])

  const totalIssued = miRows.reduce((s, m) => s + (m.items || []).reduce((t, l) => t + (l.issuedQty || 0), 0), 0)

  async function pickWo(id: string) {
    setWoId(id); setLines([]); setWoInfo(null)
    if (!id) return
    try {
      const d = await apiGet<WoDetail>(`/api/work-orders/${id}?companyId=${companyId}`)
      setWoInfo(d)
      const issuedByItem: Record<string, number> = {}
      for (const mi of miRows) {
        if (mi.workOrder?.id === id) {
          for (const l of mi.items || []) issuedByItem[l.itemId] = (issuedByItem[l.itemId] || 0) + (l.issuedQty || 0)
        }
      }
      const comps = d?.bom?.items || []
      setLines(comps.map((c) => {
        const gross = r2((d.plannedQty || 0) * (c.qty || 0) * (1 + (c.scrapPct || 0) / 100))
        const pending = Math.max(0, gross - (issuedByItem[c.itemId] || 0))
        return { itemId: c.itemId, gross, requiredQty: pending, issuedQty: pending }
      }))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to load work order BOM')
    }
  }

  async function create() {
    if (!woId) { toast.error('Select a work order'); return }
    if (!warehouseId) { toast.error('Select a warehouse'); return }
    const toPost = lines.filter((l) => l.issuedQty > 0)
    if (toPost.length === 0) { toast.error('Nothing to issue — all pending quantities are 0'); return }
    setSaving(true)
    try {
      await apiPost('/api/material-issues', {
        companyId, workOrderId: woId, warehouseId, date,
        lines: toPost.map((l) => ({ itemId: l.itemId, requiredQty: l.requiredQty, issuedQty: l.issuedQty })),
        notes: notes || undefined,
      })
      toast.success('Material issue posted')
      setOpen(false); setWoId(''); setWoInfo(null); setLines([]); setNotes(''); setDate(todayISO())
      void list.refetch(); void wos.refetch()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to post material issue')
    } finally { setSaving(false) }
  }

  // ---- detail dialog ----
  const [viewRow, setViewRow] = React.useState<MiRow | null>(null)

  const columns: Column<MiRow>[] = [
    { key: 'number', header: 'Issue #', render: (r) => <span className="font-medium">{r.number}</span> },
    { key: 'date', header: 'Date', render: (r) => <DateCell value={r.date} /> },
    { key: 'wo', header: 'Work Order', render: (r) => r.workOrder?.number || '—' },
    { key: 'count', header: 'Items', className: 'text-right', render: (r) => <span className="tabular-nums">{r.items?.length ?? 0}</span> },
    {
      key: 'qty', header: 'Issued Qty', className: 'text-right', render: (r) => (
        <span className="tabular-nums">{fmtNum((r.items || []).reduce((s, l) => s + (l.issuedQty || 0), 0))}</span>
      ),
    },
    { key: 'wh', header: 'Warehouse', hideOnMobile: true, render: (r) => r.warehouse?.name || '—' },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
  ]

  return (
    <div>
      <PageHeader
        title="Material Issues"
        description="Issue BOM raw materials from store to released work orders"
        actions={
          <Button onClick={() => { setWoId(''); setWoInfo(null); setLines([]); setDate(todayISO()); setNotes(''); setOpen(true) }}>
            <Plus className="h-4 w-4 mr-1.5" />New Issue
          </Button>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 mb-4">
        <StatCard title="Total Issues" value={miRows.length} sub="All postings" />
        <StatCard title="This view — lines" value={miRows.reduce((s, m) => s + (m.items?.length ?? 0), 0)} sub="Total issue lines" />
        <StatCard title="Total Issued Qty" value={fmtNum(totalIssued)} sub="Sum of issued quantities" />
        <StatCard title="Open WOs" value={openWos.length} sub="Released / in progress" />
      </div>

      <DataTable
        columns={columns} rows={miRows} loading={list.loading}
        searchPlaceholder="Search issues…" onRowClick={(r) => setViewRow(r)}
      />

      {/* ---- Create dialog ---- */}
      <FormDialog
        open={open} onOpenChange={setOpen} title="New Material Issue"
        description="Pending quantities are computed from the WO BOM minus what was already issued"
        submitLabel="Post Issue" loading={saving} onSubmit={create} wide
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Work Order" required>
            <SelectInput
              value={woId} onChange={(v) => void pickWo(v)}
              options={openWos.map((w) => ({ value: w.id, label: `${w.number} — ${w.item?.name || ''} (${w.status})` }))}
              placeholder="Select released WO…"
            />
          </Field>
          <Field label="Issue From Warehouse" required>
            <SelectInput
              value={warehouseId} onChange={setWarehouseId}
              options={whRows.map((w) => ({ value: w.id, label: `${w.code || ''} — ${w.name || ''} (${w.type || ''})`.trim() }))}
            />
          </Field>
          <Field label="Date" required>
            <TextInput type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label="Notes">
            <TextInput value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional remarks" />
          </Field>
        </div>

        {woId && lines.length > 0 && (
          <div className="rounded-lg border overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/50 hover:bg-muted/50">
                  <TableHead>Component</TableHead>
                  <TableHead className="text-right">Required Total</TableHead>
                  <TableHead className="text-right">Pending</TableHead>
                  <TableHead className="text-right w-36">Issue Qty</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {lines.map((l, idx) => (
                  <TableRow key={l.itemId}>
                    <TableCell className="truncate max-w-52">{itemLabel(l.itemId)}</TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">{fmtNum(l.gross)}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmtNum(l.requiredQty)}</TableCell>
                    <TableCell className="text-right">
                      <NumberInput
                        value={l.issuedQty} min={0} step="any"
                        onChange={(n) => setLines((ls) => ls.map((x, i) => (i === idx ? { ...x, issuedQty: n } : x)))}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        {woId && lines.length === 0 && (
          <p className="text-sm text-muted-foreground rounded-lg border p-4 text-center">No BOM components found for this work order</p>
        )}
        <p className="text-xs text-muted-foreground">Issuing more than available stock will be rejected by the server. Lines with 0 issue qty are skipped.</p>
      </FormDialog>

      {/* ---- Detail dialog ---- */}
      <FormDialog
        open={!!viewRow} onOpenChange={(o) => { if (!o) setViewRow(null) }}
        title={`Material Issue ${viewRow?.number || ''}`}
        description={viewRow?.workOrder?.number ? `Against WO ${viewRow.workOrder.number}` : undefined}
        submitLabel="Close" onSubmit={() => setViewRow(null)} wide
      >
        <div className="rounded-lg border overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/50 hover:bg-muted/50">
                <TableHead>Item</TableHead>
                <TableHead className="text-right">Required</TableHead>
                <TableHead className="text-right">Issued</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(viewRow?.items || []).map((l) => (
                <TableRow key={l.id}>
                  <TableCell>
                    <p className="truncate">{l.item?.name || l.itemId}</p>
                    <p className="text-xs text-muted-foreground">{l.item?.code}</p>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{fmtNum(l.requiredQty)}</TableCell>
                  <TableCell className="text-right tabular-nums font-medium">{fmtNum(l.issuedQty)}</TableCell>
                </TableRow>
              ))}
              {(viewRow?.items || []).length === 0 && (
                <TableRow><TableCell colSpan={3} className="text-center text-muted-foreground">No lines</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </div>
        {viewRow?.notes && <p className="text-xs text-muted-foreground">Notes: {viewRow.notes}</p>}
      </FormDialog>
    </div>
  )
}
