'use client'

import * as React from 'react'
import { toast } from 'sonner'
import {
  ArrowLeft, ArrowRight, Building2, CalendarRange, CheckCircle2, ChevronDown, Circle, Download, FileSpreadsheet, Loader2, Lock,
  Package, RefreshCw, Search, Square, Upload, Users, XCircle,
} from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import { Skeleton } from '@/components/ui/skeleton'
import { ConnectErrorCard, ConnectingCard, PairingIntro } from '@/components/erp/import-center/tally-auto-connect'
import TallyConnectorPanel, { CONNECTOR_BADGE } from '@/components/erp/import-center/tally-connector-panel'
import { ITEM_TYPES, ITEM_TYPE_LABEL, fmtDate } from '@/lib/erp-constants'
import type { RunResult, RunRow } from '@/lib/import/run'
import { STATUS_LABEL, downloadText, friendlyError, problemRowsCsv } from '@/lib/import/wizard-helpers'
import type { ConnectorStatus } from '@/lib/tally/connector'
import {
  CONNECT_DEADLINE_MS, LIST_AUTO_RETRIES, autoConnectProgress, connectFailure, pollDelay, tallyFlow, type TallyFlow,
} from '@/lib/tally/flow'
import type { JobView } from '@/lib/tally/jobs'
import type { TallyPeriod } from '@/lib/tally/period'
import { api, apiDelete, apiGet, apiPost } from '@/lib/use-api'
import { cn } from '@/lib/utils'

/**
 * Import from Tally through the ManuFlow Tally Connector: 1 Connect → 2 Company → 3 Data → 4 Review & import.
 * Everything shown comes from the server: the connector status, Tally's own company list, the records the connector
 * read, and the Import Center preview / import of those records (same checks and duplicate rules as a file import).
 * Vouchers, orders, other masters, stock, balances and the period are shown as not available — they are not built.
 * Automatic connection: a paired connector reconnects by itself, and whenever it is connected the dialog moves on to the
 * company list (unless the user went back to step 1), which it fetches by itself; a list that failed is fetched again
 * when the connection comes back. The connection is watched on every step. Nothing is read from a company until the
 * user chooses it. The import needs an explicit confirmation, and its progress counts come from the server's batch
 * results.
 */

type Kind = 'customers' | 'suppliers' | 'items'
type Company = NonNullable<JobView['companies']>[number]

const STEPS = ['Connect Tally', 'Choose company', 'Select data', 'Review & import']
const KINDS: { kind: Kind; label: string; hint: string; job: string }[] = [
  { kind: 'customers', label: 'Customers', hint: 'Sundry Debtors ledgers', job: 'export-customers' },
  { kind: 'suppliers', label: 'Suppliers', hint: 'Sundry Creditors ledgers', job: 'export-suppliers' },
  { kind: 'items', label: 'Stock items', hint: 'Name, unit, HSN, GST rate, stock group', job: 'export-items' },
]
// Listed so users see what is not there yet; none can be selected (no Tally reader, mapping or accounting rules yet)
const UNAVAILABLE: { title: string; items: string[] }[] = [
  { title: 'Masters', items: ['Ledgers (bank, expenses, …)', 'Ledger groups', 'Stock groups', 'Units', 'Godowns / locations', 'Cost centres'] },
  { title: 'Vouchers', items: ['Sales', 'Purchase', 'Payment', 'Receipt', 'Contra', 'Journal', 'Debit notes', 'Credit notes', 'Sales orders', 'Purchase orders', 'Delivery notes', 'Receipt notes', 'Stock journals'] },
  { title: 'Stock', items: ['Opening stock', 'Stock movements', 'Stock summary / balances', 'Closing stock'] },
  { title: 'Accounts', items: ['Opening balances', 'Closing balances', 'Ledger balances', 'Trial balance', 'Outstanding receivables', 'Outstanding payables'] },
]
const UNAVAILABLE_COUNT = UNAVAILABLE.reduce((s, g) => s + g.items.length, 0)
const WATCH_MS = 10_000
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

type FixedPeriod = 'current-fy' | 'last-fy' | 'all'
type PeriodOption = { ok: true; period: TallyPeriod } | { ok: false; message: string }
const PERIODS: { kind: FixedPeriod | 'custom'; label: string }[] = [
  { kind: 'current-fy', label: 'Current financial year' },
  { kind: 'last-fy', label: 'Last financial year' },
  { kind: 'all', label: 'All data (every financial year)' },
  { kind: 'custom', label: 'Custom date range' },
]

function elapsed(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`
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
  // Step 3: what each period would cover for the chosen Tally company (worked out by the server from Tally's dates)
  const [periodInfo, setPeriodInfo] = React.useState<{ company: string; options: Record<FixedPeriod, PeriodOption> } | null>(null)
  // Step 4
  const [phase, setPhase] = React.useState<Phase>('idle')
  const [cats, setCats] = React.useState<CatState[]>([])
  const [stage, setStage] = React.useState('')
  const [progress, setProgress] = React.useState({ done: 0, total: 0 })
  const [runError, setRunError] = React.useState('')
  const [confirming, setConfirming] = React.useState(false)
  const [importStarted, setImportStarted] = React.useState(false)
  const [timing, setTiming] = React.useState<{ start: number; end: number | null } | null>(null)
  const [, setTick] = React.useState(0)
  const stopRef = React.useRef(false)
  const busyRef = React.useRef(false)
  const openJobs = React.useRef(new Set<string>())
  const checkedFor = React.useRef('')

  const connected = conn?.state === 'connected'
  const busy = phase === 'reading' || phase === 'checking' || phase === 'importing'
  const q = `companyId=${companyId}`
  // The user went back to step 1 on purpose: the connector panel is shown as it is, no automatic connection
  const [manualConnect, setManualConnect] = React.useState(false)
  // The connector panel (first-time pairing, connector details) reports what it sees; the automatic flow takes it from there
  const onStatus = React.useCallback((s: ConnectorStatus) => { setConn(s) }, [])

  // ---------- step 1: automatic connection (src/lib/tally/flow.ts → autoConnectProgress) ----------
  // One status check at a time, with growing waits; every check also tells the connector to check in every 5 s for a
  // while (markWatching on the server), which is how a reconnect is sped up. Stops after CONNECT_DEADLINE_MS, on close,
  // or when it is not needed (connected and companies read, pairing needed, or nothing to wait for).
  const [attempt, setAttempt] = React.useState(0)
  const [startedAt, setStartedAt] = React.useState(() => Date.now())
  const [timedOut, setTimedOut] = React.useState(false)
  const [networkError, setNetworkError] = React.useState('')
  const listRetries = React.useRef(0)
  const listingRef = React.useRef(false)

  // Steps 2–4: keep watching the connection (step 1 has the connector panel, which polls itself)
  React.useEffect(() => {
    if (step === 1) return
    let alive = true
    const t = setInterval(() => {
      apiGet<ConnectorStatus>(`/api/import-center/tally/connector?${q}`).then((s) => { if (alive) setConn(s) }).catch(() => {})
    }, WATCH_MS)
    return () => { alive = false; clearInterval(t) }
  }, [step, q])

  React.useEffect(() => {
    if (step !== 3 || !company || periodInfo?.company === company) return
    let alive = true
    apiGet<{ options: Record<FixedPeriod, PeriodOption> }>(`/api/import-center/tally/period?${q}&tallyCompany=${encodeURIComponent(company)}`)
      .then((r) => { if (alive) setPeriodInfo({ company, options: r.options }) })
      .catch(() => {})
    return () => { alive = false }
  }, [step, company])

  // Elapsed time of a running import
  React.useEffect(() => {
    if (phase !== 'importing') return
    const t = setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [phase])

  const auto = autoConnectProgress(conn, { listing, companies, error: listError })
  const autoMode = step === 1 && !manualConnect
  const listGaveUp = !!listError && listRetries.current >= LIST_AUTO_RETRIES
  const checking = autoMode && auto.outcome.kind === 'working' && !timedOut && !listGaveUp

  React.useEffect(() => {
    if (!checking) return
    let alive = true
    const ctrl = new AbortController()
    const timer = setTimeout(async () => {
      try {
        const s = await api<ConnectorStatus>(`/api/import-center/tally/connector?${q}`, { signal: ctrl.signal })
        if (!alive) return
        setConn(s)
        setNetworkError('')
      } catch (e) {
        if (!alive || ctrl.signal.aborted) return
        setNetworkError(friendlyError(e)) // temporary: checked again with the next attempt
      }
      if (!alive) return
      // Reading the company list has its own limits (the job's lease); the overall wait only covers the connection
      if (Date.now() - startedAt > CONNECT_DEADLINE_MS && !listingRef.current) setTimedOut(true)
      else setAttempt((a) => a + 1)
    }, attempt === 0 ? 0 : pollDelay(attempt))
    return () => { alive = false; clearTimeout(timer); ctrl.abort() }
  }, [checking, attempt])

  // The connection came back while the error was shown (e.g. through the connector panel): carry on by itself
  React.useEffect(() => {
    if (autoMode && timedOut && conn?.state === 'connected' && !listError) { setTimedOut(false); setStartedAt(Date.now()); setAttempt(0) }
  }, [autoMode, timedOut, conn?.state])

  function retryConnect() {
    listRetries.current = 0
    setConn(null)
    setListError('')
    setNetworkError('')
    setTimedOut(false)
    setStartedAt(Date.now())
    setAttempt(0)
  }

  // ---------- Tally jobs ----------
  async function waitForJob(type: string, tallyCompany?: string, reuse = false): Promise<JobView> {
    let job = await apiPost<JobView>(`/api/import-center/tally/jobs?${q}`, { type, tallyCompany, ...(reuse ? { reuse } : {}) })
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

  /** reuse: asked for by the screen itself, so a list read a few seconds ago will do (Refresh always reads again). */
  async function loadCompanies(reuse = false) {
    if (listingRef.current) return // one read at a time (double clicks, effects running twice)
    listingRef.current = true
    setListing(true); setListError(''); stopRef.current = false
    try {
      const job = await waitForJob('list-companies', undefined, reuse)
      if (job.status !== 'done') { setListError(job.message || 'Tally did not return the company list.'); return }
      const list = job.companies ?? []
      setCompanies(list)
      setShown(PAGE)
      // Keep the choice when it is still open in Tally (and can still be told apart from other companies)
      if (company && !list.some((c) => c.name === company && !c.ambiguous)) setCompany('')
      if (!company && list.length === 1 && !list[0].ambiguous) setCompany(list[0].name)
    } catch (e) {
      if (!(e instanceof Stopped)) setListError(friendlyError(e))
    } finally {
      listingRef.current = false
      setListing(false)
    }
  }

  // Step 1: once connected, read the company list by itself (a failed read is tried again a few times), then go on
  React.useEffect(() => {
    if (!autoMode || conn?.state !== 'connected' || listing) return
    if (companies === null && !listError) { void loadCompanies(true); return }
    if (listError && listRetries.current < LIST_AUTO_RETRIES) {
      const t = setTimeout(() => { listRetries.current += 1; void loadCompanies(true) }, 2000 * (listRetries.current + 1))
      return () => clearTimeout(t)
    }
  }, [autoMode, conn?.state, listing, listError, companies])

  React.useEffect(() => {
    if (autoMode && auto.outcome.kind === 'ready') setStep(2)
  }, [autoMode, auto.outcome.kind])

  // Company discovery: by itself once connected, and again when the connection comes back after a failed read
  React.useEffect(() => {
    if (step === 2 && connected && !listing && (companies === null || listError)) void loadCompanies(true)
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
    setConfirming(false)
    setImportStarted(false)
    setTiming(null)
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
    setConfirming(false)
    setImportStarted(true)
    const startedAt = Date.now()
    setTiming({ start: startedAt, end: null })
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
      setTiming({ start: startedAt, end: Date.now() })
    }
  }

  // ---------- navigation ----------
  const filtered = (companies ?? []).filter((c) => c.name.toLowerCase().includes(search.trim().toLowerCase()))
  const canNext = step === 1 ? connected : step === 2 ? !!company : step === 3 ? kinds.size > 0 && (!kinds.has('items') || !!itemType) : false
  const nextHint = step === 1 ? (connected ? '' : 'Connect Tally to continue')
    : step === 2 ? (company ? '' : 'Choose a company to continue')
      : step === 3 ? (kinds.size === 0 ? 'Choose what to import' : kinds.has('items') && !itemType ? 'Choose the item type for stock items' : '') : ''

  function back() {
    if (step === 2) setManualConnect(true)
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
  const totals = { imported: sum((c) => c.done.imported), skipped: sum((c) => c.done.duplicates), failed: sum((c) => c.done.problems) }
  const percent = phase === 'done' ? 100 : progress.total ? Math.min(99, Math.floor((progress.done / progress.total) * 100)) : 0
  const lostConnection = step > 1 && conn && conn.state !== 'connected'
  const flow = tallyFlow(conn, { listing, companies, error: listError })
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
          {lostConnection && (
            <Alert className="mb-4" data-testid="tally-connection-warning">
              {conn.state === 'reconnecting' ? <RefreshCw className="h-4 w-4 animate-spin" /> : <XCircle className="h-4 w-4 text-destructive" />}
              <AlertTitle>Tally connection: {CONNECTOR_BADGE[conn.state].label}</AlertTitle>
              <AlertDescription>{conn.message} Reading from Tally waits until the connection is back.</AlertDescription>
            </Alert>
          )}
          {/* ---------------- 1 Connect ---------------- */}
          {step === 1 && (
            <section className="space-y-4" aria-labelledby="t-step1">
              <h3 id="t-step1" className="sr-only">Connect Tally</h3>
              {manualConnect ? (
                <>
                  <FlowBar flow={flow} />
                  <TallyConnectorPanel companyId={companyId} onStatus={onStatus} />
                </>
              ) : auto.outcome.kind === 'needs-pairing' ? (
                <>
                  <PairingIntro reason={auto.outcome.reason} />
                  <TallyConnectorPanel companyId={companyId} onStatus={onStatus} />
                </>
              ) : auto.outcome.kind === 'blocked' || timedOut || listGaveUp ? (
                <ConnectErrorCard
                  failure={connectFailure(conn, { error: listError }, networkError)}
                  onRetry={auto.outcome.kind === 'blocked' && auto.outcome.reason === 'unavailable' ? undefined : retryConnect}
                  onUseFile={onUseFile}>
                  {conn?.connector && (
                    <details className="text-sm">
                      <summary className="cursor-pointer text-muted-foreground">Connector details</summary>
                      <div className="mt-2"><TallyConnectorPanel companyId={companyId} onStatus={onStatus} /></div>
                    </details>
                  )}
                </ConnectErrorCard>
              ) : (
                <ConnectingCard steps={auto.steps} note={networkError ? 'ManuFlow did not answer — trying again…' : conn?.state === 'tally_error' ? 'The connector is online; waiting for TallyPrime to answer…' : undefined} />
              )}
              {(manualConnect || auto.outcome.kind === 'needs-pairing') && (
                <button type="button" onClick={onUseFile} className="inline-flex items-center gap-1.5 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
                  <FileSpreadsheet className="h-4 w-4" aria-hidden /> No connector? Import an Excel / CSV file exported from Tally instead
                </button>
              )}
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
              <FlowBar flow={flow} />
              <p className="text-sm text-muted-foreground">
                Tally lists only the companies that are open in TallyPrime right now{companies ? ` (${companies.length})` : ''}.
              </p>
              {(companies?.length ?? 0) > 0 && (
                <div className="relative">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                  <Input value={search} onChange={(e) => { setSearch(e.target.value); setShown(PAGE) }} placeholder="Search companies" aria-label="Search companies" className="pl-9" />
                </div>
              )}
              {listError && (
                <div className="flex flex-wrap items-center gap-2">
                  <Problem text={listError} />
                  <Button variant="outline" size="sm" onClick={() => void loadCompanies()} disabled={listing || !connected}>Try again</Button>
                  {!connected && <span className="text-xs text-muted-foreground">Tried again by itself when the connection is back.</span>}
                </div>
              )}
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
                    const on = c.name === company && !c.ambiguous
                    return (
                      <button key={`${c.name}|${c.guid ?? ''}`} type="button" role="radio" aria-checked={on} onClick={() => setCompany(c.name)} disabled={c.ambiguous}
                        className={cn('flex items-start gap-3 rounded-lg border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                          c.ambiguous ? 'cursor-not-allowed opacity-70' : on ? 'border-primary bg-success-soft ring-1 ring-ring dark:bg-success-soft' : 'hover:bg-muted/60')}>
                        <Building2 className={cn('mt-0.5 h-5 w-5 shrink-0', on ? 'text-success' : 'text-muted-foreground')} aria-hidden />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium">{c.name}</span>
                          <span className="block text-xs text-muted-foreground">
                            {c.booksFrom ? `Books from ${fmtDate(c.booksFrom)}` : c.startingFrom ? `Financial year from ${fmtDate(c.startingFrom)}` : 'Financial year not reported'}
                          </span>
                          {c.ambiguous && (
                            <span className="block text-xs text-destructive">Another open company has the same name. Close one of them in TallyPrime, then Refresh.</span>
                          )}
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
              <CompanyLine company={company} onChange={() => setStep(2)} />
              <div className="flex flex-wrap items-center gap-2">
                <h3 id="t-step3" className="mr-auto text-base font-semibold">What should be imported?</h3>
                <Button variant="ghost" size="sm" onClick={() => setKinds(new Set(KINDS.map((k) => k.kind)))} disabled={kinds.size === KINDS.length}>Select all</Button>
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

              <fieldset disabled aria-describedby="t-period-note" className="space-y-2 rounded-lg border p-3" data-testid="tally-period">
                <legend className="flex items-center gap-1.5 px-1 text-sm font-medium">
                  <CalendarRange className="h-4 w-4 text-muted-foreground" aria-hidden /> Period <span className="font-normal text-muted-foreground">— not available yet</span>
                </legend>
                <ul className="grid gap-1.5 sm:grid-cols-2">
                  {PERIODS.map((p) => {
                    const o = p.kind === 'custom' || periodInfo?.company !== company ? undefined : periodInfo.options[p.kind]
                    return (
                      <li key={p.kind}>
                        <label className="flex cursor-not-allowed items-start gap-2 rounded-lg border px-2.5 py-1.5 text-xs text-muted-foreground">
                          <input type="radio" name="t-period" disabled className="mt-0.5 h-3 w-3" aria-label={`${p.label} (not available yet)`} />
                          <span>
                            <span className="block font-medium">{p.label}</span>
                            <span className="block" data-testid={`tally-period-${p.kind}`}>
                              {p.kind === 'custom' ? 'Any dates up to the end of the current financial year' : periodText(o)}
                            </span>
                          </span>
                        </label>
                      </li>
                    )
                  })}
                </ul>
                <p id="t-period-note" className="text-xs text-muted-foreground">
                  The dates come from {company ? `“${company}”` : 'the company'} in Tally. A period applies to vouchers, which cannot be read from Tally yet;
                  customers, suppliers and stock items are read as they are in Tally today.
                </p>
              </fieldset>

              <div className="rounded-lg border bg-muted/30">
                <button type="button" onClick={() => setShowLater((v) => !v)} aria-expanded={showLater}
                  className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm">
                  <Lock className="h-4 w-4 text-muted-foreground" aria-hidden />
                  <span className="flex-1">{UNAVAILABLE_COUNT} more kinds of data <span className="text-muted-foreground">— not available yet</span></span>
                  <ChevronDown className={cn('h-4 w-4 transition-transform', showLater && 'rotate-180')} aria-hidden />
                </button>
                {showLater && (
                  <div className="space-y-3 border-t px-3 py-3 text-sm" data-testid="tally-unavailable">
                    <p className="text-muted-foreground">These cannot be read from Tally yet: vouchers, stock and balances need accounting rules (ledgers, numbering, outstanding bills) that ManuFlow does not have for imported data, and the Tally replies are not verified yet.</p>
                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                      {UNAVAILABLE.map((g) => (
                        <fieldset key={g.title} disabled>
                          <legend className="font-medium">{g.title}</legend>
                          <ul className="mt-1 space-y-1">
                            {g.items.map((item) => (
                              <li key={item} className="flex items-center gap-2 text-muted-foreground">
                                <Checkbox disabled aria-label={`${item} (not available yet)`} /> {item}
                              </li>
                            ))}
                          </ul>
                        </fieldset>
                      ))}
                    </div>
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
              {!busy && phase !== 'done' && !importStarted && <CompanyLine company={company} onChange={() => setStep(2)} />}
              {(phase === 'reading' || phase === 'checking' || phase === 'ready') && (
                <p className="text-sm text-muted-foreground">Preview — nothing is saved in ManuFlow until you confirm the import.</p>
              )}

              {(busy || stage) && (
                <div className="space-y-2" aria-live="polite">
                  <p className="flex items-center gap-2 text-sm font-medium"><Loader2 className="h-4 w-4 animate-spin" aria-hidden /> {stage}</p>
                </div>
              )}
              {importStarted && (
                <div className="space-y-2" data-testid="tally-progress">
                  <div className="flex items-center gap-3">
                    <Progress value={percent} aria-label="Import progress" className="flex-1" />
                    <span className="w-12 text-right text-sm font-semibold tabular-nums">{percent}%</span>
                  </div>
                  <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
                    <Stat label="Processed" value={`${progress.done} of ${progress.total}`} />
                    <Stat label="Remaining" value={Math.max(0, progress.total - progress.done)} />
                    <Stat label="Imported" value={totals.imported} tone="text-success" />
                    <Stat label="Skipped (already in ManuFlow)" value={totals.skipped} />
                    <Stat label="Not imported" value={totals.failed} tone={totals.failed ? 'text-warning' : undefined} />
                    <Stat label="Time" value={timing ? elapsed((timing.end ?? Date.now()) - timing.start) : '—'} />
                  </dl>
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
                    {totals.imported} imported · {totals.skipped} already in ManuFlow (skipped) · {totals.failed} not imported{timing?.end ? ` · ${elapsed(timing.end - timing.start)}` : ''}. Each part is recorded in Import History.
                  </AlertDescription>
                </Alert>
              )}
              {phase === 'stopped' && <Problem text="Stopped. Parts that finished before stopping are imported and recorded in Import History; continuing skips them." tone="info" />}
              {confirming && phase === 'ready' && (
                <Alert data-testid="tally-confirm">
                  <Upload className="h-4 w-4" />
                  <AlertTitle>Import {sum((c) => c.preview.ready)} new records into {companyName || 'this company'}?</AlertTitle>
                  <AlertDescription>
                    <p>From Tally company “{company}”. Existing ManuFlow records are not changed; {sum((c) => c.preview.duplicates)} already there will be skipped and {sum((c) => c.preview.problems)} that need attention are not imported. Nothing is written to Tally.</p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Button size="sm" onClick={() => void importAll()} className="bg-primary text-primary-foreground hover:bg-primary/90">Yes, import</Button>
                      <Button size="sm" variant="outline" onClick={() => setConfirming(false)}>Cancel</Button>
                    </div>
                  </AlertDescription>
                </Alert>
              )}
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
          {step === 4 && (phase === 'failed' || phase === 'stopped') && importStarted && (
            <Button onClick={() => void importAll()} className="bg-primary text-primary-foreground hover:bg-primary/90">
              <Upload className="mr-2 h-4 w-4" aria-hidden /> Continue import
            </Button>
          )}
          {step === 4 && phase === 'ready' && !confirming && (
            <Button onClick={() => setConfirming(true)} disabled={sum((c) => c.preview.ready) === 0} className="bg-primary text-primary-foreground hover:bg-primary/90">
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

const FLOW_STAGES = ['Connector', 'TallyPrime', 'Companies']

/** Where the automatic connection is: connector → TallyPrime → company list, and the current state in words. */
function FlowBar({ flow }: { flow: TallyFlow }) {
  const problem = ['auth_failed', 'connector_offline', 'tally_unreachable', 'retry', 'outdated', 'unavailable'].includes(flow.state)
  const busy = ['detecting', 'connecting', 'fetching_companies'].includes(flow.state)
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border bg-muted/30 px-3 py-2 text-sm" data-testid="tally-flow" data-state={flow.state}>
      <ol className="flex items-center gap-3" aria-label="Connection progress">
        {FLOW_STAGES.map((s, i) => {
          const done = flow.reached > i
          return (
            <li key={s} className={cn('flex items-center gap-1.5', done ? 'text-success' : 'text-muted-foreground')}>
              {done ? <CheckCircle2 className="h-4 w-4" aria-hidden /> : <Circle className="h-4 w-4" aria-hidden />}
              <span>{s}<span className="sr-only">{done ? ': done' : ': not yet'}</span></span>
            </li>
          )
        })}
      </ol>
      <span className={cn('ml-auto flex items-center gap-1.5 font-medium', problem ? 'text-destructive' : flow.reached === 3 ? 'text-success' : '')} role="status">
        {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />} {flow.label}
      </span>
    </div>
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

function periodText(o: PeriodOption | undefined) {
  if (!o) return '…'
  if (!o.ok) return o.message
  const years = o.period.financialYears.length
  return `${fmtDate(o.period.from)} – ${fmtDate(o.period.to)}${years > 1 ? ` · ${years} financial years` : ''}`
}

function CompanyLine({ company, onChange }: { company: string; onChange: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/30 px-3 py-2 text-sm">
      <Building2 className="h-4 w-4 text-muted-foreground" aria-hidden />
      <span className="mr-auto">Tally company: <span className="font-medium">{company}</span></span>
      <Button variant="outline" size="sm" onClick={onChange}>Change company</Button>
    </div>
  )
}

function Stat({ label, value, tone }: { label: string; value: React.ReactNode; tone?: string }) {
  return (
    <div className="rounded-lg border px-3 py-2">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={cn('text-base font-semibold tabular-nums', tone)}>{value}</dd>
    </div>
  )
}

function Problem({ text, tone = 'error' }: { text: string; tone?: 'error' | 'info' }) {
  return (
    <p role={tone === 'error' ? 'alert' : 'status'} className={cn('flex items-start gap-1.5 text-sm', tone === 'error' ? 'text-destructive' : 'text-muted-foreground')}>
      <XCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> {text}
    </p>
  )
}
