'use client'

import * as React from 'react'
import {
  AlertTriangle, ArrowLeft, ArrowRight, Ban, Building2, CheckCircle2, Download, FileUp, Info, Loader2, Package, Store, Wallet, XCircle,
} from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Field, SelectInput } from '@/components/erp/kit'
import GoLivePanel, { type GoLive } from '@/components/erp/import-center/go-live-panel'
import { ITEM_TYPES, ITEM_TYPE_LABEL, UOMS, fmtDate } from '@/lib/erp-constants'
import type { RunResult, RunRow } from '@/lib/import/run'
import { STATUS_LABEL, downloadText, friendlyError, problemRowsCsv } from '@/lib/import/wizard-helpers'
import type { VyaparSnapshotView } from '@/lib/vyapar/shared'
import { apiPost, apiUpload, useList } from '@/lib/use-api'
import { cn } from '@/lib/utils'

/**
 * Import Centre → Vyapar → "Upload a Vyapar backup".
 *
 * 1 Upload the .vyb (or the .vyp inside it) → 2 check what the backup holds → 3 choose what to
 * import and fill the gaps Vyapar leaves (GST rate, unit) → 4 review → 5 import.
 *
 * The backup is read on the server; the browser only gets a summary and then asks for the import
 * batch by batch (≤ 500 records), so nothing of the customer's data travels back and forth. Preview
 * is a read-only dry run of exactly the same import services the commit uses.
 */

type Kind = 'customers' | 'suppliers' | 'items' | 'opening-stock'

const KINDS: { kind: Kind; label: string; hint: string; source: string; module: string }[] = [
  { kind: 'customers', label: 'Customers', hint: 'Name, GSTIN, phone, address', source: 'Vyapar parties (customers)', module: 'Customers' },
  { kind: 'suppliers', label: 'Suppliers', hint: 'Name, GSTIN, phone, address', source: 'Vyapar parties (suppliers)', module: 'Suppliers' },
  { kind: 'items', label: 'Items', hint: 'Name, code, HSN, GST rate, unit, prices', source: 'Vyapar items', module: 'Items' },
  { kind: 'opening-stock', label: 'Opening stock', hint: 'Quantity and value on hand, posted at the go-live date', source: 'Vyapar current stock', module: 'Stock' },
]

const GST_CHOICES = ['0', '5', '12', '18', '28']
const PAGE_PROBLEMS = 25

type Counts = { total: number; ready: number; duplicates: number; imported: number; problems: number; warnings: number }
const EMPTY: Counts = { total: 0, ready: 0, duplicates: 0, imported: 0, problems: 0, warnings: 0 }

interface KindState extends Counts {
  kind: Kind
  checked: boolean
  importedDone: boolean
  problemsRows: RunRow[]
  note?: string
}

interface BatchReply { batch: number; batches: number; totalRecords: number; batchSize: number; batchRows: number; result: RunResult }

const money = (n: number) => n.toLocaleString('en-IN', { maximumFractionDigits: 2 })
const num = (n: number) => n.toLocaleString('en-IN', { maximumFractionDigits: 3 })

function Stat({ label, value, hint, icon: Icon, tone }: { label: string; value: string; hint?: string; icon?: typeof Package; tone?: string }) {
  return (
    <div className={cn('rounded-lg border p-3', tone)}>
      <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        {Icon && <Icon className="h-3.5 w-3.5" aria-hidden />} {label}
      </div>
      <div className="mt-1 text-xl font-bold tabular-nums">{value}</div>
      {hint && <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div>}
    </div>
  )
}

export default function VyaparBackup({ open, onOpenChange, companyId, onUseFile }: {
  open: boolean
  onOpenChange: (o: boolean) => void
  companyId: string
  /** "Import a report exported from Vyapar instead" — opens the normal file wizard. */
  onUseFile: () => void
}) {
  const [file, setFile] = React.useState<File | null>(null)
  const [reading, setReading] = React.useState(false)
  const [readError, setReadError] = React.useState('')
  const [snap, setSnap] = React.useState<VyaparSnapshotView | null>(null)

  const [kinds, setKinds] = React.useState<Set<Kind>>(new Set())
  const [itemType, setItemType] = React.useState('RAW')
  const [gstFallback, setGstFallback] = React.useState('')
  const [uomFallback, setUomFallback] = React.useState('')
  const [warehouseId, setWarehouseId] = React.useState('')
  const [goLive, setGoLive] = React.useState<GoLive | null>(null)

  const [phase, setPhase] = React.useState<'idle' | 'checking' | 'ready' | 'importing' | 'done'>('idle')
  const [states, setStates] = React.useState<Record<Kind, KindState>>({} as Record<Kind, KindState>)
  const [stage, setStage] = React.useState('')
  const [progress, setProgress] = React.useState({ done: 0, total: 0 })
  const [runError, setRunError] = React.useState('')
  const [showProblems, setShowProblems] = React.useState<Kind | null>(null)

  const warehouses = useList<{ items: { id: string; code: string; name: string }[] }>(`/api/warehouses?companyId=${companyId}`)
  const busy = reading || phase === 'checking' || phase === 'importing'
  const q = `companyId=${companyId}`

  function resetAll() {
    setFile(null); setReading(false); setReadError(''); setSnap(null)
    setKinds(new Set()); setPhase('idle'); setStates({} as Record<Kind, KindState>); setRunError(''); setStage(''); setShowProblems(null)
    setGoLive(null); setWarehouseId(''); setGstFallback(''); setUomFallback(''); setItemType('RAW')
  }

  React.useEffect(() => { if (snap && !warehouses.data) return; if (snap && warehouses.data && !warehouseId && warehouses.data.items.length === 1) setWarehouseId(warehouses.data.items[0].id) }, [snap, warehouses.data, warehouseId])

  async function readBackup() {
    if (!file || reading) return
    setReading(true); setReadError('')
    try {
      const form = new FormData()
      form.append('file', file)
      form.append('companyId', companyId)
      const view = await apiUpload<VyaparSnapshotView>(`/api/import-center/vyapar/inspect?${q}`, form)
      setSnap(view)
      // Everything that has rows is ticked by default — the user can untick
      const next = new Set<Kind>()
      if (view.lists.customers) next.add('customers')
      if (view.lists.suppliers) next.add('suppliers')
      if (view.lists.items) next.add('items')
      setKinds(next)
      setPhase('idle')
    } catch (e) {
      setReadError(friendlyError(e))
      setSnap(null)
    } finally {
      setReading(false)
    }
  }

  const selected = KINDS.filter((k) => kinds.has(k.kind))
  const recordCount = (kind: Kind) => (snap ? snap.lists[({ 'customers': 'customers', 'suppliers': 'suppliers', items: 'items', 'opening-stock': 'openingStock' } as const)[kind]] : 0)

  // What still has to be chosen before the import can run
  const choiceProblem = (() => {
    if (!snap || !selected.length) return 'Choose at least one thing to import.'
    if (kinds.has('items')) {
      if (snap.stats.itemsWithoutGst && !gstFallback) return `${snap.stats.itemsWithoutGst} items have no GST rate in Vyapar — choose the rate to use for them.`
      if (snap.unknownUnits.length && !uomFallback) return `${snap.unknownUnits.reduce((s, u) => s + u.count, 0)} items use a unit ManuFlow does not have — choose the unit to use for them.`
      if (!itemType) return 'Choose the item type for Vyapar products.'
    }
    if (kinds.has('opening-stock')) {
      if (!warehouseId) return 'Choose the warehouse the opening stock belongs to.'
      if (!goLive?.goLiveDate) return 'Set the go-live date first — opening stock is posted on the day before it.'
      if (goLive.locked) return 'Opening stock was already imported against this go-live date.'
    }
    return ''
  })()

  const options = React.useMemo(() => ({
    ...(kinds.has('items') ? { itemType, gstFallback, uomFallback } : {}),
    ...(kinds.has('opening-stock') ? { defaultWarehouseId: warehouseId, goLiveDate: goLive?.goLiveDate ?? '' } : {}),
  }), [kinds, itemType, gstFallback, uomFallback, warehouseId, goLive])

  async function callImport(kind: Kind, mode: 'preview' | 'commit', batch: number): Promise<BatchReply> {
    return apiPost<BatchReply>(`/api/import-center/vyapar/import?${q}`, {
      companyId, snapshotId: snap?.snapshotId, dataType: kind, mode, batch,
      options,
      ...(mode === 'commit' ? { confirm: true } : {}),
    })
  }

  /** Batches of one kind, previewed (read-only) or imported, with the counts collected per kind. */
  async function runKind(kind: Kind, mode: 'preview' | 'commit', note?: string): Promise<Counts> {
    let batch = 0
    let batches = Math.max(1, Math.ceil(recordCount(kind) / 500))
    const acc = { ...EMPTY }
    const problemsRows: RunRow[] = []
    for (;;) {
      setStage(`${mode === 'preview' ? 'Checking' : 'Importing'} ${KINDS.find((k) => k.kind === kind)!.label.toLowerCase()} — batch ${batch + 1} of ${batches}`)
      const reply = await callImport(kind, mode, batch)
      batches = reply.batches
      const c = reply.result.counts
      acc.total += c.total
      acc.ready += c.ready
      acc.duplicates += c.duplicates
      acc.imported += c.imported
      acc.problems += c.errors + c.failed
      acc.warnings += c.withWarnings
      problemsRows.push(...reply.result.rows)
      setProgress((p) => ({ ...p, done: p.done + 1 }))
      if (batch + 1 >= batches) break
      batch++
    }
    setStates((prev) => ({
      ...prev,
      [kind]: {
        kind, checked: mode === 'preview', importedDone: mode === 'commit',
        ...acc, problemsRows, note,
      },
    }))
    return acc
  }

  /** Opening stock can only be checked once the items exist — checked during the import when both are picked. */
  const openingStockAfterItems = kinds.has('opening-stock') && kinds.has('items')

  async function previewAll() {
    if (!snap || choiceProblem) return
    setPhase('checking'); setRunError(''); setStates({} as Record<Kind, KindState>); setProgress({ done: 0, total: selected.length })
    try {
      for (const k of selected) {
        if (k.kind === 'opening-stock' && openingStockAfterItems) {
          // The items are created first in the same run, so there is nothing yet to post the stock to
          setStates((prev) => ({
            ...prev,
            'opening-stock': {
              kind: 'opening-stock', checked: false, importedDone: false, ...EMPTY, problemsRows: [],
              note: 'Checked during the import, right after the items are created.',
            },
          }))
          setProgress((p) => ({ ...p, done: p.done + 1 }))
          continue
        }
        await runKind(k.kind, 'preview')
      }
      setPhase('ready')
    } catch (e) {
      setRunError(friendlyError(e))
      setPhase('idle')
    } finally {
      setStage('')
    }
  }

  async function importAll() {
    if (!snap || choiceProblem) return
    setPhase('importing'); setRunError(''); setProgress({ done: 0, total: selected.length })
    try {
      for (const k of selected) {
        if (k.kind === 'opening-stock' && openingStockAfterItems) {
          // Now the items exist: check the stock rows, and only post them when at least one is ready
          const check = await runKind('opening-stock', 'preview', 'Checked after the items were created.')
          if (check.ready === 0) {
            setStates((prev) => ({ ...prev, 'opening-stock': { ...prev['opening-stock'], importedDone: false, note: 'Nothing could be posted — see the problems.' } }))
            setProgress((p) => ({ ...p, done: p.done + 1 }))
            continue
          }
          await runKind('opening-stock', 'commit')
          continue
        }
        await runKind(k.kind, 'commit')
      }
      setPhase('done')
    } catch (e) {
      setRunError(friendlyError(e))
      setPhase('ready')
    } finally {
      setStage('')
    }
  }

  const totals = selected.reduce((acc, k) => {
    const s = states[k.kind]
    if (!s) return acc
    return {
      records: acc.records + s.total,
      ready: acc.ready + s.ready,
      imported: acc.imported + s.imported,
      duplicates: acc.duplicates + s.duplicates,
      problems: acc.problems + s.problems,
    }
  }, { records: 0, ready: 0, imported: 0, duplicates: 0, problems: 0 })

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) resetAll(); onOpenChange(o) }}>
      <DialogContent className="max-h-[92vh] max-w-4xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Store className="h-5 w-5 text-success" /> Import from a Vyapar backup</DialogTitle>
          <DialogDescription>
            Read the backup Vyapar creates (.vyb) and import the company&apos;s parties, items and stock into ManuFlow.
            The backup is read on the server; nothing is saved until you confirm.
          </DialogDescription>
        </DialogHeader>

        {/* ---------------- Step 1: upload ---------------- */}
        <section className="space-y-3">
          <h3 className="text-sm font-semibold">Step 1 · Choose the backup file</h3>
          <div className="flex flex-wrap items-center gap-3">
            <label className={cn('inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border px-4 text-sm font-medium', busy && 'pointer-events-none opacity-60')}>
              <FileUp className="h-4 w-4" aria-hidden />
              {file ? 'Choose another file' : 'Choose the .vyb / .vyp file'}
              <input
                type="file"
                accept=".vyb,.vyp,application/octet-stream"
                className="sr-only"
                disabled={busy}
                onChange={(e) => { setFile(e.target.files?.[0] ?? null); setSnap(null); setReadError(''); setPhase('idle') }}
              />
            </label>
            {file && <span className="text-sm text-muted-foreground">{file.name} · {(file.size / (1024 * 1024)).toFixed(1)} MB</span>}
            <Button onClick={() => void readBackup()} disabled={!file || busy}>
              {reading ? <><Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> Reading…</> : 'Read backup'}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            In Vyapar: <span className="font-medium">Settings → Backup &amp; Restore → Take a backup</span>, then copy the .vyb file here.
            The .vyp file inside a .vyb works too. A report exported from Vyapar to Excel is imported through the{' '}
            <button type="button" className="underline" onClick={onUseFile}>normal file import</button>.
          </p>
          {readError && (
            <Alert variant="destructive" role="alert">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>The backup could not be read</AlertTitle>
              <AlertDescription>{readError}</AlertDescription>
            </Alert>
          )}
        </section>

        {snap && (
          <>
            {/* ---------------- Step 2: what the backup holds ---------------- */}
            <section className="space-y-3">
              <h3 className="text-sm font-semibold">Step 2 · What this backup holds</h3>
              <div className="rounded-lg border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Building2 className="h-4 w-4 text-success" aria-hidden />
                  <span className="font-semibold">{snap.firm.name || 'Vyapar company'}</span>
                  {snap.firm.gstin && <Badge variant="outline">GSTIN {snap.firm.gstin}</Badge>}
                  {snap.firm.state && <Badge variant="outline">{snap.firm.state}</Badge>}
                  <span className="ml-auto text-xs text-muted-foreground">{snap.source.companyFile}</span>
                </div>
                {(snap.firm.address || snap.firm.phone || snap.firm.email) && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {[snap.firm.address, snap.firm.phone, snap.firm.email].filter(Boolean).join(' · ')}
                  </p>
                )}
                {snap.stats.firstTxnDate && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    Vouchers in Vyapar: {num(snap.stats.transactions)} · {fmtDate(snap.stats.firstTxnDate)} to {fmtDate(snap.stats.lastTxnDate)}
                  </p>
                )}
              </div>

              <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
                <Stat label="Customers" value={num(snap.lists.customers)} hint={`${snap.stats.partiesWithGstin} parties with a GSTIN`} icon={Building2} />
                <Stat label="Suppliers" value={num(snap.lists.suppliers)} icon={Building2} />
                <Stat label="Items" value={num(snap.lists.items)} hint={`${num(snap.stats.serviceItems)} services · ${snap.stats.itemsWithCode} with a code`} icon={Package} />
                <Stat label="Stock on hand" value={`₹${money(snap.stats.stockValue)}`} hint={`${num(snap.lists.openingStock)} items · ${num(snap.stats.stockQty)} units`} icon={Wallet} />
              </div>

              {!!snap.stats.txnGroups.length && (
                <details className="rounded-lg border p-3">
                  <summary className="cursor-pointer text-sm font-medium">
                    Vouchers read (not imported yet) — {num(snap.stats.transactions)} entries
                  </summary>
                  <Table className="mt-2">
                    <TableHeader>
                      <TableRow><TableHead>Entry</TableHead><TableHead className="text-right">Count</TableHead><TableHead>Period</TableHead></TableRow>
                    </TableHeader>
                    <TableBody>
                      {snap.stats.txnGroups.map((g) => (
                        <TableRow key={g.type}>
                          <TableCell>{g.label}</TableCell>
                          <TableCell className="text-right tabular-nums">{num(g.count)}</TableCell>
                          <TableCell className="text-xs text-muted-foreground">{g.from ? `${fmtDate(g.from)} – ${fmtDate(g.to)}` : '—'}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                  <p className="mt-2 text-xs text-muted-foreground">
                    Sales, purchases, payments and expenses are counted here so the summary matches Vyapar, but they are not
                    imported in this version — only parties, items and opening stock are.
                  </p>
                </details>
              )}

              {!!snap.warnings.length && (
                <Alert>
                  <Info className="h-4 w-4" />
                  <AlertTitle>Before you import</AlertTitle>
                  <AlertDescription>
                    <ul className="list-disc space-y-1 pl-4">
                      {snap.warnings.map((w) => <li key={w}>{w}</li>)}
                    </ul>
                  </AlertDescription>
                </Alert>
              )}
            </section>

            {/* ---------------- Step 3: what to import ---------------- */}
            <section className="space-y-3">
              <h3 className="text-sm font-semibold">Step 3 · What should be imported</h3>
              <div className="grid gap-2 sm:grid-cols-2">
                {KINDS.map((k) => {
                  const count = recordCount(k.kind)
                  const disabled = count === 0
                  return (
                    <label key={k.kind} className={cn('flex items-start gap-3 rounded-lg border p-3', disabled ? 'opacity-60' : 'cursor-pointer hover:border-success-border')}>
                      <Checkbox
                        checked={kinds.has(k.kind)}
                        disabled={disabled || busy || phase === 'done'}
                        onCheckedChange={(v) => setKinds((prev) => {
                          const next = new Set(prev)
                          if (v === true) next.add(k.kind); else next.delete(k.kind)
                          return next
                        })}
                        aria-label={k.label}
                      />
                      <span className="min-w-0">
                        <span className="flex items-center gap-2 font-medium">{k.label} <Badge variant="outline">{num(count)}</Badge></span>
                        <span className="mt-0.5 block text-xs text-muted-foreground">{k.hint}</span>
                        <span className="mt-0.5 block text-xs text-muted-foreground">from {k.source}</span>
                      </span>
                    </label>
                  )
                })}
              </div>

              {kinds.has('items') && (
                <div className="grid gap-3 rounded-lg border p-3 sm:grid-cols-3">
                  <Field label="Item type for products">
                    <SelectInput value={itemType} onChange={setItemType} options={ITEM_TYPES.filter((t) => t !== 'SERVICE').map((t) => ({ value: t, label: ITEM_TYPE_LABEL[t] ?? t }))} />
                  </Field>
                  <Field label={`GST rate for ${snap.stats.itemsWithoutGst} items without one`}>
                    <SelectInput
                      value={gstFallback}
                      onChange={setGstFallback}
                      options={[{ value: '', label: snap.stats.itemsWithoutGst ? 'Choose a rate' : 'Not needed' }, ...GST_CHOICES.map((g) => ({ value: g, label: `${g}%` }))]}
                      disabled={!snap.stats.itemsWithoutGst}
                    />
                  </Field>
                  <Field label="Unit for units ManuFlow does not have">
                    <SelectInput
                      value={uomFallback}
                      onChange={setUomFallback}
                      options={[{ value: '', label: snap.unknownUnits.length ? 'Choose a unit' : 'Not needed' }, ...UOMS.map((u) => ({ value: u, label: u }))]}
                      disabled={!snap.unknownUnits.length}
                    />
                  </Field>
                  {!!snap.unknownUnits.length && (
                    <p className="text-xs text-muted-foreground sm:col-span-3">
                      Units without an equivalent: {snap.unknownUnits.map((u) => `${u.unit} (${u.count})`).join(', ')}
                    </p>
                  )}
                  {snap.stats.itemsWithoutHsn > 0 && (
                    <p className="text-xs text-muted-foreground sm:col-span-3">
                      {num(snap.stats.itemsWithoutHsn)} items have no HSN in Vyapar — add it before billing them on GST invoices.
                    </p>
                  )}
                </div>
              )}

              {kinds.has('opening-stock') && (
                <div className="space-y-2 rounded-lg border p-3">
                  <div className="max-w-sm">
                    <Field label="Warehouse for the opening stock" required>
                      <SelectInput
                        value={warehouseId}
                        onChange={setWarehouseId}
                        options={(warehouses.data?.items ?? []).map((w) => ({ value: w.id, label: `${w.code} — ${w.name}` }))}
                        placeholder="Choose a warehouse"
                      />
                    </Field>
                  </div>
                  <GoLivePanel companyId={companyId} onChange={setGoLive} />
                  <p className="text-xs text-muted-foreground">
                    Vyapar&apos;s stock value of ₹{money(snap.stats.stockValue)} is posted as the opening value
                    (rate = Vyapar value ÷ quantity), so the stock report after the import matches Vyapar on the cutover date.
                  </p>
                </div>
              )}

              {choiceProblem && phase !== 'done' && <p className="text-sm text-warning" role="status">{choiceProblem}</p>}
            </section>

            {/* ---------------- Step 4: review + import ---------------- */}
            <section className="space-y-3">
              <h3 className="text-sm font-semibold">
                Step 4 · Review and import{' '}
                <span className="font-normal text-muted-foreground">— nothing is saved until you press Import</span>
              </h3>
              {phase === 'idle' && (
                <Button onClick={() => void previewAll()} disabled={!!choiceProblem || busy}>
                  Check the data <ArrowRight className="ml-1.5 h-4 w-4" />
                </Button>
              )}
              {(phase === 'checking' || phase === 'importing' || phase === 'ready' || phase === 'done') && (
                <div className="space-y-3">
                  <div className="rounded-lg border">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Data</TableHead>
                          <TableHead className="text-right">Records</TableHead>
                          <TableHead className="text-right">Ready</TableHead>
                          <TableHead className="text-right">Duplicates</TableHead>
                          <TableHead className="text-right">Problems</TableHead>
                          {phase === 'done' && <TableHead className="text-right">Imported</TableHead>}
                          <TableHead />
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {selected.map((k) => {
                          const s = states[k.kind]
                          return (
                            <TableRow key={k.kind}>
                              <TableCell className="font-medium">
                                {k.label}
                                {s?.note && <span className="mt-0.5 block text-xs font-normal text-muted-foreground">{s.note}</span>}
                              </TableCell>
                              <TableCell className="text-right tabular-nums">{s ? num(s.total) : '—'}</TableCell>
                              <TableCell className="text-right tabular-nums">{s ? num(s.ready) : '—'}</TableCell>
                              <TableCell className="text-right tabular-nums">{s ? num(s.duplicates) : '—'}</TableCell>
                              <TableCell className={cn('text-right tabular-nums', s && s.problems > 0 && 'font-semibold text-destructive')}>{s ? num(s.problems) : '—'}</TableCell>
                              {phase === 'done' && <TableCell className="text-right font-semibold tabular-nums text-success">{s ? num(s.imported) : '—'}</TableCell>}
                              <TableCell className="text-right">
                                {s && s.problemsRows.length > 0 && (
                                  <Button size="sm" variant="link" className="h-auto p-0" onClick={() => setShowProblems(showProblems === k.kind ? null : k.kind)}>
                                    {showProblems === k.kind ? 'Hide' : 'Show'} problems
                                  </Button>
                                )}
                              </TableCell>
                            </TableRow>
                          )
                        })}
                      </TableBody>
                    </Table>
                  </div>

                  {(phase === 'checking' || phase === 'importing') && (
                    <div className="space-y-1" role="status" aria-live="polite">
                      <div className="flex items-center gap-2 text-sm"><Loader2 className="h-4 w-4 animate-spin" /> {stage || 'Working…'}</div>
                      <div className="text-xs text-muted-foreground">Finished {progress.done} of {progress.total} data types</div>
                    </div>
                  )}

                  {showProblems && states[showProblems] && (
                    <div className="space-y-2">
                      {states[showProblems].problemsRows.slice(0, PAGE_PROBLEMS).map((r) => (
                        <div key={r.line} className="flex flex-wrap items-start gap-2 rounded-lg border p-2 text-sm">
                          {r.status === 'error' || r.status === 'failed' ? <XCircle className="mt-0.5 h-4 w-4 text-destructive" /> : <Ban className="mt-0.5 h-4 w-4 text-warning" />}
                          <span className="font-medium">Record {r.line - 1}</span>
                          <span className="font-semibold">{r.values.name || r.values.itemName || ''}</span>
                          <span className="text-muted-foreground">{STATUS_LABEL[r.status]}</span>
                          <span className="w-full text-muted-foreground">{r.messages.join('; ')}</span>
                        </div>
                      ))}
                      {states[showProblems].problemsRows.length > PAGE_PROBLEMS && (
                        <p className="text-xs text-muted-foreground">… and {states[showProblems].problemsRows.length - PAGE_PROBLEMS} more — download the list to see them all.</p>
                      )}
                      <Button size="sm" variant="outline" onClick={() => downloadText(`vyapar-${showProblems}-problems.csv`, problemRowsCsv(states[showProblems].problemsRows))}>
                        <Download className="mr-1.5 h-4 w-4" /> Download the problem rows
                      </Button>
                    </div>
                  )}

                  {phase === 'ready' && (
                    <div className="flex flex-wrap items-center gap-3">
                      <Button onClick={() => void importAll()} disabled={busy}>
                        <CheckCircle2 className="mr-1.5 h-4 w-4" /> Import {num(totals.ready)} records
                      </Button>
                      <Button variant="outline" onClick={() => { setPhase('idle'); setStates({} as Record<Kind, KindState>); setShowProblems(null) }} disabled={busy}>
                        <ArrowLeft className="mr-1.5 h-4 w-4" /> Change the selection
                      </Button>
                      <p className="text-xs text-muted-foreground">
                        {num(totals.duplicates)} of them already exist in ManuFlow and are skipped; {num(totals.problems)} have problems and are not imported.
                      </p>
                    </div>
                  )}

                  {phase === 'done' && (
                    <Alert>
                      <CheckCircle2 className="h-4 w-4" />
                      <AlertTitle>Import finished</AlertTitle>
                      <AlertDescription>
                        <p>
                          {num(totals.imported)} records imported · {num(totals.duplicates)} skipped (already exist) · {num(totals.problems)} not imported.
                          Every batch is recorded in the Import History.
                        </p>
                        <p className="mt-1 text-xs">
                          Not imported from this backup: Vyapar vouchers (sales, purchases, payments, expenses), party balances and
                          cash / bank opening balances. Set the balances with the go-live date once the accounting import is available.
                        </p>
                      </AlertDescription>
                    </Alert>
                  )}

                  {runError && (
                    <Alert variant="destructive" role="alert">
                      <AlertTriangle className="h-4 w-4" />
                      <AlertTitle>The import stopped</AlertTitle>
                      <AlertDescription>{runError}</AlertDescription>
                    </Alert>
                  )}
                </div>
              )}
            </section>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
