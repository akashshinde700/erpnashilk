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
import { cn } from '@/lib/utils'
import { fmtDate, fmtMoney, fmtNum, tone } from '@/lib/erp-constants'
import { Inbox, Search, Printer } from 'lucide-react'

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

// ---------- Generic data table ----------

export interface Column<T> {
  key: string
  header: string
  render: (row: T) => React.ReactNode
  className?: string
  hideOnMobile?: boolean
}

export function DataTable<T extends { id: string }>({
  columns, rows, loading, emptyText = 'No records yet', searchPlaceholder, onRowClick, maxHeight = 'auto', pageSize = 12,
}: {
  columns: Column<T>[]
  rows: T[]
  loading?: boolean
  emptyText?: string
  searchPlaceholder?: string
  onRowClick?: (row: T) => void
  maxHeight?: string
  pageSize?: number
}) {
  const [q, setQ] = React.useState('')
  const [page, setPage] = React.useState(0)

  const filtered = React.useMemo(() => {
    if (!q.trim()) return rows
    const needle = q.toLowerCase()
    return rows.filter((r) => JSON.stringify(r).toLowerCase().includes(needle))
  }, [rows, q])

  React.useEffect(() => setPage(0), [q, rows.length])

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize))
  const pageRows = filtered.slice(page * pageSize, page * pageSize + pageSize)

  return (
    <div className="space-y-3">
      {searchPlaceholder && (
        <div className="relative max-w-xs">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={searchPlaceholder} className="pl-8 h-9" />
        </div>
      )}
      <div className="rounded-lg border overflow-hidden bg-card">
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
                pageRows.map((row) => (
                  <TableRow key={row.id} onClick={() => onRowClick?.(row)} className={onRowClick ? 'cursor-pointer' : undefined}>
                    {columns.map((c) => (
                      <TableCell key={c.key} className={cn('align-middle', c.hideOnMobile && 'hidden md:table-cell', c.className)}>{c.render(row)}</TableCell>
                    ))}
                  </TableRow>
                ))
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
