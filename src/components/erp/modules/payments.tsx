'use client'

import * as React from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Plus, Trash2 } from 'lucide-react'
import {
  Column, ConfirmAction, DataTable, DateCell, DateInput, Field, FormDialog, Money,
  NumberInput, PageHeader, SelectInput, TextInput,
} from '@/components/erp/kit'
import { apiDelete, apiPost, useList } from '@/lib/use-api'
import { PAYMENT_MODES } from '@/lib/erp-constants'

interface PaymentRow {
  id: string; number: string; date: string; type: string; partyType: string
  amount: number; mode: string; reference?: string | null; notes?: string | null
  customer?: { name?: string | null } | null
  supplier?: { name?: string | null } | null
  invoiceNumber?: string | null
  invoice?: { number?: string | null } | null
}
interface PartyRow { id: string; name?: string | null; code?: string | null }
interface DocInvoiceRow {
  id: string; number: string; status: string; grandTotal: number; paidAmount: number
  customerId?: string | null; supplierId?: string | null
}

const today = () => new Date().toISOString().slice(0, 10)
const r2 = (n: number) => Math.round(n * 100) / 100

export default function PaymentsModule({ companyId }: { companyId: string }) {
  const [typeFilter, setTypeFilter] = React.useState('')
  const list = useList<{ items: PaymentRow[] }>(
    `/api/payments?companyId=${companyId}${typeFilter ? `&type=${typeFilter}` : ''}`,
  )
  const customers = useList<{ items: PartyRow[] }>(`/api/customers?companyId=${companyId}`)
  const suppliers = useList<{ items: PartyRow[] }>(`/api/suppliers?companyId=${companyId}`)
  const salesInvoices = useList<{ items: DocInvoiceRow[] }>(`/api/sales-invoices?companyId=${companyId}`)
  const purchaseInvoices = useList<{ items: DocInvoiceRow[] }>(`/api/purchase-invoices?companyId=${companyId}`)

  const [open, setOpen] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [type, setType] = React.useState('RECEIPT')
  const [partyId, setPartyId] = React.useState('')
  const [invoiceId, setInvoiceId] = React.useState('')
  const [amount, setAmount] = React.useState(0)
  const [mode, setMode] = React.useState('NEFT')
  const [date, setDate] = React.useState(today)
  const [reference, setReference] = React.useState('')
  const [notes, setNotes] = React.useState('')

  const rows = list.data?.items ?? []

  const partyOpts: { value: string; label: string }[] = React.useMemo(() => {
    const src = type === 'RECEIPT' ? (customers.data?.items ?? []) : (suppliers.data?.items ?? [])
    return src.map((p) => ({ value: p.id, label: p.name || p.code || p.id }))
  }, [type, customers.data, suppliers.data])

  const invoiceOpts = React.useMemo(() => {
    const src = type === 'RECEIPT' ? (salesInvoices.data?.items ?? []) : (purchaseInvoices.data?.items ?? [])
    const partyKey = type === 'RECEIPT' ? 'customerId' : 'supplierId'
    return src
      .filter((inv) => inv.status !== 'PAID' && inv.status !== 'CANCELLED')
      .filter((inv) => !partyId || (inv as unknown as Record<string, unknown>)[partyKey] === partyId)
      .map((inv) => ({
        value: inv.id,
        label: `${inv.number} — outstanding ₹${((inv.grandTotal || 0) - (inv.paidAmount || 0)).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`,
        outstanding: r2((inv.grandTotal || 0) - (inv.paidAmount || 0)),
      }))
  }, [type, partyId, salesInvoices.data, purchaseInvoices.data])

  function resetForm() {
    setType('RECEIPT'); setPartyId(''); setInvoiceId(''); setAmount(0); setMode('NEFT'); setDate(today()); setReference(''); setNotes('')
  }

  function pickInvoice(id: string) {
    setInvoiceId(id)
    const found = invoiceOpts.find((o) => o.value === id)
    setAmount(found ? found.outstanding : 0)
  }

  async function submit() {
    if (!partyId) { toast.error('Select a party'); return }
    if (amount <= 0) { toast.error('Enter a valid amount'); return }
    setSaving(true)
    try {
      await apiPost('/api/payments', {
        companyId, type, partyType: type === 'RECEIPT' ? 'CUSTOMER' : 'SUPPLIER',
        customerId: type === 'RECEIPT' ? partyId : undefined,
        supplierId: type === 'PAYMENT' ? partyId : undefined,
        invoiceType: invoiceId ? (type === 'RECEIPT' ? 'SALES' : 'PURCHASE') : undefined,
        invoiceId: invoiceId || undefined,
        amount, mode, date, reference: reference || undefined, notes: notes || undefined,
        userName: type === 'RECEIPT' ? 'Sales User' : 'Purchase User',
      })
      toast.success('Payment recorded')
      setOpen(false); resetForm(); void list.refetch()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to record payment') } finally { setSaving(false) }
  }

  async function remove(row: PaymentRow) {
    try {
      await apiDelete(`/api/payments/${row.id}?companyId=${companyId}`)
      toast.success('Payment voided'); void list.refetch()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to delete') }
  }

  const columns: Column<PaymentRow>[] = [
    { key: 'number', header: 'Payment #', render: (r) => <span className="font-medium">{r.number}</span> },
    { key: 'date', header: 'Date', render: (r) => <DateCell value={r.date} /> },
    {
      key: 'type', header: 'Type',
      render: (r) => (
        <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap ${r.type === 'RECEIPT' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300' : 'bg-orange-100 text-orange-700 dark:bg-orange-950 dark:text-orange-300'}`}>
          {r.type}
        </span>
      ),
    },
    { key: 'party', header: 'Party', render: (r) => r.customer?.name || r.supplier?.name || '—' },
    { key: 'invoice', header: 'Invoice', hideOnMobile: true, render: (r) => r.invoiceNumber || r.invoice?.number || '—' },
    { key: 'amount', header: 'Amount', render: (r) => <Money value={r.amount} className="font-medium" /> },
    { key: 'mode', header: 'Mode', hideOnMobile: true, render: (r) => r.mode || '—' },
    { key: 'reference', header: 'Reference', hideOnMobile: true, render: (r) => r.reference || '—' },
    {
      key: 'actions', header: 'Actions',
      render: (r) => (
        <div onClick={(e) => e.stopPropagation()}>
          <ConfirmAction
            trigger={<Button variant="ghost" size="sm" className="h-7 text-red-600"><Trash2 className="h-3.5 w-3.5" /></Button>}
            title="Void payment?" message={`Void payment ${r.number} of ${r.amount}? Linked invoice balances will be updated.`}
            tone="destructive" onConfirm={() => remove(r)}
          />
        </div>
      ),
    },
  ]

  return (
    <div>
      <PageHeader
        title="Payments"
        description="Customer receipts and supplier payments"
        actions={
          <div className="flex items-center gap-2">
            <div className="w-40">
              <SelectInput
                value={typeFilter} onChange={setTypeFilter} placeholder="All types"
                options={[
                  { value: '', label: 'All types' },
                  { value: 'RECEIPT', label: 'Receipts' },
                  { value: 'PAYMENT', label: 'Payments' },
                ]}
              />
            </div>
            <Button onClick={() => { resetForm(); setOpen(true) }}><Plus className="h-4 w-4 mr-1.5" />New Payment</Button>
          </div>
        }
      />
      <DataTable columns={columns} rows={rows} loading={list.loading} searchPlaceholder="Search payments…" />

      <FormDialog
        open={open} onOpenChange={setOpen} title="Record Payment" submitLabel="Save Payment"
        description="Receipts reduce customer outstanding; payments reduce supplier outstanding"
        loading={saving} onSubmit={submit}
      >
        <div className="grid sm:grid-cols-2 gap-4">
          <Field label="Type" required>
            <SelectInput
              value={type} onChange={(v) => { setType(v); setPartyId(''); setInvoiceId(''); setAmount(0) }}
              options={[{ value: 'RECEIPT', label: 'Receipt (from customer)' }, { value: 'PAYMENT', label: 'Payment (to supplier)' }]}
            />
          </Field>
          <Field label="Party" required>
            <SelectInput
              value={partyId} onChange={(v) => { setPartyId(v); setInvoiceId('') }}
              options={partyOpts} placeholder={type === 'RECEIPT' ? 'Select customer…' : 'Select supplier…'}
            />
          </Field>
          <Field label="Against Invoice (optional)" className="sm:col-span-2">
            <SelectInput
              value={invoiceId} onChange={pickInvoice}
              options={[{ value: '', label: '— Advance / on account —' }, ...invoiceOpts]}
              placeholder={invoiceOpts.length ? 'Select open invoice…' : 'No open invoices for this party'}
            />
          </Field>
          <Field label="Amount" required><NumberInput value={amount} onChange={setAmount} min={0} /></Field>
          <Field label="Mode"><SelectInput value={mode} onChange={setMode} options={PAYMENT_MODES.map((m) => ({ value: m, label: m }))} /></Field>
          <Field label="Date" required><DateInput value={date} onChange={setDate} /></Field>
          <Field label="Reference"><TextInput value={reference} onChange={(e) => setReference(e.target.value)} placeholder="UTR / cheque no." /></Field>
          <Field label="Notes" className="sm:col-span-2"><TextInput value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Remarks…" /></Field>
        </div>
      </FormDialog>
    </div>
  )
}
