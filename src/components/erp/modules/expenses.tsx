'use client'

import * as React from 'react'
import { CalendarClock, Pencil, Plus, Trash2, Wallet } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Column, ConfirmAction, DataTable, DateCell, DateInput, Field, FormDialog, Money,
  NumberInput, PageHeader, SelectInput, StatCard, StatusBadge, TextInput, useCreatePreset,
} from '@/components/erp/kit'
import { EXPENSE_CATEGORIES, PAYMENT_MODES, accountsForMode, fmtMoney, type ModeAccount } from '@/lib/erp-constants'
import { apiDelete, apiPatch, apiPost, useList } from '@/lib/use-api'

interface ExpenseRow {
  id: string
  number: string
  date: string | Date
  category: string
  description: string
  amount: number
  paymentMode: string
  paidTo?: string | null
  gstAmount?: number
  status: string
  vendorGstin?: string | null
  billNo?: string | null
  billDate?: string | Date | null
  itcEligible?: boolean
  accountId?: string | null
  accountName?: string | null
  expenseType?: string | null
}

type AccountOpt = ModeAccount

interface ExpenseForm {
  date: string
  category: string
  description: string
  amount: number
  paymentMode: string
  paidTo: string
  gstAmount: number
  status: string
  vendorGstin: string
  billNo: string
  billDate: string // YYYY-MM-DD or ''
  itcEligible: string // 'YES' | 'NO'
  accountId: string // '' = default account for the payment mode
  expenseType: string // DIRECT | INDIRECT
}

const todayStr = () => new Date().toISOString().slice(0, 10)

const freshForm = (): ExpenseForm => ({
  date: todayStr(),
  category: 'UTILITIES',
  description: '',
  amount: 0,
  paymentMode: 'CASH',
  paidTo: '',
  gstAmount: 0,
  status: 'POSTED',
  vendorGstin: '',
  billNo: '',
  billDate: '',
  itcEligible: 'NO',
  accountId: '',
  expenseType: 'INDIRECT',
})

const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/
const STATUS_OPTIONS = [
  { value: 'DRAFT', label: 'Draft' },
  { value: 'POSTED', label: 'Posted' },
  { value: 'CANCELLED', label: 'Cancelled' },
]
const YES_NO = [
  { value: 'NO', label: 'No' },
  { value: 'YES', label: 'Yes' },
]

const EXPENSE_TYPE_OPTIONS = [
  { value: 'DIRECT', label: 'Direct (production: freight, job work, power…)' },
  { value: 'INDIRECT', label: 'Indirect (rent, salary, office, tea…)' },
]
// Categories that are usually a direct (production) cost — used to pre-select the type
const DIRECT_CATEGORIES = ['FREIGHT', 'TOOLING']

const CATEGORY_OPTIONS = EXPENSE_CATEGORIES.map((c) => ({ value: c, label: c.replaceAll('_', ' ') }))
const MODE_OPTIONS = PAYMENT_MODES.map((m) => ({ value: m, label: m }))

function CategoryChip({ category }: { category: string }) {
  return (
    <span className="inline-flex items-center whitespace-nowrap rounded-md bg-muted px-2 py-0.5 text-[11px] font-medium">
      {(category || '—').replaceAll('_', ' ')}
    </span>
  )
}

export default function ExpensesModule({ companyId }: { companyId: string }) {
  const { data, loading, refetch } = useList<{ items?: ExpenseRow[]; total?: number }>(`/api/expenses?companyId=${companyId}`)
  const rows = data?.items ?? []
  const accounts = useList<{ items: AccountOpt[] }>(`/api/accounts?companyId=${companyId}`)
  const [open, setOpen] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [editingId, setEditingId] = React.useState<string | null>(null)
  const [form, setForm] = React.useState<ExpenseForm>(freshForm)
  // The account an edited expense already has (kept even if it no longer matches the mode — saved before the rule)
  const [keptAccountId, setKeptAccountId] = React.useState('')

  // Accounts of the payment mode's type only (cash ↔ bank); '' = the default account the server will use
  const forMode = React.useMemo(() => accountsForMode(accounts.data?.items ?? [], form.paymentMode), [accounts.data, form.paymentMode])
  const accountOpts = React.useMemo(() => {
    const all = accounts.data?.items ?? []
    const kept = keptAccountId && !forMode.matching.some((a) => a.id === keptAccountId) ? all.find((a) => a.id === keptAccountId) : undefined
    return [
      { value: '', label: forMode.fallback ? `Default — ${forMode.fallback.name}` : 'Default for mode' },
      ...forMode.matching.map((a) => ({ value: a.id, label: a.name })),
      ...(kept ? [{ value: kept.id, label: `${kept.name} (current)` }] : []),
    ]
  }, [accounts.data, forMode, keptAccountId])
  const accountHint = form.accountId
    ? `Paid from ${(accounts.data?.items ?? []).find((a) => a.id === form.accountId)?.name ?? 'the chosen account'}`
    : forMode.fallback
      ? `Will be paid from ${forMode.fallback.name}`
      : `No ${forMode.type === 'BANK' ? 'bank' : 'cash'} account — add one in Cash & Bank to record ${form.paymentMode} payments`

  const monthKey = todayStr().slice(0, 7)
  // cancelled expenses don't count towards spend totals
  const liveRows = rows.filter((r) => r.status !== 'CANCELLED')
  const monthRows = liveRows.filter((r) => String(r.date).slice(0, 7) === monthKey)
  const monthTotal = monthRows.reduce((s, r) => s + (r.amount || 0), 0)
  const allTotal = liveRows.reduce((s, r) => s + (r.amount || 0), 0)

  function openCreate() {
    setEditingId(null)
    setKeptAccountId('')
    setForm(freshForm())
    setOpen(true)
  }

  // Opened from another screen (Cash & Bank → Money Out → Expense): a fresh form
  useCreatePreset('expenses', () => openCreate())

  function openEdit(row: ExpenseRow) {
    setEditingId(row.id)
    setForm({
      date: String(row.date).slice(0, 10),
      category: row.category || 'OTHER',
      description: row.description || '',
      amount: row.amount || 0,
      paymentMode: row.paymentMode || 'CASH',
      paidTo: row.paidTo || '',
      gstAmount: row.gstAmount || 0,
      status: row.status || 'POSTED',
      vendorGstin: row.vendorGstin || '',
      billNo: row.billNo || '',
      billDate: row.billDate ? String(row.billDate).slice(0, 10) : '',
      itcEligible: row.itcEligible ? 'YES' : 'NO',
      accountId: row.accountId || '',
      expenseType: row.expenseType || 'INDIRECT',
    })
    setKeptAccountId(row.accountId || '')
    setOpen(true)
  }

  async function submit() {
    if (!form.description.trim()) {
      toast.error('Description is required')
      return
    }
    if (!(form.amount > 0)) {
      toast.error('Amount must be greater than 0')
      return
    }
    const gstin = form.vendorGstin.trim().toUpperCase()
    if (gstin && !GSTIN_RE.test(gstin)) {
      toast.error('Vendor GSTIN is not a valid 15-character GSTIN')
      return
    }
    setSaving(true)
    try {
      const payload = {
        companyId,
        date: form.date,
        category: form.category,
        description: form.description.trim(),
        amount: form.amount,
        paymentMode: form.paymentMode,
        paidTo: form.paidTo.trim() || null,
        gstAmount: form.gstAmount || 0,
        status: form.status,
        vendorGstin: gstin || null,
        billNo: form.billNo.trim() || null,
        billDate: form.billDate || null,
        itcEligible: form.itcEligible === 'YES',
        accountId: form.accountId || null,
        expenseType: form.expenseType,
        userName: 'admin',
      }
      if (editingId) {
        await apiPatch(`/api/expenses/${editingId}`, payload)
        toast.success('Expense updated')
      } else {
        await apiPost('/api/expenses', payload)
        toast.success('Expense recorded')
      }
      setOpen(false)
      await refetch()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save expense')
    } finally {
      setSaving(false)
    }
  }

  async function remove(row: ExpenseRow) {
    try {
      await apiDelete(`/api/expenses/${row.id}?companyId=${companyId}`)
      toast.success('Expense deleted')
      await refetch()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to delete expense')
    }
  }

  const columns: Column<ExpenseRow>[] = [
    { key: 'number', header: 'Number', render: (r) => <span className="font-mono text-xs">{r.number}</span> },
    { key: 'date', header: 'Date', render: (r) => <DateCell value={r.date} /> },
    { key: 'category', header: 'Category', render: (r) => <CategoryChip category={r.category} /> },
    {
      key: 'expenseType', header: 'Type', hideOnMobile: true,
      render: (r) => (
        <span className={`inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium ${r.expenseType === 'DIRECT' ? 'bg-info-soft text-info ring-1 ring-inset ring-info-border' : 'bg-muted text-muted-foreground'}`}>
          {r.expenseType === 'DIRECT' ? 'Direct' : 'Indirect'}
        </span>
      ),
    },
    {
      key: 'description',
      header: 'Description',
      render: (r) => (
        <span className="block max-w-[220px] truncate" title={r.description}>
          {r.description || '—'}
        </span>
      ),
    },
    { key: 'paidTo', header: 'Paid To', hideOnMobile: true, render: (r) => r.paidTo || '—' },
    { key: 'amount', header: 'Amount', className: 'text-right', render: (r) => <Money value={r.amount} className="font-medium" /> },
    { key: 'mode', header: 'Mode', render: (r) => <StatusBadge status={r.paymentMode} /> },
    { key: 'account', header: 'Account', hideOnMobile: true, render: (r) => r.accountName || '—' },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
    {
      key: 'actions',
      header: '',
      className: 'w-20 text-right',
      render: (r) => (
        <div className="flex items-center justify-end gap-1">
          <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => openEdit(r)} aria-label="Edit expense">
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <ConfirmAction
            tone="destructive"
            title="Delete expense"
            message={`Delete ${r.number} (${fmtMoney(r.amount)})? This cannot be undone.`}
            onConfirm={() => remove(r)}
            trigger={
              <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-destructive hover:text-destructive" aria-label="Delete expense">
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            }
          />
        </div>
      ),
    },
  ]

  return (
    <div>
      <PageHeader
        title="Expenses"
        description="Operating expenses with auto EXP numbering per financial year"
        actions={
          <Button size="sm" onClick={openCreate}>
            <Plus className="h-4 w-4 mr-1.5" />
            Expense
          </Button>
        }
      />
      <div className="grid gap-3 sm:grid-cols-2 mb-4">
        <StatCard
          title="This Month"
          value={fmtMoney(monthTotal)}
          sub={`${monthRows.length} entries in ${monthKey}`}
          icon={<CalendarClock className="h-4 w-4" />}
        />
        <StatCard
          title="All-Time Total"
          value={fmtMoney(allTotal)}
          sub={`${liveRows.length} expenses recorded`}
          icon={<Wallet className="h-4 w-4" />}
          toneClass="bg-info-soft text-info"
        />
      </div>
      <DataTable
        columns={columns}
        rows={rows}
        loading={loading}
        searchPlaceholder="Search expenses…"
        emptyText="No expenses recorded yet"
      />
      <FormDialog
        open={open}
        onOpenChange={setOpen}
        title={editingId ? 'Edit Expense' : 'Expense'}
        description="Expense number is generated automatically (EXP-FY-NNNNNN)."
        onSubmit={submit}
        loading={saving}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Date" required>
            <DateInput value={form.date} onChange={(v) => setForm((f) => ({ ...f, date: v }))} />
          </Field>
          <Field label="Category" required>
            <SelectInput
              value={form.category}
              onChange={(v) => setForm((f) => ({ ...f, category: v, ...(editingId ? {} : { expenseType: DIRECT_CATEGORIES.includes(v) ? 'DIRECT' : 'INDIRECT' }) }))}
              options={CATEGORY_OPTIONS}
            />
          </Field>
          <Field label="Expense type" className="sm:col-span-2">
            <SelectInput value={form.expenseType} onChange={(v) => setForm((f) => ({ ...f, expenseType: v }))} options={EXPENSE_TYPE_OPTIONS} />
          </Field>
          <Field label="Description" required className="sm:col-span-2">
            <TextInput
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              placeholder="e.g. Generator diesel refill"
            />
          </Field>
          <Field label="Amount (₹)" required>
            <NumberInput value={form.amount} onChange={(n) => setForm((f) => ({ ...f, amount: n }))} min={0} step="0.01" />
          </Field>
          <Field label="GST Amount (₹)">
            <NumberInput value={form.gstAmount} onChange={(n) => setForm((f) => ({ ...f, gstAmount: n }))} min={0} step="0.01" />
          </Field>
          <Field label="Payment Mode">
            <SelectInput
              value={form.paymentMode} options={MODE_OPTIONS}
              // a new mode clears an account of the other kind (cash ↔ bank)
              onChange={(v) => setForm((f) => ({ ...f, paymentMode: v, accountId: accountsForMode(accounts.data?.items ?? [], v).matching.some((a) => a.id === f.accountId) ? f.accountId : '' }))}
            />
          </Field>
          <Field label="Paid from account">
            <SelectInput value={form.accountId} onChange={(v) => setForm((f) => ({ ...f, accountId: v }))} options={accountOpts} />
            <p className={`mt-1 text-[11px] ${form.accountId || forMode.fallback ? 'text-muted-foreground' : 'text-destructive'}`}>{accountHint}</p>
          </Field>
          <Field label="Paid To">
            <TextInput
              value={form.paidTo}
              onChange={(e) => setForm((f) => ({ ...f, paidTo: e.target.value }))}
              placeholder="Vendor / payee name"
            />
          </Field>
          <Field label="Vendor GSTIN">
            <TextInput
              value={form.vendorGstin}
              onChange={(e) => setForm((f) => ({ ...f, vendorGstin: e.target.value.toUpperCase() }))}
              placeholder="27ABCDE1234F1Z5"
              maxLength={15}
            />
          </Field>
          <Field label="ITC Eligible">
            <SelectInput value={form.itcEligible} onChange={(v) => setForm((f) => ({ ...f, itcEligible: v }))} options={YES_NO} />
          </Field>
          <Field label="Bill No">
            <TextInput
              value={form.billNo}
              onChange={(e) => setForm((f) => ({ ...f, billNo: e.target.value }))}
              placeholder="Vendor bill / invoice no."
            />
          </Field>
          <Field label="Bill Date">
            <DateInput value={form.billDate} onChange={(v) => setForm((f) => ({ ...f, billDate: v }))} />
          </Field>
          <Field label="Status">
            <SelectInput value={form.status} onChange={(v) => setForm((f) => ({ ...f, status: v }))} options={STATUS_OPTIONS} />
          </Field>
        </div>
      </FormDialog>
    </div>
  )
}
