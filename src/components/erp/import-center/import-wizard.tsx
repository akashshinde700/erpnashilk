'use client'

import * as React from 'react'
import {
  AlertTriangle, ArrowLeft, ArrowRight, Ban, Building2, CheckCircle2, ChevronDown, Download, FileSpreadsheet, FileUp, HelpCircle,
  Info, Loader2, PlugZap, RefreshCw, RotateCcw, Store, Unplug, Upload, XCircle,
} from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Field, SelectInput } from '@/components/erp/kit'
import GoLivePanel, { type GoLive } from '@/components/erp/import-center/go-live-panel'
import TallyConnectorPanel from '@/components/erp/import-center/tally-connector-panel'
import { ITEM_TYPES, ITEM_TYPE_LABEL, fmtDate, fmtDateTime } from '@/lib/erp-constants'
import { IMPORT_DATA_TYPES, IMPORT_LIMITS, PARTS_DATA_TYPES, findDataType, suggestMapping, type ColumnMapping, type MappingSuggestion } from '@/lib/import/fields'
import type { TableRow as FileRow } from '@/lib/import/parse-file'
import type { RunResult, RunRow, RunRowStatus } from '@/lib/import/run'
import type { TallyCheck } from '@/lib/tally/client'
import {
  DATA_TYPE_UI, FILE_ACCEPT, FILE_TYPES, STATUS_LABEL, addFileDuplicates, downloadText, fileProblemFor, friendlyError, markFileDuplicates, mergeRunResults,
  problemRowsCsv, splitParts, templateCsv, withoutLines,
} from '@/lib/import/wizard-helpers'
import type { FileFormat } from '@/lib/import/parse-file'
import type { TallyVoucherCheck } from '@/lib/import/tally-xml'
import { apiGet, apiPost, apiUpload, useList } from '@/lib/use-api'
import { cn } from '@/lib/utils'

/**
 * Import Center wizard (popup). One flow for the three entry cards:
 *   1 Source → 2 Connection / file → 3 Company + data type → 4 Preview + checks → 5 Confirm → 6 Result.
 * It only uses the existing Import Center API: parse (upload, nothing stored), preview (read-only),
 * commit (writes only after "Yes, import", re-validated on the server). Closing the popup before
 * step 5 saves nothing. Direct Tally / Vyapar data transfer is not available yet and is shown as such.
 */

export type ImportEntry = 'tally' | 'vyapar' | 'excel'
type Route = 'direct' | 'file'

const ENTRY: Record<ImportEntry, { title: string; source: string; emoji: string }> = {
  tally: { title: 'Import from Tally', source: 'TALLY', emoji: '📘' },
  vyapar: { title: 'Import from Vyapar', source: 'VYAPAR', emoji: '🟢' },
  excel: { title: 'Import from Excel / CSV', source: 'EXCEL', emoji: '📊' },
}

const STEPS = ['Source', 'Connection / File', 'Data Type', 'Preview', 'Confirm', 'Result']

const STATUS_STYLE: Record<RunRowStatus, { cls: string; icon: typeof CheckCircle2 }> = {
  ready: { cls: 'bg-success-soft text-success ring-1 ring-inset ring-success-border', icon: CheckCircle2 },
  imported: { cls: 'bg-success-soft text-success ring-1 ring-inset ring-success-border', icon: CheckCircle2 },
  duplicate: { cls: 'bg-warning-soft text-warning ring-1 ring-inset ring-warning-border', icon: Ban },
  error: { cls: 'bg-danger-soft text-destructive ring-1 ring-inset ring-danger-border', icon: XCircle },
  failed: { cls: 'bg-danger-soft text-destructive ring-1 ring-inset ring-danger-border', icon: XCircle },
  // Import from Tally only (parties without a GSTIN); a file import never produces these
  confirm: { cls: 'bg-warning-soft text-warning ring-1 ring-inset ring-warning-border', icon: Ban },
  declined: { cls: 'bg-muted text-muted-foreground ring-1 ring-inset ring-border', icon: Ban },
}

interface Parsed {
  fileName: string
  format: FileFormat
  sheetNames: string[]
  sheet: string | null
  table: FileRow[]
  headerRow: number
  suggestion: MappingSuggestion
  notes?: string[]
  tally?: { layout: string; company: string | null; objectCounts: Record<string, number> }
  vouchers?: TallyVoucherCheck
}

const FORMAT_LABEL: Record<FileFormat, string> = {
  xlsx: 'Excel workbook', csv: 'CSV', txt: 'Text in columns', xml: 'XML', 'tally-xml': 'Tally XML', json: 'JSON',
}
const STRUCTURED = ['xml', 'json']
const rupees = (paise: number | null | undefined) => (paise === null || paise === undefined ? '—' : `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)
const num = (v: unknown) => (typeof v === 'number' ? v.toLocaleString('en-IN', { maximumFractionDigits: 4 }) : String(v ?? ''))
const columnLetter = (i: number) => {
  let s = ''
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s
  return s
}

/** Indeterminate progress bar (a single request has no measurable progress). */
function Working({ label }: { label: string }) {
  return (
    <div className="space-y-2" role="status" aria-live="polite">
      <div className="flex items-center gap-2 text-sm"><Loader2 className="h-4 w-4 animate-spin" /> {label}</div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
        <div className="h-full w-1/3 animate-[pulse_1.2s_ease-in-out_infinite] rounded-full bg-primary" />
      </div>
    </div>
  )
}

/** Big selectable option card (radio semantics). */
function Choice({ selected, disabled, onSelect, icon: Icon, title, text, badge, tooltip }: {
  selected: boolean; disabled?: boolean; onSelect: () => void; icon: typeof FileUp; title: string; text: string; badge?: string; tooltip?: string
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-disabled={disabled}
      disabled={disabled}
      title={tooltip}
      onClick={onSelect}
      className={cn(
        'flex w-full items-start gap-3 rounded-lg border p-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        disabled ? 'cursor-not-allowed opacity-60' : 'hover:border-success-border',
        selected && 'border-primary ring-1 ring-ring bg-success-soft dark:bg-success-soft',
      )}
    >
      <Icon className={cn('mt-0.5 h-6 w-6 shrink-0', selected ? 'text-success' : 'text-muted-foreground')} aria-hidden />
      <span className="min-w-0">
        <span className="flex flex-wrap items-center gap-2 font-medium">{title}{badge && <Badge variant="outline" className="font-normal">{badge}</Badge>}</span>
        <span className="mt-0.5 block text-sm text-muted-foreground">{text}</span>
      </span>
      {selected && <CheckCircle2 className="ml-auto h-5 w-5 shrink-0 text-success" aria-label="Selected" />}
    </button>
  )
}

function SummaryCard({ label, value, tone, icon: Icon }: { label: string; value: number; tone: string; icon: typeof CheckCircle2 }) {
  return (
    <div className={cn('rounded-lg border p-3', tone)}>
      <div className="flex items-center gap-1.5 text-xs font-medium"><Icon className="h-3.5 w-3.5" aria-hidden /> {label}</div>
      <div className="mt-1 text-2xl font-bold tabular-nums">{value}</div>
    </div>
  )
}

export default function ImportWizard({ entry, open, onOpenChange, companyId, companyName, onConnectDirect, onUseVyaparBackup }: {
  entry: ImportEntry; open: boolean; onOpenChange: (o: boolean) => void; companyId: string; companyName: string
  /** Tally: "Connect to Tally directly" opens the connector flow (tally-import.tsx) instead of this wizard's step. */
  onConnectDirect?: () => void
  /** Vyapar: "Upload a Vyapar backup" opens the backup flow (vyapar-backup.tsx) instead of this wizard's step. */
  onUseVyaparBackup?: () => void
}) {
  const meta = ENTRY[entry]
  const [step, setStep] = React.useState(1)
  const [route, setRoute] = React.useState<Route | null>(entry === 'excel' ? 'file' : null)
  // Tally connection
  const [tally, setTally] = React.useState<TallyCheck | null>(null)
  const [tallyBusy, setTallyBusy] = React.useState(false)
  const [tallyHelp, setTallyHelp] = React.useState(false)
  // File + data type
  const [file, setFile] = React.useState<File | null>(null)
  const [fileProblem, setFileProblem] = React.useState('')
  const [dataTypeKey, setDataTypeKey] = React.useState('')
  const [parsed, setParsed] = React.useState<Parsed | null>(null)
  const [parsing, setParsing] = React.useState(false)
  const [parseStage, setParseStage] = React.useState('')
  const [partProgress, setPartProgress] = React.useState('')
  const [headerRow, setHeaderRow] = React.useState(0)
  const [mapping, setMapping] = React.useState<ColumnMapping>({})
  const [suggestion, setSuggestion] = React.useState<MappingSuggestion | null>(null)
  const [itemType, setItemType] = React.useState('')
  const [defaultWarehouseId, setDefaultWarehouseId] = React.useState('')
  const [partyKind, setPartyKind] = React.useState('')
  const [unsignedMeans, setUnsignedMeans] = React.useState('')
  const [goLive, setGoLive] = React.useState<GoLive | null>(null)
  // Preview / import
  const [preview, setPreview] = React.useState<RunResult | null>(null)
  // Rows that repeat an earlier row of the file (also across parts): shown as duplicates, never sent to the import
  const [fileDuplicates, setFileDuplicates] = React.useState<Map<number, string>>(new Map())
  const [previewing, setPreviewing] = React.useState(false)
  const [showMapping, setShowMapping] = React.useState(false)
  const [mappingOk, setMappingOk] = React.useState(false)
  const [filter, setFilter] = React.useState<'all' | 'problems' | 'warnings'>('all')
  const [showDetails, setShowDetails] = React.useState(false)
  const [importing, setImporting] = React.useState(false)
  const [result, setResult] = React.useState<RunResult | null>(null)
  const [showReport, setShowReport] = React.useState(false)
  const [error, setError] = React.useState('')

  const dataType = findDataType(dataTypeKey)
  const kind = dataTypeKey
  const isItems = kind === 'items'
  const warehouses = useList<{ items: { id: string; code: string; name: string }[] }>(kind === 'opening-stock' ? `/api/warehouses?companyId=${companyId}` : null)
  const headers = parsed ? (parsed.table[headerRow]?.cells ?? []) : []
  const dataRowCount = parsed ? Math.max(0, parsed.table.length - headerRow - 1) : 0

  // ---------- server calls ----------
  async function checkTally() {
    setTallyBusy(true)
    setError('')
    try {
      setTally(await apiGet<TallyCheck>(`/api/import-center/tally/status?companyId=${companyId}`))
    } catch (e) {
      setTally(null)
      setError(friendlyError(e))
    } finally {
      setTallyBusy(false)
    }
  }

  async function parseFile(typeKey: string, sheet?: string) {
    if (!file) return
    setParsing(true)
    setError('')
    setParsed(null)
    setPreview(null)
    setMappingOk(false)
    try {
      const form = new FormData()
      const ext = file.name.toLowerCase().split('.').pop() ?? ''
      // XML / JSON exports are large and repetitive: sent gzip-compressed (unpacked and size-checked on the server)
      if (STRUCTURED.includes(ext) && typeof CompressionStream !== 'undefined') {
        setParseStage('Compressing the file for upload…')
        const gz = await new Response(file.stream().pipeThrough(new CompressionStream('gzip'))).blob()
        if (gz.size > IMPORT_LIMITS.maxUploadBytes) throw new Error(`The file is too large to upload even compressed (${(gz.size / 1024 / 1024).toFixed(1)} MB). Export a smaller part.`)
        form.set('file', new File([gz], file.name))
        form.set('encoding', 'gzip')
      } else {
        if (file.size > IMPORT_LIMITS.maxUploadBytes) throw new Error('This browser cannot compress the file and it is too large to upload. Use a current Chrome, Edge or Firefox.')
        form.set('file', file)
      }
      setParseStage('Uploading and reading the file…')
      form.set('dataType', typeKey)
      form.set('companyId', companyId)
      if (sheet) form.set('sheet', sheet)
      const p = await apiUpload<Parsed>('/api/import-center/parse', form)
      setParsed(p)
      setHeaderRow(p.headerRow)
      setSuggestion(p.suggestion)
      setMapping(p.suggestion.mapping)
    } catch (e) {
      setError(friendlyError(e))
    } finally {
      setParsing(false)
      setParseStage('')
    }
  }

  const payload = () => ({
    companyId, dataType: dataTypeKey, source: meta.source, fileName: parsed?.fileName, table: parsed?.table, headerRow, mapping,
    options: {
      itemType: itemType || undefined, defaultWarehouseId: defaultWarehouseId || undefined, partyKind: partyKind || undefined,
      unsignedMeans: unsignedMeans || undefined, goLiveDate: goLive?.goLiveDate || undefined,
    },
  })

  // More rows than one import takes (XML / JSON): checked and imported in parts of 500, in file order
  const parts = () => (parsed ? splitParts(parsed.table, headerRow) : [])

  const runPreview = React.useCallback(async () => {
    setPreviewing(true)
    setError('')
    try {
      const list = parts()
      const results: RunResult[] = []
      for (let i = 0; i < list.length; i++) {
        if (list.length > 1) setPartProgress(`part ${i + 1} of ${list.length}`)
        results.push(await apiPost<RunResult>('/api/import-center/preview', { ...payload(), ...list[i] }))
      }
      const merged = mergeRunResults(results)
      const marked = PARTS_DATA_TYPES.includes(dataTypeKey) ? markFileDuplicates(dataTypeKey, merged) : { result: merged, fileDuplicates: new Map<number, string>() }
      setPreview(marked.result)
      setFileDuplicates(marked.fileDuplicates)
      setFilter('all')
    } catch (e) {
      setPreview(null)
      setError(friendlyError(e))
    } finally {
      setPreviewing(false)
      setPartProgress('')
    }
    // payload() reads the state listed below
  }, [companyId, dataTypeKey, parsed, headerRow, mapping, itemType, defaultWarehouseId, partyKind, unsignedMeans, goLive])

  async function runImport() {
    setImporting(true)
    setError('')
    // The rows found to repeat an earlier row of the file are left out (the server still checks the database)
    const list = parsed ? splitParts(withoutLines(parsed.table, headerRow, new Set(fileDuplicates.keys())), headerRow) : []
    const results: RunResult[] = []
    try {
      for (let i = 0; i < list.length; i++) {
        if (list.length > 1) setPartProgress(`part ${i + 1} of ${list.length}`)
        const fileName = list.length > 1 ? `${parsed?.fileName} (part ${i + 1} of ${list.length})` : parsed?.fileName
        results.push(await apiPost<RunResult>('/api/import-center/commit', { ...payload(), ...list[i], fileName, confirm: true }))
      }
      setResult(preview ? addFileDuplicates(mergeRunResults(results), preview, fileDuplicates) : mergeRunResults(results))
      setStep(6)
    } catch (e) {
      // Parts already imported stay imported; trying again skips them as duplicates
      setError(`${friendlyError(e)}${results.length ? ` (${results.length} of ${list.length} parts were imported before this; trying again skips them as duplicates)` : ''}`)
    } finally {
      setImporting(false)
      setPartProgress('')
    }
  }

  // Step 4 opens with a fresh preview (read-only on the server)
  React.useEffect(() => {
    if (step === 4 && !preview && !previewing && !error) void runPreview()
  }, [step, preview, previewing, error, runPreview])

  // ---------- step rules ----------
  const missingRequired = dataType ? dataType.fields.filter((f) => f.required && mapping[f.key] === undefined) : []
  const missingOneOf = dataType ? (dataType.requireOneOf ?? []).filter((g) => !g.fields.some((f) => mapping[f] !== undefined)) : []
  const needsItemType = isItems && mapping.type === undefined && !itemType
  const isVouchers = kind === 'tally-vouchers'
  const optionProblem = !parsed ? '' : isVouchers ? 'Check only: Tally vouchers are not imported into ManuFlow' : missingRequired.length ? `No column was found for: ${missingRequired.map((f) => f.label).join(', ')} — use "Change columns" in step 4`
    : missingOneOf.length ? `At least one of these columns is needed: ${missingOneOf.map((g) => g.label).join('; ')}`
      : dataType?.needsGoLive && !goLive?.goLiveDate ? 'Set the go-live date first'
        : needsItemType ? 'Choose the item type'
          : kind === 'opening-stock' && mapping.warehouse === undefined && !defaultWarehouseId ? 'Choose a warehouse'
            : kind === 'opening-balances' && !partyKind ? 'Choose whose balances these are'
              : dataRowCount === 0 ? 'There is no data below the header row' : ''
  const fileOk = !!file && !fileProblem

  const canNext = step === 1 ? !!route
    : step === 2 ? route === 'file' && fileOk
      : step === 3 ? !!parsed && !parsing && !optionProblem && !isVouchers
        : step === 4 ? !!preview && preview.counts.ready > 0 && mappingOk && dataType?.commit !== false
          : false

  function goNext() {
    setError('')
    if (step === 3 && preview) setPreview(null) // options may have changed — preview again
    setStep((s) => Math.min(6, s + 1))
  }
  function goBack() {
    setError('')
    if (step === 4) { setPreview(null); setMappingOk(false) }
    setStep((s) => Math.max(1, s - 1))
  }
  function startOver() {
    setStep(1); setRoute(entry === 'excel' ? 'file' : null); setFile(null); setFileProblem(''); setDataTypeKey(''); setParsed(null)
    setMapping({}); setSuggestion(null); setItemType(''); setDefaultWarehouseId(''); setPartyKind(''); setUnsignedMeans('')
    setPreview(null); setMappingOk(false); setResult(null); setShowReport(false); setError(''); setTally(null)
  }

  function chooseFile(f: File | null) {
    setFile(f)
    setParsed(null)
    setPreview(null)
    setDataTypeKey('')
    if (!f) { setFileProblem(''); return }
    setFileProblem(fileProblemFor(f.name, f.size))
  }

  function chooseDataType(key: string) {
    setDataTypeKey(key)
    setItemType(''); setDefaultWarehouseId(''); setPartyKind(''); setUnsignedMeans('')
    void parseFile(key)
  }

  function changeMapping(fieldKey: string, v: string) {
    setMapping((m) => {
      const next = { ...m }
      if (v === '') delete next[fieldKey]
      else {
        for (const k of Object.keys(next)) if (next[k] === Number(v)) delete next[k] // one column → one field
        next[fieldKey] = Number(v)
      }
      return next
    })
    setPreview(null)
    setMappingOk(false)
  }

  const shown = (result ?? preview)?.rows.filter((r) => filter === 'all'
    || (filter === 'problems' ? ['error', 'failed', 'duplicate'].includes(r.status) : r.warnings.length > 0)) ?? []
  const keyCols: [string, string][] = isItems
    ? [['code', 'Code'], ['hsn', 'HSN'], ['gstRate', 'GST %'], ['uom', 'Unit'], ['purchasePrice', 'Purchase price']]
    : kind === 'opening-stock'
      ? [['x.item', 'Item'], ['x.warehouse', 'Warehouse'], ['x.qty', 'Qty'], ['x.rate', 'Rate'], ['x.value', 'Value']]
      : kind === 'opening-balances'
        ? [['x.party', 'Party'], ['x.side', 'Dr/Cr'], ['x.amount', 'Amount'], ['x.existing', 'Already recorded']]
        : [['code', 'Code'], ['gstin', 'GSTIN'], ['phone', 'Phone'], ['city', 'City']]
  const cellOf = (r: RunRow, k: string) => {
    if (k.startsWith('x.')) { const v = r.extra?.[k.slice(2)]; return typeof v === 'number' ? num(v) : v ?? '' }
    return (k === 'code' ? r.code || r.values.code : r.values[k]) ?? ''
  }
  const nameOf = (r: RunRow) => r.values.name || r.values.itemName || r.values.itemCode || (typeof r.extra?.item === 'string' ? r.extra.item : '') || '—'

  const blockClose = importing
  const title = meta.title

  // ---------- render ----------
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!blockClose) onOpenChange(o) }}>
      <DialogContent showCloseButton={!blockClose} className="max-h-[92vh] overflow-y-auto sm:max-w-4xl" onInteractOutside={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle className="text-lg sm:text-xl">{title}</DialogTitle>
          <DialogDescription>Company: <span className="font-medium text-foreground">{companyName || '—'}</span></DialogDescription>
        </DialogHeader>

        {/* Steps */}
        <ol className="grid grid-cols-6 gap-1" aria-label="Import steps">
          {STEPS.map((s, i) => {
            const n = i + 1
            return (
              <li key={s} aria-current={n === step ? 'step' : undefined} className="flex flex-col items-center gap-1 text-center">
                <span className={cn('grid h-7 w-7 place-items-center rounded-full border text-xs font-semibold',
                  n < step ? 'border-primary bg-primary text-primary-foreground' : n === step ? 'border-primary text-success' : 'text-muted-foreground')}>
                  {n < step ? <CheckCircle2 className="h-4 w-4" aria-hidden /> : n}
                </span>
                <span className={cn('hidden text-[11px] leading-tight sm:block', n === step ? 'font-medium' : 'text-muted-foreground')}>{s}</span>
              </li>
            )
          })}
        </ol>

        {error && (
          <Alert variant="destructive" role="alert">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Something went wrong</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <div className="min-h-[16rem] space-y-4">
          {/* ---------------- Step 1: source ---------------- */}
          {step === 1 && (
            <section className="space-y-3">
              <h3 className="text-base font-semibold">Step 1 · Where is the data coming from?</h3>
              <div className="grid gap-3" role="radiogroup" aria-label="Source">
                {entry === 'tally' && (
                  <>
                    <Choice selected={route === 'direct'} onSelect={() => (onConnectDirect ? onConnectDirect() : setRoute('direct'))} icon={PlugZap} title="Connect to Tally directly"
                      text="Read customers, suppliers and stock items from TallyPrime through the ManuFlow Tally Connector." />
                    <Choice selected={route === 'file'} onSelect={() => setRoute('file')} icon={FileSpreadsheet} title="Use a file exported from Tally"
                      text="Export a report such as List of Ledgers or Stock Summary from Tally to Excel or CSV and choose that file." badge="Recommended" />
                  </>
                )}
                {entry === 'vyapar' && (
                  <>
                    <Choice selected={route === 'direct'} onSelect={() => (onUseVyaparBackup ? onUseVyaparBackup() : setRoute('direct'))} icon={Store} title="Upload a Vyapar backup (.vyb)"
                      text="Read the backup Vyapar creates and import customers, suppliers, items and opening stock — nothing to export by hand." badge="Recommended" />
                    <Choice selected={route === 'file'} onSelect={() => setRoute('file')} icon={FileSpreadsheet} title="Choose a report exported from Vyapar"
                      text="Export a party, item or stock report from Vyapar to Excel / CSV and choose that file." />
                    <Choice selected={false} disabled onSelect={() => {}} icon={Unplug} title="Connect to Vyapar" badge="Not available"
                      text="Vyapar has no official API or connector, so a direct connection is not possible — the backup file is the way." />
                  </>
                )}
                {entry === 'excel' && (
                  <Choice selected={route === 'file'} onSelect={() => setRoute('file')} icon={FileSpreadsheet} title="Excel / CSV file"
                    text="Your own Excel (.xlsx) or CSV file. A sample template is available in step 3." />
                )}
              </div>
            </section>
          )}

          {/* ---------------- Step 2: connection ---------------- */}
          {step === 2 && route === 'direct' && (
            <section className="space-y-4">
              <h3 className="text-base font-semibold">Step 2 · Connect to Tally</h3>
              <TallyConnectorPanel companyId={companyId} />
              <p className="text-xs text-muted-foreground">Only for ManuFlow installed on a computer in your own office (not the online service):</p>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline" className={cn('gap-1.5 py-1 text-sm', tally?.status === 'connected' ? 'border-success-border text-success' : 'text-muted-foreground')}>
                  {tally?.status === 'connected' ? <PlugZap className="h-4 w-4" aria-hidden /> : <Unplug className="h-4 w-4" aria-hidden />}
                  {tally?.status === 'connected' ? 'Tally server found' : 'Not connected'}
                </Badge>
                <Button size="lg" onClick={() => void checkTally()} disabled={tallyBusy}>
                  {tallyBusy ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-2" />} Check Tally connection
                </Button>
                <Button size="lg" variant="outline" onClick={() => setTallyHelp((v) => !v)} aria-expanded={tallyHelp}>
                  <HelpCircle className="h-4 w-4 mr-2" /> I need help
                </Button>
              </div>
              {tally && (
                <p className="text-sm">
                  {tally.status === 'not_configured'
                    ? 'No Tally connection is set up for this ManuFlow server. ManuFlow runs online (in the cloud), so reaching Tally on your computer needs a small ManuFlow Connector, which is not available yet.'
                    : tally.status === 'connected' ? 'Tally’s XML server is responding.' : 'Tally could not be reached.'}
                  <span className="block text-xs text-muted-foreground">Checked: {fmtDateTime(tally.checkedAt)}</span>
                </p>
              )}
              {tallyHelp && (
                <Alert>
                  <HelpCircle className="h-4 w-4" />
                  <AlertTitle>How to prepare Tally</AlertTitle>
                  <AlertDescription>
                    <ol className="list-decimal space-y-1 pl-5">
                      <li>Open TallyPrime and load the company you want to import.</li>
                      <li>In Exchange → Data Synchronization, set “TallyPrime act as” to Server (or Both). Note the port (usually 9000).</li>
                      <li>In Windows Firewall, open that port for the ManuFlow Connector only.</li>
                    </ol>
                  </AlertDescription>
                </Alert>
              )}
              <Alert>
                <Info className="h-4 w-4" />
                <AlertTitle>Importing directly from Tally is not available yet</AlertTitle>
                <AlertDescription>
                  <p>Company list, customers, suppliers, stock items, opening stock, balances and vouchers are all coming soon. Even with a working connection, data cannot be imported directly yet.</p>
                  <p className="mt-1">For now, export the report from Tally to Excel or CSV and use that file:</p>
                  <Button className="mt-2" variant="secondary" onClick={() => { setRoute('file'); setTally(null) }}>
                    <FileSpreadsheet className="h-4 w-4 mr-2" /> Use an exported file instead
                  </Button>
                </AlertDescription>
              </Alert>
            </section>
          )}

          {/* ---------------- Step 2: file ---------------- */}
          {step === 2 && route === 'file' && (
            <section className="space-y-4">
              <h3 className="text-base font-semibold">Step 2 · Choose a file</h3>
              <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-6 text-center hover:border-success-border focus-within:ring-2 focus-within:ring-ring">
                <Upload className="h-8 w-8 text-success" aria-hidden />
                <span className="font-medium">{file ? file.name : 'Click here to choose a file'}</span>
                <span className="text-xs text-muted-foreground">
                  .xlsx, .csv, .txt up to {IMPORT_LIMITS.maxFileBytes / 1024 / 1024} MB and {IMPORT_LIMITS.maxDataRows} rows · .xml, .json up to {IMPORT_LIMITS.maxStructuredBytes / 1024 / 1024} MB and {IMPORT_LIMITS.maxStructuredDataRows.toLocaleString('en-IN')} records
                </span>
                <Input type="file" accept={FILE_ACCEPT} className="sr-only" aria-label="Choose the file to import" onChange={(e) => chooseFile(e.target.files?.[0] ?? null)} />
              </label>
              {file && !fileProblem && <p className="flex items-center gap-1.5 text-sm text-success"><CheckCircle2 className="h-4 w-4" /> {file.name} · {(file.size / 1024).toFixed(0)} KB — the file is only read to check it; it is not stored.</p>}
              {fileProblem && <p className="flex items-center gap-1.5 text-sm text-destructive" role="alert"><XCircle className="h-4 w-4" /> {fileProblem}</p>}
              <Alert>
                <Info className="h-4 w-4" />
                <AlertTitle>{entry === 'tally' ? 'How to export a file from Tally' : entry === 'vyapar' ? 'How to export a file from Vyapar' : 'Supported files'}</AlertTitle>
                <AlertDescription>
                  {entry === 'tally' && <p>In TallyPrime, open the report you need (for example List of Ledgers or Stock Summary) → Export → Excel (.xlsx) or CSV. Title rows at the top are detected automatically.</p>}
                  {entry === 'vyapar' && <p>Best: Vyapar → Settings → Backup &amp; Restore → take a backup, then upload the .vyb file (step 1). A party or item report exported to Excel works as well.</p>}
                  {entry === 'excel' && <p>The first row should contain the column names (for example Customer Name, GSTIN, Mobile). A sample template is available in step 3.</p>}
                  <ul className="mt-2 grid gap-x-4 sm:grid-cols-2" data-testid="supported-file-types">
                    {FILE_TYPES.map((t) => <li key={t.ext}><span className="font-medium">.{t.ext}</span> — {t.label}</li>)}
                    <li className="text-muted-foreground"><span className="font-medium">.pdf</span> — not importable (tables in a PDF cannot be read reliably)</li>
                  </ul>
                  <p className="mt-1 text-xs">The file type is checked from its content, not only its name. Tally XML (masters exported from TallyPrime) is read directly; Tally vouchers can be checked but not imported.</p>
                </AlertDescription>
              </Alert>
            </section>
          )}

          {/* ---------------- Step 3: company + data type ---------------- */}
          {step === 3 && (
            <section className="space-y-4">
              <h3 className="text-base font-semibold">Step 3 · Choose the company and data type</h3>
              <div className="flex items-center gap-2 rounded-lg border p-3 text-sm">
                <Building2 className="h-5 w-5 text-success" aria-hidden />
                <span>Data will be imported into: <span className="font-semibold">{companyName || '—'}</span></span>
                <span className="ml-auto hidden text-xs text-muted-foreground sm:inline">To use another company, switch it in the tenant selector at the top</span>
              </div>
              <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Data type">
                {IMPORT_DATA_TYPES.map((d) => (
                  <Choice
                    key={d.key}
                    selected={dataTypeKey === d.key}
                    disabled={!d.available || parsing}
                    onSelect={() => chooseDataType(d.key)}
                    icon={d.available ? FileSpreadsheet : Ban}
                    title={DATA_TYPE_UI[d.key]?.name ?? d.label}
                    text={d.available ? (DATA_TYPE_UI[d.key]?.hint ?? '') : 'Coming soon'}
                    tooltip={d.available ? undefined : d.plannedNote}
                    badge={!d.available ? 'Coming soon' : d.commit === false ? 'Check only' : undefined}
                  />
                ))}
              </div>
              {dataType && templateCsv(dataType.key) && (
                <Button variant="link" className="h-auto p-0" onClick={() => downloadText(`${dataType.key}-template.csv`, templateCsv(dataType.key) as string)}>
                  <Download className="h-4 w-4 mr-1.5" /> Download the {DATA_TYPE_UI[dataType.key]?.name} sample template
                </Button>
              )}
              {parsing && <Working label={parseStage || 'Reading the file…'} />}
              {parsed && dataType && (
                <div className="space-y-3 rounded-lg border p-3">
                  <p className="flex flex-wrap items-center gap-1.5 text-sm" data-testid="parsed-file">
                    <CheckCircle2 className="h-4 w-4 text-success" /> {parsed.fileName}
                    <Badge variant="outline" className="font-normal">{FORMAT_LABEL[parsed.format]}</Badge>
                    {isVouchers ? `${parsed.vouchers?.count ?? 0} vouchers found` : `${dataRowCount} rows found`}
                    {!isVouchers && dataRowCount > IMPORT_LIMITS.maxDataRows && <span className="text-muted-foreground">· checked and imported in {Math.ceil(dataRowCount / IMPORT_LIMITS.maxDataRows)} parts of {IMPORT_LIMITS.maxDataRows}</span>}
                  </p>
                  {parsed.tally && (
                    <p className="text-xs text-muted-foreground">
                      Tally file{parsed.tally.company ? ` of company “${parsed.tally.company}”` : ''}: {Object.entries(parsed.tally.objectCounts).map(([k, v]) => `${v} ${k.toLowerCase()}`).join(', ')}
                    </p>
                  )}
                  {!!parsed.notes?.length && <ul className="list-disc pl-5 text-xs text-muted-foreground">{parsed.notes.map((n) => <li key={n}>{n}</li>)}</ul>}
                  {isVouchers && parsed.vouchers && <VoucherCheck check={parsed.vouchers} />}
                  {parsed.sheetNames.length > 1 && (
                    <div className="max-w-md">
                      <Field label={parsed.format === 'xlsx' ? 'Excel sheet' : 'Records in the file'}>
                        <SelectInput value={parsed.sheet ?? ''} onChange={(v) => void parseFile(dataType.key, v)} options={parsed.sheetNames.map((s) => ({ value: s, label: s }))} />
                      </Field>
                    </div>
                  )}
                  {dataType.needsGoLive && <GoLivePanel companyId={companyId} onChange={setGoLive} />}
                  {isItems && mapping.type === undefined && (
                    <div className="max-w-xs">
                      <Field label="Item type for all rows" required>
                        <SelectInput value={itemType} onChange={setItemType} options={ITEM_TYPES.map((t) => ({ value: t, label: ITEM_TYPE_LABEL[t] ?? t }))} placeholder="Choose the item type" />
                      </Field>
                    </div>
                  )}
                  {kind === 'opening-stock' && mapping.warehouse === undefined && (
                    <div className="max-w-xs">
                      <Field label="Warehouse for all rows" required>
                        <SelectInput value={defaultWarehouseId} onChange={setDefaultWarehouseId} options={(warehouses.data?.items ?? []).map((w) => ({ value: w.id, label: `${w.code} — ${w.name}` }))} placeholder="Choose a warehouse" />
                      </Field>
                    </div>
                  )}
                  {kind === 'opening-balances' && (
                    <div className="grid max-w-xl gap-3 sm:grid-cols-2">
                      <Field label="These balances belong to" required>
                        <SelectInput value={partyKind} onChange={setPartyKind} options={[{ value: 'customer', label: 'Customers (debtors)' }, { value: 'supplier', label: 'Suppliers (creditors)' }]} placeholder="Choose" />
                      </Field>
                      <Field label="Amounts without Dr / Cr">
                        <SelectInput value={unsignedMeans} onChange={setUnsignedMeans} options={[{ value: '', label: 'Show as an error' }, { value: 'DR', label: 'Treat as debit (Dr)' }, { value: 'CR', label: 'Treat as credit (Cr)' }]} />
                      </Field>
                    </div>
                  )}
                  {optionProblem && <p className="text-sm text-warning" role="status">{optionProblem}</p>}
                </div>
              )}
            </section>
          )}

          {/* ---------------- Step 4: preview ---------------- */}
          {step === 4 && dataType && (
            <section className="space-y-4">
              <h3 className="text-base font-semibold">Step 4 · Preview and checks <span className="text-sm font-normal text-muted-foreground">— nothing has been saved yet</span></h3>
              {previewing && <Working label={`Checking all rows${partProgress ? ` — ${partProgress}` : ''}…`} />}
              {preview && dataRowCount > IMPORT_LIMITS.maxDataRows && (
                <p className="text-xs text-muted-foreground">Checked in parts of {IMPORT_LIMITS.maxDataRows}; duplicates are found across the whole file, and a repeated record is not imported.</p>
              )}
              {preview && (
                <>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                    <SummaryCard label="Total records" value={preview.counts.total} tone="" icon={FileSpreadsheet} />
                    <SummaryCard label="Ready to import" value={preview.counts.ready} tone="border-success-border text-success" icon={CheckCircle2} />
                    <SummaryCard label="Warnings" value={preview.counts.withWarnings} tone="border-warning-border text-warning" icon={AlertTriangle} />
                    <SummaryCard label="Errors" value={preview.counts.errors} tone="border-danger-border text-destructive" icon={XCircle} />
                    <SummaryCard label="Duplicates" value={preview.counts.duplicates} tone="border-warning-border text-warning" icon={Ban} />
                  </div>
                  {!!preview.notes.length && (
                    <Alert><Info className="h-4 w-4" /><AlertTitle>Please note</AlertTitle><AlertDescription><ul className="list-disc pl-4">{preview.notes.map((n) => <li key={n}>{n}</li>)}</ul></AlertDescription></Alert>
                  )}
                  {preview.balanceTotals && (
                    <div className="rounded-lg border p-3 text-sm">
                      <p className="font-medium">Compare with the source report</p>
                      <div className="mt-1 grid gap-x-6 gap-y-1 sm:grid-cols-3">
                        <span>Matched parties: {preview.balanceTotals.matched} / {preview.balanceTotals.rows}</span>
                        <span>Total debit: ₹{num(preview.balanceTotals.debit)}</span>
                        <span>Total credit: ₹{num(preview.balanceTotals.credit)}</span>
                        <span>Net: ₹{num(preview.balanceTotals.net)}</span>
                      </div>
                    </div>
                  )}
                </>
              )}

              {/* Mapping (advanced) */}
              <div className="rounded-lg border">
                <button type="button" className="flex w-full items-center justify-between p-3 text-left text-sm font-medium" onClick={() => setShowMapping((v) => !v)} aria-expanded={showMapping}>
                  <span>Column mapping ({Object.keys(mapping).length} / {dataType.fields.length}) — {showMapping ? 'Hide' : 'View / change'}</span>
                  <ChevronDown className={cn('h-4 w-4 transition-transform', showMapping && 'rotate-180')} aria-hidden />
                </button>
                {!showMapping && (
                  <p className="px-3 pb-3 text-xs text-muted-foreground">
                    {dataType.fields.filter((f) => mapping[f.key] !== undefined).map((f) => `${f.label} ← “${headers[mapping[f.key]] || columnLetter(mapping[f.key])}”`).join(' · ') || 'No columns matched'}
                  </p>
                )}
                {showMapping && parsed && (
                  <div className="space-y-3 border-t p-3">
                    <div className="max-w-sm">
                      <Field label="Header row (column names)">
                        <SelectInput
                          value={String(headerRow)}
                          onChange={(v) => { const r = Number(v); setHeaderRow(r); const s = suggestMapping(dataType, parsed.table[r]?.cells ?? []); setSuggestion(s); setMapping(s.mapping); setPreview(null); setMappingOk(false) }}
                          options={parsed.table.slice(0, IMPORT_LIMITS.headerScanRows).map((r, i) => ({ value: String(i), label: `Row ${r.line}: ${r.cells.filter(Boolean).slice(0, 4).join(' · ').slice(0, 50) || '(empty)'}` }))}
                        />
                      </Field>
                    </div>
                    <div className="grid gap-2 sm:grid-cols-2">
                      {dataType.fields.map((f) => (
                        <Field key={f.key} label={`${f.label}${f.required ? ' *' : ''}`}>
                          <SelectInput
                            value={mapping[f.key] === undefined ? '' : String(mapping[f.key])}
                            onChange={(v) => changeMapping(f.key, v)}
                            options={[{ value: '', label: '— Do not import —' }, ...headers.map((h, i) => ({ value: String(i), label: `${columnLetter(i)}: ${h || '(no heading)'}` }))]}
                          />
                        </Field>
                      ))}
                    </div>
                    {!!suggestion?.notImported.length && (
                      <p className="text-xs text-muted-foreground">Recognised but not imported: {suggestion.notImported.map((n) => n.header).join(', ')}</p>
                    )}
                    <Button variant="outline" onClick={() => void runPreview()} disabled={previewing || !!optionProblem}>
                      <RefreshCw className="h-4 w-4 mr-2" /> Preview again
                    </Button>
                    {optionProblem && <p className="text-xs text-warning">{optionProblem}</p>}
                  </div>
                )}
              </div>

              {preview && (
                <>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {(['all', 'problems', 'warnings'] as const).map((f) => (
                      <Button key={f} size="sm" variant={filter === f ? 'default' : 'outline'} onClick={() => setFilter(f)} aria-pressed={filter === f}>
                        {f === 'all' ? 'All rows' : f === 'problems' ? 'Errors and duplicates' : 'Warnings'}
                      </Button>
                    ))}
                    <Button size="sm" variant="ghost" onClick={() => setShowDetails((v) => !v)} aria-pressed={showDetails}>{showDetails ? 'Fewer details' : 'More details'}</Button>
                    <Button size="sm" variant="ghost" className="ml-auto" onClick={() => downloadText(`${dataType.key}-problems.csv`, problemRowsCsv(preview.rows))}>
                      <Download className="h-4 w-4 mr-1.5" /> Problem rows (CSV)
                    </Button>
                  </div>
                  <RowsTable rows={shown} keyCols={showDetails ? keyCols : []} nameOf={nameOf} cellOf={cellOf} />
                  {dataType.commit === false ? (
                    <Alert><Info className="h-4 w-4" /><AlertTitle>Check only — this file cannot be imported yet</AlertTitle><AlertDescription>{dataType.commitBlocked}</AlertDescription></Alert>
                  ) : (
                    <label className="flex items-start gap-2 rounded-lg border p-3 text-sm">
                      <Checkbox checked={mappingOk} onCheckedChange={(v) => setMappingOk(v === true)} className="mt-0.5" aria-label="Columns checked" />
                      <span>I have checked the column mapping and the preview above. <span className="text-muted-foreground">Only rows marked “Ready” will be imported.</span></span>
                    </label>
                  )}
                </>
              )}
            </section>
          )}

          {/* ---------------- Step 5: confirm ---------------- */}
          {step === 5 && dataType && preview && (
            <section className="space-y-4">
              <h3 className="text-base font-semibold">Step 5 · Confirm the import</h3>
              <p className="text-lg">Do you want to import the selected data into ManuFlow ERP?</p>
              <ul className="space-y-1 rounded-lg border p-3 text-sm">
                <li>Company: <span className="font-medium">{companyName}</span></li>
                <li>Data: <span className="font-medium">{DATA_TYPE_UI[dataType.key]?.name}</span> · File: {parsed?.fileName}</li>
                <li className="text-success">Rows to import: <span className="font-semibold">{preview.counts.ready}</span></li>
                <li className="text-muted-foreground">Rows left out: {preview.counts.errors} with errors + {preview.counts.duplicates} already existing</li>
                {kind === 'opening-stock' && goLive?.goLiveDate && <li>Stock date: {fmtDate(goLive.openingDate)} (go-live {fmtDate(goLive.goLiveDate)}) — the go-live date cannot be changed after this import</li>}
              </ul>
              {importing ? (
                <Working label={`Importing ${preview.counts.ready} rows${partProgress ? ` — ${partProgress}` : ''}… Please do not close this window.`} />
              ) : (
                <div className="flex flex-wrap gap-2">
                  <Button size="lg" onClick={() => void runImport()}>
                    <CheckCircle2 className="h-5 w-5 mr-2" /> {error ? 'Try again' : 'Yes, import'}
                  </Button>
                  <Button size="lg" variant="outline" onClick={goBack}><ArrowLeft className="h-5 w-5 mr-2" /> Back</Button>
                </div>
              )}
              {error && !importing && <p className="text-xs text-muted-foreground">Trying again is safe: rows that were already imported are skipped as duplicates.</p>}
              <p className="text-xs text-muted-foreground">An import cannot be undone automatically. Correct mistakes on the master screens, or with a stock adjustment for stock.</p>
            </section>
          )}

          {/* ---------------- Step 6: result ---------------- */}
          {step === 6 && result && dataType && (
            <section className="space-y-4">
              <h3 className={cn('flex items-center gap-2 text-xl font-semibold', result.counts.failed + result.counts.errors ? 'text-warning' : 'text-success')}>
                {result.counts.failed + result.counts.errors ? <AlertTriangle className="h-6 w-6" aria-hidden /> : <CheckCircle2 className="h-6 w-6" aria-hidden />}
                {result.counts.failed + result.counts.errors ? 'Import finished — some rows were not imported' : 'Import complete!'}
              </h3>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <SummaryCard label="Imported" value={result.counts.imported} tone="border-success-border text-success" icon={CheckCircle2} />
                <SummaryCard label="Failed" value={result.counts.failed + result.counts.errors} tone="border-danger-border text-destructive" icon={XCircle} />
                <SummaryCard label="Skipped duplicates" value={result.counts.duplicates} tone="border-warning-border text-warning" icon={Ban} />
                <SummaryCard label="Warnings" value={result.counts.withWarnings} tone="border-warning-border text-warning" icon={AlertTriangle} />
              </div>
              {result.reconciliation && (
                <div className="rounded-lg border p-3 text-sm">
                  <p className="font-medium">Stock reconciliation (file vs posted) · Reference {result.reconciliation.ref}</p>
                  <p className="mt-1">File: {num(result.reconciliation.totals.sourceQty)} qty, ₹{num(result.reconciliation.totals.sourceValue)} · Posted: {num(result.reconciliation.totals.postedQty)} qty, ₹{num(result.reconciliation.totals.postedValue)} · Difference: ₹{num(result.reconciliation.totals.valueDiff)}</p>
                </div>
              )}
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" onClick={() => setShowReport((v) => !v)} aria-expanded={showReport}><FileSpreadsheet className="h-4 w-4 mr-2" /> View import report</Button>
                <Button variant="outline" onClick={() => downloadText(`${dataType.key}-import-errors.csv`, problemRowsCsv(result.rows))}><Download className="h-4 w-4 mr-2" /> Download errors</Button>
                <Button variant="outline" onClick={startOver}><RotateCcw className="h-4 w-4 mr-2" /> Import more data</Button>
                <Button onClick={() => { onOpenChange(false); window.dispatchEvent(new CustomEvent('erp:goto', { detail: 'dashboard' })) }}>Go to Dashboard</Button>
              </div>
              {showReport && <RowsTable rows={result.rows} keyCols={keyCols} nameOf={nameOf} cellOf={cellOf} />}
              <p className="text-xs text-muted-foreground">This import is recorded in History.</p>
            </section>
          )}
        </div>

        {/* Navigation */}
        {step <= 4 && (
          <DialogFooter className="flex-row flex-wrap justify-between gap-2 sm:justify-between">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <div className="flex gap-2">
              {step > 1 && <Button variant="outline" size="lg" onClick={goBack}><ArrowLeft className="h-4 w-4 mr-2" /> Back</Button>}
              <Button size="lg" onClick={goNext} disabled={!canNext} aria-disabled={!canNext}>
                Next <ArrowRight className="h-4 w-4 ml-2" />
              </Button>
            </div>
          </DialogFooter>
        )}
        {step === 6 && (
          <DialogFooter><Button variant="ghost" onClick={() => onOpenChange(false)}>Close</Button></DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}

function RowsTable({ rows, keyCols, nameOf, cellOf }: {
  rows: RunRow[]; keyCols: [string, string][]; nameOf: (r: RunRow) => string; cellOf: (r: RunRow, k: string) => string | number
}) {
  return (
    <div className="max-h-80 overflow-auto rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow className="bg-muted/50 hover:bg-muted/50">
            <TableHead className="w-14">Row</TableHead>
            <TableHead>Name</TableHead>
            <TableHead>Status</TableHead>
            {keyCols.map(([k, l]) => <TableHead key={k} className="whitespace-nowrap">{l}</TableHead>)}
            <TableHead className="min-w-56">Problems</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow><TableCell colSpan={keyCols.length + 4} className="h-16 text-center text-muted-foreground">No rows in this view</TableCell></TableRow>
          ) : rows.map((r) => {
            const st = STATUS_STYLE[r.status]
            const warn = r.status === 'ready' && r.warnings.length > 0
            return (
              <TableRow key={r.line}>
                <TableCell className="text-muted-foreground">{r.line}</TableCell>
                <TableCell className="max-w-48 truncate font-medium">{nameOf(r)}</TableCell>
                <TableCell>
                  <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap', warn ? STATUS_STYLE.duplicate.cls : st.cls)}>
                    {warn ? <AlertTriangle className="h-3 w-3" aria-hidden /> : <st.icon className="h-3 w-3" aria-hidden />}
                    {warn ? 'Warning' : STATUS_LABEL[r.status]}
                  </span>
                </TableCell>
                {keyCols.map(([k]) => <TableCell key={k} className="max-w-40 truncate whitespace-nowrap">{cellOf(r, k) || '—'}</TableCell>)}
                <TableCell className="text-xs">
                  {r.messages.length === 0 && r.warnings.length === 0 && <span className="text-muted-foreground">—</span>}
                  {r.messages.map((m) => <div key={m} className="text-destructive">{m}</div>)}
                  {r.warnings.map((w) => <div key={w} className="text-warning">{w}</div>)}
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </div>
  )
}

/** Tally vouchers from an XML file: what is in it, checked — never imported. */
function VoucherCheck({ check }: { check: TallyVoucherCheck }) {
  const [open, setOpen] = React.useState<number | null>(null)
  return (
    <div className="space-y-3" data-testid="voucher-check">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <SummaryCard label="Vouchers" value={check.count} tone="" icon={FileSpreadsheet} />
        <SummaryCard label="Not balanced" value={check.unbalanced} tone={check.unbalanced ? 'border-danger-border text-destructive' : ''} icon={XCircle} />
        <SummaryCard label="Ledger lines" value={check.ledgerLines} tone="" icon={Info} />
        <SummaryCard label="Inventory lines" value={check.inventoryLines} tone="" icon={Info} />
      </div>
      <p className="text-sm">
        {check.from ? `Dates ${fmtDate(check.from)} – ${fmtDate(check.to)}` : 'No dates'} · {check.billAllocations} bill allocations · {check.batchAllocations} batch / godown allocations
        {Object.keys(check.actions).length > 0 && <> · actions in the file: {Object.entries(check.actions).map(([a, n]) => `${a} ${n}`).join(', ')} (reported only)</>}
      </p>
      <div className="overflow-auto rounded-lg border">
        <Table>
          <TableHeader><TableRow><TableHead>Voucher type</TableHead><TableHead className="text-right">Vouchers</TableHead><TableHead className="text-right">Cancelled</TableHead><TableHead className="text-right">Optional</TableHead><TableHead className="text-right">Not balanced</TableHead><TableHead className="text-right">Value (not cancelled)</TableHead></TableRow></TableHeader>
          <TableBody>
            {check.byType.map((t) => (
              <TableRow key={t.type}>
                <TableCell className="font-medium">{t.type}</TableCell><TableCell className="text-right tabular-nums">{t.count}</TableCell>
                <TableCell className="text-right tabular-nums">{t.cancelled}</TableCell><TableCell className="text-right tabular-nums">{t.optional}</TableCell>
                <TableCell className="text-right tabular-nums">{t.unbalanced}</TableCell><TableCell className="text-right tabular-nums">{rupees(t.amountPaise)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <p className="text-xs text-muted-foreground">The first {check.shown} of {check.count} vouchers — select one to see its lines and allocations.</p>
      <div className="max-h-80 overflow-auto rounded-lg border">
        <Table>
          <TableHeader><TableRow><TableHead>Date</TableHead><TableHead>Type</TableHead><TableHead>No.</TableHead><TableHead>Party</TableHead><TableHead className="text-right">Value</TableHead><TableHead>Check</TableHead></TableRow></TableHeader>
          <TableBody>
            {check.vouchers.map((v, i) => (
              <React.Fragment key={i}>
                <TableRow className="cursor-pointer" onClick={() => setOpen(open === i ? null : i)} aria-expanded={open === i}>
                  <TableCell className="whitespace-nowrap">{v.date ? fmtDate(v.date) : '—'}</TableCell>
                  <TableCell>{v.type}</TableCell><TableCell>{v.number ?? '—'}</TableCell>
                  <TableCell className="max-w-48 truncate">{v.party ?? '—'}</TableCell>
                  <TableCell className="text-right tabular-nums">{rupees(v.amountPaise)}</TableCell>
                  <TableCell className="text-xs">
                    {v.cancelled ? <span className="text-warning">Cancelled</span> : v.balanced ? <span className="text-success">Balanced</span> : <span className="text-destructive">Not balanced</span>}
                    {v.optional && <span className="text-muted-foreground"> · optional</span>}
                  </TableCell>
                </TableRow>
                {open === i && (
                  <TableRow className="bg-muted/30 hover:bg-muted/30">
                    <TableCell colSpan={6} className="space-y-2 text-xs">
                      {v.issues.map((m) => <p key={m} className="text-destructive">{m}</p>)}
                      <p className="font-medium">Ledger lines</p>
                      <ul className="space-y-0.5">
                        {v.ledgerLines.map((l, j) => (
                          <li key={j}>
                            {l.ledger || '(no ledger)'} · {rupees(Math.abs(l.amountPaise))} {l.drCr}{l.fromItem ? ' · from an item line' : ''}
                            {l.bills.map((b, k) => <span key={k} className="block pl-4 text-muted-foreground">bill {b.name || '—'} ({b.type ?? '—'}) {rupees(b.amountPaise === null ? null : Math.abs(b.amountPaise))}</span>)}
                          </li>
                        ))}
                      </ul>
                      {v.inventoryLines.length > 0 && <p className="font-medium">Inventory lines</p>}
                      <ul className="space-y-0.5">
                        {v.inventoryLines.map((l, j) => (
                          <li key={j}>
                            {l.item} · {l.qty ?? '—'} {l.unit ?? ''} × {rupees(l.ratePaise)} = {rupees(l.amountPaise === null ? null : Math.abs(l.amountPaise))}
                            {l.batches.map((b, k) => <span key={k} className="block pl-4 text-muted-foreground">{[b.godown, b.batch, b.qty].filter(Boolean).join(' · ')}</span>)}
                          </li>
                        ))}
                      </ul>
                    </TableCell>
                  </TableRow>
                )}
              </React.Fragment>
            ))}
          </TableBody>
        </Table>
      </div>
      <Alert><Info className="h-4 w-4" /><AlertTitle>Check only — vouchers are not imported</AlertTitle><AlertDescription>ManuFlow does not post vouchers from a file into its books: invoices, stock and accounts would change without ManuFlow's own checks. Masters (customers, suppliers, items, opening stock) from a Tally master XML can be imported.</AlertDescription></Alert>
    </div>
  )
}
