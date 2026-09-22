'use client'

import * as React from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Mail, MessageCircle, Pencil, Plus, Printer, Trash2 } from 'lucide-react'
import {
  Column, ConfirmAction, DataTable, DateCell, DateInput, Field, FormDialog, Money,
  NumberInput, PageHeader, SelectInput, StatusBadge, TextInput, printHtml,
} from '@/components/erp/kit'
import { apiDelete, apiGet, apiPatch, apiPost, useList } from '@/lib/use-api'
import { fmtDate, fmtMoney } from '@/lib/erp-constants'

interface PartyRow { id: string; name?: string | null; code?: string | null }
interface ItemRow { id: string; code?: string | null; name?: string | null; sellingPrice?: number | null; gstRate?: number | null }
interface QtItem { id: string; itemId: string; qty: number; rate: number; discountPct: number; gstRate: number; lineTotal: number; item?: { code?: string | null; name?: string | null; uom?: string | null } | null }
interface QuotationRow {
  id: string; number: string; enquiryId?: string | null; customerId?: string | null; date: string; validUntil?: string | null
  status: string; subtotal: number; discountTotal: number; cgst: number; sgst: number; igst: number
  grandTotal: number; notes?: string | null
  customer?: { name?: string | null; city?: string | null; state?: string | null; gstin?: string | null; phone?: string | null; email?: string | null } | null
  items?: QtItem[] | null
}
interface CompanyInfo { name?: string | null }
interface DraftLine { itemId: string; qty: number; rate: number; discountPct: number; gstRate: number }

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

// Build a wa.me deep link: 10-digit numbers get the '91' prefix, already-prefixed
// 12-digit numbers pass through, anything else (or no phone) opens WhatsApp's chat chooser.
function waUrl(phone: string | null | undefined, message: string): string {
  const digits = (phone || '').replace(/\D/g, '')
  const valid = digits.length === 10 || (digits.length === 12 && digits.startsWith('91'))
  return `https://wa.me/${valid ? digits : ''}?text=${encodeURIComponent(message)}`
}

// Build a mailto: deep link — a missing recipient opens the user's mail app with a blank To: field.
function mailtoUrl(email: string | null | undefined, subject: string, body: string): string {
  return `mailto:${email || ''}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
}

// Share text for both the WhatsApp and email actions on a quotation.
function quotationMessage(q: QuotationRow, company?: CompanyInfo): string {
  const customerName = q.customer?.name || 'Customer'
  return `Namaste ${customerName},\n\nQuotation ${q.number} dated ${fmtDate(q.date)} — Amount ${fmtMoney(q.grandTotal)}${q.validUntil ? `\nValid till: ${fmtDate(q.validUntil)}` : ''}\n\nThank you,\n${company?.name || 'Sales'}`
}

export default function QuotationsModule({ companyId }: { companyId: string }) {
  const list = useList<{ items: QuotationRow[] }>(`/api/quotations?companyId=${companyId}`)
  const customers = useList<{ items: PartyRow[] }>(`/api/customers?companyId=${companyId}`)
  const items = useList<{ items: ItemRow[] }>(`/api/items?companyId=${companyId}`)
  const enquiries = useList<{ items: { id: string; number: string }[] }>(`/api/enquiries?companyId=${companyId}`)

  const [open, setOpen] = React.useState(false)
  const [editId, setEditId] = React.useState<string | null>(null)
  const [saving, setSaving] = React.useState(false)
  const [customerId, setCustomerId] = React.useState('')
  const [enquiryId, setEnquiryId] = React.useState('')
  const [date, setDate] = React.useState(today)
  const [validUntil, setValidUntil] = React.useState('')
  const [notes, setNotes] = React.useState('')
  const [lines, setLines] = React.useState<DraftLine[]>([emptyLine()])

  const rows = list.data?.items ?? []
  const customerOpts = (customers.data?.items ?? []).map((c) => ({ value: c.id, label: c.name || c.id }))
  const itemOpts = (items.data?.items ?? []).map((i) => ({ value: i.id, label: i.code && i.name ? `${i.code} — ${i.name}` : i.name || i.id }))
  const enquiryOpts = (enquiries.data?.items ?? []).filter((e) => e.number).map((e) => ({ value: e.id, label: e.number }))

  function resetForm() {
    setEditId(null); setCustomerId(''); setEnquiryId(''); setDate(today()); setValidUntil(''); setNotes('')
    setLines([emptyLine()])
  }

  function openCreate() { resetForm(); setOpen(true) }

  async function openEdit(q: QuotationRow) {
    setSaving(true)
    try {
      const detail = await apiGet<QuotationRow>(`/api/quotations/${q.id}?companyId=${companyId}`)
      setEditId(q.id); setCustomerId(detail.customerId || '')
      setEnquiryId(detail.enquiryId || ''); setDate((detail.date || today()).slice(0, 10))
      setValidUntil(detail.validUntil ? detail.validUntil.slice(0, 10) : '')
      setNotes(detail.notes || '')
      setLines((detail.items ?? []).map((it) => ({ itemId: it.itemId, qty: it.qty, rate: it.rate, discountPct: it.discountPct, gstRate: it.gstRate })))
      if (!(detail.items ?? []).length) setLines([emptyLine()])
      setOpen(true)
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to load quotation') } finally { setSaving(false) }
  }

  async function submit() {
    if (!customerId) { toast.error('Select a customer'); return }
    const valid = lines.filter((l) => l.itemId && l.qty > 0)
    if (!valid.length) { toast.error('Add at least one line with item and qty'); return }
    setSaving(true)
    try {
      if (editId) {
        await apiPatch(`/api/quotations/${editId}`, { companyId, customerId, date, validUntil: validUntil || undefined, notes: notes || undefined, items: valid })
        toast.success('Quotation updated')
      } else {
        await apiPost('/api/quotations', { companyId, customerId, enquiryId: enquiryId || undefined, date, validUntil: validUntil || undefined, notes: notes || undefined, items: valid })
        toast.success('Quotation created')
      }
      setOpen(false); resetForm(); void list.refetch()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to save quotation') } finally { setSaving(false) }
  }

  async function setStatus(row: QuotationRow, status: string) {
    try {
      await apiPatch(`/api/quotations/${row.id}`, { status, companyId })
      toast.success(`Quotation ${row.number} → ${status}`)
      void list.refetch()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to update status') }
  }

  async function remove(row: QuotationRow) {
    try {
      await apiDelete(`/api/quotations/${row.id}?companyId=${companyId}`)
      toast.success('Quotation deleted'); void list.refetch()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to delete') }
  }

  async function shareQuotation(row: QuotationRow) {
    // Company profile is only needed for the signature — best-effort fetch.
    let company: CompanyInfo | undefined
    try {
      company = await apiGet<CompanyInfo>(`/api/settings?companyId=${companyId}`)
    } catch { /* signature falls back to 'Sales' without the profile */ }
    const message = quotationMessage(row, company)
    if (!row.customer?.phone) toast.info('No phone saved for this customer — choose a chat in WhatsApp')
    window.open(waUrl(row.customer?.phone, message), '_blank', 'noopener,noreferrer')
  }

  async function emailQuotation(row: QuotationRow) {
    // Company profile is only needed for the subject sign-off — best-effort fetch.
    let company: CompanyInfo | undefined
    try {
      company = await apiGet<CompanyInfo>(`/api/settings?companyId=${companyId}`)
    } catch { /* subject falls back to the generic name without the profile */ }
    const subject = `Quotation ${row.number} — ${company?.name || 'Quotation'}`
    if (!row.customer?.email) toast.info('No email saved for this customer — your mail app will open with a blank recipient')
    window.location.href = mailtoUrl(row.customer?.email, subject, quotationMessage(row, company))
  }

  function printQuotation(q: QuotationRow) {
    const items2 = q.items ?? []
    const body = `
      <div class="head">
        <div><h1>Acme Precision Manufacturing Pvt Ltd</h1>
          <div class="muted">Quotation · ${q.number}</div></div>
        <div style="text-align:right"><span class="badge">${q.status}</span><br/>
          <div class="muted">Date: ${new Date(q.date).toLocaleDateString('en-IN')}</div>
          ${q.validUntil ? `<div class="muted">Valid until: ${new Date(q.validUntil).toLocaleDateString('en-IN')}</div>` : ''}</div>
      </div>
      <p><strong>To:</strong> ${q.customer?.name || '—'}${q.customer?.gstin ? ` · GSTIN ${q.customer.gstin}` : ''}
      ${q.customer?.city ? `<br/><span class="muted">${q.customer.city}${q.customer.state ? ', ' + q.customer.state : ''}</span>` : ''}</p>
      <table>
        <thead><tr><th>#</th><th>Item</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">Disc %</th><th class="num">GST %</th><th class="num">Amount</th></tr></thead>
        <tbody>
          ${items2.map((it, i) => `<tr><td>${i + 1}</td><td>${it.item?.name || it.itemId}</td><td class="num">${it.qty}</td><td class="num">${fmtMoney(it.rate)}</td><td class="num">${it.discountPct}%</td><td class="num">${it.gstRate}%</td><td class="num">${fmtMoney(it.lineTotal)}</td></tr>`).join('')}
        </tbody>
      </table>
      <table class="totals" style="width:280px;margin-left:auto">
        <tr><td>Subtotal</td><td class="num">${fmtMoney(q.subtotal)}</td></tr>
        <tr><td>Discount</td><td class="num">- ${fmtMoney(q.discountTotal)}</td></tr>
        <tr><td>CGST</td><td class="num">${fmtMoney(q.cgst)}</td></tr>
        <tr><td>SGST</td><td class="num">${fmtMoney(q.sgst)}</td></tr>
        ${q.igst ? `<tr><td>IGST</td><td class="num">${fmtMoney(q.igst)}</td></tr>` : ''}
        <tr class="grand"><td>Grand Total</td><td class="num">${fmtMoney(q.grandTotal)}</td></tr>
      </table>
      ${q.notes ? `<p class="muted">Notes: ${q.notes}</p>` : ''}
      <p class="muted">This is a computer generated quotation. Prices valid as per validity date above.</p>`
    printHtml(`Quotation ${q.number}`, body)
  }

  const totals = computeTotals(lines)

  const columns: Column<QuotationRow>[] = [
    { key: 'number', header: 'Quotation #', render: (r) => <span className="font-medium">{r.number}</span> },
    { key: 'date', header: 'Date', render: (r) => <DateCell value={r.date} /> },
    { key: 'customer', header: 'Customer', render: (r) => r.customer?.name || '—' },
    { key: 'total', header: 'Grand Total', render: (r) => <Money value={r.grandTotal} className="font-medium" /> },
    { key: 'valid', header: 'Valid Until', hideOnMobile: true, render: (r) => <DateCell value={r.validUntil} /> },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
    {
      key: 'status-action', header: 'Move To', hideOnMobile: true,
      render: (r) => nextStatuses(r.status).length ? (
        <div onClick={(e) => e.stopPropagation()} className="w-32">
          <SelectInput value="" placeholder="Change…" onChange={(v) => void setStatus(r, v)} options={nextStatuses(r.status).map((s) => ({ value: s, label: s }))} />
        </div>
      ) : <span className="text-xs text-muted-foreground">—</span>,
    },
    {
      key: 'actions', header: 'Actions',
      render: (r) => (
        <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
          <Button variant="ghost" size="sm" className="h-7" onClick={() => printQuotation(r)} title="Print"><Printer className="h-3.5 w-3.5" /></Button>
          <Button variant="ghost" size="sm" className="h-7 text-green-600 hover:text-green-700" title="Send on WhatsApp" onClick={() => void shareQuotation(r)}><MessageCircle className="h-3.5 w-3.5" /></Button>
          <Button variant="ghost" size="sm" className="h-7" title="Email quotation" onClick={() => void emailQuotation(r)}><Mail className="h-3.5 w-3.5" /></Button>
          {r.status === 'DRAFT' && (
            <>
              <Button variant="ghost" size="sm" className="h-7" onClick={() => void openEdit(r)} title="Edit"><Pencil className="h-3.5 w-3.5" /></Button>
              <ConfirmAction
                trigger={<Button variant="ghost" size="sm" className="h-7 text-red-600"><Trash2 className="h-3.5 w-3.5" /></Button>}
                title="Delete quotation?" message={`Delete draft quotation ${r.number}?`} tone="destructive" onConfirm={() => remove(r)}
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
        title="Quotations"
        description="Prepare, send and approve price quotations"
        actions={<Button onClick={openCreate}><Plus className="h-4 w-4 mr-1.5" />New Quotation</Button>}
      />
      <DataTable columns={columns} rows={rows} loading={list.loading || saving} searchPlaceholder="Search quotations…" />

      <FormDialog
        open={open} onOpenChange={setOpen} wide
        title={editId ? 'Edit Quotation (Draft)' : 'New Quotation'}
        submitLabel={editId ? 'Save Changes' : 'Create Quotation'}
        description="CGST + SGST split shown is a client-side preview" loading={saving} onSubmit={submit}
      >
        <div className="grid sm:grid-cols-3 gap-4">
          <Field label="Customer" required><SelectInput value={customerId} onChange={setCustomerId} options={customerOpts} /></Field>
          <Field label="From Enquiry (optional)">
            <SelectInput value={enquiryId} onChange={setEnquiryId} options={[{ value: '', label: '— None —' }, ...enquiryOpts]} />
          </Field>
          <Field label="Date" required><DateInput value={date} onChange={setDate} /></Field>
          <Field label="Valid Until"><DateInput value={validUntil} onChange={setValidUntil} /></Field>
          <Field label="Notes" className="sm:col-span-2"><TextInput value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Terms / remarks…" /></Field>
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
            <TotalCell label="Subtotal" value={totals.subtotal} />
            <TotalCell label="Discount" value={totals.discount} />
            <TotalCell label="CGST (preview)" value={totals.cgst} />
            <TotalCell label="SGST (preview)" value={totals.sgst} />
            <TotalCell label="Grand Total" value={totals.grand} bold />
          </div>
        </div>
      </FormDialog>
    </div>
  )
}

function emptyLine(): DraftLine { return { itemId: '', qty: 1, rate: 0, discountPct: 0, gstRate: 18 } }

function nextStatuses(status: string): string[] {
  if (status === 'DRAFT') return ['SENT']
  if (status === 'SENT') return ['APPROVED', 'REJECTED']
  return []
}

function TotalCell({ label, value, bold }: { label: string; value: number; bold?: boolean }) {
  return (
    <div className={bold ? 'sm:text-right' : ''}>
      <p className="text-[11px] text-muted-foreground uppercase tracking-wide">{label}</p>
      <p className={`tabular-nums ${bold ? 'font-bold text-base' : 'font-medium'}`}>{fmtMoney(value)}</p>
    </div>
  )
}
