'use client'

import * as React from 'react'
import { AlertTriangle, CheckCircle2, Download, FileWarning, Upload } from 'lucide-react'
import { toast } from 'sonner'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { apiPost } from '@/lib/use-api'
import { parseCsv } from '@/lib/import/csv'

export interface ImportResult {
  imported: number
  skipped: number
  errors: { row: number; message: string }[]
}

interface ImportDialogProps {
  open: boolean
  onOpenChange: (o: boolean) => void
  companyId: string
  apiPath: string
  entityLabel: string
  templateHeaders: string[]
  templateSample: (string | number)[][]
  /** Called after a successful import so the module can refetch its list. */
  onImported?: () => void
}

// Columns the server requires per entity — a CSV missing any of these is blocked client-side.
const REQUIRED_COLUMNS: Record<string, string[]> = {
  items: ['code', 'name'],
  customers: ['name'],
}

const PREVIEW_ROWS = 8
const MAX_ERRORS_SHOWN = 5

function csvEscape(v: string | number): string {
  const s = String(v ?? '')
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s
}

export default function ImportDialog({
  open, onOpenChange, companyId, apiPath, entityLabel, templateHeaders, templateSample, onImported,
}: ImportDialogProps) {
  const [csvText, setCsvText] = React.useState('')
  const [fileName, setFileName] = React.useState('')
  const [importing, setImporting] = React.useState(false)
  const [result, setResult] = React.useState<ImportResult | null>(null)
  const [submitError, setSubmitError] = React.useState('')
  const fileRef = React.useRef<HTMLInputElement>(null)

  // Reset state when the dialog closes
  React.useEffect(() => {
    if (open) return
    setCsvText('')
    setFileName('')
    setResult(null)
    setSubmitError('')
    if (fileRef.current) fileRef.current.value = ''
  }, [open])

  const parsed = React.useMemo(() => {
    if (!csvText.trim()) return null
    const table = parseCsv(csvText)
    if (table.length === 0) return null
    const headerRow = table[0].map((h) => h.trim())
    const colIndex = new Map<string, number>() // templateHeader -> column index
    templateHeaders.forEach((t) => {
      const idx = headerRow.findIndex((h) => h.toLowerCase() === t.toLowerCase())
      if (idx >= 0) colIndex.set(t, idx)
    })
    const rows: Record<string, string>[] = table.slice(1).map((r) => {
      const obj: Record<string, string> = {}
      colIndex.forEach((idx, key) => {
        obj[key] = (r[idx] ?? '').trim()
      })
      return obj
    })
    return { headerRow, colIndex, rows }
  }, [csvText, templateHeaders])

  const required = REQUIRED_COLUMNS[entityLabel] ?? []
  const missingColumns = React.useMemo(
    () => (parsed ? required.filter((c) => !parsed.colIndex.has(c)) : []),
    [parsed, required],
  )
  const blocked = missingColumns.length > 0

  const cellWarnings = React.useMemo(() => {
    if (!parsed) return []
    const out: string[] = []
    parsed.rows.forEach((r, i) => {
      for (const c of required) {
        if (parsed.colIndex.has(c) && (r[c] ?? '').trim() === '') out.push(`Row ${i + 1}: ${c} is empty`)
      }
    })
    return out
  }, [parsed, required])

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    if (!f) return
    setFileName(f.name)
    const reader = new FileReader()
    reader.onload = () => setCsvText(String(reader.result ?? ''))
    reader.readAsText(f)
  }

  function downloadTemplate() {
    const csv = [templateHeaders, ...templateSample].map((r) => r.map(csvEscape).join(',')).join('\n')
    const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${entityLabel}-import-template.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  async function runImport() {
    if (!parsed || blocked || parsed.rows.length === 0) return
    setImporting(true)
    setSubmitError('')
    setResult(null)
    try {
      const res = await apiPost<ImportResult>(apiPath, { companyId, rows: parsed.rows })
      setResult(res)
      toast.success(`Imported ${res.imported} ${entityLabel}`)
      onImported?.()
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : 'Import failed')
    } finally {
      setImporting(false)
    }
  }

  const rowCount = parsed?.rows.length ?? 0
  const canImport = !!parsed && !blocked && rowCount > 0 && !importing

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Import {entityLabel}</DialogTitle>
          <DialogDescription>
            Upload a CSV file or paste rows below — the first line must be the header row. Existing {entityLabel} are
            skipped, individual bad rows are reported without failing the batch.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 py-1">
          {/* Step 1 — source */}
          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">1. Choose a file or paste CSV</p>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input ref={fileRef} type="file" accept=".csv,text/csv" onChange={onFile} className="h-9 flex-1" />
              <Button type="button" variant="outline" size="sm" className="h-9 shrink-0" onClick={downloadTemplate}>
                <Download className="h-4 w-4 mr-1.5" /> Download template
              </Button>
            </div>
            <Textarea
              rows={6}
              value={csvText}
              onChange={(e) => setCsvText(e.target.value)}
              placeholder={`Paste CSV here — first line must be the header row:\n${templateHeaders.join(',')}`}
              className="font-mono text-xs"
            />
            {fileName && <p className="text-xs text-muted-foreground">Loaded file: {fileName}</p>}
          </div>

          {/* Step 2 — preview + validation */}
          {parsed && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">2. Preview</p>
                <Badge variant={rowCount > 0 ? 'secondary' : 'destructive'}>
                  {rowCount} row{rowCount === 1 ? '' : 's'}
                </Badge>
                <span className="text-xs text-muted-foreground">showing first {Math.min(PREVIEW_ROWS, rowCount)}</span>
              </div>

              {blocked && (
                <Alert variant="destructive">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertTitle>Missing required column{missingColumns.length === 1 ? '' : 's'}: {missingColumns.join(', ')}</AlertTitle>
                  <AlertDescription>
                    Add the column{missingColumns.length === 1 ? '' : 's'} to the CSV header line (case-insensitive) to continue.
                  </AlertDescription>
                </Alert>
              )}

              {!blocked && cellWarnings.length > 0 && (
                <Alert>
                  <FileWarning className="h-4 w-4 text-warning" />
                  <AlertTitle>{cellWarnings.length} row{cellWarnings.length === 1 ? '' : 's'} with empty required cells</AlertTitle>
                  <AlertDescription>
                    {cellWarnings.slice(0, 3).join(' · ')}
                    {cellWarnings.length > 3 ? ` · +${cellWarnings.length - 3} more` : ''} — those rows will be rejected on import.
                  </AlertDescription>
                </Alert>
              )}

              <div className="rounded-lg border overflow-hidden bg-card">
                <div className="max-h-64 overflow-y-auto">
                  <Table>
                    <TableHeader>
                      <TableRow className="bg-muted/50 hover:bg-muted/50">
                        <TableHead className="w-10 font-medium">#</TableHead>
                        {templateHeaders.map((h) => (
                          <TableHead key={h} className="font-medium whitespace-nowrap">
                            {h}
                            {required.includes(h) && <span className="text-destructive"> *</span>}
                          </TableHead>
                        ))}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {rowCount === 0 ? (
                        <TableRow>
                          <TableCell colSpan={templateHeaders.length + 1} className="h-20 text-center text-sm text-muted-foreground">
                            No data rows found below the header line
                          </TableCell>
                        </TableRow>
                      ) : (
                        parsed.rows.slice(0, PREVIEW_ROWS).map((r, i) => (
                          <TableRow key={i}>
                            <TableCell className="text-muted-foreground">{i + 1}</TableCell>
                            {templateHeaders.map((h) => (
                              <TableCell key={h} className="max-w-40 truncate whitespace-nowrap">
                                {parsed.colIndex.has(h) ? r[h] : <span className="text-muted-foreground">—</span>}
                              </TableCell>
                            ))}
                          </TableRow>
                        ))
                      )}
                    </TableBody>
                  </Table>
                </div>
              </div>
            </div>
          )}

          {/* Result */}
          {submitError && (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>Import failed</AlertTitle>
              <AlertDescription>{submitError}</AlertDescription>
            </Alert>
          )}
          {result && (
            <Alert className="border-success-border bg-success-soft text-success">
              <CheckCircle2 className="h-4 w-4 text-success" />
              <AlertTitle>Imported {result.imported} · Skipped {result.skipped}</AlertTitle>
              {result.errors.length > 0 && (
                <AlertDescription>
                  <ul className="list-disc space-y-0.5 pl-4">
                    {result.errors.slice(0, MAX_ERRORS_SHOWN).map((er) => (
                      <li key={`${er.row}-${er.message}`}>Row {er.row}: {er.message}</li>
                    ))}
                    {result.errors.length > MAX_ERRORS_SHOWN && (
                      <li>…and {result.errors.length - MAX_ERRORS_SHOWN} more</li>
                    )}
                  </ul>
                </AlertDescription>
              )}
            </Alert>
          )}
        </div>

        <DialogFooter className="mt-2">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
          <Button type="button" disabled={!canImport} onClick={() => void runImport()}>
            <Upload className="h-4 w-4 mr-1.5" />
            {importing ? 'Importing…' : `Import ${rowCount} row${rowCount === 1 ? '' : 's'}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
