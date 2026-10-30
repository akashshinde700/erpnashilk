'use client'

import * as React from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Plus, Printer, X } from 'lucide-react'
import {
  Column, ConfirmAction, DataTable, DateCell, DateInput, Field, FormDialog, Money,
  NumberInput, PageHeader, SelectInput, StatusBadge, TextInput, printHtml, useCreatePreset,
} from '@/components/erp/kit'
import { apiGet, apiPatch, apiPost, useList } from '@/lib/use-api'
import { fmtMoney, fmtNum } from '@/lib/erp-constants'
import { amountInWords } from '@/lib/number-to-words'
import { RefundDialog } from '@/components/erp/refund-dialog'

interface CompanyBlock {
  name?: string | null; gstin?: string | null; addressLine?: string | null; city?: string | null; state?: string | null
  stateCode?: string | null; phone?: string | null; email?: string | null; roundOffTotals?: boolean | null
}
interface RetItem {
  id: string; invoiceItemId?: string | null; itemId: string; qty: number; rate: number; gstRate: number; lineTotal: number
  item?: { code?: string | null; name?: string | null; uom?: string | null; hsn?: string | null } | null
}
interface RetRow {
  id: string; number: string; date: string; invoiceId: string; supplierId: string; warehouseId: string; status: string
  reason?: string | null; notes?: string | null; isInterState: boolean
  subtotal: number; cgst: number; sgst: number; igst: number; grandTotal: number
  invoice?: { number?: string | null; date?: string | null; supplierInvNo?: string | null; supplierInvDate?: string | null } | null
  supplier?: { name?: string | null; gstin?: string | null; addressLine?: string | null; city?: string | null; state?: string | null; stateCode?: string | null } | null
  warehouse?: { code?: string | null; name?: string | null } | null
  items: RetItem[]
  // refund on the note (Phase 4): applied to its bill, received from the supplier, still due
  refund?: { total: number; appliedToBill: number; refunded: number; remaining: number } | null
}
interface BillRow {
  id: string; number: string; status: string; grandTotal: number; paidAmount: number; isInterState?: boolean
  supplierInvNo?: string | null; supplier?: { name?: string | null } | null
}
interface BillDetail extends BillRow {
  items: { id: string; itemId: string; qty: number; rate: number; gstRate: number; item?: { code?: string | null; name?: string | null; uom?: string | null } | null }[]
}
interface DraftLine {
  invoiceItemId: string; label: string; uom: string; billed: number; returned: number; rate: number; gstRate: number; qty: number
  itemId: string; batchNo: string; serials: string
}
interface ItemFlags { id: string; batchTracked?: boolean; trackSerial?: boolean }
const SERIAL_SPLIT = /[\r\n,;]+/
const serialList = (t: string) => Array.from(new Set(t.split(SERIAL_SPLIT).map((x) => x.trim()).filter(Boolean)))

const r2 = (n: number) => Math.round(n * 100) / 100
const today = () => new Date().toISOString().slice(0, 10)
const esc = (v?: string | null) =>
  (v ?? '').replace(/[&<>"]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'))
const joinAddr = (...parts: (string | null | undefined)[]) =>
  parts.filter((p): p is string => !!p && p.trim() !== '').join(', ')

/** Live preview — same formula as computeBillTotals() on the server (no bill-level discount / charges on a return). */
function computeTotals(lines: DraftLine[], interState: boolean, roundOff: boolean) {
  let taxable = 0, gst = 0
  for (const l of lines) {
    const t = (l.qty || 0) * l.rate
    taxable += t
    gst += t * ((l.gstRate || 0) / 100)
  }
  const cgst = interState ? 0 : r2(gst / 2)
  const sgst = interState ? 0 : r2(gst / 2)
  const igst = interState ? r2(gst) : 0
  const exact = r2(taxable + cgst + sgst + igst)
  const grand = roundOff ? Math.round(exact) : exact
  return { taxable: r2(taxable), cgst, sgst, igst, roundOff: r2(grand - exact), grand: r2(grand) }
}

/** Batch picker — batches with stock in the warehouse, FEFO order; blank = auto FEFO. */
function ReturnBatchPick({ companyId, itemId, warehouseId, value, onChange }: {
  companyId: string; itemId: string; warehouseId: string; value: string; onChange: (v: string) => void
}) {
  const batches = useList<{ items: { id: string; batchNo: string; qty: number; expiryDate?: string | null }[] }>(
    warehouseId ? `/api/batches?companyId=${companyId}&itemId=${itemId}&warehouseId=${warehouseId}` : null,
  )
  const opts = [
    { value: '', label: 'Auto (earliest expiry first)' },
    ...(batches.data?.items ?? []).map((b) => ({
      value: b.batchNo, label: `${b.batchNo} · qty ${b.qty}${b.expiryDate ? ` · exp ${new Date(b.expiryDate).toLocaleDateString('en-IN')}` : ''}`,
    })),
  ]
  return <SelectInput value={value} onChange={onChange} options={opts} disabled={!warehouseId} placeholder="Batch…" />
}

export default function PurchaseReturnsModule({ companyId }: { companyId: string }) {
  const list = useList<{ items: RetRow[] }>(`/api/purchase-returns?companyId=${companyId}`)
  const bills = useList<{ items: BillRow[] }>(`/api/purchase-invoices?companyId=${companyId}`)
  const warehouses = useList<{ items: { id: string; code: string; name: string; type: string }[] }>(`/api/warehouses?companyId=${companyId}`)
  const settings = useList<CompanyBlock>(`/api/settings?companyId=${companyId}`)
  const itemMaster = useList<{ items: ItemFlags[] }>(`/api/items?companyId=${companyId}`)
  const flagOf = (itemId: string) => (itemMaster.data?.items ?? []).find((i) => i.id === itemId)

  const [open, setOpen] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [invoiceId, setInvoiceId] = React.useState('')
  const [bill, setBill] = React.useState<BillDetail | null>(null)
  const [loadingBill, setLoadingBill] = React.useState(false)
  const [date, setDate] = React.useState(today)
  const [warehouseId, setWarehouseId] = React.useState('')
  const [reason, setReason] = React.useState('')
  const [notes, setNotes] = React.useState('')
  const [lines, setLines] = React.useState<DraftLine[]>([])

  const rows = list.data?.items ?? []
  const billOpts = (bills.data?.items ?? [])
    .filter((b) => b.status !== 'CANCELLED')
    .map((b) => ({ value: b.id, label: `${b.number} — ${b.supplier?.name || ''}${b.supplierInvNo ? ` (inv ${b.supplierInvNo})` : ''} · ${fmtMoney(b.grandTotal)}` }))

  function resetForm() {
    setInvoiceId(''); setBill(null); setDate(today()); setWarehouseId(''); setReason(''); setNotes(''); setLines([])
  }

  async function pickBill(id: string) {
    setInvoiceId(id); setBill(null); setLines([])
    if (!id) return
    setLoadingBill(true)
    try {
      const [detail, prior] = await Promise.all([
        apiGet<BillDetail>(`/api/purchase-invoices/${id}?companyId=${companyId}`),
        apiGet<{ items: RetRow[] }>(`/api/purchase-returns?companyId=${companyId}&invoiceId=${id}`),
      ])
      const done = new Map<string, number>()
      for (const r of prior.items ?? []) {
        if (r.status === 'CANCELLED') continue
        for (const it of r.items) if (it.invoiceItemId) done.set(it.invoiceItemId, r2((done.get(it.invoiceItemId) || 0) + it.qty))
      }
      setBill(detail)
      setLines((detail.items ?? []).map((it) => ({
        invoiceItemId: it.id,
        label: it.item ? `${it.item.code ? `${it.item.code} — ` : ''}${it.item.name ?? ''}` : it.itemId,
        uom: it.item?.uom || '',
        billed: it.qty, returned: done.get(it.id) || 0, rate: it.rate, gstRate: it.gstRate, qty: 0,
        itemId: it.itemId, batchNo: '', serials: '',
      })))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to load the bill')
    } finally { setLoadingBill(false) }
  }

  // Shortcut from a purchase bill row ("Return") opens this form with the bill pre-selected
  useCreatePreset('purchase-returns', (d) => {
    resetForm()
    setOpen(true)
    if (d.invoiceId) void pickBill(String(d.invoiceId))
  })

  const totals = computeTotals(lines, !!bill?.isInterState, settings.data?.roundOffTotals ?? true)
  // Same default as the server: RM store, else the first warehouse
  const whList = warehouses.data?.items ?? []
  const effectiveWh = warehouseId || (whList.find((w) => w.type === 'RM') ?? whList[0])?.id || ''
  const outstanding = bill ? Math.max(0, r2(bill.grandTotal - bill.paidAmount)) : 0

  async function submit() {
    if (!invoiceId) { toast.error('Select a purchase bill'); return }
    const valid = lines.filter((l) => l.qty > 0)
    if (!valid.length) { toast.error('Enter a return qty on at least one line'); return }
    const over = valid.find((l) => l.qty > r2(l.billed - l.returned) + 0.0005)
    if (over) { toast.error(`${over.label}: only ${fmtNum(r2(over.billed - over.returned))} can still be returned`); return }
    const badSerial = valid.find((l) => flagOf(l.itemId)?.trackSerial && serialList(l.serials).length !== l.qty)
    if (badSerial) { toast.error(`${badSerial.label}: enter the ${badSerial.qty} serial no(s) going back`); return }
    setSaving(true)
    try {
      const res = await apiPost<RetRow & { refundDue?: number; debitApplied?: number }>('/api/purchase-returns', {
        companyId, invoiceId, date, warehouseId: warehouseId || undefined,
        reason: reason || undefined, notes: notes || undefined,
        lines: valid.map((l) => ({
          invoiceItemId: l.invoiceItemId, qty: l.qty,
          ...(flagOf(l.itemId)?.batchTracked && l.batchNo ? { batchNo: l.batchNo } : {}),
          ...(flagOf(l.itemId)?.trackSerial ? { serials: l.serials } : {}),
        })),
      })
      toast.success(`Debit note ${res.number} created`, {
        description: (res.refundDue || 0) > 0
          ? `${fmtMoney(res.debitApplied || 0)} adjusted against the bill; ${fmtMoney(res.refundDue)} to be refunded by the supplier`
          : `${fmtMoney(res.debitApplied || 0)} adjusted against the bill`,
      })
      setOpen(false); resetForm(); void list.refetch(); void bills.refetch()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to create the debit note') } finally { setSaving(false) }
  }

  async function cancelReturn(row: RetRow) {
    try {
      await apiPatch(`/api/purchase-returns/${row.id}`, { action: 'cancel', companyId })
      toast.success(`Debit note ${row.number} cancelled — stock and bill restored`)
      void list.refetch(); void bills.refetch()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to cancel') }
  }

  function printReturn(row: RetRow) {
    const co = settings.data
    const sup = row.supplier
    const items = row.items ?? []
    const taxable = r2(items.reduce((s, it) => s + (it.lineTotal || 0), 0))
    const exact = r2(taxable + row.cgst + row.sgst + row.igst)
    const roundOff = r2(row.grandTotal - exact)
    const html = `
      <div class="head">
        <div>
          <h1>${esc(co?.name || '')}</h1>
          <div class="muted">${esc(joinAddr(co?.addressLine, co?.city, co?.state))}</div>
          <div class="muted">${co?.gstin ? `GSTIN: ${esc(co.gstin)}` : ''}${co?.stateCode ? ` &nbsp;·&nbsp; State Code: ${esc(co.stateCode)}` : ''}</div>
          <div class="muted">${esc(joinAddr(co?.phone, co?.email))}</div>
        </div>
        <div style="text-align:right">
          <div style="font-size:18px;font-weight:800;letter-spacing:3px">DEBIT NOTE</div>
          <div><strong>No: ${esc(row.number)}</strong></div>
          <div class="muted">Date: ${new Date(row.date).toLocaleDateString('en-IN')}</div>
          <span class="badge">${esc(row.status)}</span>
        </div>
      </div>
      <table><tr>
        <td style="width:55%;vertical-align:top">
          <div class="muted">To (Supplier)</div>
          <strong>${esc(sup?.name || '—')}</strong>
          <div class="muted">${esc(joinAddr(sup?.addressLine, sup?.city, sup?.state))}</div>
          <div class="muted">${sup?.gstin ? `GSTIN: ${esc(sup.gstin)}` : ''}${sup?.stateCode ? ` &nbsp;·&nbsp; State Code: ${esc(sup.stateCode)}` : ''}</div>
        </td>
        <td style="vertical-align:top">
          <div class="muted">Against purchase bill</div>
          <strong>${esc(row.invoice?.number || '')}</strong>${row.invoice?.date ? ` <span class="muted">dated ${new Date(row.invoice.date).toLocaleDateString('en-IN')}</span>` : ''}
          ${row.invoice?.supplierInvNo ? `<div class="muted">Supplier invoice: ${esc(row.invoice.supplierInvNo)}${row.invoice.supplierInvDate ? ` dated ${new Date(row.invoice.supplierInvDate).toLocaleDateString('en-IN')}` : ''}</div>` : ''}
          <div class="muted">Supply: ${row.isInterState ? 'Inter-State (IGST)' : 'Intra-State (CGST + SGST)'}</div>
          ${row.reason ? `<div class="muted">Reason: ${esc(row.reason)}</div>` : ''}
        </td>
      </tr></table>
      <table>
        <thead><tr><th>#</th><th>Item</th><th>HSN</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">GST %</th><th class="num">Taxable</th></tr></thead>
        <tbody>
          ${items.map((it, i) => `<tr>
            <td>${i + 1}</td>
            <td>${esc(it.item ? `${it.item.code ? `${it.item.code} — ` : ''}${it.item.name ?? ''}` : it.itemId)}</td>
            <td>${esc(it.item?.hsn || '')}</td>
            <td class="num">${fmtNum(it.qty)} ${esc(it.item?.uom || '')}</td>
            <td class="num">${fmtMoney(it.rate)}</td>
            <td class="num">${it.gstRate}%</td>
            <td class="num">${fmtMoney(it.lineTotal)}</td>
          </tr>`).join('')}
        </tbody>
      </table>
      <table class="totals" style="width:auto;margin-left:auto">
        <tr><td>Taxable value</td><td class="num">${fmtMoney(taxable)}</td></tr>
        ${row.isInterState
          ? `<tr><td>IGST</td><td class="num">${fmtMoney(row.igst)}</td></tr>`
          : `<tr><td>CGST</td><td class="num">${fmtMoney(row.cgst)}</td></tr><tr><td>SGST</td><td class="num">${fmtMoney(row.sgst)}</td></tr>`}
        ${roundOff !== 0 ? `<tr><td>Round off</td><td class="num">${fmtMoney(roundOff)}</td></tr>` : ''}
        <tr class="grand"><td>Total debit</td><td class="num">${fmtMoney(row.grandTotal)}</td></tr>
      </table>
      <p style="margin-top:10px"><strong>Amount in words:</strong> ${esc(amountInWords(row.grandTotal))}</p>
      ${row.notes ? `<p class="muted">Notes: ${esc(row.notes)}</p>` : ''}
      <p class="muted">We have debited your account for the goods returned above.</p>
      <div style="display:flex;justify-content:flex-end;margin-top:60px">
        <div style="border-top:1px solid #333;padding-top:5px;min-width:200px;text-align:center">For ${esc(co?.name || '')}<br/>Authorised Signatory</div>
      </div>`
    printHtml(`Debit Note ${row.number}`, html)
  }

  // ----- Refund still due from the supplier on a note -----
  const [refundRow, setRefundRow] = React.useState<RetRow | null>(null)
  const due = (r: RetRow) => (r.status === 'POSTED' ? r.refund?.remaining ?? 0 : 0)

  const columns: Column<RetRow>[] = [
    { key: 'number', header: 'Debit Note #', render: (r) => <span className="font-medium">{r.number}</span> },
    { key: 'date', header: 'Date', render: (r) => <DateCell value={r.date} /> },
    { key: 'bill', header: 'Bill No', sortValue: (r) => r.invoice?.number || '', render: (r) => r.invoice?.number || '—' },
    { key: 'supplier', header: 'Supplier', sortValue: (r) => r.supplier?.name || '', render: (r) => r.supplier?.name || '—' },
    { key: 'amount', header: 'Amount', sortValue: (r) => r.grandTotal || 0, sum: true, sumFormat: 'money', render: (r) => <Money value={r.grandTotal} className="font-medium" /> },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
    {
      key: 'refundDue', header: 'Refund due', hideOnMobile: true, sortValue: (r) => due(r),
      render: (r) => (due(r) > 0.005 ? <Money value={due(r)} className="font-medium text-warning" /> : <span className="text-muted-foreground">—</span>),
    },
    {
      key: 'actions', header: 'Actions',
      render: (r) => (
        <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
          {due(r) > 0.005 && <Button variant="outline" size="sm" className="h-7" onClick={() => setRefundRow(r)}>Record refund</Button>}
          <Button variant="outline" size="sm" className="h-7" onClick={() => printReturn(r)} title="Print debit note">
            <Printer className="h-3.5 w-3.5 mr-0.5" />Print
          </Button>
          {r.status !== 'CANCELLED' && (
            <ConfirmAction
              trigger={<Button variant="ghost" size="sm" className="h-7 text-destructive" title="Cancel"><X className="h-3.5 w-3.5" /></Button>}
              title="Cancel debit note?" tone="destructive"
              message={`Cancel ${r.number}? The goods are taken back into stock and the bill's outstanding goes up again.`}
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
        title="Purchase Returns (Debit Notes)"
        description="Goods sent back to suppliers — stock out and the bill's outstanding reduced"
        actions={<Button onClick={() => { resetForm(); setOpen(true) }}><Plus className="h-4 w-4 mr-1.5" />Debit Note</Button>}
      />
      <DataTable columns={columns} rows={rows} loading={list.loading} searchPlaceholder="Search debit notes…" moduleKey="purchase-returns" savedViewsKey={`${companyId}:purchase-returns`} sortable />

      <FormDialog
        open={open} onOpenChange={setOpen} wide title="Purchase Return / Debit Note" submitLabel="Create Debit Note"
        description="Return goods from a purchase bill at the billed rates" loading={saving} onSubmit={submit}
      >
        <div className="grid sm:grid-cols-2 gap-4">
          <Field label="Purchase bill" required className="sm:col-span-2">
            <SelectInput value={invoiceId} onChange={(v) => void pickBill(v)} options={billOpts} placeholder="Select a bill…" />
          </Field>
          <Field label="Date" required><DateInput value={date} onChange={setDate} /></Field>
          <Field label="Return from warehouse">
            <SelectInput value={warehouseId} onChange={setWarehouseId}
              options={[{ value: '', label: 'Raw material store (default)' }, ...(warehouses.data?.items ?? []).map((w) => ({ value: w.id, label: `${w.code} — ${w.name}` }))]} />
          </Field>
          <Field label="Reason"><TextInput value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Damaged / rejected / excess…" /></Field>
          <Field label="Notes"><TextInput value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Remarks…" /></Field>
        </div>

        {loadingBill && <p className="text-sm text-muted-foreground">Loading bill…</p>}
        {bill && (
          <div className="space-y-2">
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Lines</span>
            <div className="hidden sm:grid grid-cols-12 gap-2 px-0.5 text-[11px] font-medium text-muted-foreground">
              <span className="col-span-4">Item</span><span className="col-span-2 text-right">Billed</span><span className="col-span-2 text-right">Already returned</span>
              <span className="col-span-2 text-right">Rate (₹)</span><span className="col-span-2">Return qty</span>
            </div>
            {lines.map((l, idx) => {
              const left = r2(l.billed - l.returned)
              return (
                <div key={l.invoiceItemId} className="grid grid-cols-12 gap-2 items-center text-sm">
                  <span className="col-span-12 sm:col-span-4 truncate" title={l.label}>{l.label}</span>
                  <span className="col-span-3 sm:col-span-2 text-right tabular-nums">{fmtNum(l.billed)} {l.uom}</span>
                  <span className="col-span-3 sm:col-span-2 text-right tabular-nums text-muted-foreground">{fmtNum(l.returned)}</span>
                  <span className="col-span-3 sm:col-span-2 text-right tabular-nums">{fmtMoney(l.rate)} <span className="text-[10px] text-muted-foreground">+{l.gstRate}%</span></span>
                  <NumberInput className="col-span-3 sm:col-span-2" value={l.qty} min={0} max={left} disabled={left <= 0}
                    placeholder={left > 0 ? `max ${fmtNum(left)}` : 'none left'}
                    onChange={(n) => setLines((ls) => ls.map((x, i) => (i === idx ? { ...x, qty: n } : x)))} />
                  {l.qty > 0 && (flagOf(l.itemId)?.batchTracked || flagOf(l.itemId)?.trackSerial) && (
                    <div className="col-span-12 grid sm:grid-cols-2 gap-2 pl-2 border-l-2 border-muted">
                      {flagOf(l.itemId)?.batchTracked && (
                        <div>
                          <span className="text-[10px] text-muted-foreground uppercase">Batch</span>
                          <ReturnBatchPick companyId={companyId} itemId={l.itemId} warehouseId={effectiveWh} value={l.batchNo}
                            onChange={(v) => setLines((ls) => ls.map((x, i) => (i === idx ? { ...x, batchNo: v } : x)))} />
                        </div>
                      )}
                      {flagOf(l.itemId)?.trackSerial && (
                        <div className={flagOf(l.itemId)?.batchTracked ? '' : 'sm:col-span-2'}>
                          <span className={serialList(l.serials).length === l.qty ? 'text-[10px] text-muted-foreground uppercase' : 'text-[10px] text-warning uppercase'}>
                            Serial nos going back — {serialList(l.serials).length} of {l.qty}
                          </span>
                          <Textarea rows={2} value={l.serials} placeholder="One serial / IMEI per line"
                            onChange={(e) => setLines((ls) => ls.map((x, i) => (i === idx ? { ...x, serials: e.target.value } : x)))} />
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
            <div className="rounded-md border bg-muted/30 p-3 text-sm grid grid-cols-2 sm:grid-cols-4 gap-2">
              <TotCell label="Taxable" value={totals.taxable} />
              {bill.isInterState
                ? <TotCell label="IGST" value={totals.igst} />
                : (<><TotCell label="CGST" value={totals.cgst} /><TotCell label="SGST" value={totals.sgst} /></>)}
              {totals.roundOff !== 0 && <TotCell label="Round off" value={totals.roundOff} />}
              <TotCell label="Return total" value={totals.grand} bold />
            </div>
            <p className="text-[11px] text-muted-foreground">
              Bill outstanding {fmtMoney(outstanding)}.{' '}
              {totals.grand > outstanding + 0.01
                ? `${fmtMoney(outstanding)} will be adjusted against the bill; ${fmtMoney(r2(totals.grand - outstanding))} is a refund due from the supplier.`
                : 'The return total is adjusted against the bill outstanding.'}
              {' '}Bill-level discount and freight / packing are not apportioned to returns.
            </p>
          </div>
        )}
      </FormDialog>

      {refundRow && (
        <RefundDialog
          key={refundRow.id} companyId={companyId} open onClose={() => setRefundRow(null)}
          title="Refund from supplier" accountLabel="Received into account"
          description={`${refundRow.number} · ${refundRow.supplier?.name || ''} — money the supplier pays back`}
          maxAmount={due(refundRow)}
          onSave={async (v) => {
            await apiPost('/api/payments', { companyId, type: 'RECEIPT', invoiceType: 'PURCHASE_RETURN', invoiceId: refundRow.id, supplierId: refundRow.supplierId, ...v })
            toast.success('Refund recorded'); void list.refetch()
          }}
        />
      )}
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
