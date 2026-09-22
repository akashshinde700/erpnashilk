'use client'

import * as React from 'react'
import {
  AlertTriangle,
  BarChart3,
  Boxes,
  ClipboardList,
  CreditCard,
  Factory,
  FileText,
  HandCoins,
  IndianRupee,
  Layers3,
  PackageCheck,
  Percent,
  RefreshCw,
  ShoppingCart,
  SlidersHorizontal,
  Wallet,
} from 'lucide-react'
import { Area, AreaChart, Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { canAccessModule, fmtDate, fmtDateTime, fmtMoney, fmtNum } from '@/lib/erp-constants'
import { useList } from '@/lib/use-api'
import { Money, SectionCard, StatCard, StatusBadge } from '@/components/erp/kit'

// ---------- API shapes (contract: GET /api/dashboard?companyId=) ----------

interface RecentSalesOrder {
  id: string
  number?: string
  date?: string
  orderDate?: string
  status?: string
  grandTotal?: number
  customer?: { name?: string } | null
}

interface PendingApproval {
  id: string
  type?: string // 'PR' | 'PO' or full doc type name
  number?: string
  date?: string
  amount?: number
  grandTotal?: number
}

interface LowStockRow {
  id?: string
  item?: { code?: string; name?: string; uom?: string } | null
  onHand?: number
  qty?: number
  reorderLevel?: number
}

interface NotificationRow {
  id: string
  title?: string
  message?: string
  level?: string // INFO | WARNING | CRITICAL | SUCCESS
  createdAt?: string
  read?: boolean
}

interface DashboardData {
  kpis?: {
    salesThisMonth?: number
    purchasesThisMonth?: number
    receivables?: number
    payables?: number
    stockValue?: number
    openOrders?: number
    openSalesOrders?: number
    wipQty?: number
    lowStockCount?: number
  }
  charts?: {
    salesTrend?: { month: string; key?: string; value: number }[]
    productionTrend?: { month: string; key?: string; value?: number; qty?: number }[]
  }
  lists?: {
    recentSalesOrders?: RecentSalesOrder[]
    pendingApprovals?: PendingApproval[]
    lowStock?: LowStockRow[]
    notifications?: NotificationRow[]
  }
}

// ---------- palette / helpers ----------

const EMERALD = '#059669'
const TEAL = '#0d9488'
const AMBER = '#f59e0b'

const TONE = {
  emerald: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300',
  violet: 'bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300',
  sky: 'bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300',
  rose: 'bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300',
  amber: 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300',
}

function compact(n: number): string {
  const abs = Math.abs(n)
  if (abs >= 10000000) return `${(n / 10000000).toFixed(1)}Cr`
  if (abs >= 100000) return `${(n / 100000).toFixed(1)}L`
  if (abs >= 1000) return `${(n / 1000).toFixed(1)}K`
  return `${Math.round(n)}`
}

function shortApprovalType(t?: string): string {
  const s = (t || '').toUpperCase()
  if (s === 'PR' || s.startsWith('PURCHASE_REQUISITION') || s.startsWith('REQUISITION')) return 'PR'
  if (s === 'PO' || s.startsWith('PURCHASE_ORDER') || s.startsWith('ORDER')) return 'PO'
  return s.slice(0, 2) || '—'
}

/** Extract a trend point's yyyy-mm key from a Recharts click datum (v2 wraps the point in .payload). */
function trendKeyFromChartDatum(datum: unknown): string | undefined {
  if (!datum || typeof datum !== 'object') return undefined
  const d = datum as { payload?: unknown }
  const point = (d.payload && typeof d.payload === 'object' ? d.payload : datum) as { key?: unknown }
  return typeof point.key === 'string' && point.key ? point.key : undefined
}

function levelDotCls(level?: string): string {
  switch ((level || '').toUpperCase()) {
    case 'CRITICAL':
      return 'bg-red-500'
    case 'WARNING':
      return 'bg-amber-500'
    case 'INFO':
      return 'bg-sky-500'
    case 'SUCCESS':
      return 'bg-emerald-500'
    default:
      return 'bg-zinc-400'
  }
}

const EmptyList = ({ text }: { text: string }) => (
  <p className="py-10 text-center text-sm text-muted-foreground">{text}</p>
)

// ---------- quick actions (role-filtered, navigate via erp:goto) ----------

const QUICK_ACTIONS: { key: string; label: string; icon: React.ReactNode }[] = [
  { key: 'sales-orders', label: 'New Sales Order', icon: <ShoppingCart className="h-4 w-4" /> },
  { key: 'quotations', label: 'New Quotation', icon: <FileText className="h-4 w-4" /> },
  { key: 'purchase-orders', label: 'New Purchase Order', icon: <PackageCheck className="h-4 w-4" /> },
  { key: 'payments', label: 'Record Payment', icon: <Wallet className="h-4 w-4" /> },
  { key: 'work-orders', label: 'New Work Order', icon: <Factory className="h-4 w-4" /> },
  { key: 'qc-inspections', label: 'QC Inspection', icon: <ClipboardList className="h-4 w-4" /> },
  { key: 'stock-adjustments', label: 'Stock Adjustment', icon: <SlidersHorizontal className="h-4 w-4" /> },
  { key: 'mrp', label: 'Run MRP', icon: <Layers3 className="h-4 w-4" /> },
  { key: 'stock', label: 'Check Stock', icon: <Boxes className="h-4 w-4" /> },
  { key: 'gst-report', label: 'GST Report', icon: <Percent className="h-4 w-4" /> },
  { key: 'reports', label: 'Reports', icon: <BarChart3 className="h-4 w-4" /> },
  { key: 'expenses', label: 'Add Expense', icon: <CreditCard className="h-4 w-4" /> },
]

function QuickActions({ role }: { role: string }) {
  const actions = QUICK_ACTIONS.filter((a) => canAccessModule(role, a.key))
  if (!actions.length) return null
  return (
    <SectionCard title="Quick actions">
      <p className="text-xs text-muted-foreground -mt-1 mb-2">One-click jump to the most-used workflows</p>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        {actions.map((a) => (
          <button
            key={a.key}
            onClick={() => window.dispatchEvent(new CustomEvent('erp:goto', { detail: a.key }))}
            className="flex flex-col items-center gap-1.5 rounded-lg border bg-card px-2 py-3 text-center transition-colors hover:border-emerald-300 hover:bg-emerald-50 dark:hover:border-emerald-800 dark:hover:bg-emerald-950/40"
          >
            <span className="rounded-md bg-emerald-100 p-1.5 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">{a.icon}</span>
            <span className="text-[11px] font-medium leading-tight">{a.label}</span>
          </button>
        ))}
      </div>
    </SectionCard>
  )
}

// ---------- trend span (3M / 6M / 12M) ----------

const TREND_SPANS = [3, 6, 12] as const

type TrendSpan = (typeof TREND_SPANS)[number]

function TrendSpanControl({ span, onChange }: { span: TrendSpan; onChange: (s: TrendSpan) => void }) {
  return (
    <div className="flex items-center justify-end gap-2">
      <span className="text-xs text-muted-foreground">Trend span</span>
      <div role="group" aria-label="Trend span" className="flex items-center gap-1">
        {TREND_SPANS.map((s) => (
          <Button
            key={s}
            size="sm"
            variant={s === span ? 'default' : 'outline'}
            aria-pressed={s === span}
            className={s === span ? 'h-8 bg-emerald-600 text-white hover:bg-emerald-600' : 'h-8'}
            onClick={() => onChange(s)}
          >
            {s}M
          </Button>
        ))}
      </div>
    </div>
  )
}

// ---------- module ----------

export default function DashboardModule({ companyId }: { companyId: string }) {
  const [span, setSpan] = React.useState<TrendSpan>(6)
  const { data, loading, error, refetch } = useList<DashboardData>(`/api/dashboard?companyId=${companyId}&months=${span}`)

  // Role read lifted here (localStorage 'erp_user') — gates every widget below
  const role = React.useMemo(() => {
    try {
      const raw = window.localStorage.getItem('erp_user')
      return raw ? (JSON.parse(raw) as { user?: { role?: string } }).user?.role || '' : ''
    } catch { return '' }
  }, [])

  const canReceivables = canAccessModule(role, 'receivables')
  const canPayables = canAccessModule(role, 'payables')
  const canStock = canAccessModule(role, 'stock')
  const canWorkOrders = canAccessModule(role, 'work-orders')
  const canSalesOrders = canAccessModule(role, 'sales-orders')
  const canApprovals = canAccessModule(role, 'purchase-orders') || canAccessModule(role, 'requisitions')
  const canNotifications = canAccessModule(role, 'notifications')

  /** Navigate via the global erp:goto event (string detail, or { key, preset } to seed a search filter). */
  function openModule(key: string, preset?: { q?: string }) {
    window.dispatchEvent(new CustomEvent('erp:goto', { detail: preset ? { key, preset } : key }))
  }

  /** Palette-style deep-link highlight + navigate — list rows that target a specific record. */
  function openWithHighlight(module: string, id: string) {
    try {
      window.sessionStorage.setItem('erp_deep_link', JSON.stringify({ module, id, ts: Date.now() }))
      window.dispatchEvent(new CustomEvent('erp:deep-link', { detail: { module, id } }))
    } catch { /* ignore */ }
    openModule(module)
  }

  const k = data?.kpis
  const lists = data?.lists
  const salesTrend = data?.charts?.salesTrend ?? []
  const productionTrend = (data?.charts?.productionTrend ?? []).map((r) => ({ month: r.month, key: r.key, qty: r.qty ?? r.value ?? 0 }))
  const recentOrders = lists?.recentSalesOrders ?? []
  const approvals = lists?.pendingApprovals ?? []
  const lowStock = lists?.lowStock ?? []
  const notifications = lists?.notifications ?? []

  const stats: { title: string; value: string; icon: React.ReactNode; cls: string; to: string; hint: string; allow?: boolean }[] = [
    { title: 'Sales This Month', value: fmtMoney(k?.salesThisMonth), icon: <IndianRupee className="h-4 w-4" />, cls: TONE.emerald, to: 'sales-invoices', hint: 'Open sales invoices' },
    { title: 'Purchases This Month', value: fmtMoney(k?.purchasesThisMonth), icon: <ShoppingCart className="h-4 w-4" />, cls: TONE.violet, to: 'purchase-invoices', hint: 'Open purchase invoices' },
    { title: 'Receivables', value: fmtMoney(k?.receivables), icon: <HandCoins className="h-4 w-4" />, cls: TONE.sky, to: 'receivables', hint: 'Open receivables', allow: canReceivables },
    { title: 'Payables', value: fmtMoney(k?.payables), icon: <CreditCard className="h-4 w-4" />, cls: TONE.rose, to: 'payables', hint: 'Open payables', allow: canPayables },
    { title: 'Stock Value', value: fmtMoney(k?.stockValue), icon: <Boxes className="h-4 w-4" />, cls: TONE.amber, to: 'stock', hint: 'Open stock balances', allow: canStock },
    { title: 'Open Sales Orders', value: fmtNum(k?.openSalesOrders ?? k?.openOrders), icon: <ClipboardList className="h-4 w-4" />, cls: TONE.sky, to: 'sales-orders', hint: 'Open sales orders' },
    { title: 'WIP Qty', value: fmtNum(k?.wipQty), icon: <Factory className="h-4 w-4" />, cls: TONE.violet, to: 'work-orders', hint: 'Open work orders', allow: canWorkOrders },
    { title: 'Low Stock Items', value: fmtNum(k?.lowStockCount), icon: <AlertTriangle className="h-4 w-4" />, cls: TONE.rose, to: 'stock', hint: 'Open stock balances', allow: canStock },
  ]
  const visibleStats = stats.filter((s) => s.allow !== false)

  // List grid columns adapt to how many top-level list sections the role can see
  const listSlots = [canSalesOrders, canApprovals, canStock || canNotifications].filter(Boolean).length
  const listCols = listSlots >= 3 ? 'lg:grid-cols-3' : listSlots === 2 ? 'lg:grid-cols-2' : 'lg:grid-cols-1'

  if (error && !data) {
    return (
      <SectionCard>
        <div className="flex flex-col items-center gap-3 py-12 text-center">
          <AlertTriangle className="h-8 w-8 text-amber-500" />
          <p className="max-w-md text-sm text-muted-foreground">{error}</p>
          <Button variant="outline" size="sm" onClick={() => void refetch()}>
            <RefreshCw className="h-4 w-4 mr-1.5" /> Retry
          </Button>
        </div>
      </SectionCard>
    )
  }

  if (loading && !data) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={`kpi-${i}`} className="h-[86px] rounded-xl" />
          ))}
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          <Skeleton className="h-[320px] rounded-xl" />
          <Skeleton className="h-[320px] rounded-xl" />
        </div>
        <div className="grid gap-4 lg:grid-cols-3">
          <Skeleton className="h-[280px] rounded-xl" />
          <Skeleton className="h-[280px] rounded-xl" />
          <Skeleton className="h-[280px] rounded-xl" />
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {error && data && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-300">
          <span className="truncate">{error}</span>
          <Button variant="outline" size="sm" onClick={() => void refetch()}>
            <RefreshCw className="h-4 w-4 mr-1.5" /> Retry
          </Button>
        </div>
      )}

      {/* KPI cards — clickable, drill into the owning module */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {visibleStats.map((s) => (
          <button
            key={s.title}
            type="button"
            onClick={() => openModule(s.to)}
            className="text-left w-full rounded-xl transition hover:ring-2 hover:ring-emerald-300 dark:hover:ring-emerald-700 focus:outline-none focus-visible:ring-2 cursor-pointer"
            aria-label={s.hint}
            title={s.hint}
          >
            <StatCard title={s.title} value={s.value} icon={s.icon} toneClass={s.cls} />
          </button>
        ))}
      </div>

      {/* Quick actions */}
      <QuickActions role={role} />

      {/* Trend span control — changing it refetches with the chosen window */}
      <TrendSpanControl span={span} onChange={setSpan} />

      {/* Charts — production card only for work-order roles (dimmed while a span refetch is in flight) */}
      <div
        className={cn(
          'grid gap-4',
          canWorkOrders ? 'lg:grid-cols-2' : 'lg:grid-cols-1',
          loading && data ? 'opacity-60 transition-opacity' : undefined,
        )}
      >
        <SectionCard title={`Sales Trend (${span} months)`}>
          <p className="-mt-1 mb-2 text-xs text-muted-foreground">Click a bar to open that month's invoices</p>
          {salesTrend.length > 0 ? (
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={salesTrend} margin={{ top: 8, right: 8, left: -4, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e4e4e7" />
                <XAxis dataKey="month" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
                <YAxis
                  tick={{ fontSize: 11 }}
                  tickLine={false}
                  axisLine={false}
                  width={48}
                  tickFormatter={(v) => compact(Number(v))}
                />
                <Tooltip cursor={{ fill: 'rgba(5, 150, 105, 0.08)' }} formatter={(v) => fmtMoney(Number(v))} />
                <Bar
                  dataKey="value"
                  name="Sales"
                  fill={EMERALD}
                  radius={[4, 4, 0, 0]}
                  maxBarSize={42}
                  className="cursor-pointer"
                  onClick={(datum: unknown) => {
                    const key = trendKeyFromChartDatum(datum)
                    if (key) openModule('sales-invoices', { q: key })
                  }}
                />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex h-[260px] items-center justify-center text-sm text-muted-foreground">No sales data yet</div>
          )}
        </SectionCard>

        {canWorkOrders && (
        <SectionCard title={`Production Output (${span} months)`}>
          <p className="-mt-1 mb-2 text-xs text-muted-foreground">Click a point to open that month's work orders</p>
          {productionTrend.length > 0 ? (
            <ResponsiveContainer width="100%" height={260}>
              <AreaChart data={productionTrend} margin={{ top: 8, right: 8, left: -4, bottom: 0 }}>
                <defs>
                  <linearGradient id="mfl-prod-fill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={TEAL} stopOpacity={0.35} />
                    <stop offset="100%" stopColor={TEAL} stopOpacity={0.03} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e4e4e7" />
                <XAxis dataKey="month" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
                <YAxis
                  tick={{ fontSize: 11 }}
                  tickLine={false}
                  axisLine={false}
                  width={48}
                  tickFormatter={(v) => compact(Number(v))}
                />
                <Tooltip cursor={{ stroke: AMBER, strokeDasharray: '3 3' }} formatter={(v) => `${fmtNum(Number(v))} qty`} />
                <Area
                  type="monotone"
                  dataKey="qty"
                  name="Output"
                  stroke={TEAL}
                  strokeWidth={2}
                  fill="url(#mfl-prod-fill)"
                  className="cursor-pointer"
                  onClick={(datum: unknown) => {
                    const key = trendKeyFromChartDatum(datum)
                    if (key) openModule('work-orders', { q: key })
                  }}
                />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex h-[260px] items-center justify-center text-sm text-muted-foreground">No production data yet</div>
          )}
        </SectionCard>
        )}
      </div>

      {/* Lists — role-gated */}
      <div className={cn('grid gap-4', listCols)}>
        {canSalesOrders && (
        <SectionCard title="Recent Sales Orders">
          {recentOrders.length === 0 ? (
            <EmptyList text="No sales orders yet" />
          ) : (
            <div>
              {recentOrders.slice(0, 6).map((o) => (
                <button
                  key={o.id}
                  type="button"
                  onClick={() => openWithHighlight('sales-orders', o.id)}
                  className="flex w-full items-center justify-between gap-3 border-b py-2 text-left last:border-0 transition-colors hover:bg-muted/50 cursor-pointer"
                  aria-label={`Open sales order ${o.number ?? ''}`}
                  title="Open this sales order"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{o.number ?? '—'}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {o.customer?.name ?? '—'} · {fmtDate(o.orderDate ?? o.date)}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <Money value={o.grandTotal} className="text-sm font-medium" />
                    <div className="mt-0.5">
                      <StatusBadge status={o.status} />
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </SectionCard>
        )}

        {canApprovals && (
        <SectionCard
          title="Pending Approvals"
          actions={
            approvals.length > 0 ? (
              <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:bg-amber-950 dark:text-amber-300">
                {approvals.length} waiting
              </span>
            ) : undefined
          }
        >
          {approvals.length === 0 ? (
            <EmptyList text="Nothing pending approval" />
          ) : (
            <div>
              {approvals.slice(0, 6).map((a) => {
                const kind = shortApprovalType(a.type)
                const body = (
                  <>
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="shrink-0 rounded bg-violet-100 px-1.5 py-0.5 text-[10px] font-semibold text-violet-700 dark:bg-violet-950 dark:text-violet-300">
                        {kind}
                      </span>
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{a.number ?? '—'}</p>
                        <p className="text-xs text-muted-foreground">{fmtDate(a.date)}</p>
                      </div>
                    </div>
                    <Money value={a.grandTotal ?? a.amount} className="shrink-0 text-sm font-medium" />
                  </>
                )
                if (kind !== 'PR' && kind !== 'PO') {
                  return <div key={a.id} className="flex items-center justify-between gap-3 border-b py-2 last:border-0">{body}</div>
                }
                return (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => (kind === 'PO' ? openWithHighlight('purchase-orders', a.id) : openModule('requisitions'))}
                    className="flex w-full items-center justify-between gap-3 border-b py-2 text-left last:border-0 transition-colors hover:bg-muted/50 cursor-pointer"
                    aria-label={`Open ${kind === 'PO' ? 'purchase order' : 'requisition'} ${a.number ?? ''}`}
                    title={kind === 'PO' ? 'Open purchase order' : 'Open requisition'}
                  >
                    {body}
                  </button>
                )
              })}
            </div>
          )}
        </SectionCard>
        )}

        {(canStock || canNotifications) && (
        <div className="space-y-4">
          {canStock && (
          <SectionCard title="Low Stock">
            {lowStock.length === 0 ? (
              <EmptyList text="All items above reorder level" />
            ) : (
              <div>
                {lowStock.slice(0, 5).map((r) => {
                  const onHand = r.onHand ?? r.qty ?? 0
                  const code = (r.item?.code || '').trim()
                  return (
                    <button
                      key={r.item?.code || r.id || r.item?.name || Math.random()}
                      type="button"
                      onClick={() => (code ? openModule('stock', { q: code }) : openModule('stock'))}
                      className="flex w-full items-center justify-between gap-3 border-b py-2 text-left last:border-0 transition-colors hover:bg-muted/50 cursor-pointer"
                      aria-label={`Check stock for ${r.item?.name ?? 'item'}`}
                      title="Check stock for this item"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{r.item?.name ?? '—'}</p>
                        <p className="truncate text-xs text-muted-foreground">
                          {r.item?.code ?? ''} · reorder at {fmtNum(r.reorderLevel)}
                        </p>
                      </div>
                      <span className={cn('shrink-0 text-sm font-semibold tabular-nums', onHand <= 0 ? 'text-red-600' : 'text-amber-600')}>
                        {fmtNum(onHand)}
                      </span>
                    </button>
                  )
                })}
              </div>
            )}
          </SectionCard>
          )}

          {canNotifications && (
          <SectionCard title="Notifications">
            {notifications.length === 0 ? (
              <EmptyList text="No notifications" />
            ) : (
              <div>
                {notifications.slice(0, 5).map((n) => (
                  <button
                    key={n.id}
                    type="button"
                    onClick={() => openModule('notifications')}
                    className="flex w-full items-start gap-2.5 border-b py-2 text-left last:border-0 transition-colors hover:bg-muted/50 cursor-pointer"
                    aria-label="Open notifications"
                    title="Open notifications"
                  >
                    <span className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', levelDotCls(n.level))} />
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{n.title ?? '—'}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {n.message ? `${n.message} · ` : ''}
                        {fmtDateTime(n.createdAt)}
                      </p>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </SectionCard>
          )}
        </div>
        )}
      </div>
    </div>
  )
}
