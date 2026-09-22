'use client'

import * as React from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { BadgeIndianRupee, Plus, Printer, Trash2, X } from 'lucide-react'
import {
  Column, ConfirmAction, DataTable, DateCell, DateInput, Field, FormDialog, Money,
  NumberInput, PageHeader, SelectInput, StatusBadge, TextInput, printHtml, useRowHighlight,
} from '@/components/erp/kit'
import { apiGet, apiPatch, apiPost, useList } from '@/lib/use-api'
import { PAYMENT_MODES, fmtMoney } from '@/lib/erp-constants'
import { amountInWords } from '@/lib/number-to-words'

interface PartyRow { id: string; name?: string | null; code?: string | null }
interface ItemRow { id: string; code?: string | null; name?: string | null; sellingPrice?: number | null; gstRate?: number | null; hsn?: string | null }
interface InvItem { id: string; itemId: string; hsn?: string | null; qty: number; rate: number; discountPct?: number; gstRate: number; lineTotal: number; invoicedQty?: number; item?: { code?: string | null; name?: string | null; uom?: string | null } | null }
interface InvoiceRow {
  id: string; number: string; date: string; dueDate?: string | null; placeOfSupply?: string | null
  customerId?: string | null; status: string; subtotal: number; discountTotal: number; cgst: number; sgst: number; igst: number
  grandTotal: number; paidAmount: number; irn?: string | null; ewayBillNo?: string | null; notes?: string | null
  salesOrderId?: string | null; salesOrder?: { number?: string | null } | null
  customer?: { name?: string | null; gstin?: string | null; contactPerson?: string | null; phone?: string | null; email?: string | null; city?: string | null; state?: string | null; stateCode?: string | null; addressLine?: string | null } | null
  items?: InvItem[] | null
}
interface CompanyRow { id: string; name?: string | null; gstin?: string | null; pan?: string | null; addressLine?: string | null; city?: string | null; state?: string | null; stateCode?: string | null; phone?: string | null; email?: string | null; bankAccountName?: string | null; bankAccountNumber?: string | null; bankIfsc?: string | null; bankUpiId?: string | null }
interface DraftLine { itemId: string; qty: number; rate: number; discountPct: number; gstRate: number }

const r2 = (n: number) => Math.round(n * 100) / 100
const today = () => new Date().toISOString().slice(0, 10)
const INVOICEABLE = ['CONFIRMED', 'READY', 'PARTIALLY_DISPATCHED', 'DISPATCHED']

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
function emptyLine(): DraftLine { return { itemId: '', qty: 1, rate: 0, discountPct: 0, gstRate: 18 } }

// Escape a value for interpolation into the print-window HTML.
const esc = (v?: string | null) =>
  (v ?? '').replace(/[&<>"]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'))
// Join non-empty address parts with ', ' (raw — wrap the result in esc() before injecting).
const joinAddr = (...parts: (string | null | undefined)[]) =>
  parts.filter((p): p is string => !!p && p.trim() !== '').join(', ')

export default function SalesInvoicesModule({ companyId }: { companyId: string }) {
  const highlightId = useRowHighlight('sales-invoices')
  const list = useList<{ items: InvoiceRow[] }>(`/api/sales-invoices?companyId=${companyId}`)
  const customers = useList<{ items: PartyRow[] }>(`/api/customers?companyId=${companyId}`)
  const items = useList<{ items: ItemRow[] }>(`/api/items?companyId=${companyId}`)
  const sos = useList<{ items: { id: string; number: string; status: string }[] }>(`/api/sales-orders?companyId=${companyId}`)

  const [open, setOpen] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [mode, setMode] = React.useState('SO')
  const [salesOrderId, setSalesOrderId] = React.useState('')
  const [customerId, setCustomerId] = React.useState('')
  const [date, setDate] = React.useState(today)
  const [dueDate, setDueDate] = React.useState('')
  const [placeOfSupply, setPlaceOfSupply] = React.useState('')
  const [notes, setNotes] = React.useState('')
  const [lines, setLines] = React.useState<DraftLine[]>([emptyLine()])

  const [payFor, setPayFor] = React.useState<InvoiceRow | null>(null)
  const [payAmount, setPayAmount] = React.useState(0)
  const [payMode, setPayMode] = React.useState('NEFT')
  const [payDate, setPayDate] = React.useState(today)
  const [payRef, setPayRef] = React.useState('')
  const [paying, setPaying] = React.useState(false)

  const rows = list.data?.items ?? []
  const customerOpts = (customers.data?.items ?? []).map((c) => ({ value: c.id, label: c.name || c.id }))
  const itemOpts = (items.data?.items ?? []).map((i) => ({ value: i.id, label: i.code && i.name ? `${i.code} — ${i.name}` : i.name || i.id }))
  const soOpts = (sos.data?.items ?? []).filter((s) => INVOICEABLE.includes(s.status)).map((s) => ({ value: s.id, label: `${s.number} (${s.status.replaceAll('_', ' ')})` }))

  function resetForm() {
    setMode('SO'); setSalesOrderId(''); setCustomerId(''); setDate(today()); setDueDate(''); setPlaceOfSupply(''); setNotes('')
    setLines([emptyLine()])
  }

  async function pickSo(sid: string) {
    setSalesOrderId(sid)
    if (!sid) return
    try {
      const so = await apiGet<InvoiceRow & { customerId?: string }>(`/api/sales-orders/${sid}?companyId=${companyId}`)
      if (so.customerId) setCustomerId(so.customerId)
      const mapped = (so.items ?? [])
        .filter((it) => it.qty - (it.invoicedQty ?? 0) > 0)
        .map((it) => ({ itemId: it.itemId, qty: r2(it.qty - (it.invoicedQty ?? 0)), rate: it.rate, discountPct: it.discountPct ?? 0, gstRate: it.gstRate }))
      setLines(mapped.length ? mapped : [emptyLine()])
      toast.success(`Loaded ${mapped.length} pending line(s) from ${so.number}`)
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to load sales order') }
  }

  async function submit() {
    if (mode === 'SO' && !salesOrderId) { toast.error('Select a sales order'); return }
    if (mode === 'MANUAL' && !customerId) { toast.error('Select a customer'); return }
    const valid = lines.filter((l) => l.itemId && l.qty > 0)
    if (!valid.length) { toast.error('Add at least one line with item and qty'); return }
    setSaving(true)
    try {
      await apiPost('/api/sales-invoices', {
        companyId, salesOrderId: mode === 'SO' ? salesOrderId : undefined, customerId: customerId || undefined,
        date, dueDate: dueDate || undefined, placeOfSupply: placeOfSupply || undefined, notes: notes || undefined,
        items: valid,
      })
      toast.success('Sales invoice created')
      setOpen(false); resetForm(); void list.refetch()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to create invoice') } finally { setSaving(false) }
  }

  async function openPay(row: InvoiceRow) {
    setPayFor(row); setPayAmount(r2((row.grandTotal || 0) - (row.paidAmount || 0)))
    setPayMode('NEFT'); setPayDate(today()); setPayRef('')
  }

  async function submitPayment() {
    if (!payFor) return
    if (payAmount <= 0) { toast.error('Enter a valid amount'); return }
    setPaying(true)
    try {
      await apiPost('/api/payments', {
        companyId, type: 'RECEIPT', partyType: 'CUSTOMER', customerId: payFor.customerId,
        invoiceType: 'SALES', invoiceId: payFor.id, amount: payAmount, mode: payMode, date: payDate,
        reference: payRef || undefined, userName: 'Sales User',
      })
      toast.success(`Payment of ${fmtMoney(payAmount)} recorded`)
      setPayFor(null); void list.refetch()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to record payment') } finally { setPaying(false) }
  }

  async function generateIrn(row: InvoiceRow) {
    try {
      const res = await apiPatch<{ irn?: string }>(`/api/sales-invoices/${row.id}`, { action: 'generate-irn', companyId })
      toast.success(`IRN generated: ${res?.irn || 'registered on e-invoice portal'}`)
      void list.refetch()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to generate IRN') }
  }

  async function cancelInvoice(row: InvoiceRow) {
    try {
      await apiPatch(`/api/sales-invoices/${row.id}`, { action: 'cancel', companyId })
      toast.success(`Invoice ${row.number} cancelled`); void list.refetch()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to cancel') }
  }

  async function printInvoice(row: InvoiceRow) {
    // Prefer the detail endpoint — it returns the full customer (phone/email/address),
    // items with UOM and the seller company (PAN/state code) needed on a GST tax invoice.
    let inv: InvoiceRow = row
    let seller: CompanyRow | undefined
    try {
      const detail = await apiGet<InvoiceRow & { company?: CompanyRow }>(`/api/sales-invoices/${row.id}?companyId=${companyId}`)
      if (detail) {
        inv = { ...row, ...detail, customer: detail.customer ?? row.customer, items: detail.items ?? row.items }
        seller = detail.company
      }
    } catch { /* fall back to the list row */ }
    if (!seller) {
      try {
        const companies = await apiGet<{ companies?: CompanyRow[]; items?: CompanyRow[] }>('/api/companies')
        seller = (companies.companies ?? companies.items ?? []).find((c) => c.id === companyId)
      } catch { /* fall back to placeholders below */ }
    }

    const cust = inv.customer
    const lines2 = inv.items ?? []
    const interState = (inv.igst || 0) > 0
    const sellerName = seller?.name || 'Acme Precision Manufacturing Pvt Ltd'
    // PAN = characters 3-12 of the GSTIN (when PAN itself is not stored)
    const sellerPan = seller?.pan || (seller?.gstin && seller.gstin.length >= 12 ? seller.gstin.slice(2, 12) : '')
    const sellerStateCode = seller?.stateCode || (seller?.gstin ? seller.gstin.slice(0, 2) : '')
    const buyerStateCode = cust?.stateCode || (cust?.gstin ? cust.gstin.slice(0, 2) : '')
    const buyerContact = [cust?.phone, cust?.email].filter((x): x is string => !!x && x.trim() !== '').join(' · ')
    const qtySum = r2(lines2.reduce((s, it) => s + (it.qty || 0), 0))
    const taxableSum = r2(lines2.reduce((s, it) => s + (it.lineTotal || 0), 0))
    const balance = r2((inv.grandTotal || 0) - (inv.paidAmount || 0))

    // Bank details box — real rows when any bank field is stored on the company,
    // otherwise keep the 'As per records' placeholder so the box is never empty.
    const bankName = (seller?.bankAccountName || '').trim()
    const bankAcctNo = (seller?.bankAccountNumber || '').trim()
    const bankIfsc = (seller?.bankIfsc || '').trim().toUpperCase()
    const bankUpi = (seller?.bankUpiId || '').trim()
    const hasBankDetails = !!(bankName || bankAcctNo || bankIfsc || bankUpi)
    const bankRowsHtml = [
      `A/C Name: ${esc(bankName || sellerName)}`,
      bankAcctNo ? `A/C No.: ${esc(bankAcctNo)}` : '',
      bankIfsc ? `IFSC: ${esc(bankIfsc)}` : '',
      bankUpi ? `UPI: ${esc(bankUpi)}` : '',
    ].filter(Boolean).join('<br/>')

    const html = `
      <style>
        .gst-inv { border: 1.5px solid #333; }
        .gst-inv table { margin-top: 0; }
        .gst-inv th, .gst-inv td { border-color: #444; }
        .gst-inv .grid td { vertical-align: top; padding: 8px 10px; }
        .gst-inv .bare td { border: none; padding: 5px 10px; vertical-align: top; }
        .gst-inv .sec { font-size: 9px; font-weight: 700; letter-spacing: 1px; text-transform: uppercase; color: #555; margin-bottom: 4px; }
        .gst-inv .title { text-align: center; font-size: 15px; font-weight: 800; letter-spacing: 4px; padding: 7px 10px; border-bottom: 1.5px solid #333; }
        .gst-inv .words { font-weight: 700; font-size: 12px; margin-top: 8px; line-height: 1.5; }
        .gst-inv .bankbox { border: 1px solid #444; padding: 8px 10px; font-size: 11px; line-height: 1.7; }
        .gst-inv .terms { font-size: 10.5px; line-height: 1.7; color: #444; }
        .gst-inv .signline { border-top: 1px solid #333; margin-top: 72px; padding-top: 5px; font-size: 11px; text-align: center; }
        .gst-inv .footer { border-top: 1.5px solid #333; padding: 6px 10px; font-size: 10px; color: #444; text-align: center; line-height: 1.6; }
        .gst-inv .grand td { font-size: 15px; }
      </style>
      <div class="gst-inv">
        <div class="title">TAX INVOICE</div>
        <div class="head" style="padding:10px 12px">
          <div>
            <h1 style="font-size:17px">${esc(sellerName)}</h1>
            <div class="muted">${esc(joinAddr(seller?.addressLine, seller?.city, seller?.state)) || '&nbsp;'}</div>
            <div class="muted">${seller?.gstin ? `GSTIN: ${esc(seller.gstin)}` : ''}${sellerPan ? ` &nbsp;·&nbsp; PAN: ${esc(sellerPan)}` : ''}</div>
            <div class="muted">${esc(joinAddr(seller?.phone, seller?.email))}</div>
            <div class="muted">${esc(joinAddr(seller?.state, sellerStateCode ? `State Code: ${sellerStateCode}` : ''))}</div>
          </div>
          <div style="text-align:right">
            <div style="font-size:13px"><strong>Invoice No: ${esc(inv.number)}</strong></div>
            <div class="muted">Date: ${new Date(inv.date).toLocaleDateString('en-IN')}</div>
            ${inv.dueDate ? `<div class="muted">Due: ${new Date(inv.dueDate).toLocaleDateString('en-IN')}</div>` : ''}
            ${inv.irn ? `<div class="muted" style="max-width:280px;word-break:break-all">IRN: ${esc(inv.irn)}</div>` : ''}
            ${inv.ewayBillNo ? `<div class="muted">E-Way Bill No: ${esc(inv.ewayBillNo)}</div>` : ''}
            <span class="badge">${esc(inv.status)}</span>
          </div>
        </div>
        <table class="grid"><tr>
          <td style="width:58%">
            <div class="sec">Buyer (Bill To)</div>
            <strong style="font-size:13px">${esc(cust?.name || '—')}</strong>
            ${cust?.contactPerson ? `<div class="muted">Attn: ${esc(cust.contactPerson)}</div>` : ''}
            <div class="muted">${esc(joinAddr(cust?.addressLine, cust?.city)) || '&nbsp;'}</div>
            <div class="muted">${cust?.gstin ? `GSTIN: ${esc(cust.gstin)}` : ''}</div>
            <div class="muted">${esc(joinAddr(cust?.state, buyerStateCode ? `State Code: ${buyerStateCode}` : ''))}</div>
            ${buyerContact ? `<div class="muted">${esc(buyerContact)}</div>` : ''}
            ${inv.placeOfSupply ? `<div class="muted">Place of Supply: ${esc(inv.placeOfSupply)}</div>` : ''}
          </td>
          <td style="width:42%">
            <div class="sec">Invoice Details</div>
            <table class="bare">
              <tr><td class="muted">Against Sales Order</td><td style="text-align:right"><strong>${esc(inv.salesOrder?.number || '—')}</strong></td></tr>
              <tr><td class="muted">Supply Type</td><td style="text-align:right">${interState ? 'Inter-State (IGST)' : 'Intra-State (CGST + SGST)'}</td></tr>
              <tr><td class="muted">Payment Due</td><td style="text-align:right">${inv.dueDate ? new Date(inv.dueDate).toLocaleDateString('en-IN') : '—'}</td></tr>
              <tr><td class="muted">E-Invoice (IRN)</td><td style="text-align:right">${inv.irn ? 'Registered' : '—'}</td></tr>
            </table>
          </td>
        </tr></table>
        <table>
          <thead><tr><th style="width:26px">#</th><th>Item</th><th style="width:70px">HSN</th><th class="num" style="width:70px">Qty</th><th class="num" style="width:85px">Rate</th><th class="num" style="width:52px">Disc %</th><th class="num" style="width:90px">Taxable</th><th class="num" style="width:52px">GST %</th><th class="num" style="width:95px">Amount</th></tr></thead>
          <tbody>${lines2.map((it, i) => {
            const gross = it.qty * it.rate
            const taxable = gross - gross * ((it.discountPct || 0) / 100)
            return `<tr><td>${i + 1}</td><td>${esc(it.item?.name || it.itemId)}${it.item?.code ? ` <span class="muted">(${esc(it.item.code)})</span>` : ''}</td><td>${esc(it.hsn || '—')}</td><td class="num">${it.qty}${it.item?.uom ? ` ${esc(it.item.uom)}` : ''}</td><td class="num">${fmtMoney(it.rate)}</td><td class="num">${it.discountPct || 0}</td><td class="num">${fmtMoney(taxable)}</td><td class="num">${it.gstRate}%</td><td class="num">${fmtMoney(it.lineTotal)}</td></tr>`
          }).join('')}</tbody>
          <tfoot><tr style="background:#f4f4f5;font-weight:600"><td colspan="3" style="text-align:right">Total</td><td class="num">${qtySum}</td><td></td><td></td><td class="num">${fmtMoney(taxableSum)}</td><td></td><td class="num">${fmtMoney(taxableSum)}</td></tr></tfoot>
        </table>
        <table class="grid"><tr>
          <td style="width:55%">
            <div class="sec">Bank Details</div>
            <div class="bankbox">
              ${hasBankDetails
                ? bankRowsHtml
                : `<strong>${esc(sellerName)}</strong><br/>A/C No.: As per records<br/>IFSC: As per records &nbsp;·&nbsp; UPI: As per records`}
            </div>
          </td>
          <td style="width:45%">
            <table class="totals" style="width:100%">
              <tr><td>Subtotal</td><td class="num">${fmtMoney(inv.subtotal)}</td></tr>
              <tr><td>Discount</td><td class="num">- ${fmtMoney(inv.discountTotal)}</td></tr>
              ${interState
                ? `<tr><td>IGST</td><td class="num">${fmtMoney(inv.igst)}</td></tr>`
                : `<tr><td>CGST</td><td class="num">${fmtMoney(inv.cgst)}</td></tr><tr><td>SGST</td><td class="num">${fmtMoney(inv.sgst)}</td></tr>`}
              <tr class="grand"><td>Grand Total</td><td class="num">${fmtMoney(inv.grandTotal)}</td></tr>
              <tr><td>Paid</td><td class="num">${fmtMoney(inv.paidAmount)}</td></tr>
              <tr><td>Balance Due</td><td class="num">${fmtMoney(balance)}</td></tr>
            </table>
            <div style="margin-top:6px;font-size:13px"><strong>Total Invoice Value: ${fmtMoney(inv.grandTotal)}</strong></div>
            <div class="words">Amount in words: Rupees ${amountInWords(inv.grandTotal)} Only</div>
          </td>
        </tr></table>
        ${inv.notes ? `<div class="muted" style="padding:6px 10px;border-top:1px solid #444">Notes: ${esc(inv.notes)}</div>` : ''}
        <table class="bare"><tr>
          <td style="width:58%">
            <div class="sec">Terms &amp; Conditions</div>
            <div class="terms">
              1. Subject to ${seller?.city ? esc(seller.city) + ' ' : ''}jurisdiction.<br/>
              2. Interest @18% p.a. will be charged on overdue payments.<br/>
              3. Delivery subject to realisation of payment.<br/>
              4. Goods once sold will not be taken back. E&amp;OE.
            </div>
          </td>
          <td style="width:42%;text-align:right">
            <div style="font-weight:700;font-size:12px;text-align:left">For ${esc(sellerName)}</div>
            <div class="signline">Authorised Signatory</div>
          </td>
        </tr></table>
        <div class="footer">
          This is a computer-generated GST tax invoice.<br/>
          <strong>Declaration:</strong> We declare that this invoice shows the actual price of the goods described and that all particulars are true and correct.
        </div>
      </div>`
    printHtml(`Tax Invoice ${row.number}`, html)
  }

  const totals = computeTotals(lines)

  const columns: Column<InvoiceRow>[] = [
    { key: 'number', header: 'Invoice #', render: (r) => <span className="font-medium">{r.number}</span> },
    { key: 'date', header: 'Date', render: (r) => <DateCell value={r.date} /> },
    { key: 'customer', header: 'Customer', render: (r) => r.customer?.name || '—' },
    { key: 'total', header: 'Grand Total', render: (r) => <Money value={r.grandTotal} className="font-medium" /> },
    { key: 'paid', header: 'Paid', hideOnMobile: true, render: (r) => <Money value={r.paidAmount} /> },
    { key: 'outstanding', header: 'Outstanding', render: (r) => <Money value={r2((r.grandTotal || 0) - (r.paidAmount || 0))} className={r2((r.grandTotal || 0) - (r.paidAmount || 0)) > 0 ? 'text-amber-600 font-medium' : 'text-emerald-600'} /> },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
    {
      key: 'actions', header: 'Actions',
      render: (r) => (
        <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
          <Button variant="ghost" size="sm" className="h-7" title="Print tax invoice" onClick={() => void printInvoice(r)}><Printer className="h-3.5 w-3.5" /></Button>
          {!r.irn && r.status !== 'CANCELLED' && (
            <Button variant="ghost" size="sm" className="h-7" title="Generate IRN" onClick={() => void generateIrn(r)}><BadgeIndianRupee className="h-3.5 w-3.5" /></Button>
          )}
          {r.status !== 'PAID' && r.status !== 'CANCELLED' && (
            <Button variant="outline" size="sm" className="h-7" onClick={() => void openPay(r)}>Payment</Button>
          )}
          {r.status !== 'CANCELLED' && (r.paidAmount || 0) <= 0 && (
            <ConfirmAction
              trigger={<Button variant="ghost" size="sm" className="h-7 text-red-600"><X className="h-3.5 w-3.5" /></Button>}
              title="Cancel invoice?" message={`Cancel ${r.number}? Only unpaid invoices can be cancelled.`} tone="destructive"
              onConfirm={() => cancelInvoice(r)}
            />
          )}
        </div>
      ),
    },
  ]

  return (
    <div>
      <PageHeader
        title="Sales Invoices"
        description="GST tax invoices, payments received and e-invoicing"
        actions={<Button onClick={() => { resetForm(); setOpen(true) }}><Plus className="h-4 w-4 mr-1.5" />New Invoice</Button>}
      />
      <DataTable columns={columns} rows={rows} loading={list.loading} searchPlaceholder="Search invoices…" highlightId={highlightId} />

      <FormDialog
        open={open} onOpenChange={setOpen} wide title="New Sales Invoice" submitLabel="Create Invoice"
        description="From a sales order (pending qty pre-filled) or manual lines" loading={saving} onSubmit={submit}
      >
        <div className="grid sm:grid-cols-3 gap-4">
          <Field label="Mode">
            <SelectInput
              value={mode} onChange={setMode}
              options={[{ value: 'SO', label: 'From Sales Order' }, { value: 'MANUAL', label: 'Manual Lines' }]}
            />
          </Field>
          {mode === 'SO' ? (
            <Field label="Sales Order" required>
              <SelectInput value={salesOrderId} onChange={(v) => void pickSo(v)} options={soOpts} placeholder="Select SO…" />
            </Field>
          ) : (
            <Field label="Customer" required>
              <SelectInput value={customerId} onChange={setCustomerId} options={customerOpts} />
            </Field>
          )}
          <Field label="Date" required><DateInput value={date} onChange={setDate} /></Field>
          <Field label="Due Date"><DateInput value={dueDate} onChange={setDueDate} /></Field>
          <Field label="Place of Supply"><TextInput value={placeOfSupply} onChange={(e) => setPlaceOfSupply(e.target.value)} placeholder="e.g. Maharashtra" /></Field>
          <Field label="Notes"><TextInput value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Remarks…" /></Field>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Lines</span>
            <Button type="button" variant="outline" size="sm" onClick={() => setLines((ls) => [...ls, emptyLine()])}>
              <Plus className="h-3.5 w-3.5 mr-1" />Add Line
            </Button>
          </div>
          {lines.map((l, idx) => (
            <div key={idx} className="grid grid-cols-12 gap-2 items-center">
              <div className="col-span-12 sm:col-span-4">
                <SelectInput
                  value={l.itemId} options={itemOpts} placeholder="Select item…"
                  onChange={(v) => setLines((ls) => ls.map((x, i) => {
                    if (i !== idx) return x
                    const it = (items.data?.items ?? []).find((o) => o.id === v)
                    return { ...x, itemId: v, rate: x.rate || Number(it?.sellingPrice || 0), gstRate: it?.gstRate ?? x.gstRate }
                  }))}
                />
              </div>
              <NumberInput className="col-span-3 sm:col-span-2" value={l.qty} min={0} placeholder="Qty"
                onChange={(n) => setLines((ls) => ls.map((x, i) => (i === idx ? { ...x, qty: n } : x)))} />
              <NumberInput className="col-span-3 sm:col-span-2" value={l.rate} min={0} placeholder="Rate"
                onChange={(n) => setLines((ls) => ls.map((x, i) => (i === idx ? { ...x, rate: n } : x)))} />
              <NumberInput className="col-span-3 sm:col-span-1" value={l.discountPct} min={0} placeholder="Disc %"
                onChange={(n) => setLines((ls) => ls.map((x, i) => (i === idx ? { ...x, discountPct: n } : x)))} />
              <NumberInput className="col-span-2 sm:col-span-1" value={l.gstRate} min={0} placeholder="GST %"
                onChange={(n) => setLines((ls) => ls.map((x, i) => (i === idx ? { ...x, gstRate: n } : x)))} />
              <div className="col-span-1 flex justify-end">
                <Button type="button" variant="ghost" size="sm" disabled={lines.length <= 1}
                  onClick={() => setLines((ls) => ls.filter((_, i) => i !== idx))}>
                  <Trash2 className="h-3.5 w-3.5 text-red-600" />
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

      <FormDialog
        open={!!payFor} onOpenChange={(o) => !o && setPayFor(null)} title={`Record Payment — ${payFor?.number || ''}`}
        submitLabel="Save Payment" loading={paying} onSubmit={submitPayment}
        description={`Outstanding: ${fmtMoney(payFor ? (payFor.grandTotal || 0) - (payFor.paidAmount || 0) : 0)}`}
      >
        <div className="grid sm:grid-cols-2 gap-4">
          <Field label="Amount" required><NumberInput value={payAmount} onChange={setPayAmount} min={0} /></Field>
          <Field label="Mode">
            <SelectInput value={payMode} onChange={setPayMode} options={PAYMENT_MODES.map((m) => ({ value: m, label: m }))} />
          </Field>
          <Field label="Date" required><DateInput value={payDate} onChange={setPayDate} /></Field>
          <Field label="Reference"><TextInput value={payRef} onChange={(e) => setPayRef(e.target.value)} placeholder="UTR / cheque no." /></Field>
        </div>
      </FormDialog>
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
