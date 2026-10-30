'use client'

import * as React from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Checkbox } from '@/components/ui/checkbox'
import { BadgeIndianRupee, Pencil, Plus, Redo2, Trash2, X } from 'lucide-react'
import {
  Column, ConfirmAction, DataTable, DateCell, DateInput, Field, FormDialog, Money,
  NumberInput, PageHeader, SelectInput, StatusBadge, TextInput, openCreate, useCreatePreset
} from '@/components/erp/kit'
import { apiGet, apiPatch, apiPost, useList } from '@/lib/use-api'
import { ItemPicker, QuickItemDialog, type PickerItem } from '@/components/erp/item-picker'
import { PAYMENT_MODES, accountsForMode, fmtDate, fmtMoney } from '@/lib/erp-constants'
import { baseQtyHint, convertRate, lineToBase, toBaseQty, unitOptions } from '@/lib/units'

interface PartyRow { id: string; name?: string | null; code?: string | null; paymentTermsDays?: number | null; state?: string | null; stateCode?: string | null }
interface CompanySettings { roundOffTotals?: boolean | null; state?: string | null; stateCode?: string | null }
interface ItemRow { id: string; code?: string | null; name?: string | null; uom?: string | null; purchasePrice?: number | null; gstRate?: number | null; batchTracked?: boolean | null; trackSerial?: boolean | null; type?: string | null
  altUom?: string | null; altFactor?: number | null }
interface PiItem { id: string; itemId: string; qty: number; rate: number; gstRate: number; lineTotal: number; item?: { code?: string | null; name?: string | null } | null }
interface PiRow {
  id: string; number: string; date: string; supplierId?: string | null; status: string
  subtotal: number; grandTotal: number; paidAmount: number; supplierInvNo?: string | null; notes?: string | null
  supplierInvDate?: string | null; dueDate?: string | null; grnId?: string | null; poId?: string | null
  supplier?: { name?: string | null } | null
  reverseCharge?: boolean | null
}
interface DraftLine {
  itemId: string; qty: number; rate: number; gstRate: number
  // the item's secondary unit when chosen (qty/rate are then per that unit; converted to base on save)
  unit?: string
  // direct receive only (batch-tracked / serial-tracked items)
  batchNo?: string; mfgDate?: string; expiryDate?: string; serials?: string
}
// newline / comma separated → unique non-empty serials (mirrors parseSerials on the server)
const serialList = (t: string | undefined) => Array.from(new Set(String(t || '').split(/[\r\n,;]+/).map((x) => x.trim()).filter(Boolean)))

const r2 = (n: number) => Math.round(n * 100) / 100
const today = () => new Date().toISOString().slice(0, 10)
// yyyy-mm-dd + n days (UTC arithmetic so the date never shifts with the timezone)
function addDays(ymd: string, n: number) {
  const d = new Date(`${ymd}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return ''
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
const INVOICEABLE = ['APPROVED', 'RECEIVED', 'PARTIALLY_RECEIVED']

interface BillAdj { billDiscount: number; freight: number; freightGst: number; packing: number; packingGst: number; roundOff: boolean }

/** Live preview — mirrors computeBillTotals() in src/lib/erp-helpers.ts (the server recomputes on save). */
function computeTotals(lines: DraftLine[], interState: boolean, adj: BillAdj) {
  const pre = lines.map((l) => (l.qty || 0) * (l.rate || 0))
  const baseSum = pre.reduce((s, b) => s + b, 0)
  const billDiscount = Math.min(Math.max(0, adj.billDiscount || 0), baseSum)
  let taxable = 0, gst = 0
  lines.forEach((l, i) => {
    const t = baseSum > 0 ? pre[i] - billDiscount * (pre[i] / baseSum) : pre[i]
    taxable += t
    gst += t * ((l.gstRate || 0) / 100)
  })
  const freight = r2(Math.max(0, adj.freight || 0))
  const packing = r2(Math.max(0, adj.packing || 0))
  gst += freight * ((adj.freightGst ?? 18) / 100) + packing * ((adj.packingGst ?? 18) / 100)
  const cgst = interState ? 0 : r2(gst / 2)
  const sgst = interState ? 0 : r2(gst / 2)
  const igst = interState ? r2(gst) : 0
  const exact = r2(taxable + freight + packing + cgst + sgst + igst)
  const grand = adj.roundOff ? Math.round(exact) : exact
  return {
    subtotal: r2(baseSum), billDiscount: r2(billDiscount), taxable: r2(taxable), freight, packing,
    cgst, sgst, igst, roundOff: r2(grand - exact), grand: r2(grand),
  }
}
// Same rule as isInterStateParty(): GST state codes when both have one, else state names
function interStateOf(c?: CompanySettings | null, p?: PartyRow | null) {
  const diff = (a?: string | null, b?: string | null) => !!a && !!b && a.trim().toLowerCase() !== b.trim().toLowerCase()
  if (!c || !p) return false
  if (c.stateCode && p.stateCode) return diff(c.stateCode, p.stateCode)
  return diff(c.state, p.state)
}
function emptyLine(): DraftLine { return { itemId: '', qty: 1, rate: 0, gstRate: 18 } }

export default function PurchaseInvoicesModule({ companyId }: { companyId: string }) {
  const list = useList<{ items: PiRow[] }>(`/api/purchase-invoices?companyId=${companyId}`)
  const suppliers = useList<{ items: PartyRow[] }>(`/api/suppliers?companyId=${companyId}`)
  const items = useList<{ items: ItemRow[] }>(`/api/items?companyId=${companyId}`)
  const pos = useList<{ items: { id: string; number: string; status: string }[] }>(`/api/purchase-orders?companyId=${companyId}`)
  const warehouses = useList<{ items: { id: string; code: string; name: string; type: string }[] }>(`/api/warehouses?companyId=${companyId}`)
  const settings = useList<CompanySettings>(`/api/settings?companyId=${companyId}`)
  const accounts = useList<{ items: { id: string; name: string; type: string; active: boolean; isDefault?: boolean; createdAt?: string }[] }>(`/api/accounts?companyId=${companyId}`)
  // Direct bill (no PO / GRN): receive the goods into stock with the bill
  const [receiveStock, setReceiveStock] = React.useState(true)
  const [stockWh, setStockWh] = React.useState('')
  const [newItemFor, setNewItemFor] = React.useState<{ idx: number; name: string } | null>(null)

  const [open, setOpen] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  // Editing an existing direct bill (PATCH action=edit) instead of creating one
  const [editing, setEditing] = React.useState<{ id: string; number: string } | null>(null)
  const [supplierId, setSupplierId] = React.useState('')
  const [poId, setPoId] = React.useState('')
  const [date, setDate] = React.useState(today)
  const [supplierInvNo, setSupplierInvNo] = React.useState('')
  const [supplierInvDate, setSupplierInvDate] = React.useState('')
  const [dueDate, setDueDate] = React.useState('')
  const [dueTouched, setDueTouched] = React.useState(false) // user edited the due date — stop auto-filling
  const [grnId, setGrnId] = React.useState('')
  const [notes, setNotes] = React.useState('')
  const [reverseCharge, setReverseCharge] = React.useState(false)
  const [lines, setLines] = React.useState<DraftLine[]>([emptyLine()])
  // Bill-level discount & charges
  const [billDiscount, setBillDiscount] = React.useState(0)
  const [freightCharge, setFreightCharge] = React.useState(0)
  const [freightGstRate, setFreightGstRate] = React.useState(18)
  const [packingCharge, setPackingCharge] = React.useState(0)
  const [packingGstRate, setPackingGstRate] = React.useState(18)
  // Paid to the supplier along with the bill
  const [paidNow, setPaidNow] = React.useState(0)
  const [paidMode, setPaidMode] = React.useState('CASH')
  const [paidChequeNo, setPaidChequeNo] = React.useState('')
  const [paidChequeDate, setPaidChequeDate] = React.useState('')
  // "From account": accounts of the mode's type only (cash ↔ bank, no fallback to cash — CB-R5)
  const paidFor = accountsForMode(accounts.data?.items ?? [], paidMode)
  const [paidAccountId, setPaidAccountId] = React.useState('') // '' = default account for the mode

  const [payFor, setPayFor] = React.useState<PiRow | null>(null)
  const [payAmount, setPayAmount] = React.useState(0)
  const [payMode, setPayMode] = React.useState('NEFT')
  const [payDate, setPayDate] = React.useState(today)
  const [payRef, setPayRef] = React.useState('')
  const [paying, setPaying] = React.useState(false)

  const rows = list.data?.items ?? []
  const supplierOpts = (suppliers.data?.items ?? []).map((s) => ({ value: s.id, label: s.name || s.id }))
  const direct = !poId && !grnId // bill without PO / GRN
  const flagsOf = (itemId: string) => {
    const it = (items.data?.items ?? []).find((o) => o.id === itemId)
    const svc = it?.type === 'SERVICE'
    return { batch: !!it?.batchTracked && !svc, serial: !!it?.trackSerial && !svc }
  }
  const itemRow = (itemId: string) => (items.data?.items ?? []).find((o) => o.id === itemId)
  const itemLabel = (itemId: string) => {
    const it = (items.data?.items ?? []).find((o) => o.id === itemId)
    return it ? `${it.code ? `${it.code} — ` : ''}${it.name || ''}` : 'Item'
  }
  const poOpts = (pos.data?.items ?? []).filter((p) => INVOICEABLE.includes(p.status)).map((p) => ({ value: p.id, label: `${p.number} (${p.status.replaceAll('_', ' ')})` }))

  function resetForm() {
    setSupplierId(''); setPoId(''); setDate(today()); setSupplierInvNo(''); setNotes(''); setReverseCharge(false); setLines([emptyLine()])
    setReceiveStock(true); setStockWh('')
    setSupplierInvDate(''); setDueDate(''); setDueTouched(false); setGrnId('')
    setBillDiscount(0); setFreightCharge(0); setFreightGstRate(18); setPackingCharge(0); setPackingGstRate(18)
    setPaidNow(0); setPaidMode('CASH'); setPaidAccountId(''); setPaidChequeNo(''); setPaidChequeDate('')
    setEditing(null)
  }

  /** Open the bill form pre-filled from a saved direct bill (no payments / returns, not from a PO or GRN). */
  async function openEdit(row: PiRow) {
    try {
      const b = await apiGet<PiRow & {
        billDiscount?: number | null; freightCharge?: number | null; freightGstRate?: number | null
        packingCharge?: number | null; packingGstRate?: number | null
        receivedStock?: boolean; receivedWarehouseId?: string | null
        items?: (PiItem & { batchNo?: string | null; mfgDate?: string | null; expiryDate?: string | null; serials?: string | null })[] | null
      }>(`/api/purchase-invoices/${row.id}?companyId=${companyId}`)
      resetForm()
      setEditing({ id: b.id, number: b.number })
      setSupplierId(b.supplierId || '')
      setDate(String(b.date || '').slice(0, 10) || today())
      setSupplierInvNo(b.supplierInvNo || '')
      setSupplierInvDate(b.supplierInvDate ? String(b.supplierInvDate).slice(0, 10) : '')
      if (b.dueDate) { setDueDate(String(b.dueDate).slice(0, 10)); setDueTouched(true) }
      setNotes(b.notes || '')
      setReverseCharge(!!b.reverseCharge)
      setBillDiscount(b.billDiscount || 0)
      setFreightCharge(b.freightCharge || 0); setFreightGstRate(b.freightGstRate ?? 18)
      setPackingCharge(b.packingCharge || 0); setPackingGstRate(b.packingGstRate ?? 18)
      setReceiveStock(!!b.receivedStock); setStockWh(b.receivedWarehouseId || '')
      const ls = (b.items ?? []).map((it) => ({
        itemId: it.itemId, qty: it.qty, rate: it.rate, gstRate: it.gstRate,
        batchNo: it.batchNo || undefined,
        mfgDate: it.mfgDate ? String(it.mfgDate).slice(0, 10) : undefined,
        expiryDate: it.expiryDate ? String(it.expiryDate).slice(0, 10) : undefined,
        serials: it.serials || undefined,
      }))
      setLines(ls.length ? ls : [emptyLine()])
      setOpen(true)
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to load the bill') }
  }

  // Default due date = invoice date + the supplier's credit days (until the user edits it)
  const supplierTerms = (suppliers.data?.items ?? []).find((s) => s.id === supplierId)?.paymentTermsDays
  const effectiveDue = dueTouched ? dueDate : supplierId && date ? addDays(date, Number(supplierTerms) || 0) : ''

  // Shortcuts from other screens (party view, row actions, quick actions) open this form pre-filled
  useCreatePreset('purchase-invoices', (d) => {
    resetForm()
    if (d.grnId) setGrnId(String(d.grnId))
    if (d.poId) void pickPo(String(d.poId), d.grnId ? String(d.grnId) : '')
    setOpen(true)
  })

  async function pickPo(pid: string, forGrnId = '') {
    setPoId(pid)
    if (!forGrnId) setGrnId('') // a manually picked PO drops any GRN link from a shortcut
    if (!pid) return
    try {
      const po = await apiGet<PiRow & { items?: ({ id?: string; itemId: string; qty: number; rate: number; gstRate: number } | PiItem)[] | null }>(`/api/purchase-orders/${pid}?companyId=${companyId}`)
      if (po.supplierId) setSupplierId(po.supplierId)
      let mapped = (po.items ?? []).map((it) => ({ itemId: it.itemId, qty: it.qty, rate: it.rate, gstRate: it.gstRate }))
      let source = po.number
      if (forGrnId) {
        // Bill exactly what this GRN accepted, at the PO rates
        const grn = await apiGet<{ number: string; supplierInvNo?: string | null; supplierInvDate?: string | null; items?: { poItemId?: string | null; itemId: string; acceptedQty: number }[] | null }>(`/api/grns/${forGrnId}?companyId=${companyId}`)
        const poLines = po.items ?? []
        mapped = (grn.items ?? []).filter((g) => g.acceptedQty > 0).map((g) => {
          const pl = poLines.find((x) => !!g.poItemId && x.id === g.poItemId) || poLines.find((x) => x.itemId === g.itemId)
          return { itemId: g.itemId, qty: g.acceptedQty, rate: pl?.rate ?? 0, gstRate: pl?.gstRate ?? 18 }
        })
        if (grn.supplierInvNo) setSupplierInvNo(grn.supplierInvNo)
        if (grn.supplierInvDate) setSupplierInvDate(String(grn.supplierInvDate).slice(0, 10))
        source = `${po.number} / ${grn.number}`
      }
      setLines(mapped.length ? mapped : [emptyLine()])
      toast.success(`Loaded ${mapped.length} line(s) from ${source}`)
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to load purchase order') }
  }

  /**
   * The rate this supplier last billed / was ordered at for the item: replaces the item-master
   * rate on that line (only while the line still shows the rate we pre-filled — never a typed one).
   */
  async function applyLastRate(itemId: string, prefilled: number) {
    if (!supplierId || !itemId) return
    try {
      const r = await apiGet<{ rates: Record<string, { rate: number; date: string; ref: string }> }>(
        `/api/parties/last-rates?companyId=${companyId}&kind=supplier&partyId=${supplierId}&itemIds=${encodeURIComponent(itemId)}`,
      )
      const last = r.rates?.[itemId]
      if (!last || !(last.rate > 0)) return
      setLines((ls) => ls.map((x) => (x.itemId === itemId && x.rate === prefilled ? { ...x, rate: convertRate(last.rate, undefined, x.unit, itemRow(itemId)) } : x)))
    } catch { /* keep the item-master rate */ }
  }

  /** Set a line's item; picking an item already on another line adds this qty to that line instead. */
  function pickItem(idx: number, it: { id: string; purchasePrice?: number | null; gstRate?: number | null }) {
    if (!lines.some((x, i) => i !== idx && x.itemId === it.id)) {
      void applyLastRate(it.id, lines[idx]?.rate || Number(it.purchasePrice || 0))
    }
    setLines((ls) => {
      const dup = ls.findIndex((x, i) => i !== idx && x.itemId === it.id)
      if (dup >= 0) {
        toast.info('Item already on this bill — quantity added to that line')
        return ls.map((x, i) => (i === dup ? { ...x, qty: r2(x.qty + (ls[idx].qty || 1)) } : x)).filter((_, i) => i !== idx || ls.length === 1)
      }
      return ls.map((x, i) => (i === idx ? { ...x, itemId: it.id, rate: x.rate || Number(it.purchasePrice || 0), gstRate: it.gstRate ?? x.gstRate, unit: it.id === x.itemId ? x.unit : undefined } : x))
    })
  }

  async function submit() {
    if (!supplierId) { toast.error('Select a supplier'); return }
    // qty / rate go to the API in the item's base unit
    const valid = lines.filter((l) => l.itemId && l.qty > 0).map((l) => lineToBase(l, itemRow(l.itemId)))
    if (!valid.length) { toast.error('Add at least one line with item and qty'); return }
    if (paidNow > totals.grand + 0.01) { toast.error(`Paid now cannot exceed the bill total (${fmtMoney(totals.grand)})`); return }
    const receiving = direct && receiveStock
    if (receiving) {
      const bad = valid.find((l) => flagsOf(l.itemId).serial && serialList(l.serials).length !== l.qty)
      if (bad) { toast.error(`${itemLabel(bad.itemId)}: enter exactly ${bad.qty} serial no(s)`); return }
    }
    const payloadLines = valid.map((l) => {
      const f = flagsOf(l.itemId)
      return {
        itemId: l.itemId, qty: l.qty, rate: l.rate, gstRate: l.gstRate,
        ...(receiving && f.batch ? { batchNo: l.batchNo?.trim() || undefined, mfgDate: l.mfgDate || undefined, expiryDate: l.expiryDate || undefined } : {}),
        ...(receiving && f.serial ? { serials: l.serials || '' } : {}),
      }
    })
    setSaving(true)
    if (editing) {
      try {
        await apiPatch(`/api/purchase-invoices/${editing.id}`, {
          action: 'edit', companyId, supplierId, date,
          supplierInvNo: supplierInvNo || '', supplierInvDate: supplierInvDate || '',
          dueDate: effectiveDue || '', notes: notes || '', items: payloadLines,
          reverseCharge,
          billDiscount, freightCharge, freightGstRate, packingCharge, packingGstRate,
          receiveStock: receiving, ...(receiving ? { warehouseId: stockWh || undefined } : {}),
        })
        toast.success(`Purchase invoice ${editing.number} updated${receiving ? ' — stock re-posted' : ''}`)
        setOpen(false); resetForm(); void list.refetch()
      } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to update invoice') } finally { setSaving(false) }
      return
    }
    try {
      await apiPost('/api/purchase-invoices', {
        companyId, supplierId, poId: poId || undefined, grnId: grnId || undefined, date,
        supplierInvNo: supplierInvNo || undefined, supplierInvDate: supplierInvDate || undefined,
        dueDate: effectiveDue || undefined, notes: notes || undefined, items: payloadLines,
        reverseCharge,
        billDiscount, freightCharge, freightGstRate, packingCharge, packingGstRate,
        ...(paidNow > 0 ? {
          paidNow, paymentMode: paidMode, accountId: paidAccountId || undefined,
          ...(paidMode === 'CHEQUE' ? { chequeNo: paidChequeNo.trim() || undefined, chequeDate: paidChequeDate || undefined } : {}),
        } : {}),
        ...(direct && receiveStock ? { receiveStock: true, warehouseId: stockWh || undefined } : {}),
      })
      toast.success(`${direct && receiveStock ? 'Purchase invoice created — items added to stock' : 'Purchase invoice created'}${paidNow > 0 ? ` (paid ${fmtMoney(paidNow)})` : ''}`)
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

  const supplierRow = (suppliers.data?.items ?? []).find((s) => s.id === supplierId) ?? null
  const interState = interStateOf(settings.data, supplierRow)
  const totals = computeTotals(lines.map((l) => lineToBase(l, itemRow(l.itemId))), interState, {
    billDiscount, freight: freightCharge, freightGst: freightGstRate, packing: packingCharge, packingGst: packingGstRate,
    roundOff: settings.data?.roundOffTotals ?? true,
  })

  const columns: Column<PiRow>[] = [
    { key: 'number', header: 'Invoice #', render: (r) => <span className="font-medium">{r.number}</span> },
    { key: 'date', header: 'Date', render: (r) => <DateCell value={r.date} /> },
    {
      key: 'due', header: 'Due', hideOnMobile: true, sortValue: (r) => r.dueDate || '',
      render: (r) => {
        const overdue = !!r.dueDate && !['PAID', 'CANCELLED'].includes(r.status) && r.dueDate.slice(0, 10) < today()
        return overdue
          ? <span className="whitespace-nowrap text-red-600 font-medium" title="Overdue">{fmtDate(r.dueDate)}</span>
          : <DateCell value={r.dueDate} />
      },
    },
    { key: 'supplier', header: 'Supplier', sortValue: (r) => r.supplier?.name || '', render: (r) => r.supplier?.name || '—' },
    { key: 'total', header: 'Grand Total', sortValue: (r) => r.grandTotal || 0, sum: true, sumFormat: 'money', render: (r) => <Money value={r.grandTotal} className="font-medium" /> },
    { key: 'paid', header: 'Paid', hideOnMobile: true, sortValue: (r) => r.paidAmount || 0, sum: true, sumFormat: 'money', render: (r) => <Money value={r.paidAmount} /> },
    {
      key: 'outstanding', header: 'Outstanding', sortValue: (r) => r2((r.grandTotal || 0) - (r.paidAmount || 0)), sum: true, sumFormat: 'money',
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
          {r.status !== 'CANCELLED' && (
            <Button variant="ghost" size="sm" className="h-7" title="Purchase return / debit note"
              onClick={() => openCreate('purchase-returns', { invoiceId: r.id })}>
              <Redo2 className="h-3.5 w-3.5 mr-0.5" />Return
            </Button>
          )}
          {r.status !== 'CANCELLED' && (r.paidAmount || 0) <= 0 && !r.poId && !r.grnId && (
            <Button variant="ghost" size="sm" className="h-7" title="Edit bill" onClick={() => void openEdit(r)}>
              <Pencil className="h-3.5 w-3.5 mr-0.5" />Edit
            </Button>
          )}
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
        actions={<Button onClick={() => { resetForm(); setOpen(true) }}><Plus className="h-4 w-4 mr-1.5" />Invoice</Button>}
      />
      <DataTable columns={columns} rows={rows} loading={list.loading} searchPlaceholder="Search purchase invoices…" moduleKey="purchase-invoices" savedViewsKey={`${companyId}:purchase-invoices`} sortable />

      <FormDialog
        open={open} onOpenChange={(o) => { setOpen(o); if (!o) setEditing(null) }} wide
        title={editing ? `Edit Purchase Invoice ${editing.number}` : 'Purchase Invoice'} submitLabel={editing ? 'Save Changes' : 'Create Invoice'}
        description={editing ? 'Lines, totals and received stock are re-posted on save; the bill number stays the same' : 'From a purchase order (lines pre-filled) or manual lines'}
        loading={saving} onSubmit={submit}
      >
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <Field label="Supplier" required><SelectInput value={supplierId} onChange={setSupplierId} options={supplierOpts} /></Field>
          {!editing && (
            <Field label="From Purchase Order (optional)">
              <SelectInput value={poId} onChange={(v) => void pickPo(v)} options={[{ value: '', label: '— None —' }, ...poOpts]} />
            </Field>
          )}
          <Field label="Date" required><DateInput value={date} onChange={setDate} /></Field>
          <Field label="Supplier Inv No"><TextInput value={supplierInvNo} onChange={(e) => setSupplierInvNo(e.target.value)} placeholder="Their invoice no." /></Field>
          <Field label="Supplier Inv Date"><DateInput value={supplierInvDate} onChange={setSupplierInvDate} /></Field>
          <Field label={supplierTerms ? `Due Date (Net ${supplierTerms} days)` : 'Due Date'}>
            <DateInput value={effectiveDue} onChange={(v) => { setDueDate(v); setDueTouched(true) }} />
          </Field>
          <Field label="Notes" className="sm:col-span-2"><TextInput value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Remarks…" /></Field>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Lines</span>
            <Button type="button" variant="outline" size="sm" onClick={() => setLines((ls) => [...ls, emptyLine()])}>
              <Plus className="h-3.5 w-3.5 mr-1" />Add Line
            </Button>
          </div>
          <div className="hidden sm:grid grid-cols-12 gap-2 px-0.5 text-[11px] font-medium text-muted-foreground">
            <span className="col-span-5">Item</span><span className="col-span-2">Qty</span><span className="col-span-2">Rate (₹)</span><span className="col-span-2">GST %</span>
          </div>
          {lines.map((l, idx) => (
            <div key={idx} className="grid grid-cols-12 gap-2 items-center">
              <div className="col-span-12 sm:col-span-5">
                <ItemPicker
                  items={(items.data?.items ?? []) as PickerItem[]}
                  value={l.itemId}
                  onChange={(id) => { const it = (items.data?.items ?? []).find((o) => o.id === id); if (it) pickItem(idx, it) }}
                  onCreate={(typed) => setNewItemFor({ idx, name: typed })}
                />
              </div>
              <div className="col-span-4 sm:col-span-2 grid gap-0.5">
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
              {direct && receiveStock && flagsOf(l.itemId).batch && (
                <div className="col-span-12 grid grid-cols-1 sm:grid-cols-3 gap-2">
                  <div>
                    <span className="text-[10px] text-muted-foreground uppercase">Batch no</span>
                    <TextInput value={l.batchNo ?? ''} onChange={(e) => setLines((ls) => ls.map((x, i) => (i === idx ? { ...x, batchNo: e.target.value } : x)))} placeholder="Blank = bill number" />
                  </div>
                  <div>
                    <span className="text-[10px] text-muted-foreground uppercase">Mfg date</span>
                    <DateInput value={l.mfgDate ?? ''} onChange={(v) => setLines((ls) => ls.map((x, i) => (i === idx ? { ...x, mfgDate: v } : x)))} />
                  </div>
                  <div>
                    <span className="text-[10px] text-muted-foreground uppercase">Expiry date</span>
                    <DateInput value={l.expiryDate ?? ''} onChange={(v) => setLines((ls) => ls.map((x, i) => (i === idx ? { ...x, expiryDate: v } : x)))} />
                  </div>
                </div>
              )}
              {direct && receiveStock && flagsOf(l.itemId).serial && (
                <div className="col-span-12">
                  <span className="text-[10px] text-muted-foreground uppercase">
                    Serial / IMEI nos — one per line ({serialList(l.serials).length} of {toBaseQty(l.qty, l.unit, itemRow(l.itemId))} entered)
                  </span>
                  <Textarea rows={3} value={l.serials ?? ''} onChange={(e) => setLines((ls) => ls.map((x, i) => (i === idx ? { ...x, serials: e.target.value } : x)))}
                    placeholder="One serial number per line (scan or paste)"
                    className={serialList(l.serials).length !== toBaseQty(l.qty, l.unit, itemRow(l.itemId)) ? 'border-amber-500' : ''} />
                </div>
              )}
            </div>
          ))}
          {direct && (
            <div className="flex flex-wrap items-center gap-3 rounded-md border p-3 text-sm">
              <label className="flex items-center gap-2">
                <input type="checkbox" className="h-4 w-4 accent-emerald-600" checked={receiveStock} onChange={(e) => setReceiveStock(e.target.checked)} />
                Add these items to stock (no GRN)
              </label>
              {receiveStock && (
                <div className="min-w-48">
                  <SelectInput value={stockWh} onChange={setStockWh}
                    options={[{ value: '', label: 'Raw material store (default)' }, ...(warehouses.data?.items ?? []).map((w) => ({ value: w.id, label: `${w.code} — ${w.name}` }))]} />
                </div>
              )}
              <span className="text-[11px] text-muted-foreground">Bills from a PO / GRN never add stock — the GRN already did.</span>
            </div>
          )}
          <div className="space-y-2 rounded-md border p-3">
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Discount &amp; charges</span>
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
              <Field label="Bill discount (₹)"><NumberInput value={billDiscount} min={0} onChange={setBillDiscount} /></Field>
              <Field label="Freight (₹)"><NumberInput value={freightCharge} min={0} onChange={setFreightCharge} /></Field>
              <Field label="Freight GST %"><NumberInput value={freightGstRate} min={0} onChange={setFreightGstRate} /></Field>
              <Field label="Packing (₹)"><NumberInput value={packingCharge} min={0} onChange={setPackingCharge} /></Field>
              <Field label="Packing GST %"><NumberInput value={packingGstRate} min={0} onChange={setPackingGstRate} /></Field>
            </div>
            <label className="flex w-fit cursor-pointer items-center gap-2 text-xs text-muted-foreground">
              <Checkbox checked={reverseCharge} aria-label="Reverse charge" onCheckedChange={(v) => setReverseCharge(v === true)} />
              Reverse charge (Sec 9(3)/9(4)) — you pay the GST and claim it as ITC
            </label>
            {!editing && <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
              <Field label="Paid now (₹)"><NumberInput value={paidNow} min={0} onChange={setPaidNow} /></Field>
              <Field label="Mode">
                <SelectInput value={paidMode} onChange={(m) => { setPaidMode(m); setPaidAccountId('') }} options={PAYMENT_MODES.map((m) => ({ value: m, label: m }))} />
              </Field>
              <Field label="From account">
                <SelectInput
                  value={paidAccountId} onChange={setPaidAccountId}
                  options={[
                    { value: '', label: paidFor.fallback ? `Default — ${paidFor.fallback.name}` : 'Default for mode' },
                    ...paidFor.matching.map((a) => ({ value: a.id, label: a.name })),
                  ]}
                />
                {paidNow > 0 && !paidAccountId && !paidFor.fallback && (
                  <p className="mt-1 text-[11px] text-red-600">No {paidFor.type === 'BANK' ? 'bank' : 'cash'} account — add one in Cash & Bank to pay by {paidMode}.</p>
                )}
              </Field>
              {paidMode === 'CHEQUE' && (
                <>
                  <Field label="Cheque no."><TextInput value={paidChequeNo} onChange={(e) => setPaidChequeNo(e.target.value)} /></Field>
                  <Field label="Cheque date"><DateInput value={paidChequeDate} onChange={setPaidChequeDate} /></Field>
                </>
              )}
              <div className="col-span-2 sm:col-span-2 self-end pb-2 text-[11px] text-muted-foreground">
                {paidMode === 'CHEQUE' && paidChequeDate > today() ? 'Post-dated cheque — leaves the account once it is cleared. ' : ''}
                {paidNow > 0
                  ? `Records a payment of ${fmtMoney(paidNow)} — balance due ${fmtMoney(Math.max(0, r2(totals.grand - paidNow)))}`
                  : 'Leave 0 for a credit bill (pay later from the list).'}
              </div>
            </div>}
          </div>
          <div className="rounded-md border bg-muted/30 p-3 text-sm grid grid-cols-2 sm:grid-cols-4 gap-2">
            <TotCell label="Subtotal" value={totals.subtotal} />
            {totals.billDiscount > 0 && <TotCell label="Bill discount" value={-totals.billDiscount} />}
            <TotCell label="Taxable" value={totals.taxable} />
            {totals.freight > 0 && <TotCell label="Freight" value={totals.freight} />}
            {totals.packing > 0 && <TotCell label="Packing" value={totals.packing} />}
            {interState
              ? <TotCell label="IGST (preview)" value={totals.igst} />
              : (<><TotCell label="CGST (preview)" value={totals.cgst} /><TotCell label="SGST (preview)" value={totals.sgst} /></>)}
            {totals.roundOff !== 0 && <TotCell label="Round off" value={totals.roundOff} />}
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

      <QuickItemDialog
        open={!!newItemFor}
        onOpenChange={(o) => { if (!o) setNewItemFor(null) }}
        initialName={newItemFor?.name ?? ''}
        items={(items.data?.items ?? []) as PickerItem[]}
        onCreated={(it) => { if (newItemFor) pickItem(newItemFor.idx, it); void items.refetch() }}
        onUseExisting={(it) => { if (newItemFor) pickItem(newItemFor.idx, it) }}
      />
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
