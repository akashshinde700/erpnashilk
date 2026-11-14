'use client'

import * as React from 'react'
import { toast } from 'sonner'
import { AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight, Info, Link2, Loader2, Plus, RefreshCw, Search, Unlink, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { friendlyError } from '@/lib/import/wizard-helpers'
import { MASTER_TYPES } from '@/lib/tally/data-types'
import type { JobView } from '@/lib/tally/jobs'
import { LEDGER_CATEGORY_LABEL, type KindSummary, type ReviewFilter, type ReviewRow } from '@/lib/tally/master-classify'
import { apiGet, apiPost } from '@/lib/use-api'
import { cn } from '@/lib/utils'

/**
 * Masters review (Phase 1): reads the chosen masters from Tally into ManuFlow's review copy, then shows them per kind
 * with what the server worked out — the suggested meaning of each ledger, items already using a unit / stock group,
 * problems, and records no longer in Tally. Nothing is imported: the only changes a user can make here are linking a
 * godown to a warehouse (or creating one for it) and a bank / cash ledger to a Cash & Bank account, one explicit action
 * at a time. Every number shown comes from the server.
 */

type ReadState = { status: 'waiting' | 'reading' | 'done' | 'failed'; count?: number; message?: string }
interface Page { summary: KindSummary; matching: number; page: number; pageSize: number; rows: ReviewRow[] }
interface Option { id: string; label: string; type?: string }

const FILTERS: { key: ReviewFilter; label: string }[] = [
  { key: 'all', label: 'All' }, { key: 'review', label: 'Needs review' }, { key: 'issues', label: 'With problems' },
  { key: 'missing', label: 'No longer in Tally' },
]
const LINK_FILTERS: { key: ReviewFilter; label: string }[] = [{ key: 'linked', label: 'Linked' }, { key: 'unlinked', label: 'Not linked' }]

export default function TallyMasters({ companyId, tallyCompany, keys, readJob }: {
  companyId: string
  tallyCompany: string
  /** Data-type keys from MASTER_TYPES the user chose */
  keys: string[]
  /** Reads one job from Tally and waits for it (the parent's job runner: stop / cancel work for it too) */
  readJob: (type: string) => Promise<JobView>
}) {
  const types = MASTER_TYPES.filter((t) => keys.includes(t.key))
  const q = `companyId=${companyId}&tallyCompany=${encodeURIComponent(tallyCompany)}`
  const [reads, setReads] = React.useState<Record<string, ReadState>>(() => Object.fromEntries(types.map((t) => [t.key, { status: 'waiting' }])))
  const [reading, setReading] = React.useState(false)
  const [summary, setSummary] = React.useState<KindSummary[] | null>(null)
  const [active, setActive] = React.useState(types[0]?.reviewKind ?? 'ledger')
  const [filter, setFilter] = React.useState<ReviewFilter>('all')
  const [search, setSearch] = React.useState('')
  const [pageNo, setPageNo] = React.useState(0)
  const [page, setPage] = React.useState<Page | null>(null)
  const [loadingPage, setLoadingPage] = React.useState(false)
  const [error, setError] = React.useState('')
  const [warehouses, setWarehouses] = React.useState<Option[] | null>(null)
  const [accounts, setAccounts] = React.useState<Option[] | null>(null)
  const [busyGuid, setBusyGuid] = React.useState('')
  const started = React.useRef(false)

  const loadSummary = React.useCallback(async () => {
    const r = await apiGet<{ summary: KindSummary[] }>(`/api/import-center/tally/master-review?${q}`)
    setSummary(r.summary)
  }, [q])

  const loadPage = React.useCallback(async () => {
    setLoadingPage(true)
    try {
      const r = await apiGet<Page>(`/api/import-center/tally/master-review?${q}&kind=${active}&filter=${filter}&page=${pageNo}&q=${encodeURIComponent(search.trim())}`)
      setPage(r)
      setError('')
    } catch (e) {
      setError(friendlyError(e))
    } finally {
      setLoadingPage(false)
    }
  }, [q, active, filter, pageNo, search])

  async function readAll() {
    setReading(true)
    setError('')
    for (const t of types) {
      setReads((r) => ({ ...r, [t.key]: { status: 'reading' } }))
      try {
        const job = await readJob(t.job!)
        setReads((r) => ({ ...r, [t.key]: job.status === 'done' ? { status: 'done', count: job.count ?? 0 } : { status: 'failed', message: job.message ?? 'Could not read this from Tally.' } }))
      } catch (e) {
        setReads((r) => ({ ...r, [t.key]: { status: 'failed', message: friendlyError(e) } }))
        if ((e as Error)?.name === 'Stopped' || e?.constructor?.name === 'Stopped') break
      }
    }
    setReading(false)
    try { await loadSummary() } catch (e) { setError(friendlyError(e)) }
  }

  React.useEffect(() => {
    if (started.current) return
    started.current = true
    void readAll()
  }, [])

  React.useEffect(() => {
    if (!summary) return
    void loadPage()
  }, [summary, loadPage])

  // Pickers, loaded when the tab that needs them opens
  React.useEffect(() => {
    if (active === 'godown' && !warehouses) {
      apiGet<{ items: { id: string; code: string; name: string }[] }>(`/api/warehouses?companyId=${companyId}`)
        .then((r) => setWarehouses(r.items.map((w) => ({ id: w.id, label: `${w.code} — ${w.name}` })))).catch(() => setWarehouses([]))
    }
    if (active === 'ledger' && !accounts) {
      apiGet<{ items: { id: string; name: string; type: string }[] }>(`/api/accounts?companyId=${companyId}&active=1`)
        .then((r) => setAccounts(r.items.map((a) => ({ id: a.id, label: a.name, type: a.type })))).catch(() => setAccounts([]))
    }
  }, [active, companyId])

  async function act(kind: 'godown' | 'ledger', guid: string, body: Record<string, unknown>) {
    setBusyGuid(guid)
    try {
      await apiPost(`/api/import-center/tally/master-review?companyId=${companyId}`, { companyId, tallyCompany, kind, guid, ...body })
      toast.success(body.unlink ? 'Link removed' : body.create ? 'Warehouse created and linked' : 'Linked')
      if (body.create) setWarehouses(null)
      await loadSummary()
    } catch (e) {
      toast.error(friendlyError(e))
    } finally {
      setBusyGuid('')
    }
  }

  const kindLabel = (kind: string) => MASTER_TYPES.find((t) => t.reviewKind === kind)?.label ?? kind
  const s = page?.summary
  const pages = page ? Math.max(1, Math.ceil(page.matching / page.pageSize)) : 1
  const filters = active === 'godown' || active === 'ledger' ? [...FILTERS, ...LINK_FILTERS] : FILTERS

  return (
    <section className="space-y-5" aria-labelledby="t-masters" data-testid="tally-masters">
      <div>
        <h4 id="t-masters" className="text-base font-semibold tracking-tight">Masters — review copy</h4>
        <p className="mt-1 text-sm text-muted-foreground">
          Read from Tally into a review copy kept in ManuFlow. Nothing is imported as business data and nothing is written to Tally.
          Only the links you make below (godown → warehouse, bank / cash ledger → account) change anything in ManuFlow.
        </p>
      </div>

      <div role="note" className="flex items-start gap-3 rounded-xl border border-warning-border bg-warning-soft px-4 py-3 text-sm" data-testid="tally-masters-unverified">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
        <p>These Tally readers have not yet been checked against a real TallyPrime company. Compare the counts with Tally’s own screens before relying on them.</p>
      </div>

      {/* reads */}
      <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3" aria-live="polite" data-testid="tally-masters-reads">
        {types.map((t) => {
          const r = reads[t.key]
          return (
            <li key={t.key} className="flex items-center gap-2.5 rounded-lg border bg-background px-3 py-2 text-sm" data-testid={`tally-master-read-${t.key}`}>
              {r.status === 'reading' ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" aria-hidden />
                : r.status === 'done' ? <CheckCircle2 className="h-4 w-4 shrink-0 text-success" aria-hidden />
                  : r.status === 'failed' ? <XCircle className="h-4 w-4 shrink-0 text-destructive" aria-hidden />
                    : <span className="h-4 w-4 shrink-0 rounded-full border" aria-hidden />}
              <span className="min-w-0 flex-1">
                <span className="font-medium">{t.label}</span>
                <span className="block text-xs text-muted-foreground">
                  {r.status === 'done' ? `${r.count} read from Tally` : r.status === 'failed' ? r.message : r.status === 'reading' ? 'Reading…' : 'Waiting'}
                </span>
              </span>
            </li>
          )
        })}
      </ul>
      {!reading && Object.values(reads).some((r) => r.status === 'failed') && (
        <Button variant="outline" size="sm" onClick={() => void readAll()} className="rounded-lg"><RefreshCw className="mr-2 h-4 w-4" aria-hidden /> Read again</Button>
      )}

      {reading && !summary && <Skeleton className="h-40 rounded-xl" />}

      {summary && (
        <>
          {/* kinds */}
          <div role="tablist" aria-label="Master kind" className="flex flex-wrap gap-2">
            {types.map((t) => {
              const k = summary.find((x) => x.kind === t.reviewKind)
              const on = active === t.reviewKind
              return (
                <button key={t.key} type="button" role="tab" aria-selected={on} onClick={() => { setActive(t.reviewKind!); setFilter('all'); setPageNo(0) }}
                  className={cn('inline-flex min-h-10 items-center gap-2 rounded-lg border px-3 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    on ? 'border-primary bg-success-soft font-medium' : 'bg-background hover:bg-muted/50')}>
                  {t.label} <span className="tabular-nums text-muted-foreground">{k?.total ?? 0}</span>
                  {!!k?.needsReview && <span className="rounded-full bg-warning-soft px-1.5 text-xs tabular-nums text-warning">{k.needsReview}</span>}
                </button>
              )
            })}
          </div>

          {s && (
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-5" data-testid="tally-masters-summary">
              <Tile label={`${kindLabel(active)} in the copy`} value={s.total} />
              <Tile label="Needs review" value={s.needsReview} tone={s.needsReview ? 'text-warning' : undefined} />
              <Tile label="With problems" value={s.withIssues} tone={s.withIssues ? 'text-destructive' : undefined} />
              <Tile label="No longer in Tally" value={s.missing} />
              <Tile label={active === 'godown' || active === 'ledger' ? 'Linked to ManuFlow' : 'Last read'} value={active === 'godown' || active === 'ledger' ? s.linked : s.lastReadAt ? new Date(s.lastReadAt).toLocaleString() : '—'} />
            </dl>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-0 flex-1 sm:max-w-xs">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <Input value={search} onChange={(e) => { setSearch(e.target.value); setPageNo(0) }} placeholder="Search name or group" aria-label="Search masters" className="pl-9" />
            </div>
            {filters.map((f) => (
              <Button key={f.key} size="sm" variant={filter === f.key ? 'default' : 'outline'} onClick={() => { setFilter(f.key); setPageNo(0) }} className="rounded-lg">{f.label}</Button>
            ))}
          </div>

          {error && <p className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">{error}</p>}

          <div className="overflow-x-auto rounded-xl border" aria-busy={loadingPage}>
            <table className="w-full min-w-[40rem] text-sm" data-testid="tally-masters-table">
              <thead className="bg-muted text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th scope="col" className="px-3 py-2.5 font-medium">Name</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">{active === 'unit' ? 'Details' : 'Parent'}</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">{active === 'ledger' ? 'Suggested meaning' : active === 'godown' ? 'Warehouse' : active === 'unit' || active === 'stockgroup' ? 'ManuFlow items using it' : 'Details'}</th>
                  {(active === 'ledger') && <th scope="col" className="px-3 py-2.5 font-medium">Linked to</th>}
                  <th scope="col" className="px-3 py-2.5 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {page?.rows.length === 0 && (
                  <tr><td colSpan={5} className="px-3 py-8 text-center text-muted-foreground">{s?.total ? 'Nothing matches.' : `No ${kindLabel(active).toLowerCase()} read from Tally yet.`}</td></tr>
                )}
                {page?.rows.map((r) => (
                  <tr key={r.guid} className="border-t align-top">
                    <td className="px-3 py-2.5 font-medium">{r.name}</td>
                    <td className="px-3 py-2.5 text-muted-foreground">{active === 'unit' ? unitText(r) : r.parent || '—'}</td>
                    <td className="px-3 py-2.5">
                      {active === 'ledger' && r.classification && (
                        <span>
                          {LEDGER_CATEGORY_LABEL[r.classification.category]}
                          <span className="block text-xs text-muted-foreground">{r.classification.reason}</span>
                        </span>
                      )}
                      {(active === 'unit' || active === 'stockgroup') && <span className="tabular-nums">{r.itemsUsing ?? 0}</span>}
                      {active === 'costcentre' && <span className="text-muted-foreground">{String(r.data.category ?? '') || '—'}</span>}
                      {active === 'group' && <span className="text-muted-foreground">{r.data.reservedName ? `Tally group “${String(r.data.reservedName)}”` : '—'}</span>}
                      {active === 'godown' && (
                        <GodownLink row={r} options={warehouses} busy={busyGuid === r.guid} disabled={!!r.missingSince}
                          onLink={(warehouseId) => void act('godown', r.guid, { warehouseId })}
                          onCreate={() => void act('godown', r.guid, { create: { type: 'GENERAL' } })}
                          onUnlink={() => void act('godown', r.guid, { unlink: true })} />
                      )}
                    </td>
                    {active === 'ledger' && (
                      <td className="px-3 py-2.5">
                        <LedgerLink row={r} options={accounts} busy={busyGuid === r.guid}
                          onLink={(moneyAccountId) => void act('ledger', r.guid, { moneyAccountId })}
                          onUnlink={() => void act('ledger', r.guid, { unlink: true })} />
                      </td>
                    )}
                    <td className="px-3 py-2.5 text-xs">
                      {r.missingSince ? <span className="text-muted-foreground">No longer in Tally</span>
                        : r.issues.length ? <span className="text-destructive">{r.issues.map((i) => i.message).join(' ')}</span>
                          : r.needsReview ? <span className="text-warning">{active === 'unit' ? 'Compound unit — check' : active === 'godown' ? 'Not linked' : 'Needs review'}</span>
                            : <span className="text-success">OK</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {page && pages > 1 && (
            <div className="flex items-center justify-end gap-2 text-sm">
              <span className="text-muted-foreground">Page {page.page + 1} of {pages} · {page.matching} records</span>
              <Button size="icon" variant="outline" aria-label="Previous page" disabled={page.page === 0} onClick={() => setPageNo(page.page - 1)}><ChevronLeft className="h-4 w-4" /></Button>
              <Button size="icon" variant="outline" aria-label="Next page" disabled={page.page + 1 >= pages} onClick={() => setPageNo(page.page + 1)}><ChevronRight className="h-4 w-4" /></Button>
            </div>
          )}
          <p className="flex items-start gap-2 text-xs text-muted-foreground"><Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            Ledger meanings are suggestions from Tally’s own groups and are not saved as mappings. Customer and supplier links come from importing them; bank and cash ledgers can be linked here.
          </p>
        </>
      )}
    </section>
  )
}

function unitText(r: ReviewRow) {
  const d = r.data as Record<string, string | undefined>
  if (d.baseUnits || d.additionalUnits) return `${d.baseUnits ?? '?'} → ${d.additionalUnits ?? '?'}${d.conversion ? ` (× ${d.conversion})` : ''}`
  return [d.formalName, d.decimals !== undefined ? `${d.decimals} decimals` : '', d.gstUqc ? `UQC ${d.gstUqc}` : ''].filter(Boolean).join(' · ') || '—'
}

function Tile({ label, value, tone }: { label: string; value: React.ReactNode; tone?: string }) {
  return (
    <div className="rounded-xl border bg-background px-3 py-2.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={cn('mt-0.5 text-lg font-semibold tabular-nums', tone)}>{value}</dd>
    </div>
  )
}

function GodownLink({ row, options, busy, disabled, onLink, onCreate, onUnlink }: {
  row: ReviewRow; options: Option[] | null; busy: boolean; disabled: boolean
  onLink: (id: string) => void; onCreate: () => void; onUnlink: () => void
}) {
  const [choice, setChoice] = React.useState(row.suggestion?.id ?? '')
  if (row.link) {
    return (
      <span className="flex flex-wrap items-center gap-2">
        <Link2 className="h-3.5 w-3.5 text-success" aria-hidden /> {row.link.label}
        <Button size="sm" variant="ghost" disabled={busy} onClick={onUnlink} className="h-7 px-2 text-xs"><Unlink className="mr-1 h-3.5 w-3.5" aria-hidden /> Unlink</Button>
      </span>
    )
  }
  if (disabled) return <span className="text-muted-foreground">—</span>
  return (
    <span className="flex flex-wrap items-center gap-2">
      <select value={choice} onChange={(e) => setChoice(e.target.value)} aria-label={`Warehouse for ${row.name}`} disabled={busy || !options}
        className="h-8 max-w-[14rem] rounded-md border bg-background px-2 text-sm">
        <option value="">Choose warehouse…</option>
        {(options ?? []).map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
      </select>
      <Button size="sm" variant="outline" disabled={busy || !choice} onClick={() => onLink(choice)} className="h-8">{busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Link'}</Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={onCreate} className="h-8 text-xs"><Plus className="mr-1 h-3.5 w-3.5" aria-hidden /> Create warehouse</Button>
      {row.suggestion && <span className="w-full text-xs text-muted-foreground">Same name in ManuFlow: {row.suggestion.label} (not linked yet)</span>}
    </span>
  )
}

function LedgerLink({ row, options, busy, onLink, onUnlink }: {
  row: ReviewRow; options: Option[] | null; busy: boolean; onLink: (id: string) => void; onUnlink: () => void
}) {
  const c = row.classification
  const linkable = !!c && c.confidence === 'exact' && (c.category === 'bank' || c.category === 'cash') && !row.missingSince
  const [choice, setChoice] = React.useState('')
  if (row.link) {
    return (
      <span className="flex flex-wrap items-center gap-2">
        <Link2 className="h-3.5 w-3.5 text-success" aria-hidden /> {row.link.label}
        {row.link.kind === 'moneyaccount' && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={onUnlink} className="h-7 px-2 text-xs"><Unlink className="mr-1 h-3.5 w-3.5" aria-hidden /> Unlink</Button>
        )}
      </span>
    )
  }
  if (!linkable) return <span className="text-muted-foreground">—</span>
  const want = c!.category === 'cash' ? 'CASH' : 'BANK'
  const list = (options ?? []).filter((o) => o.type === want)
  return (
    <span className="flex flex-wrap items-center gap-2">
      <select value={choice} onChange={(e) => setChoice(e.target.value)} aria-label={`Account for ${row.name}`} disabled={busy || !options}
        className="h-8 max-w-[14rem] rounded-md border bg-background px-2 text-sm">
        <option value="">{list.length ? `Choose ${want === 'CASH' ? 'cash' : 'bank'} account…` : `No ${want === 'CASH' ? 'cash' : 'bank'} account in ManuFlow`}</option>
        {list.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
      </select>
      <Button size="sm" variant="outline" disabled={busy || !choice} onClick={() => onLink(choice)} className="h-8">{busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Link'}</Button>
    </span>
  )
}
