'use client'

import * as React from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Plus, Printer, Trash2, Truck } from 'lucide-react'
import {
  Column, ConfirmAction, DataTable, DateCell, DateInput, Field, FormDialog, NumberInput,
  PageHeader, SelectInput, StatusBadge, TextInput, printHtml,
} from '@/components/erp/kit'
import { apiDelete, apiGet, apiPatch, apiPost, useList } from '@/lib/use-api'

interface SoRow { id: string; number: string; status: string }
interface SoDetail {
  id: string; number: string; status: string
  customer?: { name?: string | null; city?: string | null; state?: string | null } | null
  items?: { id: string; itemId: string; qty: number; dispatchedQty?: number; item?: { code?: string | null; name?: string | null; uom?: string | null } | null }[] | null
}
interface DeliveryRow {
  id: string; number: string; date: string; vehicleNo?: string | null; transporter?: string | null; status: string; notes?: string | null
  salesOrder?: { number?: string | null; customer?: { name?: string | null } | null } | null
  items?: { id: string; qty: number; item?: { name?: string | null; uom?: string | null } | null }[] | null
}
interface DraftRow { salesOrderItemId: string; itemId: string; label: string; uom: string; pending: number; qty: number }

const today = () => new Date().toISOString().slice(0, 10)
const DISPATCHABLE = ['CONFIRMED', 'IN_PRODUCTION', 'READY', 'PARTIALLY_DISPATCHED']

export default function DeliveriesModule({ companyId }: { companyId: string }) {
  const list = useList<{ items: DeliveryRow[] }>(`/api/deliveries?companyId=${companyId}`)
  const sos = useList<{ items: SoRow[] }>(`/api/sales-orders?companyId=${companyId}`)
  const warehouses = useList<{ items: { id: string; name?: string | null; code?: string | null }[] }>(`/api/warehouses?companyId=${companyId}`)

  const [open, setOpen] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [salesOrderId, setSalesOrderId] = React.useState('')
  const [warehouseId, setWarehouseId] = React.useState('')
  const [date, setDate] = React.useState(today)
  const [vehicleNo, setVehicleNo] = React.useState('')
  const [transporter, setTransporter] = React.useState('')
  const [notes, setNotes] = React.useState('')
  const [rows, setRows] = React.useState<DraftRow[]>([])

  const items = list.data?.items ?? []
  const soOpts = (sos.data?.items ?? [])
    .filter((so) => DISPATCHABLE.includes(so.status))
    .map((so) => ({ value: so.id, label: `${so.number} (${so.status.replaceAll('_', ' ')})` }))
  const whOpts = (warehouses.data?.items ?? []).map((w) => ({ value: w.id, label: w.name ? `${w.code || ''} ${w.name}`.trim() : w.code || w.id }))

  function resetForm() {
    setSalesOrderId(''); setWarehouseId(''); setDate(today()); setVehicleNo(''); setTransporter(''); setNotes(''); setRows([])
  }

  async function pickSo(sid: string) {
    setSalesOrderId(sid)
    if (!sid) { setRows([]); return }
    try {
      const so = await apiGet<SoDetail>(`/api/sales-orders/${sid}?companyId=${companyId}`)
      const mapped: DraftRow[] = (so.items ?? [])
        .filter((it) => it.qty - (it.dispatchedQty || 0) > 0)
        .map((it) => ({
          salesOrderItemId: it.id, itemId: it.itemId,
          label: it.item?.name ? `${it.item.code ? it.item.code + ' — ' : ''}${it.item.name}` : it.itemId,
          uom: it.item?.uom || '', pending: it.qty - (it.dispatchedQty || 0),
          qty: it.qty - (it.dispatchedQty || 0),
        }))
      setRows(mapped)
      toast.success(`Loaded ${mapped.length} pending line(s) from ${so.number}`)
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to load sales order') }
  }

  async function submit() {
    if (!salesOrderId) { toast.error('Select a sales order'); return }
    if (!warehouseId) { toast.error('Select a warehouse'); return }
    const valid = rows.filter((r) => r.qty > 0)
    if (!valid.length) { toast.error('No lines to deliver'); return }
    setSaving(true)
    try {
      await apiPost('/api/deliveries', {
        companyId, salesOrderId, warehouseId, date, vehicleNo: vehicleNo || undefined,
        transporter: transporter || undefined, notes: notes || undefined,
        lines: valid.map((r) => ({ salesOrderItemId: r.salesOrderItemId, itemId: r.itemId, qty: r.qty })),
      })
      toast.success('Delivery challan created (DRAFT)')
      setOpen(false); resetForm(); void list.refetch()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to create delivery') } finally { setSaving(false) }
  }

  async function dispatch(row: DeliveryRow) {
    try {
      await apiPatch(`/api/deliveries/${row.id}`, { action: 'dispatch', companyId })
      toast.success(`Challan ${row.number} dispatched — stock updated`)
      void list.refetch()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to dispatch') }
  }

  async function remove(row: DeliveryRow) {
    try {
      await apiDelete(`/api/deliveries/${row.id}?companyId=${companyId}`)
      toast.success('Challan deleted'); void list.refetch()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to delete') }
  }

  function printChallan(d: DeliveryRow) {
    const html = `
      <div class="head">
        <div><h1>Acme Precision Manufacturing Pvt Ltd</h1><div class="muted">Delivery Challan · ${d.number}</div></div>
        <div style="text-align:right"><span class="badge">${d.status}</span><br/>
          <div class="muted">Date: ${new Date(d.date).toLocaleDateString('en-IN')}</div></div>
      </div>
      <p><strong>Sales Order:</strong> ${d.salesOrder?.number || '—'} &nbsp; <strong>Customer:</strong> ${d.salesOrder?.customer?.name || '—'}</p>
      <p class="muted">Vehicle: ${d.vehicleNo || '—'} · Transporter: ${d.transporter || '—'}</p>
      <table>
        <thead><tr><th>#</th><th>Item</th><th class="num">Qty</th></tr></thead>
        <tbody>${(d.items ?? []).map((it, i) => `<tr><td>${i + 1}</td><td>${it.item?.name || '—'}</td><td class="num">${it.qty}${it.item?.uom ? ' ' + it.item.uom : ''}</td></tr>`).join('')}</tbody>
      </table>
      ${d.notes ? `<p class="muted">Notes: ${d.notes}</p>` : ''}
      <p class="muted">Receiver's signature: ______________________</p>`
    printHtml(`Delivery Challan ${d.number}`, html)
  }

  const columns: Column<DeliveryRow>[] = [
    { key: 'number', header: 'Challan #', render: (r) => <span className="font-medium">{r.number}</span> },
    { key: 'date', header: 'Date', render: (r) => <DateCell value={r.date} /> },
    { key: 'so', header: 'Sales Order', render: (r) => r.salesOrder?.number || '—' },
    { key: 'customer', header: 'Customer', render: (r) => r.salesOrder?.customer?.name || '—' },
    { key: 'vehicle', header: 'Vehicle', hideOnMobile: true, render: (r) => r.vehicleNo || '—' },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
    {
      key: 'actions', header: 'Actions',
      render: (r) => (
        <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
          <Button variant="ghost" size="sm" className="h-7" title="Print challan" onClick={() => printChallan(r)}><Printer className="h-3.5 w-3.5" /></Button>
          {r.status === 'DRAFT' && (
            <>
              <ConfirmAction
                trigger={<Button size="sm" className="h-7"><Truck className="h-3.5 w-3.5 mr-1" />Dispatch</Button>}
                title="Dispatch challan?" message={`Dispatch ${r.number}? This posts stock OUT of the warehouse.`}
                onConfirm={() => dispatch(r)}
              />
              <ConfirmAction
                trigger={<Button variant="ghost" size="sm" className="h-7 text-red-600"><Trash2 className="h-3.5 w-3.5" /></Button>}
                title="Delete challan?" message={`Delete draft challan ${r.number}?`} tone="destructive" onConfirm={() => remove(r)}
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
        title="Deliveries"
        description="Create delivery challans from sales orders and dispatch"
        actions={<Button onClick={() => { resetForm(); setOpen(true) }}><Plus className="h-4 w-4 mr-1.5" />New Delivery</Button>}
      />
      <DataTable columns={columns} rows={items} loading={list.loading} searchPlaceholder="Search deliveries…" />

      <FormDialog
        open={open} onOpenChange={setOpen} wide title="New Delivery Challan" submitLabel="Create Challan"
        description="Pick a sales order — pending quantities are pre-filled" loading={saving} onSubmit={submit}
      >
        <div className="grid sm:grid-cols-3 gap-4">
          <Field label="Sales Order" required>
            <SelectInput value={salesOrderId} onChange={(v) => void pickSo(v)} options={soOpts} placeholder="Select confirmed SO…" />
          </Field>
          <Field label="Warehouse" required><SelectInput value={warehouseId} onChange={setWarehouseId} options={whOpts} /></Field>
          <Field label="Date" required><DateInput value={date} onChange={setDate} /></Field>
          <Field label="Vehicle No"><TextInput value={vehicleNo} onChange={(e) => setVehicleNo(e.target.value)} placeholder="MH 12 AB 3456" /></Field>
          <Field label="Transporter"><TextInput value={transporter} onChange={(e) => setTransporter(e.target.value)} placeholder="Transporter name" /></Field>
          <Field label="Notes"><TextInput value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Remarks…" /></Field>
        </div>

        <div className="space-y-2">
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Lines (editable qty, max = pending)</span>
          {!salesOrderId && <p className="text-sm text-muted-foreground">Select a sales order to load pending lines.</p>}
          {rows.map((r, idx) => (
            <div key={r.salesOrderItemId || idx} className="flex gap-2 items-center">
              <span className="flex-1 min-w-0 truncate text-sm">{r.label}</span>
              <span className="text-xs text-muted-foreground whitespace-nowrap">pending {r.pending}{r.uom ? ` ${r.uom}` : ''}</span>
              <NumberInput
                className="w-24" value={r.qty} min={0} max={r.pending}
                onChange={(n) => setRows((rs) => rs.map((x, i) => (i === idx ? { ...x, qty: Math.min(n, x.pending) } : x)))}
              />
            </div>
          ))}
        </div>
      </FormDialog>
    </div>
  )
}
