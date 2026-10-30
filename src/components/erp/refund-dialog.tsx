'use client'

import * as React from 'react'
import { toast } from 'sonner'
import { DateInput, Field, FormDialog, NumberInput, SelectInput, TextInput } from '@/components/erp/kit'
import { PAYMENT_MODES, accountsForMode, fmtMoney, type ModeAccount } from '@/lib/erp-constants'
import { useList } from '@/lib/use-api'

const today = () => new Date().toISOString().slice(0, 10)

/**
 * Money for a return's credit (Phase 4): a refund paid to a customer or received from a supplier. Amount defaults to
 * — and may not exceed — what is left on the note; accounts follow the payment mode (cash ↔ bank).
 */
export function RefundDialog({ companyId, open, onClose, title, description, maxAmount, accountLabel, onSave }: {
  companyId: string; open: boolean; onClose: () => void; title: string; description: string; maxAmount: number; accountLabel: string
  onSave: (v: { amount: number; mode: string; accountId?: string; date: string; reference?: string; chequeNo?: string; chequeDate?: string }) => Promise<void>
}) {
  const accounts = useList<{ items: ModeAccount[] }>(open ? `/api/accounts?companyId=${companyId}` : null)
  const [amount, setAmount] = React.useState(maxAmount)
  const [mode, setMode] = React.useState('CASH')
  const [accountId, setAccountId] = React.useState('')
  const [date, setDate] = React.useState(today)
  const [reference, setReference] = React.useState('')
  const [chequeNo, setChequeNo] = React.useState('')
  const [chequeDate, setChequeDate] = React.useState('')
  const [saving, setSaving] = React.useState(false)
  const forMode = accountsForMode(accounts.data?.items ?? [], mode)

  async function submit() {
    if (!(amount > 0)) { toast.error('Enter an amount'); return }
    if (amount > maxAmount + 0.005) { toast.error(`Only ${fmtMoney(maxAmount)} is left on this note`); return }
    // only once the account list has loaded — before that the server decides (it applies the same rule)
    if (accounts.data && !accountId && !forMode.fallback) { toast.error(`Add a ${forMode.type === 'BANK' ? 'bank' : 'cash'} account in Cash & Bank first`); return }
    setSaving(true)
    try {
      await onSave({
        amount, mode, accountId: accountId || undefined, date, reference: reference.trim() || undefined,
        ...(mode === 'CHEQUE' ? { chequeNo: chequeNo.trim() || undefined, chequeDate: chequeDate || undefined } : {}),
      })
      onClose()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to record the refund') } finally { setSaving(false) }
  }

  return (
    <FormDialog open={open} onOpenChange={(o) => { if (!o) onClose() }} loading={saving} onSubmit={submit} title={title} description={description} submitLabel="Save refund">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Amount (₹)" required><NumberInput value={amount} onChange={setAmount} min={0} step="0.01" /></Field>
        <Field label="Date" required><DateInput value={date} onChange={setDate} /></Field>
        <Field label="Mode"><SelectInput value={mode} onChange={(m) => { setMode(m); setAccountId('') }} options={PAYMENT_MODES.map((m) => ({ value: m, label: m }))} /></Field>
        <Field label={accountLabel}>
          <SelectInput
            value={accountId} onChange={setAccountId}
            options={[{ value: '', label: forMode.fallback ? `Default — ${forMode.fallback.name}` : 'Default for mode' }, ...forMode.matching.map((a) => ({ value: a.id, label: a.name }))]}
          />
          {accounts.data && !accountId && !forMode.fallback && <p className="mt-1 text-[11px] text-destructive">No {forMode.type === 'BANK' ? 'bank' : 'cash'} account — add one in Cash & Bank.</p>}
        </Field>
        {mode === 'CHEQUE' && (
          <>
            <Field label="Cheque no."><TextInput value={chequeNo} onChange={(e) => setChequeNo(e.target.value)} /></Field>
            <Field label="Cheque date"><DateInput value={chequeDate} onChange={setChequeDate} /></Field>
          </>
        )}
        <Field label="Reference" className="sm:col-span-2"><TextInput value={reference} onChange={(e) => setReference(e.target.value)} placeholder="UTR / cheque no." /></Field>
        <p className="sm:col-span-2 text-[11px] text-muted-foreground">Left on this note: {fmtMoney(maxAmount)}. A refund settles the note — it is not an expense or income.</p>
      </div>
    </FormDialog>
  )
}
