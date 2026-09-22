'use client'

import * as React from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Eye, PackageCheck, Plus, Trash2 } from 'lucide-react'
import {
  Column, ConfirmAction, DataTable, DateCell, DateInput, Field, FormDialog, NumberInput,
  PageHeader, SelectInput, StatusBadge, TextInput,
} from '@/components/erp/kit'
import { apiDelete, apiGet, apiPatch, apiPost, useList } from '@/lib/use-api'
import { fmtNum } from '@/lib/erp-constants'

interface PoRow { id: string; number: string; status: string }
interface PoDetail {
  id: string; number: string
  supplier?: { name?: string | null } | null
  items?: { id: string; itemId: string; qty: number; receivedQty?: number; item?: { code?: string | null; name?: string | null; uom?: string | null } | null }[] | null
}
interface GrnRow {
  id: string; number: string; date: string; supplierInvNo?: string | null; status: string; notes?: string | null
  po?: { number?: string | null; supplier?: { name?: string | null } | null } | null
  items?: { id: string; orderedQty: number; receivedQty: number; acceptedQty: number; rejectedQty: number; qcStatus?: string | null; item?: { code?: string | null; name?: string | null; uom?: string | null } | null }[] | null
}
interface DraftRow {
  poItemId: string; itemId: string; label: string; uom: string
  orderedQty: number; pending: number; receivedQty: number; acceptedQty: number; rejectedQty: number
}

const today = () => new Date().toISOString().slice(0, 10)
const RECEIVABLE = ['APPROVED', 'PARTIALLY_RECEIVED']

export default function GrnsModule({ companyId }: { companyId: string }) {
  const list = useList<{ items: GrnRow[] }>(`/api/grns?companyId=${companyId}`)
  const pos = useList<{ items: PoRow[] }>(`/api/purchase-orders?companyId=${companyId}`)
  const warehouses = useList<{ items: { id: string; name?: string | null; code?: string | null }[] }>(`/api/warehouses?companyId=${companyId}`)

  const [open, setOpen] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [poId, setPoId] = React.useState('')
  const [warehouseId, setWarehouseId] = React.useState('')
  const [date, setDate] = React.useState(today)
  const [supplierInvNo, setSupplierInvNo] = React.useState('')
  const [notes, setNotes] = React.useState('')
  const [rows, setRows] = React.useState<DraftRow[]>([])
  const [detail, setDetail] = React.useState<GrnRow | null>(null)

  const items = list.data?.items ?? []
  const poOpts = (pos.data?.items ?? []).filter((p) => RECEIVABLE.includes(p.status)).map((p) => ({ value: p.id, label: `${p.number} (${p.status.replaceAll('_', ' ')})` }))
  const whOpts = (warehouses.data?.items ?? []).map((w) => ({ value: w.id, label: w.name ? `${w.code || ''} ${w.name}`.trim() : w.code || w.id }))

  function resetForm() {
    setPoId(''); setWarehouseId(''); setDate(today()); setSupplierInvNo(''); setNotes(''); setRows([])
  }

  async function pickPo(pid: string) {
    setPoId(pid)
    if (!pid) { setRows([]); return }
    try {
      const po = await apiGet<PoDetail>(`/api/purchase-orders/${pid}?companyId=${companyId}`)
      const mapped: DraftRow[] = (po.items ?? [])
        .filter((it) => it.qty - (it.receivedQty || 0) > 0)
        .map((it) => {
          const pending = it.qty - (it.receivedQty || 0)
          return {
            poItemId: it.id, itemId: it.itemId,
            label: it.item?.name ? `${it.item.code ? it.item.code + ' — ' : ''}${it.item.name}` : it.itemId,
            uom: it.item?.uom || '', orderedQty: it.qty, pending,
            receivedQty: pending, acceptedQty: pending, rejectedQty: 0,
          }
        })
      setRows(mapped)
      toast.success(`Loaded ${mapped.length} pending line(s) from ${po.number}`)
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to load purchase order') }
  }

  function updateRow(idx: number, patch: Partial<DraftRow>) {
    setRows((rs) => rs.map((r, i) => {
      if (i !== idx) return r
      const next = { ...r, ...patch }
      next.receivedQty = Math.min(Math.max(0, next.receivedQty), next.pending)
      next.acceptedQty = Math.min(Math.max(0, next.acceptedQty), next.receivedQty)
      next.rejectedQty = Math.min(Math.max(0, next.rejectedQty), next.receivedQty - next.acceptedQty)
      return next
    }))
  }

  async function submit() {
    if (!poId) { toast.error('Select a purchase order'); return }
    if (!warehouseId) { toast.error('Select a warehouse'); return }
    const valid = rows.filter((r) => r.receivedQty > 0)
    if (!valid.length) { toast.error('Enter received qty for at least one line'); return }
    setSaving(true)
    try {
      await apiPost('/api/grns', {
        companyId, poId, warehouseId, date, supplierInvNo: supplierInvNo || undefined, notes: notes || undefined,
        items: valid.map((r) => ({
          poItemId: r.poItemId, itemId: r.itemId, orderedQty: r.orderedQty,
          receivedQty: r.receivedQty, acceptedQty: r.acceptedQty, rejectedQty: r.rejectedQty,
        })),
      })
      toast.success('GRN created — pending QC')
      setOpen(false); resetForm(); void list.refetch()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to create GRN') } finally { setSaving(false) }
  }

  async function post(row: GrnRow) {
    try {
      await apiPatch(`/api/grns/${row.id}`, { action: 'post', companyId })
      toast.success('Stock updated')
      void list.refetch()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to post') }
  }

  async function remove(row: GrnRow) {
    try {
      await apiDelete(`/api/grns/${row.id}?companyId=${companyId}`)
      toast.success('GRN deleted'); void list.refetch()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to delete') }
  }

  const columns: Column<GrnRow>[] = [
    { key: 'number', header: 'GRN #', render: (r) => <span className="font-medium">{r.number}</span> },
    { key: 'date', header: 'Date', render: (r) => <DateCell value={r.date} /> },
    { key: 'po', header: 'PO #', render: (r) => r.po?.number || '—' },
    { key: 'supplier', header: 'Supplier', render: (r) => r.po?.supplier?.name || '—' },
    { key: 'inv', header: 'Supplier Inv', hideOnMobile: true, render: (r) => r.supplierInvNo || '—' },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
    {
      key: 'actions', header: 'Actions',
      render: (r) => (
        <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
          <Button variant="ghost" size="sm" className="h-7" title="View detail" onClick={() => setDetail(r)}><Eye className="h-3.5 w-3.5" /></Button>
          {r.status === 'PENDING_QC' && (
            <>
              <ConfirmAction
                trigger={<Button size="sm" className="h-7"><PackageCheck className="h-3.5 w-3.5 mr-1" />Post to Stock</Button>}
                title="Post GRN to stock?" message={`Post ${r.number}? Accepted quantities will be added to warehouse stock at PO rate.`}
                onConfirm={() => post(r)}
              />
              <ConfirmAction
                trigger={<Button variant="ghost" size="sm" className="h-7 text-red-600"><Trash2 className="h-3.5 w-3.5" /></Button>}
                title="Delete GRN?" message={`Delete GRN ${r.number}?`} tone="destructive" onConfirm={() => remove(r)}
              />
            </>
          )}
        </div>
      ),
    },
  ]

  return (
    <div>
      <PageHeader
        title="Goods Receipt Notes"
        description="Receive material against purchase orders, then post to stock after QC"
        actions={<Button onClick={() => { resetForm(); setOpen(true) }}><Plus className="h-4 w-4 mr-1.5" />New GRN</Button>}
      />
      <DataTable columns={columns} rows={items} loading={list.loading} searchPlaceholder="Search GRNs…" onRowClick={(r) => setDetail(r)} />

      <FormDialog
        open={open} onOpenChange={setOpen} wide title="New GRN" submitLabel="Create GRN"
        description="Pick an approved PO — pending quantities are pre-filled" loading={saving} onSubmit={submit}
      >
        <div className="grid sm:grid-cols-4 gap-4">
          <Field label="Purchase Order" required>
            <SelectInput value={poId} onChange={(v) => void pickPo(v)} options={poOpts} placeholder="Select PO…" />
          </Field>
          <Field label="Warehouse" required><SelectInput value={warehouseId} onChange={setWarehouseId} options={whOpts} /></Field>
          <Field label="Date" required><DateInput value={date} onChange={setDate} /></Field>
          <Field label="Supplier Inv No"><TextInput value={supplierInvNo} onChange={(e) => setSupplierInvNo(e.target.value)} placeholder="Their invoice no." /></Field>
          <Field label="Notes" className="sm:col-span-4"><TextInput value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Remarks…" /></Field>
        </div>

        <div className="space-y-2">
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Receipt Lines</span>
          {!poId && <p className="text-sm text-muted-foreground">Select a purchase order to load pending lines.</p>}
          {rows.map((r, idx) => (
            <div key={r.poItemId || idx} className="grid grid-cols-2 sm:grid-cols-12 gap-2 items-center rounded-md border p-2">
              <div className="col-span-2 sm:col-span-4 min-w-0">
                <p className="text-sm font-medium truncate">{r.label}</p>
                <p className="text-[11px] text-muted-foreground">Ordered {fmtNum(r.orderedQty)}{r.uom ? ` ${r.uom}` : ''} · pending {fmtNum(r.pending)}</p>
              </div>
              <div className="sm:col-span-2">
                <span className="text-[10px] text-muted-foreground uppercase">Received</span>
                <NumberInput value={r.receivedQty} min={0} max={r.pending} onChange={(n) => updateRow(idx, { receivedQty: n, acceptedQty: n })} />
              </div>
              <div className="sm:col-span-2">
                <span className="text-[10px] text-muted-foreground uppercase">Accepted</span>
                <NumberInput value={r.acceptedQty} min={0} max={r.receivedQty} onChange={(n) => updateRow(idx, { acceptedQty: n })} />
              </div>
              <div className="sm:col-span-2">
                <span className="text-[10px] text-muted-foreground uppercase">Rejected</span>
                <NumberInput value={r.rejectedQty} min={0} onChange={(n) => updateRow(idx, { rejectedQty: n })} />
              </div>
              <div className="col-span-2 sm:col-span-2 flex justify-end">
                <Button type="button" variant="ghost" size="sm"
                  onClick={() => setRows((rs) => rs.filter((_, i) => i !== idx))}>
                  <Trash2 className="h-3.5 w-3.5 text-red-600" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      </FormDialog>

      <Dialog open={!!detail} onOpenChange={(o) => !o && setDetail(null)}>
        <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>GRN {detail?.number}</DialogTitle>
            <DialogDescription>
              {detail?.po?.number || '—'} · {detail?.po?.supplier?.name || '—'} · <StatusBadge status={detail?.status} />
            </DialogDescription>
          </DialogHeader>
          {detail && (
            <div className="space-y-3 text-sm">
              <div className="rounded-lg border overflow-x-auto">
                <table className="w-full text-xs">
                  <thead><tr className="bg-muted/50">
                    <th className="text-left p-2">Item</th><th className="text-right p-2">Ordered</th>
                    <th className="text-right p-2">Received</th><th className="text-right p-2">Accepted</th>
                    <th className="text-right p-2">Rejected</th><th className="text-right p-2">QC</th>
                  </tr></thead>
                  <tbody>
                    {(detail.items ?? []).map((it) => (
                      <tr key={it.id} className="border-t">
                        <td className="p-2">{it.item?.name || '—'}</td>
                        <td className="p-2 text-right tabular-nums">{it.orderedQty}</td>
                        <td className="p-2 text-right tabular-nums">{it.receivedQty}</td>
                        <td className="p-2 text-right tabular-nums text-emerald-700">{it.acceptedQty}</td>
                        <td className="p-2 text-right tabular-nums text-red-600">{it.rejectedQty}</td>
                        <td className="p-2 text-right"><StatusBadge status={it.qcStatus || 'PENDING'} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {detail.notes && <p className="text-xs text-muted-foreground">Notes: {detail.notes}</p>}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
