'use client'

import * as React from 'react'
import { CalendarClock, Pencil, Plus, Trash2, Wallet } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Column, ConfirmAction, DataTable, DateCell, DateInput, Field, FormDialog, Money,
  NumberInput, PageHeader, SelectInput, StatCard, StatusBadge, TextInput,
} from '@/components/erp/kit'
import { EXPENSE_CATEGORIES, PAYMENT_MODES, fmtMoney } from '@/lib/erp-constants'
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
}

interface ExpenseForm {
  date: string
  category: string
  description: string
  amount: number
  paymentMode: string
  paidTo: string
  gstAmount: number
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
})

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

  const [open, setOpen] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [editingId, setEditingId] = React.useState<string | null>(null)
  const [form, setForm] = React.useState<ExpenseForm>(freshForm)

  const monthKey = todayStr().slice(0, 7)
  const monthRows = rows.filter((r) => String(r.date).slice(0, 7) === monthKey)
  const monthTotal = monthRows.reduce((s, r) => s + (r.amount || 0), 0)
  const allTotal = rows.reduce((s, r) => s + (r.amount || 0), 0)

  function openCreate() {
    setEditingId(null)
    setForm(freshForm())
    setOpen(true)
  }

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
    })
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
              <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-red-600 hover:text-red-700" aria-label="Delete expense">
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
            New Expense
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
          sub={`${rows.length} expenses recorded`}
          icon={<Wallet className="h-4 w-4" />}
          toneClass="bg-sky-100 text-sky-600"
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
        title={editingId ? 'Edit Expense' : 'New Expense'}
        description="Expense number is generated automatically (EXP-FY-NNNNNN)."
        onSubmit={submit}
        loading={saving}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Date" required>
            <DateInput value={form.date} onChange={(v) => setForm((f) => ({ ...f, date: v }))} />
          </Field>
          <Field label="Category" required>
            <SelectInput value={form.category} onChange={(v) => setForm((f) => ({ ...f, category: v }))} options={CATEGORY_OPTIONS} />
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
            <SelectInput value={form.paymentMode} onChange={(v) => setForm((f) => ({ ...f, paymentMode: v }))} options={MODE_OPTIONS} />
          </Field>
          <Field label="Paid To">
            <TextInput
              value={form.paidTo}
              onChange={(e) => setForm((f) => ({ ...f, paidTo: e.target.value }))}
              placeholder="Vendor / payee name"
            />
          </Field>
        </div>
      </FormDialog>
    </div>
  )
}
