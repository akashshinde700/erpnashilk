'use client'

import * as React from 'react'
import { toast } from 'sonner'
import { FileText, Landmark, Loader2, MapPin, User, Wallet } from 'lucide-react'
import { Textarea } from '@/components/ui/textarea'
import { Checkbox } from '@/components/ui/checkbox'
import { Field, FormDialog, SelectInput, TextInput } from '@/components/erp/kit'
import { apiPatch, apiPost } from '@/lib/use-api'
import { GST_STATES } from '@/lib/erp-constants'
import { MODULE_TAB_EVENT } from '@/components/erp/tab-group'

export type PartyKind = 'customer' | 'supplier'
/** What a save produced: one master, or a linked customer + supplier ("Both"). */
export type SavedKind = PartyKind | 'both'

/** Window event the app shell / forms fire to switch the Parties screen to a tab. */
export const PARTY_TAB_EVENT = MODULE_TAB_EVENT

/** Customer / Supplier master row as returned by the API (shared shape). */
export interface PartyRecord {
  id: string
  code: string
  name: string
  nickName?: string | null
  gstin?: string | null
  /** REGULAR | COMPOSITION | UNREGISTERED | CONSUMER | OVERSEAS | SEZ */
  gstType?: string | null
  pan?: string | null
  contactPerson?: string | null
  phone?: string | null
  altPhone?: string | null
  email?: string | null
  addressLine?: string | null
  addressLine2?: string | null
  city?: string | null
  state?: string | null
  stateCode?: string | null
  pincode?: string | null
  country?: string | null
  shippingAddress?: string | null
  bankIfsc?: string | null
  bankName?: string | null
  bankAccountNo?: string | null
  bankBranch?: string | null
  paymentTermsDays?: number
  creditLimit?: number
  openingBalance?: number
  notes?: string | null
  status: string
  /** Ledger name this party is posted to in Tally (blank = the party name). */
  tallyLedgerName?: string | null
  /** "Both" link: set on a customer that is also a supplier / on a supplier that is also a customer */
  supplierId?: string | null
  supplier?: { id: string; code: string } | null
  customer?: { id: string; code: string } | null
}

export const isBothParty = (p: PartyRecord) => !!(p.supplierId || p.supplier || p.customer)

/** GST registration types of a party (Customer / Supplier gstType). */
export const GST_TYPE_OPTIONS = [
  { value: 'REGULAR', label: 'Registered – Regular' },
  { value: 'COMPOSITION', label: 'Registered – Composition' },
  { value: 'UNREGISTERED', label: 'Unregistered' },
  { value: 'CONSUMER', label: 'Consumer' },
  { value: 'OVERSEAS', label: 'Overseas' },
  { value: 'SEZ', label: 'SEZ' },
]
export const gstTypeLabel = (t?: string | null) => GST_TYPE_OPTIONS.find((o) => o.value === t)?.label ?? ''

const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/

type FormState = Record<
  'kind' | 'code' | 'name' | 'nickName' | 'gstin' | 'gstType' | 'pan' | 'contactPerson' | 'phone' | 'altPhone' | 'email'
  | 'addressLine' | 'addressLine2' | 'city' | 'state' | 'stateCode' | 'pincode' | 'country' | 'shippingAddress'
  | 'bankIfsc' | 'bankName' | 'bankAccountNo' | 'bankBranch'
  | 'paymentTermsDays' | 'creditLimit' | 'openingBalance' | 'openingBalanceSupplier' | 'notes' | 'status'
  | 'tallyLedgerName',
  string
>

const toForm = (kind: PartyKind, p: PartyRecord | null): FormState => ({
  kind: p && isBothParty(p) ? 'both' : kind,
  code: p?.code ?? '',
  name: p?.name ?? '',
  nickName: p?.nickName ?? '',
  gstin: p?.gstin ?? '',
  gstType: p?.gstType || (p?.gstin ? 'REGULAR' : 'UNREGISTERED'),
  pan: p?.pan ?? '',
  contactPerson: p?.contactPerson ?? '',
  phone: p?.phone ?? '',
  altPhone: p?.altPhone ?? '',
  email: p?.email ?? '',
  addressLine: p?.addressLine ?? '',
  addressLine2: p?.addressLine2 ?? '',
  city: p?.city ?? '',
  state: p?.state ?? '',
  stateCode: p?.stateCode ?? '',
  pincode: p?.pincode ?? '',
  country: p?.country || 'India',
  shippingAddress: p?.shippingAddress ?? '',
  bankIfsc: p?.bankIfsc ?? '',
  bankName: p?.bankName ?? '',
  bankAccountNo: p?.bankAccountNo ?? '',
  bankBranch: p?.bankBranch ?? '',
  paymentTermsDays: String(p?.paymentTermsDays ?? 30),
  creditLimit: p?.creditLimit ? String(p.creditLimit) : '',
  openingBalance: p?.openingBalance ? String(p.openingBalance) : '',
  openingBalanceSupplier: '',
  notes: p?.notes ?? '',
  status: p?.status ?? 'ACTIVE',
  tallyLedgerName: p?.tallyLedgerName ?? '',
})

const LEGAL_SUFFIX = /\b(private|pvt\.?|limited|ltd\.?|llp|inc\.?|co\.?|company|corporation|corp\.?|&)\b/gi

/** "Precision Tools Pvt Ltd" → "Precision Tools" */
function suggestNick(name: string): string {
  return name.replace(LEGAL_SUFFIX, ' ').replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim().split(' ').slice(0, 2).join(' ')
}

const stateByCode = (code: string) => GST_STATES.find((s) => s.code === code)

/** Billing address fields as one block of text (for "Same as billing" shipping address). */
function billingText(f: FormState): string {
  const place = [f.city, f.state].map((s) => s.trim()).filter(Boolean).join(', ')
  const last = [place, f.pincode.trim()].filter(Boolean).join(' - ')
  return [f.addressLine.trim(), f.addressLine2.trim(), last].filter(Boolean).join('\n')
}

function Section({ icon: Icon, title, hint, children }: { icon: React.ComponentType<{ className?: string }>; title: string; hint: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border p-4">
      <div className="mb-4 flex items-start gap-3">
        <div className="rounded-lg bg-emerald-50 p-2 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"><Icon className="h-4 w-4" /></div>
        <div>
          <p className="text-sm font-semibold leading-tight">{title}</p>
          <p className="text-xs text-muted-foreground">{hint}</p>
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">{children}</div>
    </section>
  )
}

const Hint = ({ children }: { children: React.ReactNode }) => <p className="text-[11px] text-muted-foreground">{children}</p>

/**
 * Add / edit a party (customer or supplier). On create the Type picks which master it goes to;
 * on edit the type is fixed. `onSaved(kind)` lets the caller refresh / switch tabs.
 */
export function PartyFormDialog({ open, onOpenChange, kind, editing, companyId, onSaved }: {
  open: boolean
  onOpenChange: (o: boolean) => void
  kind: PartyKind
  editing: PartyRecord | null
  companyId: string
  onSaved: (kind: SavedKind) => void
}) {
  const [form, setForm] = React.useState<FormState>(() => toForm(kind, editing))
  const [nickTouched, setNickTouched] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [ifscLooking, setIfscLooking] = React.useState(false)
  const [sameShipping, setSameShipping] = React.useState(false)

  React.useEffect(() => {
    if (!open) return
    setForm(toForm(kind, editing))
    setNickTouched(!!editing?.nickName)
    setSameShipping(false)
  }, [open, kind, editing])

  const set = (k: keyof FormState) => (v: string) => setForm((f) => ({ ...f, [k]: v }))
  const input = (k: keyof FormState) => ({ value: form[k], onChange: (e: React.ChangeEvent<HTMLInputElement>) => set(k)(e.target.value) })

  function onName(v: string) {
    setForm((f) => ({ ...f, name: v, nickName: nickTouched ? f.nickName : suggestNick(v) }))
  }

  // GSTIN = 2-digit state code + 10-char PAN + 3 chars: fill PAN, state code and state.
  function onGstin(raw: string) {
    const g = raw.toUpperCase().replace(/\s/g, '').slice(0, 15)
    setForm((f) => {
      const next = { ...f, gstin: g }
      if (GSTIN_RE.test(g) && f.gstType === 'UNREGISTERED') next.gstType = 'REGULAR'
      if (g.length >= 12) next.pan = g.slice(2, 12)
      if (g.length >= 2 && /^\d{2}/.test(g)) {
        const st = stateByCode(g.slice(0, 2))
        next.stateCode = g.slice(0, 2)
        if (st) next.state = st.name
      }
      return next
    })
  }

  function onState(name: string) {
    const st = GST_STATES.find((s) => s.name === name)
    setForm((f) => ({ ...f, state: name, stateCode: st ? st.code : f.stateCode }))
  }

  async function onIfsc(raw: string) {
    const code = raw.toUpperCase().replace(/\s/g, '').slice(0, 11)
    set('bankIfsc')(code)
    if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(code)) return
    // Public IFSC directory (only the IFSC code is sent). Failure just leaves the fields for manual entry.
    setIfscLooking(true)
    try {
      const res = await fetch(`https://ifsc.razorpay.com/${code}`)
      if (!res.ok) { toast.error('IFSC not found — check the code or fill bank details manually'); return }
      const d = (await res.json()) as { BANK?: string; BRANCH?: string }
      setForm((f) => (f.bankIfsc === code ? { ...f, bankName: d.BANK || f.bankName, bankBranch: d.BRANCH || f.bankBranch } : f))
    } catch {
      /* offline / blocked — manual entry */
    } finally {
      setIfscLooking(false)
    }
  }

  async function submit() {
    if (!form.name.trim()) { toast.error('Party name is required'); return }
    setSaving(true)
    try {
      const values = sameShipping ? { ...form, shippingAddress: billingText(form) } : form
      const fields = Object.fromEntries(
        Object.entries(values).filter(([k]) => k !== 'kind' && k !== 'openingBalanceSupplier').map(([k, v]) => [k, v.trim()]),
      )
      const body = { companyId, ...fields }
      const target = form.kind as SavedKind
      if (editing) {
        // Edit saves the record itself; the server syncs a linked counterpart.
        await apiPatch(`${kind === 'customer' ? '/api/customers' : '/api/suppliers'}/${editing.id}`, body)
        // Turning a single customer/supplier into "Both" creates its linked counterpart.
        if (target === 'both' && !isBothParty(editing)) await apiPost('/api/parties', { companyId, linkFrom: { kind, id: editing.id } })
        toast.success(target === 'both' && !isBothParty(editing) ? 'Party updated and added on the other side too' : 'Party updated')
      } else if (target === 'both') {
        await apiPost('/api/parties', { ...body, openingBalanceSupplier: form.openingBalanceSupplier.trim() })
        toast.success('Party added as customer and supplier')
      } else {
        await apiPost(target === 'customer' ? '/api/customers' : '/api/suppliers', body)
        toast.success(`${target === 'customer' ? 'Customer' : 'Supplier'} added`)
      }
      onOpenChange(false)
      onSaved(target)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save party')
    } finally {
      setSaving(false)
    }
  }

  const label = form.kind === 'both' ? 'Party' : form.kind === 'customer' ? 'Customer' : 'Supplier'
  const linked = !!editing && isBothParty(editing)
  const typeOptions = [
    { value: 'customer', label: 'Customer' },
    { value: 'supplier', label: 'Supplier' },
    { value: 'both', label: 'Both (Customer + Supplier)' },
  ].filter((o) => !editing || o.value === kind || o.value === 'both')
  const stateOptions = [{ value: '', label: '— Select state —' }, ...GST_STATES.map((s) => ({ value: s.name, label: `${s.name} (${s.code})` }))]
  if (form.state && !stateByCode(form.stateCode) && !GST_STATES.some((s) => s.name === form.state)) stateOptions.push({ value: form.state, label: form.state })

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={editing ? `Edit ${label}` : 'Party'}
      description={editing ? `Updating ${editing.code}` : 'Add a customer or supplier to the party master'}
      onSubmit={submit}
      loading={saving}
      submitLabel={editing ? 'Update' : 'Save'}
      wide
    >
      <div className="grid gap-4">
        <Section icon={User} title="Party Details" hint="Legal name and primary contact for this party">
          <Field label="Party Name" required className="sm:col-span-2">
            <TextInput value={form.name} onChange={(e) => onName(e.target.value)} placeholder="Precision Tools Pvt Ltd" />
            <Hint>As per GST records</Hint>
          </Field>
          <Field label="Nick Name">
            <TextInput value={form.nickName} onChange={(e) => { setNickTouched(true); set('nickName')(e.target.value) }} />
            <Hint>Short name — auto-suggested from the party name; editable</Hint>
          </Field>
          <Field label="Type" required>
            <SelectInput value={form.kind} onChange={set('kind')} disabled={linked} options={typeOptions} />
            {form.kind === 'both' && !linked && <Hint>Saved in both Customers and Suppliers; edits stay in sync</Hint>}
            {linked && <Hint>Also a {kind === 'customer' ? 'supplier' : 'customer'}{(editing?.supplier?.code || editing?.customer?.code) ? ` (${editing?.supplier?.code || editing?.customer?.code})` : ''} — details stay in sync</Hint>}
          </Field>
          <Field label="Code">
            <TextInput {...input('code')} placeholder={editing ? '' : 'Auto'} />
            {!editing && <Hint>Leave blank to auto-number ({form.kind === 'supplier' ? 'S-0001' : form.kind === 'both' ? 'C-0001 + S-0001' : 'C-0001'}…)</Hint>}
          </Field>
          <Field label="Contact Person"><TextInput {...input('contactPerson')} /></Field>
          <Field label="Phone">
            <TextInput {...input('phone')} inputMode="tel" maxLength={14} />
            <Hint>10-digit mobile</Hint>
          </Field>
          <Field label="Alt Phone"><TextInput {...input('altPhone')} inputMode="tel" maxLength={14} /></Field>
          <Field label="Email"><TextInput {...input('email')} type="email" /></Field>
          <Field label="GSTIN">
            <TextInput value={form.gstin} onChange={(e) => onGstin(e.target.value)} className="font-mono uppercase" maxLength={15} placeholder="27ABCDE1234F1Z5" />
            <Hint>Fills PAN + state code automatically</Hint>
          </Field>
          <Field label="GST Type">
            <SelectInput value={form.gstType} onChange={set('gstType')} options={GST_TYPE_OPTIONS} />
            {['REGULAR', 'COMPOSITION', 'SEZ'].includes(form.gstType) && !form.gstin.trim() && <Hint>GSTIN is required for this type</Hint>}
          </Field>
          <Field label="PAN">
            <TextInput value={form.pan} onChange={(e) => set('pan')(e.target.value.toUpperCase())} className="font-mono uppercase" maxLength={10} />
            <Hint>5 letters, 4 digits, 1 letter</Hint>
          </Field>
          <Field label="GST State Code">
            <TextInput {...input('stateCode')} maxLength={2} placeholder="—" />
            <Hint>Auto from GSTIN or State</Hint>
          </Field>
          {editing && (
            <Field label="Status">
              <SelectInput value={form.status} onChange={set('status')} options={[{ value: 'ACTIVE', label: 'Active' }, { value: 'INACTIVE', label: 'Inactive' }]} />
            </Field>
          )}
        </Section>

        <Section icon={Landmark} title="Bank Details" hint={form.kind === 'customer' ? 'Shown on the party statement' : 'Used for vendor payments and on the party statement'}>
          <Field label="IFSC Code">
            <div className="relative">
              <TextInput value={form.bankIfsc} onChange={(e) => void onIfsc(e.target.value)} className="font-mono uppercase" maxLength={11} placeholder="HDFC0001234" />
              {ifscLooking && <Loader2 className="absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground" />}
            </div>
            <Hint>Fills the bank name automatically</Hint>
          </Field>
          <Field label="Bank Name"><TextInput {...input('bankName')} /></Field>
          <Field label="Bank Account No."><TextInput {...input('bankAccountNo')} inputMode="numeric" maxLength={18} /></Field>
          <Field label="Branch"><TextInput {...input('bankBranch')} /></Field>
        </Section>

        <Section icon={MapPin} title="Address" hint="Billing address shown on quotations and invoices">
          <Field label="Address Line 1" className="sm:col-span-2"><TextInput {...input('addressLine')} /></Field>
          <Field label="Address Line 2" className="sm:col-span-2"><TextInput {...input('addressLine2')} /></Field>
          <Field label="City"><TextInput {...input('city')} /></Field>
          <Field label="State"><SelectInput value={form.state} onChange={onState} options={stateOptions} /></Field>
          <Field label="Pincode">
            <TextInput {...input('pincode')} inputMode="numeric" maxLength={6} />
            <Hint>6-digit PIN</Hint>
          </Field>
          <Field label="Country"><TextInput {...input('country')} /></Field>
          <Field label="Shipping Address" className="sm:col-span-2">
            <Textarea
              value={sameShipping ? billingText(form) : form.shippingAddress}
              onChange={(e) => set('shippingAddress')(e.target.value)}
              disabled={sameShipping}
              rows={3}
              placeholder="Delivery address, if different from billing"
            />
            <label className="flex w-fit cursor-pointer items-center gap-2 text-xs text-muted-foreground">
              <Checkbox
                checked={sameShipping}
                onCheckedChange={(v) => {
                  const on = v === true
                  setSameShipping(on)
                  if (on) setForm((f) => ({ ...f, shippingAddress: billingText(f) }))
                }}
              />
              Same as billing
            </label>
          </Field>
        </Section>

        <Section icon={Wallet} title="Commercial" hint="Credit terms and opening balance for the party ledger">
          <Field label="Credit Limit">
            <TextInput {...input('creditLimit')} type="number" min={0} />
            <Hint>Maximum outstanding allowed (₹)</Hint>
          </Field>
          <Field label="Credit Days">
            <TextInput {...input('paymentTermsDays')} type="number" min={0} />
            <Hint>Payment due window</Hint>
          </Field>
          <Field label={form.kind === 'both' && !editing ? 'Opening Balance (receivable)' : 'Opening Balance'}>
            <TextInput {...input('openingBalance')} type="number" />
            <Hint>{(editing ? kind : form.kind) === 'supplier' ? 'Amount you owe the supplier (₹), carried forward' : 'Amount the party owes you (₹), carried forward'}</Hint>
          </Field>
          <Field label="Tally ledger name" className="sm:col-span-2">
            <TextInput {...input('tallyLedgerName')} aria-label="Tally ledger name" maxLength={100} placeholder={form.name.trim() || 'Same as the party name'} />
            <Hint>
              The account this party is posted to in Tally — used by the Tally import file and the masters download.
              Leave blank to use the party name.
            </Hint>
          </Field>
          {form.kind === 'both' && !editing && (
            <Field label="Opening Balance (payable)">
              <TextInput {...input('openingBalanceSupplier')} type="number" />
              <Hint>Amount you owe this party as a supplier (₹)</Hint>
            </Field>
          )}
        </Section>

        <section className="rounded-xl border p-4">
          <div className="mb-4 flex items-start gap-3">
            <div className="rounded-lg bg-emerald-50 p-2 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"><FileText className="h-4 w-4" /></div>
            <div>
              <p className="text-sm font-semibold leading-tight">Notes</p>
              <p className="text-xs text-muted-foreground">Internal remarks — never printed on documents</p>
            </div>
          </div>
          <Textarea value={form.notes} onChange={(e) => set('notes')(e.target.value)} rows={3} />
        </section>
      </div>
    </FormDialog>
  )
}
