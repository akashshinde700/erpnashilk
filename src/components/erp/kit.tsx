'use client'

import * as React from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ScrollArea } from '@/components/ui/scroll-area'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { fmtDate, fmtMoney, fmtNum, tone } from '@/lib/erp-constants'
import { Bookmark, BookmarkPlus, Download, FileSpreadsheet, Inbox, Search, Printer, Trash2, X } from 'lucide-react'
import * as XLSX from 'xlsx'

// ---------- Page header ----------

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between mb-4">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
        {description && <p className="text-sm text-muted-foreground mt-0.5">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}

// ---------- Status badge ----------

export function StatusBadge({ status }: { status?: string | null }) {
  const t = tone(status)
  const cls: Record<string, string> = {
    gray: 'bg-muted text-muted-foreground',
    green: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300',
    amber: 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300',
    red: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300',
    blue: 'bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300',
    purple: 'bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300',
    teal: 'bg-teal-100 text-teal-700 dark:bg-teal-950 dark:text-teal-300',
  }
  const label = (status || '—').replaceAll('_', ' ')
  return <span className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap', cls[t])}>{label}</span>
}

// ---------- Stat card ----------

export function StatCard({ title, value, sub, icon, toneClass }: { title: string; value: string | number; sub?: string; icon?: React.ReactNode; toneClass?: string }) {
  return (
    <Card className="py-4">
      <CardContent className="flex items-start justify-between gap-2 px-4">
        <div className="min-w-0">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{title}</p>
          <p className="text-xl sm:text-2xl font-bold mt-1 truncate">{value}</p>
          {sub && <p className="text-xs text-muted-foreground mt-0.5 truncate">{sub}</p>}
        </div>
        {icon && <div className={cn('rounded-lg p-2 shrink-0', toneClass || 'bg-primary/10 text-primary')}>{icon}</div>}
      </CardContent>
    </Card>
  )
}

// ---------- CSV export ----------

function csvEscape(v: string | number): string {
  const s = String(v ?? '')
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s
}

export function downloadCsv(filename: string, headers: string[], rows: (string | number)[][]) {
  const csv = [headers, ...rows].map((r) => r.map(csvEscape).join(',')).join('\n')
  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${filename}-${new Date().toISOString().slice(0, 10)}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

// ---------- XLSX export ----------

/**
 * Builds a real Excel workbook (one sheet) from a 2-D array — first data row is
 * the header row. Numbers stay number cells (Excel can sum/filter them) and each
 * column gets a width derived from its longest content (capped). Browser-only:
 * XLSX.writeFile triggers the file download.
 */
export function downloadXlsx(filename: string, headers: string[], rows: (string | number)[][]) {
  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows])
  ws['!cols'] = headers.map((h, col) => {
    let max = String(h ?? '').length
    for (const row of rows) {
      const len = String(row[col] ?? '').length
      if (len > max) max = len
    }
    return { wch: Math.min(Math.max(max + 2, 10), 45) }
  })
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Data')
  XLSX.writeFile(wb, `${filename}.xlsx`)
}

// ---------- Kbd (keyboard key chip) ----------

export function Kbd({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        'inline-flex h-5 min-w-5 items-center justify-center gap-0.5 rounded border bg-muted px-1.5 font-mono text-[10px] font-semibold text-muted-foreground',
        className,
      )}
    >
      {children}
    </kbd>
  )
}

// ---------- Deep-link row highlight (global search → module table) ----------

/** Escape a string for safe use inside a CSS attribute selector (ids are plain cuids — defensive only). */
function cssAttrEscape(s: string): string {
  return typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
    ? CSS.escape(s)
    : s.replace(/["\\]/g, '\\$&')
}

/**
 * Reads the deep-link written by the global search palette (sessionStorage key
 * 'erp_deep_link': { module, id, ts }) and returns the record id that should be
 * highlighted in this module's table — or null. The entry is consumed (removed)
 * on first read and the highlight auto-clears after ~8s, making it a one-shot pulse.
 * Pass the module's key (e.g. 'items', 'sales-orders'); deep links for other
 * modules are ignored (and consumed) by the first mounted module that reads them.
 */
export function useRowHighlight(moduleKey: string | null | undefined): string | null {
  const [highlightId, setHighlightId] = React.useState<string | null>(null)

  // Read once per mount. The sessionStorage key is removed on every successful
  // read, so effect re-runs (moduleKey change without a remount) are no-ops.
  React.useEffect(() => {
    try {
      const raw = sessionStorage.getItem('erp_deep_link')
      if (!raw) return
      const d = JSON.parse(raw) as { module?: unknown; id?: unknown; ts?: unknown }
      sessionStorage.removeItem('erp_deep_link')
      if (d && d.module === moduleKey && typeof d.id === 'string' && d.id.trim() !== '') {
        setHighlightId(String(d.id))
      }
    } catch {
      // Malformed / unavailable deep link — best-effort UX nicety, ignore.
    }
  }, [moduleKey])

  // Auto-clear the pulse so a stale highlight never sticks around.
  React.useEffect(() => {
    if (!highlightId) return
    const t = setTimeout(() => setHighlightId(null), 8000)
    return () => clearTimeout(t)
  }, [highlightId])

  // Same-module deep link while already mounted (no remount happens): the palette
  // also broadcasts 'erp:deep-link' so we re-highlight live.
  React.useEffect(() => {
    const handler = (e: Event) => {
      try {
        const d = (e as CustomEvent<{ module?: unknown; id?: unknown }>).detail
        if (d && d.module === moduleKey && typeof d.id === 'string' && d.id.trim() !== '') {
          setHighlightId(null) // restart the pulse even for the same row
          window.setTimeout(() => setHighlightId(String(d.id)), 0)
        }
      } catch {
        // best-effort UX nicety — ignore
      }
    }
    window.addEventListener('erp:deep-link', handler)
    return () => window.removeEventListener('erp:deep-link', handler)
  }, [moduleKey])

  return highlightId
}

// ---------- Saved views (per-module localStorage search presets) ----------

interface SavedView { name: string; q: string; ts: number }

const VIEWS_STORAGE_PREFIX = 'manuflow:views:'

/** Reads + sanitizes the saved-view list for a storage key. Private-mode safe (returns [] on any failure). */
function loadSavedViews(key: string): SavedView[] {
  try {
    const raw = localStorage.getItem(VIEWS_STORAGE_PREFIX + key)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((v): v is SavedView =>
        !!v && typeof v === 'object' &&
        typeof (v as SavedView).name === 'string' && typeof (v as SavedView).q === 'string')
      .map((v) => ({ name: v.name, q: v.q, ts: typeof v.ts === 'number' ? v.ts : 0 }))
  } catch {
    return []
  }
}

/** Writes the saved-view list for a storage key. Private-mode safe (silently no-ops). */
function persistSavedViews(key: string, views: SavedView[]) {
  try {
    localStorage.setItem(VIEWS_STORAGE_PREFIX + key, JSON.stringify(views))
  } catch {
    // Storage unavailable (private mode / quota) — views stay in-memory for this session.
  }
}

// ---------- Generic data table ----------

export interface Column<T> {
  key: string
  header: string
  render: (row: T) => React.ReactNode
  className?: string
  hideOnMobile?: boolean
}

export function DataTable<T extends { id: string }>({
  columns, rows, loading, emptyText = 'No records yet', searchPlaceholder, onRowClick, maxHeight = 'auto', pageSize = 12, csvExport, xlsxExport, highlightId, moduleKey, savedViewsKey,
}: {
  columns: Column<T>[]
  rows: T[]
  loading?: boolean
  emptyText?: string
  searchPlaceholder?: string
  onRowClick?: (row: T) => void
  maxHeight?: string
  pageSize?: number
  /** When provided, shows an "Export CSV" button exporting all filtered rows. */
  csvExport?: { filename: string; pick: (row: T) => (string | number)[] }
  /** When provided, shows an "Excel" button (beside the CSV one) exporting the same filtered rows as a real .xlsx. Headers default to the column labels — identical columns to the CSV. */
  xlsxExport?: { filename: string; headers?: string[]; pick: (row: T) => (string | number)[] }
  /** Deep-linked record id (from useRowHighlight) — page-jumps to + scrolls the row into view and highlights it. */
  highlightId?: string | null
  /** Opts into the dashboard filter-preset channel: on mount consumes sessionStorage 'erp_filter_preset' ({ module, q, ts }) when its module matches, and live-listens for 'erp:filter-preset' CustomEvents (detail { module, q }). Pass the module's key (e.g. 'items'). No effect when omitted. */
  moduleKey?: string
  /** Enables the "Views" saved-search control. Views persist in localStorage under `manuflow:views:<savedViewsKey>` — pass `${companyId}:<moduleKey>` so views are scoped per company + module. No effect when omitted. */
  savedViewsKey?: string
}) {
  const [q, setQ] = React.useState('')
  const [appliedView, setAppliedView] = React.useState<string | null>(null)
  const [page, setPage] = React.useState(0)
  const wrapperRef = React.useRef<HTMLDivElement | null>(null)

  const filtered = React.useMemo(() => {
    if (!q.trim()) return rows
    const needle = q.toLowerCase()
    return rows.filter((r) => JSON.stringify(r).toLowerCase().includes(needle))
  }, [rows, q])

  React.useEffect(() => setPage(0), [q, rows.length])

  // Deep-link: page-jump to + scroll the highlighted row into view. Rows may
  // arrive async (table can be loading when the highlight first applies), so
  // attempts are retried across a few ticks; state kept in a ref keyed by the
  // highlight id makes each jump a strict one-shot that never fights the
  // user's own paging/filtering afterwards.
  const jumpStateRef = React.useRef<{ id: string | null; jumped: boolean; scrolled: boolean }>({ id: null, jumped: false, scrolled: false })

  React.useEffect(() => {
    if (!highlightId) return
    const st = jumpStateRef.current
    if (st.id !== highlightId) {
      st.id = highlightId
      st.jumped = false
      st.scrolled = false
    }
    const timers: ReturnType<typeof setTimeout>[] = []
    const attempt = () => {
      if (!st.jumped) {
        const idx = filtered.findIndex((r) => String(r.id) === highlightId)
        if (idx === -1) return // not in filtered yet (rows still loading) or filtered out by the text filter — do nothing
        st.jumped = true
        setPage(Math.floor(idx / pageSize))
      }
      if (!st.scrolled) {
        const el = wrapperRef.current?.querySelector(`[data-row-id="${cssAttrEscape(highlightId)}"]`)
        if (el) {
          el.scrollIntoView({ block: 'center', behavior: 'smooth' })
          st.scrolled = true
        }
      }
    }
    for (const delay of [0, 150, 400, 900]) timers.push(setTimeout(attempt, delay))
    return () => timers.forEach(clearTimeout)
  }, [highlightId, filtered, pageSize])

  // ---- Dashboard filter presets (moduleKey) ----
  // One-shot: read + consume sessionStorage 'erp_filter_preset' ({ module, q, ts })
  // on mount, exactly like the deep-link pattern above.
  React.useEffect(() => {
    if (!moduleKey) return
    try {
      const raw = sessionStorage.getItem('erp_filter_preset')
      if (!raw) return
      const d = JSON.parse(raw) as { module?: unknown; q?: unknown; ts?: unknown }
      sessionStorage.removeItem('erp_filter_preset')
      if (d && d.module === moduleKey && typeof d.q === 'string') setQ(d.q)
    } catch {
      // Malformed / unavailable preset — best-effort, ignore.
    }
  }, [moduleKey])

  // Same-module live presets while already mounted (no remount happens): the
  // emitter also broadcasts 'erp:filter-preset' with detail { module, q }.
  React.useEffect(() => {
    if (!moduleKey) return
    const handler = (e: Event) => {
      try {
        const d = (e as CustomEvent<{ module?: unknown; q?: unknown }>).detail
        if (d && d.module === moduleKey && typeof d.q === 'string') {
          const next = String(d.q)
          setQ((prev) => (next === prev ? prev : next))
          setAppliedView(null) // an external preset replaces any applied view
        }
      } catch {
        // best-effort — ignore
      }
    }
    window.addEventListener('erp:filter-preset', handler)
    return () => window.removeEventListener('erp:filter-preset', handler)
  }, [moduleKey])

  // ---- Saved views (savedViewsKey) ----
  const [views, setViews] = React.useState<SavedView[]>([])
  const [saveDialogOpen, setSaveDialogOpen] = React.useState(false)
  const [viewName, setViewName] = React.useState('')

  // Load (re-load on key change) from localStorage after mount — hydration safe.
  React.useEffect(() => {
    if (!savedViewsKey) return
    setViews(loadSavedViews(savedViewsKey))
    setAppliedView(null)
  }, [savedViewsKey])

  const applyView = (v: SavedView) => {
    setQ(v.q)
    setAppliedView(v.name)
  }

  const deleteView = (name: string) => {
    if (!savedViewsKey) return
    const next = views.filter((v) => v.name !== name)
    setViews(next)
    persistSavedViews(savedViewsKey, next)
    setAppliedView((cur) => (cur === name ? null : cur))
  }

  const saveCurrentView = () => {
    if (!savedViewsKey) return
    const name = viewName.trim() || 'All records'
    const view: SavedView = { name, q, ts: Date.now() }
    const idx = views.findIndex((v) => v.name === name)
    const next = idx === -1 ? [...views, view] : views.map((v, i) => (i === idx ? view : v))
    setViews(next)
    persistSavedViews(savedViewsKey, next)
    setAppliedView(name)
    setSaveDialogOpen(false)
  }

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize))
  const pageRows = filtered.slice(page * pageSize, page * pageSize + pageSize)

  return (
    <div className="space-y-3">
      {(searchPlaceholder || csvExport || xlsxExport || savedViewsKey) && (
        <div className="flex items-center justify-between gap-2">
          {searchPlaceholder ? (
            <div className="relative max-w-xs flex-1">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input value={q} onChange={(e) => { setQ(e.target.value); setAppliedView(null) }} placeholder={searchPlaceholder} className="pl-8 h-9" />
            </div>
          ) : <div />}
          <div className="flex items-center gap-2 shrink-0">
            {csvExport && rows.length > 0 && (
              <Button
                variant="outline"
                size="sm"
                className="h-9"
                onClick={() => downloadCsv(csvExport.filename, columns.map((c) => c.header), filtered.map(csvExport.pick))}
              >
                <Download className="h-4 w-4 mr-1.5" />CSV
              </Button>
            )}
            {xlsxExport && rows.length > 0 && (
              <Button
                variant="outline"
                size="sm"
                className="h-9"
                onClick={() => downloadXlsx(xlsxExport.filename, xlsxExport.headers ?? columns.map((c) => c.header), filtered.map(xlsxExport.pick))}
              >
                <FileSpreadsheet className="h-4 w-4 mr-1.5 text-emerald-600 dark:text-emerald-400" />Excel
              </Button>
            )}
            {savedViewsKey && (
              <div className="flex items-center gap-1.5">
                {appliedView && (
                  <span
                    className="inline-flex items-center gap-1 max-w-40 rounded-full bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300 px-2 py-0.5 text-[11px] font-medium"
                    title={`Applied view: ${appliedView}`}
                  >
                    <span className="truncate">{appliedView}</span>
                    <button
                      type="button"
                      title="Clear applied view"
                      className="rounded-full p-0.5 hover:bg-amber-200/70 dark:hover:bg-amber-900/60"
                      onClick={() => { setQ(''); setAppliedView(null) }}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                )}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="sm" className="h-9" title="Saved views">
                      <Bookmark className="h-4 w-4 mr-1.5" />
                      <span className="hidden sm:inline">Views</span>
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-64">
                    {views.length === 0 ? (
                      <div className="px-2 py-1.5 text-xs text-muted-foreground">No saved views yet</div>
                    ) : (
                      views.map((v) => (
                        <DropdownMenuItem key={v.name} onSelect={() => applyView(v)} className="items-start gap-2">
                          <div className="min-w-0 flex-1 py-0.5">
                            <div className="font-medium truncate">{v.name}</div>
                            {v.q.trim() !== '' && <div className="text-xs text-muted-foreground truncate">“{v.q}”</div>}
                          </div>
                          <button
                            type="button"
                            title={`Delete view “${v.name}”`}
                            className="mt-0.5 rounded p-1 text-muted-foreground hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950"
                            onClick={(e) => { e.stopPropagation(); e.preventDefault(); deleteView(v.name) }}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </DropdownMenuItem>
                      ))
                    )}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onSelect={() => { setViewName(q.trim() || 'All records'); setSaveDialogOpen(true) }}
                    >
                      <BookmarkPlus className="h-4 w-4 mr-2" />
                      Save current search…
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            )}
          </div>
        </div>
      )}
      <div ref={wrapperRef} className="rounded-lg border overflow-hidden bg-card">
        <ScrollArea className={maxHeight !== 'auto' ? maxHeight : undefined} style={maxHeight !== 'auto' ? { height: maxHeight } : undefined}>
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/50 hover:bg-muted/50">
                {columns.map((c) => (
                  <TableHead key={c.key} className={cn('font-medium whitespace-nowrap', c.hideOnMobile && 'hidden md:table-cell', c.className)}>{c.header}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <TableRow key={`sk-${i}`}>
                    {columns.map((c) => (
                      <TableCell key={c.key} className={cn(c.hideOnMobile && 'hidden md:table-cell')}><Skeleton className="h-4 w-full max-w-24" /></TableCell>
                    ))}
                  </TableRow>
                ))
              ) : pageRows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={columns.length} className="h-40 text-center">
                    <div className="flex flex-col items-center gap-2 text-muted-foreground">
                      <Inbox className="h-8 w-8" />
                      <p className="text-sm">{emptyText}</p>
                    </div>
                  </TableCell>
                </TableRow>
              ) : (
                pageRows.map((row) => {
                  const highlighted = highlightId !== null && highlightId !== undefined && String(row.id) === highlightId
                  return (
                    <TableRow
                      key={row.id}
                      data-row-id={String(row.id)}
                      onClick={() => onRowClick?.(row)}
                      className={cn(
                        onRowClick && 'cursor-pointer',
                        highlighted && 'bg-amber-50 dark:bg-amber-500/10 ring-2 ring-inset ring-amber-300 dark:ring-amber-500/40',
                      )}
                    >
                      {columns.map((c) => (
                        <TableCell key={c.key} className={cn('align-middle', c.hideOnMobile && 'hidden md:table-cell', c.className)}>{c.render(row)}</TableCell>
                      ))}
                    </TableRow>
                  )
                })
              )}
            </TableBody>
          </Table>
        </ScrollArea>
      </div>
      {filtered.length > pageSize && (
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>Showing {page * pageSize + 1}–{Math.min((page + 1) * pageSize, filtered.length)} of {filtered.length}</span>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>Prev</Button>
            <Button variant="outline" size="sm" disabled={page >= totalPages - 1} onClick={() => setPage((p) => p + 1)}>Next</Button>
          </div>
        </div>
      )}
      {savedViewsKey && (
        <Dialog open={saveDialogOpen} onOpenChange={setSaveDialogOpen}>
          <DialogContent className="sm:max-w-sm">
            <DialogHeader>
              <DialogTitle>Save current search</DialogTitle>
              <DialogDescription>
                {q.trim() !== ''
                  ? <>Saves the current search text: <span className="font-medium">“{q}”</span></>
                  : 'Saves an empty search (shows all records)'}
              </DialogDescription>
            </DialogHeader>
            <form onSubmit={(e) => { e.preventDefault(); saveCurrentView() }}>
              <div className="grid gap-4 py-2">
                <Field label="View name" required>
                  <Input value={viewName} onChange={(e) => setViewName(e.target.value)} placeholder="All records" autoFocus />
                </Field>
              </div>
              <DialogFooter className="mt-2">
                <Button type="button" variant="outline" onClick={() => setSaveDialogOpen(false)}>Cancel</Button>
                <Button type="submit">Save</Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}

// ---------- Form dialog ----------

export function FormDialog({ open, onOpenChange, title, description, children, onSubmit, submitLabel = 'Save', loading, wide }: {
  open: boolean
  onOpenChange: (o: boolean) => void
  title: string
  description?: string
  children: React.ReactNode
  onSubmit: () => void | Promise<void>
  submitLabel?: string
  loading?: boolean
  wide?: boolean
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={cn('max-h-[90vh] overflow-y-auto', wide ? 'sm:max-w-3xl' : 'sm:max-w-lg')}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <form onSubmit={(e) => { e.preventDefault(); void onSubmit() }}>
          <div className="grid gap-4 py-2">{children}</div>
          <DialogFooter className="mt-4">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={loading}>{loading ? 'Saving…' : submitLabel}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ---------- Fields ----------

export function Field({ label, children, required, className }: { label: string; children: React.ReactNode; required?: boolean; className?: string }) {
  return (
    <div className={cn('grid gap-1.5', className)}>
      <Label className="text-xs font-medium text-muted-foreground">
        {label}{required && <span className="text-red-500"> *</span>}
      </Label>
      {children}
    </div>
  )
}

export function TextInput(props: React.ComponentProps<typeof Input>) {
  return <Input {...props} className={cn('h-9', props.className)} />
}

export function NumberInput({ value, onChange, ...props }: { value: number; onChange: (n: number) => void } & Omit<React.ComponentProps<typeof Input>, 'value' | 'onChange'>) {
  return (
    <Input
      {...props}
      type="number"
      inputMode="decimal"
      className={cn('h-9', props.className)}
      value={Number.isFinite(value) ? value : 0}
      onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
    />
  )
}

export function DateInput({ value, onChange, className }: { value: string; onChange: (v: string) => void; className?: string }) {
  return <Input type="date" value={value} onChange={(e) => onChange(e.target.value)} className={cn('h-9', className)} />
}

export function SelectInput({ value, onChange, options, placeholder = 'Select…', disabled }: {
  value: string; onChange: (v: string) => void; options: { value: string; label: string }[]; placeholder?: string; disabled?: boolean
}) {
  // Radix Select forbids empty string item values — map '' to a sentinel transparently
  const EMPTY = '__EMPTY__'
  const safeOptions = options.map((o) => (o.value === '' ? { ...o, value: EMPTY } : o))
  const safeValue = value === '' ? EMPTY : (value || undefined)
  return (
    <Select value={safeValue} onValueChange={(v) => onChange(v === EMPTY ? '' : v)} disabled={disabled}>
      <SelectTrigger className="h-9 w-full"><SelectValue placeholder={placeholder} /></SelectTrigger>
      <SelectContent className="max-h-72">
        {safeOptions.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
      </SelectContent>
    </Select>
  )
}

// ---------- Confirm action button ----------

export function ConfirmAction({ trigger, title, message, onConfirm, tone = 'default' }: {
  trigger: React.ReactNode
  title: string
  message: string
  onConfirm: () => void | Promise<void>
  tone?: 'default' | 'destructive'
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{message}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className={tone === 'destructive' ? 'bg-red-600 hover:bg-red-700 text-white' : ''}
            onClick={(e) => { e.preventDefault(); void onConfirm() }}
          >
            Confirm
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

// ---------- Section card ----------

export function SectionCard({ title, children, actions, className }: { title?: string; children: React.ReactNode; actions?: React.ReactNode; className?: string }) {
  return (
    <Card className={className}>
      {(title || actions) && (
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            {title && <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>}
            {actions}
          </div>
        </CardHeader>
      )}
      <CardContent className={title ? 'pt-0' : undefined}>{children}</CardContent>
    </Card>
  )
}

// ---------- Money / qty cells ----------

export function Money({ value, className }: { value: number | null | undefined; className?: string }) {
  return <span className={cn('whitespace-nowrap tabular-nums', className)}>{fmtMoney(value)}</span>
}

export function Qty({ value, uom }: { value: number | null | undefined; uom?: string }) {
  return <span className="tabular-nums whitespace-nowrap">{fmtNum(value)}{uom ? ` ${uom}` : ''}</span>
}

export function DateCell({ value }: { value: string | Date | null | undefined }) {
  return <span className="whitespace-nowrap text-muted-foreground">{fmtDate(value)}</span>
}

// ---------- Print helper ----------

export function printHtml(title: string, html: string) {
  const w = window.open('', '_blank', 'width=900,height=700')
  if (!w) return
  w.document.write(`<!DOCTYPE html><html><head><title>${title}</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: -apple-system, 'Segoe UI', Arial, sans-serif; color: #111; padding: 28px; font-size: 13px; }
    h1 { font-size: 20px; margin: 0 0 2px; }
    table { width: 100%; border-collapse: collapse; margin-top: 14px; }
    th, td { border: 1px solid #ddd; padding: 7px 9px; text-align: left; font-size: 12px; }
    th { background: #f4f4f5; font-weight: 600; }
    .num { text-align: right; }
    .muted { color: #666; font-size: 11px; }
    .totals td { border: none; padding: 3px 8px; }
    .totals .num { font-weight: 600; }
    .grand { font-size: 14px; font-weight: 700; border-top: 2px solid #111; }
    .head { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #111; padding-bottom: 12px; }
    .badge { display: inline-block; border: 1px solid #999; border-radius: 4px; padding: 2px 8px; font-size: 10px; letter-spacing: 1px; }
    @media print { body { padding: 12px; } }
  </style></head><body>${html}
  <script>window.onload = function(){ window.print(); }</script>
  </body></html>`)
  w.document.close()
}

export function PrintButton({ onClick, label = 'Print' }: { onClick: () => void; label?: string }) {
  return (
    <Button variant="outline" size="sm" onClick={onClick}>
      <Printer className="h-4 w-4 mr-1.5" />{label}
    </Button>
  )
}
