'use client'

import * as React from 'react'
import { toast } from 'sonner'
import { Bell, CheckCheck, ChevronDown, Factory, Loader2, LogOut, Menu, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'
import { fmtDateTime } from '@/lib/erp-constants'
import { apiPatch, useList } from '@/lib/use-api'
import { MODULES, MODULE_GROUPS, findModule } from '@/components/erp/registry'

interface CompanyRow {
  id: string
  name: string
  gstin?: string | null
  city?: string | null
  stateCode?: string | null
  logoText?: string | null
}

interface NotificationRow {
  id: string
  title: string
  message?: string | null
  level: string
  read: boolean
  createdAt: string
}

const LEVEL_DOT: Record<string, string> = {
  INFO: 'bg-sky-500',
  WARNING: 'bg-amber-500',
  CRITICAL: 'bg-red-500',
}

export default function ErpApp() {
  const [companyId, setCompanyId] = React.useState<string | null>(null)
  const [activeKey, setActiveKey] = React.useState('dashboard')
  const [navOpen, setNavOpen] = React.useState(false)
  const [switching, setSwitching] = React.useState(false)

  const companies = useList<{ companies: CompanyRow[] }>('/api/companies')

  // Initialize company from localStorage or first tenant
  React.useEffect(() => {
    if (!companies.data || companyId) return
    const list = companies.data.companies || []
    if (!list.length) return
    const saved = typeof window !== 'undefined' ? window.localStorage.getItem('erp_company_id') : null
    const valid = list.find((c) => c.id === saved)
    setCompanyId((valid || list[0]).id)
  }, [companies.data, companyId])

  const activeModule = findModule(activeKey) || MODULES[0]

  // Reset scroll when switching modules
  React.useEffect(() => {
    window.scrollTo({ top: 0 })
  }, [activeKey])
  const notifications = useList<{ items: NotificationRow[]; unreadCount: number }>(
    companyId ? `/api/notifications?companyId=${companyId}&unread=1` : null,
  )
  const [notifOpen, setNotifOpen] = React.useState(false)

  function switchCompany(id: string) {
    if (id === companyId) return
    setSwitching(true)
    window.localStorage.setItem('erp_company_id', id)
    setTimeout(() => {
      setCompanyId(id)
      setSwitching(false)
      setNavOpen(false)
      toast.success('Tenant switched — data isolated per company')
    }, 250)
  }

  async function markAllRead() {
    if (!companyId) return
    try {
      await apiPatch('/api/notifications', { companyId, all: true })
      await notifications.refetch()
    } catch {
      /* non-blocking */
    }
  }

  const companyList = companies.data?.companies || []
  const currentCompany = companyList.find((c) => c.id === companyId)

  const sidebar = (
    <div className="flex h-full flex-col bg-card">
      <div className="flex items-center gap-2.5 px-4 h-14 border-b shrink-0">
        <div className="h-8 w-8 rounded-lg bg-emerald-600 text-white grid place-items-center shrink-0">
          <Factory className="h-4.5 w-4.5" />
        </div>
        <div className="leading-tight min-w-0">
          <p className="font-semibold text-sm">ManuFlow ERP</p>
          <p className="text-[10px] text-muted-foreground">Manufacturing SaaS Suite</p>
        </div>
        {navOpen && (
          <Button variant="ghost" size="icon" className="ml-auto lg:hidden h-8 w-8" onClick={() => setNavOpen(false)}>
            <X className="h-4 w-4" />
          </Button>
        )}
      </div>
      <ScrollArea className="flex-1">
        <nav className="p-2 pb-6" aria-label="ERP modules">
          {MODULE_GROUPS.map((group) => {
            const mods = MODULES.filter((m) => m.group === group)
            if (!mods.length) return null
            return (
              <div key={group} className="mb-1">
                <p className="px-2.5 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">{group}</p>
                {mods.map((m) => {
                  const active = m.key === activeKey
                  return (
                    <button
                      key={m.key}
                      onClick={() => { setActiveKey(m.key); setNavOpen(false) }}
                      className={cn(
                        'w-full flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] transition-colors text-left',
                        active ? 'bg-emerald-600 text-white font-medium shadow-sm' : 'text-foreground/70 hover:bg-muted hover:text-foreground',
                      )}
                      aria-current={active ? 'page' : undefined}
                    >
                      <m.icon className="h-4 w-4 shrink-0" />
                      <span className="truncate">{m.label}</span>
                    </button>
                  )
                })}
              </div>
            )
          })}
        </nav>
      </ScrollArea>
      <div className="border-t px-4 py-2.5 text-[10px] text-muted-foreground shrink-0">
        {currentCompany ? (
          <div className="truncate">
            <span className="font-medium text-foreground/80">{currentCompany.name}</span>
            {currentCompany.gstin && <span className="ml-1">· GSTIN {currentCompany.gstin}</span>}
          </div>
        ) : 'Multi-tenant SaaS · FY Apr–Mar'}
      </div>
    </div>
  )

  return (
    <div className="min-h-screen flex bg-background">
      {/* Desktop sidebar */}
      <aside className="hidden lg:block w-60 border-r shrink-0 sticky top-0 h-screen">{sidebar}</aside>

      {/* Mobile nav overlay */}
      {navOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={() => setNavOpen(false)} />
          <div className="absolute inset-y-0 left-0 w-72 shadow-xl">{sidebar}</div>
        </div>
      )}

      <div className="flex-1 flex flex-col min-w-0">
        {/* Topbar */}
        <header className="sticky top-0 z-40 h-14 border-b bg-card/95 backdrop-blur flex items-center gap-2 px-3 sm:px-4">
          <Button variant="ghost" size="icon" className="lg:hidden h-9 w-9 shrink-0" onClick={() => setNavOpen(true)} aria-label="Open navigation">
            <Menu className="h-5 w-5" />
          </Button>

          <div className="min-w-0 flex-1">
            <h1 className="font-semibold text-sm sm:text-base truncate leading-tight">{activeModule.label}</h1>
            <p className="text-[11px] text-muted-foreground truncate leading-tight hidden sm:block">
              {activeModule.description || activeModule.group}
            </p>
          </div>

          {/* Company switcher */}
          <div className="flex items-center gap-2">
            <div className="hidden sm:flex items-center gap-1.5 text-[11px] text-muted-foreground">
              {switching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <span className="hidden md:inline">Tenant:</span>}
            </div>
            <Select value={companyId ?? ''} onValueChange={switchCompany}>
              <SelectTrigger className="h-9 w-[150px] sm:w-[220px] text-xs" aria-label="Switch company (tenant)">
                <SelectValue placeholder="Loading…" />
              </SelectTrigger>
              <SelectContent>
                {companyList.map((c) => (
                  <SelectItem key={c.id} value={c.id} className="text-xs">
                    <span className="font-medium">{c.logoText || c.name.slice(0, 12)}</span>
                    <span className="text-muted-foreground ml-1.5">{c.city || ''}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {/* Notifications */}
            <Popover open={notifOpen} onOpenChange={setNotifOpen}>
              <PopoverTrigger asChild>
                <Button variant="ghost" size="icon" className="relative h-9 w-9 shrink-0" aria-label={`Notifications (${notifications.data?.unreadCount || 0} unread)`}>
                  <Bell className="h-4.5 w-4.5" />
                  {!!notifications.data?.unreadCount && (
                    <span className="absolute -top-0.5 -right-0.5 h-4 min-w-4 px-0.5 rounded-full bg-red-500 text-white text-[9px] grid place-items-center font-semibold">
                      {notifications.data.unreadCount > 9 ? '9+' : notifications.data.unreadCount}
                    </span>
                  )}
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-80 p-0">
                <div className="flex items-center justify-between px-3 py-2 border-b">
                  <p className="text-sm font-medium">Notifications</p>
                  <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => void markAllRead()}>
                    <CheckCheck className="h-3.5 w-3.5 mr-1" />Mark all read
                  </Button>
                </div>
                <ScrollArea className="max-h-80">
                  {(notifications.data?.items || []).length === 0 ? (
                    <p className="text-xs text-muted-foreground text-center py-8">No unread notifications 🎉</p>
                  ) : (
                    (notifications.data?.items || []).map((n) => (
                      <div key={n.id} className="px-3 py-2.5 border-b last:border-0 flex gap-2.5">
                        <span className={cn('h-2 w-2 rounded-full mt-1.5 shrink-0', LEVEL_DOT[n.level] || 'bg-gray-400')} />
                        <div className="min-w-0">
                          <p className="text-[13px] font-medium leading-snug">{n.title}</p>
                          {n.message && <p className="text-xs text-muted-foreground leading-snug mt-0.5">{n.message}</p>}
                          <p className="text-[10px] text-muted-foreground/70 mt-1">{fmtDateTime(n.createdAt)}</p>
                        </div>
                      </div>
                    ))
                  )}
                </ScrollArea>
              </PopoverContent>
            </Popover>

            {/* User chip */}
            <div className="hidden md:flex items-center gap-2 pl-2 border-l">
              <div className="h-8 w-8 rounded-full bg-teal-600 text-white grid place-items-center text-xs font-semibold shrink-0">RD</div>
              <div className="leading-tight">
                <p className="text-xs font-medium">Rajesh Deshmukh</p>
                <p className="text-[10px] text-muted-foreground">Tenant Admin</p>
              </div>
            </div>
            <Button variant="ghost" size="icon" className="hidden md:inline-flex h-9 w-9 shrink-0" aria-label="Sign out (demo)" onClick={() => toast.info('Demo build — authentication arrives in Phase 6')}>
              <LogOut className="h-4 w-4" />
            </Button>
          </div>
        </header>

        {/* Content */}
        <main className="flex-1 px-3 py-4 sm:px-5 sm:py-5 lg:px-6 lg:py-6 w-full max-w-[1500px] mx-auto">
          {!companyId || switching ? (
            <div className="h-64 grid place-items-center">
              <div className="flex flex-col items-center gap-3 text-muted-foreground">
                <Loader2 className="h-7 w-7 animate-spin text-emerald-600" />
                <p className="text-sm">Loading workspace…</p>
              </div>
            </div>
          ) : (
            <activeModule.component key={`${companyId}-${activeKey}`} companyId={companyId} />
          )}
        </main>

        {/* Sticky footer */}
        <footer className="mt-auto border-t bg-card">
          <div className="max-w-[1500px] mx-auto px-4 py-3 flex flex-col sm:flex-row items-center justify-between gap-1.5 text-xs text-muted-foreground">
            <div className="flex items-center gap-1.5">
              <Factory className="h-3.5 w-3.5 text-emerald-600" />
              <span className="font-medium text-foreground/80">ManuFlow ERP</span>
              <span className="hidden sm:inline">— Lead → Quotation → SO → Production → QC → Dispatch → GST Invoice → Payment</span>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="text-[10px] font-normal">Demo data: Acme Precision Mfg</Badge>
              <Separator orientation="vertical" className="h-3 hidden sm:block" />
              <span className="hidden sm:inline">FY {new Date().getMonth() + 1 >= 4 ? new Date().getFullYear() : new Date().getFullYear() - 1}–{(new Date().getMonth() + 1 >= 4 ? new Date().getFullYear() : new Date().getFullYear() - 1) + 1}</span>
            </div>
          </div>
        </footer>
      </div>
    </div>
  )
}
