'use client'

import * as React from 'react'
import {
  AlertTriangle, Ban, Check, CheckCircle2, ChevronDown, CircleDashed, Copy, Database, History, Info, Package, Search, Truck, Users,
  X, XCircle,
} from 'lucide-react'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import type { RunRowStatus } from '@/lib/import/run'
import { cn } from '@/lib/utils'

/**
 * Presentation of the Tally Import Center's review, import and result stages (src/components/erp/import-center/
 * tally-import.tsx keeps all state, server calls and rules). Every figure shown here comes from the server's preview
 * / commit replies passed in as props; nothing is computed from what a button was clicked.
 */

export type ReviewKind = 'customers' | 'suppliers' | 'items'
export type GstinAnswer = 'import' | 'skip'

/** One record of the preview as the server returned it. */
export interface ReviewRow {
  key: string
  kind: ReviewKind
  line: number
  name: string
  code?: string
  gstin?: string
  gstType?: string
  status: RunRowStatus
  messages: string[]
}

/** Preview totals (the server's counts per data type, added up). */
export interface ReviewCounts {
  total: number
  ready: number
  gstinMissing: number
  existing: number
  invalid: number
  /** GSTIN-missing records the user chose to skip (answers given so far) */
  willSkip: number
  /** GSTIN-missing records without an answer yet */
  pending: number
}

export type StatusFilter = 'all' | 'ready' | 'gstin' | 'existing' | 'invalid' | 'skip'

const KIND_LABEL: Record<ReviewKind, { one: string; many: string; icon: React.ElementType }> = {
  customers: { one: 'Customer', many: 'Customers', icon: Users },
  suppliers: { one: 'Supplier', many: 'Suppliers', icon: Truck },
  items: { one: 'Stock item', many: 'Stock items', icon: Package },
}
export const kindLabel = (k: ReviewKind) => KIND_LABEL[k].one

// ---------------------------------------------------------------- stages

const STAGES = ['Connect & Fetch', 'Review & Confirm', 'Import', 'Result']

/**
 * The four stages of an import. `stage` is where the import really is (worked out by the caller from the wizard step
 * and the import phase); a stage is shown as done only when the caller has moved past it.
 */
export function ImportStages({ stage, sub }: { stage: 1 | 2 | 3 | 4; sub?: { labels: string[]; current: number } }) {
  return (
    <div>
      <div className="sm:hidden">
        <p className="text-sm font-medium">Stage {stage} of 4 · {STAGES[stage - 1]}</p>
        {stage === 1 && sub && <p className="mt-0.5 text-xs text-muted-foreground">{sub.labels[sub.current]}</p>}
        <div className="mt-2 grid grid-cols-4 gap-1.5" aria-hidden>
          {STAGES.map((s, i) => <span key={s} className={cn('h-1.5 rounded-full', i < stage ? 'bg-primary' : 'bg-muted')} />)}
        </div>
      </div>
      <ol className="hidden items-start gap-3 sm:flex" aria-label="Import steps">
        {STAGES.map((s, i) => {
          const n = i + 1
          const done = n < stage
          const current = n === stage
          return (
            <li key={s} aria-current={current ? 'step' : undefined} className="flex flex-1 items-start gap-3 last:flex-none">
              <span className={cn('grid h-8 w-8 shrink-0 place-items-center rounded-full border-2 text-xs font-semibold',
                done ? 'border-primary bg-primary text-primary-foreground' : current ? 'border-primary bg-success-soft text-success ring-4 ring-success-soft' : 'border-border text-muted-foreground')}>
                {done ? <Check className="h-4 w-4" aria-hidden /> : n}
              </span>
              <span className="min-w-0 pt-1">
                <span className={cn('block whitespace-nowrap text-sm', current ? 'font-semibold text-foreground' : done ? 'font-medium text-foreground' : 'text-muted-foreground')}>
                  {s}<span className="sr-only">{done ? ' (done)' : current ? ' (current step)' : ''}</span>
                </span>
                {n === 1 && sub && current && (
                  <span className="mt-0.5 block text-xs text-muted-foreground">{sub.labels[sub.current]} · {sub.current + 1} of {sub.labels.length}</span>
                )}
              </span>
              {n < STAGES.length && <span className={cn('mt-4 h-0.5 min-w-4 flex-1 rounded-full', done ? 'bg-primary' : 'bg-border')} aria-hidden />}
            </li>
          )
        })}
      </ol>
    </div>
  )
}

// ---------------------------------------------------------------- summary cards

const CARDS: { key: StatusFilter; label: string; icon: React.ElementType; tone: string; value: (c: ReviewCounts) => number; hint: string }[] = [
  { key: 'all', label: 'Total Records', icon: Database, tone: 'text-foreground bg-muted', value: (c) => c.total, hint: 'Read from Tally' },
  { key: 'ready', label: 'Ready to Import', icon: CheckCircle2, tone: 'text-success bg-success-soft', value: (c) => c.ready, hint: 'New, all checks passed' },
  { key: 'gstin', label: 'GSTIN Missing', icon: AlertTriangle, tone: 'text-warning bg-warning-soft', value: (c) => c.gstinMissing, hint: 'Your yes / no needed' },
  { key: 'existing', label: 'Duplicates / Existing', icon: Copy, tone: 'text-info bg-info-soft', value: (c) => c.existing, hint: 'Already in ManuFlow' },
  { key: 'invalid', label: 'Invalid Records', icon: XCircle, tone: 'text-destructive bg-danger-soft', value: (c) => c.invalid, hint: 'Not imported' },
  { key: 'skip', label: 'Will Be Skipped', icon: Ban, tone: 'text-muted-foreground bg-muted', value: (c) => c.willSkip, hint: 'You chose to skip' },
]

/** Six compact cards; a card filters the table to its records. */
export function SummaryCards({ counts, active, onFilter }: { counts: ReviewCounts; active: StatusFilter; onFilter: (f: StatusFilter) => void }) {
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 2xl:grid-cols-6" data-testid="tally-summary-cards">
      {CARDS.map((c) => {
        const on = active === c.key
        return (
          <button key={c.key} type="button" onClick={() => onFilter(on && c.key !== 'all' ? 'all' : c.key)} aria-pressed={on}
            data-testid={`tally-card-${c.key}`}
            className={cn('flex min-w-0 items-start gap-3 rounded-xl border bg-card p-3.5 text-left shadow-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              on ? 'border-primary ring-1 ring-primary' : 'hover:bg-muted/40')}>
            <span className={cn('grid h-9 w-9 shrink-0 place-items-center rounded-lg', c.tone)} aria-hidden><c.icon className="h-4.5 w-4.5" /></span>
            <span className="min-w-0">
              <span className="block truncate text-xs text-muted-foreground">{c.label}</span>
              <span className="block text-xl font-semibold tabular-nums leading-tight">{c.value(counts)}</span>
              <span className="block truncate text-[11px] text-muted-foreground">{c.hint}</span>
            </span>
          </button>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------- review table

/** Where a record stands, from the server's status and (for GSTIN-missing records) the user's answer. */
function rowState(r: ReviewRow, answer: GstinAnswer | undefined): Exclude<StatusFilter, 'all'> {
  if (r.status === 'ready' || r.status === 'imported') return 'ready'
  if (r.status === 'confirm') return answer === 'skip' ? 'skip' : 'gstin'
  if (r.status === 'declined') return 'skip'
  if (r.status === 'duplicate') return 'existing'
  return 'invalid'
}

function Badge({ tone, icon: Icon, children }: { tone: 'success' | 'warning' | 'info' | 'danger' | 'muted'; icon?: React.ElementType; children: React.ReactNode }) {
  const cls = {
    success: 'border-success-border bg-success-soft text-success',
    warning: 'border-warning-border bg-warning-soft text-warning',
    info: 'border-info-border bg-info-soft text-info',
    danger: 'border-danger-border bg-danger-soft text-destructive',
    muted: 'border-border bg-muted text-muted-foreground',
  }[tone]
  return (
    <span className={cn('inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium', cls)}>
      {Icon && <Icon className="h-3 w-3" aria-hidden />}{children}
    </span>
  )
}

function ImportStatus({ r, answer }: { r: ReviewRow; answer?: GstinAnswer }) {
  if (r.status === 'ready' || r.status === 'imported') return <Badge tone="success" icon={CheckCircle2}>Ready to Import</Badge>
  if (r.status === 'confirm') {
    if (answer === 'import') return <Badge tone="success" icon={Check}>Import without GSTIN</Badge>
    if (answer === 'skip') return <Badge tone="muted" icon={Ban}>Skipped</Badge>
    return <Badge tone="warning" icon={AlertTriangle}>Confirmation required</Badge>
  }
  if (r.status === 'declined') return <Badge tone="muted" icon={Ban}>Skipped</Badge>
  if (r.status === 'duplicate') return <Badge tone="info" icon={Copy}>Already Exists</Badge>
  return <Badge tone="danger" icon={XCircle}>Invalid</Badge>
}

function GstinStatus({ r }: { r: ReviewRow }) {
  if (r.kind === 'items') return <span className="text-xs text-muted-foreground">Not applicable</span>
  if (r.status === 'confirm' || r.status === 'declined') return <Badge tone="warning" icon={AlertTriangle}>GSTIN Missing</Badge>
  if (r.gstin) return <span className="inline-flex items-center gap-1 text-xs text-success"><CheckCircle2 className="h-3.5 w-3.5" aria-hidden />Available</span>
  return <span className="text-xs text-muted-foreground" title={r.gstType ? `GST type: ${r.gstType}` : undefined}>Not registered</span>
}

const PAGE_ROWS = 100

export function ReviewTable({
  rows, totals, listedComplete, answers, selected, onSelect, onReview, onReviewMany, onSkipMany, filter, onFilter, locked,
}: {
  rows: ReviewRow[]
  /** Records per data type in the whole export (the server's counts), for the type filters */
  totals: { kind: ReviewKind; count: number }[]
  /** False when the server listed fewer rows than there are records (attention rows are capped per part) */
  listedComplete: boolean
  answers: Record<string, GstinAnswer>
  selected: Set<string>
  onSelect: (keys: string[], on: boolean) => void
  onReview: (row: ReviewRow) => void
  onReviewMany: (rows: ReviewRow[]) => void
  onSkipMany: (rows: ReviewRow[]) => void
  filter: StatusFilter
  onFilter: (f: StatusFilter) => void
  /** No answers can be changed (e.g. while the final confirmation is open) */
  locked?: boolean
}) {
  const [kind, setKind] = React.useState<'all' | ReviewKind>('all')
  const [query, setQuery] = React.useState('')
  const [shown, setShown] = React.useState(PAGE_ROWS)
  const q = query.trim().toLowerCase()
  const visible = rows.filter((r) => (kind === 'all' || r.kind === kind)
    && (filter === 'all' || rowState(r, answers[r.key]) === filter)
    && (!q || r.name.toLowerCase().includes(q) || (r.code ?? '').toLowerCase().includes(q) || (r.gstin ?? '').toLowerCase().includes(q)))
  const selectable = visible.filter((r) => r.status === 'confirm')
  const allSelected = selectable.length > 0 && selectable.every((r) => selected.has(r.key))
  const someSelected = selectable.some((r) => selected.has(r.key))
  const chosen = rows.filter((r) => selected.has(r.key) && r.status === 'confirm')
  const reset = () => { setKind('all'); setQuery(''); onFilter('all'); setShown(PAGE_ROWS) }
  const totalAll = totals.reduce((s, t) => s + t.count, 0)

  return (
    <div className="space-y-3" data-testid="tally-review">
      {/* filters */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Data type">
          {[{ kind: 'all' as const, label: 'All', count: totalAll }, ...totals.map((t) => ({ kind: t.kind, label: KIND_LABEL[t.kind].many, count: t.count }))].map((t) => (
            <button key={t.kind} type="button" onClick={() => { setKind(t.kind); setShown(PAGE_ROWS) }} aria-pressed={kind === t.kind}
              className={cn('inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                kind === t.kind ? 'border-primary bg-success-soft font-medium text-foreground' : 'bg-card text-muted-foreground hover:text-foreground')}>
              {t.label} <span className="rounded-full bg-background/80 px-1.5 text-xs tabular-nums">{t.count}</span>
            </button>
          ))}
        </div>
        <div className="flex flex-1 flex-col gap-2 sm:flex-row lg:justify-end">
          <div className="relative sm:w-72">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input value={query} onChange={(e) => { setQuery(e.target.value); setShown(PAGE_ROWS) }} placeholder="Search name, code or GSTIN" aria-label="Search records" className="h-9 rounded-lg pl-9" />
          </div>
          <select value={filter} onChange={(e) => { onFilter(e.target.value as StatusFilter); setShown(PAGE_ROWS) }} aria-label="Status"
            className="h-9 rounded-lg border bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <option value="all">All statuses</option>
            <option value="ready">Ready to Import</option>
            <option value="gstin">GSTIN Missing</option>
            <option value="existing">Already Exists</option>
            <option value="invalid">Invalid</option>
            <option value="skip">Skipped</option>
          </select>
        </div>
      </div>

      {/* bulk actions: only for GSTIN-missing records, and only as explicit answers per record */}
      {chosen.length > 0 && !locked && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-primary/30 bg-success-soft px-3 py-2 text-sm" data-testid="tally-bulk">
          <span className="font-medium">{chosen.length} selected</span>
          <span className="text-muted-foreground">· GSTIN-missing records</span>
          <span className="flex-1" />
          <Button size="sm" onClick={() => onReviewMany(chosen)} className="rounded-lg">Review selected one by one</Button>
          <Button size="sm" variant="outline" onClick={() => onSkipMany(chosen)} className="rounded-lg bg-background">Skip selected</Button>
          <Button size="sm" variant="ghost" onClick={() => onSelect(chosen.map((r) => r.key), false)}><X className="mr-1 h-3.5 w-3.5" aria-hidden />Clear</Button>
        </div>
      )}

      <div className="overflow-x-auto rounded-xl border md:overflow-visible">
        <table className="w-full text-sm">
          <thead className="bg-muted text-left text-xs text-muted-foreground md:sticky md:top-14 md:z-10 md:shadow-[0_1px_0_var(--border)]">
            <tr>
              <th scope="col" className="w-10 px-3 py-3">
                <Checkbox checked={allSelected ? true : someSelected ? 'indeterminate' : false} disabled={!selectable.length || locked}
                  onCheckedChange={(v) => onSelect(selectable.map((r) => r.key), v === true)} aria-label="Select all GSTIN-missing records shown" />
              </th>
              <th scope="col" className="hidden px-3 py-3 font-medium xl:table-cell">Code</th>
              <th scope="col" className="px-3 py-3 font-medium">Party / item name</th>
              <th scope="col" className="hidden px-3 py-3 font-medium lg:table-cell">Type</th>
              <th scope="col" className="hidden px-3 py-3 font-medium 2xl:table-cell">GSTIN</th>
              <th scope="col" className="hidden px-3 py-3 font-medium sm:table-cell">GSTIN status</th>
              <th scope="col" className="hidden px-3 py-3 font-medium sm:table-cell">Import status</th>
              <th scope="col" className="hidden px-3 py-3 text-right font-medium sm:table-cell">Action</th>
            </tr>
          </thead>
          <tbody>
            {visible.slice(0, shown).map((r) => {
              const answer = answers[r.key]
              const confirm = r.status === 'confirm'
              return (
                <tr key={r.key} className={cn('border-t align-top', confirm && !answer && 'bg-warning-soft/40')} data-testid="tally-review-row">
                  <td className="px-3 py-3">
                    {confirm && <Checkbox checked={selected.has(r.key)} disabled={locked} onCheckedChange={(v) => onSelect([r.key], v === true)} aria-label={`Select ${r.name}`} />}
                  </td>
                  <td className="hidden px-3 py-3 font-mono text-xs text-muted-foreground xl:table-cell">{r.code || '—'}</td>
                  <td className="min-w-[11rem] px-3 py-3">
                    <span className="block break-words font-medium">{r.name || '—'}</span>
                    <span className="block text-xs text-muted-foreground lg:hidden">{kindLabel(r.kind)}{r.code ? ` · ${r.code}` : ''}{r.gstin ? ` · ${r.gstin}` : ''}</span>
                    <span className="hidden text-xs text-muted-foreground lg:block 2xl:hidden">{r.gstin || ''}</span>
                    {(r.status === 'error' || r.status === 'failed' || r.status === 'duplicate') && r.messages.length > 0 && (
                      <span className={cn('mt-0.5 block text-xs', r.status === 'duplicate' ? 'text-muted-foreground' : 'text-destructive')}>{r.messages.join('; ')}</span>
                    )}
                    {/* phones: the statuses and the action under the name instead of in their own columns */}
                    <span className="mt-2 flex flex-wrap items-center gap-1.5 sm:hidden">
                      <GstinStatus r={r} /><ImportStatus r={r} answer={answer} />
                      {confirm && (
                        <Button size="sm" variant={answer ? 'ghost' : 'outline'} disabled={locked} onClick={() => onReview(r)} aria-label={`${answer ? 'Change' : 'Review'} ${r.name}`} className="h-7 rounded-lg px-2.5 text-xs">
                          {answer ? 'Change' : 'Review'}
                        </Button>
                      )}
                    </span>
                  </td>
                  <td className="hidden whitespace-nowrap px-3 py-3 text-muted-foreground lg:table-cell">{kindLabel(r.kind)}</td>
                  <td className="hidden px-3 py-3 font-mono text-xs 2xl:table-cell">{r.gstin || '—'}</td>
                  <td className="hidden px-3 py-3 sm:table-cell"><GstinStatus r={r} /></td>
                  <td className="hidden px-3 py-3 sm:table-cell"><ImportStatus r={r} answer={answer} /></td>
                  <td className="hidden px-3 py-3 text-right sm:table-cell">
                    {confirm ? (
                      <Button size="sm" variant={answer ? 'ghost' : 'outline'} disabled={locked} onClick={() => onReview(r)} aria-label={`${answer ? 'Change' : 'Review'} ${r.name}`} className="rounded-lg">
                        {answer ? 'Change' : 'Review'}
                      </Button>
                    ) : <span className="text-xs text-muted-foreground">—</span>}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {visible.length === 0 && (
          <div className="flex flex-col items-center gap-2 px-4 py-10 text-center text-sm text-muted-foreground" data-testid="tally-review-empty">
            <CircleDashed className="h-6 w-6" aria-hidden />
            {rows.length === 0 ? 'No records to show.' : 'No records match these filters.'}
            {rows.length > 0 && <Button size="sm" variant="outline" onClick={reset} className="rounded-lg">Clear filters</Button>}
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>Showing {Math.min(shown, visible.length)} of {visible.length} listed record{visible.length === 1 ? '' : 's'}</span>
        {!listedComplete && <span>· Up to 200 records that need attention are listed per part of 500 — the counts above cover all records.</span>}
        {visible.length > shown && <Button size="sm" variant="outline" onClick={() => setShown((n) => n + PAGE_ROWS)} className="ml-auto rounded-lg">Show more ({visible.length - shown})</Button>}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- side panel

export function ImportSidePanel({ counts, tallyCompany, companyName, data }: { counts: ReviewCounts; tallyCompany: string; companyName: string; data: string }) {
  const rows: [string, number, string][] = [
    ['Total records', counts.total, ''],
    ['Ready to import', counts.ready, 'text-success'],
    ['GSTIN confirmation pending', counts.pending, counts.pending ? 'text-warning' : ''],
    ['Existing / duplicate', counts.existing, 'text-info'],
    ['Invalid', counts.invalid, counts.invalid ? 'text-destructive' : ''],
    ['Skipped by you', counts.willSkip, ''],
  ]
  return (
    <aside className="space-y-4" aria-label="Import summary">
      <div className="rounded-xl border bg-card p-4 shadow-xs">
        <p className="text-sm font-semibold">Import summary</p>
        <p className="mt-1 text-xs text-muted-foreground">{data} from <span className="font-medium text-foreground">{tallyCompany}</span> into <span className="font-medium text-foreground">{companyName || 'this company'}</span></p>
        <dl className="mt-3 divide-y text-sm" data-testid="tally-side-summary">
          {rows.map(([label, value, tone]) => (
            <div key={label} className="flex items-center justify-between py-2">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className={cn('font-semibold tabular-nums', tone)}>{value}</dd>
            </div>
          ))}
        </dl>
      </div>
      <details className="group rounded-xl border bg-card p-4 shadow-xs" open>
        <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <Info className="h-4 w-4 text-info" aria-hidden /> How it works
          <ChevronDown className="ml-auto h-4 w-4 text-muted-foreground transition-transform group-open:rotate-180" aria-hidden />
        </summary>
        <ol className="mt-3 space-y-2.5 text-xs text-muted-foreground">
          <li><span className="font-medium text-foreground">1. Preview.</span> The records were read from Tally and checked; nothing is saved yet.</li>
          <li><span className="font-medium text-foreground">2. Review.</span> New records are imported; records already in ManuFlow are skipped and never changed; invalid ones are not imported.</li>
          <li><span className="font-medium text-foreground">3. Confirm.</span> A party without a GSTIN is imported only after your yes for that record.</li>
          <li><span className="font-medium text-foreground">4. Import.</span> Each part is recorded in Import History. Nothing is written to Tally.</li>
        </ol>
      </details>
    </aside>
  )
}

// ---------------------------------------------------------------- result

export interface ResultTotals { imported: number; declined: number; skipped: number; failed: number; unanswered: number }

export function ImportResult({ totals, failures, declined, onHistory, children }: {
  totals: ResultTotals
  failures: { key: string; name: string; kind: ReviewKind; messages: string[] }[]
  declined: { key: string; name: string; kind: ReviewKind }[]
  onHistory?: () => void
  children?: React.ReactNode
}) {
  const cards: { label: string; value: number; tone: string; icon: React.ElementType; show: boolean }[] = [
    { label: 'Successfully Imported', value: totals.imported, tone: 'text-success bg-success-soft', icon: CheckCircle2, show: true },
    { label: 'Skipped', value: totals.declined, tone: 'text-muted-foreground bg-muted', icon: Ban, show: true },
    { label: 'Already Exists', value: totals.skipped, tone: 'text-info bg-info-soft', icon: Copy, show: true },
    { label: 'Failed', value: totals.failed, tone: 'text-destructive bg-danger-soft', icon: XCircle, show: true },
    { label: 'Awaiting Confirmation', value: totals.unanswered, tone: 'text-warning bg-warning-soft', icon: AlertTriangle, show: totals.unanswered > 0 },
  ]
  return (
    <div className="space-y-5" data-testid="tally-result">
      {children}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-5">
        {cards.filter((c) => c.show).map((c) => (
          <div key={c.label} className="flex items-start gap-3 rounded-xl border bg-card p-3.5 shadow-xs" data-testid="tally-result-card">
            <span className={cn('grid h-9 w-9 shrink-0 place-items-center rounded-lg', c.tone)} aria-hidden><c.icon className="h-4.5 w-4.5" /></span>
            <span><span className="block text-xs text-muted-foreground">{c.label}</span><span className="block text-xl font-semibold tabular-nums">{c.value}</span></span>
          </div>
        ))}
      </div>
      {failures.length > 0 && (
        <div className="space-y-2" data-testid="tally-result-failures">
          <p className="text-sm font-medium">Not imported — needs attention ({failures.length}{failures.length >= 200 ? '+' : ''})</p>
          <ul className="divide-y rounded-xl border text-sm">
            {failures.slice(0, 100).map((f) => (
              <li key={f.key} className="px-4 py-2.5">
                <span className="font-medium">{f.name || '—'}</span>
                <span className="text-muted-foreground"> · {kindLabel(f.kind)}: {f.messages.join('; ')}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {declined.length > 0 && (
        <div className="space-y-2" data-testid="tally-gstin-declined">
          <p className="text-sm font-medium">Skipped by you — no GSTIN ({declined.length})</p>
          <ul className="divide-y rounded-xl border text-sm">
            {declined.map((d) => (
              <li key={d.key} className="px-4 py-2.5"><span className="font-medium">{d.name || '—'}</span><span className="text-muted-foreground"> · {kindLabel(d.kind)}</span></li>
            ))}
          </ul>
        </div>
      )}
      {onHistory && (
        <Button variant="outline" onClick={onHistory} className="rounded-lg"><History className="mr-2 h-4 w-4" aria-hidden /> View Import History</Button>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- GSTIN dialog

/**
 * One GSTIN-missing record at a time. mode 'import': part of starting the import (Cancel import drops every answer,
 * as before); mode 'review': answering from the table (Close keeps the answers given so far).
 */
export function GstinDialog({ item, index, total, mode, onYes, onNo, onCancel }: {
  item: { name: string; kind: ReviewKind; gstType?: string } | null
  index: number
  total: number
  mode: 'import' | 'review'
  onYes: () => void
  onNo: () => void
  onCancel: () => void
}) {
  const party = item ? (item.kind === 'suppliers' ? 'Supplier' : 'Customer') : ''
  return (
    <AlertDialog open={!!item} onOpenChange={(o) => { if (!o) onCancel() }}>
      <AlertDialogContent data-testid="tally-gstin-dialog" className="sm:max-w-lg">
        {item && (
          <>
            <AlertDialogHeader>
              <div className="flex items-center gap-3">
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-warning-soft text-warning" aria-hidden><AlertTriangle className="h-5 w-5" /></span>
                <AlertDialogTitle>GSTIN Missing</AlertDialogTitle>
                {total > 1 && <span className="ml-auto rounded-full bg-muted px-2.5 py-0.5 text-xs text-muted-foreground">Record {index + 1} of {total}</span>}
              </div>
              <div className="mt-3 rounded-lg border bg-muted/40 px-3 py-2.5">
                <p className="text-base font-semibold text-foreground">{item.name || 'This party'}</p>
                <p className="mt-0.5 flex flex-wrap gap-x-2 text-xs text-muted-foreground">
                  <span>{party}</span>{item.gstType && <span>· GST type in Tally: {item.gstType}</span>}
                </p>
              </div>
              <AlertDialogDescription className="mt-3">
                The GSTIN for <span className="font-medium text-foreground">{item.name || 'this party'}</span> is not available in Tally. Are you sure you want to import this {party} without GSTIN?
              </AlertDialogDescription>
              <p className="text-xs text-muted-foreground">
                Yes saves the {party.toLowerCase()} with the GSTIN left empty and the GST type kept as in Tally — add the GSTIN later in Parties. No leaves this record out of the import.
              </p>
            </AlertDialogHeader>
            <AlertDialogFooter className="gap-2 sm:justify-between">
              <Button variant="ghost" onClick={onCancel}>{mode === 'import' ? 'Cancel Import' : 'Close'}</Button>
              <div className="flex flex-col-reverse gap-2 sm:flex-row">
                <AlertDialogCancel onClick={(e) => { e.preventDefault(); onNo() }}>No, Skip this record</AlertDialogCancel>
                <AlertDialogAction onClick={(e) => { e.preventDefault(); onYes() }}>Yes, Import without GSTIN</AlertDialogAction>
              </div>
            </AlertDialogFooter>
          </>
        )}
      </AlertDialogContent>
    </AlertDialog>
  )
}
