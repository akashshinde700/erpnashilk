'use client'

import * as React from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Ban, Plus, Printer, Trash2, Truck } from 'lucide-react'
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
interface CompanyBlock { name?: string | null; gstin?: string | null; addressLine?: string | null; city?: string | null; state?: string | null; stateCode?: string | null; phone?: string | null; email?: string | null }
interface DeliveryRow {
  id: string; number: string; date: string; vehicleNo?: string | null; transporter?: string | null; ewayBillNo?: string | null; status: string; notes?: string | null
  salesOrder?: { number?: string | null; customer?: { name?: string | null; gstin?: string | null; addressLine?: string | null; city?: string | null; state?: string | null; stateCode?: string | null } | null } | null
  warehouse?: { id?: string; code?: string | null; name?: string | null; location?: string | null } | null
  company?: CompanyBlock | null
  items?: { id: string; qty: number; item?: { code?: string | null; name?: string | null; uom?: string | null; hsn?: string | null } | null }[] | null
}
interface DraftRow { salesOrderItemId: string; itemId: string; label: string; uom: string; pending: number; qty: number }

const today = () => new Date().toISOString().slice(0, 10)
const DISPATCHABLE = ['CONFIRMED', 'IN_PRODUCTION', 'READY', 'PARTIALLY_DISPATCHED']

// Escape a value for interpolation into the print-window HTML.
const esc = (v?: string | null) =>
  (v ?? '').replace(/[&<>"]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'))
// Join non-empty address parts with ', ' (raw — wrap the result in esc() before injecting).
const joinAddr = (...parts: (string | null | undefined)[]) =>
  parts.filter((p): p is string => !!p && p.trim() !== '').join(', ')

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

  async function cancel(row: DeliveryRow) {
    try {
      await apiPatch(`/api/deliveries/${row.id}`, { action: 'cancel', companyId })
      toast.success(`Challan ${row.number} cancelled`)
      void list.refetch()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to cancel') }
  }

  async function remove(row: DeliveryRow) {
    try {
      await apiDelete(`/api/deliveries/${row.id}?companyId=${companyId}`)
      toast.success('Challan deleted'); void list.refetch()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to delete') }
  }

  async function printChallan(row: DeliveryRow) {
    // Prefer the detail endpoint — it returns the full consignee (address/GSTIN/state code),
    // item master info (code/uom/HSN), the dispatch warehouse and the consignor company block.
    let d: DeliveryRow = row
    try {
      const detail = await apiGet<DeliveryRow>(`/api/deliveries/${row.id}?companyId=${companyId}`)
      if (detail) {
        d = { ...row, ...detail, salesOrder: detail.salesOrder ?? row.salesOrder, items: detail.items ?? row.items }
      }
    } catch { /* fall back to the list row */ }

    const consignor = d.company
    const consignorName = consignor?.name || 'Acme Precision Manufacturing Pvt Ltd'
    const cust = d.salesOrder?.customer
    const custStateCode = cust?.stateCode || (cust?.gstin ? cust.gstin.slice(0, 2) : '')
    const wh = d.warehouse
    const whLabel = wh ? joinAddr(wh.code, wh.name, wh.location) : ''

    const html = `
      <style>
        .dc-form { border: 1.5px solid #333; }
        .dc-form table { margin-top: 0; }
        .dc-form th, .dc-form td { border-color: #444; }
        .dc-form .grid td { vertical-align: top; padding: 8px 10px; }
        .dc-form .bare td { border: none; padding: 5px 10px; vertical-align: top; }
        .dc-form .sec { font-size: 9px; font-weight: 700; letter-spacing: 1px; text-transform: uppercase; color: #555; margin-bottom: 4px; }
        .dc-form .title { text-align: center; font-size: 15px; font-weight: 800; letter-spacing: 4px; padding: 7px 10px; border-bottom: 1.5px solid #333; }
        .dc-form .signline { border-top: 1px solid #333; margin-top: 56px; padding-top: 5px; font-size: 11px; text-align: center; }
        .dc-form .footer { border-top: 1.5px solid #333; padding: 6px 10px; font-size: 10px; color: #444; text-align: center; line-height: 1.6; }
      </style>
      <div class="dc-form">
        <div class="title">DELIVERY CHALLAN</div>
        <div class="head" style="padding:10px 12px">
          <div>
            <h1 style="font-size:17px">${esc(consignorName)}</h1>
            <div class="muted">${esc(joinAddr(consignor?.addressLine, consignor?.city, consignor?.state)) || '&nbsp;'}</div>
            <div class="muted">${consignor?.gstin ? `GSTIN: ${esc(consignor.gstin)}` : ''}</div>
            <div class="muted">${esc(joinAddr(consignor?.phone, consignor?.email))}</div>
          </div>
          <div style="text-align:right">
            <div style="font-size:13px"><strong>Challan No: ${esc(d.number)}</strong></div>
            <div class="muted">Date: ${new Date(d.date).toLocaleDateString('en-IN')}</div>
            <div class="muted">Against SO: ${esc(d.salesOrder?.number || '—')}</div>
            ${d.vehicleNo ? `<div class="muted">Vehicle No: ${esc(d.vehicleNo)}</div>` : ''}
            <span class="badge">${esc(d.status)}</span>
          </div>
        </div>
        <table class="grid"><tr>
          <td style="width:58%">
            <div class="sec">Consignee (Ship To)</div>
            <strong style="font-size:13px">${esc(cust?.name || '—')}</strong>
            <div class="muted">${esc(joinAddr(cust?.addressLine, cust?.city)) || '&nbsp;'}</div>
            <div class="muted">${cust?.gstin ? `GSTIN: ${esc(cust.gstin)}` : ''}</div>
            <div class="muted">${esc(joinAddr(cust?.state, custStateCode ? `State Code: ${custStateCode}` : ''))}</div>
          </td>
          <td style="width:42%">
            <div class="sec">Dispatch Details</div>
            <table class="bare">
              <tr><td class="muted">Dispatch From</td><td style="text-align:right"><strong>${esc(whLabel || '—')}</strong></td></tr>
              <tr><td class="muted">Vehicle No</td><td style="text-align:right">${esc(d.vehicleNo || '—')}</td></tr>
              <tr><td class="muted">Transporter</td><td style="text-align:right">${esc(d.transporter || '—')}</td></tr>
              ${d.ewayBillNo ? `<tr><td class="muted">E-Way Bill No</td><td style="text-align:right">${esc(d.ewayBillNo)}</td></tr>` : ''}
            </table>
          </td>
        </tr></table>
        <table>
          <thead><tr><th style="width:26px">#</th><th>Description of Goods</th><th style="width:70px">HSN</th><th class="num" style="width:80px">Qty</th><th style="width:120px">Remarks</th></tr></thead>
          <tbody>${(d.items ?? []).map((it, i) =>
            `<tr><td>${i + 1}</td><td>${esc(it.item?.name || '—')}${it.item?.code ? ` <span class="muted">(${esc(it.item.code)})</span>` : ''}</td><td>${esc(it.item?.hsn || '—')}</td><td class="num">${it.qty}${it.item?.uom ? ` ${esc(it.item.uom)}` : ''}</td><td></td></tr>`
          ).join('')}</tbody>
        </table>
        ${d.notes ? `<div class="muted" style="padding:6px 10px;border-top:1px solid #444">Notes: ${esc(d.notes)}</div>` : ''}
        <div style="padding:8px 10px;border-top:1px solid #444">
          <div class="sec">Declaration</div>
          <div style="font-size:10.5px;line-height:1.7;color:#444">Goods described above are being delivered for further manufacturing/processing. We declare that the particulars given above are true and correct.</div>
        </div>
        <table class="bare"><tr>
          <td style="width:58%"><div class="signline">Receiver's Signature</div></td>
          <td style="width:42%;text-align:right">
            <div style="font-weight:700;font-size:12px;text-align:left">For ${esc(consignorName)}</div>
            <div class="signline">Authorised Signatory</div>
          </td>
        </tr></table>
        <div class="footer">This is a computer-generated delivery challan.</div>
      </div>`
    printHtml(`Delivery Challan ${row.number}`, html)
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
          <Button variant="ghost" size="sm" className="h-7" title="Print delivery challan" onClick={() => void printChallan(r)}><Printer className="h-3.5 w-3.5" /></Button>
          {r.status === 'DRAFT' && (
            <>
              <ConfirmAction
                trigger={<Button size="sm" className="h-7"><Truck className="h-3.5 w-3.5 mr-1" />Dispatch</Button>}
                title="Dispatch challan?" message={`Dispatch ${r.number}? This posts stock OUT of the warehouse.`}
                onConfirm={() => dispatch(r)}
              />
              <ConfirmAction
                trigger={<Button variant="ghost" size="sm" className="h-7" title="Cancel challan (keeps the record)"><Ban className="h-3.5 w-3.5" /></Button>}
                title="Cancel challan?" message={`Cancel draft challan ${r.number}? It stays in the list as CANCELLED.`} tone="destructive" onConfirm={() => cancel(r)}
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
