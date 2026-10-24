'use client'

import * as React from 'react'
import { ChevronRight, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { fmtDateTime } from '@/lib/erp-constants'
import { IMPORT_DATA_TYPES, IMPORT_HISTORY_ENTITY } from '@/lib/import/fields'
import { useList } from '@/lib/use-api'
import { cn } from '@/lib/utils'

const ENTITY_LABEL: Record<string, string> = Object.fromEntries(
  Object.entries(IMPORT_HISTORY_ENTITY).map(([k, e]) => [e, IMPORT_DATA_TYPES.find((d) => d.key === k)?.label ?? k]),
)

interface HistoryRow { id: string; createdAt: string; userName?: string | null; entity: string; details?: string | null }

/** Import history: the company's IMPORT audit entries (summary line + first row errors). */
export default function ImportHistory({ companyId }: { companyId: string }) {
  const [page, setPage] = React.useState(1)
  const { data, loading, refetch } = useList<{ items: HistoryRow[]; total: number }>(`/api/import-center/history?companyId=${companyId}&page=${page}`)
  const [open, setOpen] = React.useState<string | null>(null)
  const items = data?.items ?? []
  const total = data?.total ?? 0

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">Imports into this company, newest first (also shown in the Audit Log).</p>
        <Button size="sm" variant="outline" onClick={() => void refetch()} disabled={loading}>
          <RefreshCw className={cn('h-4 w-4 mr-1.5', loading && 'animate-spin')} /> Refresh
        </Button>
      </div>
      <div className="rounded-lg border overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/50 hover:bg-muted/50">
              <TableHead className="w-8" />
              <TableHead>Time</TableHead>
              <TableHead>User</TableHead>
              <TableHead>Data</TableHead>
              <TableHead>Summary</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.length === 0 ? (
              <TableRow><TableCell colSpan={5} className="h-16 text-center text-muted-foreground">{loading ? 'Loading…' : 'No imports yet'}</TableCell></TableRow>
            ) : items.map((r) => {
              const [summary, ...errors] = (r.details || '').split('\n')
              const isOpen = open === r.id
              return (
                <React.Fragment key={r.id}>
                  <TableRow className={cn(errors.length && 'cursor-pointer')} onClick={() => errors.length && setOpen(isOpen ? null : r.id)}>
                    <TableCell>{errors.length > 0 && <ChevronRight className={cn('h-4 w-4 transition-transform', isOpen && 'rotate-90')} />}</TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">{fmtDateTime(r.createdAt)}</TableCell>
                    <TableCell>{r.userName || 'system'}</TableCell>
                    <TableCell>{ENTITY_LABEL[r.entity] ?? r.entity}</TableCell>
                    <TableCell className="text-sm">{summary || '—'}{errors.length > 0 && <span className="ml-1 text-xs text-muted-foreground">({errors.length} row note{errors.length === 1 ? '' : 's'})</span>}</TableCell>
                  </TableRow>
                  {isOpen && (
                    <TableRow className="bg-muted/30 hover:bg-muted/30">
                      <TableCell />
                      <TableCell colSpan={4}><ul className="space-y-0.5 text-xs">{errors.map((e, i) => <li key={i}>{e}</li>)}</ul></TableCell>
                    </TableRow>
                  )}
                </React.Fragment>
              )
            })}
          </TableBody>
        </Table>
      </div>
      {total > 50 && (
        <div className="flex items-center justify-end gap-2 text-sm">
          <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</Button>
          <span className="text-muted-foreground">Page {page} of {Math.ceil(total / 50)}</span>
          <Button size="sm" variant="outline" disabled={page * 50 >= total} onClick={() => setPage((p) => p + 1)}>Next</Button>
        </div>
      )}
    </div>
  )
}
