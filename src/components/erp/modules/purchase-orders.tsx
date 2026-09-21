'use client'

import * as React from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Check, Plus, Printer, Trash2, Upload, X } from 'lucide-react'
import {
  Column, ConfirmAction, DataTable, DateCell, DateInput, Field, FormDialog, Money,
  NumberInput, PageHeader, SelectInput, StatusBadge, TextInput, printHtml,
} from '@/components/erp/kit'
import { apiGet, apiPatch, apiPost, useList } from '@/lib/use-api'
import { fmtMoney } from '@/lib/erp-constants'

interface PartyRow { id: string; name?: string | null; code?: string | null }
interface ItemRow { id: string; code?: string | null; name?: string | null; uom?: string | null; purchasePrice?: number | null; gstRate?: number | null }
interface PoItem { id: string; itemId: string; qty: number; rate: number; gstRate: number; lineTotal: number; receivedQty?: number; item?: { code?: string | null; name?: string | null; uom?: string | null } | null }
interface PoRow {
  id: string; number: string; orderDate: string; expectedDate?: string | null; status: string
  subtotal: number; discountTotal: number; cgst: number; sgst: number; igst: number; grandTotal: number
  approvedBy?: string | null; notes?: string | null
  supplier?: { name?: string | null; gstin?: string | null; city?: string | null; state?: string | null } | null
  items?: PoItem[] | null
}
interface DraftLine { itemId: string; qty: number; rate: number; gstRate: number }

const r2 = (n: number) => Math.round(n * 100) / 100
const today = () => new Date().toISOString().slice(0, 10)

function computeTotals(lines: DraftLine[]) {
  let taxable = 0, gst = 0
  for (const l of lines) {
    const gross = l.qty * l.rate
    taxable += gross
    gst += gross * ((l.gstRate || 0) / 100)
  }
  return { subtotal: r2(taxable), cgst: r2(gst / 2), sgst: r2(gst / 2), grand: r2(taxable + gst) }
}
function emptyLine(): DraftLine { return { itemId: '', qty: 1, rate: 0, gstRate: 18 } }

export default function PurchaseOrdersModule({ companyId }: { companyId: string }) {
  const list = useList<{ items: PoRow[] }>(`/api/purchase-orders?companyId=${companyId}`)
  const suppliers = useList<{ items: PartyRow[] }>(`/api/suppliers?companyId=${companyId}`)
  const items = useList<{ items: ItemRow[] }>(`/api/items?companyId=${companyId}`)
  const prs = useList<{ items: { id: string; number: string; status: string }[] }>(`/api/purchase-requisitions?companyId=${companyId}`)

  const [open, setOpen] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [supplierId, setSupplierId] = React.useState('')
  const [prId, setPrId] = React.useState('')
  const [orderDate, setOrderDate] = React.useState(today)
  const [expectedDate, setExpectedDate] = React.useState('')
  const [notes, setNotes] = React.useState('')
  const [lines, setLines] = React.useState<DraftLine[]>([emptyLine()])
  const [detail, setDetail] = React.useState<PoRow | null>(null)

  const rows = list.data?.items ?? []
  const supplierOpts = (suppliers.data?.items ?? []).map((s) => ({ value: s.id, label: s.name || s.id }))
  const itemOpts = (items.data?.items ?? []).map((i) => ({ value: i.id, label: i.code && i.name ? `${i.code} — ${i.name}` : i.name || i.id }))
  const prOpts = (prs.data?.items ?? []).filter((p) => p.status === 'PENDING').map((p) => ({ value: p.id, label: p.number }))

  function resetForm() {
    setSupplierId(''); setPrId(''); setOrderDate(today()); setExpectedDate(''); setNotes('')
    setLines([emptyLine()])
  }

  async function pickPr(pid: string) {
    setPrId(pid)
    if (!pid) return
    try {
      const pr = await apiGet<{ number: string; items?: { itemId: string; qty: number }[] | null }>(`/api/purchase-requisitions/${pid}?companyId=${companyId}`)
      const itemMap = items.data?.items ?? []
      const mapped = (pr.items ?? []).map((it) => {
        const meta = itemMap.find((o) => o.id === it.itemId)
        return { itemId: it.itemId, qty: it.qty, rate: Number(meta?.purchasePrice || 0), gstRate: Number(meta?.gstRate ?? 18) }
      })
      setLines(mapped.length ? mapped : [emptyLine()])
      toast.success(`Loaded ${mapped.length} line(s) from PR ${pr.number}`)
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to load requisition') }
  }

  async function submit() {
    if (!supplierId) { toast.error('Select a supplier'); return }
    const valid = lines.filter((l) => l.itemId && l.qty > 0)
    if (!valid.length) { toast.error('Add at least one line with item and qty'); return }
    setSaving(true)
    try {
      await apiPost('/api/purchase-orders', {
        companyId, supplierId, prId: prId || undefined, orderDate,
        expectedDate: expectedDate || undefined, notes: notes || undefined, items: valid,
      })
      toast.success('Purchase order created' + (prId ? ' — requisition converted' : ''))
      setOpen(false); resetForm(); void list.refetch(); void prs.refetch()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to create PO') } finally { setSaving(false) }
  }

  async function act(row: PoRow, body: Record<string, unknown>, msg: string) {
    try {
      await apiPatch(`/api/purchase-orders/${row.id}`, { ...body, companyId })
      toast.success(msg); void list.refetch()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed') }
  }

  async function cancelPo(row: PoRow) {
    await act(row, { action: 'cancel' }, `Purchase order ${row.number} cancelled`)
  }

  function printPo(po: PoRow) {
    const html = `
      <div class="head">
        <div><h1>Acme Precision Manufacturing Pvt Ltd</h1><div class="muted">Purchase Order · ${po.number}</div></div>
        <div style="text-align:right"><span class="badge">${po.status}</span><br/>
          <div class="muted">Order date: ${new Date(po.orderDate).toLocaleDateString('en-IN')}</div>
          ${po.expectedDate ? `<div class="muted">Expected: ${new Date(po.expectedDate).toLocaleDateString('en-IN')}</div>` : ''}</div>
      </div>
      <p><strong>Supplier:</strong> ${po.supplier?.name || '—'}${po.supplier?.gstin ? ` · GSTIN ${po.supplier.gstin}` : ''}
      ${po.supplier?.city ? `<br/><span class="muted">${po.supplier.city}${po.supplier.state ? ', ' + po.supplier.state : ''}</span>` : ''}</p>
      <table>
        <thead><tr><th>#</th><th>Item</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">GST %</th><th class="num">Amount</th></tr></thead>
        <tbody>${(po.items ?? []).map((it, i) => `<tr><td>${i + 1}</td><td>${it.item?.name || it.itemId}</td><td class="num">${it.qty}${it.item?.uom ? ' ' + it.item.uom : ''}</td><td class="num">${fmtMoney(it.rate)}</td><td class="num">${it.gstRate}%</td><td class="num">${fmtMoney(it.lineTotal)}</td></tr>`).join('')}</tbody>
      </table>
      <table class="totals" style="width:280px;margin-left:auto">
        <tr><td>Subtotal</td><td class="num">${fmtMoney(po.subtotal)}</td></tr>
        <tr><td>CGST</td><td class="num">${fmtMoney(po.cgst)}</td></tr>
        <tr><td>SGST</td><td class="num">${fmtMoney(po.sgst)}</td></tr>
        ${po.igst ? `<tr><td>IGST</td><td class="num">${fmtMoney(po.igst)}</td></tr>` : ''}
        <tr class="grand"><td>Grand Total</td><td class="num">${fmtMoney(po.grandTotal)}</td></tr>
      </table>
      ${po.approvedBy ? `<p class="muted">Approved by: ${po.approvedBy}</p>` : ''}
      ${po.notes ? `<p class="muted">Notes: ${po.notes}</p>` : ''}`
    printHtml(`Purchase Order ${po.number}`, html)
  }

  const totals = computeTotals(lines)

  const columns: Column<PoRow>[] = [
    { key: 'number', header: 'PO #', render: (r) => <span className="font-medium">{r.number}</span> },
    { key: 'orderDate', header: 'Order Date', render: (r) => <DateCell value={r.orderDate} /> },
    { key: 'supplier', header: 'Supplier', render: (r) => r.supplier?.name || '—' },
    { key: 'total', header: 'Grand Total', render: (r) => <Money value={r.grandTotal} className="font-medium" /> },
    { key: 'expected', header: 'Expected', hideOnMobile: true, render: (r) => <DateCell value={r.expectedDate} /> },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
    {
      key: 'actions', header: 'Actions',
      render: (r) => (
        <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
          <Button variant="ghost" size="sm" className="h-7" title="Print PO" onClick={() => printPo(r)}><Printer className="h-3.5 w-3.5" /></Button>
          {r.status === 'DRAFT' && (
            <Button variant="outline" size="sm" className="h-7" onClick={() => void act(r, { action: 'submit' }, `PO ${r.number} submitted for approval`)}>
              <Upload className="h-3.5 w-3.5 mr-0.5" />Submit
            </Button>
          )}
          {r.status === 'PENDING_APPROVAL' && (
            <Button variant="outline" size="sm" className="h-7 text-emerald-700"
              onClick={() => void act(r, { action: 'approve', userName: 'Purchase Manager' }, `PO ${r.number} approved`)}>
              <Check className="h-3.5 w-3.5 mr-0.5" />Approve
            </Button>
          )}
          {!['CANCELLED', 'INVOICED'].includes(r.status) && (
            <ConfirmAction
              trigger={<Button variant="ghost" size="sm" className="h-7 text-red-600"><X className="h-3.5 w-3.5" /></Button>}
              title="Cancel PO?" message={`Cancel ${r.number}? This cannot be undone.`} tone="destructive" onConfirm={() => cancelPo(r)}
            />
          )}
        </div>
      ),
    },
  ]

  return (
    <div>
      <PageHeader
        title="Purchase Orders"
        description="Raise, approve and track supplier orders"
        actions={<Button onClick={() => { resetForm(); setOpen(true) }}><Plus className="h-4 w-4 mr-1.5" />New Purchase Order</Button>}
      />
      <DataTable
        columns={columns} rows={rows} loading={list.loading} searchPlaceholder="Search purchase orders…" onRowClick={(r) => setDetail(r)}
        csvExport={{
          filename: 'purchase-orders',
          pick: (r) => [r.number, new Date(r.orderDate).toISOString().slice(0, 10), r.supplier?.name || '', r.status, r.items?.length ?? 0, r.subtotal, r.discountTotal, r.cgst, r.sgst, r.igst, r.grandTotal],
        }}
      />

      <FormDialog
        open={open} onOpenChange={setOpen} wide title="New Purchase Order" submitLabel="Create PO"
        description="Optionally convert an approved requisition — rates prefill from item purchase price" loading={saving} onSubmit={submit}
      >
        <div className="grid sm:grid-cols-3 gap-4">
          <Field label="Supplier" required><SelectInput value={supplierId} onChange={setSupplierId} options={supplierOpts} /></Field>
          <Field label="From Requisition (optional)">
            <SelectInput value={prId} onChange={(v) => void pickPr(v)} options={[{ value: '', label: '— None —' }, ...prOpts]} />
          </Field>
          <Field label="Order Date" required><DateInput value={orderDate} onChange={setOrderDate} /></Field>
          <Field label="Expected Date"><DateInput value={expectedDate} onChange={setExpectedDate} /></Field>
          <Field label="Notes" className="sm:col-span-2"><TextInput value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Delivery / payment terms…" /></Field>
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
              <div className="col-span-12 sm:col-span-5">
                <SelectInput
                  value={l.itemId} options={itemOpts} placeholder="Select item…"
                  onChange={(v) => setLines((ls) => ls.map((x, i) => {
                    if (i !== idx) return x
                    const it = (items.data?.items ?? []).find((o) => o.id === v)
                    return { ...x, itemId: v, rate: x.rate || Number(it?.purchasePrice || 0), gstRate: it?.gstRate ?? x.gstRate }
                  }))}
                />
              </div>
              <NumberInput className="col-span-4 sm:col-span-2" value={l.qty} min={0} placeholder="Qty"
                onChange={(n) => setLines((ls) => ls.map((x, i) => (i === idx ? { ...x, qty: n } : x)))} />
              <NumberInput className="col-span-4 sm:col-span-2" value={l.rate} min={0} placeholder="Rate"
                onChange={(n) => setLines((ls) => ls.map((x, i) => (i === idx ? { ...x, rate: n } : x)))} />
              <NumberInput className="col-span-3 sm:col-span-2" value={l.gstRate} min={0} placeholder="GST %"
                onChange={(n) => setLines((ls) => ls.map((x, i) => (i === idx ? { ...x, gstRate: n } : x)))} />
              <div className="col-span-1 flex justify-end">
                <Button type="button" variant="ghost" size="sm" disabled={lines.length <= 1}
                  onClick={() => setLines((ls) => ls.filter((_, i) => i !== idx))}>
                  <Trash2 className="h-3.5 w-3.5 text-red-600" />
                </Button>
              </div>
            </div>
          ))}
          <div className="rounded-md border bg-muted/30 p-3 text-sm grid grid-cols-2 sm:grid-cols-4 gap-2">
            <TotCell label="Subtotal" value={totals.subtotal} />
            <TotCell label="CGST (preview)" value={totals.cgst} />
            <TotCell label="SGST (preview)" value={totals.sgst} />
            <TotCell label="Grand Total" value={totals.grand} bold />
          </div>
        </div>
      </FormDialog>

      <Dialog open={!!detail} onOpenChange={(o) => !o && setDetail(null)}>
        <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Purchase Order {detail?.number}</DialogTitle>
            <DialogDescription>{detail?.supplier?.name || '—'} · <StatusBadge status={detail?.status} /></DialogDescription>
          </DialogHeader>
          {detail && (
            <div className="space-y-3 text-sm">
              <div className="grid grid-cols-3 gap-2 text-xs text-muted-foreground">
                <div>Order date: <span className="text-foreground font-medium"><DateCell value={detail.orderDate} /></span></div>
                <div>Expected: <span className="text-foreground font-medium"><DateCell value={detail.expectedDate} /></span></div>
                <div>{detail.approvedBy ? `Approved by ${detail.approvedBy}` : 'Not approved yet'}</div>
              </div>
              <div className="rounded-lg border overflow-x-auto">
                <table className="w-full text-xs">
                  <thead><tr className="bg-muted/50">
                    <th className="text-left p-2">Item</th><th className="text-right p-2">Qty</th><th className="text-right p-2">Rate</th>
                    <th className="text-right p-2">GST %</th><th className="text-right p-2">Received</th><th className="text-right p-2">Line Total</th>
                  </tr></thead>
                  <tbody>
                    {(detail.items ?? []).map((it) => (
                      <tr key={it.id} className="border-t">
                        <td className="p-2">{it.item?.name || it.itemId}</td>
                        <td className="p-2 text-right tabular-nums">{it.qty}</td>
                        <td className="p-2 text-right tabular-nums">{fmtMoney(it.rate)}</td>
                        <td className="p-2 text-right tabular-nums">{it.gstRate}%</td>
                        <td className="p-2 text-right tabular-nums">{it.receivedQty ?? 0}</td>
                        <td className="p-2 text-right tabular-nums font-medium">{fmtMoney(it.lineTotal)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex flex-col items-end gap-0.5">
                <span>Subtotal <Money value={detail.subtotal} /></span>
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
