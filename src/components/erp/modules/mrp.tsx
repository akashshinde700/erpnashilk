'use client'

import * as React from 'react'
import { toast } from 'sonner'
import { BrainCircuit, ShoppingCart, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import {
  Field, FormDialog, PageHeader, SelectInput, StatCard, TextInput,
} from '@/components/erp/kit'
import { apiPost, useList } from '@/lib/use-api'
import { fmtDateTime, fmtNum, ITEM_TYPE_LABEL } from '@/lib/erp-constants'

const todayISO = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const plusDays = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10)

// ---------- types ----------
interface MrpRow {
  itemId: string
  required?: number; requiredFromOpenSOs?: number
  onHand?: number; incoming?: number; shortage?: number
  suggestedQty?: number; belowReorder?: boolean; reorderLevel?: number
  item?: { code?: string; name?: string; type?: string } | null
}
interface MrpResult { generatedAt?: string; rows?: MrpRow[]; items?: MrpRow[] }

export default function MrpModule({ companyId }: { companyId: string }) {
  const [mrpUrl, setMrpUrl] = React.useState<string | null>(null)
  const mrp = useList<MrpResult>(mrpUrl)

  const rows = React.useMemo<MrpRow[]>(
    () => (mrp.data ? (mrp.data.rows || mrp.data.items || []) : []),
    [mrp.data],
  )

  // ---- selection (keyed by itemId) ----
  const [selected, setSelected] = React.useState<Set<string>>(new Set())

  function toggle(id: string, on: boolean) {
    setSelected((s) => {
      const next = new Set(s)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })
  }

  function toggleAll(on: boolean) {
    setSelected(on ? new Set(rows.map((r) => r.itemId)) : new Set())
  }

  // ---- bulk PR dialog ----
  const [prOpen, setPrOpen] = React.useState(false)
  const [savingPr, setSavingPr] = React.useState(false)
  const [department, setDepartment] = React.useState('Stores')
  const [raisedBy, setRaisedBy] = React.useState('MRP Run')
  const [requiredBy, setRequiredBy] = React.useState(plusDays(7))

  const selectedRows = React.useMemo(() => rows.filter((r) => selected.has(r.itemId)), [rows, selected])

  const stats = React.useMemo(() => ({
    short: rows.filter((r) => (r.shortage ?? 0) > 0).length,
    belowReorder: rows.filter((r) => r.belowReorder).length,
    suggested: rows.reduce((s, r) => s + (r.suggestedQty || 0), 0),
  }), [rows])

  async function createPr() {
    const items = selectedRows
      .map((r) => {
        const sugg = r.suggestedQty || 0
        const qty = Math.max(sugg, r.belowReorder ? (r.reorderLevel || 0) : 0) || sugg
        return { itemId: r.itemId, qty }
      })
      .filter((i) => i.qty > 0)
    if (items.length === 0) { toast.error('Selected rows have no suggested quantity'); return }
    setSavingPr(true)
    try {
      await apiPost('/api/purchase-requisitions', {
        companyId, date: todayISO(), requiredBy, department: department || 'Stores', raisedBy: raisedBy || 'MRP Run', items,
      })
      toast.success(`Purchase requisition created for ${items.length} item(s)`)
      setPrOpen(false); setSelected(new Set())
      void mrp.refetch()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to create purchase requisition')
    } finally { setSavingPr(false) }
  }

  return (
    <div>
      <PageHeader
        title="MRP — Material Requirements Planning"
        description="Net requirements from open sales orders, on-hand stock and incoming POs"
        actions={
          <Button onClick={() => setMrpUrl(`/api/mrp?companyId=${companyId}`)} disabled={mrp.loading}>
            <BrainCircuit className="h-4 w-4 mr-1.5" />{mrp.loading ? 'Running…' : 'Run MRP'}
          </Button>
        }
      />

      {mrp.data?.generatedAt && (
        <p className="text-xs text-muted-foreground mb-3">Last run: {fmtDateTime(mrp.data.generatedAt)}</p>
      )}

      {!mrpUrl ? (
        <div className="rounded-lg border bg-card p-10 text-center">
          <BrainCircuit className="h-10 w-10 mx-auto text-muted-foreground" />
          <p className="mt-3 text-sm font-medium">Run MRP to compute shortages</p>
          <p className="text-xs text-muted-foreground mt-1 max-w-md mx-auto">
            The planner explodes open sales orders, nets them against on-hand stock and incoming purchase orders,
            and suggests what to buy per item.
          </p>
        </div>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-3 mb-4">
            <StatCard title="Items Short" value={stats.short} sub="Shortage > 0" toneClass="bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300" icon={<TriangleAlert className="h-4 w-4" />} />
            <StatCard title="Below Reorder" value={stats.belowReorder} sub="Reached reorder level" toneClass="bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300" />
            <StatCard title="Total Suggested Qty" value={fmtNum(stats.suggested)} sub="Across all suggested rows" toneClass="bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300" icon={<ShoppingCart className="h-4 w-4" />} />
          </div>

          {selected.size > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-muted/40 px-4 py-2.5 mb-3">
              <p className="text-sm">{selected.size} row(s) selected</p>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={() => setSelected(new Set())}>Clear</Button>
                <Button size="sm" onClick={() => setPrOpen(true)}>
                  <ShoppingCart className="h-3.5 w-3.5 mr-1.5" />Create PR for selected ({selected.size})
                </Button>
              </div>
            </div>
          )}

          <div className="rounded-lg border overflow-hidden bg-card">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/50 hover:bg-muted/50">
                  <TableHead className="w-10">
                    <Checkbox
                      checked={rows.length > 0 && selected.size === rows.length}
                      onCheckedChange={(v) => toggleAll(v === true)}
                      aria-label="Select all"
                    />
                  </TableHead>
                  <TableHead>Item</TableHead>
                  <TableHead className="hidden md:table-cell">Type</TableHead>
                  <TableHead className="text-right">Required</TableHead>
                  <TableHead className="text-right">On Hand</TableHead>
                  <TableHead className="text-right hidden md:table-cell">Incoming</TableHead>
                  <TableHead className="text-right">Shortage</TableHead>
                  <TableHead className="text-right">Suggested</TableHead>
                  <TableHead className="hidden md:table-cell">Reorder</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {mrp.loading ? (
                  Array.from({ length: 5 }).map((_, i) => (
                    <TableRow key={`sk-${i}`}>
                      {Array.from({ length: 9 }).map((__, j) => (
                        <TableCell key={j}><Skeleton className="h-4 w-full max-w-20" /></TableCell>
                      ))}
                    </TableRow>
                  ))
                ) : rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={9} className="h-32 text-center text-sm text-muted-foreground">
                      No MRP rows returned — everything is covered or there is no open demand.
                    </TableCell>
                  </TableRow>
                ) : (
                  rows.map((r) => {
                    const required = r.required ?? r.requiredFromOpenSOs ?? 0
                    const shortage = r.shortage ?? 0
                    const isSel = selected.has(r.itemId)
                    return (
                      <TableRow key={r.itemId} className={isSel ? 'bg-muted/30' : undefined}>
                        <TableCell>
                          <Checkbox checked={isSel} onCheckedChange={(v) => toggle(r.itemId, v === true)} aria-label={`Select ${r.item?.code || r.itemId}`} />
                        </TableCell>
                        <TableCell>
                          <p className="truncate">{r.item?.name || r.itemId}</p>
                          <p className="text-xs text-muted-foreground">{r.item?.code}</p>
                        </TableCell>
                        <TableCell className="hidden md:table-cell text-xs text-muted-foreground">
                          {r.item?.type ? (ITEM_TYPE_LABEL[r.item.type] || r.item.type) : '—'}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{fmtNum(required)}</TableCell>
                        <TableCell className="text-right tabular-nums">{fmtNum(r.onHand)}</TableCell>
                        <TableCell className="text-right tabular-nums hidden md:table-cell">{fmtNum(r.incoming)}</TableCell>
                        <TableCell className={`text-right tabular-nums font-bold ${shortage > 0 ? 'text-red-600 dark:text-red-400' : 'text-muted-foreground'}`}>
                          {fmtNum(shortage)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums font-medium">{fmtNum(r.suggestedQty)}</TableCell>
                        <TableCell className="hidden md:table-cell">
                          {r.belowReorder ? (
                            <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:bg-amber-950 dark:text-amber-300">
                              BELOW REORDER
                            </span>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </TableCell>
                      </TableRow>
                    )
                  })
                )}
              </TableBody>
            </Table>
          </div>
          {mrp.error && <p className="text-sm text-red-600 mt-2">{mrp.error}</p>}
        </>
      )}

      {/* ---- Bulk create PR dialog ---- */}
      <FormDialog
        open={prOpen} onOpenChange={setPrOpen} title="Create Purchase Requisition"
        description={`Raises a PR for ${selectedRows.length} selected item(s) using suggested quantities`}
        submitLabel="Create PR" loading={savingPr} onSubmit={createPr}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Department">
            <SelectInput
              value={department} onChange={setDepartment}
              options={[
                { value: 'Stores', label: 'Stores' },
                { value: 'Production', label: 'Production' },
                { value: 'Maintenance', label: 'Maintenance' },
                { value: 'Quality', label: 'Quality' },
                { value: 'General', label: 'General' },
              ]}
            />
          </Field>
          <Field label="Raised By">
            <TextInput value={raisedBy} onChange={(e) => setRaisedBy(e.target.value)} />
          </Field>
          <Field label="Required By">
            <TextInput type="date" value={requiredBy} onChange={(e) => setRequiredBy(e.target.value)} />
          </Field>
          <Field label="PR Date">
            <TextInput value={todayISO()} disabled />
          </Field>
        </div>
        <p className="text-xs text-muted-foreground">
          Quantities use the MRP suggested qty (or reorder level for below-reorder items). Items with zero quantity are skipped.
        </p>
      </FormDialog>
    </div>
  )
}
