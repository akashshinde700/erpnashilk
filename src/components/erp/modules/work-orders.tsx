'use client'

import * as React from 'react'
import { toast } from 'sonner'
import { ClipboardList, PlayCircle, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Progress } from '@/components/ui/progress'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import {
  ConfirmAction, DataTable, DateCell, Field, FormDialog, NumberInput, PageHeader, Qty, SelectInput, StatCard,
  StatusBadge, TextInput, type Column, useRowHighlight,
} from '@/components/erp/kit'
import { apiGet, apiPatch, apiPost, useList } from '@/lib/use-api'
import { fmtDate, fmtNum } from '@/lib/erp-constants'

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100
const todayISO = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const rowsOf = <T,>(d: T[] | { items?: T[] } | null | undefined): T[] => (Array.isArray(d) ? d : d?.items || [])

// ---------- types ----------
interface ItemRow { id: string; code?: string; name?: string; uom?: string; type?: string }
interface BomRow { id: string; code?: string; version?: string; outputItemId?: string }
interface WarehouseRow { id: string; code?: string; name?: string; type?: string }
interface BomComponent { id: string; itemId: string; qty: number; scrapPct?: number; item?: { code?: string; name?: string; uom?: string } | null }
interface IssueLine { id: string; itemId: string; requiredQty?: number; issuedQty?: number; item?: { code?: string; name?: string } | null }
interface IssueRow { id: string; number: string; date: string; status?: string; workOrderId?: string; workOrder?: { id?: string; number?: string } | null; items?: IssueLine[] }
interface ProdRow { id: string; date: string; producedQty: number; rejectedQty: number; operator?: string | null; workOrderId?: string; workOrder?: { id?: string; number?: string } | null }
interface WoRow {
  id: string; number: string; status: string; priority: string
  plannedQty: number; producedQty: number; rejectedQty: number
  startDate?: string; dueDate?: string | null; notes?: string | null
  itemId: string
  item?: { code?: string; name?: string; uom?: string } | null
  warehouse?: { code?: string; name?: string } | null
}
interface WoDetail extends WoRow { bom?: { id: string; code?: string; items?: BomComponent[] } | null }

export default function WorkOrdersModule({ companyId }: { companyId: string }) {
  const highlightId = useRowHighlight('work-orders')
  const list = useList<{ items?: WoRow[] } | WoRow[]>(`/api/work-orders?companyId=${companyId}`)
  const items = useList<{ items?: ItemRow[] } | ItemRow[]>(`/api/items?companyId=${companyId}`)
  const boms = useList<{ items?: BomRow[] } | BomRow[]>(`/api/boms?companyId=${companyId}`)
  const whs = useList<{ items?: WarehouseRow[] } | WarehouseRow[]>(`/api/warehouses?companyId=${companyId}`)
  const issues = useList<{ items?: IssueRow[] } | IssueRow[]>(`/api/material-issues?companyId=${companyId}`)
  const entries = useList<{ items?: ProdRow[] } | ProdRow[]>(`/api/production-entries?companyId=${companyId}`)

  const woRows = rowsOf(list.data)
  const itemRows = rowsOf(items.data)
  const whRows = rowsOf(whs.data)
  const bomRows = rowsOf(boms.data)

  // ---- create dialog ----
  const [open, setOpen] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [itemId, setItemId] = React.useState('')
  const [bomId, setBomId] = React.useState('__AUTO__')
  const [warehouseId, setWarehouseId] = React.useState('')
  const [plannedQty, setPlannedQty] = React.useState(0)
  const [startDate, setStartDate] = React.useState(todayISO())
  const [dueDate, setDueDate] = React.useState('')
  const [priority, setPriority] = React.useState('NORMAL')
  const [notes, setNotes] = React.useState('')

  // ---- detail dialog ----
  const [detailOpen, setDetailOpen] = React.useState(false)
  const [detailLoading, setDetailLoading] = React.useState(false)
  const [detail, setDetail] = React.useState<WoDetail | null>(null)
  const [detailId, setDetailId] = React.useState('')

  const fgItems = itemRows.filter((i) => i.type === 'FINISHED' || i.type === 'SEMI')
  const bomOptions = bomRows.filter((b) => b.outputItemId === itemId)

  const stats = React.useMemo(() => {
    const planned = woRows.filter((w) => w.status === 'PLANNED').length
    const inProgress = woRows.filter((w) => w.status === 'RELEASED' || w.status === 'IN_PROGRESS').length
    const completed = woRows.filter((w) => w.status === 'COMPLETED').length
    const totalQty = woRows.reduce((s, w) => s + (w.plannedQty || 0), 0)
    return { planned, inProgress, completed, totalQty }
  }, [woRows])

  const woIssues = detailId ? rowsOf(issues.data).filter((i) => i.workOrder?.id === detailId || i.workOrderId === detailId) : []
  const woEntries = detailId ? rowsOf(entries.data).filter((p) => p.workOrder?.id === detailId || p.workOrderId === detailId) : []
  const bomComps = detail?.bom?.items || []
  const prog = detail && detail.plannedQty > 0
    ? Math.min(100, ((detail.producedQty + detail.rejectedQty) / detail.plannedQty) * 100)
    : 0

  function resetForm() {
    setItemId(''); setBomId('__AUTO__'); setWarehouseId(''); setPlannedQty(0)
    setStartDate(todayISO()); setDueDate(''); setPriority('NORMAL'); setNotes('')
  }

  async function create() {
    if (!itemId) { toast.error('Select an item to manufacture'); return }
    if (!warehouseId) { toast.error('Select a warehouse'); return }
    if (!(plannedQty > 0)) { toast.error('Planned qty must be greater than 0'); return }
    setSaving(true)
    try {
      await apiPost('/api/work-orders', {
        companyId, itemId,
        bomId: bomId === '__AUTO__' ? undefined : bomId || undefined,
        warehouseId, plannedQty, startDate,
        dueDate: dueDate || undefined, priority, notes: notes || undefined,
      })
      toast.success('Work order created')
      setOpen(false); resetForm(); void list.refetch()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to create work order')
    } finally { setSaving(false) }
  }

  async function action(r: WoRow, act: 'release' | 'cancel') {
    try {
      await apiPatch(`/api/work-orders/${r.id}`, { companyId, action: act })
      toast.success(act === 'release' ? `WO ${r.number} released` : `WO ${r.number} cancelled`)
      void list.refetch()
      if (detailId === r.id) setDetail((d) => (d ? { ...d, status: act === 'release' ? 'RELEASED' : 'CANCELLED' } : d))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Action failed')
    }
  }

  async function openDetail(r: WoRow) {
    setDetailOpen(true); setDetailLoading(true); setDetail(null); setDetailId(r.id)
    try {
      setDetail(await apiGet<WoDetail>(`/api/work-orders/${r.id}?companyId=${companyId}`))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to load work order')
    } finally { setDetailLoading(false) }
  }

  const columns: Column<WoRow>[] = [
    { key: 'number', header: 'WO #', render: (r) => <span className="font-medium whitespace-nowrap">{r.number}</span> },
    {
      key: 'item', header: 'Item', render: (r) => (
        <div className="min-w-40">
          <p className="truncate">{r.item?.name || '—'}</p>
          <p className="text-xs text-muted-foreground">{r.item?.code}</p>
        </div>
      ),
    },
    { key: 'plannedQty', header: 'Planned', render: (r) => <Qty value={r.plannedQty} uom={r.item?.uom} /> },
    {
      key: 'produced', header: 'Prod / Rej', render: (r) => (
        <span className="tabular-nums whitespace-nowrap">{fmtNum(r.producedQty)} / {fmtNum(r.rejectedQty)}</span>
      ),
    },
    { key: 'dueDate', header: 'Due', hideOnMobile: true, render: (r) => <DateCell value={r.dueDate} /> },
    { key: 'priority', header: 'Priority', hideOnMobile: true, render: (r) => <StatusBadge status={r.priority} /> },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
    {
      key: 'actions', header: '', render: (r) => (
        <div className="flex items-center justify-end gap-1">
          {r.status === 'PLANNED' && (
            <Button size="sm" variant="outline" className="h-7" onClick={() => void action(r, 'release')}>
              <PlayCircle className="h-3.5 w-3.5 mr-1" />Release
            </Button>
          )}
          <Button size="sm" variant="ghost" className="h-7" onClick={() => void openDetail(r)}>
            <ClipboardList className="h-3.5 w-3.5 mr-1" />Detail
          </Button>
          {r.status !== 'COMPLETED' && r.status !== 'CANCELLED' && (
            <ConfirmAction
              title={`Cancel WO ${r.number}?`}
              message="A cancelled work order cannot be released again."
              tone="destructive"
              onConfirm={() => void action(r, 'cancel')}
              trigger={<Button size="sm" variant="ghost" className="h-7 text-red-600 hover:text-red-700">Cancel</Button>}
            />
          )}
        </div>
      ),
    },
  ]

  return (
    <div>
      <PageHeader
        title="Work Orders"
        description="Plan, release and track production orders"
        actions={
          <Button onClick={() => { resetForm(); setOpen(true) }}>
            <Plus className="h-4 w-4 mr-1.5" />New Work Order
          </Button>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 mb-4">
        <StatCard title="Planned" value={stats.planned} sub="Awaiting release" />
        <StatCard title="In Progress" value={stats.inProgress} sub="Released / running" />
        <StatCard title="Completed" value={stats.completed} sub="Finished orders" />
        <StatCard title="Total Planned Qty" value={fmtNum(stats.totalQty)} sub="Across all WOs" />
      </div>

      <DataTable columns={columns} rows={woRows} loading={list.loading} searchPlaceholder="Search work orders…" highlightId={highlightId} />

      {/* ---- Create dialog ---- */}
      <FormDialog
        open={open} onOpenChange={setOpen} title="New Work Order"
        description="Create a production order against a finished / semi-finished item"
        submitLabel="Create" loading={saving} onSubmit={create} wide
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Item (Finished / Semi)" required>
            <SelectInput
              value={itemId} onChange={(v) => { setItemId(v); setBomId('__AUTO__') }}
              options={fgItems.map((i) => ({ value: i.id, label: `${i.code || ''} — ${i.name || ''}` }))}
              placeholder="Select item…"
            />
          </Field>
          <Field label="BOM">
            <SelectInput
              value={bomId} onChange={setBomId} disabled={!itemId}
              options={[
                { value: '__AUTO__', label: 'Auto (first matching BOM)' },
                ...bomOptions.map((b) => ({ value: b.id, label: `${b.code || 'BOM'} ${b.version || ''}`.trim() })),
              ]}
            />
          </Field>
          <Field label="Produce Into Warehouse" required>
            <SelectInput
              value={warehouseId} onChange={setWarehouseId}
              options={whRows.map((w) => ({ value: w.id, label: `${w.code || ''} — ${w.name || ''}`.trim() }))}
              placeholder="Select warehouse…"
            />
          </Field>
          <Field label="Planned Qty" required>
            <NumberInput value={plannedQty} onChange={setPlannedQty} min={0} step="any" placeholder="0" />
          </Field>
          <Field label="Start Date" required>
            <TextInput type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          </Field>
          <Field label="Due Date">
            <TextInput type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </Field>
          <Field label="Priority">
            <SelectInput
              value={priority} onChange={setPriority}
              options={[{ value: 'NORMAL', label: 'Normal' }, { value: 'HIGH', label: 'High' }, { value: 'URGENT', label: 'Urgent' }]}
            />
          </Field>
          <Field label="Notes">
            <TextInput value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional remarks" />
          </Field>
        </div>
      </FormDialog>

      {/* ---- Detail dialog ---- */}
      <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
        <DialogContent className="sm:max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Work Order {detail?.number || ''}</DialogTitle>
            <DialogDescription>
              {detail?.item?.code ? `${detail.item.code} — ${detail.item.name}` : 'Work order details, BOM explosion and production history'}
            </DialogDescription>
          </DialogHeader>
          {detailLoading ? (
            <p className="text-sm text-muted-foreground py-10 text-center">Loading…</p>
          ) : detail ? (
            <div className="space-y-5">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                <div><p className="text-xs text-muted-foreground">Status</p><div className="mt-0.5"><StatusBadge status={detail.status} /></div></div>
                <div><p className="text-xs text-muted-foreground">Priority</p><div className="mt-0.5"><StatusBadge status={detail.priority} /></div></div>
                <div><p className="text-xs text-muted-foreground">Planned Qty</p><Qty value={detail.plannedQty} uom={detail.item?.uom} /></div>
                <div><p className="text-xs text-muted-foreground">Warehouse</p><p className="truncate">{detail.warehouse?.name || '—'}</p></div>
                <div><p className="text-xs text-muted-foreground">Start</p><p>{fmtDate(detail.startDate)}</p></div>
                <div><p className="text-xs text-muted-foreground">Due</p><p>{fmtDate(detail.dueDate)}</p></div>
                <div><p className="text-xs text-muted-foreground">Produced</p><Qty value={detail.producedQty} /></div>
                <div><p className="text-xs text-muted-foreground">Rejected</p><Qty value={detail.rejectedQty} /></div>
              </div>

              <div>
                <p className="text-xs font-medium text-muted-foreground mb-1.5">Progress — (produced + rejected) / planned</p>
                <Progress value={prog} />
                <p className="text-xs text-muted-foreground mt-1">{Math.round(prog)}% complete</p>
              </div>

              {bomComps.length > 0 && (
                <div>
                  <p className="text-sm font-medium mb-2">BOM components — {detail.bom?.code || 'BOM'}</p>
                  <div className="rounded-lg border overflow-hidden">
                    <Table>
                      <TableHeader>
                        <TableRow className="bg-muted/50 hover:bg-muted/50">
                          <TableHead>Component</TableHead>
                          <TableHead className="text-right">Per Unit</TableHead>
                          <TableHead className="text-right">Scrap %</TableHead>
                          <TableHead className="text-right">Required</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {bomComps.map((c) => {
                          const required = r2((detail.plannedQty || 0) * (c.qty || 0) * (1 + (c.scrapPct || 0) / 100))
                          return (
                            <TableRow key={c.id}>
                              <TableCell>
                                <p className="truncate">{c.item?.name || c.itemId}</p>
                                <p className="text-xs text-muted-foreground">{c.item?.code}</p>
                              </TableCell>
                              <TableCell className="text-right tabular-nums">{fmtNum(c.qty)}</TableCell>
                              <TableCell className="text-right tabular-nums">{fmtNum(c.scrapPct || 0)}</TableCell>
                              <TableCell className="text-right tabular-nums font-medium">{fmtNum(required)}</TableCell>
                            </TableRow>
                          )
                        })}
                      </TableBody>
                    </Table>
                  </div>
                </div>
              )}

              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <p className="text-sm font-medium mb-2">Material issues ({woIssues.length})</p>
                  {woIssues.length === 0 ? (
                    <p className="text-xs text-muted-foreground rounded-lg border p-4 text-center">No material issued yet</p>
                  ) : (
                    <div className="rounded-lg border overflow-hidden">
                      <Table>
                        <TableHeader>
                          <TableRow className="bg-muted/50 hover:bg-muted/50">
                            <TableHead>Issue #</TableHead>
                            <TableHead>Date</TableHead>
                            <TableHead className="text-right">Lines</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {woIssues.map((i) => (
                            <TableRow key={i.id}>
                              <TableCell className="font-medium">{i.number}</TableCell>
                              <TableCell className="text-muted-foreground whitespace-nowrap">{fmtDate(i.date)}</TableCell>
                              <TableCell className="text-right tabular-nums">{i.items?.length ?? 0}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  )}
                </div>
                <div>
                  <p className="text-sm font-medium mb-2">Production entries ({woEntries.length})</p>
                  {woEntries.length === 0 ? (
                    <p className="text-xs text-muted-foreground rounded-lg border p-4 text-center">Nothing produced yet</p>
                  ) : (
                    <div className="rounded-lg border overflow-hidden">
                      <Table>
                        <TableHeader>
                          <TableRow className="bg-muted/50 hover:bg-muted/50">
                            <TableHead>Date</TableHead>
                            <TableHead className="text-right">Prod / Rej</TableHead>
                            <TableHead>Operator</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {woEntries.map((p) => (
                            <TableRow key={p.id}>
                              <TableCell className="text-muted-foreground whitespace-nowrap">{fmtDate(p.date)}</TableCell>
                              <TableCell className="text-right tabular-nums whitespace-nowrap">{fmtNum(p.producedQty)} / {fmtNum(p.rejectedQty)}</TableCell>
                              <TableCell className="truncate">{p.operator || '—'}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground py-10 text-center">No data</p>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
