'use client'

import * as React from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { MoreHorizontal, Plus, Trash2 } from 'lucide-react'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import {
  Column, ConfirmAction, DataTable, DateCell, DateInput, Field, FormDialog, Money,
  NumberInput, PageHeader, SelectInput, TextInput, useCreatePreset
} from '@/components/erp/kit'
import { apiDelete, apiPatch, apiPost, useList } from '@/lib/use-api'
import { PAYMENT_MODES } from '@/lib/erp-constants'

interface PaymentRow {
  id: string; number: string; date: string; type: string; partyType: string
  amount: number; mode: string; reference?: string | null; notes?: string | null
  customer?: { name?: string | null } | null
  supplier?: { name?: string | null } | null
  invoiceNumber?: string | null
  invoice?: { number?: string | null } | null
  accountId?: string | null; accountName?: string | null
  chequeNo?: string | null; chequeDate?: string | null; chequeStatus?: string | null; clearedDate?: string | null
}
interface AccountOpt { id: string; name: string; type: string; active: boolean }
interface PartyRow { id: string; name?: string | null; code?: string | null }
interface DocInvoiceRow {
  id: string; number: string; status: string; grandTotal: number; paidAmount: number
  customerId?: string | null; supplierId?: string | null
}

const today = () => new Date().toISOString().slice(0, 10)
const r2 = (n: number) => Math.round(n * 100) / 100
// Adjustments posted by sales / purchase returns — voided only by cancelling the note
const NOTE_MODES: Record<string, string> = { CREDIT_NOTE: 'Credit Note', DEBIT_NOTE: 'Debit Note' }
const CHEQUE_TONE: Record<string, string> = {
  PENDING: 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300',
  DEPOSITED: 'bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300',
  CLEARED: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300',
  BOUNCED: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300',
}
const CHEQUE_LABEL: Record<string, string> = { PENDING: 'Post-dated', DEPOSITED: 'Deposited', CLEARED: 'Cleared', BOUNCED: 'Bounced' }

function ChequeBadge({ status }: { status?: string | null }) {
  if (!status) return null
  return <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap ${CHEQUE_TONE[status] || 'bg-muted text-muted-foreground'}`}>{CHEQUE_LABEL[status] || status}</span>
}

export default function PaymentsModule({ companyId }: { companyId: string }) {
  const [typeFilter, setTypeFilter] = React.useState('')
  const [chequeFilter, setChequeFilter] = React.useState('')
  const list = useList<{ items: PaymentRow[] }>(
    `/api/payments?companyId=${companyId}${typeFilter ? `&type=${typeFilter}` : ''}${chequeFilter ? `&cheques=${chequeFilter}` : ''}`,
  )
  const accounts = useList<{ items: AccountOpt[] }>(`/api/accounts?companyId=${companyId}`)
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
  const [accountId, setAccountId] = React.useState('') // '' = default account for the mode
  const [chequeNo, setChequeNo] = React.useState('')
  const [chequeDate, setChequeDate] = React.useState('')
  const [chequeAction, setChequeAction] = React.useState<{ row: PaymentRow; action: 'deposit' | 'clear' | 'bounce' } | null>(null)
  const [actionDate, setActionDate] = React.useState(today)
  const [acting, setActing] = React.useState(false)

  const accountOpts = React.useMemo(() => [
    { value: '', label: 'Default for mode' },
    ...(accounts.data?.items ?? []).filter((a) => a.active).map((a) => ({ value: a.id, label: `${a.name}${a.type === 'CASH' ? ' (cash)' : ''}` })),
  ], [accounts.data])

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
    setAccountId(''); setChequeNo(''); setChequeDate('')
  }

  // Shortcuts from other screens (party view, row actions, quick actions) open this form pre-filled
  useCreatePreset('payments', (d) => {
    resetForm()
    if (d.type === 'RECEIPT' || d.type === 'PAYMENT') setType(String(d.type))
    if (d.partyId) setPartyId(String(d.partyId))
    if (d.invoiceId) { setInvoiceId(String(d.invoiceId)); setAmount(Number(d.amount) || 0) }
    setOpen(true)
  })

  // Header buttons share the preset path: blank form with the direction preselected
  function startCreate(t: 'RECEIPT' | 'PAYMENT') {
    resetForm(); setType(t); setOpen(true)
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
        accountId: accountId || undefined,
        ...(mode === 'CHEQUE' ? { chequeNo: chequeNo || undefined, chequeDate: chequeDate || undefined } : {}),
        userName: type === 'RECEIPT' ? 'Sales User' : 'Purchase User',
      })
      toast.success(mode === 'CHEQUE' && chequeDate > today() ? 'Post-dated cheque recorded — counts in the bank once cleared' : 'Payment recorded')
      setOpen(false); resetForm(); void list.refetch()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to record payment') } finally { setSaving(false) }
  }

  async function runChequeAction() {
    if (!chequeAction) return
    setActing(true)
    try {
      await apiPatch(`/api/payments/${chequeAction.row.id}`, { companyId, action: chequeAction.action, date: actionDate })
      toast.success(chequeAction.action === 'deposit' ? 'Cheque deposited' : chequeAction.action === 'clear' ? 'Cheque cleared' : 'Cheque bounced — invoice balance restored')
      setChequeAction(null); void list.refetch()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to update cheque') } finally { setActing(false) }
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
        <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap ${r.type === 'RECEIPT' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300' : 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300'}`}>
          {r.type === 'RECEIPT' ? 'In' : 'Out'}
        </span>
      ),
    },
    { key: 'party', header: 'Party', render: (r) => r.customer?.name || r.supplier?.name || '—' },
    { key: 'invoice', header: 'Invoice', hideOnMobile: true, render: (r) => r.invoiceNumber || r.invoice?.number || '—' },
    { key: 'amount', header: 'Amount', render: (r) => <Money value={r.amount} className="font-medium" /> },
    {
      key: 'mode', header: 'Mode', hideOnMobile: true,
      render: (r) => (
        <div className="flex flex-col gap-0.5">
          <span>{NOTE_MODES[r.mode] || r.mode || '—'}{r.chequeNo ? ` #${r.chequeNo}` : ''}</span>
          {r.chequeStatus && (
            <span className="flex items-center gap-1">
              <ChequeBadge status={r.chequeStatus} />
              {r.chequeDate && <span className="text-[11px] text-muted-foreground">{String(r.chequeDate).slice(0, 10)}</span>}
            </span>
          )}
        </div>
      ),
    },
    { key: 'account', header: 'Account', hideOnMobile: true, render: (r) => r.accountName || '—' },
    { key: 'reference', header: 'Reference', hideOnMobile: true, render: (r) => r.reference || '—' },
    {
      key: 'actions', header: 'Actions',
      render: (r) => (
        <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
          {r.mode === 'CHEQUE' && r.chequeStatus !== 'CLEARED' && r.chequeStatus !== 'BOUNCED' && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="h-7 w-7 p-0" aria-label="Cheque actions"><MoreHorizontal className="h-3.5 w-3.5" /></Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {r.chequeStatus === 'PENDING' && (
                  <DropdownMenuItem onClick={() => { setActionDate(today()); setChequeAction({ row: r, action: 'deposit' }) }}>Deposit in bank</DropdownMenuItem>
                )}
                {(r.chequeStatus === 'PENDING' || r.chequeStatus === 'DEPOSITED') && (
                  <DropdownMenuItem onClick={() => { setActionDate(today()); setChequeAction({ row: r, action: 'clear' }) }}>Mark cleared</DropdownMenuItem>
                )}
                <DropdownMenuItem className="text-red-600" onClick={() => { setActionDate(today()); setChequeAction({ row: r, action: 'bounce' }) }}>Mark bounced</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {NOTE_MODES[r.mode] ? (
            <span className="text-[11px] text-muted-foreground" title="Cancel the credit/debit note to reverse this">{NOTE_MODES[r.mode]}</span>
          ) : (
            <ConfirmAction
              trigger={<Button variant="ghost" size="sm" className="h-7 text-red-600"><Trash2 className="h-3.5 w-3.5" /></Button>}
              title="Void payment?" message={`Void payment ${r.number} of ${r.amount}? Linked invoice balances will be updated.`}
              tone="destructive" onConfirm={() => remove(r)}
            />
          )}
        </div>
      ),
    },
  ]

  return (
    <div>
      <PageHeader
        title="Payment In / Out"
        description="Payment In (from customers) & Payment Out (to suppliers)"
        actions={
          <div className="flex items-center gap-2">
            <div className="w-40">
              <SelectInput
                value={typeFilter} onChange={setTypeFilter} placeholder="All types"
                options={[
                  { value: '', label: 'All types' },
                  { value: 'RECEIPT', label: 'Payment In' },
                  { value: 'PAYMENT', label: 'Payment Out' },
                ]}
              />
            </div>
            <div className="w-44">
              <SelectInput
                value={chequeFilter} onChange={setChequeFilter} placeholder="All payments"
                options={[
                  { value: '', label: 'All payments' },
                  { value: 'postdated', label: 'Post-dated cheques' },
                  { value: 'all', label: 'All cheques' },
                ]}
              />
            </div>
            <Button onClick={() => startCreate('RECEIPT')}><Plus className="h-4 w-4 mr-1.5" />Payment In</Button>
            <Button variant="outline" onClick={() => startCreate('PAYMENT')}><Plus className="h-4 w-4 mr-1.5" />Payment Out</Button>
          </div>
        }
      />
      <DataTable columns={columns} rows={rows} loading={list.loading} searchPlaceholder="Search payments…" />

      <FormDialog
        open={open} onOpenChange={setOpen} title={type === 'RECEIPT' ? 'Payment In' : 'Payment Out'} submitLabel="Save Payment"
        description="Payment In reduces customer outstanding; Payment Out reduces supplier outstanding"
        loading={saving} onSubmit={submit}
      >
        <div className="grid sm:grid-cols-2 gap-4">
          <Field label="Type" required>
            <SelectInput
              value={type} onChange={(v) => { setType(v); setPartyId(''); setInvoiceId(''); setAmount(0) }}
              options={[{ value: 'RECEIPT', label: 'Payment In (from customer)' }, { value: 'PAYMENT', label: 'Payment Out (to supplier)' }]}
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
          <Field label={type === 'RECEIPT' ? 'Into account' : 'From account'}>
            <SelectInput value={accountId} onChange={setAccountId} options={accountOpts} />
          </Field>
          {mode === 'CHEQUE' && (
            <>
              <Field label="Cheque no."><TextInput value={chequeNo} onChange={(e) => setChequeNo(e.target.value)} placeholder="e.g. 004512" /></Field>
              <Field label="Cheque date"><DateInput value={chequeDate} onChange={setChequeDate} /></Field>
              {chequeDate > today() && (
                <p className="sm:col-span-2 text-[11px] text-amber-600">Post-dated cheque — it will not count in the bank balance until you mark it cleared.</p>
              )}
            </>
          )}
          <Field label="Date" required><DateInput value={date} onChange={setDate} /></Field>
          <Field label="Reference"><TextInput value={reference} onChange={(e) => setReference(e.target.value)} placeholder="UTR / cheque no." /></Field>
          <Field label="Notes" className="sm:col-span-2"><TextInput value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Remarks…" /></Field>
        </div>
      </FormDialog>

      <FormDialog
        open={!!chequeAction} onOpenChange={(o) => { if (!o) setChequeAction(null) }}
        title={chequeAction?.action === 'deposit' ? 'Deposit cheque' : chequeAction?.action === 'clear' ? 'Cheque cleared' : 'Cheque bounced'}
        description={chequeAction ? `${chequeAction.row.number} • cheque ${chequeAction.row.chequeNo || ''} • ₹${chequeAction.row.amount.toLocaleString('en-IN')}${chequeAction.action === 'bounce' ? ' — the invoice becomes unpaid again for this amount' : ''}` : undefined}
        submitLabel={chequeAction?.action === 'deposit' ? 'Deposit' : chequeAction?.action === 'clear' ? 'Mark cleared' : 'Mark bounced'}
        loading={acting} onSubmit={runChequeAction}
      >
        <Field label="Date"><DateInput value={actionDate} onChange={setActionDate} /></Field>
      </FormDialog>
    </div>
  )
}
