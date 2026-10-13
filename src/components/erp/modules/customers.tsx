'use client'

import * as React from 'react'
import { Eye, Pencil, Plus, Trash2, Upload } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { apiDelete, useList } from '@/lib/use-api'
import { PartyViewDialog } from '@/components/erp/party-view'
import { isBothParty, PartyFormDialog, PARTY_TAB_EVENT, type PartyRecord, type SavedKind } from '@/components/erp/party-form'
import ImportDialog from '@/components/erp/import-dialog'
import {
  ConfirmAction,
  DataTable,
  Money,
  PageHeader,
  StatusBadge,
  useRowHighlight,
} from '@/components/erp/kit'
import type { Column } from '@/components/erp/kit'

// ---------- API shapes ----------

type CustomerRow = PartyRecord

interface CustomersResponse {
  items: CustomerRow[]
  total?: number
}

export default function CustomersModule({ companyId }: { companyId: string }) {
  const highlightId = useRowHighlight('customers')
  // Server-side pagination: the API filters + slices, so page/serverQ drive the url.
  const [page, setPage] = React.useState(0)
  const [serverQ, setServerQ] = React.useState('')
  const { data, loading, refetch } = useList<CustomersResponse>(
    `/api/customers?companyId=${companyId}&page=${page + 1}&pageSize=200${serverQ ? `&q=${encodeURIComponent(serverQ)}` : ''}`,
  )
  const rows = data?.items ?? []

  const [open, setOpen] = React.useState(false)
  const [importOpen, setImportOpen] = React.useState(false)
  const [editing, setEditing] = React.useState<CustomerRow | null>(null)
  const [viewing, setViewing] = React.useState<CustomerRow | null>(null)

  function openCreate() {
    setEditing(null)
    setOpen(true)
  }

  function openEdit(row: CustomerRow) {
    setEditing(row)
    setOpen(true)
  }

  // Saved under the other type → show it there; otherwise refresh this list.
  function onSaved(saved: SavedKind) {
    if (saved === 'customer' || saved === 'both') void refetch()
    else window.dispatchEvent(new CustomEvent(PARTY_TAB_EVENT, { detail: 'suppliers' }))
  }

  async function remove(row: CustomerRow) {
    try {
      await apiDelete(`/api/customers/${row.id}?companyId=${companyId}`)
      toast.success('Deleted')
      await refetch()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to delete customer')
    }
  }

  const columns: Column<CustomerRow>[] = [
    { key: 'code', header: 'Code', render: (r) => <span className="font-medium">{r.code}</span> },
    {
      key: 'name',
      header: 'Name',
      render: (r) => (
        <span className="flex max-w-56 items-center gap-1.5">
          <span className="truncate">{r.name}</span>
          {isBothParty(r) && <span className="shrink-0 rounded bg-violet-100 px-1.5 py-0.5 text-[10px] font-medium text-violet-700 dark:bg-violet-950 dark:text-violet-300" title="Also a supplier">Both</span>}
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
    { key: 'credit', header: 'Credit Limit', render: (r) => <Money value={r.creditLimit} /> },
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
            title="Delete customer"
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
        title="Customers"
        description="Customer master with GST and credit terms"
        actions={
          <>
            <Button size="sm" variant="outline" onClick={() => setImportOpen(true)}>
              <Upload className="h-4 w-4 mr-1.5" /> Import CSV
            </Button>
            <Button size="sm" onClick={openCreate}>
              <Plus className="h-4 w-4 mr-1.5" /> Customer
            </Button>
          </>
        }
      />

      <DataTable
        columns={columns}
        onRowClick={(r) => setViewing(r)}
        rows={rows}
        loading={loading}
        highlightId={highlightId}
        moduleKey="customers"
        savedViewsKey={`${companyId}:customers`}
        searchPlaceholder="Search customers…"
        emptyText="No customers yet"
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
          filename: 'customers',
          pick: (r) => [r.code, r.name, r.gstin || '', r.contactPerson || '', r.phone || '', r.email || '', r.city || '', r.state || '', r.paymentTermsDays ?? 0, r.creditLimit ?? 0, r.status],
        }}
        xlsxExport={{
          filename: 'customers',
          pick: (r) => [r.code, r.name, r.gstin || '', r.contactPerson || '', r.phone || '', r.email || '', r.city || '', r.state || '', r.paymentTermsDays ?? 0, r.creditLimit ?? 0, r.status],
        }}
      />

      <PartyViewDialog
        open={!!viewing}
        onOpenChange={(o) => { if (!o) setViewing(null) }}
        kind="customer"
        id={viewing?.id ?? null}
        onEdit={() => { if (viewing) openEdit(viewing) }}
      />

      <PartyFormDialog
        open={open}
        onOpenChange={setOpen}
        kind="customer"
        editing={editing}
        companyId={companyId}
        onSaved={onSaved}
      />

      <ImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        companyId={companyId}
        apiPath="/api/customers/import"
        entityLabel="customers"
        templateHeaders={['name', 'gstin', 'city', 'state', 'stateCode', 'phone', 'email', 'addressLine']}
        templateSample={[
          ['Precision Tools Pvt Ltd', '27ABCDE1234F1Z5', 'Pune', 'Maharashtra', '27', '9876543210', 'sales@precisiontools.in', 'Plot 14, MIDC Bhosari'],
          ['Vadodara Bearings', '', 'Vadodara', 'Gujarat', '24', '', 'orders@vdbearings.com', 'GIDC Makarpura'],
        ]}
        onImported={() => void refetch()}
      />
    </div>
  )
}
