'use client'

import * as React from 'react'
import { useTheme } from 'next-themes'
import { toast } from 'sonner'
import { io, type Socket } from 'socket.io-client'
import {
  Bell, CheckCheck, Factory, Keyboard, KeyRound, Loader2, LogOut, Menu, Moon, PanelLeftClose, PanelLeftOpen,
  Search, Star, Sun, X, Command as CommandIcon, Clock, Sparkles,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator,
} from '@/components/ui/command'
import { cn } from '@/lib/utils'
import { fmtDateTime, ROLE_LABEL, canAccessModule } from '@/lib/erp-constants'
import { apiGet, apiPatch, apiPost, useList } from '@/lib/use-api'
import { MODULES, MODULE_GROUPS, findModule } from '@/components/erp/registry'
import { Kbd } from '@/components/erp/kit'
import LoginScreen, { type LoginUser, type LoginCompany } from '@/components/erp/login-screen'
import ShortcutsDialog from '@/components/erp/shortcuts-help'
import ChangePasswordDialog from '@/components/erp/change-password-dialog'

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

interface Session {
  user: LoginUser
  company: LoginCompany
}

interface SearchResult {
  id: string
  type: string
  label: string
  sub?: string | null
  module: string
}

const SESSION_KEY = 'erp_user'
const FAV_KEY = 'erp_fav_modules'
const RECENT_KEY = 'erp_recent_modules'
const COLLAPSE_KEY = 'erp_sidebar_collapsed'

const LEVEL_DOT: Record<string, string> = {
  INFO: 'bg-sky-500',
  WARNING: 'bg-amber-500',
  CRITICAL: 'bg-red-500',
}

const TENANT_ADMIN_ROLES = ['TENANT_ADMIN', 'MANAGEMENT', 'SUPER_ADMIN']

/** g + key → module key (Gmail-style jump). Only fires for modules the role can access. */
const GO_KEYS: Record<string, string> = {
  d: 'dashboard',
  i: 'items',
  c: 'customers',
  v: 'suppliers',
  s: 'stock',
  o: 'sales-orders',
  q: 'quotations',
  e: 'enquiries',
  n: 'sales-invoices',
  p: 'purchase-orders',
  w: 'work-orders',
  m: 'mrp',
  b: 'boms',
  l: 'stock-ledger',
  t: 'stock-transfers',
  u: 'users',
  r: 'reports',
  a: 'audit-log',
}

const initials = (name: string) =>
  name.split(/\s+/).slice(0, 2).map((p) => p[0]?.toUpperCase() || '').join('') || 'U'

function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false
  return t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable
}

function readJsonArray(key: string): string[] {
  try {
    const raw = window.localStorage.getItem(key)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter((k) => typeof k === 'string') : []
  } catch { return [] }
}

function persistJson(key: string, value: string[]) {
  try { window.localStorage.setItem(key, JSON.stringify(value)) } catch { /* private mode */ }
}

export default function ErpApp() {
  const [session, setSession] = React.useState<Session | null>(null)
  const [booting, setBooting] = React.useState(true)
  const [companyId, setCompanyId] = React.useState<string | null>(null)
  const [activeKey, setActiveKey] = React.useState('dashboard')
  const [navOpen, setNavOpen] = React.useState(false)
  const [switching, setSwitching] = React.useState(false)
  const socketRef = React.useRef<Socket | null>(null)

  // ---------- Phase 7 UX state ----------
  const [collapsed, setCollapsed] = React.useState(false)
  const [favs, setFavs] = React.useState<string[]>([])
  const [recents, setRecents] = React.useState<string[]>([])
  const [helpOpen, setHelpOpen] = React.useState(false)
  const [pwdOpen, setPwdOpen] = React.useState(false)
  const goPendingRef = React.useRef(0)
  const { resolvedTheme, setTheme } = useTheme()
  const [themeMounted, setThemeMounted] = React.useState(false)

  // ---------- boot: restore session + prefs ----------
  React.useEffect(() => {
    try {
      const raw = window.localStorage.getItem(SESSION_KEY)
      if (raw) setSession(JSON.parse(raw) as Session)
      setCollapsed(window.localStorage.getItem(COLLAPSE_KEY) === '1')
      setFavs(readJsonArray(FAV_KEY))
      setRecents(readJsonArray(RECENT_KEY))
    } catch { /* corrupted session — ignore */ }
    setThemeMounted(true)
    setBooting(false)
  }, [])

  const companies = useList<{ companies: CompanyRow[] }>(session ? '/api/companies' : null)

  // ---------- company selection (restricted by role) ----------
  const multiTenant = !!session && TENANT_ADMIN_ROLES.includes(session.user.role)
  const companyList = React.useMemo(() => {
    const all = companies.data?.companies || []
    if (!session) return []
    return multiTenant ? all : all.filter((c) => c.id === session.user.companyId)
  }, [companies.data, session, multiTenant])

  React.useEffect(() => {
    if (!session || !companies.data || companyId) return
    const saved = window.localStorage.getItem('erp_company_id')
    const allowed = companyList.find((c) => c.id === saved) || companyList.find((c) => c.id === session.user.companyId) || companyList[0]
    if (allowed) setCompanyId(allowed.id)
  }, [session, companies.data, companyId, companyList])

  // Keep tenant list fresh when a Company Setup module creates/edits tenants
  React.useEffect(() => {
    const handler = () => { void companies.refetch() }
    window.addEventListener('erp:companies-changed', handler)
    return () => window.removeEventListener('erp:companies-changed', handler)
  }, [companies])

  const activeModuleDef = findModule(activeKey)
  // RBAC: fall back to dashboard when current module is not allowed for this role
  const activeModule = activeModuleDef && canAccessModule(session?.user.role, activeModuleDef.key) ? activeModuleDef : MODULES[0]

  React.useEffect(() => {
    window.scrollTo({ top: 0 })
  }, [activeKey])

  // Browser tab title follows the active module
  React.useEffect(() => {
    document.title = session ? `${activeModule.label} · ManuFlow ERP` : 'ManuFlow ERP — Manufacturing SaaS Suite'
  }, [activeModule, session])

  const notifications = useList<{ items: NotificationRow[]; unreadCount: number }>(
    session && companyId ? `/api/notifications?companyId=${companyId}&unread=1` : null,
  )
  const [notifOpen, setNotifOpen] = React.useState(false)

  // ---------- realtime notifications (socket.io via gateway) ----------
  React.useEffect(() => {
    if (!session || !companyId) return
    const socket: Socket = io('/?XTransformPort=3003', {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: 10,
      forceNew: true,
    })
    socketRef.current = socket
    socket.on('connect', () => socket.emit('join', { companyId }))
    socket.on('erp:notification', (n: { title: string; message?: string; level?: string }) => {
      const level = n.level || 'INFO'
      const run = level === 'CRITICAL' ? toast.error : level === 'WARNING' ? toast.warning : toast.info
      run(n.title, { description: n.message })
      void notifications.refetch()
    })
    return () => { socket.disconnect(); socketRef.current = null }
  }, [session, companyId])

  // ---------- command palette (global search) ----------
  const [paletteOpen, setPaletteOpen] = React.useState(false)
  const [paletteQuery, setPaletteQuery] = React.useState('')
  const [searchResults, setSearchResults] = React.useState<SearchResult[]>([])
  const [searching, setSearching] = React.useState(false)

  React.useEffect(() => {
    if (!paletteOpen || !session || !companyId) return
    const q = paletteQuery.trim()
    if (q.length < 2) { setSearchResults([]); setSearching(false); return }
    setSearching(true)
    const t = setTimeout(() => {
      apiGet<{ results: SearchResult[] }>(`/api/search?companyId=${companyId}&q=${encodeURIComponent(q)}`)
        .then((d) => setSearchResults(d.results || []))
        .catch(() => setSearchResults([]))
        .finally(() => setSearching(false))
    }, 300)
    return () => clearTimeout(t)
  }, [paletteQuery, paletteOpen, session, companyId])

  const visibleModules = React.useMemo(
    () => MODULES.filter((m) => canAccessModule(session?.user.role, m.key)),
    [session],
  )

  const favModules = React.useMemo(
    () => favs.map((k) => findModule(k)).filter((m): m is NonNullable<typeof m> => !!m && canAccessModule(session?.user.role, m.key)),
    [favs, session],
  )
  const recentModules = React.useMemo(
    () => recents.map((k) => findModule(k)).filter((m): m is NonNullable<typeof m> => !!m && canAccessModule(session?.user.role, m.key)).slice(0, 5),
    [recents, session],
  )

  // group palette search results by target module
  const groupedResults = React.useMemo(() => {
    const map = new Map<string, SearchResult[]>()
    for (const r of searchResults) {
      const list = map.get(r.module) || []
      list.push(r)
      map.set(r.module, list)
    }
    return Array.from(map.entries())
  }, [searchResults])

  function goToModule(key: string) {
    setActiveKey(key)
    setPaletteOpen(false)
    setNavOpen(false)
    setRecents((prev) => {
      const nx = [key, ...prev.filter((k) => k !== key)].slice(0, 6)
      persistJson(RECENT_KEY, nx)
      return nx
    })
  }

  function toggleFav(key: string) {
    setFavs((prev) => {
      const nx = prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]
      persistJson(FAV_KEY, nx)
      return nx
    })
  }

  function toggleCollapsed() {
    setCollapsed((prev) => {
      const nx = !prev
      try { window.localStorage.setItem(COLLAPSE_KEY, nx ? '1' : '0') } catch { /* private mode */ }
      return nx
    })
  }

  // ---------- keyboard shortcuts engine ----------
  React.useEffect(() => {
    if (!session) return
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen((o) => !o)
        return
      }
      if (paletteOpen || helpOpen || pwdOpen) return
      if (isTypingTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey) return

      // g + key sequence (Gmail-style)
      const now = Date.now()
      if (goPendingRef.current && now - goPendingRef.current < 1500) {
        goPendingRef.current = 0
        const target = GO_KEYS[e.key.toLowerCase()]
        if (target) {
          e.preventDefault()
          const def = findModule(target)
          if (def && canAccessModule(session.user.role, target)) goToModule(target)
          else if (def) toast.error(`${def.label} is not available for the ${ROLE_LABEL[session.user.role] || session.user.role} role`)
          return
        }
      }
      if (e.key === 'g') { goPendingRef.current = Date.now(); return }
      if (e.key === '?') { e.preventDefault(); setHelpOpen((o) => !o); return }
      if (e.key === '/') { e.preventDefault(); setPaletteOpen(true); return }
      if (e.key === '[' || e.key === ']') {
        e.preventDefault()
        const dir = e.key === ']' ? 1 : -1
        const idx = visibleModules.findIndex((m) => m.key === activeKey)
        const nextIdx = (idx + dir + visibleModules.length) % visibleModules.length
        const target = visibleModules[nextIdx]
        if (target) goToModule(target.key)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [session, paletteOpen, helpOpen, pwdOpen, visibleModules, activeKey])

  function toggleTheme() {
    setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')
  }

  function showProTipOnce() {
    try {
      if (!window.localStorage.getItem('erp_tip_shown')) {
        window.localStorage.setItem('erp_tip_shown', '1')
        setTimeout(() => {
          toast('Pro tips for power users', {
            description: 'Press ? for keyboard shortcuts · Ctrl+K to search · g then d to jump to Dashboard · star modules to pin them.',
          })
        }, 1500)
      }
    } catch { /* private mode */ }
  }

  function handleLogin(user: LoginUser, company: LoginCompany) {
    const s: Session = { user, company }
    window.localStorage.setItem(SESSION_KEY, JSON.stringify(s))
    window.localStorage.setItem('erp_company_id', user.companyId)
    setSession(s)
    setCompanyId(user.companyId)
    setActiveKey('dashboard')
    toast.success(`Welcome back, ${user.name.split(' ')[0]}`, { description: `${ROLE_LABEL[user.role] || user.role} · ${company.name}` })
    showProTipOnce()
  }

  async function logout() {
    try { await apiPost('/api/auth/logout', { userName: session?.user.name }) } catch { /* best effort */ }
    window.localStorage.removeItem(SESSION_KEY)
    socketRef.current?.disconnect()
    setSession(null)
    setCompanyId(null)
    setActiveKey('dashboard')
    setPaletteOpen(false)
    setPwdOpen(false)
    setHelpOpen(false)
    toast.success('Signed out')
  }

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
    } catch { /* non-blocking */ }
  }

  // ---------- auth gate ----------
  if (booting) {
    return (
      <div className="min-h-screen grid place-items-center bg-background">
        <div className="flex flex-col items-center gap-3 text-muted-foreground">
          <Loader2 className="h-7 w-7 animate-spin text-emerald-600" />
          <p className="text-sm">Loading ManuFlow ERP…</p>
        </div>
      </div>
    )
  }

  if (!session) {
    return <LoginScreen onLogin={handleLogin} />
  }

  const currentCompany = companyList.find((c) => c.id === companyId)

  function renderModuleRow(m: (typeof MODULES)[number], opts: { collapsed: boolean; star?: boolean }) {
    const active = m.key === activeKey
    const isFav = favs.includes(m.key)
    return (
      <div
        key={m.key}
        className={cn(
          'group flex items-center rounded-md transition-colors',
          active ? 'bg-emerald-600 text-white font-medium shadow-sm' : 'text-foreground/70 hover:bg-muted hover:text-foreground',
        )}
      >
        <button
          onClick={() => goToModule(m.key)}
          title={opts.collapsed ? m.label : undefined}
          className={cn(
            'flex flex-1 items-center gap-2.5 py-1.5 text-[13px] text-left min-w-0',
            opts.collapsed ? 'justify-center px-0' : 'px-2.5',
          )}
          aria-current={active ? 'page' : undefined}
        >
          <m.icon className="h-4 w-4 shrink-0" />
          {!opts.collapsed && <span className="truncate">{m.label}</span>}
        </button>
        {opts.star && !opts.collapsed && (
          <button
            onClick={() => toggleFav(m.key)}
            className={cn(
              'mr-1.5 rounded p-1 transition-opacity',
              isFav ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
              active ? 'hover:bg-white/20' : 'hover:bg-muted',
            )}
            aria-label={isFav ? `Unpin ${m.label}` : `Pin ${m.label} to favorites`}
            title={isFav ? 'Unpin' : 'Pin to favorites'}
          >
            <Star className={cn('h-3.5 w-3.5', isFav ? 'fill-amber-400 text-amber-400' : 'text-muted-foreground')} />
          </button>
        )}
      </div>
    )
  }

  function buildSidebar(isCollapsed: boolean) {
    const favRows = favModules.filter((m) => m.group !== 'Dashboard')
    return (
      <div className="flex h-full flex-col bg-card">
        <div className={cn('flex items-center gap-2.5 h-14 border-b shrink-0', isCollapsed ? 'justify-center px-0' : 'px-4')}>
          <div className="h-8 w-8 rounded-lg bg-emerald-600 text-white grid place-items-center shrink-0">
            <Factory className="h-4.5 w-4.5" />
          </div>
          {!isCollapsed && (
            <div className="leading-tight min-w-0">
              <p className="font-semibold text-sm">ManuFlow ERP</p>
              <p className="text-[10px] text-muted-foreground">Manufacturing SaaS Suite</p>
            </div>
          )}
          {navOpen && (
            <Button variant="ghost" size="icon" className="ml-auto lg:hidden h-8 w-8" onClick={() => setNavOpen(false)}>
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
        <ScrollArea className="flex-1">
          <nav className={cn('pb-6', isCollapsed ? 'p-1.5' : 'p-2')} aria-label="ERP modules">
            {favRows.length > 0 && (
              <div className="mb-1">
                {isCollapsed ? (
                  <div className="mx-2 my-2 border-t" />
                ) : (
                  <p className="px-2.5 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70 flex items-center gap-1">
                    <Star className="h-3 w-3 fill-amber-400 text-amber-400" /> Favorites
                  </p>
                )}
                {favRows.map((m) => renderModuleRow(m, { collapsed: isCollapsed, star: true }))}
              </div>
            )}
            {MODULE_GROUPS.map((group) => {
              const mods = visibleModules.filter((m) => m.group === group)
              if (!mods.length) return null
              return (
                <div key={group} className="mb-1">
                  {isCollapsed ? (
                    <div className="mx-2 my-2 border-t" />
                  ) : (
                    <p className="px-2.5 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">{group}</p>
                  )}
                  {mods.map((m) => renderModuleRow(m, { collapsed: isCollapsed, star: true }))}
                </div>
              )
            })}
          </nav>
        </ScrollArea>
        <div className={cn('border-t shrink-0', isCollapsed ? 'px-1.5 py-2.5' : 'px-4 py-2.5')}>
          {isCollapsed ? (
            <div className="h-4" aria-hidden="true" />
          ) : (
            <div className="text-[10px] text-muted-foreground truncate">
              {currentCompany ? (
                <div className="truncate">
                  <span className="font-medium text-foreground/80">{currentCompany.name}</span>
                  {currentCompany.gstin && <span className="ml-1">· GSTIN {currentCompany.gstin}</span>}
                </div>
              ) : 'Multi-tenant SaaS · FY Apr–Mar'}
            </div>
          )}
        </div>
      </div>
    )
  }

  const dark = themeMounted && resolvedTheme === 'dark'

  return (
    <div className="min-h-screen flex bg-background">
      {/* Desktop sidebar */}
      <aside className={cn('hidden lg:block border-r shrink-0 sticky top-0 h-screen transition-[width] duration-200', collapsed ? 'w-[56px]' : 'w-60')}>
        {buildSidebar(collapsed)}
      </aside>

      {/* Mobile nav overlay */}
      {navOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={() => setNavOpen(false)} />
          <div className="absolute inset-y-0 left-0 w-72 shadow-xl">{buildSidebar(false)}</div>
        </div>
      )}

      <div className="flex-1 flex flex-col min-w-0">
        {/* Topbar */}
        <header className="sticky top-0 z-40 h-14 border-b bg-card/95 backdrop-blur flex items-center gap-2 px-3 sm:px-4">
          <Button variant="ghost" size="icon" className="lg:hidden h-9 w-9 shrink-0" onClick={() => setNavOpen(true)} aria-label="Open navigation">
            <Menu className="h-5 w-5" />
          </Button>

          {/* Sidebar collapse toggle (desktop) */}
          <Button
            variant="ghost"
            size="icon"
            className="hidden lg:inline-flex h-9 w-9 shrink-0 text-muted-foreground"
            onClick={toggleCollapsed}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {collapsed ? <PanelLeftOpen className="h-4.5 w-4.5" /> : <PanelLeftClose className="h-4.5 w-4.5" />}
          </Button>

          <div className="min-w-0 flex-1">
            <h1 className="font-semibold text-sm sm:text-base truncate leading-tight">{activeModule.label}</h1>
            <p className="text-[11px] text-muted-foreground truncate leading-tight hidden sm:block">
              {activeModule.description || activeModule.group}
            </p>
          </div>

          {/* Global search trigger */}
          <Button
            variant="outline"
            size="sm"
            className="h-9 gap-1.5 text-muted-foreground font-normal shrink-0 w-9 sm:w-auto px-0 sm:px-3"
            onClick={() => setPaletteOpen(true)}
            aria-label="Search (Ctrl+K)"
          >
            <Search className="h-4 w-4" />
            <span className="hidden sm:inline text-xs">Search…</span>
            <kbd className="hidden md:inline-flex h-5 items-center gap-0.5 rounded border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground">
              <CommandIcon className="h-2.5 w-2.5" />K
            </kbd>
          </Button>

          {/* Theme toggle */}
          <Button
            variant="ghost"
            size="icon"
            className="h-9 w-9 shrink-0"
            onClick={toggleTheme}
            aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
            title={dark ? 'Light mode' : 'Dark mode'}
          >
            {dark ? <Sun className="h-4.5 w-4.5" /> : <Moon className="h-4.5 w-4.5" />}
          </Button>

          {/* Company switcher */}
          <div className="hidden sm:flex items-center gap-2">
            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              {switching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <span className="hidden md:inline">Tenant:</span>}
            </div>
            <Select value={companyId ?? ''} onValueChange={switchCompany} disabled={!multiTenant && companyList.length <= 1}>
              <SelectTrigger className="h-9 w-[130px] sm:w-[200px] text-xs" aria-label="Switch company (tenant)">
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
          </div>

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

          {/* User menu */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className="flex items-center gap-2 pl-1 sm:pl-2 shrink-0 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label="Open user menu"
              >
                <span className="h-8 w-8 rounded-full bg-teal-600 text-white grid place-items-center text-xs font-semibold">
                  {initials(session.user.name)}
                </span>
                <span className="hidden md:block text-left leading-tight">
                  <span className="block text-xs font-medium max-w-[140px] truncate">{session.user.name}</span>
                  <span className="block text-[10px] text-muted-foreground">{ROLE_LABEL[session.user.role] || session.user.role}</span>
                </span>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-60">
              <DropdownMenuLabel className="font-normal">
                <p className="text-sm font-medium truncate">{session.user.name}</p>
                <p className="text-xs text-muted-foreground truncate">{session.user.email}</p>
                <p className="text-[10px] text-muted-foreground mt-0.5">{ROLE_LABEL[session.user.role] || session.user.role} · {session.company?.name}</p>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setPwdOpen(true)}>
                <KeyRound className="h-4 w-4 mr-2" />Change password
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setHelpOpen(true)}>
                <Keyboard className="h-4 w-4 mr-2" />Keyboard shortcuts
                <Kbd className="ml-auto">?</Kbd>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={toggleTheme}>
                {dark ? <Sun className="h-4 w-4 mr-2" /> : <Moon className="h-4 w-4 mr-2" />}
                {dark ? 'Light mode' : 'Dark mode'}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => void logout()} className="text-red-600 focus:text-red-600">
                <LogOut className="h-4 w-4 mr-2" />Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
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
              <Badge variant="outline" className="text-[10px] font-normal">Signed in as {ROLE_LABEL[session.user.role] || session.user.role}</Badge>
              <Separator orientation="vertical" className="h-3 hidden sm:block" />
              <button
                onClick={() => setHelpOpen(true)}
                className="hidden sm:flex items-center gap-1 hover:text-foreground transition-colors"
                aria-label="Show keyboard shortcuts"
              >
                Shortcuts: <Kbd>?</Kbd>
              </button>
              <Separator orientation="vertical" className="h-3 hidden sm:block" />
              <span className="hidden sm:inline">FY {new Date().getMonth() + 1 >= 4 ? new Date().getFullYear() : new Date().getFullYear() - 1}–{(new Date().getMonth() + 1 >= 4 ? new Date().getFullYear() : new Date().getFullYear() - 1) + 1}</span>
            </div>
          </div>
        </footer>
      </div>

      {/* Global search / command palette */}
      <CommandDialog open={paletteOpen} onOpenChange={(o) => { setPaletteOpen(o); if (!o) { setPaletteQuery(''); setSearchResults([]) } }}>
        <CommandInput value={paletteQuery} onValueChange={setPaletteQuery} placeholder="Search modules, items, customers, orders…" />
        <CommandList>
          {searching && <div className="py-6 text-center text-sm text-muted-foreground">Searching…</div>}
          {!searching && paletteQuery.trim().length >= 2 && searchResults.length === 0 && (
            <CommandEmpty>No results found.</CommandEmpty>
          )}
          {paletteQuery.trim().length < 2 && (
            <>
              {favModules.length > 0 && (
                <CommandGroup heading="Favorites">
                  {favModules.map((m) => (
                    <CommandItem key={`fav-${m.key}`} value={`fav-${m.label}`} onSelect={() => goToModule(m.key)}>
                      <Star className="h-4 w-4 mr-2 fill-amber-400 text-amber-400" />
                      <span>{m.label}</span>
                      <span className="ml-auto text-[10px] text-muted-foreground">{m.group}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
              {recentModules.length > 0 && (
                <CommandGroup heading="Recent">
                  {recentModules.map((m) => (
                    <CommandItem key={`recent-${m.key}`} value={`recent-${m.label}`} onSelect={() => goToModule(m.key)}>
                      <Clock className="h-4 w-4 mr-2 text-muted-foreground" />
                      <span>{m.label}</span>
                      <span className="ml-auto text-[10px] text-muted-foreground">{m.group}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
              <CommandGroup heading="Modules">
                {visibleModules.map((m) => (
                  <CommandItem key={`module-${m.key}`} value={`module-${m.label}`} onSelect={() => goToModule(m.key)}>
                    <m.icon className="h-4 w-4 mr-2 text-muted-foreground" />
                    <span>{m.label}</span>
                    <span className="ml-auto text-[10px] text-muted-foreground">{m.group}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
              <CommandSeparator />
              <CommandGroup heading="Actions">
                <CommandItem value="action-theme" onSelect={() => { toggleTheme(); setPaletteOpen(false) }}>
                  {dark ? <Sun className="h-4 w-4 mr-2 text-muted-foreground" /> : <Moon className="h-4 w-4 mr-2 text-muted-foreground" />}
                  <span>{dark ? 'Light mode' : 'Dark mode'}</span>
                </CommandItem>
                <CommandItem value="action-shortcuts" onSelect={() => { setPaletteOpen(false); setHelpOpen(true) }}>
                  <Keyboard className="h-4 w-4 mr-2 text-muted-foreground" />
                  <span>Keyboard shortcuts</span>
                  <Kbd className="ml-auto">?</Kbd>
                </CommandItem>
                <CommandItem value="action-tip" onSelect={() => { setPaletteOpen(false); toast('Pro tips', { description: 'g then d → Dashboard · [ ] → prev/next module · / → search · star modules to pin.' }) }}>
                  <Sparkles className="h-4 w-4 mr-2 text-muted-foreground" />
                  <span>Show quick tips</span>
                </CommandItem>
              </CommandGroup>
            </>
          )}
          {paletteQuery.trim().length >= 2 && groupedResults.map(([moduleKey, rows]) => {
            const mod = findModule(moduleKey)
            return (
              <React.Fragment key={moduleKey}>
                <CommandSeparator />
                <CommandGroup heading={mod ? `${mod.label}` : moduleKey}>
                  {rows.map((r) => (
                    <CommandItem key={`${r.type}-${r.id}`} value={`${r.type}-${r.id}-${r.label}`} onSelect={() => goToModule(r.module)}>
                      <Search className="h-3.5 w-3.5 mr-2 text-muted-foreground" />
                      <span className="truncate">{r.label}</span>
                      {r.sub && <span className="ml-auto text-[10px] text-muted-foreground truncate max-w-[140px]">{r.sub}</span>}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </React.Fragment>
            )
          })}
        </CommandList>
        <div className="border-t px-3 py-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground shrink-0">
          <span className="flex items-center gap-1"><Kbd>↑</Kbd><Kbd>↓</Kbd> navigate</span>
          <span className="flex items-center gap-1"><Kbd>↵</Kbd> open</span>
          <span className="flex items-center gap-1"><Kbd>Esc</Kbd> close</span>
          <span className="hidden sm:flex items-center gap-1"><Kbd>g</Kbd>+<Kbd>d</Kbd> go to module</span>
          <button className="ml-auto flex items-center gap-1 hover:text-foreground" onClick={() => { setPaletteOpen(false); setHelpOpen(true) }}>
            <Kbd>?</Kbd> all shortcuts
          </button>
        </div>
      </CommandDialog>

      {/* Keyboard shortcuts help */}
      <ShortcutsDialog open={helpOpen} onOpenChange={setHelpOpen} />

      {/* Change password */}
      <ChangePasswordDialog
        open={pwdOpen}
        onOpenChange={setPwdOpen}
        userId={session.user.id}
        userName={session.user.name}
      />
    </div>
  )
}
