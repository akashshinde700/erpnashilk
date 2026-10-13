'use client'

import * as React from 'react'
import { Eye, Pencil, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { apiDelete, useList } from '@/lib/use-api'
import { PartyViewDialog } from '@/components/erp/party-view'
import { isBothParty, PartyFormDialog, PARTY_TAB_EVENT, type PartyRecord, type SavedKind } from '@/components/erp/party-form'
import {
  ConfirmAction,
  DataTable,
  PageHeader,
  StatusBadge,
  useRowHighlight,
} from '@/components/erp/kit'
import type { Column } from '@/components/erp/kit'

// ---------- API shapes ----------

type SupplierRow = PartyRecord

interface SuppliersResponse {
  items: SupplierRow[]
  total?: number
}

export default function SuppliersModule({ companyId }: { companyId: string }) {
  const highlightId = useRowHighlight('suppliers')
  // Server-side pagination: the API filters + slices, so page/serverQ drive the url.
  const [page, setPage] = React.useState(0)
  const [serverQ, setServerQ] = React.useState('')
  const { data, loading, refetch } = useList<SuppliersResponse>(
    `/api/suppliers?companyId=${companyId}&page=${page + 1}&pageSize=200${serverQ ? `&q=${encodeURIComponent(serverQ)}` : ''}`,
  )
  const rows = data?.items ?? []

  const [open, setOpen] = React.useState(false)
  const [editing, setEditing] = React.useState<SupplierRow | null>(null)
  const [viewing, setViewing] = React.useState<SupplierRow | null>(null)

  function openCreate() {
    setEditing(null)
    setOpen(true)
  }

  function openEdit(row: SupplierRow) {
    setEditing(row)
    setOpen(true)
  }

  // Saved under the other type → show it there; otherwise refresh this list.
  function onSaved(saved: SavedKind) {
    if (saved === 'supplier' || saved === 'both') void refetch()
    else window.dispatchEvent(new CustomEvent(PARTY_TAB_EVENT, { detail: 'customers' }))
  }

  async function remove(row: SupplierRow) {
    try {
      await apiDelete(`/api/suppliers/${row.id}?companyId=${companyId}`)
      toast.success('Deleted')
      await refetch()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to delete supplier')
    }
  }

  const columns: Column<SupplierRow>[] = [
    { key: 'code', header: 'Code', render: (r) => <span className="font-medium">{r.code}</span> },
    {
      key: 'name',
      header: 'Name',
      render: (r) => (
        <span className="flex max-w-56 items-center gap-1.5">
          <span className="truncate">{r.name}</span>
          {isBothParty(r) && <span className="shrink-0 rounded bg-violet-100 px-1.5 py-0.5 text-[10px] font-medium text-violet-700 dark:bg-violet-950 dark:text-violet-300" title="Also a customer">Both</span>}
        </span>
      ),
    },
    { key: 'city', header: 'City', render: (r) => <span>{r.city || '—'}</span> },
    { key: 'state', header: 'State', hideOnMobile: true, render: (r) => <span>{r.state || '—'}</span> },
    {
      key: 'gstin',
      header: 'GSTIN',
      hideOnMobile: true,
      render: (r) => <span className="font-mono text-xs">{r.gstin || '—'}</span>,
    },
    { key: 'phone', header: 'Phone', hideOnMobile: true, render: (r) => <span>{r.phone || '—'}</span> },
    {
      key: 'terms',
      header: 'Terms (days)',
      render: (r) => <span className="tabular-nums">{r.paymentTermsDays ?? 0}</span>,
    },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
    {
      key: 'actions',
      header: '',
      className: 'text-right',
      render: (r) => (
        <div className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={(e) => { e.stopPropagation(); setViewing(r) }} title="History, dues & documents">
            <Eye className="h-3.5 w-3.5" />
          </Button>
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={(e) => { e.stopPropagation(); openEdit(r) }} title="Edit">
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <ConfirmAction
            trigger={
              <Button variant="ghost" size="icon" className="h-8 w-8 text-red-600 hover:text-red-700" title="Delete">
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            }
            title="Delete supplier"
            message={`Delete ${r.code} — ${r.name}? This cannot be undone.`}
            tone="destructive"
            onConfirm={() => remove(r)}
          />
        </div>
      ),
    },
  ]

  return (
    <div>
      <PageHeader
        title="Suppliers"
        description="Supplier and vendor master"
        actions={
          <Button size="sm" onClick={openCreate}>
            <Plus className="h-4 w-4 mr-1.5" /> Supplier
          </Button>
        }
      />

      <DataTable
        columns={columns}
        onRowClick={(r) => setViewing(r)}
        rows={rows}
        loading={loading}
        highlightId={highlightId}
        moduleKey="suppliers"
        savedViewsKey={`${companyId}:suppliers`}
        searchPlaceholder="Search suppliers…"
        emptyText="No suppliers yet"
        serverPagination={{
          page,
          pageSize: 200,
          total: data?.total ?? rows.length,
          onPageChange: setPage,
          onSearchChange: (s) => {
            setServerQ(s)
            setPage(0)
          },
        }}
        csvExport={{
          filename: 'suppliers',
          pick: (r) => [r.code, r.name, r.gstin || '', r.contactPerson || '', r.phone || '', r.email || '', r.city || '', r.state || '', r.paymentTermsDays ?? 0, r.status],
        }}
        xlsxExport={{
          filename: 'suppliers',
          pick: (r) => [r.code, r.name, r.gstin || '', r.contactPerson || '', r.phone || '', r.email || '', r.city || '', r.state || '', r.paymentTermsDays ?? 0, r.status],
        }}
      />

      <PartyViewDialog
        open={!!viewing}
        onOpenChange={(o) => { if (!o) setViewing(null) }}
        kind="supplier"
        id={viewing?.id ?? null}
        onEdit={() => { if (viewing) openEdit(viewing) }}
      />

      <PartyFormDialog
        open={open}
        onOpenChange={setOpen}
        kind="supplier"
        editing={editing}
        companyId={companyId}
        onSaved={onSaved}
      />
    </div>
  )
}
