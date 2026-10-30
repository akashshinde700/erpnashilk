'use client'

import * as React from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { CheckCircle2, Factory, Plus, Printer, Receipt, Trash2, Truck, X } from 'lucide-react'
import {
  Column, ConfirmAction, DataTable, DateCell, DateInput, Field, FormDialog, Money,
  NumberInput, PageHeader, SelectInput, StatusBadge, TextInput, openCreate, printHtml, useRowHighlight, useCreatePreset
} from '@/components/erp/kit'
import { apiGet, apiPatch, apiPost, useList } from '@/lib/use-api'
import { fmtMoney } from '@/lib/erp-constants'
import { baseQtyHint, convertRate, defaultSellRate, inclGstHint, lineToBase, unitOptions } from '@/lib/units'
import { ItemPicker, QuickItemDialog, ScanToAdd, pickIntoLines, scanIntoLines, type PickerItem } from '@/components/erp/item-picker'

interface PartyRow { id: string; name?: string | null; code?: string | null }
interface ItemRow { id: string; code?: string | null; name?: string | null; uom?: string | null; sellingPrice?: number | null; gstRate?: number | null; barcode?: string | null; partNo?: string | null
  altUom?: string | null; altFactor?: number | null; mrp?: number | null; priceIncludesTax?: boolean | null }
interface SoItem { id: string; itemId: string; qty: number; rate: number; discountPct: number; gstRate: number; lineTotal: number; dispatchedQty?: number; invoicedQty?: number; item?: { code?: string | null; name?: string | null; uom?: string | null } | null }
interface SoRow {
  id: string; number: string; orderDate: string; deliveryDate?: string | null; status: string
  subtotal: number; discountTotal: number; cgst: number; sgst: number; igst: number; grandTotal: number
  notes?: string | null; customerId?: string | null
  customerPoNo?: string | null; customerPoDate?: string | null
  paymentTerms?: string | null; deliveryTerms?: string | null; shippingAddress?: string | null
  customer?: { name?: string | null; city?: string | null; state?: string | null; gstin?: string | null } | null
  items?: SoItem[] | null
}
// unit: the item's secondary unit when chosen (qty/rate are then per that unit; converted to base on save)
interface DraftLine { itemId: string; qty: number; rate: number; discountPct: number; gstRate: number; unit?: string }
interface LastRate { rate: number; discountPct: number; date: string; ref: string }

// Rate last billed to this customer for an item (null when never sold to them / on error).
async function lastRateFor(companyId: string, customerId: string, itemId: string): Promise<LastRate | null> {
  try {
    const r = await apiGet<{ rates?: Record<string, LastRate> }>(`/api/parties/last-rates?companyId=${companyId}&kind=customer&partyId=${encodeURIComponent(customerId)}&itemIds=${encodeURIComponent(itemId)}`)
    return r.rates?.[itemId] ?? null
  } catch { return null }
}
interface BomRow { id: string; code?: string | null; version?: string | null; outputItemId?: string | null }

const r2 = (n: number) => Math.round(n * 100) / 100
const today = () => new Date().toISOString().slice(0, 10)

function computeTotals(lines: DraftLine[]) {
  let subtotal = 0, discount = 0, gst = 0
  for (const l of lines) {
    const gross = l.qty * l.rate
    const disc = gross * ((l.discountPct || 0) / 100)
    const net = gross - disc
    subtotal += gross; discount += disc; gst += net * ((l.gstRate || 0) / 100)
  }
  return { subtotal: r2(subtotal), discount: r2(discount), cgst: r2(gst / 2), sgst: r2(gst / 2), grand: r2(subtotal - discount + gst) }
}

// Minimal HTML escaping for user-entered text dropped into the print template
function esc(v: string | null | undefined): string {
  return (v || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

const DISPATCHABLE = ['CONFIRMED', 'IN_PRODUCTION', 'READY', 'PARTIALLY_DISPATCHED']
const INVOICEABLE = ['CONFIRMED', 'IN_PRODUCTION', 'READY', 'PARTIALLY_DISPATCHED', 'DISPATCHED']
const CLOSABLE = ['DISPATCHED', 'PARTIALLY_DISPATCHED']

// Every line fully invoiced → nothing left to bill on this order
function fullyInvoiced(so: SoRow): boolean {
  const ls = so.items ?? []
  return ls.length > 0 && ls.every((l) => (l.invoicedQty ?? 0) >= l.qty - 0.005)
}

function emptyLine(): DraftLine { return { itemId: '', qty: 1, rate: 0, discountPct: 0, gstRate: 18 } }

export default function SalesOrdersModule({ companyId }: { companyId: string }) {
  const highlightId = useRowHighlight('sales-orders')
  const list = useList<{ items: SoRow[] }>(`/api/sales-orders?companyId=${companyId}`)
  const customers = useList<{ items: PartyRow[] }>(`/api/customers?companyId=${companyId}`)
  const items = useList<{ items: ItemRow[] }>(`/api/items?companyId=${companyId}`)
  const quotations = useList<{ items: { id: string; number: string }[] }>(`/api/quotations?companyId=${companyId}`)
  const warehouses = useList<{ items: PartyRow[] }>(`/api/warehouses?companyId=${companyId}`)
  const boms = useList<{ items: BomRow[] }>(`/api/boms?companyId=${companyId}`)

  const [open, setOpen] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [customerId, setCustomerId] = React.useState('')
  const [quotationId, setQuotationId] = React.useState('')
  const [orderDate, setOrderDate] = React.useState(today)
  const [deliveryDate, setDeliveryDate] = React.useState('')
  const [notes, setNotes] = React.useState('')
  const [status, setStatus] = React.useState('CONFIRMED')
  const [customerPoNo, setCustomerPoNo] = React.useState('')
  const [customerPoDate, setCustomerPoDate] = React.useState('')
  const [paymentTerms, setPaymentTerms] = React.useState('')
  const [deliveryTerms, setDeliveryTerms] = React.useState('')
  const [shippingAddress, setShippingAddress] = React.useState('')
  const [lines, setLines] = React.useState<DraftLine[]>([emptyLine()])
  const [detail, setDetail] = React.useState<SoRow | null>(null)
  const [newItemFor, setNewItemFor] = React.useState<{ idx: number; name: string } | null>(null)
  const [lastHints, setLastHints] = React.useState<Record<string, string>>({})

  // ---- plan work order dialog ----
  const [woRow, setWoRow] = React.useState<SoRow | null>(null)
  const [planning, setPlanning] = React.useState(false)
  const [woItemId, setWoItemId] = React.useState('')
  const [woBomId, setWoBomId] = React.useState('')
  const [woWarehouseId, setWoWarehouseId] = React.useState('')
  const [woQty, setWoQty] = React.useState(0)
  const [woStartDate, setWoStartDate] = React.useState(today)
  const [woDueDate, setWoDueDate] = React.useState('')
  const [woPriority, setWoPriority] = React.useState('NORMAL')
  const [woNotes, setWoNotes] = React.useState('')

  const rows = list.data?.items ?? []
  const customerOpts = (customers.data?.items ?? []).map((c) => ({ value: c.id, label: c.name || c.id }))
  const itemRows = items.data?.items ?? []
  const itemRow = (itemId: string) => itemRows.find((o) => o.id === itemId)
  const quotationOpts = (quotations.data?.items ?? []).filter((q) => q.number).map((q) => ({ value: q.id, label: q.number }))
  const whOpts = (warehouses.data?.items ?? []).map((w) => ({ value: w.id, label: w.code && w.name ? `${w.code} — ${w.name}` : w.name || w.code || w.id }))
  const woItemOpts = (woRow?.items ?? []).filter((l) => l.itemId).map((l) => {
    const it = (items.data?.items ?? []).find((o) => o.id === l.itemId)
    const code = l.item?.code || it?.code || ''
    const name = l.item?.name || it?.name || ''
    return { value: l.itemId, label: code && name ? `${code} — ${name}` : name || l.itemId }
  })
  // /api/boms GET has no itemId filter — filter client-side to the selected item's output
  const woBomOpts = (boms.data?.items ?? []).filter((b) => b.outputItemId === woItemId)

  /** Set a line's item (rate/GST from the item master); an item already on another line adds this qty there instead. */
  function pickItem(idx: number, it: PickerItem) {
    const r = pickIntoLines(lines, idx, it.id, (x) => ({ ...x, itemId: it.id, rate: x.rate || defaultSellRate(itemRow(it.id) ?? it), gstRate: it.gstRate ?? x.gstRate, unit: it.id === x.itemId ? x.unit : undefined }))
    if (r.merged) toast.info('Item already on this order — quantity added to that line')
    setLines(r.lines)
    if (!r.merged) void applyLastRate(it.id)
  }

  /** The customer's last billed rate/discount for this item replaces the master selling price. */
  async function applyLastRate(itemId: string) {
    if (!customerId) return
    const lr = await lastRateFor(companyId, customerId, itemId)
    if (!lr) return
    setLines((ls) => ls.map((x) => (x.itemId === itemId ? { ...x, rate: convertRate(lr.rate, undefined, x.unit, itemRow(itemId)), discountPct: lr.discountPct ?? x.discountPct } : x)))
    setLastHints((h) => ({ ...h, [itemId]: `Last rate ₹${lr.rate} on ${lr.ref}` }))
  }

  // Barcode scan: +1 on the item's line, or a new line priced from the item master
  function scanItem(it: PickerItem) {
    setLines((ls) => scanIntoLines(ls, it.id, () => ({ ...emptyLine(), itemId: it.id, qty: 1, rate: defaultSellRate(itemRow(it.id) ?? it), gstRate: it.gstRate ?? emptyLine().gstRate })))
  }

  function resetForm() {
    setCustomerId(''); setQuotationId(''); setOrderDate(today()); setDeliveryDate(''); setNotes(''); setStatus('CONFIRMED')
    setCustomerPoNo(''); setCustomerPoDate(''); setPaymentTerms(''); setDeliveryTerms(''); setShippingAddress('')
    setLines([emptyLine()])
  }

  // Shortcuts from other screens (party view, row actions, quick actions) open this form pre-filled
  useCreatePreset('sales-orders', (d) => {
    resetForm()
    if (d.quotationId) void pickQuotation(String(d.quotationId))
    else if (d.customerId) setCustomerId(String(d.customerId))
    setOpen(true)
  })

  async function pickQuotation(qid: string) {
    setQuotationId(qid)
    if (!qid) return
    try {
      const qt = await apiGet<SoRow>(`/api/quotations/${qid}?companyId=${companyId}`)
      if (qt.customerId) setCustomerId(qt.customerId)
      if (qt.paymentTerms) setPaymentTerms(qt.paymentTerms)
      if (qt.deliveryTerms) setDeliveryTerms(qt.deliveryTerms)
      const mapped = (qt.items ?? []).map((it) => ({ itemId: it.itemId, qty: it.qty, rate: it.rate, discountPct: it.discountPct, gstRate: it.gstRate }))
      setLines(mapped.length ? mapped : [emptyLine()])
      toast.success(`Loaded ${qt.items?.length ?? 0} line(s) from quotation ${qt.number}`)
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to load quotation') }
  }

  async function submit() {
    if (!customerId) { toast.error('Select a customer'); return }
    // qty / rate go to the API in the item's base unit
    const valid = lines.filter((l) => l.itemId && l.qty > 0).map((l) => lineToBase(l, itemRow(l.itemId)))
    if (!valid.length) { toast.error('Add at least one line with item and qty'); return }
    setSaving(true)
    try {
      await apiPost('/api/sales-orders', {
        companyId, customerId, quotationId: quotationId || undefined, orderDate,
        deliveryDate: deliveryDate || undefined, notes: notes || undefined, status, items: valid,
        customerPoNo: customerPoNo || undefined, customerPoDate: customerPoDate || undefined,
        paymentTerms: paymentTerms || undefined, deliveryTerms: deliveryTerms || undefined,
        shippingAddress: shippingAddress || undefined,
      })
      toast.success('Sales order created')
      setOpen(false); resetForm(); void list.refetch()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to create sales order') } finally { setSaving(false) }
  }

  async function action(row: SoRow, act: string, successMsg: string) {
    try {
      await apiPatch(`/api/sales-orders/${row.id}`, { action: act, companyId })
      toast.success(successMsg); void list.refetch()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed') }
  }

  function printSo(so: SoRow) {
    const items2 = so.items ?? []
    const html = `
      <div class="head">
        <div><h1>Acme Precision Manufacturing Pvt Ltd</h1><div class="muted">Sales Order · ${so.number}</div></div>
        <div style="text-align:right"><span class="badge">${so.status}</span><br/>
          <div class="muted">Order date: ${new Date(so.orderDate).toLocaleDateString('en-IN')}</div>
          ${so.deliveryDate ? `<div class="muted">Delivery: ${new Date(so.deliveryDate).toLocaleDateString('en-IN')}</div>` : ''}</div>
      </div>
      <p><strong>Customer:</strong> ${so.customer?.name || '—'}${so.customer?.gstin ? ` · GSTIN ${so.customer.gstin}` : ''}
      ${so.customer?.city ? `<br/><span class="muted">${so.customer.city}${so.customer.state ? ', ' + so.customer.state : ''}</span>` : ''}
      ${so.customerPoNo ? `<br/><strong>Customer PO:</strong> ${esc(so.customerPoNo)}${so.customerPoDate ? ` dt. ${new Date(so.customerPoDate).toLocaleDateString('en-IN')}` : ''}` : ''}</p>
      ${so.shippingAddress ? `<p><strong>Ship To:</strong><br/><span style="white-space:pre-wrap">${esc(so.shippingAddress)}</span></p>` : ''}
      <table>
        <thead><tr><th>#</th><th>Item</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">Disc %</th><th class="num">GST %</th><th class="num">Amount</th></tr></thead>
        <tbody>${items2.map((it, i) => `<tr><td>${i + 1}</td><td>${it.item?.name || it.itemId}</td><td class="num">${it.qty}${it.item?.uom ? ' ' + it.item.uom : ''}</td><td class="num">${fmtMoney(it.rate)}</td><td class="num">${it.discountPct}%</td><td class="num">${it.gstRate}%</td><td class="num">${fmtMoney(it.lineTotal)}</td></tr>`).join('')}</tbody>
      </table>
      <table class="totals" style="width:280px;margin-left:auto">
        <tr><td>Subtotal</td><td class="num">${fmtMoney(so.subtotal)}</td></tr>
        <tr><td>Discount</td><td class="num">- ${fmtMoney(so.discountTotal)}</td></tr>
        <tr><td>CGST</td><td class="num">${fmtMoney(so.cgst)}</td></tr>
        <tr><td>SGST</td><td class="num">${fmtMoney(so.sgst)}</td></tr>
        ${so.igst ? `<tr><td>IGST</td><td class="num">${fmtMoney(so.igst)}</td></tr>` : ''}
        <tr class="grand"><td>Grand Total</td><td class="num">${fmtMoney(so.grandTotal)}</td></tr>
      </table>
      ${so.paymentTerms ? `<p><strong>Payment Terms:</strong> ${esc(so.paymentTerms)}</p>` : ''}
      ${so.deliveryTerms ? `<p><strong>Delivery Terms:</strong> ${esc(so.deliveryTerms)}</p>` : ''}
      ${so.notes ? `<p class="muted">Notes: ${esc(so.notes)}</p>` : ''}`
    printHtml(`Sales Order ${so.number}`, html)
  }

  function resetWoPlan() {
    setWoItemId(''); setWoQty(0); setWoBomId(''); setWoWarehouseId('')
    setWoStartDate(today()); setWoDueDate(''); setWoPriority('NORMAL'); setWoNotes('')
  }

  function openWo(row: SoRow) {
    resetWoPlan()
    const first = (row.items ?? []).find((l) => l.itemId)
    setWoRow(row); setWoItemId(first?.itemId || ''); setWoQty(first?.qty || 0)
  }

  function onWoItemChange(v: string) {
    setWoItemId(v)
    const line = (woRow?.items ?? []).find((l) => l.itemId === v)
    setWoQty(line?.qty || 0)
    setWoBomId('')
  }

  async function submitWo() {
    if (!woRow) return
    if (!woItemId) { toast.error('Select an item'); return }
    if (!woWarehouseId) { toast.error('Select a warehouse'); return }
    if (!(woQty > 0)) { toast.error('Planned qty must be greater than 0'); return }
    setPlanning(true)
    try {
      const wo = await apiPost<{ id: string; number: string }>('/api/work-orders', {
        companyId, itemId: woItemId, bomId: woBomId || undefined, salesOrderId: woRow.id,
        warehouseId: woWarehouseId, plannedQty: woQty, startDate: woStartDate,
        dueDate: woDueDate || undefined, priority: woPriority || undefined, notes: woNotes || undefined,
      })
      setWoRow(null); resetWoPlan()
      toast.success(`Work order ${wo.number} planned from ${woRow.number}`)
      try {
        window.sessionStorage.setItem('erp_deep_link', JSON.stringify({ module: 'work-orders', id: wo.id, ts: Date.now() }))
        window.dispatchEvent(new CustomEvent('erp:deep-link', { detail: { module: 'work-orders', id: wo.id } }))
      } catch { /* private mode */ }
      window.dispatchEvent(new CustomEvent('erp:goto', { detail: 'work-orders' }))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to plan work order')
    } finally { setPlanning(false) }
  }

  const totals = computeTotals(lines.map((l) => lineToBase(l, itemRow(l.itemId))))

  const columns: Column<SoRow>[] = [
    { key: 'number', header: 'SO #', render: (r) => <span className="font-medium">{r.number}</span> },
    { key: 'orderDate', header: 'Order Date', render: (r) => <DateCell value={r.orderDate} /> },
    { key: 'customer', header: 'Customer', render: (r) => r.customer?.name || '—' },
    { key: 'total', header: 'Grand Total', render: (r) => <Money value={r.grandTotal} className="font-medium" /> },
    { key: 'delivery', header: 'Delivery', hideOnMobile: true, render: (r) => <DateCell value={r.deliveryDate} /> },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
    {
      key: 'actions', header: 'Actions',
      render: (r) => (
        <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
          <Button variant="ghost" size="sm" className="h-7" title="Print" onClick={() => printSo(r)}><Printer className="h-3.5 w-3.5" /></Button>
          {(r.status === 'CONFIRMED' || r.status === 'IN_PRODUCTION') && (
            <Button variant="ghost" size="sm" className="h-7" title="Plan Work Order" aria-label="Plan Work Order" onClick={() => openWo(r)}>
              <Factory className="h-3.5 w-3.5" />
            </Button>
          )}
          {DISPATCHABLE.includes(r.status) && (
            <Button variant="ghost" size="sm" className="h-7" title="Create Delivery Challan" onClick={() => openCreate('deliveries', { soId: r.id })}>
              <Truck className="h-3.5 w-3.5 mr-1" />Dispatch
            </Button>
          )}
          {INVOICEABLE.includes(r.status) && !fullyInvoiced(r) && (
            <Button variant="ghost" size="sm" className="h-7" title="Create Sales Invoice" onClick={() => openCreate('sales-invoices', { soId: r.id })}>
              <Receipt className="h-3.5 w-3.5 mr-1" />Invoice
            </Button>
          )}
          {CLOSABLE.includes(r.status) && (
            <ConfirmAction
              trigger={<Button variant="ghost" size="sm" className="h-7" title="Close sales order"><CheckCircle2 className="h-3.5 w-3.5 mr-1" />Close</Button>}
              title="Close sales order?"
              message={`Mark ${r.number} as COMPLETED? Any undispatched or uninvoiced balance will no longer show as pending.`}
              onConfirm={() => action(r, 'close', `Sales order ${r.number} closed`)}
            />
          )}
          {r.status === 'DRAFT' && (
            <>
              <Button variant="outline" size="sm" className="h-7" onClick={() => void action(r, 'confirm', `Sales order ${r.number} confirmed`)}>Confirm</Button>
              <ConfirmAction
                trigger={<Button variant="ghost" size="sm" className="h-7 text-destructive"><X className="h-3.5 w-3.5" /></Button>}
                title="Cancel sales order?" message={`Cancel ${r.number}? This cannot be undone.`} tone="destructive"
                onConfirm={() => action(r, 'cancel', `Sales order ${r.number} cancelled`)}
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
        title="Sales Orders"
        description="Confirmed customer orders feeding production and dispatch"
        actions={<Button onClick={() => { resetForm(); setOpen(true) }}><Plus className="h-4 w-4 mr-1.5" />Sales Order</Button>}
      />
      <DataTable
        columns={columns} rows={rows} loading={list.loading} searchPlaceholder="Search sales orders…" onRowClick={(r) => setDetail(r)}
        highlightId={highlightId}
        moduleKey="sales-orders"
        savedViewsKey={`${companyId}:sales-orders`}
        csvExport={{
          filename: 'sales-orders',
          pick: (r) => [r.number, new Date(r.orderDate).toISOString().slice(0, 10), r.customer?.name || '', r.status, r.items?.length ?? 0, r.subtotal, r.discountTotal, r.cgst, r.sgst, r.igst, r.grandTotal],
        }}
        xlsxExport={{
          filename: 'sales-orders',
          pick: (r) => [r.number, new Date(r.orderDate).toISOString().slice(0, 10), r.customer?.name || '', r.status, r.items?.length ?? 0, r.subtotal, r.discountTotal, r.cgst, r.sgst, r.igst, r.grandTotal],
        }}
      />

      <FormDialog
        open={open} onOpenChange={setOpen} wide title="Sales Order" submitLabel="Create Sales Order"
        description="Pick an APPROVED quotation to auto-fill lines (GST split preview: CGST+SGST)" loading={saving} onSubmit={submit}
      >
        <div className="grid sm:grid-cols-3 gap-4">
          <Field label="Customer" required><SelectInput value={customerId} onChange={setCustomerId} options={customerOpts} /></Field>
          <Field label="From Quotation (optional)">
            <SelectInput value={quotationId} onChange={(v) => void pickQuotation(v)} options={[{ value: '', label: '— None —' }, ...quotationOpts]} />
          </Field>
          <Field label="Order Date" required><DateInput value={orderDate} onChange={setOrderDate} /></Field>
          <Field label="Delivery Date"><DateInput value={deliveryDate} onChange={setDeliveryDate} /></Field>
          <Field label="Status"><SelectInput value={status} onChange={setStatus} options={[{ value: 'CONFIRMED', label: 'Confirmed' }, { value: 'DRAFT', label: 'Draft' }]} /></Field>
          <Field label="Customer PO No."><TextInput value={customerPoNo} onChange={(e) => setCustomerPoNo(e.target.value)} placeholder="Buyer's PO reference" /></Field>
          <Field label="Customer PO Date"><DateInput value={customerPoDate} onChange={setCustomerPoDate} /></Field>
          <Field label="Payment Terms"><TextInput value={paymentTerms} onChange={(e) => setPaymentTerms(e.target.value)} placeholder="e.g. 30 days from invoice" /></Field>
          <Field label="Delivery Terms"><TextInput value={deliveryTerms} onChange={(e) => setDeliveryTerms(e.target.value)} placeholder="e.g. Door delivery" /></Field>
          <Field label="Notes" className="sm:col-span-2"><TextInput value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Special instructions…" /></Field>
          <Field label="Shipping Address" className="sm:col-span-3">
            <Textarea value={shippingAddress} onChange={(e) => setShippingAddress(e.target.value)} rows={2} placeholder="Leave blank if same as billing address" />
          </Field>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Lines</span>
            <div className="flex items-center gap-2">
              <ScanToAdd items={itemRows} onScan={scanItem} className="w-44 sm:w-56" />
              <Button type="button" variant="outline" size="sm" onClick={() => setLines((ls) => [...ls, emptyLine()])}>
                <Plus className="h-3.5 w-3.5 mr-1" />Add Line
              </Button>
            </div>
          </div>
          {lines.map((l, idx) => (
            <div key={idx} className="grid grid-cols-12 gap-2 items-center">
              <div className="col-span-12 sm:col-span-4">
                <ItemPicker
                  items={itemRows}
                  value={l.itemId}
                  onChange={(id) => { const it = itemRows.find((o) => o.id === id); if (it) pickItem(idx, it) }}
                  onCreate={(typed) => setNewItemFor({ idx, name: typed })}
                />
              </div>
              <div className="col-span-3 sm:col-span-2 grid gap-0.5">
                <div className="flex gap-1">
                  <NumberInput className="min-w-0 flex-1" value={l.qty} min={0} placeholder="Qty"
                    onChange={(n) => setLines((ls) => ls.map((x, i) => (i === idx ? { ...x, qty: n } : x)))} />
                  {unitOptions(itemRow(l.itemId)).length > 0 && (
                    <div className="w-20 shrink-0">
                      <SelectInput value={l.unit || itemRow(l.itemId)?.uom || ''} options={unitOptions(itemRow(l.itemId))}
                        onChange={(u) => setLines((ls) => ls.map((x, i) => (i === idx ? { ...x, unit: u, rate: convertRate(x.rate, x.unit, u, itemRow(x.itemId)) } : x)))} />
                    </div>
                  )}
                </div>
                {baseQtyHint(l.qty, l.unit, itemRow(l.itemId)) && <span className="text-[10px] leading-tight text-muted-foreground">{baseQtyHint(l.qty, l.unit, itemRow(l.itemId))}</span>}
              </div>
              <div className="col-span-3 sm:col-span-2 grid gap-0.5">
                <NumberInput value={l.rate} min={0} placeholder="Rate" title={lastHints[l.itemId] || undefined}
                  onChange={(n) => setLines((ls) => ls.map((x, i) => (i === idx ? { ...x, rate: n } : x)))} />
                {!lastHints[l.itemId] && inclGstHint(itemRow(l.itemId), l.unit) && <span className="text-[10px] leading-tight text-muted-foreground truncate">{inclGstHint(itemRow(l.itemId), l.unit)}</span>}
              </div>
              <NumberInput className="col-span-3 sm:col-span-1" value={l.discountPct} min={0} placeholder="Disc %"
                onChange={(n) => setLines((ls) => ls.map((x, i) => (i === idx ? { ...x, discountPct: n } : x)))} />
              <NumberInput className="col-span-2 sm:col-span-1" value={l.gstRate} min={0} placeholder="GST %"
                onChange={(n) => setLines((ls) => ls.map((x, i) => (i === idx ? { ...x, gstRate: n } : x)))} />
              <div className="col-span-1 flex justify-end">
                <Button type="button" variant="ghost" size="sm" disabled={lines.length <= 1}
                  onClick={() => setLines((ls) => ls.filter((_, i) => i !== idx))}>
                  <Trash2 className="h-3.5 w-3.5 text-destructive" />
                </Button>
              </div>
            </div>
          ))}
          <div className="rounded-md border bg-muted/30 p-3 text-sm grid grid-cols-2 sm:grid-cols-5 gap-2">
            <TotCell label="Subtotal" value={totals.subtotal} />
            <TotCell label="Discount" value={totals.discount} />
            <TotCell label="CGST (preview)" value={totals.cgst} />
            <TotCell label="SGST (preview)" value={totals.sgst} />
            <TotCell label="Grand Total" value={totals.grand} bold />
          </div>
        </div>
      </FormDialog>

      <QuickItemDialog
        open={!!newItemFor}
        onOpenChange={(o) => { if (!o) setNewItemFor(null) }}
        initialName={newItemFor?.name ?? ''}
        items={itemRows}
        defaultType="FINISHED"
        onCreated={(it) => { if (newItemFor) pickItem(newItemFor.idx, it); void items.refetch() }}
        onUseExisting={(it) => { if (newItemFor) pickItem(newItemFor.idx, it) }}
      />

      <FormDialog
        open={!!woRow} onOpenChange={(o) => { if (!o) { setWoRow(null); resetWoPlan() } }}
        title="Plan Work Order"
        description={woRow ? `Creates a PLANNED work order linked to ${woRow.number}.` : ''}
        submitLabel="Create Work Order" loading={planning} onSubmit={submitWo}
      >
        <div className="grid sm:grid-cols-2 gap-4">
          <Field label="Item" required>
            <SelectInput value={woItemId} onChange={onWoItemChange} options={woItemOpts} placeholder="Select item…" />
          </Field>
          <Field label="Planned Qty" required>
            <NumberInput value={woQty} onChange={setWoQty} min={0} step="any" placeholder="0" />
          </Field>
          <Field label="Warehouse" required>
            <SelectInput value={woWarehouseId} onChange={setWoWarehouseId} options={whOpts} placeholder="Select warehouse…" />
          </Field>
          <Field label="BOM (optional)">
            <SelectInput
              value={woBomId} onChange={setWoBomId} disabled={!woItemId}
              options={[
                { value: '', label: '— Auto (latest ACTIVE) —' },
                ...woBomOpts.map((b) => ({ value: b.id, label: `${b.code || 'BOM'} ${b.version || ''}`.trim() })),
              ]}
            />
          </Field>
          <Field label="Start Date" required><DateInput value={woStartDate} onChange={setWoStartDate} /></Field>
          <Field label="Due Date"><DateInput value={woDueDate} onChange={setWoDueDate} /></Field>
          <Field label="Priority">
            <SelectInput
              value={woPriority} onChange={setWoPriority}
              options={[{ value: 'NORMAL', label: 'Normal' }, { value: 'HIGH', label: 'High' }, { value: 'URGENT', label: 'Urgent' }]}
            />
          </Field>
          <Field label="Notes">
            <TextInput value={woNotes} onChange={(e) => setWoNotes(e.target.value)} placeholder="Optional remarks" />
          </Field>
        </div>
      </FormDialog>

      <Dialog open={!!detail} onOpenChange={(o) => !o && setDetail(null)}>
        <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Sales Order {detail?.number}</DialogTitle>
            <DialogDescription>
              {detail?.customer?.name || '—'} · <StatusBadge status={detail?.status} />
            </DialogDescription>
          </DialogHeader>
          {detail && (
            <div className="space-y-3 text-sm">
              <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground sm:grid-cols-3">
                <div>Order date: <span className="text-foreground font-medium"><DateCell value={detail.orderDate} /></span></div>
                <div>Delivery: <span className="text-foreground font-medium"><DateCell value={detail.deliveryDate} /></span></div>
                <div>Lines: <span className="text-foreground font-medium">{detail.items?.length ?? 0}</span></div>
                {detail.customerPoNo && <div>Customer PO: <span className="text-foreground font-medium">{detail.customerPoNo}</span>{detail.customerPoDate ? <> · <DateCell value={detail.customerPoDate} /></> : null}</div>}
                {detail.paymentTerms && <div>Payment: <span className="text-foreground font-medium">{detail.paymentTerms}</span></div>}
                {detail.deliveryTerms && <div>Delivery terms: <span className="text-foreground font-medium">{detail.deliveryTerms}</span></div>}
                {detail.shippingAddress && <div className="col-span-3">Ship to: <span className="text-foreground font-medium whitespace-pre-wrap">{detail.shippingAddress}</span></div>}
              </div>
              <div className="rounded-lg border overflow-x-auto">
                <table className="w-full text-xs">
                  <thead><tr className="bg-muted/50">
                    <th className="text-left p-2">Item</th><th className="text-right p-2">Qty</th><th className="text-right p-2">Rate</th>
                    <th className="text-right p-2">Disc %</th><th className="text-right p-2">GST %</th><th className="text-right p-2">Dispatched</th><th className="text-right p-2">Line Total</th>
                  </tr></thead>
                  <tbody>
                    {(detail.items ?? []).map((it) => (
                      <tr key={it.id} className="border-t">
                        <td className="p-2">{it.item?.name || it.itemId}</td>
                        <td className="p-2 text-right tabular-nums">{it.qty}{it.item?.uom ? ` ${it.item.uom}` : ''}</td>
                        <td className="p-2 text-right tabular-nums">{fmtMoney(it.rate)}</td>
                        <td className="p-2 text-right tabular-nums">{it.discountPct}%</td>
                        <td className="p-2 text-right tabular-nums">{it.gstRate}%</td>
                        <td className="p-2 text-right tabular-nums">{it.dispatchedQty ?? 0}</td>
                        <td className="p-2 text-right tabular-nums font-medium">{fmtMoney(it.lineTotal)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex flex-col items-end gap-0.5 text-sm">
                <span>Subtotal <Money value={detail.subtotal} /></span>
                <span>Discount <Money value={-detail.discountTotal} /></span>
                <span>CGST <Money value={detail.cgst} /></span>
                <span>SGST <Money value={detail.sgst} /></span>
                {detail.igst ? <span>IGST <Money value={detail.igst} /></span> : null}
                <span className="font-bold text-base">Grand Total <Money value={detail.grandTotal} /></span>
              </div>
              {detail.notes && <p className="text-xs text-muted-foreground">Notes: {detail.notes}</p>}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}

function TotCell({ label, value, bold }: { label: string; value: number; bold?: boolean }) {
  return (
    <div className={bold ? 'sm:text-right' : ''}>
      <p className="text-[11px] text-muted-foreground uppercase tracking-wide">{label}</p>
      <p className={`tabular-nums ${bold ? 'font-bold text-base' : 'font-medium'}`}>{fmtMoney(value)}</p>
    </div>
  )
}
