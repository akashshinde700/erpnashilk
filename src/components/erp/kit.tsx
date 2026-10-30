'use client'

import * as React from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ScrollArea } from '@/components/ui/scroll-area'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { printDocument } from '@/lib/html'
import { fmtDate, fmtMoney, fmtNum, tone } from '@/lib/erp-constants'
import { Bookmark, BookmarkPlus, ChevronDown, ChevronUp, Download, FileSpreadsheet, Inbox, Search, Printer, Trash2, X } from 'lucide-react'
import * as XLSX from 'xlsx'

// ---------- Page header ----------

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: React.ReactNode }) {
  return (
    <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <h2 className="text-xl font-semibold tracking-tight text-balance">{title}</h2>
        {description && <p className="mt-0.5 max-w-2xl text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}

// ---------- Status badge ----------

export function StatusBadge({ status }: { status?: string | null }) {
  const t = tone(status)
  // Tone → token classes, in one place, so every status in the product has the same
  // shape, contrast and dark-mode behaviour.
  const cls: Record<string, string> = {
    gray: 'bg-muted text-muted-foreground ring-border',
    green: 'bg-success-soft text-success ring-success-border',
    amber: 'bg-warning-soft text-warning ring-warning-border',
    red: 'bg-danger-soft text-destructive ring-danger-border',
    blue: 'bg-info-soft text-info ring-info-border',
    purple: 'bg-info-soft text-info ring-info-border',
    teal: 'bg-success-soft text-success ring-success-border',
  }
  const label = (status || '—').replaceAll('_', ' ')
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap ring-1 ring-inset',
        cls[t],
      )}
    >
      {label}
    </span>
  )
}

// ---------- Stat card ----------

export function StatCard({ title, value, sub, icon, toneClass, delta, deltaLabel, hint }: {
  title: string
  value: string | number
  sub?: string
  icon?: React.ReactNode
  toneClass?: string
  /** Signed change, e.g. +12.4 or -3. The sign picks the tone; the caller formats the figure. */
  delta?: number | null
  deltaLabel?: string
  hint?: string
}) {
  const up = (delta ?? 0) > 0
  const flat = !delta
  return (
    <Card className="group relative overflow-hidden py-3.5 elev-1 transition-shadow duration-200 hover:elev-2">
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-0.5 bg-gradient-to-r from-primary/70 via-primary/30 to-transparent opacity-70"
      />
      <CardContent className="flex items-start justify-between gap-3 px-4">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">{title}</p>
          <p
            className="mt-1.5 truncate text-2xl font-semibold tracking-tight tabular"
            title={hint || (typeof value === 'string' ? value : String(value))}
          >
            {value}
          </p>
          <div className="mt-1 flex items-center gap-1.5">
            {typeof delta === 'number' && !flat && (
              <span
                className={cn(
                  'inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[11px] font-semibold tabular',
                  up ? 'bg-success-soft text-success' : 'bg-danger-soft text-destructive',
                )}
              >
                {up ? '▲' : '▼'} {Math.abs(delta).toLocaleString('en-IN')}
              </span>
            )}
            {sub && <p className="truncate text-xs text-muted-foreground">{sub}</p>}
            {deltaLabel && <p className="sr-only">{deltaLabel}</p>}
          </div>
        </div>
        {icon && (
          <div
            className={cn(
              'shrink-0 rounded-xl p-2 ring-1 ring-inset ring-black/5 transition-transform duration-200 group-hover:scale-105 dark:ring-white/10',
              toneClass || 'bg-primary/10 text-primary',
            )}
            aria-hidden="true"
          >
            {icon}
          </div>
        )}
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
  /** Override extractor for the value behind this column — used by DataTable column sorting (`sortable`) and the totals footer (`sum`). Needed for computed columns whose key has no raw row field. */
  sortValue?: (row: T) => string | number
  /** Includes this column in the totals footer row: finite numeric values are summed (client mode: all filtered rows; server mode: current page rows). */
  sum?: boolean
  /** Footer total format — 'money' renders via fmtMoney, 'num' (default) via fmtNum. */
  sumFormat?: 'money' | 'num'
}

/** Raw value behind a column for sorting/summing: the column's sortValue override when set, else the row's own field under the column key. */
function columnValue<T>(row: T, col: Column<T>): unknown {
  return col.sortValue ? col.sortValue(row) : (row as Record<string, unknown>)[col.key]
}

/**
 * Three-way compare for extracted column values: numbers compare numerically,
 * strings lexicographically (ISO date strings order correctly), mixed types
 * fall back to a String() compare. undefined/null never reach this — the sort
 * comparator pulls empties to the end in both directions (empties-always-last).
 */
function compareSortValues(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b
  if (typeof a === 'string' && typeof b === 'string') return a.localeCompare(b)
  const sa = String(a)
  const sb = String(b)
  return sa < sb ? -1 : sa > sb ? 1 : 0
}

export function DataTable<T extends { id: string }>({
  columns, rows, loading, emptyText = 'No records yet', searchPlaceholder, onRowClick, maxHeight = 'auto', pageSize = 12, csvExport, xlsxExport, highlightId, moduleKey, savedViewsKey, serverPagination, sortable,
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
  csvExport?: { filename: string; headers?: string[]; pick: (row: T) => (string | number)[] }
  /** When provided, shows an "Excel" button (beside the CSV one) exporting the same filtered rows as a real .xlsx. Headers default to the column labels — identical columns to the CSV. */
  xlsxExport?: { filename: string; headers?: string[]; pick: (row: T) => (string | number)[] }
  /** Deep-linked record id (from useRowHighlight) — page-jumps to + scrolls the row into view and highlights it. */
  highlightId?: string | null
  /** Opts into the dashboard filter-preset channel: on mount consumes sessionStorage 'erp_filter_preset' ({ module, q, ts }) when its module matches, and live-listens for 'erp:filter-preset' CustomEvents (detail { module, q }). Pass the module's key (e.g. 'items'). No effect when omitted. */
  moduleKey?: string
  /** Enables the "Views" saved-search control. Views persist in localStorage under `manuflow:views:<savedViewsKey>` — pass `${companyId}:<moduleKey>` so views are scoped per company + module. No effect when omitted. */
  savedViewsKey?: string
  /** Opts the whole table into column sorting: every column with usable values (a sortValue extractor, or at least one row with a non-null raw value under its key) gets a clickable header cycling asc → desc → off. Client mode sorts the full filtered set before pagination (filter → sort → paginate); server mode only reorders the current page slice (the API owns the real order). undefined/null values sort last in both directions. Sort state persists across refetches. No effect when omitted. */
  sortable?: boolean
  /** Opts into server-side pagination: `rows` must then be exactly the page slice the API returned (already filtered + paginated). The local text filter and internal page state are bypassed — Prev/Next and the "Showing …" footer are driven by `page`/`onPageChange`/`total`, and (with `onSearchChange`) the search text is pushed to the module debounced by 300ms (mount run skipped). Omit for the default fully client-side behavior (zero change). */
  serverPagination?: {
    /** 0-based page index, controlled by the module (Prev → onPageChange(page - 1), Next → onPageChange(page + 1)). */
    page: number
    /** Rows per server page — the module must fetch exactly this many. */
    pageSize: number
    /** Full filtered row count from the server (across all pages). */
    total: number
    /** Called when the user pages (Prev/Next) or a highlight page-jump targets another page. */
    onPageChange: (page: number) => void
    /** Debounced (300ms) search-text push; the module should store it as its server-side q filter and reset to page 0. */
    onSearchChange?: (q: string) => void
  }
}) {
  const [q, setQ] = React.useState('')
  const [appliedView, setAppliedView] = React.useState<string | null>(null)
  const [page, setPage] = React.useState(0)
  const wrapperRef = React.useRef<HTMLDivElement | null>(null)

  const filtered = React.useMemo(() => {
    if (serverPagination) return rows // server mode: the API already filtered + sliced — rows are the page as-is
    if (!q.trim()) return rows
    const needle = q.toLowerCase()
    return rows.filter((r) => JSON.stringify(r).toLowerCase().includes(needle))
  }, [rows, q, serverPagination])

  React.useEffect(() => setPage(0), [q, rows.length])

  // ---- Column sorting (sortable) ----
  // Active sort: { key, dir } cycling asc → desc → off per header click; null
  // = unsorted. Persists across refetches — deliberately no reset on data change.
  const [sort, setSort] = React.useState<{ key: string; dir: 'asc' | 'desc' } | null>(null)

  // Columns with usable values: a column is sortable when it declares a
  // sortValue extractor or at least one display row has a non-null raw value
  // under its key (keeps 'actions'-style render-only columns inert).
  const sortableKeys = React.useMemo(() => {
    const set = new Set<string>()
    if (!sortable) return set
    for (const c of columns) {
      if (c.sortValue) { set.add(c.key); continue }
      for (const row of filtered) {
        const v = (row as Record<string, unknown>)[c.key]
        if (v !== undefined && v !== null) { set.add(c.key); break }
      }
    }
    return set
  }, [sortable, columns, filtered])

  // Display pipeline: filter (above) → sort (here) → paginate (pageRows
  // below). Sorting is opt-in; without `sortable` (or an active sort) this is
  // `filtered` verbatim. Server mode sorts nothing — `rows` are the API's page
  // slice, so header clicks only reorder the current page.
  const displayRows = React.useMemo(() => {
    if (serverPagination || !sortable || !sort) return filtered
    const col = columns.find((c) => c.key === sort.key)
    if (!col) return filtered
    const dirMul = sort.dir === 'asc' ? 1 : -1
    return filtered
      .map((row, i) => ({ row, i, v: columnValue(row, col) }))
      .sort((a, b) => {
        const aEmpty = a.v === undefined || a.v === null
        const bEmpty = b.v === undefined || b.v === null
        if (aEmpty !== bEmpty) return aEmpty ? 1 : -1 // empties always last, asc + desc
        const c = compareSortValues(a.v, b.v)
        return c !== 0 ? dirMul * c : a.i - b.i // stable ties keep the filtered order
      })
      .map((x) => x.row)
  }, [filtered, columns, sortable, sort, serverPagination])

  // Deep-link: page-jump to + scroll the highlighted row into view. Rows may
  // arrive async (table can be loading when the highlight first applies), so
  // attempts are retried across a few ticks; state kept in a ref keyed by the
  // highlight id makes each jump a strict one-shot that never fights the
  // user's own paging/filtering afterwards.
  const jumpStateRef = React.useRef<{ id: string | null; jumped: boolean; scrolled: boolean }>({ id: null, jumped: false, scrolled: false })

  // Latest serverPagination config, readable inside effects below without
  // re-triggering them on every render (the object is recreated per render).
  // Synced in a bare effect (runs after every render, before the consumers
  // declared after it) so effects always read the freshest config.
  const serverPaginationRef = React.useRef(serverPagination)
  React.useEffect(() => {
    serverPaginationRef.current = serverPagination
  })

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
        const idx = displayRows.findIndex((r) => String(r.id) === highlightId)
        if (idx === -1) return // not in filtered yet (rows still loading) or filtered out by the text filter — do nothing
        st.jumped = true
        const sp = serverPaginationRef.current
        if (sp) sp.onPageChange(Math.floor(idx / sp.pageSize))
        else setPage(Math.floor(idx / pageSize))
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
  }, [highlightId, displayRows, pageSize])

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

  // ---- Server-side search (serverPagination.onSearchChange) ----
  // The search input still owns the local `q` (saved views + presets keep
  // working visually); when an onSearchChange callback is wired, q is pushed
  // to the module debounced by 300ms. The very first run after mount is
  // skipped, and values already sent are suppressed — so programmatic setQ
  // (views/presets) to the same text never triggers a redundant refetch.
  const onSearchChangeRef = React.useRef(serverPagination?.onSearchChange)
  React.useEffect(() => {
    onSearchChangeRef.current = serverPagination?.onSearchChange
  })
  const serverSearchArmedRef = React.useRef(false)
  const serverSearchLastSentRef = React.useRef<string | null>(null)

  React.useEffect(() => {
    const cb = onSearchChangeRef.current
    if (!cb) return
    if (!serverSearchArmedRef.current) {
      serverSearchArmedRef.current = true
      serverSearchLastSentRef.current = q
      return
    }
    if (q === serverSearchLastSentRef.current) return
    const timer = setTimeout(() => {
      serverSearchLastSentRef.current = q
      cb(q)
    }, 300)
    return () => clearTimeout(timer) // re-armed per q change; cleared on unmount
  }, [q])

  const totalPages = serverPagination
    ? Math.max(1, Math.ceil(serverPagination.total / serverPagination.pageSize))
    : Math.max(1, Math.ceil(filtered.length / pageSize))
  const pageRows = serverPagination ? displayRows : displayRows.slice(page * pageSize, page * pageSize + pageSize)
  const pagerPage = serverPagination ? serverPagination.page : page
  const pagerPageSize = serverPagination ? serverPagination.pageSize : pageSize
  const pagerTotal = serverPagination ? serverPagination.total : filtered.length
  const gotoPage = (p: number) => {
    if (serverPagination) serverPagination.onPageChange(p)
    else setPage(p)
  }

  // ---- Totals footer (per-column opt-in via Column.sum) ----
  // Sums all client-side filtered rows (pre-pagination); server mode sums only
  // the current page rows (the API owns the full set). Rendered only when at
  // least one column opts in and there is something to sum.
  const sumRows = serverPagination ? pageRows : displayRows
  const hasSum = columns.some((c) => c.sum)
  const totals = React.useMemo(() => {
    if (!hasSum) return null
    const map = new Map<string, number | null>()
    for (const c of columns) {
      if (!c.sum) continue
      let total = 0
      let any = false
      for (const row of sumRows) {
        const v = columnValue(row, c)
        if (typeof v === 'number' && Number.isFinite(v)) { total += v; any = true }
      }
      map.set(c.key, any ? total : null) // null → nothing summable, footer renders '—'
    }
    return map
  }, [hasSum, columns, sumRows])
  const showFooter = hasSum && !loading && sumRows.length > 0

  return (
    <div className="space-y-3">
      {(searchPlaceholder || csvExport || xlsxExport || savedViewsKey) && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          {searchPlaceholder ? (
            <div className="relative max-w-xs flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" aria-hidden="true" />
              <Input
                value={q}
                onChange={(e) => { setQ(e.target.value); setAppliedView(null) }}
                placeholder={searchPlaceholder}
                aria-label={searchPlaceholder}
                type="search"
                className="h-9 pl-8 pr-8"
              />
              {q && (
                <button
                  type="button"
                  onClick={() => { setQ(''); setAppliedView(null) }}
                  className="absolute right-1.5 top-1.5 grid h-6 w-6 cursor-pointer place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  aria-label="Clear search box"
                >
                  <X className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              )}
            </div>
          ) : <div />}
          <div className="flex items-center gap-2 shrink-0">
            {csvExport && rows.length > 0 && (
              <Button
                variant="outline"
                size="sm"
                className="h-9"
                onClick={() => downloadCsv(csvExport.filename, csvExport.headers ?? columns.map((c) => c.header), filtered.map(csvExport.pick))}
              >
                <Download className="mr-1.5 h-4 w-4" aria-hidden="true" />CSV
              </Button>
            )}
            {xlsxExport && rows.length > 0 && (
              <Button
                variant="outline"
                size="sm"
                className="h-9"
                onClick={() => downloadXlsx(xlsxExport.filename, xlsxExport.headers ?? columns.map((c) => c.header), filtered.map(xlsxExport.pick))}
              >
                <FileSpreadsheet className="mr-1.5 h-4 w-4 text-success" aria-hidden="true" />Excel
              </Button>
            )}
            {savedViewsKey && (
              <div className="flex items-center gap-1.5">
                {appliedView && (
                  <span
                    className="inline-flex max-w-40 items-center gap-1 rounded-full bg-warning-soft px-2 py-0.5 text-[11px] font-medium text-warning ring-1 ring-inset ring-warning-border"
                    title={`Applied view: ${appliedView}`}
                  >
                    <span className="truncate">{appliedView}</span>
                    <button
                      type="button"
                      title="Clear applied view"
                      className="cursor-pointer rounded-full p-0.5 hover:bg-warning-border/60" aria-label="Clear applied view"
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
                            className="mt-0.5 cursor-pointer rounded p-1 text-muted-foreground transition-colors hover:bg-danger-soft hover:text-destructive"
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
      <div
        ref={wrapperRef}
        className="overflow-hidden rounded-xl border bg-card elev-1"
        aria-busy={loading || undefined}
        role="region"
        aria-label={searchPlaceholder ? `${searchPlaceholder} table` : 'Records table'}
      >
        <ScrollArea className={maxHeight !== 'auto' ? maxHeight : undefined} style={maxHeight !== 'auto' ? { height: maxHeight } : undefined}>
          <Table>
            <TableHeader className="erp-table-head">
              <TableRow className="bg-transparent hover:bg-transparent">
                {columns.map((c) => {
                  const canSort = !!sortable && sortableKeys.has(c.key)
                  const sortedDir = sort && sort.key === c.key ? sort.dir : null
                  return (
                    <TableHead
                      key={c.key}
                      aria-sort={sortedDir === 'asc' ? 'ascending' : sortedDir === 'desc' ? 'descending' : undefined}
                      className={cn('font-medium whitespace-nowrap', c.hideOnMobile && 'hidden md:table-cell', c.className)}
                    >
                      {canSort ? (
                        <button
                          type="button"
                          className="inline-flex cursor-pointer select-none items-center rounded transition-colors hover:text-foreground"
                          onClick={() => setSort((cur) => (cur && cur.key === c.key ? (cur.dir === 'asc' ? { key: c.key, dir: 'desc' } : null) : { key: c.key, dir: 'asc' }))}
                        >
                          {c.header}
                          {sortedDir === 'asc' && <ChevronUp className="h-3 w-3 ml-1 text-muted-foreground" />}
                          {sortedDir === 'desc' && <ChevronDown className="h-3 w-3 ml-1 text-muted-foreground" />}
                        </button>
                      ) : c.header}
                    </TableHead>
                  )
                })}
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
                  <TableCell colSpan={columns.length} className="h-44 text-center">
                    <div className="flex flex-col items-center gap-2 text-muted-foreground">
                      <div className="grid h-11 w-11 place-items-center rounded-full bg-muted">
                        <Inbox className="h-5 w-5" aria-hidden="true" />
                      </div>
                      <p className="text-sm font-medium text-foreground">
                        {q.trim() ? `No matches for “${q.trim()}”` : emptyText}
                      </p>
                      <p className="text-xs">
                        {q.trim() ? 'Try a shorter search, or clear it to see everything.' : 'New records appear here as soon as they are saved.'}
                      </p>
                      {q.trim() && (
                        <Button variant="outline" size="sm" className="mt-1" onClick={() => { setQ(''); setAppliedView(null) }}>
                          Clear search
                        </Button>
                      )}
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
                      tabIndex={onRowClick ? 0 : undefined}
                      onKeyDown={onRowClick ? (e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          onRowClick(row)
                        }
                      } : undefined}
                      className={cn(
                        'erp-row-hover transition-colors duration-150',
                        onRowClick && 'cursor-pointer focus-visible:-outline-offset-2 focus-visible:outline-2 focus-visible:outline-ring',
                        highlighted && 'bg-warning-soft ring-2 ring-inset ring-warning-border',
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
            {showFooter && totals && (
              <TableFooter>
                <TableRow>
                  {columns.map((c, ci) => {
                    const total = c.sum ? (totals.get(c.key) ?? null) : null
                    return (
                      <TableCell key={c.key} className={cn(c.hideOnMobile && 'hidden md:table-cell', c.className)}>
                        {ci === 0 && (
                          <span className={cn('text-muted-foreground', c.sum ? 'block text-[11px] uppercase tracking-wide' : 'text-xs font-medium')}>
                            Total ({sumRows.length})
                          </span>
                        )}
                        {c.sum && (
                          <span className="whitespace-nowrap font-semibold tabular">
                            {total === null ? '—' : c.sumFormat === 'money' ? fmtMoney(total) : fmtNum(total)}
                          </span>
                        )}
                      </TableCell>
                    )
                  })}
                </TableRow>
              </TableFooter>
            )}
          </Table>
        </ScrollArea>
      </div>
      {pagerTotal > pagerPageSize && (
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
          <span className="tabular" aria-live="polite">
            Showing {pagerPage * pagerPageSize + 1}–{Math.min((pagerPage + 1) * pagerPageSize, pagerTotal)} of {pagerTotal}
          </span>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={pagerPage === 0} onClick={() => gotoPage(pagerPage - 1)}>Prev</Button>
            <Button variant="outline" size="sm" disabled={pagerPage >= totalPages - 1} onClick={() => gotoPage(pagerPage + 1)}>Next</Button>
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

export function FormDialog({ open, onOpenChange, title, description, children, onSubmit, submitLabel = 'Save', loading, wide, error }: {
  open: boolean
  onOpenChange: (o: boolean) => void
  title: string
  description?: string
  children: React.ReactNode
  onSubmit: () => void | Promise<void>
  submitLabel?: string
  loading?: boolean
  wide?: boolean
  /**
   * Form-level error (usually the API message). Rendered as a focusable alert at the top of the
   * form and focused when it appears, so a screen-reader user hears why the save failed without
   * hunting for red text — and keyboard users land on it in the tab order.
   */
  error?: string | null
}) {
  const errorRef = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    if (error) errorRef.current?.focus()
  }, [error])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Phones: full-screen sheet so long forms scroll naturally; desktop: centred dialog */}
      <DialogContent className={cn(
        'max-h-[90vh] overflow-y-auto max-sm:h-[100dvh] max-sm:max-h-[100dvh] max-sm:max-w-full max-sm:w-full max-sm:rounded-none max-sm:p-4',
        wide ? 'sm:max-w-3xl' : 'sm:max-w-lg',
      )}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        {error && (
          <div
            ref={errorRef}
            role="alert"
            aria-live="assertive"
            tabIndex={-1}
            className="rounded-lg border border-danger-border bg-danger-soft px-3 py-2 text-sm font-medium text-destructive"
          >
            {error}
          </div>
        )}
        <form
          onSubmit={(e) => { e.preventDefault(); void onSubmit() }}
          // Ctrl/⌘ + Enter or Ctrl/⌘ + S saves from anywhere in the form (incl. textareas)
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && (e.key === 'Enter' || e.key.toLowerCase() === 's') && !loading) { e.preventDefault(); void onSubmit() }
          }}
        >
          <div className="grid gap-4 py-2">{children}</div>
          {/* Solid, bordered footer: on long forms the actions stay reachable while the body scrolls,
              and content never shows through the bar. */}
          <DialogFooter className="sticky bottom-0 -mx-6 mt-4 items-center gap-2 border-t bg-popover px-6 py-3">
            <span className="mr-auto hidden text-[11px] text-muted-foreground sm:inline">
              <Kbd>Ctrl</Kbd> <span className="mx-0.5">+</span> <Kbd>S</Kbd> to save
            </span>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={loading} aria-busy={loading || undefined}>
              {loading ? 'Saving…' : submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ---------- Fields ----------

export function Field({ label, children, required, className, hint, error }: {
  label: string
  children: React.ReactNode
  required?: boolean
  className?: string
  hint?: React.ReactNode
  error?: string | null
}) {
  // Persistent help or the validation reason, linked to the control via aria-describedby so
  // assistive tech reads the reason, not just the red ring.
  const uid = React.useId()
  const describedBy = hint || error ? `${uid}-desc` : undefined
  const child = React.isValidElement(children)
    ? React.cloneElement(children as React.ReactElement<{ 'aria-describedby'?: string; 'aria-invalid'?: boolean }>, {
        'aria-describedby': describedBy,
        ...(error ? { 'aria-invalid': true } : {}),
      })
    : children

  return (
    <div className={cn('grid gap-1.5', className)}>
      <Label className="text-xs font-medium text-muted-foreground">
        {label}{required && <span className="text-destructive" aria-hidden="true"> *</span>}
        {required && <span className="sr-only"> (required)</span>}
      </Label>
      {child}
      {(hint || error) && (
        <p id={describedBy} className={cn('text-xs', error ? 'font-medium text-destructive' : 'text-muted-foreground')}>
          {error || hint}
        </p>
      )}
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
  // '' with no '' option = nothing chosen yet: Radix shows the placeholder for a controlled value of ''
  // (mapping it to the sentinel instead would leave the trigger blank)
  const hasEmptyOption = options.some((o) => o.value === '')
  const safeValue = value === '' ? (hasEmptyOption ? EMPTY : '') : (value || undefined)
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
            className={tone === 'destructive' ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90' : ''}
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
    <Card className={cn('gap-0 py-4 elev-1', className)}>
      {(title || actions) && (
        <CardHeader className="gap-1 pb-3">
          <div className="flex items-center justify-between gap-2">
            {title && (
              <CardTitle className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
                {title}
              </CardTitle>
            )}
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
  // The document shell (and the <title>, which can carry a party name) is escaped in printDocument();
  // `html` is caller-built markup whose values the caller escapes.
  w.document.write(printDocument(title, html))
  w.document.close()
}

export function PrintButton({ onClick, label = 'Print' }: { onClick: () => void; label?: string }) {
  return (
    <Button variant="outline" size="sm" onClick={onClick}>
      <Printer className="h-4 w-4 mr-1.5" />{label}
    </Button>
  )
}

// ============ Create presets (shortcuts that open another module's form, pre-filled) ============

const CREATE_PRESET_KEY = 'erp_create_preset'
const CREATE_PRESET_EVENT = 'erp:create-preset'
/** Fired by the `n` keyboard shortcut: the module on screen opens its create form. */
export const NEW_DOC_EVENT = 'erp:new-document'
export type CreatePreset = Record<string, string | number | undefined>

/**
 * Jump to `moduleKey` and open its create form, pre-filled with `data`
 * (e.g. openCreate('sales-invoices', { soId }) or openCreate('payments', { type: 'RECEIPT', partyId })).
 */
export function openCreate(moduleKey: string, data: CreatePreset = {}) {
  try {
    sessionStorage.setItem(CREATE_PRESET_KEY, JSON.stringify({ module: moduleKey, data, ts: Date.now() }))
  } catch { /* private mode — the live event still covers an already-mounted module */ }
  window.dispatchEvent(new CustomEvent(CREATE_PRESET_EVENT, { detail: { module: moduleKey, data } }))
  window.dispatchEvent(new CustomEvent('erp:goto', { detail: moduleKey }))
}

/** In a module: run `apply(data)` when a shortcut asked to open this module's create form. */
export function useCreatePreset(moduleKey: string, apply: (data: CreatePreset) => void) {
  const applyRef = React.useRef(apply)
  React.useEffect(() => { applyRef.current = apply })
  React.useEffect(() => {
    const consume = () => {
      try {
        const raw = sessionStorage.getItem(CREATE_PRESET_KEY)
        if (!raw) return
        const p = JSON.parse(raw) as { module?: string; data?: CreatePreset; ts?: number }
        if (p.module !== moduleKey || !p.ts || Date.now() - p.ts > 60000) return
        sessionStorage.removeItem(CREATE_PRESET_KEY)
        applyRef.current(p.data || {})
      } catch { /* ignore malformed */ }
    }
    consume() // module mounted by the navigation
    const onEvent = (e: Event) => {
      if ((e as CustomEvent<{ module?: string }>).detail?.module === moduleKey) setTimeout(consume, 0) // already mounted
    }
    // `n` shortcut: only the module on screen is mounted, so it alone opens its blank form
    const onNew = () => applyRef.current({})
    window.addEventListener(CREATE_PRESET_EVENT, onEvent)
    window.addEventListener(NEW_DOC_EVENT, onNew)
    return () => {
      window.removeEventListener(CREATE_PRESET_EVENT, onEvent)
      window.removeEventListener(NEW_DOC_EVENT, onNew)
    }
  }, [moduleKey])
}
