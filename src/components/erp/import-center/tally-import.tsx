'use client'

import * as React from 'react'
import { toast } from 'sonner'
import {
  ArrowLeft, ArrowRight, Building2, CalendarRange, CheckCircle2, ChevronDown, Download, FileSpreadsheet, Loader2, Lock,
  Package, RefreshCw, Search, Square, Upload, Users, XCircle,
} from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import { Skeleton } from '@/components/ui/skeleton'
import TallyConnectorPanel from '@/components/erp/import-center/tally-connector-panel'
import { ITEM_TYPES, ITEM_TYPE_LABEL, fmtDate } from '@/lib/erp-constants'
import type { RunResult, RunRow } from '@/lib/import/run'
import { STATUS_LABEL, downloadText, friendlyError, problemRowsCsv } from '@/lib/import/wizard-helpers'
import type { ConnectorStatus } from '@/lib/tally/connector'
import type { JobView } from '@/lib/tally/jobs'
import { apiDelete, apiGet, apiPost } from '@/lib/use-api'
import { cn } from '@/lib/utils'

/**
 * Import from Tally through the ManuFlow Tally Connector: 1 Connect → 2 Company → 3 Data → 4 Review & import.
 * Everything shown comes from the server: the connector status, Tally's own company list, the records the connector
 * read, and the Import Center preview / import of those records (same checks and duplicate rules as a file import).
 * Vouchers, orders and date ranges are shown as not available — they are not built.
 */

type Kind = 'customers' | 'suppliers' | 'items'
type Company = NonNullable<JobView['companies']>[number]

const STEPS = ['Connect Tally', 'Choose company', 'Select data', 'Review & import']
const KINDS: { kind: Kind; label: string; hint: string; job: string }[] = [
  { kind: 'customers', label: 'Customers', hint: 'Sundry Debtors ledgers', job: 'export-customers' },
  { kind: 'suppliers', label: 'Suppliers', hint: 'Sundry Creditors ledgers', job: 'export-suppliers' },
  { kind: 'items', label: 'Stock items', hint: 'Name, unit, HSN, GST rate, stock group', job: 'export-items' },
]
const LATER: { title: string; items: string[] }[] = [
  { title: 'Vouchers', items: ['Sales', 'Purchase', 'Payment', 'Receipt', 'Contra', 'Debit notes', 'Credit notes'] },
  { title: 'Orders & delivery', items: ['Sales orders', 'Purchase orders', 'Delivery notes'] },
  { title: 'Other masters', items: ['Other ledgers (bank, expenses…)', 'Units, stock groups, godowns', 'Opening balances & stock'] },
]
const PAGE = 50
const POLL_MS = 1500

interface CatState {
  kind: Kind
  read: 'waiting' | 'reading' | 'done' | 'failed'
  jobId?: string
  records?: number
  error?: string
  batches: number
  preview: Counts
  done: Counts
  problems: RunRow[]
}
type Counts = { ready: number; duplicates: number; problems: number; imported: number }
const ZERO: Counts = { ready: 0, duplicates: 0, problems: 0, imported: 0 }
type Phase = 'idle' | 'reading' | 'checking' | 'ready' | 'importing' | 'done' | 'stopped' | 'failed'
interface BatchReply { batch: number; batches: number; totalRecords: number; result: RunResult }

function fyLabel(offset: number) {
  const now = new Date()
  const start = (now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1) + offset
  return `Apr ${start} – Mar ${start + 1}`
}

class Stopped extends Error {}

export default function TallyImport({ open, onOpenChange, companyId, companyName, onUseFile }: {
  open: boolean; onOpenChange: (o: boolean) => void; companyId: string; companyName: string; onUseFile: () => void
}) {
  const [step, setStep] = React.useState(1)
  const [conn, setConn] = React.useState<ConnectorStatus | null>(null)
  // Step 2
  const [companies, setCompanies] = React.useState<Company[] | null>(null)
  const [listing, setListing] = React.useState(false)
  const [listError, setListError] = React.useState('')
  const [search, setSearch] = React.useState('')
  const [shown, setShown] = React.useState(PAGE)
  const [company, setCompany] = React.useState('')
  // Step 3
  const [kinds, setKinds] = React.useState<Set<Kind>>(new Set())
  const [itemType, setItemType] = React.useState('')
  const [showLater, setShowLater] = React.useState(false)
  // Step 4
  const [phase, setPhase] = React.useState<Phase>('idle')
  const [cats, setCats] = React.useState<CatState[]>([])
  const [stage, setStage] = React.useState('')
  const [progress, setProgress] = React.useState({ done: 0, total: 0 })
  const [runError, setRunError] = React.useState('')
  const stopRef = React.useRef(false)
  const busyRef = React.useRef(false)
  const openJobs = React.useRef(new Set<string>())
  const checkedFor = React.useRef('')

  const connected = conn?.state === 'connected'
  const busy = phase === 'reading' || phase === 'checking' || phase === 'importing'
  const q = `companyId=${companyId}`
  const onStatus = React.useCallback((s: ConnectorStatus) => setConn(s), [])

  // ---------- Tally jobs ----------
  async function waitForJob(type: string, tallyCompany?: string): Promise<JobView> {
    let job = await apiPost<JobView>(`/api/import-center/tally/jobs?${q}`, { type, tallyCompany })
    openJobs.current.add(job.id)
    try {
      while (job.status === 'queued' || job.status === 'running') {
        if (stopRef.current) throw new Stopped()
        await new Promise((r) => setTimeout(r, POLL_MS))
        job = await apiGet<JobView>(`/api/import-center/tally/jobs?${q}&id=${job.id}`)
      }
      return job
    } finally {
      openJobs.current.delete(job.id)
    }
  }

  function cancelOpenJobs() {
    for (const id of openJobs.current) void apiDelete(`/api/import-center/tally/jobs?${q}&id=${id}`).catch(() => {})
  }

  async function loadCompanies() {
    if (listing) return
    setListing(true); setListError(''); stopRef.current = false
    try {
      const job = await waitForJob('list-companies')
      if (job.status !== 'done') { setListError(job.message || 'Tally did not return the company list.'); return }
      const list = job.companies ?? []
      setCompanies(list)
      setShown(PAGE)
      // Keep the choice when it is still open in Tally
      if (company && !list.some((c) => c.name === company)) setCompany('')
      if (!company && list.length === 1) setCompany(list[0].name)
    } catch (e) {
      if (!(e instanceof Stopped)) setListError(friendlyError(e))
    } finally {
      setListing(false)
    }
  }

  React.useEffect(() => {
    if (step === 2 && companies === null && !listing && connected) void loadCompanies()
  }, [step, connected])

  // Back out of step 4 / close while Tally is being read → stop and cancel
  React.useEffect(() => () => { stopRef.current = true; cancelOpenJobs() }, [])

  // ---------- step 4: read + check (read-only), then import ----------
  const selected = KINDS.filter((k) => kinds.has(k.kind))
  const signature = `${company}|${selected.map((k) => k.kind).join(',')}|${itemType}`
  const options = (kind: Kind) => (kind === 'items' ? { itemType } : {})

  const patch = (kind: Kind, p: Partial<CatState>) => setCats((cs) => cs.map((c) => (c.kind === kind ? { ...c, ...p } : c)))

  async function readAndCheck() {
    if (busyRef.current) return
    busyRef.current = true
    stopRef.current = false
    checkedFor.current = signature
    setRunError('')
    const list: CatState[] = selected.map((k) => ({ kind: k.kind, read: 'waiting', batches: 0, preview: { ...ZERO }, done: { ...ZERO }, problems: [] }))
    setCats(list)
    try {
      setPhase('reading')
      for (const k of selected) {
        setStage(`Reading ${k.label.toLowerCase()} from Tally…`)
        patch(k.kind, { read: 'reading' })
        const job = await waitForJob(k.job, company)
        if (job.status !== 'done') {
          patch(k.kind, { read: 'failed', error: job.message || 'Could not read this from Tally.' })
          continue
        }
        patch(k.kind, { read: 'done', jobId: job.id, records: job.count ?? 0 })
        const c = list.find((x) => x.kind === k.kind)!
        c.read = 'done'; c.jobId = job.id; c.records = job.count ?? 0
      }
      setPhase('checking')
      for (const c of list.filter((x) => x.read === 'done' && (x.records ?? 0) > 0)) {
        const label = KINDS.find((k) => k.kind === c.kind)!.label.toLowerCase()
        const counts = { ...ZERO }
        const problems: RunRow[] = []
        let batches = 1
        for (let b = 0; b < batches; b++) {
          if (stopRef.current) throw new Stopped()
          setStage(`Checking ${label}${batches > 1 ? ` (part ${b + 1} of ${batches})` : ''}…`)
          const r = await apiPost<BatchReply>('/api/import-center/tally/import', { companyId, jobId: c.jobId, dataType: c.kind, mode: 'preview', batch: b, options: options(c.kind) })
          batches = r.batches
          counts.ready += r.result.counts.ready
          counts.duplicates += r.result.counts.duplicates
          counts.problems += r.result.counts.errors + r.result.counts.failed
          problems.push(...r.result.rows.filter((x) => x.status === 'error' || x.status === 'failed'))
        }
        patch(c.kind, { preview: counts, batches, problems })
      }
      setPhase('ready')
      setStage('')
    } catch (e) {
      cancelOpenJobs()
      if (e instanceof Stopped) { setPhase('stopped'); setStage('') } else { setPhase('failed'); setRunError(friendlyError(e)) }
    } finally {
      busyRef.current = false
    }
  }

  React.useEffect(() => {
    if (step === 4 && checkedFor.current !== signature && !busyRef.current) void readAndCheck()
  }, [step])

  async function importAll() {
    if (busyRef.current) return // a second click while running does nothing
    busyRef.current = true
    stopRef.current = false
    setRunError('')
    const todo = cats.filter((c) => c.read === 'done' && c.preview.ready > 0)
    const total = todo.reduce((s, c) => s + c.preview.ready + c.preview.duplicates + c.preview.problems, 0)
    let processed = 0
    setProgress({ done: 0, total })
    setPhase('importing')
    try {
      for (const c of todo) {
        const label = KINDS.find((k) => k.kind === c.kind)!.label.toLowerCase()
        const counts = { ...ZERO }
        const problems: RunRow[] = []
        for (let b = 0; b < c.batches; b++) {
          if (stopRef.current) throw new Stopped()
          setStage(`Importing ${label}${c.batches > 1 ? ` (part ${b + 1} of ${c.batches})` : ''}…`)
          const r = await apiPost<BatchReply>('/api/import-center/tally/import', { companyId, jobId: c.jobId, dataType: c.kind, mode: 'commit', batch: b, options: options(c.kind), confirm: true })
          counts.imported += r.result.counts.imported
          counts.duplicates += r.result.counts.duplicates
          counts.problems += r.result.counts.errors + r.result.counts.failed
          problems.push(...r.result.rows.filter((x) => x.status === 'error' || x.status === 'failed'))
          processed += r.result.counts.total
          setProgress({ done: processed, total })
          patch(c.kind, { done: { ...counts }, problems })
        }
      }
      setPhase('done')
      setStage('')
      toast.success('Import from Tally finished')
    } catch (e) {
      if (e instanceof Stopped) { setPhase('stopped'); setStage('') } else { setPhase('failed'); setRunError(friendlyError(e)) }
    } finally {
      busyRef.current = false
    }
  }

  // ---------- navigation ----------
  const filtered = (companies ?? []).filter((c) => c.name.toLowerCase().includes(search.trim().toLowerCase()))
  const canNext = step === 1 ? connected : step === 2 ? !!company : step === 3 ? kinds.size > 0 && (!kinds.has('items') || !!itemType) : false
  const nextHint = step === 1 ? (connected ? '' : 'Connect Tally to continue')
    : step === 2 ? (company ? '' : 'Choose a company to continue')
      : step === 3 ? (kinds.size === 0 ? 'Choose what to import' : kinds.has('items') && !itemType ? 'Choose the item type for stock items' : '') : ''

  function back() {
    if (step === 4 && busy && phase !== 'importing') { stopRef.current = true; cancelOpenJobs() }
    setStep((s) => Math.max(1, s - 1))
  }

  function toggle(kind: Kind, on: boolean) {
    setKinds((s) => {
      const n = new Set(s)
      if (on) n.add(kind); else n.delete(kind)
      return n
    })
  }

  const sum = (f: (c: CatState) => number) => cats.reduce((s, c) => s + f(c), 0)
  // After an import has started, the table shows what was imported instead of what would be
  const afterImport = phase === 'importing' || phase === 'done' || (phase === 'stopped' && sum((c) => c.done.imported + c.done.duplicates + c.done.problems) > 0)
  const counted = phase !== 'reading' && phase !== 'checking' && phase !== 'idle'
  const allProblems = cats.flatMap((c) => c.problems.map((p) => ({ ...p, values: { ...p.values, name: `${KINDS.find((k) => k.kind === c.kind)!.label}: ${p.values.name ?? ''}` } })))

  return (
    <Dialog open={open} onOpenChange={(o) => { if (phase !== 'importing') onOpenChange(o) }}>
      <DialogContent showCloseButton={phase !== 'importing'} onInteractOutside={(e) => e.preventDefault()}
        className="flex max-h-[92vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl">
        <DialogHeader className="border-b px-5 pb-4 pt-5 text-left sm:px-6">
          <DialogTitle className="text-lg sm:text-xl">Import from Tally</DialogTitle>
          <DialogDescription>
            Bring customers, suppliers and stock items from TallyPrime into <span className="font-medium text-foreground">{companyName || 'this company'}</span>.
          </DialogDescription>
          <Stepper step={step} />
        </DialogHeader>

        <div className="min-h-[18rem] flex-1 overflow-y-auto px-5 py-5 sm:px-6">
          {/* ---------------- 1 Connect ---------------- */}
          {step === 1 && (
            <section className="space-y-4" aria-labelledby="t-step1">
              <h3 id="t-step1" className="sr-only">Connect Tally</h3>
              <TallyConnectorPanel companyId={companyId} onStatus={onStatus} />
              <button type="button" onClick={onUseFile} className="inline-flex items-center gap-1.5 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
                <FileSpreadsheet className="h-4 w-4" aria-hidden /> No connector? Import an Excel / CSV file exported from Tally instead
              </button>
            </section>
          )}

          {/* ---------------- 2 Company ---------------- */}
          {step === 2 && (
            <section className="space-y-3" aria-labelledby="t-step2">
              <div className="flex flex-wrap items-center gap-2">
                <h3 id="t-step2" className="mr-auto text-base font-semibold">Which Tally company?</h3>
                <Button variant="outline" size="sm" onClick={() => void loadCompanies()} disabled={listing}>
                  <RefreshCw className={cn('mr-2 h-4 w-4', listing && 'animate-spin')} aria-hidden /> Refresh
                </Button>
              </div>
              <p className="text-sm text-muted-foreground">Tally lists only the companies that are open in TallyPrime right now.</p>
              {(companies?.length ?? 0) > 6 && (
                <div className="relative">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                  <Input value={search} onChange={(e) => { setSearch(e.target.value); setShown(PAGE) }} placeholder="Search companies" aria-label="Search companies" className="pl-9" />
                </div>
              )}
              {listError && <Problem text={listError} />}
              {listing && companies === null && (
                <div className="grid gap-2 sm:grid-cols-2" aria-busy="true" aria-label="Loading companies from Tally">
                  {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-16 rounded-lg" />)}
                </div>
              )}
              {companies && companies.length === 0 && !listing && (
                <Alert>
                  <Building2 className="h-4 w-4" />
                  <AlertTitle>No company is open in TallyPrime</AlertTitle>
                  <AlertDescription>Open (load) the company in TallyPrime, then press Refresh.</AlertDescription>
                </Alert>
              )}
              {companies && companies.length > 0 && (
                <div role="radiogroup" aria-label="Tally company" className="grid gap-2 sm:grid-cols-2">
                  {filtered.slice(0, shown).map((c) => {
                    const on = c.name === company
                    return (
                      <button key={c.name} type="button" role="radio" aria-checked={on} onClick={() => setCompany(c.name)}
                        className={cn('flex items-start gap-3 rounded-lg border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                          on ? 'border-primary bg-success-soft ring-1 ring-ring dark:bg-success-soft' : 'hover:bg-muted/60')}>
                        <Building2 className={cn('mt-0.5 h-5 w-5 shrink-0', on ? 'text-success' : 'text-muted-foreground')} aria-hidden />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium">{c.name}</span>
                          <span className="block text-xs text-muted-foreground">
                            {c.booksFrom ? `Books from ${fmtDate(c.booksFrom)}` : c.startingFrom ? `Financial year from ${fmtDate(c.startingFrom)}` : 'Financial year not reported'}
                          </span>
                        </span>
                        {on && <CheckCircle2 className="h-5 w-5 shrink-0 text-success" aria-hidden />}
                      </button>
                    )
                  })}
                </div>
              )}
              {filtered.length > shown && (
                <Button variant="ghost" size="sm" onClick={() => setShown((n) => n + PAGE)}>Show more ({filtered.length - shown})</Button>
              )}
              {companies && companies.length > 0 && filtered.length === 0 && <p className="text-sm text-muted-foreground">No company matches “{search}”.</p>}
            </section>
          )}

          {/* ---------------- 3 Data ---------------- */}
          {step === 3 && (
            <section className="space-y-4" aria-labelledby="t-step3">
              <div className="flex flex-wrap items-center gap-2">
                <h3 id="t-step3" className="mr-auto text-base font-semibold">What should be imported?</h3>
                <Button variant="ghost" size="sm" onClick={() => setKinds(new Set(KINDS.map((k) => k.kind)))}>Select all</Button>
                <Button variant="ghost" size="sm" onClick={() => setKinds(new Set())} disabled={kinds.size === 0}>Clear</Button>
              </div>
              <div className="grid gap-2 sm:grid-cols-3">
                {KINDS.map((k) => {
                  const on = kinds.has(k.kind)
                  const Icon = k.kind === 'items' ? Package : Users
                  return (
                    <label key={k.kind} className={cn('flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors focus-within:ring-2 focus-within:ring-ring',
                      on ? 'border-primary bg-success-soft dark:bg-success-soft' : 'hover:bg-muted/60')}>
                      <Checkbox checked={on} onCheckedChange={(v) => toggle(k.kind, v === true)} aria-label={k.label} className="mt-0.5" />
                      <span className="min-w-0">
                        <span className="flex items-center gap-1.5 font-medium"><Icon className="h-4 w-4 text-muted-foreground" aria-hidden /> {k.label}</span>
                        <span className="block text-xs text-muted-foreground">{k.hint}</span>
                      </span>
                    </label>
                  )
                })}
              </div>
              {kinds.has('items') && (
                <div className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed p-3">
                  <label htmlFor="t-itemtype" className="text-sm font-medium">New stock items are</label>
                  <select id="t-itemtype" value={itemType} onChange={(e) => setItemType(e.target.value)}
                    className="h-9 rounded-md border bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    <option value="">Choose item type…</option>
                    {ITEM_TYPES.map((t) => <option key={t} value={t}>{ITEM_TYPE_LABEL[t]}</option>)}
                  </select>
                  <span className="text-xs text-muted-foreground">Tally does not say this; you can change single items later.</span>
                </div>
              )}

              <div className="rounded-lg border bg-muted/30">
                <button type="button" onClick={() => setShowLater((v) => !v)} aria-expanded={showLater}
                  className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm">
                  <Lock className="h-4 w-4 text-muted-foreground" aria-hidden />
                  <span className="flex-1">Vouchers, orders, other masters and date range <span className="text-muted-foreground">— not available yet</span></span>
                  <ChevronDown className={cn('h-4 w-4 transition-transform', showLater && 'rotate-180')} aria-hidden />
                </button>
                {showLater && (
                  <div className="space-y-3 border-t px-3 py-3 text-sm">
                    <p className="text-muted-foreground">These need accounting rules (ledgers, numbering, outstanding bills) that ManuFlow does not have for imported data yet, so they cannot be selected.</p>
                    <div className="grid gap-3 sm:grid-cols-3">
                      {LATER.map((g) => (
                        <div key={g.title}>
                          <p className="font-medium">{g.title}</p>
                          <ul className="mt-1 space-y-0.5 text-muted-foreground">{g.items.map((i) => <li key={i}>{i}</li>)}</ul>
                        </div>
                      ))}
                    </div>
                    <fieldset disabled className="flex flex-wrap items-center gap-2 opacity-60">
                      <legend className="sr-only">Date range (vouchers only)</legend>
                      <CalendarRange className="h-4 w-4" aria-hidden />
                      {[`This financial year (${fyLabel(0)})`, `Previous financial year (${fyLabel(-1)})`, 'All available data', 'Custom range'].map((r) => (
                        <span key={r} className="rounded-full border px-2.5 py-1 text-xs">{r}</span>
                      ))}
                      <span className="w-full text-xs text-muted-foreground">The date range applies to vouchers. Customers, suppliers and stock items are imported as they are in Tally today.</span>
                    </fieldset>
                  </div>
                )}
              </div>

              {kinds.size > 0 && (
                <p className="text-sm" role="status">
                  <span className="font-medium">{selected.map((k) => k.label).join(', ')}</span> from <span className="font-medium">{company}</span>.
                  {' '}Opening balances and opening stock are not imported.
                </p>
              )}
            </section>
          )}

          {/* ---------------- 4 Review & import ---------------- */}
          {step === 4 && (
            <section className="space-y-4" aria-labelledby="t-step4">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <h3 id="t-step4" className="text-base font-semibold">Review & import</h3>
                <span className="text-sm text-muted-foreground">{company} → {companyName || 'this company'}</span>
              </div>

              {(busy || stage) && (
                <div className="space-y-2" aria-live="polite">
                  <p className="flex items-center gap-2 text-sm font-medium"><Loader2 className="h-4 w-4 animate-spin" aria-hidden /> {stage}</p>
                  {phase === 'importing' && (
                    <>
                      <Progress value={progress.total ? Math.min(99, Math.floor((progress.done / progress.total) * 100)) : 0} aria-label="Import progress" />
                      <p className="text-xs text-muted-foreground">{progress.done} of {progress.total} records processed</p>
                    </>
                  )}
                </div>
              )}

              <div className="overflow-x-auto rounded-lg border">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
                    <tr>
                      <th scope="col" className="px-2 py-2 sm:px-3 font-medium">Data</th>
                      <th scope="col" className="px-2 py-2 sm:px-3 text-right font-medium">In Tally</th>
                      <th scope="col" className="px-2 py-2 sm:px-3 text-right font-medium">{afterImport ? 'Imported' : 'New'}</th>
                      <th scope="col" className="px-2 py-2 sm:px-3 text-right font-medium"><span className="sm:hidden">Existing</span><span className="hidden sm:inline">Already in ManuFlow</span></th>
                      <th scope="col" className="px-2 py-2 sm:px-3 text-right font-medium"><span className="sm:hidden">Issues</span><span className="hidden sm:inline">Need attention</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {cats.map((c) => {
                      const k = KINDS.find((x) => x.kind === c.kind)!
                      const n = afterImport ? c.done : c.preview
                      const show = c.read === 'done' && counted
                      return (
                        <tr key={c.kind} className="border-t">
                          <th scope="row" className="px-2 py-2 sm:px-3 text-left font-medium">
                            {k.label}
                            {c.read === 'failed' && <span className="block text-xs font-normal text-destructive">{c.error}</span>}
                          </th>
                          <td className="px-2 py-2 sm:px-3 text-right tabular-nums">{c.read === 'done' ? c.records : c.read === 'reading' ? <Loader2 className="ml-auto h-4 w-4 animate-spin" aria-label="Reading" /> : c.read === 'failed' ? <XCircle className="ml-auto h-4 w-4 text-destructive" aria-label="Failed" /> : '—'}</td>
                          <td className="px-2 py-2 sm:px-3 text-right tabular-nums">{show ? (afterImport ? n.imported : n.ready) : '—'}</td>
                          <td className="px-2 py-2 sm:px-3 text-right tabular-nums">{show ? n.duplicates : '—'}</td>
                          <td className={cn('px-3 py-2 text-right tabular-nums', n.problems > 0 && 'font-medium text-warning')}>{show ? n.problems : '—'}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>

              {phase === 'ready' && sum((c) => c.preview.ready) === 0 && (
                <p className="text-sm">Nothing new to import{sum((c) => c.preview.duplicates) ? ' — everything is already in ManuFlow' : ''}.</p>
              )}
              {phase === 'ready' && sum((c) => c.preview.ready) > 0 && (
                <p className="text-sm text-muted-foreground">Existing ManuFlow records are never changed: matching names are skipped. Rows that need attention are not imported and are listed below.</p>
              )}
              {phase === 'done' && (
                <Alert>
                  <CheckCircle2 className="h-4 w-4 text-success" />
                  <AlertTitle>Import finished</AlertTitle>
                  <AlertDescription>
                    {sum((c) => c.done.imported)} imported · {sum((c) => c.done.duplicates)} already in ManuFlow (skipped) · {sum((c) => c.done.problems)} not imported. Each part is recorded in Import History.
                  </AlertDescription>
                </Alert>
              )}
              {phase === 'stopped' && <Problem text="Stopped. Parts that finished before stopping are imported and recorded in Import History; running it again skips them." tone="info" />}
              {runError && <Problem text={runError} />}

              {allProblems.length > 0 && (phase === 'ready' || phase === 'done' || phase === 'stopped') && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <p className="mr-auto text-sm font-medium">Need attention ({allProblems.length}{allProblems.length >= 200 ? '+' : ''})</p>
                    <Button variant="outline" size="sm" onClick={() => downloadText('tally-import-problems.csv', problemRowsCsv(allProblems))}>
                      <Download className="mr-2 h-4 w-4" aria-hidden /> Download list
                    </Button>
                  </div>
                  <ul className="max-h-48 divide-y overflow-y-auto rounded-lg border text-sm">
                    {allProblems.slice(0, 100).map((p, i) => (
                      <li key={i} className="px-3 py-1.5">
                        <span className="font-medium">{p.values.name || '—'}</span>
                        <span className="text-muted-foreground"> · {STATUS_LABEL[p.status]}: {p.messages.join('; ')}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </section>
          )}
        </div>

        {/* ---------------- actions ---------------- */}
        <div className="flex flex-wrap items-center gap-2 border-t bg-background px-5 py-3 sm:px-6">
          {step > 1 && phase !== 'importing' && (
            <Button variant="outline" onClick={back}><ArrowLeft className="mr-2 h-4 w-4" aria-hidden /> Back</Button>
          )}
          <span className="mr-auto text-xs text-muted-foreground" aria-live="polite">{nextHint}</span>
          {step < 4 && (
            <Button onClick={() => setStep((s) => s + 1)} disabled={!canNext} className="bg-primary text-primary-foreground hover:bg-primary/90">
              Next <ArrowRight className="ml-2 h-4 w-4" aria-hidden />
            </Button>
          )}
          {step === 4 && busy && (
            <Button variant="outline" onClick={() => { stopRef.current = true; if (phase !== 'importing') cancelOpenJobs() }}>
              <Square className="mr-2 h-4 w-4" aria-hidden /> {phase === 'importing' ? 'Stop after this part' : 'Cancel'}
            </Button>
          )}
          {step === 4 && (phase === 'failed' || phase === 'stopped') && (
            <Button variant="outline" onClick={() => void readAndCheck()}><RefreshCw className="mr-2 h-4 w-4" aria-hidden /> Check again</Button>
          )}
          {step === 4 && phase === 'ready' && (
            <Button onClick={() => void importAll()} disabled={sum((c) => c.preview.ready) === 0} className="bg-primary text-primary-foreground hover:bg-primary/90">
              <Upload className="mr-2 h-4 w-4" aria-hidden /> Import data
            </Button>
          )}
          {step === 4 && phase === 'done' && (
            <Button onClick={() => onOpenChange(false)} className="bg-primary text-primary-foreground hover:bg-primary/90">Done</Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function Stepper({ step }: { step: number }) {
  return (
    <>
      <p className="pt-3 text-sm font-medium sm:hidden">Step {step} of {STEPS.length} · {STEPS[step - 1]}</p>
      <ol className="hidden items-center gap-2 pt-4 sm:flex" aria-label="Import steps">
        {STEPS.map((s, i) => {
          const n = i + 1
          return (
            <li key={s} aria-current={n === step ? 'step' : undefined} className="flex flex-1 items-center gap-2">
              <span className={cn('grid h-7 w-7 shrink-0 place-items-center rounded-full border text-xs font-semibold',
                n < step ? 'border-primary bg-primary text-primary-foreground' : n === step ? 'border-primary text-success' : 'text-muted-foreground')}>
                {n < step ? <CheckCircle2 className="h-4 w-4" aria-hidden /> : n}
              </span>
              <span className={cn('text-sm', n === step ? 'font-medium' : 'text-muted-foreground')}>{s}</span>
              {n < STEPS.length && <span className="h-px flex-1 bg-border" aria-hidden />}
            </li>
          )
        })}
      </ol>
    </>
  )
}

function Problem({ text, tone = 'error' }: { text: string; tone?: 'error' | 'info' }) {
  return (
    <p role={tone === 'error' ? 'alert' : 'status'} className={cn('flex items-start gap-1.5 text-sm', tone === 'error' ? 'text-destructive' : 'text-muted-foreground')}>
      <XCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> {text}
    </p>
  )
}
