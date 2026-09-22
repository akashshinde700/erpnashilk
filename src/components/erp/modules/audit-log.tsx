'use client'

import * as React from 'react'
import { RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Column, DataTable, PageHeader, SelectInput, StatusBadge } from '@/components/erp/kit'
import { fmtDateTime } from '@/lib/erp-constants'
import { useList } from '@/lib/use-api'

interface AuditRow {
  id: string
  userName?: string | null
  action: string
  entity: string
  entityId?: string | null
  details?: string | null
  createdAt: string
}

const ACTION_FILTERS = ['ALL', 'CREATE', 'UPDATE', 'DELETE', 'APPROVE', 'POST', 'CONFIG', 'CANCEL'].map((a) => ({
  value: a,
  label: a === 'ALL' ? 'All actions' : a,
}))

export default function AuditLogModule({ companyId }: { companyId: string }) {
  const { data, loading, refetch, error } = useList<{ items?: AuditRow[] }>(
    `/api/audit-logs?companyId=${companyId}&limit=200`,
  )
  const [action, setAction] = React.useState('ALL')

  const rows = (data?.items ?? []).filter((r) => action === 'ALL' || r.action === action)

  const columns: Column<AuditRow>[] = [
    { key: 'createdAt', header: 'Time', render: (r) => <span className="whitespace-nowrap text-muted-foreground">{fmtDateTime(r.createdAt)}</span> },
    { key: 'userName', header: 'User', render: (r) => <span className="font-medium">{r.userName || 'system'}</span> },
    { key: 'action', header: 'Action', render: (r) => <StatusBadge status={r.action} /> },
    { key: 'entity', header: 'Entity', render: (r) => <span className="font-mono text-xs">{r.entity}</span> },
    { key: 'entityId', header: 'Entity ID', hideOnMobile: true, render: (r) => <span className="font-mono text-[11px] text-muted-foreground">{r.entityId || '—'}</span> },
    {
      key: 'details',
      header: 'Details',
      render: (r) => (
        <span className="block max-w-[320px] truncate text-muted-foreground" title={r.details || undefined}>
          {r.details || '—'}
        </span>
      ),
    },
  ]

  return (
    <div>
      <PageHeader
        title="Audit Log"
        description="Every important action, tenant-scoped (latest 200)"
        actions={
          <>
            <div className="w-40">
              <SelectInput value={action} onChange={setAction} options={ACTION_FILTERS} />
            </div>
            <Button variant="outline" size="sm" onClick={() => void refetch()} disabled={loading}>
              <RefreshCw className={`h-4 w-4 mr-1.5 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
          </>
        }
      />
      {error && (
        <p className="mb-3 rounded-lg border border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950 px-3 py-2 text-sm text-red-700 dark:text-red-300">
          {error}
        </p>
      )}
      <DataTable
        columns={columns}
        rows={rows}
        loading={loading}
        searchPlaceholder="Search audit trail…"
        emptyText="No audit entries yet"
        pageSize={15}
        csvExport={{
          filename: 'audit-log',
          pick: (r) => [new Date(r.createdAt).toISOString(), r.userName || '', r.action, r.entity, r.entityId || '', r.details || ''],
        }}
        xlsxExport={{
          filename: 'audit-log',
          pick: (r) => [new Date(r.createdAt).toISOString(), r.userName || '', r.action, r.entity, r.entityId || '', r.details || ''],
        }}
      />
    </div>
  )
}
