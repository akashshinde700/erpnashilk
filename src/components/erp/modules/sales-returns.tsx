'use client'

import * as React from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Plus, Printer, X } from 'lucide-react'
import {
  Column, ConfirmAction, DataTable, DateCell, DateInput, Field, FormDialog, Money,
  NumberInput, PageHeader, SelectInput, StatusBadge, TextInput, printHtml, useCreatePreset, useRowHighlight
} from '@/components/erp/kit'
import { apiGet, apiPatch, apiPost, useList } from '@/lib/use-api'
import { fmtDate, fmtMoney } from '@/lib/erp-constants'
import { amountInWords } from '@/lib/number-to-words'

interface ItemInfo { code?: string | null; name?: string | null; uom?: string | null; hsn?: string | null }
interface ReturnItem { id: string; invoiceItemId?: string | null; itemId: string; qty: number; rate: number; gstRate: number; lineTotal: number; discountPct?: number; hsn?: string | null; item?: ItemInfo | null }
interface PartyInfo { name?: string | null; gstin?: string | null; phone?: string | null; email?: string | null; addressLine?: string | null; city?: string | null; state?: string | null; stateCode?: string | null }
interface CompanyInfo { name?: string | null; gstin?: string | null; pan?: string | null; addressLine?: string | null; city?: string | null; state?: string | null; stateCode?: string | null; phone?: string | null; email?: string | null; logoImage?: string | null; signatureImage?: string | null; roundOffTotals?: boolean | null }
interface ReturnRow {
  id: string; number: string; date: string; status: string; reason?: string | null; notes?: string | null
  invoiceId: string; customerId: string; warehouseId: string; isInterState: boolean
  subtotal: number; cgst: number; sgst: number; igst: number; grandTotal: number
  invoice?: { number?: string | null; date?: string | null; placeOfSupply?: string | null } | null
  customer?: PartyInfo | null
  warehouse?: { code?: string | null; name?: string | null } | null
  items: ReturnItem[]
  company?: CompanyInfo | null
}
interface InvoiceListRow { id: string; number: string; date: string; status: string; grandTotal: number; customer?: { name?: string | null } | null }
interface InvoiceDetail {
  id: string; number: string; date: string; isInterState: boolean
  customer?: { name?: string | null } | null
  items?: { id: string; itemId: string; qty: number; rate: number; discountPct?: number; gstRate: number; returnedQty?: number; batchNo?: string | null; serials?: string | null; item?: ItemInfo | null }[] | null
}
interface DraftLine {
  invoiceItemId: string; itemId: string; name: string; uom: string; invoiced: number; returned: number; qty: number; rate: number; discountPct: number; gstRate: number
  soldBatch: string; soldSerials: string; serials: string
}
interface ItemFlags { id: string; batchTracked?: boolean; trackSerial?: boolean }
const SERIAL_SPLIT = /[\r\n,;]+/
const serialList = (t: string) => Array.from(new Set(t.split(SERIAL_SPLIT).map((x) => x.trim()).filter(Boolean)))
interface WarehouseRow { id: string; code?: string | null; name?: string | null; type?: string | null }

const r2 = (n: number) => Math.round(n * 100) / 100
const today = () => new Date().toISOString().slice(0, 10)
const esc = (v?: string | null) =>
  (v ?? '').replace(/[&<>"]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'))
const joinAddr = (...parts: (string | null | undefined)[]) => parts.filter((p): p is string => !!p && p.trim() !== '').join(', ')
const safeImg = (v?: string | null) => (v && /^data:image\/(png|jpe?g|gif|webp|svg\+xml);base64,/i.test(v) ? v : '')

// Same math as the API (computeBillTotals with line discounts + round-off only)
function computeTotals(lines: DraftLine[], interState: boolean, roundOff: boolean) {
  let taxable = 0, tax = 0
  for (const l of lines) {
    if (!(l.qty > 0)) continue
    const gross = l.qty * l.rate
    const t = gross - gross * ((l.discountPct || 0) / 100)
    taxable += t; tax += t * (l.gstRate / 100)
  }
  const cgst = interState ? 0 : r2(tax / 2), sgst = interState ? 0 : r2(tax / 2), igst = interState ? r2(tax) : 0
  const exact = r2(taxable + cgst + sgst + igst)
  const grand = roundOff ? Math.round(exact) : exact
  return { taxable: r2(taxable), cgst, sgst, igst, roundOff: r2(grand - exact), grand: r2(grand) }
}

export default function SalesReturnsModule({ companyId }: { companyId: string }) {
  const highlightId = useRowHighlight('sales-returns')
  const list = useList<{ items: ReturnRow[] }>(`/api/sales-returns?companyId=${companyId}`)
  const invoices = useList<{ items: InvoiceListRow[] }>(`/api/sales-invoices?companyId=${companyId}`)
  const warehouses = useList<{ items: WarehouseRow[] }>(`/api/warehouses?companyId=${companyId}`)
  const settings = useList<CompanyInfo>(`/api/settings?companyId=${companyId}`)
  const itemMaster = useList<{ items: ItemFlags[] }>(`/api/items?companyId=${companyId}`)
  const isSerial = (itemId: string) => !!(itemMaster.data?.items ?? []).find((i) => i.id === itemId)?.trackSerial

  const [open, setOpen] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [search, setSearch] = React.useState('')
  const [invoice, setInvoice] = React.useState<InvoiceDetail | null>(null)
  const [loadingInv, setLoadingInv] = React.useState(false)
  const [lines, setLines] = React.useState<DraftLine[]>([])
  const [date, setDate] = React.useState(today)
  const [warehouseId, setWarehouseId] = React.useState('')
  const [reason, setReason] = React.useState('')
  const [notes, setNotes] = React.useState('')

  const rows = list.data?.items ?? []
  const whRows = warehouses.data?.items ?? []
  const whOpts = whRows.map((w) => ({ value: w.id, label: w.code && w.name ? `${w.code} — ${w.name}` : w.name || w.code || w.id }))
  const defaultWh = (whRows.find((w) => w.type === 'FG') ?? whRows[0])?.id || ''

  const invoiceChoices = React.useMemo(() => {
    const q = search.trim().toLowerCase()
    return (invoices.data?.items ?? [])
      .filter((i) => i.status !== 'CANCELLED')
      .filter((i) => !q || i.number.toLowerCase().includes(q) || (i.customer?.name || '').toLowerCase().includes(q))
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
      .slice(0, 50)
  }, [invoices.data, search])

  function resetForm() {
    setSearch(''); setInvoice(null); setLines([]); setDate(today()); setWarehouseId(defaultWh); setReason(''); setNotes('')
  }

  async function pickInvoice(id: string) {
    setLoadingInv(true)
    try {
      const inv = await apiGet<InvoiceDetail>(`/api/sales-invoices/${id}?companyId=${companyId}`)
      setInvoice(inv)
      setLines((inv.items ?? []).map((l) => ({
        invoiceItemId: l.id, itemId: l.itemId, soldBatch: l.batchNo || '', soldSerials: l.serials || '', serials: '',
        name: l.item ? `${l.item.code ? `${l.item.code} — ` : ''}${l.item.name || ''}` : l.itemId,
        uom: l.item?.uom || '',
        invoiced: r2(l.qty), returned: r2(l.returnedQty || 0), qty: 0,
        rate: l.rate, discountPct: l.discountPct || 0, gstRate: l.gstRate,
      })))
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to load invoice') } finally { setLoadingInv(false) }
  }

  // Shortcut from Sales Invoices (row "Return" button) opens the form with the invoice preselected
  useCreatePreset('sales-returns', (d) => {
    resetForm()
    setOpen(true)
    if (d.invoiceId) void pickInvoice(String(d.invoiceId))
  })

  async function submit() {
    if (!invoice) { toast.error('Select a sales invoice'); return }
    const chosen = lines.filter((l) => l.qty > 0)
    if (!chosen.length) { toast.error('Enter a return qty on at least one line'); return }
    const over = chosen.find((l) => l.qty > r2(l.invoiced - l.returned) + 0.005)
    if (over) { toast.error(`${over.name}: only ${r2(over.invoiced - over.returned)} can still be returned`); return }
    const badSerial = chosen.find((l) => isSerial(l.itemId) && serialList(l.serials).length !== l.qty)
    if (badSerial) { toast.error(`${badSerial.name}: enter the ${badSerial.qty} serial no(s) coming back`); return }
    setSaving(true)
    try {
      const res = await apiPost<{ number: string; refundDue?: number }>('/api/sales-returns', {
        companyId, invoiceId: invoice.id, date, warehouseId: warehouseId || undefined,
        reason: reason || undefined, notes: notes || undefined,
        lines: chosen.map((l) => ({ invoiceItemId: l.invoiceItemId, qty: l.qty, ...(isSerial(l.itemId) ? { serials: l.serials } : {}) })),
      })
      if ((res?.refundDue || 0) > 0.005) toast.success(`Credit note ${res.number} created — ${fmtMoney(res.refundDue || 0)} refund due to the customer`)
      else toast.success(`Credit note ${res?.number || ''} created`)
      setOpen(false); resetForm(); void list.refetch(); void invoices.refetch()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to create sales return') } finally { setSaving(false) }
  }

  async function cancelReturn(row: ReturnRow) {
    try {
      await apiPatch(`/api/sales-returns/${row.id}`, { action: 'cancel', companyId })
      toast.success(`Credit note ${row.number} cancelled`); void list.refetch()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to cancel') }
  }

  async function printReturn(row: ReturnRow) {
    let ret: ReturnRow = row
    try { ret = await apiGet<ReturnRow>(`/api/sales-returns/${row.id}?companyId=${companyId}`) } catch { /* list row fallback */ }
    const seller = ret.company ?? settings.data ?? undefined
    const cust = ret.customer
    const logo = safeImg(seller?.logoImage)
    const sign = safeImg(seller?.signatureImage)
    const sellerStateCode = seller?.stateCode || (seller?.gstin ? seller.gstin.slice(0, 2) : '')
    const buyerStateCode = cust?.stateCode || (cust?.gstin ? cust.gstin.slice(0, 2) : '')
    const taxSum = r2((ret.cgst || 0) + (ret.sgst || 0) + (ret.igst || 0))
    const roundOff = r2(ret.grandTotal - r2(ret.subtotal + taxSum))
    const html = `
      <style>
        @page { size: A4; margin: 10mm; }
        .cn { border: 1.5px solid #333; }
        .cn table { margin-top: 0; }
        .cn th, .cn td { border-color: #444; }
        .cn .grid td { vertical-align: top; padding: 8px 10px; }
        .cn .sec { font-size: 9px; font-weight: 700; letter-spacing: 1px; text-transform: uppercase; color: #555; margin-bottom: 4px; }
        .cn .title { text-align: center; font-size: 15px; font-weight: 800; letter-spacing: 4px; padding: 7px 10px; border-bottom: 1.5px solid #333; }
        .cn .logo { max-height: 64px; max-width: 150px; object-fit: contain; margin-right: 12px; }
        .cn .sign { max-height: 54px; max-width: 170px; object-fit: contain; display: block; margin: 8px 0 0 auto; }
        .cn .signline { border-top: 1px solid #333; margin-top: ${sign ? '4px' : '64px'}; padding-top: 5px; font-size: 11px; text-align: center; }
      </style>
      <div class="cn">
        <div class="title">CREDIT NOTE</div>
        <div class="head" style="padding:10px 12px">
          <div style="display:flex;align-items:flex-start">
            ${logo ? `<img class="logo" src="${esc(logo)}" alt="" />` : ''}
            <div>
              <h1 style="font-size:17px">${esc(seller?.name || 'Company')}</h1>
              <div class="muted">${esc(joinAddr(seller?.addressLine, seller?.city, seller?.state)) || '&nbsp;'}</div>
              <div class="muted">${seller?.gstin ? `GSTIN: ${esc(seller.gstin)}` : ''}</div>
              <div class="muted">${esc(joinAddr(seller?.phone, seller?.email))}</div>
              <div class="muted">${esc(joinAddr(seller?.state, sellerStateCode ? `State Code: ${sellerStateCode}` : ''))}</div>
            </div>
          </div>
          <div style="text-align:right">
            <div style="font-size:13px"><strong>Credit Note No: ${esc(ret.number)}</strong></div>
            <div class="muted">Date: ${esc(fmtDate(ret.date))}</div>
            <div class="muted">Against Invoice: <strong>${esc(ret.invoice?.number || '—')}</strong>${ret.invoice?.date ? ` dt. ${esc(fmtDate(ret.invoice.date))}` : ''}</div>
            <span class="badge">${esc(ret.status)}</span>
          </div>
        </div>
        <table class="grid"><tr>
          <td style="width:58%">
            <div class="sec">Customer</div>
            <strong style="font-size:13px">${esc(cust?.name || '—')}</strong>
            <div class="muted">${esc(joinAddr(cust?.addressLine, cust?.city)) || '&nbsp;'}</div>
            <div class="muted">${cust?.gstin ? `GSTIN: ${esc(cust.gstin)}` : ''}</div>
            <div class="muted">${esc(joinAddr(cust?.state, buyerStateCode ? `State Code: ${buyerStateCode}` : ''))}</div>
          </td>
          <td style="width:42%">
            <div class="sec">Details</div>
            <div class="muted">Supply Type: ${ret.isInterState ? 'Inter-State (IGST)' : 'Intra-State (CGST + SGST)'}</div>
            ${ret.invoice?.placeOfSupply ? `<div class="muted">Place of Supply: ${esc(ret.invoice.placeOfSupply)}</div>` : ''}
            ${ret.warehouse ? `<div class="muted">Received into: ${esc(ret.warehouse.name || ret.warehouse.code)}</div>` : ''}
            ${ret.reason ? `<div class="muted">Reason: ${esc(ret.reason)}</div>` : ''}
          </td>
        </tr></table>
        <table>
          <thead><tr><th style="width:26px">#</th><th>Item</th><th style="width:70px">HSN</th><th class="num" style="width:70px">Qty</th><th class="num" style="width:85px">Rate</th><th class="num" style="width:52px">Disc %</th><th class="num" style="width:52px">GST %</th><th class="num" style="width:95px">Taxable</th></tr></thead>
          <tbody>${ret.items.map((it, i) => `<tr><td>${i + 1}</td><td>${esc(it.item?.name || it.itemId)}${it.item?.code ? ` <span class="muted">(${esc(it.item.code)})</span>` : ''}</td><td>${esc(it.hsn || it.item?.hsn || '—')}</td><td class="num">${it.qty}${it.item?.uom ? ` ${esc(it.item.uom)}` : ''}</td><td class="num">${fmtMoney(it.rate)}</td><td class="num">${it.discountPct || 0}</td><td class="num">${it.gstRate}%</td><td class="num">${fmtMoney(it.lineTotal)}</td></tr>`).join('')}</tbody>
        </table>
        <table class="grid"><tr>
          <td style="width:55%">
            <div style="font-weight:700;font-size:12px;line-height:1.5">Amount in words: Rupees ${esc(amountInWords(ret.grandTotal))} Only</div>
            ${ret.notes ? `<div class="muted" style="margin-top:8px">Notes: ${esc(ret.notes)}</div>` : ''}
          </td>
          <td style="width:45%">
            <table class="totals" style="width:100%">
              <tr><td>Taxable Value</td><td class="num">${fmtMoney(ret.subtotal)}</td></tr>
              ${ret.isInterState
                ? `<tr><td>IGST</td><td class="num">${fmtMoney(ret.igst)}</td></tr>`
                : `<tr><td>CGST</td><td class="num">${fmtMoney(ret.cgst)}</td></tr><tr><td>SGST</td><td class="num">${fmtMoney(ret.sgst)}</td></tr>`}
              ${Math.abs(roundOff) >= 0.005 ? `<tr><td>Round Off</td><td class="num">${roundOff > 0 ? '+ ' : '- '}${fmtMoney(Math.abs(roundOff))}</td></tr>` : ''}
              <tr class="grand"><td>Credit Total</td><td class="num">${fmtMoney(ret.grandTotal)}</td></tr>
            </table>
          </td>
        </tr></table>
        <table class="grid"><tr>
          <td style="width:58%;border:none"><div class="muted">This credit note reduces the amount payable against the original invoice.</div></td>
          <td style="width:42%;border:none">
            <div style="font-weight:700;font-size:12px">For ${esc(seller?.name || 'Company')}</div>
            ${sign ? `<img class="sign" src="${esc(sign)}" alt="" />` : ''}
            <div class="signline">Authorised Signatory</div>
          </td>
        </tr></table>
      </div>`
    printHtml(`Credit Note ${ret.number}`, html)
  }

  const totals = computeTotals(lines, invoice?.isInterState ?? false, settings.data?.roundOffTotals ?? true)

  const columns: Column<ReturnRow>[] = [
    { key: 'number', header: 'Credit Note #', render: (r) => <span className="font-medium">{r.number}</span> },
    { key: 'date', header: 'Date', render: (r) => <DateCell value={r.date} /> },
    { key: 'invoice', header: 'Invoice', sortValue: (r) => r.invoice?.number || '', render: (r) => r.invoice?.number || '—' },
    { key: 'customer', header: 'Customer', sortValue: (r) => r.customer?.name || '', render: (r) => r.customer?.name || '—' },
    { key: 'items', header: 'Items', hideOnMobile: true, sortValue: (r) => r.items.length, render: (r) => r.items.length },
    { key: 'grandTotal', header: 'Amount', sortValue: (r) => r.grandTotal || 0, sum: true, sumFormat: 'money', render: (r) => <Money value={r.grandTotal} className="font-medium" /> },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
    {
      key: 'actions', header: 'Actions',
      render: (r) => (
        <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
          <Button variant="ghost" size="sm" className="h-7" title="Print credit note" onClick={() => void printReturn(r)}><Printer className="h-3.5 w-3.5" /></Button>
          {r.status === 'POSTED' && (
            <ConfirmAction
              trigger={<Button variant="ghost" size="sm" className="h-7 text-red-600" title="Cancel credit note"><X className="h-3.5 w-3.5" /></Button>}
              title="Cancel credit note?" tone="destructive"
              message={`Cancel ${r.number}? The returned goods go back out of stock and the credit is removed from invoice ${r.invoice?.number || ''}.`}
              onConfirm={() => cancelReturn(r)}
            />
          )}
        </div>
      ),
    },
  ]

  return (
    <div>
      <PageHeader
        title="Sales Returns (Credit Notes)"
        description="Goods returned by customers — stock comes back in and the invoice balance is reduced"
        actions={<Button onClick={() => { resetForm(); setOpen(true) }}><Plus className="h-4 w-4 mr-1.5" />Sales Return</Button>}
      />
      <DataTable columns={columns} rows={rows} loading={list.loading} searchPlaceholder="Search credit notes…" highlightId={highlightId} sortable />

      <FormDialog
        open={open} onOpenChange={setOpen} wide title="Sales Return / Credit Note" submitLabel="Save Credit Note"
        description="Pick the original invoice, then enter the quantity coming back on each line" loading={saving} onSubmit={submit}
      >
        {!invoice ? (
          <Field label="Sales Invoice" required>
            <TextInput value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by invoice no. or customer…" autoFocus />
            <div className="max-h-64 overflow-y-auto rounded-md border divide-y">
              {loadingInv && <p className="p-3 text-sm text-muted-foreground">Loading invoice…</p>}
              {!loadingInv && !invoiceChoices.length && <p className="p-3 text-sm text-muted-foreground">No matching invoices</p>}
              {!loadingInv && invoiceChoices.map((i) => (
                <button key={i.id} type="button" onClick={() => void pickInvoice(i.id)}
                  className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-muted/60">
                  <span className="min-w-0">
                    <span className="font-medium">{i.number}</span>
                    <span className="text-muted-foreground"> · {fmtDate(i.date)} · {i.customer?.name || '—'}</span>
                  </span>
                  <span className="tabular-nums font-medium whitespace-nowrap">{fmtMoney(i.grandTotal)}</span>
                </button>
              ))}
            </div>
          </Field>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/30 px-3 py-2 text-sm">
              <span><span className="font-medium">{invoice.number}</span> · {fmtDate(invoice.date)} · {invoice.customer?.name || '—'}</span>
              <Button type="button" variant="ghost" size="sm" onClick={() => { setInvoice(null); setLines([]) }}>Change</Button>
            </div>
            <div className="grid sm:grid-cols-3 gap-4">
              <Field label="Date" required><DateInput value={date} onChange={setDate} /></Field>
              <Field label="Receive into warehouse">
                <SelectInput value={warehouseId || defaultWh} onChange={setWarehouseId} options={whOpts} placeholder="FG store" />
              </Field>
              <Field label="Reason"><TextInput value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Damaged / wrong item…" /></Field>
              <Field label="Notes" className="sm:col-span-3"><TextInput value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Remarks…" /></Field>
            </div>
            <div className="space-y-2">
              <div className="hidden sm:grid grid-cols-12 gap-2 px-0.5 text-[11px] font-medium text-muted-foreground">
                <span className="col-span-5">Item</span><span className="col-span-2 text-right">Invoiced</span><span className="col-span-2 text-right">Already returned</span><span className="col-span-3">Return qty</span>
              </div>
              {lines.map((l, idx) => {
                const left = r2(l.invoiced - l.returned)
                return (
                  <div key={l.invoiceItemId} className="grid grid-cols-12 gap-2 items-center rounded-md border p-2 sm:border-0 sm:p-0">
                    <div className="col-span-12 sm:col-span-5 text-sm">
                      <p className="font-medium truncate">{l.name}</p>
                      <p className="text-[11px] text-muted-foreground">{fmtMoney(l.rate)}{l.discountPct ? ` − ${l.discountPct}%` : ''} · GST {l.gstRate}%{l.soldBatch ? ` · Batch ${l.soldBatch}` : ''}</p>
                    </div>
                    <span className="col-span-4 sm:col-span-2 text-sm text-right tabular-nums">{l.invoiced} {l.uom}</span>
                    <span className="col-span-4 sm:col-span-2 text-sm text-right tabular-nums text-muted-foreground">{l.returned}</span>
                    <div className="col-span-4 sm:col-span-3">
                      <NumberInput value={l.qty} min={0} max={left} disabled={left <= 0} placeholder="0"
                        onChange={(n) => setLines((ls) => ls.map((x, i) => (i === idx ? { ...x, qty: n } : x)))} />
                    </div>
                    {isSerial(l.itemId) && l.qty > 0 && (
                      <div className="col-span-12 space-y-1 pl-2 border-l-2 border-muted">
                        <span className={serialList(l.serials).length === l.qty ? 'text-[10px] text-muted-foreground uppercase' : 'text-[10px] text-amber-600 uppercase'}>
                          Serial nos coming back — {serialList(l.serials).length} of {l.qty}
                        </span>
                        <Textarea rows={2} value={l.serials} placeholder="One serial / IMEI per line"
                          onChange={(e) => setLines((ls) => ls.map((x, i) => (i === idx ? { ...x, serials: e.target.value } : x)))} />
                        {l.soldSerials && (
                          <p className="text-[10px] text-muted-foreground break-all">Sold on this line: {serialList(l.soldSerials).join(', ')}</p>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
              <div className="rounded-md border bg-muted/30 p-3 text-sm grid grid-cols-2 sm:grid-cols-5 gap-2">
                <TotCell label="Taxable" value={totals.taxable} />
                {invoice.isInterState
                  ? <TotCell label="IGST" value={totals.igst} />
                  : <><TotCell label="CGST" value={totals.cgst} /><TotCell label="SGST" value={totals.sgst} /></>}
                <TotCell label="Round off" value={totals.roundOff} />
                <TotCell label="Credit Total" value={totals.grand} bold />
              </div>
              <p className="text-[11px] text-muted-foreground">Valued at the invoice rate less line discount; bill-level discount and freight/packing are not reversed.</p>
            </div>
          </>
        )}
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
