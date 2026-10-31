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
import { apiDelete, apiPatch, apiPost, currentRole, useList } from '@/lib/use-api'
import { PAYMENT_MODES, accountsForMode, canAccessModule, type ModeAccount } from '@/lib/erp-constants'

interface PaymentRow {
  id: string; number: string; date: string; type: string; partyType: string
  amount: number; mode: string; reference?: string | null; notes?: string | null
  customer?: { name?: string | null } | null
  supplier?: { name?: string | null } | null
  invoiceNumber?: string | null
  invoice?: { number?: string | null } | null
  accountId?: string | null; accountName?: string | null
  chequeNo?: string | null; chequeDate?: string | null; chequeStatus?: string | null; clearedDate?: string | null
  customerId?: string | null
  // Phase 4: ADVANCE | ADVANCE_APPLIED | CREDIT_APPLIED | REFUND (null = invoice payment / note)
  kind?: string | null; sourceNumber?: string | null; applied?: number; remaining?: number
}
type AccountOpt = ModeAccount
interface PartyRow { id: string; name?: string | null; code?: string | null }
interface DocInvoiceRow {
  id: string; number: string; status: string; grandTotal: number; paidAmount: number
  customerId?: string | null; supplierId?: string | null
}

const today = () => new Date().toISOString().slice(0, 10)
const r2 = (n: number) => Math.round(n * 100) / 100
// Adjustments posted by sales / purchase returns — voided only by cancelling the note
const NOTE_MODES: Record<string, string> = { CREDIT_NOTE: 'Credit Note', DEBIT_NOTE: 'Debit Note', ADVANCE_ADJ: 'Advance applied' }
// Invoice select value for "Advance (no invoice yet)" — Payment In only
const ADVANCE_OPTION = '__ADVANCE__'
const CHEQUE_TONE: Record<string, string> = {
  PENDING: 'bg-warning-soft text-warning ring-1 ring-inset ring-warning-border',
  DEPOSITED: 'bg-info-soft text-info ring-1 ring-inset ring-info-border',
  CLEARED: 'bg-success-soft text-success ring-1 ring-inset ring-success-border',
  BOUNCED: 'bg-danger-soft text-destructive ring-1 ring-inset ring-danger-border',
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
  // Phase 5: each side's invoices only for roles that may read them (the server refuses the other side with 403)
  const role = React.useMemo(() => currentRole(), [])
  const salesSide = !role || canAccessModule(role, 'sales-invoices') || canAccessModule(role, 'receivables')
  const purchaseSide = !role || canAccessModule(role, 'purchase-invoices') || canAccessModule(role, 'payables')
  const salesInvoices = useList<{ items: DocInvoiceRow[] }>(salesSide ? `/api/sales-invoices?companyId=${companyId}` : null)
  const purchaseInvoices = useList<{ items: DocInvoiceRow[] }>(purchaseSide ? `/api/purchase-invoices?companyId=${companyId}` : null)

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

  // Accounts of the mode's type only (cash ↔ bank); '' = the default account the server will use
  const forMode = React.useMemo(() => accountsForMode(accounts.data?.items ?? [], mode), [accounts.data, mode])
  const accountOpts = React.useMemo(() => [
    { value: '', label: forMode.fallback ? `Default — ${forMode.fallback.name}` : 'Default for mode' },
    ...forMode.matching.map((a) => ({ value: a.id, label: a.name })),
  ], [forMode])

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
    setType(salesSide ? 'RECEIPT' : 'PAYMENT'); setPartyId(''); setInvoiceId(''); setAmount(0); setMode('NEFT'); setDate(today()); setReference(''); setNotes('')
    setAccountId(''); setChequeNo(''); setChequeDate('')
  }

  // Shortcuts from other screens (party view, row actions, quick actions) open this form pre-filled
  useCreatePreset('payments', (d) => {
    resetForm()
    if (d.type === 'RECEIPT' || d.type === 'PAYMENT') setType(String(d.type))
    if (d.partyId) setPartyId(String(d.partyId))
    if (d.invoiceId) { setInvoiceId(String(d.invoiceId)); setAmount(Number(d.amount) || 0) }
    if (d.advance && d.type === 'RECEIPT') setInvoiceId(ADVANCE_OPTION)
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

  // A payment settles an invoice / bill; Payment In may instead be a customer advance (applied to invoices later)
  const selectedInvoice = invoiceOpts.find((o) => o.value === invoiceId)
  const isAdvance = type === 'RECEIPT' && invoiceId === ADVANCE_OPTION

  async function submit() {
    if (!partyId) { toast.error('Select a party'); return }
    if (!invoiceId) { toast.error(type === 'RECEIPT' ? 'Select the sales invoice this payment is for, or "Advance"' : 'Select the purchase bill this payment is for'); return }
    if (isAdvance && mode === 'CHEQUE' && chequeDate > today()) { toast.error('A post-dated cheque cannot be taken as an advance — record it when the cheque date arrives'); return }
    if (amount <= 0) { toast.error('Enter a valid amount'); return }
    if (selectedInvoice && amount > selectedInvoice.outstanding + 0.01) { toast.error(`Amount is more than the outstanding ₹${selectedInvoice.outstanding.toLocaleString('en-IN')}`); return }
    // only once the account list has loaded — before that the server decides (it applies the same rule)
    if (accounts.data && !accountId && !forMode.fallback) { toast.error(`Add a ${forMode.type === 'BANK' ? 'bank' : 'cash'} account in Cash & Bank first`); return }
    setSaving(true)
    try {
      await apiPost('/api/payments', {
        companyId, type, partyType: type === 'RECEIPT' ? 'CUSTOMER' : 'SUPPLIER',
        customerId: type === 'RECEIPT' ? partyId : undefined,
        supplierId: type === 'PAYMENT' ? partyId : undefined,
        invoiceType: isAdvance ? 'ADVANCE' : invoiceId ? (type === 'RECEIPT' ? 'SALES' : 'PURCHASE') : undefined,
        invoiceId: isAdvance ? undefined : invoiceId || undefined,
        amount, mode, date, reference: reference || undefined, notes: notes || undefined,
        accountId: accountId || undefined,
        ...(mode === 'CHEQUE' ? { chequeNo: chequeNo || undefined, chequeDate: chequeDate || undefined } : {}),
        userName: type === 'RECEIPT' ? 'Sales User' : 'Purchase User',
      })
      toast.success(isAdvance ? 'Advance recorded — apply it to invoices from the payment list' : mode === 'CHEQUE' && chequeDate > today() ? 'Post-dated cheque recorded — counts in the bank once cleared' : 'Payment recorded')
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

  // ----- Apply an advance to an open invoice of the same customer (no money moves) -----
  const [applyRow, setApplyRow] = React.useState<PaymentRow | null>(null)
  const [applyInvoice, setApplyInvoice] = React.useState('')
  const [applyAmount, setApplyAmount] = React.useState(0)
  const [applyDate, setApplyDate] = React.useState(today)
  const [applying, setApplying] = React.useState(false)
  const applyOpts = React.useMemo(() => (salesInvoices.data?.items ?? [])
    .filter((inv) => applyRow && inv.customerId === applyRow.customerId && inv.status !== 'PAID' && inv.status !== 'CANCELLED')
    .map((inv) => ({ value: inv.id, label: `${inv.number} — outstanding ₹${r2(inv.grandTotal - inv.paidAmount).toLocaleString('en-IN')}`, outstanding: r2(inv.grandTotal - inv.paidAmount) })), [salesInvoices.data, applyRow])
  function openApply(r: PaymentRow) {
    setApplyRow(r); setApplyInvoice(''); setApplyAmount(r.remaining ?? 0); setApplyDate(today())
  }
  function pickApplyInvoice(id: string) {
    setApplyInvoice(id)
    const o = applyOpts.find((x) => x.value === id)
    if (o && applyRow) setApplyAmount(r2(Math.min(applyRow.remaining ?? 0, o.outstanding)))
  }
  async function submitApply() {
    if (!applyRow) return
    if (!applyInvoice) { toast.error('Choose the invoice to apply the advance to'); return }
    if (!(applyAmount > 0)) { toast.error('Enter an amount'); return }
    setApplying(true)
    try {
      await apiPatch(`/api/payments/${applyRow.id}`, { companyId, action: 'apply', invoiceId: applyInvoice, amount: applyAmount, date: applyDate })
      toast.success('Advance applied'); setApplyRow(null); void list.refetch(); void salesInvoices.refetch()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to apply the advance') } finally { setApplying(false) }
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
        <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap ${r.type === 'RECEIPT' ? 'bg-success-soft text-success ring-1 ring-inset ring-success-border' : 'bg-warning-soft text-warning ring-1 ring-inset ring-warning-border'}`}>
          {r.type === 'RECEIPT' ? 'In' : 'Out'}
        </span>
      ),
    },
    { key: 'party', header: 'Party', render: (r) => r.customer?.name || r.supplier?.name || '—' },
    {
      key: 'invoice', header: 'Invoice', hideOnMobile: true,
      render: (r) => r.kind === 'ADVANCE'
        ? <span className="whitespace-nowrap">Advance · <span className={r.remaining ? 'font-medium' : 'text-muted-foreground'}>₹{(r.remaining ?? 0).toLocaleString('en-IN')} left</span></span>
        : r.kind === 'REFUND' ? `Refund on ${r.invoiceNumber || '—'}`
          : r.kind === 'ADVANCE_APPLIED' || r.kind === 'CREDIT_APPLIED' ? `${r.invoiceNumber || '—'} (from ${r.sourceNumber || '—'})`
            : r.invoiceNumber || r.invoice?.number || '—',
    },
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
                <DropdownMenuItem className="text-destructive" onClick={() => { setActionDate(today()); setChequeAction({ row: r, action: 'bounce' }) }}>Mark bounced</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {r.kind === 'ADVANCE' && (r.remaining ?? 0) > 0.005 && r.chequeStatus !== 'BOUNCED' && (
            <Button variant="outline" size="sm" className="h-7" onClick={() => openApply(r)}>Apply</Button>
          )}
          {r.kind === 'ADVANCE_APPLIED' || r.kind === 'CREDIT_APPLIED' ? (
            <ConfirmAction
              trigger={<Button variant="ghost" size="sm" className="h-7 text-destructive">Remove</Button>}
              title="Remove application?" message={`Remove ${r.number}? ₹${r.amount} goes back to ${r.sourceNumber || 'its source'} and the invoice becomes outstanding again. No money moves.`}
              tone="destructive" onConfirm={() => remove(r)}
            />
          ) : NOTE_MODES[r.mode] ? (
            <span className="text-[11px] text-muted-foreground" title="Cancel the credit/debit note to reverse this">{NOTE_MODES[r.mode]}</span>
          ) : (
            <ConfirmAction
              trigger={<Button variant="ghost" size="sm" className="h-7 text-destructive"><Trash2 className="h-3.5 w-3.5" /></Button>}
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
          <div className="flex flex-wrap items-center gap-2">
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
            {salesSide && <Button onClick={() => startCreate('RECEIPT')}><Plus className="h-4 w-4 mr-1.5" />Payment In</Button>}
            {purchaseSide && <Button variant={salesSide ? 'outline' : 'default'} onClick={() => startCreate('PAYMENT')}><Plus className="h-4 w-4 mr-1.5" />Payment Out</Button>}
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
              value={partyId} onChange={(v) => { setPartyId(v); setInvoiceId((cur) => (cur === ADVANCE_OPTION ? cur : '')) /* an advance fits any customer; an invoice belongs to the old one */ }}
              options={partyOpts} placeholder={type === 'RECEIPT' ? 'Select customer…' : 'Select supplier…'}
            />
          </Field>
          <Field label={type === 'RECEIPT' ? 'Sales invoice or advance' : 'Purchase bill'} required className="sm:col-span-2">
            <SelectInput
              value={invoiceId} onChange={pickInvoice}
              options={type === 'RECEIPT' ? [{ value: ADVANCE_OPTION, label: 'Advance (no invoice yet)' }, ...invoiceOpts] : invoiceOpts}
              placeholder={!partyId ? 'Select the party first' : invoiceOpts.length ? 'Select an open invoice…' : 'No open invoices for this party'}
            />
            <p className="mt-1 text-[11px] text-muted-foreground">
              {isAdvance
                ? 'Advance: kept as money owed to the customer (not sales) until you apply it to their invoices.'
                : selectedInvoice
                  ? `Outstanding on this ${type === 'RECEIPT' ? 'invoice' : 'bill'}: ₹${selectedInvoice.outstanding.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`
                  : type === 'RECEIPT'
                    ? 'Choose an open sales invoice, or "Advance" for money received before an invoice.'
                    : 'A payment out must be linked to an open purchase bill.'}
            </p>
          </Field>
          <Field label="Amount" required><NumberInput value={amount} onChange={setAmount} min={0} /></Field>
          <Field label="Mode"><SelectInput value={mode} onChange={(m) => { setMode(m); setAccountId('') }} options={PAYMENT_MODES.map((m) => ({ value: m, label: m }))} /></Field>
          <Field label={type === 'RECEIPT' ? 'Into account' : 'From account'}>
            <SelectInput value={accountId} onChange={setAccountId} options={accountOpts} />
            <p className={`mt-1 text-[11px] ${forMode.fallback || accountId ? 'text-muted-foreground' : 'text-destructive'}`}>
              {accountId
                ? `Recorded in ${forMode.matching.find((a) => a.id === accountId)?.name ?? 'the chosen account'}`
                : forMode.fallback
                  ? `Will be recorded in ${forMode.fallback.name}`
                  : `No ${forMode.type === 'BANK' ? 'bank' : 'cash'} account — add one in Cash & Bank to record ${mode} payments`}
            </p>
          </Field>
          {mode === 'CHEQUE' && (
            <>
              <Field label="Cheque no."><TextInput value={chequeNo} onChange={(e) => setChequeNo(e.target.value)} placeholder="e.g. 004512" /></Field>
              <Field label="Cheque date"><DateInput value={chequeDate} onChange={setChequeDate} /></Field>
              {chequeDate > today() && (
                <p className="sm:col-span-2 text-[11px] text-warning">Post-dated cheque — it will not count in the bank balance until you mark it cleared.</p>
              )}
            </>
          )}
          <Field label="Date" required><DateInput value={date} onChange={setDate} /></Field>
          <Field label="Reference"><TextInput value={reference} onChange={(e) => setReference(e.target.value)} placeholder="UTR / cheque no." /></Field>
          <Field label="Notes" className="sm:col-span-2"><TextInput value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Remarks…" /></Field>
        </div>
      </FormDialog>

      <FormDialog
        open={!!applyRow} onOpenChange={(o) => { if (!o) setApplyRow(null) }} loading={applying} onSubmit={submitApply}
        title="Apply advance" submitLabel="Apply"
        description={applyRow ? `${applyRow.number} · ${applyRow.customer?.name || ''} · ₹${(applyRow.remaining ?? 0).toLocaleString('en-IN')} left — no money moves` : ''}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Invoice" required className="sm:col-span-2">
            <SelectInput value={applyInvoice} onChange={pickApplyInvoice} options={applyOpts} placeholder={applyOpts.length ? 'Select an open invoice…' : 'No open invoices for this customer'} />
          </Field>
          <Field label="Amount (₹)" required><NumberInput value={applyAmount} onChange={setApplyAmount} min={0} step="0.01" /></Field>
          <Field label="Date" required><DateInput value={applyDate} onChange={setApplyDate} /></Field>
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
