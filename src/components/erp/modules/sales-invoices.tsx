'use client'

import * as React from 'react'
import QRCode from 'qrcode'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Checkbox } from '@/components/ui/checkbox'
import { BadgeIndianRupee, Copy, Link2Off, Mail, MessageCircle, Pencil, Plus, Printer, ReceiptText, Share2, Trash2, Undo2, X } from 'lucide-react'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import {
  Column, ConfirmAction, DataTable, DateCell, DateInput, Field, FormDialog, Money,
  NumberInput, PageHeader, SelectInput, StatusBadge, TextInput, openCreate, printHtml, useRowHighlight, useCreatePreset
} from '@/components/erp/kit'
import { apiDelete, apiGet, apiPatch, apiPost, useList } from '@/lib/use-api'
import { ItemPicker, ScanToAdd, pickIntoLines, scanIntoLines, type PickerItem } from '@/components/erp/item-picker'
import { PAYMENT_MODES, accountsForMode, fmtDate, fmtMoney } from '@/lib/erp-constants'
import { amountInWords } from '@/lib/number-to-words'
import { CURRENCIES, defaultFxRate, fxDeclaration } from '@/lib/currencies'
import { baseQtyHint, convertRate, defaultSellRate, inclGstHint, lineToBase, toBaseQty, unitOptions } from '@/lib/units'

interface PartyRow { id: string; name?: string | null; code?: string | null; state?: string | null; stateCode?: string | null; shippingAddress?: string | null }
interface ItemRow { id: string; code?: string | null; name?: string | null; sellingPrice?: number | null; gstRate?: number | null; hsn?: string | null; barcode?: string | null; uom?: string | null; cessRate?: number | null; batchTracked?: boolean; trackSerial?: boolean
  altUom?: string | null; altFactor?: number | null; mrp?: number | null; priceIncludesTax?: boolean | null }
interface InvItem { id: string; itemId: string; hsn?: string | null; qty: number; rate: number; discountPct?: number; gstRate: number; cessRate?: number | null; lineTotal: number; invoicedQty?: number; item?: { code?: string | null; name?: string | null; uom?: string | null } | null; batchNo?: string | null; serials?: string | null }
interface InvoiceRow {
  id: string; number: string; date: string; dueDate?: string | null; placeOfSupply?: string | null
  customerId?: string | null; status: string; subtotal: number; discountTotal: number; cgst: number; sgst: number; igst: number
  grandTotal: number; paidAmount: number; irn?: string | null; ewayBillNo?: string | null; notes?: string | null
  salesOrderId?: string | null; salesOrder?: { number?: string | null } | null
  challanId?: string | null; customerPoNo?: string | null; customerPoDate?: string | null
  shippingAddress?: string | null; vehicleNo?: string | null; transporter?: string | null
  billDiscount?: number | null; freightCharge?: number | null; freightGstRate?: number | null
  packingCharge?: number | null; packingGstRate?: number | null; roundOff?: number | null; isCashSale?: boolean | null
  billingName?: string | null; driverPhone?: string | null; cess?: number | null; shareToken?: string | null; deductStock?: boolean | null
  docType?: string | null; reverseCharge?: boolean | null; currency?: string | null; fxRate?: number | null
  stockWarehouseId?: string | null
  // detail GET only: UPI payee for the "scan to pay" QR (company UPI id, else the print-on-invoice bank account's)
  upi?: { id: string; payeeName?: string | null } | null
  customer?: { name?: string | null; gstin?: string | null; contactPerson?: string | null; phone?: string | null; email?: string | null; city?: string | null; state?: string | null; stateCode?: string | null; addressLine?: string | null } | null
  items?: InvItem[] | null
}
interface CompanyRow { id: string; name?: string | null; gstin?: string | null; pan?: string | null; addressLine?: string | null; city?: string | null; state?: string | null; stateCode?: string | null; phone?: string | null; email?: string | null; bankAccountName?: string | null; bankAccountNumber?: string | null; bankIfsc?: string | null; bankUpiId?: string | null; invoiceTerms?: string | null
  logoImage?: string | null; signatureImage?: string | null; roundOffTotals?: boolean | null }
// soItemId ties a line to its sales-order line so the API can enforce the over-invoicing guard per line.
// unit: the item's secondary unit when chosen (qty/rate are then per that unit; converted to base on submit).
interface DraftLine { itemId: string; qty: number; rate: number; discountPct: number; gstRate: number; cessRate: number; soItemId?: string; batchNo?: string; serials?: string; unit?: string }

// ---- batch / serial inputs for direct-sale stock deduction ----
const serialList = (t: string) => Array.from(new Set(t.split(/[\r\n,;]+/).map((x) => x.trim()).filter(Boolean)))
function LineBatchPick({ companyId, itemId, warehouseId, value, onChange }: {
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
function LineSerialPick({ companyId, itemId, warehouseId, qty, value, onChange }: {
  companyId: string; itemId: string; warehouseId: string; qty: number; value: string; onChange: (v: string) => void
}) {
  const inStock = useList<{ items: { id: string; serialNo: string }[] }>(
    warehouseId ? `/api/serials?companyId=${companyId}&itemId=${itemId}&warehouseId=${warehouseId}&status=IN_STOCK` : null,
  )
  const avail = (inStock.data?.items ?? []).map((s) => s.serialNo).sort()
  const entered = serialList(value)
  const need = Math.round(qty)
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <span className={entered.length === need ? 'text-[10px] text-muted-foreground uppercase' : 'text-[10px] text-amber-600 uppercase'}>
          Serial nos — {entered.length} of {need} entered · {avail.length} in stock
        </span>
        {avail.length > 0 && (
          <Button type="button" variant="ghost" size="sm" className="h-6 text-xs"
            onClick={() => onChange(avail.filter((s) => !entered.includes(s)).slice(0, Math.max(0, need - entered.length)).concat(entered).join('\n'))}>
            Fill from stock
          </Button>
        )}
      </div>
      <Textarea rows={2} value={value} onChange={(e) => onChange(e.target.value)} placeholder="One serial / IMEI per line" />
    </div>
  )
}
interface WarehouseRow { id: string; code?: string | null; name?: string | null; type?: string | null }
interface AccountRow { id: string; name: string; type: string; isDefault?: boolean; active?: boolean; createdAt?: string }
interface LastRate { rate: number; discountPct: number; date: string; ref: string }
interface BillAdj { billDiscount: number; freight: number; freightGst: number; packing: number; packingGst: number; roundOff: boolean }
interface ChallanDetail {
  id: string; number: string; status: string; salesOrderId: string
  vehicleNo?: string | null; transporter?: string | null; shippingAddress?: string | null; driverPhone?: string | null
  items?: { salesOrderItemId?: string | null; itemId: string; qty: number }[] | null
}

const r2 = (n: number) => Math.round(n * 100) / 100
const today = () => new Date().toISOString().slice(0, 10)
const INVOICEABLE = ['CONFIRMED', 'IN_PRODUCTION', 'READY', 'PARTIALLY_DISPATCHED', 'DISPATCHED']

// Thermal receipt paper width (mm) — the last choice is remembered per browser
type ReceiptWidth = 58 | 80
const RECEIPT_WIDTH_KEY = 'erp_receipt_width'
function readReceiptWidth(): ReceiptWidth {
  try { return localStorage.getItem(RECEIPT_WIDTH_KEY) === '80' ? 80 : 58 } catch { return 58 }
}
function saveReceiptWidth(w: ReceiptWidth) {
  try { localStorage.setItem(RECEIPT_WIDTH_KEY, String(w)) } catch { /* private mode — just don't remember */ }
}

// Client copy of computeBillTotals (src/lib/erp-helpers.ts) — keep the two in step.
function computeTotals(lines: DraftLine[], interState: boolean, adj: BillAdj) {
  let subtotal = 0, lineDisc = 0
  const bases = lines.map((l) => {
    const gross = (l.qty || 0) * (l.rate || 0)
    const disc = gross * ((l.discountPct || 0) / 100)
    subtotal += gross; lineDisc += disc
    return gross - disc
  })
  const baseSum = bases.reduce((s, b) => s + b, 0)
  const billDiscount = Math.min(Math.max(0, adj.billDiscount || 0), baseSum)
  let cgst = 0, sgst = 0, igst = 0, cess = 0, taxableSum = 0
  const addTax = (tax: number) => { if (interState) igst += tax; else { cgst += tax / 2; sgst += tax / 2 } }
  lines.forEach((l, i) => {
    const taxable = baseSum > 0 ? bases[i] - billDiscount * (bases[i] / baseSum) : bases[i]
    taxableSum += taxable
    addTax(taxable * ((l.gstRate || 0) / 100))
    cess += taxable * ((l.cessRate || 0) / 100)
  })
  const charge = (amount: number, gstRate: number) => {
    const a = Math.max(0, amount || 0)
    if (a) addTax(a * ((gstRate ?? 18) / 100))
    return r2(a)
  }
  const freight = charge(adj.freight, adj.freightGst)
  const packing = charge(adj.packing, adj.packingGst)
  const exact = r2(taxableSum + freight + packing + r2(cgst) + r2(sgst) + r2(igst) + r2(cess))
  const grand = adj.roundOff ? Math.round(exact) : exact
  return {
    subtotal: r2(subtotal), discount: r2(lineDisc + billDiscount), freight, packing,
    cgst: r2(cgst), sgst: r2(sgst), igst: r2(igst), cess: r2(cess), roundOff: r2(grand - exact), grand: r2(grand),
  }
}

// Same rule as isInterStateParty on the server: GST state codes when both have one, else state names.
function interStateOf(co?: { state?: string | null; stateCode?: string | null } | null, party?: { state?: string | null; stateCode?: string | null } | null) {
  const diff = (a?: string | null, b?: string | null) => !!a && !!b && a.trim().toLowerCase() !== b.trim().toLowerCase()
  if (co?.stateCode && party?.stateCode) return diff(co.stateCode, party.stateCode)
  return diff(co?.state, party?.state)
}

// Rate last billed to this customer for an item (null when never sold to them / on error).
async function lastRateFor(companyId: string, customerId: string, itemId: string): Promise<LastRate | null> {
  try {
    const r = await apiGet<{ rates?: Record<string, LastRate> }>(`/api/parties/last-rates?companyId=${companyId}&kind=customer&partyId=${encodeURIComponent(customerId)}&itemIds=${encodeURIComponent(itemId)}`)
    return r.rates?.[itemId] ?? null
  } catch { return null }
}

// Only data: image URLs (uploaded in Settings) are embedded in prints.
const safeImg = (v?: string | null) => (v && /^data:image\/(png|jpe?g|gif|webp|svg\+xml);base64,/i.test(v) ? v : '')
type PrintSize = 'A4' | 'A5'
function emptyLine(): DraftLine { return { itemId: '', qty: 1, rate: 0, discountPct: 0, gstRate: 18, cessRate: 0 } }

// Escape a value for interpolation into the print-window HTML.
const esc = (v?: string | null) =>
  (v ?? '').replace(/[&<>"]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'))
// Join non-empty address parts with ', ' (raw — wrap the result in esc() before injecting).
const joinAddr = (...parts: (string | null | undefined)[]) =>
  parts.filter((p): p is string => !!p && p.trim() !== '').join(', ')

// "Scan to pay" UPI QR block for prints ('' when there is no UPI id or nothing is outstanding).
async function upiQrHtml(upiId: string | null | undefined, payee: string, amount: number, invoiceNo: string, px: number): Promise<string> {
  const pa = (upiId || '').trim()
  if (!pa || !(amount > 0.005)) return ''
  const link = `upi://pay?pa=${encodeURIComponent(pa)}&pn=${encodeURIComponent(payee)}&am=${amount.toFixed(2)}&cu=INR&tn=${encodeURIComponent(invoiceNo)}`
  try {
    const src = await QRCode.toDataURL(link, { margin: 1, width: 180 })
    return `<div class="upi-qr" style="text-align:center"><img src="${src}" alt="UPI QR" style="width:${px}px;height:${px}px;display:block;margin:0 auto" /><div style="font-weight:700;font-size:11px;margin-top:2px">Scan to pay ${esc(fmtMoney(amount))}</div></div>`
  } catch { return '' }
}

// Build a wa.me deep link: 10-digit numbers get the '91' prefix, already-prefixed
// 12-digit numbers pass through, anything else (or no phone) opens WhatsApp's chat chooser.
function waUrl(phone: string | null | undefined, message: string): string {
  const digits = (phone || '').replace(/\D/g, '')
  const to = digits.length === 10 ? `91${digits}` : digits.length === 12 && digits.startsWith('91') ? digits : ''
  return `https://wa.me/${to}?text=${encodeURIComponent(message)}`
}

// Build a mailto: deep link — a missing recipient opens the user's mail app with a blank To: field.
function mailtoUrl(email: string | null | undefined, subject: string, body: string): string {
  return `mailto:${email || ''}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
}

// Share text for the WhatsApp and email actions on a sales invoice.
function invoiceMessage(row: InvoiceRow, company?: CompanyRow): string {
  const customerName = row.customer?.name || 'Customer'
  return `Namaste ${customerName},\n\nTax Invoice ${row.number} dated ${fmtDate(row.date)} — Amount ${fmtMoney(row.grandTotal)}.\n${row.paidAmount < row.grandTotal ? `Balance due: ${fmtMoney(r2(row.grandTotal - row.paidAmount))}${row.dueDate ? ` (due ${fmtDate(row.dueDate)})` : ''}\n` : ''}${company?.bankUpiId ? `Pay via UPI: ${company.bankUpiId}\n` : ''}Thank you,\n${company?.name || 'Accounts'}`
}

export default function SalesInvoicesModule({ companyId }: { companyId: string }) {
  const highlightId = useRowHighlight('sales-invoices')
  const list = useList<{ items: InvoiceRow[] }>(`/api/sales-invoices?companyId=${companyId}`)
  const customers = useList<{ items: PartyRow[] }>(`/api/customers?companyId=${companyId}`)
  const items = useList<{ items: ItemRow[] }>(`/api/items?companyId=${companyId}`)
  const sos = useList<{ items: { id: string; number: string; status: string }[] }>(`/api/sales-orders?companyId=${companyId}`)
  const settings = useList<CompanyRow>(`/api/settings?companyId=${companyId}`)
  const warehouses = useList<{ items: WarehouseRow[] }>(`/api/warehouses?companyId=${companyId}`)
  // Cash & Bank accounts — optional: when the endpoint is missing / fails the "Into account" select is hidden
  const [accounts, setAccounts] = React.useState<AccountRow[]>([])
  React.useEffect(() => {
    let alive = true
    apiGet<{ items?: AccountRow[] }>(`/api/accounts?companyId=${companyId}`)
      .then((r) => { if (alive) setAccounts((r?.items ?? []).filter((a) => a.active !== false)) })
      .catch(() => { if (alive) setAccounts([]) })
    return () => { alive = false }
  }, [companyId])

  const [open, setOpen] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  // Editing a saved invoice (PATCH action 'edit') instead of creating one; null = create
  const [editing, setEditing] = React.useState<{ id: string; number: string } | null>(null)
  const [mode, setMode] = React.useState('SO')
  const [salesOrderId, setSalesOrderId] = React.useState('')
  const [customerId, setCustomerId] = React.useState('')
  const [date, setDate] = React.useState(today)
  const [dueDate, setDueDate] = React.useState('')
  const [placeOfSupply, setPlaceOfSupply] = React.useState('')
  // GST document options (ported from the free GST billing app)
  const [docType, setDocType] = React.useState('TAX_INVOICE')
  const [currency, setCurrency] = React.useState('INR')
  const [fxRate, setFxRate] = React.useState(1)
  const [reverseCharge, setReverseCharge] = React.useState(false)
  const [notes, setNotes] = React.useState('')
  const [challanId, setChallanId] = React.useState('')
  const [challanNo, setChallanNo] = React.useState('')
  const [customerPoNo, setCustomerPoNo] = React.useState('')
  const [customerPoDate, setCustomerPoDate] = React.useState('')
  const [shippingAddress, setShippingAddress] = React.useState('')
  const [vehicleNo, setVehicleNo] = React.useState('')
  const [transporter, setTransporter] = React.useState('')
  const [lines, setLines] = React.useState<DraftLine[]>([emptyLine()])
  const [isCashSale, setIsCashSale] = React.useState(false)
  const [billDiscount, setBillDiscount] = React.useState(0)
  const [freightCharge, setFreightCharge] = React.useState(0)
  const [freightGstRate, setFreightGstRate] = React.useState(18)
  const [packingCharge, setPackingCharge] = React.useState(0)
  const [packingGstRate, setPackingGstRate] = React.useState(18)
  const [receivedAmount, setReceivedAmount] = React.useState(0)
  const [receivedMode, setReceivedMode] = React.useState('CASH')
  const [receivedChequeNo, setReceivedChequeNo] = React.useState('')
  const [receivedChequeDate, setReceivedChequeDate] = React.useState('')
  const [receivedAccountId, setReceivedAccountId] = React.useState('') // '' = default account for the mode
  const [billingName, setBillingName] = React.useState('')
  const [driverPhone, setDriverPhone] = React.useState('')
  const [deductStock, setDeductStock] = React.useState(true)
  const [stockWarehouseId, setStockWarehouseId] = React.useState('') // '' = FG store, else first
  const [lastHints, setLastHints] = React.useState<Record<string, string>>({})

  const [payFor, setPayFor] = React.useState<InvoiceRow | null>(null)
  const [payAmount, setPayAmount] = React.useState(0)
  const [payMode, setPayMode] = React.useState('NEFT')
  const [payDate, setPayDate] = React.useState(today)
  const [payRef, setPayRef] = React.useState('')
  const [paying, setPaying] = React.useState(false)

  const rows = list.data?.items ?? []
  const customerOpts = (customers.data?.items ?? []).map((c) => ({ value: c.id, label: c.name || c.id }))
  const soOpts = (sos.data?.items ?? []).filter((s) => INVOICEABLE.includes(s.status)).map((s) => ({ value: s.id, label: `${s.number} (${s.status.replaceAll('_', ' ')})` }))

  function resetForm() {
    setMode('SO'); setSalesOrderId(''); setCustomerId(''); setDate(today()); setDueDate(''); setPlaceOfSupply(''); setNotes('')
    setChallanId(''); setChallanNo(''); setCustomerPoNo(''); setCustomerPoDate(''); setShippingAddress('')
    setVehicleNo(''); setTransporter('')
    setDocType('TAX_INVOICE'); setCurrency('INR'); setFxRate(1); setReverseCharge(false)
    setLines([emptyLine()])
    setIsCashSale(false); setBillDiscount(0); setFreightCharge(0); setFreightGstRate(18); setPackingCharge(0); setPackingGstRate(18)
    setReceivedAmount(0); setReceivedMode('CASH'); setReceivedAccountId(''); setReceivedChequeNo(''); setReceivedChequeDate(''); setLastHints({})
    setBillingName(''); setDriverPhone(''); setDeductStock(true); setStockWarehouseId('')
    setEditing(null)
  }

  // Only an unpaid direct invoice (no SO / challan, no IRN) can be edited; the server also checks sales returns
  const canEdit = (r: InvoiceRow) =>
    r.status === 'UNPAID' && (r.paidAmount || 0) <= 0.005 && !r.salesOrderId && !r.challanId && !r.irn

  /** Open the create form pre-filled with a saved invoice (lines in the base unit). */
  async function openEdit(row: InvoiceRow) {
    let inv: InvoiceRow
    try {
      inv = await apiGet<InvoiceRow>(`/api/sales-invoices/${row.id}?companyId=${companyId}`)
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to load invoice'); return }
    resetForm()
    setEditing({ id: inv.id, number: inv.number })
    setMode('MANUAL')
    setIsCashSale(!!inv.isCashSale)
    setCustomerId(inv.isCashSale ? '' : inv.customerId || '')
    setDate(inv.date ? inv.date.slice(0, 10) : today())
    setDueDate(inv.dueDate ? inv.dueDate.slice(0, 10) : '')
    setPlaceOfSupply(inv.placeOfSupply || ''); setNotes(inv.notes || '')
    setDocType(inv.docType || 'TAX_INVOICE'); setCurrency(inv.currency || 'INR')
    setFxRate(inv.fxRate || 1); setReverseCharge(!!inv.reverseCharge)
    setCustomerPoNo(inv.customerPoNo || ''); setCustomerPoDate(inv.customerPoDate ? inv.customerPoDate.slice(0, 10) : '')
    setShippingAddress(inv.shippingAddress || ''); setVehicleNo(inv.vehicleNo || ''); setTransporter(inv.transporter || '')
    setBillingName(inv.billingName || ''); setDriverPhone(inv.driverPhone || '')
    setBillDiscount(inv.billDiscount || 0)
    setFreightCharge(inv.freightCharge || 0); setFreightGstRate(inv.freightGstRate ?? 18)
    setPackingCharge(inv.packingCharge || 0); setPackingGstRate(inv.packingGstRate ?? 18)
    setDeductStock(!!inv.deductStock); setStockWarehouseId(inv.stockWarehouseId || '')
    const mapped: DraftLine[] = (inv.items ?? []).map((it) => {
      // keep a single named batch; a split / un-batched allocation goes back to auto (FEFO)
      const b = String(it.batchNo || '').trim()
      const batchNo = b && !b.includes(',') && !b.includes('×') && b.toUpperCase() !== 'UNBATCHED' ? b : undefined
      return {
        itemId: it.itemId, qty: it.qty, rate: it.rate, discountPct: it.discountPct ?? 0, gstRate: it.gstRate, cessRate: it.cessRate ?? 0,
        batchNo, serials: it.serials || undefined,
      }
    })
    setLines(mapped.length ? mapped : [emptyLine()])
    setOpen(true)
  }

  // Picking a customer pre-fills an empty shipping address from the customer master
  function pickCustomer(id: string) {
    setCustomerId(id)
    const c = (customers.data?.items ?? []).find((x) => x.id === id)
    if (c?.shippingAddress) setShippingAddress((cur) => cur.trim() ? cur : (c.shippingAddress || ''))
  }

  function toggleCashSale(on: boolean) {
    setIsCashSale(on)
    if (on) { setMode('MANUAL'); setSalesOrderId(''); setChallanId(''); setChallanNo(''); setCustomerId(''); setReceivedMode('CASH') }
  }

  /** The customer's last billed rate/discount for this item replaces the master selling price. */
  async function applyLastRate(itemId: string) {
    if (!customerId || isCashSale) return
    const lr = await lastRateFor(companyId, customerId, itemId)
    if (!lr) return
    // Last rate is per base unit — re-express it in the line's chosen unit
    setLines((ls) => ls.map((x) => (x.itemId === itemId ? { ...x, rate: convertRate(lr.rate, undefined, x.unit, itemRow(itemId)), discountPct: lr.discountPct ?? x.discountPct } : x)))
    setLastHints((h) => ({ ...h, [itemId]: `last rate ${fmtMoney(lr.rate)} on ${lr.ref}` }))
  }

  // Shortcuts from other screens (party view, row actions, quick actions) open this form pre-filled
  useCreatePreset('sales-invoices', (d) => {
    resetForm()
    if (d.soId) void pickSo(String(d.soId), d.challanId ? String(d.challanId) : undefined)
    else if (d.customerId) { setMode('MANUAL'); pickCustomer(String(d.customerId)) }
    setOpen(true)
  })

  const itemFlag = (itemId: string) => {
    const it = (items.data?.items ?? []).find((o) => o.id === itemId)
    return { batchTracked: !!it?.batchTracked, trackSerial: !!it?.trackSerial }
  }
  const itemRow = (itemId: string) => (items.data?.items ?? []).find((o) => o.id === itemId)
  const itemCess = (itemId: string) => Number((items.data?.items ?? []).find((o) => o.id === itemId)?.cessRate || 0)

  // Picking an SO fills un-invoiced lines; with a challan (Deliveries → Invoice) only that challan's lines are billed.
  async function pickSo(sid: string, chId?: string) {
    setSalesOrderId(sid)
    setChallanId(chId || ''); setChallanNo('')
    if (!sid) return
    try {
      const so = await apiGet<InvoiceRow & { customerId?: string }>(`/api/sales-orders/${sid}?companyId=${companyId}`)
      if (so.customerId) setCustomerId(so.customerId)
      setCustomerPoNo(so.customerPoNo || '')
      setCustomerPoDate(so.customerPoDate ? so.customerPoDate.slice(0, 10) : '')
      setShippingAddress(so.shippingAddress || '')
      const soItems = so.items ?? []
      if (chId) {
        const ch = await apiGet<ChallanDetail>(`/api/deliveries/${chId}?companyId=${companyId}`)
        const mapped: DraftLine[] = []
        for (const ci of ch.items ?? []) {
          const si = ci.salesOrderItemId ? soItems.find((x) => x.id === ci.salesOrderItemId) : soItems.find((x) => x.itemId === ci.itemId)
          if (!si) continue
          mapped.push({ itemId: ci.itemId, qty: r2(ci.qty), rate: si.rate, discountPct: si.discountPct ?? 0, gstRate: si.gstRate, cessRate: itemCess(ci.itemId), soItemId: si.id })
        }
        setLines(mapped.length ? mapped : [emptyLine()])
        setChallanNo(ch.number)
        setVehicleNo(ch.vehicleNo || ''); setTransporter(ch.transporter || ''); setDriverPhone(ch.driverPhone || '')
        if (ch.shippingAddress) setShippingAddress(ch.shippingAddress)
        toast.success(`Loaded ${mapped.length} line(s) from challan ${ch.number}`)
        return
      }
      const mapped = soItems
        .filter((it) => it.qty - (it.invoicedQty ?? 0) > 0)
        .map((it) => ({ itemId: it.itemId, qty: r2(it.qty - (it.invoicedQty ?? 0)), rate: it.rate, discountPct: it.discountPct ?? 0, gstRate: it.gstRate, cessRate: itemCess(it.itemId), soItemId: it.id }))
      setLines(mapped.length ? mapped : [emptyLine()])
      toast.success(`Loaded ${mapped.length} pending line(s) from ${so.number}`)
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to load sales order') }
  }

  /** Choose an item for a line; an item already on another line just adds this qty there. */
  function pickLineItem(idx: number, it: ItemRow) {
    if (!lines.some((x, i) => i !== idx && x.itemId === it.id)) void applyLastRate(it.id)
    setLines((ls) => {
      const r = pickIntoLines(ls, idx, it.id, (x) => ({
        // A different item no longer matches the linked SO line
        ...x, itemId: it.id, soItemId: it.id === x.itemId ? x.soItemId : undefined, rate: x.rate || defaultSellRate(it), gstRate: it.gstRate ?? x.gstRate,
        unit: it.id === x.itemId ? x.unit : undefined,
        cessRate: it.id === x.itemId ? x.cessRate : Number(it.cessRate || 0),
      }))
      if (r.merged) toast.info('Item already on this invoice — quantity added to that line')
      return r.lines
    })
  }

  /** Barcode scan: +1 on the item's line, or a new line. */
  function scanItem(it: PickerItem) {
    const row = (items.data?.items ?? []).find((o) => o.id === it.id)
    setLines((ls) => scanIntoLines(ls, it.id, () => ({ ...emptyLine(), itemId: it.id, qty: 1, rate: defaultSellRate(row), gstRate: row?.gstRate ?? 18, cessRate: Number(row?.cessRate || 0) })))
  }

  async function submit() {
    if (mode === 'SO' && !salesOrderId) { toast.error('Select a sales order'); return }
    if (mode === 'MANUAL' && !isCashSale && !customerId) { toast.error('Select a customer'); return }
    // qty / rate go to the API in the item's base unit
    const valid = lines.filter((l) => l.itemId && l.qty > 0).map((l) => lineToBase(l, itemRow(l.itemId)))
    if (!valid.length) { toast.error('Add at least one line with item and qty'); return }
    if (directSale && deductStock && !effectiveWarehouseId) { toast.error('Select the warehouse to deduct stock from'); return }
    if (directSale && deductStock) {
      const bad = valid.find((l) => itemFlag(l.itemId).trackSerial && serialList(l.serials || '').length !== l.qty)
      if (bad) { toast.error(`Enter exactly ${bad.qty} serial no(s) for each serial-tracked line`); return }
    }
    setSaving(true)
    if (editing) {
      try {
        await apiPatch(`/api/sales-invoices/${editing.id}`, {
          action: 'edit', companyId, customerId: isCashSale ? undefined : customerId || undefined,
          billDiscount, freightCharge, freightGstRate, packingCharge, packingGstRate,
          billingName: billingName.trim() || undefined, driverPhone: driverPhone.trim() || undefined,
          deductStock, stockWarehouseId: deductStock ? effectiveWarehouseId || undefined : undefined,
          date, dueDate: dueDate || undefined, placeOfSupply: placeOfSupply || undefined, notes: notes || undefined,
          docType, reverseCharge, currency, fxRate: currency === 'INR' ? 1 : fxRate,
          customerPoNo: customerPoNo || undefined, customerPoDate: customerPoDate || undefined,
          shippingAddress: shippingAddress || undefined, vehicleNo: vehicleNo || undefined, transporter: transporter || undefined,
          items: valid.map((l) => ({
            itemId: l.itemId, qty: l.qty, rate: l.rate, discountPct: l.discountPct, gstRate: l.gstRate, cessRate: l.cessRate,
            ...(deductStock && itemFlag(l.itemId).batchTracked && l.batchNo ? { batchNo: l.batchNo } : {}),
            ...(deductStock && itemFlag(l.itemId).trackSerial ? { serials: l.serials || '' } : {}),
          })),
        })
        toast.success(`Invoice ${editing.number} updated`)
        setOpen(false); resetForm(); void list.refetch()
      } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to update invoice') } finally { setSaving(false) }
      return
    }
    try {
      const fromSo = mode === 'SO' && !isCashSale
      if (receivedAmount > totals.grand + 0.01) { toast.error(`Received amount is more than the bill total (${fmtMoney(totals.grand)})`); setSaving(false); return }
      await apiPost('/api/sales-invoices', {
        companyId, salesOrderId: fromSo ? salesOrderId : undefined, customerId: isCashSale ? undefined : customerId || undefined,
        isCashSale: isCashSale || undefined,
        billDiscount, freightCharge, freightGstRate, packingCharge, packingGstRate,
        // Cash sale with nothing typed → the server records the full bill as received
        receivedAmount: receivedAmount > 0 ? receivedAmount : isCashSale ? undefined : 0,
        receivedMode,
        receivedAccountId: effectiveAccountId || undefined,
        ...(receivedMode === 'CHEQUE' ? { receivedChequeNo: receivedChequeNo.trim() || undefined, receivedChequeDate: receivedChequeDate || undefined } : {}),
        billingName: billingName.trim() || undefined, driverPhone: driverPhone.trim() || undefined,
        // Direct sale only — with an SO / challan the challan dispatch already moved the stock
        deductStock: directSale ? deductStock : undefined,
        stockWarehouseId: directSale && deductStock ? effectiveWarehouseId || undefined : undefined,
        challanId: fromSo && challanId ? challanId : undefined,
        date, dueDate: dueDate || undefined, placeOfSupply: placeOfSupply || undefined, notes: notes || undefined,
        docType, reverseCharge, currency, fxRate: currency === 'INR' ? 1 : fxRate,
        customerPoNo: customerPoNo || undefined, customerPoDate: customerPoDate || undefined,
        shippingAddress: shippingAddress || undefined, vehicleNo: vehicleNo || undefined, transporter: transporter || undefined,
        items: valid.map((l) => ({
          itemId: l.itemId, qty: l.qty, rate: l.rate, discountPct: l.discountPct, gstRate: l.gstRate, cessRate: l.cessRate,
          salesOrderItemId: fromSo && l.soItemId ? l.soItemId : undefined,
          ...(directSale && deductStock && itemFlag(l.itemId).batchTracked && l.batchNo ? { batchNo: l.batchNo } : {}),
          ...(directSale && deductStock && itemFlag(l.itemId).trackSerial ? { serials: l.serials || '' } : {}),
        })),
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

  async function shareInvoice(row: InvoiceRow) {
    // Company profile is only needed for the UPI line + signature — best-effort fetch.
    let company: CompanyRow | undefined
    try {
      company = await apiGet<CompanyRow>(`/api/settings?companyId=${companyId}`)
    } catch { /* omit the UPI line if the profile can't be fetched */ }
    const message = invoiceMessage(row, company)
    if (!row.customer?.phone) toast.info('No phone saved for this customer — choose a chat in WhatsApp')
    window.open(waUrl(row.customer?.phone, message), '_blank', 'noopener,noreferrer')
  }

  // Public share link (/share/invoice/<token>) — created on first use, the same link afterwards.
  async function shareLink(row: InvoiceRow): Promise<string | null> {
    try {
      const r = await apiPost<{ token: string; path: string }>(`/api/sales-invoices/${row.id}/share`, { companyId })
      if (!row.shareToken) void list.refetch()
      return `${window.location.origin}${r.path}`
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Could not create the share link'); return null }
  }

  async function copyShareLink(row: InvoiceRow) {
    const url = await shareLink(row)
    if (!url) return
    try {
      await navigator.clipboard.writeText(url)
      toast.success('Invoice link copied')
    } catch {
      toast.info('Copy this link', { description: url, duration: 15000 })
    }
  }

  async function whatsappShareLink(row: InvoiceRow) {
    // Open the tab synchronously (popup blockers), then point it at wa.me once the link exists
    const win = window.open('', '_blank')
    const url = await shareLink(row)
    if (!url) { win?.close(); return }
    const wa = waUrl(row.customer?.phone, `Invoice ${row.number} for ${fmtMoney(row.grandTotal)} : ${url}`)
    if (!row.customer?.phone) toast.info('No phone saved for this customer — choose a chat in WhatsApp')
    if (win) { win.opener = null; win.location.href = wa } else window.open(wa, '_blank', 'noopener,noreferrer')
  }

  async function revokeShareLink(row: InvoiceRow) {
    try {
      await apiDelete(`/api/sales-invoices/${row.id}/share?companyId=${companyId}`)
      toast.success(`Share link for ${row.number} revoked — the old link no longer opens`)
      void list.refetch()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to revoke link') }
  }

  async function emailInvoice(row: InvoiceRow) {
    // Company profile is only needed for the subject sign-off + UPI line — best-effort fetch.
    let company: CompanyRow | undefined
    try {
      company = await apiGet<CompanyRow>(`/api/settings?companyId=${companyId}`)
    } catch { /* subject falls back to the generic name without the profile */ }
    const subject = `Tax Invoice ${row.number} — ${company?.name || 'Accounts'}`
    // The list API's customer select has no email — the mail app opens with a blank recipient.
    if (!row.customer?.email) toast.info('No email saved for this customer — your mail app will open with a blank recipient')
    window.location.href = mailtoUrl(row.customer?.email, subject, invoiceMessage(row, company))
  }

  // Prefer the detail endpoint — it returns the full customer (phone/email/address),
  // items with UOM and the seller company (PAN/state code) needed on a GST tax invoice.
  async function loadForPrint(row: InvoiceRow): Promise<{ inv: InvoiceRow; seller?: CompanyRow }> {
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
    return { inv, seller }
  }

  // ---- print: batch / expiry / serials under each line ----
  // Line batch text is "B1" or "B1×5, B2×3" (UNBATCHED = stock from before batch tracking)
  const batchNames = (text: string | null | undefined) => String(text || '').split(',').map((p) => {
    const t = p.trim(); const i = t.lastIndexOf('×')
    return (i > 0 ? t.slice(0, i) : t).trim()
  }).filter(Boolean)
  /** itemId|batchNo → expiry (one batches lookup per batch-tracked item on the invoice; best effort) */
  async function batchExpiries(inv: InvoiceRow): Promise<Map<string, string>> {
    const out = new Map<string, string>()
    const itemIds = Array.from(new Set((inv.items ?? []).filter((it) => it.batchNo).map((it) => it.itemId)))
    await Promise.all(itemIds.map(async (itemId) => {
      try {
        const res = await apiGet<{ items?: { batchNo: string; expiryDate?: string | null }[] }>(`/api/batches?companyId=${companyId}&itemId=${itemId}&includeEmpty=1`)
        for (const b of res.items ?? []) if (b.expiryDate && !out.has(`${itemId}|${b.batchNo}`)) out.set(`${itemId}|${b.batchNo}`, b.expiryDate)
      } catch { /* show the batch without expiry */ }
    }))
    return out
  }
  /** Plain-text tracking lines for one invoice line ([] when untracked). Escape before use. */
  function trackingText(it: InvItem, exp: Map<string, string>): string[] {
    const out: string[] = []
    const names = batchNames(it.batchNo).filter((b) => b.toUpperCase() !== 'UNBATCHED')
    if (names.length) {
      out.push(names.map((b) => {
        const e = exp.get(`${it.itemId}|${b}`)
        return `Batch: ${b}${e ? ` · Exp: ${fmtDate(e)}` : ''}`
      }).join('; '))
    }
    const sn = String(it.serials || '').split(/[\r\n,;]+/).map((x) => x.trim()).filter(Boolean)
    if (sn.length) out.push(`S/N: ${sn.join(', ')}`)
    return out
  }

  async function printInvoice(row: InvoiceRow, size: PrintSize = 'A4') {
    const { inv, seller } = await loadForPrint(row)
    const exp = await batchExpiries(inv)
    const logo = safeImg(seller?.logoImage)
    const sign = safeImg(seller?.signatureImage)
    const freight = inv.freightCharge || 0
    const packing = inv.packingCharge || 0
    const roundOff = inv.roundOff || 0
    const billDisc = inv.billDiscount || 0
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
    const docTitle = inv.docType === 'BILL_OF_SUPPLY' ? 'Bill of Supply' : inv.docType === 'PROFORMA' ? 'Proforma Invoice' : 'Tax Invoice'
    const docNotes = [
      inv.reverseCharge ? 'Reverse charge: GST is payable by the recipient under Sec 9(3)/9(4).' : '',
      inv.currency && inv.currency !== 'INR' ? fxDeclaration(inv.currency, inv.fxRate || 1) : '',
      inv.docType === 'BILL_OF_SUPPLY' ? 'Bill of Supply — issued for exempt / nil-rated supplies; no GST is charged.' : '',
      inv.docType === 'PROFORMA' ? 'Proforma Invoice — not a demand for payment; a tax invoice follows on supply.' : '',
    ].filter(Boolean)

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
    // "Scan to pay" QR for the outstanding amount (skipped when fully paid / no UPI id)
    const qr = await upiQrHtml(inv.upi?.id || bankUpi, inv.upi?.payeeName || sellerName, balance, inv.number, size === 'A5' ? 84 : 110)

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
        .gst-inv .logo { max-height: 64px; max-width: 150px; object-fit: contain; margin-right: 12px; }
        .gst-inv .sign { max-height: 54px; max-width: 170px; object-fit: contain; display: block; margin: 8px 0 0 auto; }
        .gst-inv .signline.with-img { margin-top: 4px; }
        ${size === 'A5' ? `
        @page { size: A5; margin: 6mm; }
        body { padding: 0 !important; font-size: 10px; }
        h1 { font-size: 14px !important; }
        th, td { font-size: 9px !important; padding: 3px 5px !important; }
        .muted { font-size: 9px !important; }
        .gst-inv .title { font-size: 12px; padding: 4px 8px; letter-spacing: 3px; }
        .gst-inv .grid td { padding: 5px 7px !important; }
        .gst-inv .words { font-size: 10px; }
        .gst-inv .bankbox, .gst-inv .terms { font-size: 9px; }
        .gst-inv .signline { margin-top: 44px; font-size: 9px; }
        .gst-inv .footer { font-size: 8.5px; padding: 4px 8px; }
        .gst-inv .grand td { font-size: 12px !important; }
        .gst-inv .logo { max-height: 44px; max-width: 110px; }
        .gst-inv .sign { max-height: 40px; }` : '@page { size: A4; margin: 10mm; }'}
      </style>
      <div class="gst-inv">
        <div class="title">TAX INVOICE</div>
        <div class="head" style="padding:10px 12px">
          <div style="display:flex;align-items:flex-start">
          ${logo ? `<img class="logo" src="${esc(logo)}" alt="" />` : ''}
          <div>
            <h1 style="font-size:17px">${esc(sellerName)}</h1>
            <div class="muted">${esc(joinAddr(seller?.addressLine, seller?.city, seller?.state)) || '&nbsp;'}</div>
            <div class="muted">${seller?.gstin ? `GSTIN: ${esc(seller.gstin)}` : ''}${sellerPan ? ` &nbsp;·&nbsp; PAN: ${esc(sellerPan)}` : ''}</div>
            <div class="muted">${esc(joinAddr(seller?.phone, seller?.email))}</div>
            <div class="muted">${esc(joinAddr(seller?.state, sellerStateCode ? `State Code: ${sellerStateCode}` : ''))}</div>
          </div>
          </div>
          <div style="text-align:right">
            <div style="font-size:13px"><strong>Invoice No: ${esc(inv.number)}</strong></div>
            <div class="muted">Date: ${new Date(inv.date).toLocaleDateString('en-IN')}</div>
            ${inv.dueDate ? `<div class="muted">Due: ${new Date(inv.dueDate).toLocaleDateString('en-IN')}</div>` : ''}
            ${inv.irn ? `<div class="muted" style="max-width:280px;word-break:break-all">IRN: ${esc(inv.irn)}</div>` : ''}
            ${inv.ewayBillNo ? `<div class="muted">E-Way Bill No: ${esc(inv.ewayBillNo)}</div>` : ''}
            ${inv.customerPoNo ? `<div class="muted">Buyer's PO: ${esc(inv.customerPoNo)}${inv.customerPoDate ? ` dt. ${new Date(inv.customerPoDate).toLocaleDateString('en-IN')}` : ''}</div>` : ''}
            <span class="badge">${esc(inv.status)}</span>
          </div>
        </div>
        <table class="grid"><tr>
          <td style="width:58%">
            <div class="sec">Buyer (Bill To)</div>
            <strong style="font-size:13px">${esc(inv.billingName || cust?.name || '—')}</strong>
            ${cust?.contactPerson ? `<div class="muted">Attn: ${esc(cust.contactPerson)}</div>` : ''}
            <div class="muted">${esc(joinAddr(cust?.addressLine, cust?.city)) || '&nbsp;'}</div>
            <div class="muted">${cust?.gstin ? `GSTIN: ${esc(cust.gstin)}` : ''}</div>
            <div class="muted">${esc(joinAddr(cust?.state, buyerStateCode ? `State Code: ${buyerStateCode}` : ''))}</div>
            ${buyerContact ? `<div class="muted">${esc(buyerContact)}</div>` : ''}
            ${inv.placeOfSupply ? `<div class="muted">Place of Supply: ${esc(inv.placeOfSupply)}</div>` : ''}
            ${docNotes.length ? `<div class="muted">${docNotes.map((n) => esc(n)).join('<br/>')}</div>` : ''}
            ${inv.shippingAddress ? `<div class="sec" style="margin-top:8px">Ship To</div><div class="muted" style="white-space:pre-wrap">${esc(inv.shippingAddress)}</div>` : ''}
          </td>
          <td style="width:42%">
            <div class="sec">Invoice Details</div>
            <table class="bare">
              <tr><td class="muted">Against Sales Order</td><td style="text-align:right"><strong>${esc(inv.salesOrder?.number || '—')}</strong></td></tr>
              ${inv.customerPoNo ? `<tr><td class="muted">Buyer's PO No / Date</td><td style="text-align:right">${esc(inv.customerPoNo)}${inv.customerPoDate ? ` / ${new Date(inv.customerPoDate).toLocaleDateString('en-IN')}` : ''}</td></tr>` : ''}
              <tr><td class="muted">Supply Type</td><td style="text-align:right">${interState ? 'Inter-State (IGST)' : 'Intra-State (CGST + SGST)'}</td></tr>
              ${inv.vehicleNo ? `<tr><td class="muted">Vehicle No</td><td style="text-align:right">${esc(inv.vehicleNo)}</td></tr>` : ''}
              ${inv.driverPhone ? `<tr><td class="muted">Driver Phone</td><td style="text-align:right">${esc(inv.driverPhone)}</td></tr>` : ''}
              ${inv.transporter ? `<tr><td class="muted">Transporter</td><td style="text-align:right">${esc(inv.transporter)}</td></tr>` : ''}
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
            const trk = trackingText(it, exp).map((t) => `<div class="muted" style="font-size:10px">${esc(t)}</div>`).join('')
            return `<tr><td>${i + 1}</td><td>${esc(it.item?.name || it.itemId)}${it.item?.code ? ` <span class="muted">(${esc(it.item.code)})</span>` : ''}${trk}</td><td>${esc(it.hsn || '—')}</td><td class="num">${it.qty}${it.item?.uom ? ` ${esc(it.item.uom)}` : ''}</td><td class="num">${fmtMoney(it.rate)}</td><td class="num">${it.discountPct || 0}</td><td class="num">${fmtMoney(taxable)}</td><td class="num">${it.gstRate}%</td><td class="num">${fmtMoney(it.lineTotal)}</td></tr>`
          }).join('')}</tbody>
          <tfoot><tr style="background:#f4f4f5;font-weight:600"><td colspan="3" style="text-align:right">Total</td><td class="num">${qtySum}</td><td></td><td></td><td class="num">${fmtMoney(taxableSum)}</td><td></td><td class="num">${fmtMoney(taxableSum)}</td></tr></tfoot>
        </table>
        <table class="grid"><tr>
          <td style="width:55%">
            <div class="sec">Bank Details</div>
            <div class="bankbox" style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px">
              <div>${hasBankDetails
                ? bankRowsHtml
                : `<strong>${esc(sellerName)}</strong><br/>A/C No.: As per records<br/>IFSC: As per records &nbsp;·&nbsp; UPI: As per records`}</div>
              ${qr}
            </div>
          </td>
          <td style="width:45%">
            <table class="totals" style="width:100%">
              <tr><td>Subtotal</td><td class="num">${fmtMoney(inv.subtotal)}</td></tr>
              <tr><td>Discount${billDisc > 0 ? ` <span class="muted">(incl. bill disc. ${fmtMoney(billDisc)})</span>` : ''}</td><td class="num">- ${fmtMoney(inv.discountTotal)}</td></tr>
              ${freight > 0 ? `<tr><td>Freight <span class="muted">(GST ${inv.freightGstRate ?? 18}%)</span></td><td class="num">${fmtMoney(freight)}</td></tr>` : ''}
              ${packing > 0 ? `<tr><td>Packing &amp; Forwarding <span class="muted">(GST ${inv.packingGstRate ?? 18}%)</span></td><td class="num">${fmtMoney(packing)}</td></tr>` : ''}
              ${interState
                ? `<tr><td>IGST</td><td class="num">${fmtMoney(inv.igst)}</td></tr>`
                : `<tr><td>CGST</td><td class="num">${fmtMoney(inv.cgst)}</td></tr><tr><td>SGST</td><td class="num">${fmtMoney(inv.sgst)}</td></tr>`}
              ${(inv.cess || 0) > 0 ? `<tr><td>Cess</td><td class="num">${fmtMoney(inv.cess || 0)}</td></tr>` : ''}
              ${Math.abs(roundOff) >= 0.005 ? `<tr><td>Round Off</td><td class="num">${roundOff > 0 ? '+ ' : '- '}${fmtMoney(Math.abs(roundOff))}</td></tr>` : ''}
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
            ${seller?.invoiceTerms && seller.invoiceTerms.trim()
              ? `<div class="terms" style="white-space:pre-wrap">${esc(seller.invoiceTerms.trim())}</div>`
              : `<div class="terms">
              1. Subject to ${seller?.city ? esc(seller.city) + ' ' : ''}jurisdiction.<br/>
              2. Interest @18% p.a. will be charged on overdue payments.<br/>
              3. Delivery subject to realisation of payment.<br/>
              4. Goods once sold will not be taken back. E&amp;OE.
            </div>`}
          </td>
          <td style="width:42%;text-align:right">
            <div style="font-weight:700;font-size:12px;text-align:left">For ${esc(sellerName)}</div>
            ${sign ? `<img class="sign" src="${esc(sign)}" alt="" />` : ''}
            <div class="signline${sign ? ' with-img' : ''}">Authorised Signatory</div>
          </td>
        </tr></table>
        <div class="footer">
          This is a computer-generated GST tax invoice.<br/>
          <strong>Declaration:</strong> We declare that this invoice shows the actual price of the goods described and that all particulars are true and correct.
        </div>
      </div>`
    printHtml(`${docTitle} ${row.number}${size === 'A5' ? ' (A5)' : ''}`, html)
  }

  // Lazy read is SSR-safe (try/catch) and only drives the ✓ inside the closed-by-default menu
  const [receiptWidth, setReceiptWidth] = React.useState<ReceiptWidth>(readReceiptWidth)

  // Compact thermal-printer receipt (58 mm / 80 mm roll) — black only, no tables wider than the paper.
  async function printReceipt(row: InvoiceRow, width: ReceiptWidth) {
    setReceiptWidth(width); saveReceiptWidth(width)
    const { inv, seller } = await loadForPrint(row)
    const exp = await batchExpiries(inv)
    const cust = inv.customer
    const interState = (inv.igst || 0) > 0
    const paid = inv.paidAmount || 0
    const balance = r2((inv.grandTotal || 0) - paid)
    const fs = width === 58 ? 11 : 12
    const qr = await upiQrHtml(inv.upi?.id || seller?.bankUpiId, inv.upi?.payeeName || seller?.name || 'Company', balance, inv.number, width === 58 ? 120 : 150)
    const amt = (label: string, value: string, cls = '') => `<div class="row ${cls}"><span>${label}</span><span>${value}</span></div>`
    const html = `
      <style>
        @page { size: ${width}mm auto; margin: 2mm; }
        html, body { margin: 0; padding: 0; background: #fff; }
        body { width: ${width - 4}mm; padding: 0 !important; color: #000; font-family: 'Courier New', Consolas, monospace; font-size: ${fs}px; line-height: 1.35; }
        .rc { width: 100%; overflow-wrap: anywhere; }
        .c { text-align: center; }
        .b { font-weight: 700; }
        .name { font-size: ${fs + 2}px; font-weight: 700; text-align: center; }
        .sep { border-top: 1px dashed #000; margin: 4px 0; height: 0; }
        .row { display: flex; justify-content: space-between; gap: 6px; }
        .row span:last-child { text-align: right; white-space: nowrap; }
        .r { text-align: right; }
        .line { margin-bottom: 3px; }
        .grand { font-size: ${fs + 3}px; font-weight: 700; }
        .terms { white-space: pre-wrap; font-size: ${fs - 1}px; }
        @media print { body { padding: 0 !important; } }
      </style>
      <div class="rc">
        <div class="name">${esc(seller?.name || 'Company')}</div>
        ${seller ? `<div class="c">${esc(joinAddr(seller.addressLine, seller.city, seller.state))}</div>` : ''}
        ${seller?.gstin ? `<div class="c">GSTIN: ${esc(seller.gstin)}</div>` : ''}
        ${seller?.phone ? `<div class="c">Ph: ${esc(seller.phone)}</div>` : ''}
        <div class="sep"></div>
        <div class="c b">TAX INVOICE</div>
        <div class="sep"></div>
        ${amt('Inv No:', esc(inv.number))}
        ${amt('Date:', esc(fmtDate(inv.date)))}
        <div>Customer: ${esc(inv.billingName || cust?.name || '—')}</div>
        ${cust?.gstin ? `<div>GSTIN: ${esc(cust.gstin)}</div>` : ''}
        <div class="sep"></div>
        ${(inv.items ?? []).map((it) => `<div class="line"><div>${esc(it.item?.name || it.itemId)}</div>${trackingText(it, exp).map((t) => `<div style="font-size:${fs - 2}px">${esc(t)}</div>`).join('')}<div class="r">${it.qty}${it.item?.uom ? ` ${esc(it.item.uom)}` : ''} x ${fmtMoney(it.rate)}${it.discountPct ? ` -${it.discountPct}%` : ''} = ${fmtMoney(it.lineTotal)}</div></div>`).join('')}
        <div class="sep"></div>
        ${amt('Subtotal', fmtMoney(inv.subtotal))}
        ${(inv.discountTotal || 0) > 0 ? amt('Discount', `- ${fmtMoney(inv.discountTotal)}`) : ''}
        ${(inv.freightCharge || 0) > 0 ? amt('Freight', fmtMoney(inv.freightCharge || 0)) : ''}
        ${(inv.packingCharge || 0) > 0 ? amt('Packing', fmtMoney(inv.packingCharge || 0)) : ''}
        ${interState ? amt('IGST', fmtMoney(inv.igst)) : `${amt('CGST', fmtMoney(inv.cgst))}${amt('SGST', fmtMoney(inv.sgst))}`}
        ${(inv.cess || 0) > 0 ? amt('Cess', fmtMoney(inv.cess || 0)) : ''}
        ${Math.abs(inv.roundOff || 0) >= 0.005 ? amt('Round off', `${(inv.roundOff || 0) > 0 ? '+' : '-'} ${fmtMoney(Math.abs(inv.roundOff || 0))}`) : ''}
        <div class="sep"></div>
        ${amt('TOTAL', fmtMoney(inv.grandTotal), 'grand')}
        ${paid > 0 ? `${amt('Paid', fmtMoney(paid))}${amt('Balance', fmtMoney(balance), 'b')}` : ''}
        <div style="margin-top:3px">Rupees ${esc(amountInWords(inv.grandTotal))} Only</div>
        ${qr ? `<div class="sep"></div>${qr}` : ''}
        <div class="sep"></div>
        <div class="c b">Thank you!</div>
        ${seller?.invoiceTerms && seller.invoiceTerms.trim() ? `<div class="terms" style="margin-top:3px">${esc(seller.invoiceTerms.trim())}</div>` : ''}
      </div>`
    printHtml(`Receipt ${row.number}`, html)
  }

  const company = settings.data
  const selCustomer = (customers.data?.items ?? []).find((c) => c.id === customerId)
  const interStatePreview = isCashSale ? false : interStateOf(company, selCustomer)
  const totals = computeTotals(lines.filter((l) => l.itemId).map((l) => lineToBase(l, itemRow(l.itemId))), interStatePreview, {
    billDiscount, freight: freightCharge, freightGst: freightGstRate, packing: packingCharge, packingGst: packingGstRate,
    roundOff: company?.roundOffTotals ?? true,
  })

  // Direct sale (manual lines / cash sale) — no challan moved the goods, so the invoice can deduct stock
  const directSale = isCashSale || mode === 'MANUAL'
  const whRows = warehouses.data?.items ?? []
  const effectiveWarehouseId = stockWarehouseId || (whRows.find((w) => w.type === 'FG') ?? whRows[0])?.id || ''
  const whOpts = whRows.map((w) => ({ value: w.id, label: w.name ? `${w.code || ''} ${w.name}`.trim() : w.code || w.id }))
  // "Into account": a cash account for CASH, a bank account for every other mode (no fallback to cash — CB-R5)
  const forMode = accountsForMode(accounts, receivedMode)
  const effectiveAccountId = accounts.length ? (receivedAccountId || forMode.fallback?.id || '') : ''
  const accountOpts = forMode.matching.map((a) => ({ value: a.id, label: a.name }))

  const columns: Column<InvoiceRow>[] = [
    { key: 'number', header: 'Invoice #', render: (r) => <span className="font-medium">{r.number}</span> },
    { key: 'date', header: 'Date', render: (r) => <DateCell value={r.date} /> },
    {
      key: 'customer', header: 'Customer', sortValue: (r) => r.customer?.name || '',
      render: (r) => (
        <span className="inline-flex items-center gap-1.5">
          {r.customer?.name || '—'}
          {r.isCashSale && <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">Cash Sale</span>}
        </span>
      ),
    },
    { key: 'total', header: 'Grand Total', sortValue: (r) => r.grandTotal || 0, sum: true, sumFormat: 'money', render: (r) => <Money value={r.grandTotal} className="font-medium" /> },
    { key: 'paid', header: 'Paid', hideOnMobile: true, sortValue: (r) => r.paidAmount || 0, sum: true, sumFormat: 'money', render: (r) => <Money value={r.paidAmount} /> },
    { key: 'outstanding', header: 'Outstanding', sortValue: (r) => r2((r.grandTotal || 0) - (r.paidAmount || 0)), sum: true, sumFormat: 'money', render: (r) => <Money value={r2((r.grandTotal || 0) - (r.paidAmount || 0))} className={r2((r.grandTotal || 0) - (r.paidAmount || 0)) > 0 ? 'text-amber-600 font-medium' : 'text-emerald-600'} /> },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
    {
      key: 'actions', header: 'Actions',
      render: (r) => (
        <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="h-7" title="Print tax invoice"><Printer className="h-3.5 w-3.5" /></Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel className="text-xs">Paper size</DropdownMenuLabel>
              <DropdownMenuItem onSelect={() => void printInvoice(r, 'A4')}>A4</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void printInvoice(r, 'A5')}>A5</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="h-7" title="Print thermal receipt"><ReceiptText className="h-3.5 w-3.5" /></Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel className="text-xs">Receipt width</DropdownMenuLabel>
              {([58, 80] as const).map((w) => (
                <DropdownMenuItem key={w} onSelect={() => void printReceipt(r, w)}>
                  {w} mm ({w === 58 ? '2"' : '3"'}){receiptWidth === w ? ' ✓' : ''}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button variant="ghost" size="sm" className="h-7 text-green-600 hover:text-green-700" title="Send on WhatsApp" onClick={() => void shareInvoice(r)}><MessageCircle className="h-3.5 w-3.5" /></Button>
          <Button variant="ghost" size="sm" className="h-7" title="Email invoice" onClick={() => void emailInvoice(r)}><Mail className="h-3.5 w-3.5" /></Button>
          {r.status !== 'CANCELLED' && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="h-7" title="Share invoice link"><Share2 className="h-3.5 w-3.5" /></Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel className="text-xs">Share link{r.shareToken ? ' (active)' : ''}</DropdownMenuLabel>
                <DropdownMenuItem onSelect={() => void copyShareLink(r)}><Copy className="h-3.5 w-3.5 mr-2" />Copy link</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void whatsappShareLink(r)}><MessageCircle className="h-3.5 w-3.5 mr-2" />WhatsApp</DropdownMenuItem>
                {r.shareToken && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem className="text-red-600" onSelect={() => void revokeShareLink(r)}><Link2Off className="h-3.5 w-3.5 mr-2" />Revoke link</DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {!r.irn && r.status !== 'CANCELLED' && (
            <Button variant="ghost" size="sm" className="h-7" title="Generate IRN" onClick={() => void generateIrn(r)}><BadgeIndianRupee className="h-3.5 w-3.5" /></Button>
          )}
          {r.status !== 'PAID' && r.status !== 'CANCELLED' && (
            <Button variant="outline" size="sm" className="h-7" onClick={() => void openPay(r)}>Payment</Button>
          )}
          {canEdit(r) && (
            <Button variant="ghost" size="sm" className="h-7" title="Edit invoice" onClick={() => void openEdit(r)}><Pencil className="h-3.5 w-3.5" /></Button>
          )}
          {r.status !== 'CANCELLED' && (
            <Button variant="ghost" size="sm" className="h-7" title="Sales return / credit note" onClick={() => openCreate('sales-returns', { invoiceId: r.id })}><Undo2 className="h-3.5 w-3.5" /></Button>
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
        actions={<Button onClick={() => { resetForm(); setOpen(true) }}><Plus className="h-4 w-4 mr-1.5" />Invoice</Button>}
      />
      <DataTable columns={columns} rows={rows} loading={list.loading} searchPlaceholder="Search invoices…" highlightId={highlightId} moduleKey="sales-invoices" savedViewsKey={`${companyId}:sales-invoices`} sortable />

      <FormDialog
        open={open} onOpenChange={setOpen} wide
        title={editing ? `Edit Sales Invoice ${editing.number}` : 'Sales Invoice'} submitLabel={editing ? 'Save Changes' : 'Create Invoice'}
        description={editing
          ? `Same invoice number; totals are recomputed${isCashSale ? ' (cash sale)' : ''} and any stock it took is re-posted`
          : 'From a sales order (pending qty pre-filled) or manual lines'}
        loading={saving} onSubmit={submit}
      >
        {!editing && (
          <label className="flex items-center gap-2 text-sm font-medium w-fit cursor-pointer">
            <Checkbox checked={isCashSale} onCheckedChange={(v) => toggleCashSale(v === true)} />
            Cash Sale (walk-in)
            <span className="text-xs font-normal text-muted-foreground">— no customer needed, paid at the counter</span>
          </label>
        )}
        <div className="grid sm:grid-cols-3 gap-4">
          <Field label="Document type">
            <SelectInput
              value={docType}
              onChange={(v) => setDocType(v)}
              options={[
                { value: 'TAX_INVOICE', label: 'Tax Invoice' },
                { value: 'BILL_OF_SUPPLY', label: 'Bill of Supply (exempt)' },
                { value: 'PROFORMA', label: 'Proforma Invoice' },
              ]}
            />
          </Field>
          <Field label="Currency">
            <SelectInput
              value={currency}
              onChange={(v) => { setCurrency(v); setFxRate(defaultFxRate(v)) }}
              options={CURRENCIES.map((c) => ({ value: c.code, label: `${c.code} — ${c.name}` }))}
            />
          </Field>
          {currency === 'INR' ? (
            <Field label="Exchange rate">
              <TextInput value="1.00 (INR)" readOnly disabled />
            </Field>
          ) : (
            <Field label={`Exchange rate (1 ${currency} = ₹)`} required>
              <NumberInput value={fxRate} onChange={(e) => setFxRate(Number(e.target.value) || 0)} step="0.0001" />
            </Field>
          )}
          <label className="flex items-center gap-2 text-sm font-medium cursor-pointer sm:col-span-3">
            <Checkbox checked={reverseCharge} onCheckedChange={(v) => setReverseCharge(v === true)} />
            Reverse charge (Sec 9(3)/9(4))
            <span className="text-xs font-normal text-muted-foreground">— GST is payable by the recipient, not you</span>
          </label>
          {!isCashSale && !editing && (
            <Field label="Mode">
              <SelectInput
                value={mode} onChange={setMode}
                options={[{ value: 'SO', label: 'From Sales Order' }, { value: 'MANUAL', label: 'Manual Lines' }]}
              />
            </Field>
          )}
          {isCashSale ? null : mode === 'SO' ? (
            <Field label={challanNo ? `Sales Order · billing challan ${challanNo}` : 'Sales Order'} required>
              <SelectInput value={salesOrderId} onChange={(v) => void pickSo(v)} options={soOpts} placeholder="Select SO…" />
            </Field>
          ) : (
            <Field label="Customer" required>
              <SelectInput value={customerId} onChange={pickCustomer} options={customerOpts} />
            </Field>
          )}
          <Field label="Date" required><DateInput value={date} onChange={setDate} /></Field>
          <Field label="Due Date"><DateInput value={dueDate} onChange={setDueDate} /></Field>
          <Field label="Place of Supply"><TextInput value={placeOfSupply} onChange={(e) => setPlaceOfSupply(e.target.value)} placeholder="e.g. Maharashtra" /></Field>
          <Field label="Notes"><TextInput value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Remarks…" /></Field>
          <Field label="Customer PO No."><TextInput value={customerPoNo} onChange={(e) => setCustomerPoNo(e.target.value)} placeholder="Buyer's PO reference" /></Field>
          <Field label="Customer PO Date"><DateInput value={customerPoDate} onChange={setCustomerPoDate} /></Field>
          <Field label="Vehicle No"><TextInput value={vehicleNo} onChange={(e) => setVehicleNo(e.target.value)} placeholder="MH 12 AB 3456" /></Field>
          <Field label="Transporter"><TextInput value={transporter} onChange={(e) => setTransporter(e.target.value)} placeholder="Transporter name" /></Field>
          <Field label="Driver Phone"><TextInput value={driverPhone} onChange={(e) => setDriverPhone(e.target.value)} placeholder="98XXXXXXXX" inputMode="tel" /></Field>
          <Field label="Name on invoice (if different)"><TextInput value={billingName} onChange={(e) => setBillingName(e.target.value)} placeholder={isCashSale ? 'e.g. Ramesh Kumar' : 'Printed instead of the party name'} /></Field>
          <Field label="Shipping Address" className="sm:col-span-2">
            <Textarea value={shippingAddress} onChange={(e) => setShippingAddress(e.target.value)} rows={2} placeholder="Leave blank if same as billing address" />
          </Field>
        </div>

        {directSale && (
          <div className="flex flex-wrap items-center gap-3 rounded-md border bg-muted/20 px-3 py-2">
            <label className="flex items-center gap-2 text-sm font-medium cursor-pointer">
              <Checkbox checked={deductStock} onCheckedChange={(v) => setDeductStock(v === true)} />
              Deduct stock now (no delivery challan)
            </label>
            {deductStock && (
              <div className="w-full sm:w-64">
                <SelectInput value={effectiveWarehouseId} onChange={setStockWarehouseId} options={whOpts} placeholder="Warehouse…" />
              </div>
            )}
            <span className="text-[11px] text-muted-foreground">
              {deductStock ? 'Goods go out of this warehouse when the invoice is saved (services are skipped).' : 'Stock will not change — use a delivery challan to dispatch.'}
            </span>
          </div>
        )}

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Lines</span>
            <div className="flex items-center gap-2">
              <ScanToAdd items={(items.data?.items ?? []) as PickerItem[]} onScan={scanItem} className="w-40 sm:w-52" />
              <Button type="button" variant="outline" size="sm" onClick={() => setLines((ls) => [...ls, emptyLine()])}>
                <Plus className="h-3.5 w-3.5 mr-1" />Add Line
              </Button>
            </div>
          </div>
          <div className="hidden sm:grid grid-cols-12 gap-2 px-0.5 text-[11px] font-medium text-muted-foreground">
            <span className="col-span-4">Item</span><span className="col-span-2">Qty</span><span className="col-span-2">Rate (₹)</span><span className="col-span-1">Disc %</span><span className="col-span-1">GST %</span><span className="col-span-1">Cess %</span>
          </div>
          {lines.map((l, idx) => (
            <div key={idx} className="grid grid-cols-12 gap-2 items-end sm:items-center rounded-md border p-2 sm:border-0 sm:p-0">
              <div className="col-span-12 sm:col-span-4">
                <ItemPicker
                  items={(items.data?.items ?? []) as PickerItem[]}
                  value={l.itemId}
                  onChange={(v) => {
                    const it = (items.data?.items ?? []).find((o) => o.id === v)
                    if (it) pickLineItem(idx, it)
                  }}
                />
              </div>
              <div className="col-span-3 sm:col-span-2 grid gap-0.5">
                <span className="text-[10px] text-muted-foreground sm:hidden">Qty</span>
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
              <label className="col-span-3 sm:col-span-2 grid gap-0.5">
                <span className="text-[10px] text-muted-foreground sm:hidden">Rate</span>
                <NumberInput value={l.rate} min={0} placeholder="Rate"
                  onChange={(n) => setLines((ls) => ls.map((x, i) => (i === idx ? { ...x, rate: n } : x)))} />
                {lastHints[l.itemId]
                  ? <span className="text-[10px] leading-tight text-muted-foreground truncate" title={lastHints[l.itemId]}>{lastHints[l.itemId]}</span>
                  : inclGstHint(itemRow(l.itemId), l.unit) && <span className="text-[10px] leading-tight text-muted-foreground truncate">{inclGstHint(itemRow(l.itemId), l.unit)}</span>}
                {!!itemRow(l.itemId)?.mrp && <span className="text-[10px] leading-tight text-muted-foreground truncate">MRP ₹{itemRow(l.itemId)?.mrp}</span>}
              </label>
              <label className="col-span-2 sm:col-span-1 grid gap-0.5">
                <span className="text-[10px] text-muted-foreground sm:hidden">Disc %</span>
                <NumberInput value={l.discountPct} min={0} placeholder="Disc %"
                  onChange={(n) => setLines((ls) => ls.map((x, i) => (i === idx ? { ...x, discountPct: n } : x)))} />
              </label>
              <label className="col-span-2 sm:col-span-1 grid gap-0.5">
                <span className="text-[10px] text-muted-foreground sm:hidden">GST %</span>
                <NumberInput value={l.gstRate} min={0} placeholder="GST %"
                  onChange={(n) => setLines((ls) => ls.map((x, i) => (i === idx ? { ...x, gstRate: n } : x)))} />
              </label>
              <label className="col-span-2 sm:col-span-1 grid gap-0.5">
                <span className="text-[10px] text-muted-foreground sm:hidden">Cess %</span>
                <NumberInput value={l.cessRate} min={0} placeholder="Cess %"
                  onChange={(n) => setLines((ls) => ls.map((x, i) => (i === idx ? { ...x, cessRate: n } : x)))} />
              </label>
              <div className="col-span-12 sm:col-span-1 flex justify-end">
                <Button type="button" variant="ghost" size="sm" disabled={lines.length <= 1}
                  onClick={() => setLines((ls) => ls.filter((_, i) => i !== idx))}>
                  <Trash2 className="h-3.5 w-3.5 text-red-600" />
                </Button>
              </div>
              {directSale && deductStock && l.itemId && (itemFlag(l.itemId).batchTracked || itemFlag(l.itemId).trackSerial) && (
                <div className="col-span-12 grid sm:grid-cols-2 gap-2 pl-2 border-l-2 border-muted">
                  {itemFlag(l.itemId).batchTracked && (
                    <div>
                      <span className="text-[10px] text-muted-foreground uppercase">Batch</span>
                      <LineBatchPick companyId={companyId} itemId={l.itemId} warehouseId={effectiveWarehouseId} value={l.batchNo || ''}
                        onChange={(v) => setLines((ls) => ls.map((x, i) => (i === idx ? { ...x, batchNo: v } : x)))} />
                    </div>
                  )}
                  {itemFlag(l.itemId).trackSerial && (
                    <div className={itemFlag(l.itemId).batchTracked ? '' : 'sm:col-span-2'}>
                      <LineSerialPick companyId={companyId} itemId={l.itemId} warehouseId={effectiveWarehouseId} qty={toBaseQty(l.qty, l.unit, itemRow(l.itemId))} value={l.serials || ''}
                        onChange={(v) => setLines((ls) => ls.map((x, i) => (i === idx ? { ...x, serials: v } : x)))} />
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
          <div className="space-y-1.5 pt-1">
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Discount &amp; charges</span>
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
              <label className="grid gap-0.5"><span className="text-[11px] text-muted-foreground">Bill discount (₹)</span>
                <NumberInput value={billDiscount} min={0} onChange={setBillDiscount} /></label>
              <label className="grid gap-0.5"><span className="text-[11px] text-muted-foreground">Freight (₹)</span>
                <NumberInput value={freightCharge} min={0} onChange={setFreightCharge} /></label>
              <label className="grid gap-0.5"><span className="text-[11px] text-muted-foreground">Freight GST %</span>
                <NumberInput value={freightGstRate} min={0} onChange={setFreightGstRate} /></label>
              <label className="grid gap-0.5"><span className="text-[11px] text-muted-foreground">Packing (₹)</span>
                <NumberInput value={packingCharge} min={0} onChange={setPackingCharge} /></label>
              <label className="grid gap-0.5"><span className="text-[11px] text-muted-foreground">Packing GST %</span>
                <NumberInput value={packingGstRate} min={0} onChange={setPackingGstRate} /></label>
            </div>
          </div>
          <div className="grid sm:grid-cols-5 gap-3 pt-1">
            {editing ? <div className="sm:col-span-2" /> : (
            <div className="sm:col-span-2 grid grid-cols-2 gap-2 content-start">
              <label className="grid gap-0.5"><span className="text-[11px] text-muted-foreground">Received now (₹)</span>
                <NumberInput value={receivedAmount} min={0} onChange={setReceivedAmount} placeholder={isCashSale ? 'Full amount' : '0'} /></label>
              <label className="grid gap-0.5"><span className="text-[11px] text-muted-foreground">Mode</span>
                <SelectInput value={receivedMode} onChange={(m) => { setReceivedMode(m); setReceivedAccountId('') }} options={PAYMENT_MODES.map((m) => ({ value: m, label: m }))} /></label>
              {receivedMode === 'CHEQUE' && (
                <>
                  <label className="grid gap-0.5"><span className="text-[11px] text-muted-foreground">Cheque no.</span>
                    <TextInput value={receivedChequeNo} onChange={(e) => setReceivedChequeNo(e.target.value)} /></label>
                  <label className="grid gap-0.5"><span className="text-[11px] text-muted-foreground">Cheque date</span>
                    <DateInput value={receivedChequeDate} onChange={setReceivedChequeDate} /></label>
                  {receivedChequeDate > today() && (
                    <p className="col-span-2 text-[11px] text-amber-700 dark:text-amber-400">Post-dated cheque — the invoice is settled now; the money counts in the account once the cheque is cleared.</p>
                  )}
                </>
              )}
              {accounts.length > 0 && (
                <label className="col-span-2 grid gap-0.5"><span className="text-[11px] text-muted-foreground">Into account</span>
                  <SelectInput value={effectiveAccountId} onChange={setReceivedAccountId} options={accountOpts} placeholder={`No ${forMode.type === 'BANK' ? 'bank' : 'cash'} account`} /></label>
              )}
              {accounts.length > 0 && !forMode.matching.length && (
                <p className="col-span-2 text-[11px] text-red-600">No {forMode.type === 'BANK' ? 'bank' : 'cash'} account — add one in Cash & Bank to record {receivedMode} receipts.</p>
              )}
              <p className="col-span-2 text-[11px] text-muted-foreground">
                {isCashSale && receivedAmount <= 0
                  ? `Full bill ${fmtMoney(totals.grand)} will be recorded as received.`
                  : receivedAmount > 0 ? `Balance after receipt: ${fmtMoney(Math.max(0, r2(totals.grand - receivedAmount)))}` : 'Leave 0 to bill on credit.'}
              </p>
            </div>
            )}
            <div className="sm:col-span-3 rounded-md border bg-muted/30 p-3 text-sm space-y-0.5">
              <TotRow label="Subtotal" value={totals.subtotal} />
              {totals.discount > 0 && <TotRow label="Discount" value={-totals.discount} />}
              {totals.freight > 0 && <TotRow label={`Freight (GST ${freightGstRate}%)`} value={totals.freight} />}
              {totals.packing > 0 && <TotRow label={`Packing (GST ${packingGstRate}%)`} value={totals.packing} />}
              {interStatePreview
                ? <TotRow label="IGST" value={totals.igst} />
                : <><TotRow label="CGST" value={totals.cgst} /><TotRow label="SGST" value={totals.sgst} /></>}
              {totals.cess > 0 && <TotRow label="Cess" value={totals.cess} />}
              {Math.abs(totals.roundOff) >= 0.005 && <TotRow label="Round off" value={totals.roundOff} />}
              <div className="border-t pt-1 mt-1"><TotRow label="Grand Total" value={totals.grand} bold /></div>
            </div>
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

function TotRow({ label, value, bold }: { label: string; value: number; bold?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className={bold ? 'font-semibold' : 'text-muted-foreground'}>{label}</span>
      <span className={`tabular-nums ${bold ? 'font-bold text-base' : 'font-medium'}`}>{value < 0 ? `- ${fmtMoney(-value)}` : fmtMoney(value)}</span>
    </div>
  )
}
