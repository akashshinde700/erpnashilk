'use client'

import * as React from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { BadgeIndianRupee, Plus, Trash2, X } from 'lucide-react'
import {
  Column, ConfirmAction, DataTable, DateCell, DateInput, Field, FormDialog, Money,
  NumberInput, PageHeader, SelectInput, StatusBadge, TextInput,
} from '@/components/erp/kit'
import { apiGet, apiPatch, apiPost, useList } from '@/lib/use-api'
import { PAYMENT_MODES, fmtMoney } from '@/lib/erp-constants'

interface PartyRow { id: string; name?: string | null; code?: string | null }
interface ItemRow { id: string; code?: string | null; name?: string | null; purchasePrice?: number | null; gstRate?: number | null }
interface PiItem { id: string; itemId: string; qty: number; rate: number; gstRate: number; lineTotal: number; item?: { code?: string | null; name?: string | null } | null }
interface PiRow {
  id: string; number: string; date: string; supplierId?: string | null; status: string
  subtotal: number; grandTotal: number; paidAmount: number; supplierInvNo?: string | null; notes?: string | null
  supplier?: { name?: string | null } | null
}
interface DraftLine { itemId: string; qty: number; rate: number; gstRate: number }

const r2 = (n: number) => Math.round(n * 100) / 100
const today = () => new Date().toISOString().slice(0, 10)
const INVOICEABLE = ['APPROVED', 'RECEIVED', 'PARTIALLY_RECEIVED']

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

export default function PurchaseInvoicesModule({ companyId }: { companyId: string }) {
  const list = useList<{ items: PiRow[] }>(`/api/purchase-invoices?companyId=${companyId}`)
  const suppliers = useList<{ items: PartyRow[] }>(`/api/suppliers?companyId=${companyId}`)
  const items = useList<{ items: ItemRow[] }>(`/api/items?companyId=${companyId}`)
  const pos = useList<{ items: { id: string; number: string; status: string }[] }>(`/api/purchase-orders?companyId=${companyId}`)

  const [open, setOpen] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [supplierId, setSupplierId] = React.useState('')
  const [poId, setPoId] = React.useState('')
  const [date, setDate] = React.useState(today)
  const [supplierInvNo, setSupplierInvNo] = React.useState('')
  const [notes, setNotes] = React.useState('')
  const [lines, setLines] = React.useState<DraftLine[]>([emptyLine()])

  const [payFor, setPayFor] = React.useState<PiRow | null>(null)
  const [payAmount, setPayAmount] = React.useState(0)
  const [payMode, setPayMode] = React.useState('NEFT')
  const [payDate, setPayDate] = React.useState(today)
  const [payRef, setPayRef] = React.useState('')
  const [paying, setPaying] = React.useState(false)

  const rows = list.data?.items ?? []
  const supplierOpts = (suppliers.data?.items ?? []).map((s) => ({ value: s.id, label: s.name || s.id }))
  const itemOpts = (items.data?.items ?? []).map((i) => ({ value: i.id, label: i.code && i.name ? `${i.code} — ${i.name}` : i.name || i.id }))
  const poOpts = (pos.data?.items ?? []).filter((p) => INVOICEABLE.includes(p.status)).map((p) => ({ value: p.id, label: `${p.number} (${p.status.replaceAll('_', ' ')})` }))

  function resetForm() {
    setSupplierId(''); setPoId(''); setDate(today()); setSupplierInvNo(''); setNotes(''); setLines([emptyLine()])
  }

  async function pickPo(pid: string) {
    setPoId(pid)
    if (!pid) return
    try {
      const po = await apiGet<PiRow & { items?: ({ itemId: string; qty: number; rate: number; gstRate: number } | PiItem)[] | null }>(`/api/purchase-orders/${pid}`)
      if (po.supplierId) setSupplierId(po.supplierId)
      const mapped = (po.items ?? []).map((it) => ({ itemId: it.itemId, qty: it.qty, rate: it.rate, gstRate: it.gstRate }))
      setLines(mapped.length ? mapped : [emptyLine()])
      toast.success(`Loaded ${mapped.length} line(s) from ${po.number}`)
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to load purchase order') }
  }

  async function submit() {
    if (!supplierId) { toast.error('Select a supplier'); return }
    const valid = lines.filter((l) => l.itemId && l.qty > 0)
    if (!valid.length) { toast.error('Add at least one line with item and qty'); return }
    setSaving(true)
    try {
      await apiPost('/api/purchase-invoices', {
        companyId, supplierId, poId: poId || undefined, date,
        supplierInvNo: supplierInvNo || undefined, notes: notes || undefined, items: valid,
      })
      toast.success('Purchase invoice created')
      setOpen(false); resetForm(); void list.refetch()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to create invoice') } finally { setSaving(false) }
  }

  async function openPay(row: PiRow) {
    setPayFor(row); setPayAmount(r2((row.grandTotal || 0) - (row.paidAmount || 0)))
    setPayMode('NEFT'); setPayDate(today()); setPayRef('')
  }

  async function submitPayment() {
    if (!payFor) return
    if (payAmount <= 0) { toast.error('Enter a valid amount'); return }
    setPaying(true)
    try {
      await apiPost('/api/payments', {
        companyId, type: 'PAYMENT', partyType: 'SUPPLIER', supplierId: payFor.supplierId,
        invoiceType: 'PURCHASE', invoiceId: payFor.id, amount: payAmount, mode: payMode, date: payDate,
        reference: payRef || undefined, userName: 'Purchase User',
      })
      toast.success(`Payment of ${fmtMoney(payAmount)} recorded`)
      setPayFor(null); void list.refetch()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to record payment') } finally { setPaying(false) }
  }

  async function cancelInvoice(row: PiRow) {
    try {
      await apiPatch(`/api/purchase-invoices/${row.id}`, { action: 'cancel', companyId })
      toast.success(`Invoice ${row.number} cancelled`); void list.refetch()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to cancel') }
  }

  const totals = computeTotals(lines)

  const columns: Column<PiRow>[] = [
    { key: 'number', header: 'Invoice #', render: (r) => <span className="font-medium">{r.number}</span> },
    { key: 'date', header: 'Date', render: (r) => <DateCell value={r.date} /> },
    { key: 'supplier', header: 'Supplier', render: (r) => r.supplier?.name || '—' },
    { key: 'total', header: 'Grand Total', render: (r) => <Money value={r.grandTotal} className="font-medium" /> },
    { key: 'paid', header: 'Paid', hideOnMobile: true, render: (r) => <Money value={r.paidAmount} /> },
    {
      key: 'outstanding', header: 'Outstanding',
      render: (r) => {
        const out = r2((r.grandTotal || 0) - (r.paidAmount || 0))
        return <Money value={out} className={out > 0 ? 'text-amber-600 font-medium' : 'text-emerald-600'} />
      },
    },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
    {
      key: 'actions', header: 'Actions',
      render: (r) => (
        <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
          {r.status !== 'PAID' && r.status !== 'CANCELLED' && (
            <>
              <Button variant="outline" size="sm" className="h-7" onClick={() => void openPay(r)} title="Record payment">
                <BadgeIndianRupee className="h-3.5 w-3.5 mr-0.5" />Pay
              </Button>
              {(r.paidAmount || 0) <= 0 && (
                <ConfirmAction
                  trigger={<Button variant="ghost" size="sm" className="h-7 text-red-600"><X className="h-3.5 w-3.5" /></Button>}
                  title="Cancel invoice?" message={`Cancel purchase invoice ${r.number}?`} tone="destructive"
                  onConfirm={() => cancelInvoice(r)}
                />
              )}
            </>
          )}
        </div>
      ),
    },
  ]

  return (
    <div>
      <PageHeader
        title="Purchase Invoices"
        description="Supplier bills against purchase orders and payments made"
        actions={<Button onClick={() => { resetForm(); setOpen(true) }}><Plus className="h-4 w-4 mr-1.5" />New Invoice</Button>}
      />
      <DataTable columns={columns} rows={rows} loading={list.loading} searchPlaceholder="Search purchase invoices…" />

      <FormDialog
        open={open} onOpenChange={setOpen} wide title="New Purchase Invoice" submitLabel="Create Invoice"
        description="From a purchase order (lines pre-filled) or manual lines" loading={saving} onSubmit={submit}
      >
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <Field label="Supplier" required><SelectInput value={supplierId} onChange={setSupplierId} options={supplierOpts} /></Field>
          <Field label="From Purchase Order (optional)">
            <SelectInput value={poId} onChange={(v) => void pickPo(v)} options={[{ value: '', label: '— None —' }, ...poOpts]} />
          </Field>
          <Field label="Date" required><DateInput value={date} onChange={setDate} /></Field>
          <Field label="Supplier Inv No"><TextInput value={supplierInvNo} onChange={(e) => setSupplierInvNo(e.target.value)} placeholder="Their invoice no." /></Field>
          <Field label="Notes" className="sm:col-span-2 lg:col-span-4"><TextInput value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Remarks…" /></Field>
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
