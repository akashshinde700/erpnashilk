'use client'

import * as React from 'react'
import { toast } from 'sonner'
import { Check, Copy, Factory, Loader2, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ConfirmAction, Field, FormDialog, SelectInput, TextInput } from '@/components/erp/kit'
import LoginScreen, { type LoginUser } from '@/components/erp/login-screen'
import { api, apiDelete, apiGet, apiPatch, apiPost, useList, UNAUTHORIZED_EVENT } from '@/lib/use-api'
import { cn } from '@/lib/utils'

// ---------------- types (mirror src/lib/platform.ts orgRow) ----------------

interface OrgRow {
  id: string
  name: string
  slug: string | null
  city: string | null
  gstin: string | null
  admin: { id: string; name: string; email: string; active: boolean } | null
  plan: { id: string; name: string } | null
  customized: boolean
  limits: { users: number; warehouses: number; items: number }
  overrides: { maxUsers: number | null; maxWarehouses: number | null; maxItems: number | null }
  usage: { users: number; warehouses: number; items: number; customers: number }
  status: string
  state_: 'active' | 'trial' | 'expired' | 'suspended'
  billingCycle: 'MONTHLY' | 'YEARLY'
  paidUntil: string | null
  trialEndsAt: string | null
  /** List endpoint only: number of firms (other orgs) this org's users also run */
  linkedFirms?: number
  /** List endpoint only: the parent org when this org is a firm of another one */
  firmOf?: { id: string; name: string | null } | null
}

interface PlanRow {
  id: string
  name: string
  priceMonthly: number
  priceYearly: number
  maxUsers: number
  maxWarehouses: number
  maxItems: number
  active: boolean
  orgCount: number
}

interface Me { user: LoginUser; company: { id: string; name: string } }

const fmtDate = (d: string | null) => {
  if (!d) return '—'
  const x = new Date(d)
  return `${String(x.getDate()).padStart(2, '0')}/${String(x.getMonth() + 1).padStart(2, '0')}/${x.getFullYear()}`
}
const lim = (used: number, max: number) => `${used}/${max || '∞'}`
const inr = (n: number) => `₹${n.toLocaleString('en-IN')}`

const STATE_STYLE: Record<OrgRow['state_'], string> = {
  active: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300',
  trial: 'bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300',
  expired: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  suspended: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300',
}

function CopyChip({ text }: { text: string }) {
  const [done, setDone] = React.useState(false)
  return (
    <button
      type="button"
      onClick={() => { void navigator.clipboard.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1200) }) }}
      className="inline-flex items-center gap-1.5 rounded-md bg-muted px-2 py-0.5 font-mono text-xs hover:bg-muted/70"
      title="Copy"
    >
      {text}
      {done ? <Check className="h-3 w-3 text-emerald-600" /> : <Copy className="h-3 w-3 text-muted-foreground" />}
    </button>
  )
}

// ---------------- page shell ----------------

export default function PlatformAdmin() {
  const [me, setMe] = React.useState<Me | null>(null)
  const [booting, setBooting] = React.useState(true)
  const [tab, setTab] = React.useState<'orgs' | 'plans'>('orgs')

  React.useEffect(() => {
    apiGet<Me>('/api/auth/me').then(setMe).catch(() => setMe(null)).finally(() => setBooting(false))
    const onUnauthorized = () => setMe(null)
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized)
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized)
  }, [])

  async function logout() {
    try { await apiPost('/api/auth/logout', {}) } catch { /* best effort */ }
    try { window.localStorage.removeItem('erp_user') } catch { /* ignore */ }
    setMe(null)
  }

  if (booting) {
    return <div className="flex min-h-screen items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
  }
  if (!me) {
    return (
      <LoginScreen
        onLogin={(user, company) => {
          if (user.role !== 'SUPER_ADMIN') {
            toast.error('This console is for the platform administrator only')
            window.location.href = '/'
            return
          }
          window.localStorage.setItem('erp_user', JSON.stringify({ user, company }))
          setMe({ user, company })
        }}
      />
    )
  }
  if (me.user.role !== 'SUPER_ADMIN') {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-lg font-semibold">Platform administrator access required</p>
        <p className="text-sm text-muted-foreground">You are signed in as {me.user.email}.</p>
        <Button onClick={() => { window.location.href = '/' }}>Go to ERP</Button>
      </div>
    )
  }

  const navBtn = (key: 'orgs' | 'plans', label: string) => (
    <Button variant={tab === key ? 'default' : 'outline'} size="sm" className={cn('rounded-full', tab === key && 'bg-emerald-700 hover:bg-emerald-700/90')} onClick={() => setTab(key)}>
      {label}
    </Button>
  )

  return (
    <div className="min-h-screen bg-muted/40">
      <header className="border-b bg-background">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-4 sm:px-6">
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-emerald-100 p-2 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"><Factory className="h-5 w-5" /></div>
            <div>
              <h1 className="text-lg font-semibold leading-tight">Platform Admin</h1>
              <p className="text-xs text-muted-foreground">{me.user.name} · {me.user.email}</p>
            </div>
          </div>
          <nav className="flex flex-wrap items-center gap-2">
            {navBtn('orgs', 'Organizations')}
            {navBtn('plans', 'Plans')}
            <Button variant="outline" size="sm" className="rounded-full" onClick={() => { window.location.href = '/' }}>Open ERP</Button>
            <Button variant="outline" size="sm" className="rounded-full" onClick={() => void logout()}>Logout</Button>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
        {tab === 'orgs' ? <Organizations /> : <Plans />}
      </main>
    </div>
  )
}

// ---------------- Organizations ----------------

interface CreateForm {
  name: string; gstin: string; city: string; state: string; stateCode: string; phone: string
  adminName: string; adminEmail: string; password: string; planId: string; billingCycle: string; trialDays: string
}
const EMPTY_CREATE: CreateForm = {
  name: '', gstin: '', city: '', state: '', stateCode: '', phone: '',
  adminName: '', adminEmail: '', password: '', planId: '', billingCycle: 'MONTHLY', trialDays: '14',
}

function Organizations() {
  const orgs = useList<{ items: OrgRow[] }>('/api/platform/orgs')
  const plans = useList<{ items: PlanRow[] }>('/api/platform/plans')
  const allRows = orgs.data?.items ?? []
  const [hideFirms, setHideFirms] = React.useState(false)
  const firmCount = allRows.filter((r) => r.firmOf).length
  const rows = hideFirms ? allRows.filter((r) => !r.firmOf) : allRows
  const planOpts = [{ value: '', label: '— No plan (unlimited) —' }, ...(plans.data?.items ?? []).map((p) => ({ value: p.id, label: p.name }))]

  // Passwords generated this session (shown until the page is reloaded; never stored server-side in plain text)
  const [shownPw, setShownPw] = React.useState<Record<string, string>>({})
  const [creds, setCreds] = React.useState<{ org: string; email: string; password: string } | null>(null)

  const [createOpen, setCreateOpen] = React.useState(false)
  const [form, setForm] = React.useState<CreateForm>(EMPTY_CREATE)
  const [saving, setSaving] = React.useState(false)
  const setF = (k: keyof CreateForm) => (v: string) => setForm((f) => ({ ...f, [k]: v }))

  const [customOrg, setCustomOrg] = React.useState<OrgRow | null>(null)
  const [custom, setCustom] = React.useState({ maxUsers: '', maxWarehouses: '', maxItems: '' })
  const [paidOrg, setPaidOrg] = React.useState<OrgRow | null>(null)
  const [paidCycle, setPaidCycle] = React.useState('MONTHLY')
  const [deleteOrg, setDeleteOrg] = React.useState<OrgRow | null>(null)
  const [deleteName, setDeleteName] = React.useState('')
  const [busy, setBusy] = React.useState<string | null>(null)

  function replaceRow(org: OrgRow) {
    // PATCH returns the plain org row — keep the list-only firm fields (linkedFirms / firmOf)
    orgs.setData((d) => (d ? { items: d.items.map((r) => (r.id === org.id ? { ...r, ...org, linkedFirms: org.linkedFirms ?? r.linkedFirms, firmOf: org.firmOf !== undefined ? org.firmOf : r.firmOf } : r)) } : d))
  }

  async function act(row: OrgRow, body: Record<string, unknown>, msg?: string) {
    setBusy(row.id + String(body.action))
    try {
      const d = await apiPatch<{ org: OrgRow; password?: string; email?: string }>(`/api/platform/orgs/${row.id}`, body)
      replaceRow(d.org)
      if (d.password && d.email) {
        setShownPw((m) => ({ ...m, [row.id]: d.password! }))
        setCreds({ org: row.name, email: d.email, password: d.password })
      } else if (msg) toast.success(msg)
      return true
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Action failed')
      return false
    } finally {
      setBusy(null)
    }
  }

  async function create() {
    if (!form.name.trim() || !form.adminEmail.trim()) { toast.error('Company name and admin email are required'); return }
    if (form.password && form.password.length < 8) { toast.error('Password must be at least 8 characters (or leave blank to generate)'); return }
    setSaving(true)
    try {
      const d = await apiPost<{ org: OrgRow; password: string }>('/api/platform/orgs', { ...form, trialDays: Number(form.trialDays || 0) })
      orgs.setData((prev) => ({ items: [d.org, ...(prev?.items ?? [])] }))
      setShownPw((m) => ({ ...m, [d.org.id]: d.password }))
      setCreds({ org: d.org.name, email: d.org.admin?.email || form.adminEmail, password: d.password })
      setCreateOpen(false)
      setForm(EMPTY_CREATE)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to create organization')
    } finally {
      setSaving(false)
    }
  }

  async function loginAs(row: OrgRow) {
    if (!(await act(row, { action: 'loginAs' }))) return
    window.localStorage.setItem('erp_company_id', row.id)
    window.location.href = '/'
  }

  async function saveCustom() {
    if (!customOrg) return
    const ok = await act(customOrg, {
      action: 'customize',
      maxUsers: custom.maxUsers === '' ? null : Number(custom.maxUsers),
      maxWarehouses: custom.maxWarehouses === '' ? null : Number(custom.maxWarehouses),
      maxItems: custom.maxItems === '' ? null : Number(custom.maxItems),
    }, 'Custom limits saved')
    if (ok) setCustomOrg(null)
  }

  async function remove() {
    if (!deleteOrg) return
    setBusy(deleteOrg.id + 'delete')
    try {
      // apiDelete() sends no body; the org delete needs the typed confirmation.
      await api(`/api/platform/orgs/${deleteOrg.id}`, { method: 'DELETE', body: JSON.stringify({ confirmName: deleteName }) })
      orgs.setData((d) => (d ? { items: d.items.filter((r) => r.id !== deleteOrg.id) } : d))
      toast.success(`${deleteOrg.name} deleted`)
      setDeleteOrg(null)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Delete failed')
    } finally {
      setBusy(null)
    }
  }

  const actBtn = 'h-8 rounded-full px-3 text-xs'

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-xl font-semibold">Organizations ({rows.length}{hideFirms && firmCount ? ` of ${allRows.length}` : ''})</h2>
          <Button
            variant={hideFirms ? 'default' : 'outline'} size="sm"
            className={cn('h-8 rounded-full px-3 text-xs', hideFirms && 'bg-emerald-700 hover:bg-emerald-700/90')}
            onClick={() => setHideFirms((v) => !v)}
            title="Hide organizations that are firms of another organization"
          >
            {hideFirms ? 'Firms hidden' : 'Hide firms'}{firmCount ? ` (${firmCount})` : ''}
          </Button>
        </div>
        <Button className="rounded-full bg-emerald-700 hover:bg-emerald-700/90" onClick={() => { setForm(EMPTY_CREATE); setCreateOpen(true) }}>
          <Plus className="mr-1.5 h-4 w-4" />Create organization
        </Button>
      </div>

      <Card className="overflow-hidden p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="min-w-40">Company</TableHead>
              <TableHead className="min-w-52">Login</TableHead>
              <TableHead className="min-w-44">Plan</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="min-w-36">Usage</TableHead>
              <TableHead className="min-w-40">Period / Trial</TableHead>
              <TableHead className="min-w-80">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {orgs.loading && !rows.length && (
              <TableRow><TableCell colSpan={7} className="py-10 text-center text-muted-foreground"><Loader2 className="mx-auto h-5 w-5 animate-spin" /></TableCell></TableRow>
            )}
            {!orgs.loading && !rows.length && (
              <TableRow><TableCell colSpan={7} className="py-10 text-center text-muted-foreground">{allRows.length ? 'All organizations are firms — turn off "Hide firms" to see them.' : 'No organizations yet — create the first one.'}</TableCell></TableRow>
            )}
            {rows.map((r) => (
              <TableRow key={r.id} className="align-top">
                <TableCell>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <p className="font-medium">{r.name}</p>
                    {!!r.linkedFirms && (
                      <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-medium text-violet-700 dark:bg-violet-950 dark:text-violet-300" title="Other organizations run by this organization's users">
                        +{r.linkedFirms} {r.linkedFirms === 1 ? 'firm' : 'firms'}
                      </span>
                    )}
                  </div>
                  {r.firmOf && <p className="text-xs text-violet-700 dark:text-violet-300">Firm of: {r.firmOf.name || '—'}</p>}
                  <p className="text-xs text-muted-foreground">{r.slug}{r.city ? ` · ${r.city}` : ''}</p>
                </TableCell>
                <TableCell>
                  <p className="text-sm">{r.admin?.email || <span className="text-muted-foreground">no admin</span>}</p>
                  {shownPw[r.id] && <div className="mt-1"><CopyChip text={shownPw[r.id]} /></div>}
                </TableCell>
                <TableCell>
                  <SelectInput value={r.plan?.id || ''} options={planOpts} onChange={(v) => void act(r, { action: 'setPlan', planId: v || null }, 'Plan updated')} />
                  {r.customized && <p className="mt-1 text-xs text-violet-700 dark:text-violet-300">Custom limits</p>}
                </TableCell>
                <TableCell>
                  <span className={cn('rounded-full px-2.5 py-0.5 text-xs font-medium', STATE_STYLE[r.state_])}>{r.state_}</span>
                </TableCell>
                <TableCell className="text-sm leading-6">
                  <div>{lim(r.usage.users, r.limits.users)} users</div>
                  <div>{lim(r.usage.warehouses, r.limits.warehouses)} warehouses</div>
                  <div>{lim(r.usage.items, r.limits.items)} items</div>
                  <div className="text-muted-foreground">{r.usage.customers} customers</div>
                </TableCell>
                <TableCell className="text-sm">
                  {r.paidUntil && <div>Paid until {fmtDate(r.paidUntil)} <span className="ml-1 rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">{r.billingCycle}</span></div>}
                  {r.trialEndsAt && <div className="text-muted-foreground">Trial until {fmtDate(r.trialEndsAt)}</div>}
                  {!r.paidUntil && !r.trialEndsAt && <span className="text-muted-foreground">No expiry</span>}
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-1.5">
                    <Button variant="outline" size="sm" className={actBtn} onClick={() => { setPaidCycle(r.billingCycle); setPaidOrg(r) }}>Mark paid</Button>
                    <Button variant="outline" size="sm" className={actBtn} disabled={busy === r.id + 'extendTrial'} onClick={() => void act(r, { action: 'extendTrial', days: 7 }, 'Trial extended by 7 days')}>+7d trial</Button>
                    {r.status === 'SUSPENDED' ? (
                      <Button variant="outline" size="sm" className={cn(actBtn, 'text-emerald-700')} onClick={() => void act(r, { action: 'activate' }, 'Organization re-activated')}>Activate</Button>
                    ) : (
                      <ConfirmAction
                        trigger={<Button variant="outline" size="sm" className={actBtn}>Suspend</Button>}
                        title={`Suspend ${r.name}?`} message="Its users will be signed out and cannot log in until you activate it again. No data is deleted."
                        tone="destructive" onConfirm={() => void act(r, { action: 'suspend' }, 'Organization suspended')}
                      />
                    )}
                    <Button variant="outline" size="sm" className={actBtn} onClick={() => {
                      setCustom({
                        maxUsers: r.overrides.maxUsers?.toString() ?? '',
                        maxWarehouses: r.overrides.maxWarehouses?.toString() ?? '',
                        maxItems: r.overrides.maxItems?.toString() ?? '',
                      })
                      setCustomOrg(r)
                    }}>Customize plan</Button>
                    <ConfirmAction
                      trigger={<Button variant="outline" size="sm" className={actBtn}>Reset pwd</Button>}
                      title="Reset admin password?" message={`A new password will be generated for ${r.admin?.email || 'the tenant admin'}. The old one stops working immediately.`}
                      onConfirm={() => void act(r, { action: 'resetPassword' })}
                    />
                    <Button variant="outline" size="sm" className={actBtn} onClick={() => void loginAs(r)}>Login as</Button>
                    <Button variant="outline" size="sm" className={cn(actBtn, 'border-red-200 text-red-600 hover:text-red-700')} onClick={() => { setDeleteName(''); setDeleteOrg(r) }}>Delete</Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      {/* Create */}
      <FormDialog open={createOpen} onOpenChange={setCreateOpen} title="Create organization" description="Creates the manufacturing company, its default warehouses (RM / FG / General) and the admin login." onSubmit={create} submitLabel="Create" loading={saving} wide>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Company name" required className="sm:col-span-2"><TextInput value={form.name} onChange={(e) => setF('name')(e.target.value)} placeholder="Acme Precision Pvt Ltd" /></Field>
          <Field label="GSTIN"><TextInput value={form.gstin} onChange={(e) => setF('gstin')(e.target.value)} maxLength={15} className="font-mono" placeholder="27ABCDE1234F1Z9" /></Field>
          <Field label="Phone"><TextInput value={form.phone} onChange={(e) => setF('phone')(e.target.value)} /></Field>
          <Field label="City"><TextInput value={form.city} onChange={(e) => setF('city')(e.target.value)} /></Field>
          <Field label="State"><TextInput value={form.state} onChange={(e) => setF('state')(e.target.value)} placeholder="Maharashtra" /></Field>
          <Field label="GST state code"><TextInput value={form.stateCode} onChange={(e) => setF('stateCode')(e.target.value)} maxLength={2} placeholder="27" /></Field>
        </div>
        <div className="grid gap-4 rounded-lg border bg-muted/40 p-4 sm:grid-cols-2">
          <Field label="Admin name"><TextInput value={form.adminName} onChange={(e) => setF('adminName')(e.target.value)} placeholder="Rajesh Kumar" /></Field>
          <Field label="Admin email (login)" required><TextInput type="email" value={form.adminEmail} onChange={(e) => setF('adminEmail')(e.target.value)} placeholder="owner@company.in" /></Field>
          <Field label="Password" className="sm:col-span-2">
            <TextInput type="text" autoComplete="off" value={form.password} onChange={(e) => setF('password')(e.target.value)} placeholder="Leave blank to generate a strong password" />
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Plan"><SelectInput value={form.planId} options={planOpts} onChange={setF('planId')} /></Field>
          <Field label="Billing cycle"><SelectInput value={form.billingCycle} options={[{ value: 'MONTHLY', label: 'Monthly' }, { value: 'YEARLY', label: 'Yearly' }]} onChange={setF('billingCycle')} /></Field>
          <Field label="Free trial (days)"><TextInput type="number" min={0} max={365} value={form.trialDays} onChange={(e) => setF('trialDays')(e.target.value)} /></Field>
        </div>
      </FormDialog>

      {/* Credentials after create / reset */}
      <Dialog open={!!creds} onOpenChange={(o) => { if (!o) setCreds(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Login details — {creds?.org}</DialogTitle>
            <DialogDescription>Copy and share these with the organization admin now. For security the password is not stored and won&apos;t be shown again after you reload this page.</DialogDescription>
          </DialogHeader>
          {creds && (
            <div className="grid gap-2 text-sm">
              <div className="flex items-center justify-between gap-2"><span className="text-muted-foreground">URL</span><CopyChip text={typeof window !== 'undefined' ? window.location.origin : ''} /></div>
              <div className="flex items-center justify-between gap-2"><span className="text-muted-foreground">Email</span><CopyChip text={creds.email} /></div>
              <div className="flex items-center justify-between gap-2"><span className="text-muted-foreground">Password</span><CopyChip text={creds.password} /></div>
            </div>
          )}
          <DialogFooter><Button onClick={() => setCreds(null)}>Done</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Mark paid */}
      <FormDialog open={!!paidOrg} onOpenChange={(o) => { if (!o) setPaidOrg(null) }} title={`Record payment — ${paidOrg?.name ?? ''}`}
        description={paidOrg?.paidUntil && new Date(paidOrg.paidUntil) > new Date() ? `Extends from the current paid-until date (${fmtDate(paidOrg.paidUntil)}).` : 'Starts today.'}
        submitLabel="Mark paid" onSubmit={async () => { if (paidOrg && (await act(paidOrg, { action: 'markPaid', cycle: paidCycle }, 'Payment recorded'))) setPaidOrg(null) }}>
        <Field label="Period"><SelectInput value={paidCycle} options={[{ value: 'MONTHLY', label: '1 month' }, { value: 'YEARLY', label: '1 year' }]} onChange={setPaidCycle} /></Field>
      </FormDialog>

      {/* Customize limits */}
      <FormDialog open={!!customOrg} onOpenChange={(o) => { if (!o) setCustomOrg(null) }} title={`Customize plan — ${customOrg?.name ?? ''}`}
        description={`Overrides the ${customOrg?.plan?.name ? `"${customOrg.plan.name}"` : ''} plan limits for this organization only. Leave blank to use the plan limit; 0 = unlimited.`}
        submitLabel="Save limits" onSubmit={saveCustom}>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Max users"><TextInput type="number" min={0} value={custom.maxUsers} onChange={(e) => setCustom((c) => ({ ...c, maxUsers: e.target.value }))} placeholder="plan" /></Field>
          <Field label="Max warehouses"><TextInput type="number" min={0} value={custom.maxWarehouses} onChange={(e) => setCustom((c) => ({ ...c, maxWarehouses: e.target.value }))} placeholder="plan" /></Field>
          <Field label="Max items"><TextInput type="number" min={0} value={custom.maxItems} onChange={(e) => setCustom((c) => ({ ...c, maxItems: e.target.value }))} placeholder="plan" /></Field>
        </div>
        {customOrg?.customized && (
          <Button type="button" variant="link" className="h-auto p-0 text-xs" onClick={async () => { if (customOrg && (await act(customOrg, { action: 'resetCustom' }, 'Back to plan limits'))) setCustomOrg(null) }}>
            Remove custom limits
          </Button>
        )}
      </FormDialog>

      {/* Delete */}
      <Dialog open={!!deleteOrg} onOpenChange={(o) => { if (!o) setDeleteOrg(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-red-600">Delete {deleteOrg?.name}?</DialogTitle>
            <DialogDescription>This permanently deletes the organization with all its users, items, documents, stock and audit history. It cannot be undone. Consider “Suspend” instead.</DialogDescription>
          </DialogHeader>
          <Field label={`Type "${deleteOrg?.name ?? ''}" to confirm`}>
            <TextInput value={deleteName} onChange={(e) => setDeleteName(e.target.value)} autoComplete="off" />
          </Field>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteOrg(null)}>Cancel</Button>
            <Button variant="destructive" disabled={deleteName !== deleteOrg?.name || busy === (deleteOrg?.id ?? '') + 'delete'} onClick={() => void remove()}>
              Delete permanently
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ---------------- Plans ----------------

interface PlanForm { name: string; priceMonthly: string; priceYearly: string; maxUsers: string; maxWarehouses: string; maxItems: string }
const EMPTY_PLAN: PlanForm = { name: '', priceMonthly: '0', priceYearly: '0', maxUsers: '0', maxWarehouses: '0', maxItems: '0' }

function Plans() {
  const plans = useList<{ items: PlanRow[] }>('/api/platform/plans')
  const rows = plans.data?.items ?? []
  const [open, setOpen] = React.useState(false)
  const [editId, setEditId] = React.useState<string | null>(null)
  const [form, setForm] = React.useState<PlanForm>(EMPTY_PLAN)
  const [saving, setSaving] = React.useState(false)
  const setF = (k: keyof PlanForm) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }))

  async function save() {
    if (!form.name.trim()) { toast.error('Plan name is required'); return }
    setSaving(true)
    try {
      const body = { ...form, name: form.name.trim() }
      if (editId) await apiPatch(`/api/platform/plans/${editId}`, body)
      else await apiPost('/api/platform/plans', body)
      toast.success(editId ? 'Plan updated' : 'Plan created')
      setOpen(false)
      await plans.refetch()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save plan')
    } finally {
      setSaving(false)
    }
  }

  async function remove(p: PlanRow) {
    try {
      await apiDelete(`/api/platform/plans/${p.id}`)
      toast.success('Plan deleted')
      await plans.refetch()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to delete plan')
    }
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">Plans ({rows.length})</h2>
          <p className="text-sm text-muted-foreground">Limits apply to every organization on the plan unless customized. 0 = unlimited.</p>
        </div>
        <Button className="rounded-full bg-emerald-700 hover:bg-emerald-700/90" onClick={() => { setEditId(null); setForm(EMPTY_PLAN); setOpen(true) }}>
          <Plus className="mr-1.5 h-4 w-4" />Plan
        </Button>
      </div>
      <Card className="overflow-hidden p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Plan</TableHead>
              <TableHead className="text-right">Monthly</TableHead>
              <TableHead className="text-right">Yearly</TableHead>
              <TableHead className="text-right">Users</TableHead>
              <TableHead className="text-right">Warehouses</TableHead>
              <TableHead className="text-right">Items</TableHead>
              <TableHead className="text-right">Organizations</TableHead>
              <TableHead>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {!plans.loading && !rows.length && (
              <TableRow><TableCell colSpan={8} className="py-10 text-center text-muted-foreground">No plans yet — create Basic / Standard / Premium with your prices and limits.</TableCell></TableRow>
            )}
            {rows.map((p) => (
              <TableRow key={p.id}>
                <TableCell className="font-medium">{p.name}</TableCell>
                <TableCell className="text-right">{inr(p.priceMonthly)}</TableCell>
                <TableCell className="text-right">{inr(p.priceYearly)}</TableCell>
                <TableCell className="text-right">{p.maxUsers || '∞'}</TableCell>
                <TableCell className="text-right">{p.maxWarehouses || '∞'}</TableCell>
                <TableCell className="text-right">{p.maxItems || '∞'}</TableCell>
                <TableCell className="text-right">{p.orgCount}</TableCell>
                <TableCell>
                  <div className="flex gap-1.5">
                    <Button variant="outline" size="sm" className="h-8 rounded-full px-3 text-xs" onClick={() => {
                      setEditId(p.id)
                      setForm({ name: p.name, priceMonthly: String(p.priceMonthly), priceYearly: String(p.priceYearly), maxUsers: String(p.maxUsers), maxWarehouses: String(p.maxWarehouses), maxItems: String(p.maxItems) })
                      setOpen(true)
                    }}>Edit</Button>
                    <ConfirmAction
                      trigger={<Button variant="outline" size="sm" className="h-8 rounded-full px-3 text-xs text-red-600">Delete</Button>}
                      title={`Delete plan ${p.name}?`} message="Only possible when no organization uses it." tone="destructive" onConfirm={() => remove(p)}
                    />
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      <FormDialog open={open} onOpenChange={setOpen} title={editId ? 'Edit plan' : 'Plan'} onSubmit={save} loading={saving} submitLabel={editId ? 'Save' : 'Create'}>
        <Field label="Plan name" required><TextInput value={form.name} onChange={setF('name')} placeholder="Standard" /></Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Price / month (₹)"><TextInput type="number" min={0} value={form.priceMonthly} onChange={setF('priceMonthly')} /></Field>
          <Field label="Price / year (₹)"><TextInput type="number" min={0} value={form.priceYearly} onChange={setF('priceYearly')} /></Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Max users"><TextInput type="number" min={0} value={form.maxUsers} onChange={setF('maxUsers')} /></Field>
          <Field label="Max warehouses"><TextInput type="number" min={0} value={form.maxWarehouses} onChange={setF('maxWarehouses')} /></Field>
          <Field label="Max items"><TextInput type="number" min={0} value={form.maxItems} onChange={setF('maxItems')} /></Field>
        </div>
      </FormDialog>
    </div>
  )
}
