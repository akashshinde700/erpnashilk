'use client'

import * as React from 'react'
import { Bell, CheckCheck, RefreshCw, Search, Trash2, Undo2 } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { PageHeader, SectionCard, TextInput } from '@/components/erp/kit'
import { fmtDateTime } from '@/lib/erp-constants'
import { apiDelete, apiPatch, useList } from '@/lib/use-api'
import { cn } from '@/lib/utils'

interface NotificationRow {
  id: string
  title: string
  message?: string | null
  level: string
  read: boolean
  createdAt: string
}

// Mirrors LEVEL_DOT in erp-app.tsx (bell popover)
const LEVEL_DOT: Record<string, string> = {
  INFO: 'bg-sky-500',
  WARNING: 'bg-amber-500',
  CRITICAL: 'bg-red-500',
}

type Filter = 'all' | 'unread' | 'read'
const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'unread', label: 'Unread' },
  { value: 'read', label: 'Read' },
]

const PAGE = 50

function timeAgo(d: string | Date): string {
  const mins = Math.floor((Date.now() - new Date(d).getTime()) / 60000)
  if (mins < 1) return 'Just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return fmtDateTime(d)
}

export default function NotificationsModule({ companyId }: { companyId: string }) {
  // One fetch of the latest window (API take cap 200); tab + search filter client-side
  const { data, loading, refetch } = useList<{ items?: NotificationRow[]; unreadCount?: number }>(
    `/api/notifications?companyId=${companyId}&status=all&take=200`,
  )
  const [filter, setFilter] = React.useState<Filter>('all')
  const [q, setQ] = React.useState('')
  const [visible, setVisible] = React.useState(PAGE)
  const [busyId, setBusyId] = React.useState<string | null>(null)
  const [markingAll, setMarkingAll] = React.useState(false)

  const all = data?.items ?? []
  const unreadCount = data?.unreadCount ?? 0
  const counts: Record<Filter, number> = {
    all: all.length,
    unread: unreadCount,
    read: Math.max(0, all.length - unreadCount),
  }

  const needle = q.trim().toLowerCase()
  const rows = all
    .filter((n) => filter === 'all' || (filter === 'unread' ? !n.read : n.read))
    .filter((n) => !needle || [n.title, n.message].some((v) => !!v && v.toLowerCase().includes(needle)))

  React.useEffect(() => {
    setVisible(PAGE)
  }, [filter, needle])

  async function toggleRead(n: NotificationRow) {
    setBusyId(n.id)
    try {
      await apiPatch(`/api/notifications/${n.id}`, { companyId, read: !n.read })
      toast.success(n.read ? 'Marked as unread' : 'Marked as read')
      await refetch()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to update notification')
    } finally {
      setBusyId(null)
    }
  }

  async function remove(n: NotificationRow) {
    setBusyId(n.id)
    try {
      await apiDelete(`/api/notifications/${n.id}?companyId=${companyId}`)
      toast.success('Notification deleted')
      await refetch()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to delete notification')
    } finally {
      setBusyId(null)
    }
  }

  async function markAllRead() {
    setMarkingAll(true)
    try {
      await apiPatch('/api/notifications', { companyId, all: true })
      toast.success('All notifications marked as read')
      await refetch()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to mark all as read')
    } finally {
      setMarkingAll(false)
    }
  }

  const emptyTitle = filter === 'unread' ? 'No unread notifications 🎉' : filter === 'read' ? 'No read notifications' : 'No notifications yet'
  const emptySub = filter === 'unread'
    ? "You're all caught up."
    : filter === 'read'
      ? 'Mark a notification as read and it will appear here.'
      : 'Alerts from stock, approvals and the system will appear here.'

  return (
    <div>
      <PageHeader
        title="Notifications"
        description="All alerts across your company"
        actions={
          <>
            <div className="relative w-full sm:w-56">
              <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <TextInput
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search notifications…"
                className="h-9 pl-8"
                aria-label="Search notifications"
              />
            </div>
            <div className="inline-flex items-center rounded-lg border bg-background p-0.5" role="tablist" aria-label="Filter notifications">
              {FILTERS.map((f) => (
                <button
                  key={f.value}
                  type="button"
                  role="tab"
                  aria-selected={filter === f.value}
                  onClick={() => setFilter(f.value)}
                  className={cn(
                    'rounded-md px-2.5 py-1.5 text-xs font-medium whitespace-nowrap transition-colors',
                    filter === f.value
                      ? 'bg-primary text-primary-foreground shadow-xs'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {f.label}
                  <span className={cn('ml-1.5 tabular-nums', filter === f.value ? 'opacity-80' : 'opacity-60')}>
                    {counts[f.value]}
                  </span>
                </button>
              ))}
            </div>
            <Button variant="outline" size="sm" onClick={() => void refetch()} disabled={loading}>
              <RefreshCw className={cn('h-4 w-4 mr-1.5', loading && 'animate-spin')} />
              Refresh
            </Button>
            <Button size="sm" onClick={() => void markAllRead()} disabled={markingAll || unreadCount === 0}>
              <CheckCheck className="h-4 w-4 mr-1.5" />
              Mark all read
            </Button>
          </>
        }
      />

      <SectionCard>
        {loading ? (
          <div className="flex flex-col gap-2 py-1">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="flex items-start gap-3 rounded-xl border p-3">
                <Skeleton className="h-2.5 w-2.5 rounded-full" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-1/3" />
                  <Skeleton className="h-3 w-2/3" />
                  <Skeleton className="h-2.5 w-20" />
                </div>
              </div>
            ))}
          </div>
        ) : rows.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-1 py-14 text-center">
            <div className="mb-2 rounded-full bg-muted p-3">
              <Bell className="h-5 w-5 text-muted-foreground" />
            </div>
            <p className="text-sm font-medium">{emptyTitle}</p>
            <p className="text-xs text-muted-foreground">{emptySub}</p>
          </div>
        ) : (
          <>
            <div className="max-h-[70vh] overflow-y-auto pr-1">
              <div className="flex flex-col gap-2">
                {rows.slice(0, visible).map((n) => (
                  <div
                    key={n.id}
                    className={cn(
                      'group flex items-start gap-3 rounded-xl border p-3 transition-colors hover:bg-muted/40',
                      !n.read && 'bg-muted/60',
                    )}
                  >
                    <span
                      className={cn('mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full', LEVEL_DOT[n.level] || 'bg-gray-400')}
                      title={n.level}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-medium leading-snug">{n.title}</p>
                        {!n.read && (
                          <Badge className="border-0 bg-teal-100 px-1.5 py-0 text-[10px] text-teal-700 dark:bg-teal-950 dark:text-teal-300">
                            New
                          </Badge>
                        )}
                      </div>
                      {n.message && <p className="mt-0.5 text-xs leading-snug text-muted-foreground">{n.message}</p>}
                      <p className="mt-1 text-[11px] text-muted-foreground/70" title={fmtDateTime(n.createdAt)}>
                        {timeAgo(n.createdAt)}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-9 w-9"
                        disabled={busyId === n.id}
                        onClick={() => void toggleRead(n)}
                        aria-label={n.read ? 'Mark as unread' : 'Mark as read'}
                        title={n.read ? 'Mark as unread' : 'Mark as read'}
                      >
                        {n.read ? <Undo2 className="h-4 w-4" /> : <CheckCheck className="h-4 w-4" />}
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-9 w-9 text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300"
                        disabled={busyId === n.id}
                        onClick={() => void remove(n)}
                        aria-label="Delete notification"
                        title="Delete notification"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            {rows.length > visible && (
              <div className="mt-3 text-center">
                <Button variant="outline" size="sm" onClick={() => setVisible((v) => v + PAGE)}>
                  Load more ({rows.length - visible} more)
                </Button>
              </div>
            )}
          </>
        )}
      </SectionCard>
    </div>
  )
}
