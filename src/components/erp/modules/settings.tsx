'use client'

import * as React from 'react'
import { AlertTriangle, CheckCheck, Download, Hash, ImagePlus, Save, ShieldCheck, Trash2, Upload } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { Column, DataTable, Field, PageHeader, SectionCard, StatusBadge, TextInput } from '@/components/erp/kit'
import { fmtDateTime } from '@/lib/erp-constants'
import { api, apiPatch, useList } from '@/lib/use-api'
import { TALLY_IMPORT_BAT_PATH } from '@/lib/tally/masters'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'

interface CompanyProfile {
  id: string
  name: string
  gstin?: string | null
  pan?: string | null
  addressLine?: string | null
  city?: string | null
  state?: string | null
  stateCode?: string | null
  phone?: string | null
  email?: string | null
  logoText?: string | null
  bankAccountName?: string | null
  bankAccountNumber?: string | null
  bankIfsc?: string | null
  bankUpiId?: string | null
  bankName?: string | null
  bankBranch?: string | null
  pincode?: string | null
  invoiceTerms?: string | null
  quotationTerms?: string | null
  tallyCompanyName?: string | null
  tallySalesLedger?: string | null
  tallyCgstLedger?: string | null
  tallySgstLedger?: string | null
  tallyIgstLedger?: string | null
  tallyFreightLedger?: string | null
  tallyRoundOffLedger?: string | null
  logoImage?: string | null
  signatureImage?: string | null
  roundOffTotals?: boolean
  lockEnabled?: boolean
}

type ProfileForm = { [K in keyof Omit<CompanyProfile, 'id' | 'logoImage' | 'signatureImage' | 'roundOffTotals' | 'lockEnabled'>]: string }

const EMPTY_PROFILE: ProfileForm = {
  name: '', gstin: '', pan: '', addressLine: '', city: '', state: '', stateCode: '', phone: '', email: '', logoText: '',
  bankAccountName: '', bankAccountNumber: '', bankIfsc: '', bankUpiId: '', bankName: '', bankBranch: '',
  pincode: '', invoiceTerms: '', quotationTerms: '',
  tallyCompanyName: '', tallySalesLedger: '', tallyCgstLedger: '', tallySgstLedger: '',
  tallyIgstLedger: '', tallyFreightLedger: '', tallyRoundOffLedger: '',
}

interface SeqRow {
  id: string
  docType: string
  prefix: string
  financialYear: string
  nextNumber: number
}

interface PrefixRow {
  docType: string
  defaultPrefix: string
  prefix: string
}

const DOC_LABELS: Record<string, string> = {
  INV: 'Sales Invoice', PINV: 'Purchase Invoice', SO: 'Sales Order', PO: 'Purchase Order', QT: 'Quotation',
  ENQ: 'Enquiry', DN: 'Delivery Challan', GRN: 'Goods Receipt (GRN)', PR: 'Purchase Requisition', WO: 'Work Order',
  MI: 'Material Issue', QC: 'Quality Check', RCPT: 'Payment In', PYMT: 'Payment Out', EXP: 'Expense',
  TRF: 'Stock Transfer', ADJ: 'Stock Adjustment', SRET: 'Credit Note (Sales Return)', PRET: 'Debit Note (Purchase Return)',
}

/** Current Indian financial year as used in document numbers, e.g. "2627" for Apr 2026 – Mar 2027. */
function currentFy(d: Date = new Date()): string {
  const start = d.getMonth() + 1 >= 4 ? d.getFullYear() : d.getFullYear() - 1
  return `${String(start % 100).padStart(2, '0')}${String((start + 1) % 100).padStart(2, '0')}`
}

/**
 * Read a PNG/JPG file, downscale it so the longest side is at most `maxSide` px and return a data URL:
 * PNG (keeps transparency) unless that is over 400 KB, then JPEG at 0.85 on a white background.
 */
async function shrinkImage(file: File, maxSide: number): Promise<string> {
  if (!/^image\/(png|jpeg)$/.test(file.type)) throw new Error('Choose a PNG or JPG image')
  const url = URL.createObjectURL(file)
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image()
      i.onload = () => resolve(i)
      i.onerror = () => reject(new Error('Could not read the image'))
      i.src = url
    })
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth || 1, img.naturalHeight || 1))
    const w = Math.max(1, Math.round(img.naturalWidth * scale))
    const h = Math.max(1, Math.round(img.naturalHeight * scale))
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Image processing is not supported in this browser')
    ctx.drawImage(img, 0, 0, w, h)
    let out = canvas.toDataURL('image/png')
    if (out.length * 0.75 > 400_000) {
      // JPEG has no transparency: paint white behind the image first
      ctx.globalCompositeOperation = 'destination-over'
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, w, h)
      out = canvas.toDataURL('image/jpeg', 0.85)
    }
    if (out.length > 700_000) throw new Error('Image is too large even after resizing — use a smaller image')
    return out
  } finally {
    URL.revokeObjectURL(url)
  }
}

function ImageUpload({ label, hint, value, maxSide, onChange }: {
  label: string
  hint: string
  value: string
  maxSide: number
  onChange: (dataUrl: string) => void
}) {
  const ref = React.useRef<HTMLInputElement>(null)
  const [busy, setBusy] = React.useState(false)

  async function pick(file: File | undefined) {
    if (!file) return
    setBusy(true)
    try {
      onChange(await shrinkImage(file, maxSide))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not load the image')
    } finally {
      setBusy(false)
      if (ref.current) ref.current.value = ''
    }
  }

  return (
    <Field label={label}>
      <button
        type="button"
        onClick={() => ref.current?.click()}
        disabled={busy}
        className="flex h-36 w-full items-center justify-center rounded-lg border border-dashed bg-muted/30 p-3 transition-colors hover:bg-muted/60 disabled:opacity-60"
      >
        {value ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={value} alt={label} className="max-h-full max-w-full object-contain" />
        ) : (
          <span className="flex flex-col items-center gap-1.5 text-xs text-muted-foreground">
            <ImagePlus className="h-5 w-5" />
            {busy ? 'Processing…' : 'Click to choose PNG / JPG'}
          </span>
        )}
      </button>
      <input ref={ref} type="file" accept="image/png,image/jpeg" className="hidden" onChange={(e) => void pick(e.target.files?.[0])} />
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] text-muted-foreground">{hint}</p>
        {value && (
          <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-xs text-destructive" onClick={() => onChange('')}>
            <Trash2 className="h-3.5 w-3.5 mr-1" />Remove
          </Button>
        )}
      </div>
    </Field>
  )
}

interface NotificationRow {
  id: string
  title: string
  message?: string | null
  level: string
  read: boolean
  createdAt: string
}

/** Settings → Security: document-lock PIN (admins only). */
function SecuritySection({ companyId, enabled, isAdmin, onSaved }: {
  companyId: string; enabled: boolean; isAdmin: boolean; onSaved: () => void | Promise<void>
}) {
  const [on, setOn] = React.useState(enabled)
  const [currentPin, setCurrentPin] = React.useState('')
  const [newPin, setNewPin] = React.useState('')
  const [confirmPin, setConfirmPin] = React.useState('')
  const [saving, setSaving] = React.useState(false)

  React.useEffect(() => { setOn(enabled) }, [enabled])

  const digits = (v: string) => v.replace(/\D/g, '').slice(0, 6)
  const changingPin = newPin !== '' || confirmPin !== ''
  const dirty = on !== enabled || changingPin

  async function save() {
    const body: Record<string, unknown> = { companyId }
    if (on !== enabled) body.lockEnabled = on
    if (on && (changingPin || !enabled)) {
      if (!/^\d{4,6}$/.test(newPin)) { toast.error('PIN must be 4 to 6 digits'); return }
      if (newPin !== confirmPin) { toast.error('PINs do not match'); return }
      body.newPin = newPin
    }
    if (enabled) {
      if (!currentPin) { toast.error('Enter the current PIN'); return }
      body.currentPin = currentPin
    }
    setSaving(true)
    try {
      await apiPatch('/api/settings', body)
      toast.success(!on ? 'Security PIN turned off' : enabled ? 'Security PIN changed' : 'Security PIN turned on')
      setCurrentPin(''); setNewPin(''); setConfirmPin('')
      await onSaved()
    } catch (e) {
      toast.error('Could not update security PIN', { description: e instanceof Error ? e.message : undefined })
    } finally {
      setSaving(false)
    }
  }

  const pinInput = (value: string, set: (v: string) => void, placeholder: string) => (
    <TextInput
      type="password" inputMode="numeric" autoComplete="new-password" maxLength={6}
      placeholder={placeholder} value={value} onChange={(e) => set(digits(e.target.value))} disabled={!isAdmin}
    />
  )

  return (
    <SectionCard
      title="Security"
      actions={isAdmin ? (
        <Button size="sm" onClick={() => void save()} disabled={saving || !dirty}>
          <Save className="h-4 w-4 mr-1.5" />
          {saving ? 'Saving…' : 'Save'}
        </Button>
      ) : undefined}
    >
      <label className="flex cursor-pointer items-center justify-between gap-4">
        <span className="flex items-center gap-2 text-sm">
          <ShieldCheck className="h-4 w-4 text-success" /> Require a security PIN for changes to saved documents
        </span>
        <Switch checked={on} onCheckedChange={(v) => setOn(v === true)} disabled={!isAdmin} />
      </label>
      <p className="text-xs text-muted-foreground mt-2">
        Staff need this PIN to cancel, delete or edit saved bills, payments and returns.
        {!isAdmin && ' Only an admin can change this setting.'}
      </p>
      {isAdmin && (on || enabled) && (
        <div className="grid gap-3 sm:grid-cols-3 mt-4">
          {enabled && <Field label="Current PIN">{pinInput(currentPin, setCurrentPin, 'Current PIN')}</Field>}
          {on && <Field label={enabled ? 'New PIN (optional)' : 'New PIN'}>{pinInput(newPin, setNewPin, '4–6 digits')}</Field>}
          {on && <Field label="Confirm new PIN">{pinInput(confirmPin, setConfirmPin, 'Repeat PIN')}</Field>}
        </div>
      )}
    </SectionCard>
  )
}

export default function SettingsModule({ companyId }: { companyId: string }) {
  const settings = useList<CompanyProfile>(`/api/settings?companyId=${companyId}`)
  const numbering = useList<{ seqs?: SeqRow[]; prefixes?: PrefixRow[] }>(`/api/numbering?companyId=${companyId}`)
  const notifications = useList<{ items?: NotificationRow[]; unreadCount?: number }>(`/api/notifications?companyId=${companyId}`)

  const [form, setForm] = React.useState<ProfileForm>(EMPTY_PROFILE)
  const [logoImage, setLogoImage] = React.useState('')
  const [signatureImage, setSignatureImage] = React.useState('')
  const [roundOffTotals, setRoundOffTotals] = React.useState(true)
  const [prefixDraft, setPrefixDraft] = React.useState<Record<string, string>>({})
  const [savingPrefixes, setSavingPrefixes] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [markingAll, setMarkingAll] = React.useState(false)
  const [downloading, setDownloading] = React.useState(false)
  const [downloadingMasters, setDownloadingMasters] = React.useState(false)

  const isAdmin = React.useMemo(() => {
    try {
      const raw = window.localStorage.getItem('erp_user')
      const role = raw ? (JSON.parse(raw) as { user?: { role?: string } }).user?.role || '' : ''
      return ['TENANT_ADMIN', 'MANAGEMENT', 'SUPER_ADMIN'].includes(role)
    } catch { return false }
  }, [])

  React.useEffect(() => {
    const d = settings.data
    if (d) {
      setForm({
        name: d.name || '',
        gstin: d.gstin || '',
        pan: d.pan || '',
        addressLine: d.addressLine || '',
        city: d.city || '',
        state: d.state || '',
        stateCode: d.stateCode || '',
        phone: d.phone || '',
        email: d.email || '',
        logoText: d.logoText || '',
        bankAccountName: d.bankAccountName || '',
        bankAccountNumber: d.bankAccountNumber || '',
        bankIfsc: d.bankIfsc || '',
        bankUpiId: d.bankUpiId || '',
        bankName: d.bankName || '',
        bankBranch: d.bankBranch || '',
        pincode: d.pincode || '',
        invoiceTerms: d.invoiceTerms || '',
        quotationTerms: d.quotationTerms || '',
        tallyCompanyName: d.tallyCompanyName || '',
        tallySalesLedger: d.tallySalesLedger || '',
        tallyCgstLedger: d.tallyCgstLedger || '',
        tallySgstLedger: d.tallySgstLedger || '',
        tallyIgstLedger: d.tallyIgstLedger || '',
        tallyFreightLedger: d.tallyFreightLedger || '',
        tallyRoundOffLedger: d.tallyRoundOffLedger || '',
      })
      setLogoImage(d.logoImage || '')
      setSignatureImage(d.signatureImage || '')
      setRoundOffTotals(d.roundOffTotals ?? true)
    }
  }, [settings.data])

  React.useEffect(() => {
    const rows = numbering.data?.prefixes
    if (rows) setPrefixDraft(Object.fromEntries(rows.map((r) => [r.docType, r.prefix === r.defaultPrefix ? '' : r.prefix])))
  }, [numbering.data])

  async function savePrefixes() {
    const rows = numbering.data?.prefixes ?? []
    const prefixes = Object.fromEntries(rows.map((r) => [r.docType, (prefixDraft[r.docType] ?? '').trim().toUpperCase()]))
    const bad = Object.entries(prefixes).find(([, p]) => p && !/^[A-Z0-9/]{1,10}$/.test(p))
    if (bad) {
      toast.error(`Prefix for ${DOC_LABELS[bad[0]] ?? bad[0]} may use A–Z, 0–9 and / (max 10)`)
      return
    }
    setSavingPrefixes(true)
    try {
      await apiPatch('/api/numbering', { companyId, prefixes })
      toast.success('Document prefixes saved')
      await numbering.refetch()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save document prefixes')
    } finally {
      setSavingPrefixes(false)
    }
  }

  async function saveProfile() {
    if (!form.name.trim()) {
      toast.error('Company name is required')
      return
    }
    const pin = (form.pincode ?? '').trim()
    if (pin && !/^\d{6}$/.test(pin)) {
      toast.error('Pincode must be 6 digits')
      return
    }
    setSaving(true)
    try {
      await apiPatch('/api/settings', {
        companyId, ...form, name: form.name.trim(),
        logoImage: logoImage || null, signatureImage: signatureImage || null, roundOffTotals,
        userName: 'admin',
      })
      toast.success('Company profile updated')
      await settings.refetch()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to update company profile')
    } finally {
      setSaving(false)
    }
  }

  async function markAllRead() {
    setMarkingAll(true)
    try {
      await apiPatch('/api/notifications', { companyId, all: true })
      toast.success('All notifications marked as read')
      await notifications.refetch()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to mark notifications read')
    } finally {
      setMarkingAll(false)
    }
  }

  async function downloadBackup(): Promise<boolean> {
    setDownloading(true)
    try {
      // Plain fetch (api() helper expects the ok() envelope, the backup returns a
      // raw JSON attachment); the session cookie identifies the caller.
      const res = await fetch(`/api/companies/${companyId}/backup?companyId=${companyId}`, { credentials: 'same-origin' })
      if (!res.ok) {
        let msg = `Backup failed (${res.status})`
        try {
          const j = (await res.json()) as { error?: { message?: string } }
          if (j?.error?.message) msg = j.error.message
        } catch { /* non-JSON error */ }
        throw new Error(msg)
      }
      const blob = await res.blob()
      const cd = res.headers.get('content-disposition') || ''
      const m = cd.match(/filename="([^"]+)"/)
      const d = new Date()
      const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = m?.[1] || `manuflow-backup-${companyId}-${ymd}.json`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
      toast.success(`Backup downloaded (${(blob.size / 1024).toFixed(1)} KB)`)
      return true
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Backup download failed')
      return false
    } finally {
      setDownloading(false)
    }
  }

  /** All Masters file for TallyPrime: the ledgers, GST ledgers, units and Sundry Debtors that every imported voucher names. */
  async function downloadMasters() {
    setDownloadingMasters(true)
    try {
      const res = await fetch(`/api/tally/masters?companyId=${encodeURIComponent(companyId)}`, { credentials: 'same-origin' })
      if (!res.ok) {
        let msg = `Masters file failed (${res.status})`
        try {
          const j = (await res.json()) as { error?: { message?: string } }
          if (j?.error?.message) msg = j.error.message
        } catch { /* non-JSON error */ }
        throw new Error(msg)
      }
      const blob = await res.blob()
      const named = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '')?.[1]
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = named || 'tally-masters.xml'
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
      toast.success('Tally masters downloaded', { description: `${a.download} — import it once in TallyPrime (Import Data → Masters).` })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not build the Tally masters file')
    } finally {
      setDownloadingMasters(false)
    }
  }

  // ---------- Restore from a backup file ----------
  type BackupFile = { meta?: { companyId?: string; companyName?: string; exportedAt?: string; version?: number; counts?: Record<string, number> }; data?: unknown }
  const fileRef = React.useRef<HTMLInputElement>(null)
  const [restoreFile, setRestoreFile] = React.useState<{ name: string; json: BackupFile } | null>(null)
  const [restoreConfirm, setRestoreConfirm] = React.useState('')
  const [restoring, setRestoring] = React.useState(false)

  async function pickBackup(file: File | undefined) {
    if (!file) return
    try {
      // Daily server backups are gzipped (.json.gz) — unzip in the browser
      const text = file.name.endsWith('.gz')
        ? await new Response(file.stream().pipeThrough(new DecompressionStream('gzip'))).text()
        : await file.text()
      const json = JSON.parse(text) as BackupFile
      if (!json?.meta || !json.data) throw new Error('This is not a ManuFlow backup file')
      if (json.meta.companyId !== companyId) throw new Error(`This backup is of "${json.meta.companyName ?? 'another company'}" — it can only be restored into that company`)
      setRestoreConfirm('')
      setRestoreFile({ name: file.name, json })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not read the backup file')
    } finally {
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  async function runRestore() {
    if (!restoreFile) return
    setRestoring(true)
    try {
      // Safety net: take a backup of the current data first
      if (!(await downloadBackup())) throw new Error('Could not back up the current data — restore stopped')
      const res = await api<{ restored: number }>(`/api/companies/${companyId}/restore`, {
        method: 'POST',
        body: JSON.stringify({ confirmName: restoreConfirm.trim(), backup: restoreFile.json }),
      })
      toast.success(`Backup restored — ${res.restored} records. Reloading…`)
      setRestoreFile(null)
      setTimeout(() => window.location.reload(), 1200)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Restore failed')
    } finally {
      setRestoring(false)
    }
  }

  const seqColumns: Column<SeqRow>[] = [
    { key: 'docType', header: 'Doc Type', render: (r) => <span className="font-mono text-xs font-semibold">{r.docType}</span> },
    { key: 'prefix', header: 'Prefix', render: (r) => <span className="font-mono text-xs">{r.prefix}</span> },
    { key: 'fy', header: 'Financial Year', render: (r) => <span className="font-mono text-xs">{r.financialYear}</span> },
    { key: 'next', header: 'Next Number', className: 'text-right', render: (r) => <span className="tabular-nums">{r.nextNumber}</span> },
    {
      key: 'sample',
      header: 'Next Document No',
      render: (r) => <span className="font-mono text-xs">{`${r.prefix}-${r.financialYear}-${String(r.nextNumber).padStart(6, '0')}`}</span>,
    },
  ]

  const unread = notifications.data?.unreadCount ?? 0
  const notificationItems = notifications.data?.items ?? []

  return (
    <div>
      <PageHeader title="Settings" description="Company profile, document numbering and notifications" />

      <div className="space-y-4">
        <SectionCard
          title="Company Profile"
          actions={
            <Button size="sm" onClick={() => void saveProfile()} disabled={saving}>
              <Save className="h-4 w-4 mr-1.5" />
              {saving ? 'Saving…' : 'Save'}
            </Button>
          }
        >
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="Company Name" required className="sm:col-span-2 lg:col-span-3">
              <TextInput
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="Acme Precision Manufacturing Pvt Ltd"
              />
            </Field>
            <Field label="GSTIN">
              <TextInput
                value={form.gstin}
                onChange={(e) => setForm((f) => ({ ...f, gstin: e.target.value }))}
                placeholder="27ABCDE1234F1Z5"
              />
            </Field>
            <Field label="PAN">
              <TextInput
                value={form.pan}
                onChange={(e) => setForm((f) => ({ ...f, pan: e.target.value }))}
                placeholder="ABCDE1234F"
              />
            </Field>
            <Field label="Logo Text">
              <TextInput
                value={form.logoText}
                onChange={(e) => setForm((f) => ({ ...f, logoText: e.target.value }))}
                placeholder="ACME"
              />
            </Field>
            <Field label="Address" className="sm:col-span-2">
              <TextInput
                value={form.addressLine}
                onChange={(e) => setForm((f) => ({ ...f, addressLine: e.target.value }))}
                placeholder="Plot 14, MIDC Industrial Area"
              />
            </Field>
            <Field label="City">
              <TextInput value={form.city} onChange={(e) => setForm((f) => ({ ...f, city: e.target.value }))} placeholder="Pune" />
            </Field>
            <Field label="State">
              <TextInput
                value={form.state}
                onChange={(e) => setForm((f) => ({ ...f, state: e.target.value }))}
                placeholder="Maharashtra"
              />
            </Field>
            <Field label="Pincode">
              <TextInput
                inputMode="numeric"
                maxLength={6}
                value={form.pincode}
                onChange={(e) => setForm((f) => ({ ...f, pincode: e.target.value.replace(/\D/g, '') }))}
                placeholder="411018"
              />
            </Field>
            <Field label="State Code">
              <TextInput
                value={form.stateCode}
                onChange={(e) => setForm((f) => ({ ...f, stateCode: e.target.value }))}
                placeholder="27"
              />
            </Field>
            <Field label="Phone">
              <TextInput value={form.phone} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} placeholder="+91 98200 00000" />
            </Field>
            <Field label="Email">
              <TextInput
                type="email"
                value={form.email}
                onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                placeholder="accounts@acme.in"
              />
            </Field>
          </div>
          <p className="text-xs text-muted-foreground mt-4">
            State code drives the GST split — same-state parties get CGST + SGST, other states get IGST.
          </p>
        </SectionCard>

        <SectionCard
          title="Tally export"
          actions={
            <Button size="sm" onClick={() => void saveProfile()} disabled={saving}>
              <Save className="h-4 w-4 mr-1.5" />
              {saving ? 'Saving…' : 'Save'}
            </Button>
          }
        >
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="Tally company name" className="sm:col-span-2 lg:col-span-3">
              <TextInput
                value={form.tallyCompanyName}
                onChange={(e) => setForm((f) => ({ ...f, tallyCompanyName: e.target.value }))}
                placeholder="Exactly as it reads in TallyPrime (optional)"
              />
            </Field>
            <Field label="Sales ledger">
              <TextInput value={form.tallySalesLedger} onChange={(e) => setForm((f) => ({ ...f, tallySalesLedger: e.target.value }))} placeholder="Sales" />
            </Field>
            <Field label="CGST ledger">
              <TextInput value={form.tallyCgstLedger} onChange={(e) => setForm((f) => ({ ...f, tallyCgstLedger: e.target.value }))} placeholder="Central Tax on Sales @ 9%" />
            </Field>
            <Field label="SGST ledger">
              <TextInput value={form.tallySgstLedger} onChange={(e) => setForm((f) => ({ ...f, tallySgstLedger: e.target.value }))} placeholder="State Tax on Sales @ 9%" />
            </Field>
            <Field label="IGST ledger">
              <TextInput value={form.tallyIgstLedger} onChange={(e) => setForm((f) => ({ ...f, tallyIgstLedger: e.target.value }))} placeholder="Integrated Tax on Sales @ 18%" />
            </Field>
            <Field label="Freight ledger">
              <TextInput value={form.tallyFreightLedger} onChange={(e) => setForm((f) => ({ ...f, tallyFreightLedger: e.target.value }))} placeholder="Transport & Freight Charges" />
            </Field>
            <Field label="Round-off ledger">
              <TextInput value={form.tallyRoundOffLedger} onChange={(e) => setForm((f) => ({ ...f, tallyRoundOffLedger: e.target.value }))} placeholder="Round Off" />
            </Field>
          </div>
          <p className="text-xs text-muted-foreground mt-4">
            Used by the Tally import file on every sales invoice. Tally never creates a master on import, so these
            names must match the ledgers of that Tally company exactly. Blank = the standard default.
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" asChild>
              <a href={TALLY_IMPORT_BAT_PATH} download="Tally-Import.bat">
                <Download className="h-4 w-4 mr-1.5" />Tally importer (.bat)
              </a>
            </Button>
            <Button size="sm" variant="outline" onClick={() => void downloadMasters()} disabled={downloadingMasters}>
              <Download className="h-4 w-4 mr-1.5" />{downloadingMasters ? 'Building…' : 'Tally masters (XML)'}
            </Button>
            <span className="text-xs text-muted-foreground">
              Drag an invoice XML onto the .bat to post it straight into Tally; import the masters file once.
            </span>
          </div>
        </SectionCard>

        <SectionCard
          title="Logo & Signature"
          actions={
            <Button size="sm" onClick={() => void saveProfile()} disabled={saving}>
              <Save className="h-4 w-4 mr-1.5" />
              {saving ? 'Saving…' : 'Save'}
            </Button>
          }
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <ImageUpload label="Company Logo" hint="Printed on quotations, invoices and other documents" value={logoImage} maxSide={400} onChange={setLogoImage} />
            <ImageUpload label="Authorised Signature" hint="Printed above “Authorised Signatory” on invoices" value={signatureImage} maxSide={300} onChange={setSignatureImage} />
          </div>
          <p className="text-xs text-muted-foreground mt-4">
            Images are resized automatically. Click Save to apply changes.
          </p>
        </SectionCard>

        <SectionCard
          title="Billing Preferences"
          actions={
            <Button size="sm" onClick={() => void saveProfile()} disabled={saving}>
              <Save className="h-4 w-4 mr-1.5" />
              {saving ? 'Saving…' : 'Save'}
            </Button>
          }
        >
          <label className="flex cursor-pointer items-center justify-between gap-4">
            <span className="text-sm">Round off invoice &amp; bill totals to the nearest rupee</span>
            <Switch checked={roundOffTotals} onCheckedChange={(v) => setRoundOffTotals(v === true)} />
          </label>
        </SectionCard>

        <SecuritySection companyId={companyId} enabled={!!settings.data?.lockEnabled} isAdmin={isAdmin} onSaved={settings.refetch} />

        <SectionCard
          title="Bank Details"
          actions={
            <Button size="sm" onClick={() => void saveProfile()} disabled={saving}>
              <Save className="h-4 w-4 mr-1.5" />
              {saving ? 'Saving…' : 'Save'}
            </Button>
          }
        >
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="Account Holder Name">
              <TextInput
                value={form.bankAccountName}
                onChange={(e) => setForm((f) => ({ ...f, bankAccountName: e.target.value }))}
                placeholder="Acme Precision Industries Pvt Ltd"
              />
            </Field>
            <Field label="Account Number">
              <TextInput
                inputMode="numeric"
                value={form.bankAccountNumber}
                onChange={(e) => setForm((f) => ({ ...f, bankAccountNumber: e.target.value }))}
                placeholder="50200076543210"
              />
            </Field>
            <Field label="IFSC Code">
              <TextInput
                value={form.bankIfsc}
                onChange={(e) => setForm((f) => ({ ...f, bankIfsc: e.target.value.toUpperCase() }))}
                placeholder="HDFC0001234"
              />
            </Field>
            <Field label="Bank Name">
              <TextInput
                value={form.bankName}
                onChange={(e) => setForm((f) => ({ ...f, bankName: e.target.value }))}
                placeholder="HDFC Bank"
              />
            </Field>
            <Field label="Branch">
              <TextInput
                value={form.bankBranch}
                onChange={(e) => setForm((f) => ({ ...f, bankBranch: e.target.value }))}
                placeholder="Bhosari, Pune"
              />
            </Field>
            <Field label="UPI ID">
              <TextInput
                value={form.bankUpiId}
                onChange={(e) => setForm((f) => ({ ...f, bankUpiId: e.target.value }))}
                placeholder="acmeprecision@hdfcbank"
              />
            </Field>
          </div>
          <p className="text-xs text-muted-foreground mt-4">
            Shown on printed GST invoices.
          </p>
        </SectionCard>

        <SectionCard
          title="Document Terms"
          actions={
            <Button size="sm" onClick={() => void saveProfile()} disabled={saving}>
              <Save className="h-4 w-4 mr-1.5" />
              {saving ? 'Saving…' : 'Save'}
            </Button>
          }
        >
          <div className="grid gap-4 lg:grid-cols-2">
            <Field label="Invoice Terms & Conditions">
              <Textarea
                value={form.invoiceTerms}
                onChange={(e) => setForm((f) => ({ ...f, invoiceTerms: e.target.value }))}
                rows={5}
                placeholder={'1. Goods once sold will not be taken back.\n2. Interest @18% p.a. on overdue bills.\n3. Subject to Pune jurisdiction.'}
              />
            </Field>
            <Field label="Quotation Terms & Conditions">
              <Textarea
                value={form.quotationTerms}
                onChange={(e) => setForm((f) => ({ ...f, quotationTerms: e.target.value }))}
                rows={5}
                placeholder={'1. Prices valid for 30 days.\n2. GST extra as applicable.\n3. Delivery: 2–3 weeks from PO.'}
              />
            </Field>
          </div>
          <p className="text-xs text-muted-foreground mt-4">
            Invoice terms print on tax invoices; quotation terms are the default for new quotations.
          </p>
        </SectionCard>

        {isAdmin && (
          <SectionCard
            title="Data & Backup"
            actions={
              <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={() => void downloadBackup()} disabled={downloading}>
                  <Download className="h-4 w-4 mr-1.5" />
                  {downloading ? 'Preparing…' : 'Download backup (JSON)'}
                </Button>
                <Button size="sm" variant="outline" onClick={() => fileRef.current?.click()} disabled={restoring}>
                  <Upload className="h-4 w-4 mr-1.5" />Restore from backup
                </Button>
                <input ref={fileRef} type="file" accept="application/json,.json,.gz,application/gzip" className="hidden" onChange={(e) => void pickBackup(e.target.files?.[0])} />
              </div>
            }
          >
            <p className="text-sm text-muted-foreground">
              Exports a complete snapshot of this company&apos;s data — masters, transactions, inventory,
              notifications and audit logs — as a single JSON file. Administrators only.
            </p>
            <p className="mt-2 text-sm text-muted-foreground">
              <b>Restore</b> replaces all of this company&apos;s data with a backup of the same company. User logins are not changed.
              A backup of the current data is downloaded automatically first.
            </p>
          </SectionCard>
        )}

        <Dialog open={!!restoreFile} onOpenChange={(o) => { if (!o && !restoring) setRestoreFile(null) }}>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-destructive"><AlertTriangle className="h-5 w-5" />Restore backup?</DialogTitle>
              <DialogDescription>
                All current items, parties, documents, stock and payments of this company will be <b>replaced</b> by the backup. This cannot be undone
                (a copy of the current data downloads first).
              </DialogDescription>
            </DialogHeader>
            {restoreFile && (
              <div className="grid gap-1 rounded-md border bg-muted/40 p-3 text-sm">
                <span>File: <b>{restoreFile.name}</b></span>
                <span>Company: <b>{restoreFile.json.meta?.companyName}</b></span>
                <span>Taken on: <b>{restoreFile.json.meta?.exportedAt ? fmtDateTime(restoreFile.json.meta.exportedAt) : '—'}</b></span>
                <span>Records: <b>{Object.entries(restoreFile.json.meta?.counts ?? {}).filter(([k]) => k !== 'users' && k !== 'company').reduce((t, [, n]) => t + (n || 0), 0)}</b></span>
              </div>
            )}
            <Field label={`Type the company name "${restoreFile?.json.meta?.companyName ?? ''}" to confirm`}>
              <TextInput value={restoreConfirm} onChange={(e) => setRestoreConfirm(e.target.value)} autoComplete="off" />
            </Field>
            <DialogFooter>
              <Button variant="outline" onClick={() => setRestoreFile(null)} disabled={restoring}>Cancel</Button>
              <Button variant="destructive" onClick={() => void runRestore()}
                disabled={restoring || restoreConfirm.trim() !== (restoreFile?.json.meta?.companyName ?? '').trim()}>
                {restoring ? 'Restoring…' : 'Restore now'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <SectionCard
          title="Document Numbering"
          actions={<Hash className="h-4 w-4 text-muted-foreground" />}
        >
          <DataTable
            columns={seqColumns}
            rows={numbering.data?.seqs ?? []}
            loading={numbering.loading}
            emptyText="No sequences yet — created automatically with the first document"
            pageSize={10}
          />
          <p className="text-xs text-muted-foreground mt-3">
            Numbers auto-advance every financial year (Apr–Mar).
          </p>
        </SectionCard>

        <SectionCard
          title="Document Prefixes"
          actions={
            <Button size="sm" onClick={() => void savePrefixes()} disabled={savingPrefixes || !numbering.data?.prefixes?.length}>
              <Save className="h-4 w-4 mr-1.5" />
              {savingPrefixes ? 'Saving…' : 'Save'}
            </Button>
          }
        >
          {numbering.loading && !numbering.data ? (
            <p className="text-sm text-muted-foreground py-4 text-center">Loading…</p>
          ) : (
            <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
              {(numbering.data?.prefixes ?? []).map((r) => {
                const value = prefixDraft[r.docType] ?? ''
                const eff = value.trim() || r.defaultPrefix
                return (
                  <Field key={r.docType} label={DOC_LABELS[r.docType] ?? r.docType}>
                    <TextInput
                      value={value}
                      maxLength={10}
                      className="font-mono uppercase"
                      placeholder={r.defaultPrefix}
                      onChange={(e) => {
                        const v = e.target.value.toUpperCase().replace(/[^A-Z0-9/]/g, '').slice(0, 10)
                        setPrefixDraft((d) => ({ ...d, [r.docType]: v }))
                      }}
                    />
                    <p className="text-[11px] text-muted-foreground">
                      e.g. <span className="font-mono">{`${eff}-${currentFy()}-000001`}</span>
                    </p>
                  </Field>
                )
              })}
            </div>
          )}
          <p className="text-xs text-muted-foreground mt-4">
            Applies to new documents only — existing numbers never change. Leave blank for the default prefix.
          </p>
        </SectionCard>

        <SectionCard
          title="Notifications"
          actions={
            <Button variant="outline" size="sm" onClick={() => void markAllRead()} disabled={markingAll || unread === 0}>
              <CheckCheck className="h-4 w-4 mr-1.5" />
              Mark all read
            </Button>
          }
        >
          <p className="text-sm text-muted-foreground mb-3">
            <span className="font-semibold text-foreground">{unread}</span> unread notification{unread === 1 ? '' : 's'}
            {notificationItems.length > 0 ? ` · showing latest ${notificationItems.length}` : ''}
          </p>
          {notificationItems.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">No notifications</p>
          ) : (
            <div className="divide-y rounded-lg border">
              {notificationItems.map((n) => (
                <div key={n.id} className="flex items-start gap-3 px-3 py-2.5">
                  <span className={`mt-1.5 h-2 w-2 rounded-full shrink-0 ${n.read ? 'bg-muted-foreground/30' : 'bg-info'}`} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium truncate">{n.title}</span>
                      <StatusBadge status={n.level} />
                    </div>
                    {n.message && <p className="text-xs text-muted-foreground mt-0.5">{n.message}</p>}
                  </div>
                  <span className="text-[11px] text-muted-foreground whitespace-nowrap">{fmtDateTime(n.createdAt)}</span>
                </div>
              ))}
            </div>
          )}
        </SectionCard>
      </div>
    </div>
  )
}
