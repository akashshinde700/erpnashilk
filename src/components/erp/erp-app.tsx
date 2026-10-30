'use client'

import * as React from 'react'
import { useTheme } from 'next-themes'
import { toast } from 'sonner'
import { io, type Socket } from 'socket.io-client'
import {
  Bell, Building2, CheckCheck, ChevronRight, Factory, Keyboard, KeyRound, Loader2, LogOut, Menu, Moon, PanelLeftClose, PanelLeftOpen,
  Search, Star, Sun, X, Command as CommandIcon, Clock, Sparkles, Plus,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from '@/components/ui/select'
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
import { fmtDateTime, ROLE_LABEL, canAccessModule, MODULE_PARENT } from '@/lib/erp-constants'
import { apiGet, apiPatch, apiPost, useList, UNAUTHORIZED_EVENT } from '@/lib/use-api'
import { MODULE_TAB_EVENT } from '@/components/erp/tab-group'
import { MODULES, MODULE_GROUPS, findModule } from '@/components/erp/registry'
import { defaultFilter } from 'cmdk'
import { Kbd, NEW_DOC_EVENT, openCreate } from '@/components/erp/kit'
import LoginScreen, { type LoginUser, type LoginCompany } from '@/components/erp/login-screen'
import { ConnectionStatus } from '@/components/erp/connection-status'
import ShortcutsDialog from '@/components/erp/shortcuts-help'
import ChangePasswordDialog from '@/components/erp/change-password-dialog'
import PinDialog from '@/components/erp/pin-dialog'
import MoneyConfirmDialog from '@/components/erp/money-confirm-dialog'
import { CreateFirmDialog, SWITCH_COMPANY_EVENT } from '@/components/erp/modules/company-setup'

interface CompanyRow {
  id: string
  name: string
  gstin?: string | null
  city?: string | null
  stateCode?: string | null
  logoText?: string | null
  isHome?: boolean
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
  INFO: 'bg-info',
  WARNING: 'bg-brand-accent',
  CRITICAL: 'bg-destructive',
}

// The platform administrator can switch between every company; other users only between
// their home company and firms linked to their login (the server returns just those).
const TENANT_ADMIN_ROLES = ['SUPER_ADMIN']
// Only a tenant admin may create additional firms (server-enforced in POST /api/firms).
const FIRM_CREATOR_ROLE = 'TENANT_ADMIN'
const NEW_FIRM_VALUE = '__new_firm__'

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
  h: 'deliveries',
  g: 'grns',
  y: 'payments',
  k: 'receivables',
  f: 'purchase-invoices',
  x: 'parties',
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

/**
 * Extra words the command palette should match. Module labels are short ("Outstanding"), but people
 * search with the domain words they know ("receivables", "dues") — without aliases those searches
 * come back empty even though the screen exists. Kept next to the palette so it is one list to groom.
 */
const PALETTE_ALIASES: Record<string, string> = {
  'dashboard': 'home overview kpi business',
  'items': 'item master products sku raw material finished goods bom part',
  'parties': 'customers suppliers vendors clients ledger',
  'warehouses': 'store godown location',
  'machines': 'machine shop floor capacity',
  'boms': 'bill of materials bom recipe components',
  'users-roles': 'users roles team staff permissions employees',
  'enquiries-quotes': 'enquiry quotation quote estimate proposal rfq',
  'sales-orders': 'so sales order po customer order booking',
  'deliveries': 'delivery challan dispatch shipment',
  'sales-invoices': 'invoice bill tax invoice gst billing sales',
  'sales-returns': 'credit note return sales return',
  'purchase-orders': 'purchase order po supplier order',
  'grns': 'grn goods receipt inward material receipt',
  'purchase-invoices': 'purchase invoice bill vendor bill expense',
  'purchase-returns': 'debit note purchase return',
  'requisitions': 'purchase requisition pr indenting',
  'stock-hub': 'stock inventory balance on hand valuation',
  'stock-movements': 'stock transfer adjustment issue correction',
  'production': 'work order production shop floor wip manufacturing',
  'mrp': 'mrp material requirement planning planning shortage',
  'qc-inspections': 'qc quality inspection check rejection',
  'outstanding': 'receivables payables outstanding dues ageing overdue collection',
  'cash-bank': 'cash bank contra loan payment receipt accounts',
  'expenses': 'expense spend purchase cost',
  'gst-report': 'gst gstr tax report cgst sgst igst hsn',
  'reports': 'reports analytics dashboard sales purchase profit',
  'import-center': 'import tally vyapar excel csv migration',
  'settings-hub': 'settings company profile numbering firm',
  'activity': 'notifications audit log activity history',
}

/** Extra search terms for a module (cmdk `keywords`): its group, description and the domain aliases. */
function paletteKeywords(m: (typeof MODULES)[number]): string[] {
  return [m.group, m.description ?? '', ...(PALETTE_ALIASES[m.key] ?? '').split(' ')].filter(Boolean)
}

/**
 * Ranking, not just filtering, for the command palette.
 *
 * Aliases (see PALETTE_ALIASES) make more screens findable — "receivables" now finds Outstanding — but an
 * alias hit must never outrank a real label hit: someone who types "GST" and presses Enter has to land on
 * GST Reports, not on a screen that merely mentions GST in its keywords. Anything that is not a palette
 * entry (records, cross-module rows) keeps the stock cmdk score, so record search behaves as before.
 *
 * Pure function on purpose: it lives at module scope so it cannot be called conditionally.
 */
function paletteFilter(value: string, search: string, keywords?: string[]): number {
  const base = defaultFilter(value, search, keywords)
  if (base <= 0) return 0
  const q = search.trim().toLowerCase()
  if (!q) return 1
  const labelled = /^(?:module|recent|action)-(.+)$/.exec(value)
  if (!labelled) return base
  const label = labelled[1].toLowerCase()
  if (label === q) return 1
  if (label.startsWith(q)) return 0.95
  if (label.includes(q)) return 0.9
  return Math.min(base, 0.4) // alias-only hit ranks below every label hit
}

export default function ErpApp() {
  const [session, setSession] = React.useState<Session | null>(null)
  const [booting, setBooting] = React.useState(true)
  const [companyId, setCompanyId] = React.useState<string | null>(null)
  const [activeKey, setActiveKey] = React.useState('dashboard')
  const [navOpen, setNavOpen] = React.useState(false)
  const drawerRef = React.useRef<HTMLDivElement | null>(null)

  /**
   * Mobile navigation drawer behaviour. The panel is a modal surface, so while it is open the page
   * behind it must not scroll, Escape must close it, Tab must stay inside it, and focus must go back
   * to the hamburger when it closes. (Selecting an item closes the drawer in goToModule.)
   */
  React.useEffect(() => {
    if (!navOpen) return
    const panel = drawerRef.current
    const previouslyFocused = document.activeElement as HTMLElement | null
    const bodyOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden' // no background scroll on touch or wheel

    const focusables = () =>
      Array.from(
        panel?.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      ).filter((el) => el.offsetParent !== null)

    focusables()[0]?.focus()

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        setNavOpen(false)
        return
      }
      if (e.key !== 'Tab') return
      const list = focusables()
      if (list.length === 0) return
      const first = list[0]
      const last = list[list.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = bodyOverflow
      previouslyFocused?.focus?.()
    }
  }, [navOpen])
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
      setCollapsed(window.localStorage.getItem(COLLAPSE_KEY) === '1')
      setFavs(readJsonArray(FAV_KEY))
      setRecents(readJsonArray(RECENT_KEY))
    } catch { /* private mode */ }
    setThemeMounted(true)
    // The httpOnly session cookie is the source of truth: confirm it with the server
    // before showing the app (the localStorage copy only carries display data).
    let cancelled = false
    apiGet<Session>('/api/auth/me')
      .then((s) => {
        if (cancelled) return
        window.localStorage.setItem(SESSION_KEY, JSON.stringify(s))
        setSession(s)
      })
      .catch(() => {
        try { window.localStorage.removeItem(SESSION_KEY) } catch { /* ignore */ }
      })
      .finally(() => { if (!cancelled) setBooting(false) })
    return () => { cancelled = true }
  }, [])

  // Server rejected the session (expired, password/role changed, deactivated) → back to login.
  React.useEffect(() => {
    const onUnauthorized = (e: Event) => {
      window.localStorage.removeItem(SESSION_KEY)
      setSession((prev) => {
        if (prev) toast.error((e as CustomEvent<string | undefined>).detail || 'Your session has ended — sign in again')
        return null
      })
      setCompanyId(null)
    }
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized)
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized)
  }, [])

  const companies = useList<{ companies: CompanyRow[] }>(session ? '/api/companies' : null)

  // ---------- company selection (restricted by role) ----------
  const multiTenant = !!session && TENANT_ADMIN_ROLES.includes(session.user.role)
  const canCreateFirm = !!session && session.user.role === FIRM_CREATOR_ROLE
  const [firmOpen, setFirmOpen] = React.useState(false)
  // Server already scopes the list: every tenant for SUPER_ADMIN, home + linked firms otherwise.
  const companyList = React.useMemo(() => {
    if (!session) return []
    return companies.data?.companies || []
  }, [companies.data, session])
  const canSwitch = multiTenant || companyList.length > 1 || canCreateFirm

  React.useEffect(() => {
    if (!session || !companies.data || companyId) return
    const saved = window.localStorage.getItem('erp_company_id')
    const allowed = companyList.find((c) => c.id === saved) || companyList.find((c) => c.id === session.user.companyId) || companyList[0]
    if (allowed) {
      // Keep the x-company-id header in step (a stale id would be rejected by the server).
      try { window.localStorage.setItem('erp_company_id', allowed.id) } catch { /* private mode */ }
      setCompanyId(allowed.id)
    }
  }, [session, companies.data, companyId, companyList])

  // Keep tenant list fresh when a Company Setup module creates/edits tenants
  React.useEffect(() => {
    const handler = () => { void companies.refetch() }
    window.addEventListener('erp:companies-changed', handler)
    return () => window.removeEventListener('erp:companies-changed', handler)
  }, [companies])

  // Other screens (Company Setup) can ask to switch firm, e.g. right after creating one.
  const switchRef = React.useRef<(id: string) => void>(() => {})
  React.useEffect(() => {
    const handler = (e: Event) => {
      const id = (e as CustomEvent<string>).detail
      if (typeof id === 'string' && id) switchRef.current(id)
    }
    window.addEventListener(SWITCH_COMPANY_EVENT, handler)
    return () => window.removeEventListener(SWITCH_COMPANY_EVENT, handler)
  }, [])

  // Screens hosted as a tab (e.g. Customers inside Parties) render inside their group entry.
  const routedKey = MODULE_PARENT[activeKey] ?? activeKey

  // Sidebar accordion: one module group open at a time — the one you're working in.
  const activeGroup = findModule(routedKey)?.group ?? 'Dashboard'
  const [openGroup, setOpenGroup] = React.useState<string | null>(null)
  React.useEffect(() => { setOpenGroup(activeGroup) }, [activeGroup])
  const activeModuleDef = findModule(routedKey)
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

  // Without the realtime socket, poll the unread badge once a minute while the tab is visible.
  React.useEffect(() => {
    if (process.env.NEXT_PUBLIC_REALTIME === '1' || !session || !companyId) return
    const t = window.setInterval(() => {
      if (document.visibilityState === 'visible') void notifications.refetch()
    }, 60000)
    return () => window.clearInterval(t)
  }, [session, companyId, notifications.refetch])

  // ---------- realtime notifications (socket.io via gateway) ----------
  // Off unless NEXT_PUBLIC_REALTIME=1: needs the notify-service behind the Caddy gateway, and its
  // rooms are joined by companyId without auth. Notifications still refresh through the API.
  React.useEffect(() => {
    if (process.env.NEXT_PUBLIC_REALTIME !== '1') return
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
    () => MODULES.filter((m) => !m.hidden && canAccessModule(session?.user.role, m.key)),
    [session],
  )

  // Old favourites/recents pointing at a tab screen resolve to its group entry.
  const listedModule = (k: string) => findModule(MODULE_PARENT[k] ?? k)
  const favModules = React.useMemo(
    () => favs.map(listedModule).filter((m, i, a): m is NonNullable<typeof m> => !!m && a.indexOf(m) === i && canAccessModule(session?.user.role, m.key)),
    [favs, session],
  )
  const recentModules = React.useMemo(
    () => recents.map(listedModule).filter((m, i, a): m is NonNullable<typeof m> => !!m && a.indexOf(m) === i && canAccessModule(session?.user.role, m.key)).slice(0, 5),
    [recents, session],
  )

  // Tab screens live inside a group entry: any navigation to one (search result, shortcut, quick
  // action, old favourite) switches the group to that tab, then settles the key on the group.
  React.useEffect(() => {
    const parent = MODULE_PARENT[activeKey]
    if (!parent) return
    // The group entry is already mounted (routedKey), so the event reaches its listener.
    window.dispatchEvent(new CustomEvent(MODULE_TAB_EVENT, { detail: activeKey }))
    setActiveKey(parent)
  }, [activeKey])

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

  function goToModule(key: string, preset?: { q?: string }) {
    // Filter preset: sessionStorage covers not-yet-mounted modules, the live event covers the already-mounted one
    if (preset && typeof preset.q === 'string' && preset.q.length > 0) {
      try {
        window.sessionStorage.setItem('erp_filter_preset', JSON.stringify({ module: key, q: preset.q, ts: Date.now() }))
      } catch { /* private mode */ }
      window.dispatchEvent(new CustomEvent('erp:filter-preset', { detail: { module: key, q: preset.q } }))
    }
    setActiveKey(key)
    setPaletteOpen(false)
    setPaletteQuery('') // programmatic close bypasses onOpenChange — clear stale query/results
    setSearchResults([])
    setNavOpen(false)
    setRecents((prev) => {
      const nx = [key, ...prev.filter((k) => k !== key)].slice(0, 6)
      persistJson(RECENT_KEY, nx)
      return nx
    })
  }

  // Module navigation events (dashboard quick actions / KPI + chart drill-down) —
  // detail may be a plain module key string or { key, preset? }
  React.useEffect(() => {
    const handler = (e: Event) => {
      const detail: unknown = (e as CustomEvent).detail
      if (typeof detail === 'string') {
        if (findModule(detail)) goToModule(detail)
        return
      }
      if (detail && typeof detail === 'object') {
        const key = (detail as { key?: unknown }).key
        if (typeof key !== 'string' || !findModule(key)) return
        const preset = (detail as { preset?: unknown }).preset
        goToModule(key, preset && typeof preset === 'object' && typeof (preset as { q?: unknown }).q === 'string'
          ? (preset as { q?: string })
          : undefined)
      }
    }
    window.addEventListener('erp:goto', handler)
    return () => window.removeEventListener('erp:goto', handler)
  }, [goToModule])

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
      // Vyapar-style: Alt+S new sale invoice, Alt+P new purchase bill (works from anywhere, not inside dialogs)
      if (e.altKey && !e.ctrlKey && !e.metaKey && (e.code === 'KeyS' || e.code === 'KeyP') && !document.querySelector('[role="dialog"]')) {
        const target = e.code === 'KeyS' ? 'sales-invoices' : 'purchase-invoices'
        e.preventDefault()
        if (canAccessModule(session.user.role, target)) openCreate(target)
        else toast.error(`${findModule(target)?.label} is not available for your role`)
        return
      }
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
      // n = new document on the current screen (ignored while any dialog is open)
      if (e.key === 'n' && !document.querySelector('[role="dialog"]')) { e.preventDefault(); window.dispatchEvent(new CustomEvent(NEW_DOC_EVENT)); return }
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
    // The platform operator lands on the organizations console.
    if (user.role === 'SUPER_ADMIN') {
      window.location.href = '/platform-admin'
      return
    }
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
    try { await apiPost('/api/auth/logout', {}) } catch { /* best effort */ }
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
    if (id === NEW_FIRM_VALUE) {
      setFirmOpen(true)
      return
    }
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
  React.useEffect(() => { switchRef.current = switchCompany })

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
      <div className="min-h-screen-safe grid place-items-center bg-background" role="status" aria-live="polite">
        <div className="flex flex-col items-center gap-3">
          <div className="grid h-11 w-11 place-items-center rounded-xl bg-primary text-primary-foreground elev-1">
            <Factory className="h-5 w-5" aria-hidden="true" />
          </div>
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin text-primary" aria-hidden="true" />
            <p className="text-sm">Loading ManuFlow ERP…</p>
          </div>
          <div className="h-1 w-32 overflow-hidden rounded-full bg-muted">
            <div className="h-full w-1/2 animate-pulse rounded-full bg-primary/60" />
          </div>
        </div>
      </div>
    )
  }

  if (!session) {
    return <LoginScreen onLogin={handleLogin} />
  }

  const currentCompany = companyList.find((c) => c.id === companyId)

  function renderModuleRow(m: (typeof MODULES)[number], opts: { collapsed: boolean; star?: boolean }) {
    const active = m.key === routedKey
    const isFav = favs.includes(m.key)
    return (
      <div
        key={m.key}
        className={cn(
        'group relative flex items-center rounded-lg transition-colors duration-150',
        active
        ? 'bg-primary font-medium text-primary-foreground shadow-sm'
        : 'text-foreground/75 hover:bg-sidebar-accent hover:text-foreground',
        )}
      >
        <button
          onClick={() => goToModule(m.key)}
          title={opts.collapsed ? m.label : undefined}
          className={cn(
          'flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 py-1.5 text-left text-[13px]',
          opts.collapsed ? 'justify-center px-0' : 'px-2.5',
          )}
          aria-current={active ? 'page' : undefined}
        >
          <m.icon className={cn('h-4 w-4 shrink-0', active ? 'opacity-100' : 'text-muted-foreground group-hover:text-primary')} aria-hidden="true" />
          {!opts.collapsed && <span className="truncate">{m.label}</span>}
        </button>
        {opts.star && !opts.collapsed && (
          <button
            onClick={() => toggleFav(m.key)}
            className={cn(
              'mr-1.5 cursor-pointer rounded p-1 transition-opacity',
              isFav ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
              active ? 'hover:bg-primary-foreground/20' : 'hover:bg-muted',
            )}
            aria-label={isFav ? `Unpin ${m.label}` : `Pin ${m.label} to favorites`}
            title={isFav ? 'Unpin' : 'Pin to favorites'}
          >
            <Star className={cn('h-3.5 w-3.5', isFav ? 'fill-brand-accent text-brand-accent' : 'text-muted-foreground')} aria-hidden="true" />
          </button>
        )}
      </div>
    )
  }

  function buildSidebar(isCollapsed: boolean) {
    const favRows = favModules.filter((m) => m.group !== 'Dashboard')
    return (
      <div className="flex h-full flex-col bg-card">
        <div className={cn('flex h-14 shrink-0 items-center gap-2.5 border-b', isCollapsed ? 'justify-center px-0' : 'px-4')}>
        <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground elev-1">
        <Factory className="h-4 w-4" aria-hidden="true" />
        </div>
        {!isCollapsed && (
        <div className="min-w-0 leading-tight">
        <p className="text-sm font-semibold tracking-tight">ManuFlow ERP</p>
              <p className="text-[10px] text-muted-foreground">Manufacturing SaaS Suite</p>
            </div>
          )}
          {navOpen && (
            <Button
              variant="ghost"
              size="icon"
              className="ml-auto h-9 w-9 shrink-0 lg:hidden"
              onClick={() => setNavOpen(false)}
              aria-label="Close navigation"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </Button>
          )}
        </div>
        {/* Native scroll: min-h-0 lets the list shrink inside the full-height column, so it scrolls with a visible bar */}
        <div className="sidebar-scroll flex-1 min-h-0 overflow-y-auto overscroll-contain">
          <nav className={cn('pb-6', isCollapsed ? 'p-1.5' : 'p-2')} aria-label="ERP modules">
            {favRows.length > 0 && (
              <div className="mb-1">
                {isCollapsed ? (
                  <div className="mx-2 my-2 border-t" />
                ) : (
                  <p className="flex items-center gap-1 px-2.5 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  <Star className="h-3 w-3 fill-brand-accent text-brand-accent" aria-hidden="true" /> Favorites
                  </p>
                )}
                {favRows.map((m) => renderModuleRow(m, { collapsed: isCollapsed, star: true }))}
              </div>
            )}
            {MODULE_GROUPS.map((group) => {
              const mods = visibleModules.filter((m) => m.group === group)
              if (!mods.length) return null
              // Icon-only rail and the single-item Dashboard group are always expanded.
              if (isCollapsed || group === 'Dashboard') {
                return (
                  <div key={group} className="mb-1">
                    {isCollapsed ? <div className="mx-2 my-2 border-t" /> : <div className="pt-1" />}
                    {mods.map((m) => renderModuleRow(m, { collapsed: isCollapsed, star: true }))}
                  </div>
                )
              }
              const open = openGroup === group
              const hasActive = group === activeGroup
              return (
                <div key={group} className="mb-0.5">
                  <button
                    type="button"
                    onClick={() => setOpenGroup(open ? null : group)}
                    aria-expanded={open}
                    className={cn(
                      'flex w-full cursor-pointer items-center gap-1.5 rounded-md px-2.5 pb-1.5 pt-2.5 text-[10px] font-semibold uppercase tracking-wider transition-colors hover:text-foreground',
                      hasActive && !open ? 'text-primary' : 'text-muted-foreground',
                    )}
                  >
                    <span className="flex-1 text-left">{group}</span>
                    {!open && <span className="rounded bg-muted px-1.5 text-[10px] font-medium normal-case tracking-normal text-muted-foreground">{mods.length}</span>}
                    <ChevronRight className={cn('h-3.5 w-3.5 transition-transform duration-200', open && 'rotate-90')} aria-hidden="true" />
                  </button>
                  {open && mods.map((m) => renderModuleRow(m, { collapsed: false, star: true }))}
                </div>
              )
            })}
          </nav>
        </div>
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
    <div className="min-h-screen-safe flex bg-background">
      {/* Desktop sidebar */}
      <aside className={cn('h-screen-safe sticky top-0 hidden shrink-0 border-r bg-sidebar transition-[width] duration-200 lg:block', collapsed ? 'w-[60px]' : 'w-60')}>
        {buildSidebar(collapsed)}
      </aside>

      {/* Mobile nav overlay */}
      {navOpen && (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
          <div className="absolute inset-0 bg-foreground/40 backdrop-blur-[2px]" onClick={() => setNavOpen(false)} aria-hidden="true" />
          <div
            ref={drawerRef}
            className="pb-safe pt-safe absolute inset-y-0 left-0 flex w-[min(18rem,85vw)] flex-col overflow-hidden border-r bg-sidebar elev-2"
          >
            {buildSidebar(false)}
          </div>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <ConnectionStatus />
        {/* Topbar */}
        <header className="pt-safe sticky top-0 z-40 flex h-[calc(3.5rem+env(safe-area-inset-top))] items-center gap-1.5 border-b bg-card/85 px-2 backdrop-blur-md supports-[backdrop-filter]:bg-card/70 sm:gap-2 sm:px-4">
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
            <h1 className="truncate text-sm font-semibold leading-tight tracking-tight sm:text-[15px]">{activeModule.label}</h1>
            <p className="text-[11px] text-muted-foreground truncate leading-tight hidden sm:block">
              {activeModule.description || activeModule.group}
            </p>
          </div>

          {/* Global search trigger */}
          <Button
            variant="outline"
            size="sm"
            className="h-9 w-9 shrink-0 gap-1.5 px-0 font-normal text-muted-foreground transition-colors hover:text-foreground sm:w-auto sm:px-3"
            onClick={() => setPaletteOpen(true)}
            aria-label="Search records (Ctrl+K)"
          >
            <Search className="h-4 w-4" aria-hidden="true" />
            <span className="hidden text-xs sm:inline">Search…</span>
            <kbd className="ml-1 hidden h-5 items-center gap-0.5 rounded border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground md:inline-flex">
            <CommandIcon className="h-2.5 w-2.5" aria-hidden="true" />K
            </kbd>
          </Button>

          {/* Theme toggle */}
          <Button
            variant="ghost"
            size="icon"
            className="hidden h-9 w-9 shrink-0 sm:inline-flex"
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
            <Select value={companyId ?? ''} onValueChange={switchCompany} disabled={!canSwitch}>
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
                {canCreateFirm && (
                  <>
                    <SelectSeparator />
                    <SelectItem value={NEW_FIRM_VALUE} className="text-xs text-success">
                      <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                      Create new firm
                    </SelectItem>
                  </>
                )}
              </SelectContent>
            </Select>
          </div>

          {/* Notifications */}
          <Popover open={notifOpen} onOpenChange={setNotifOpen}>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="icon" className="relative h-9 w-9 shrink-0" aria-label={`Notifications (${notifications.data?.unreadCount || 0} unread)`}>
                <Bell className="h-4.5 w-4.5" />
                {!!notifications.data?.unreadCount && (
                  <span className="absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-destructive px-0.5 text-[9px] font-semibold text-destructive-foreground ring-2 ring-card">
                    {notifications.data.unreadCount > 9 ? '9+' : notifications.data.unreadCount}
                  </span>
                )}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-80 p-0">
              <div className="flex items-center justify-between px-3 py-2 border-b">
                <p className="text-sm font-medium">Notifications</p>
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs text-primary hover:bg-primary/10 hover:text-primary"
                    onClick={() => { setNotifOpen(false); goToModule('notifications') }}
                  >
                    View all
                  </Button>
                  <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => void markAllRead()}>
                    <CheckCheck className="h-3.5 w-3.5 mr-1" />Mark all read
                  </Button>
                </div>
              </div>
              <ScrollArea className="max-h-80">
                {(notifications.data?.items || []).length === 0 ? (
                  <div className="flex flex-col items-center gap-1.5 py-8 text-center">
                      <CheckCheck className="h-5 w-5 text-success" aria-hidden="true" />
                      <p className="text-xs text-muted-foreground">You&apos;re all caught up</p>
                    </div>
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
                className="flex shrink-0 cursor-pointer items-center gap-2 rounded-full pl-1 outline-none transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring sm:pl-2"
                aria-label="Open user menu"
              >
                <span className="grid h-8 w-8 place-items-center rounded-full bg-primary text-xs font-semibold text-primary-foreground ring-1 ring-inset ring-black/10 dark:ring-white/15">
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
              {session.user.role === 'SUPER_ADMIN' && (
                <DropdownMenuItem onSelect={() => { window.location.href = '/platform-admin' }}>
                  <Building2 className="h-4 w-4 mr-2" />Platform Admin
                </DropdownMenuItem>
              )}
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
              <DropdownMenuItem onSelect={() => void logout()} className="text-destructive focus:text-destructive">
                <LogOut className="h-4 w-4 mr-2" />Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </header>

        {/* Content */}
        <main
  id="erp-main"
  tabIndex={-1}
  className="mx-auto w-full max-w-[1600px] flex-1 px-3 py-4 pb-6 sm:px-5 sm:py-5 lg:px-6 lg:py-6"
>
          {!companyId || switching ? (
            <div className="h-64 grid place-items-center">
              <div className="flex flex-col items-center gap-3 text-muted-foreground" role="status" aria-live="polite">
              <Loader2 className="h-5 w-5 animate-spin text-primary" aria-hidden="true" />
              <p className="text-sm">Loading workspace…</p>
              </div>
            </div>
          ) : (
            <activeModule.component key={`${companyId}-${routedKey}`} companyId={companyId} />
          )}
        </main>

        {/* Sticky footer */}
        <footer className="mt-auto border-t bg-card/60 pb-safe">
          <div className="mx-auto flex max-w-[1600px] flex-col items-center justify-between gap-1.5 px-4 py-3 text-xs text-muted-foreground sm:flex-row">
            <div className="flex items-center gap-1.5">
              <Factory className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
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
      <CommandDialog filter={paletteFilter} open={paletteOpen} onOpenChange={(o) => { setPaletteOpen(o); if (!o) { setPaletteQuery(''); setSearchResults([]) } }}>
        <CommandInput value={paletteQuery} onValueChange={setPaletteQuery} placeholder="Search modules, items, customers, orders…" />
        <CommandList>
          {searching && <div className="py-6 text-center text-sm text-muted-foreground">Searching…</div>}
          {!searching && <CommandEmpty>No results found.</CommandEmpty>}
          {/* Favorites / Recents / Modules / Actions — always rendered; cmdk filters by query,
              so typing a module name (e.g. “settings”) still jumps straight to it. */}
          {(
            <>
              {favModules.length > 0 && (
                <CommandGroup heading="Favorites">
                  {favModules.map((m) => (
                    <CommandItem key={`fav-${m.key}`} value={`fav-${m.label}`} onSelect={() => goToModule(m.key)}>
                      <Star className="mr-2 h-4 w-4 fill-brand-accent text-brand-accent" aria-hidden="true" />
                      <span>{m.label}</span>
                      <span className="ml-auto text-[10px] text-muted-foreground">{m.group}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
              {recentModules.length > 0 && (
                <CommandGroup heading="Recent">
                  {recentModules.map((m) => (
                    <CommandItem key={`recent-${m.key}`} value={`recent-${m.label}`} keywords={paletteKeywords(m)} onSelect={() => goToModule(m.key)}>
                      <Clock className="h-4 w-4 mr-2 text-muted-foreground" />
                      <span>{m.label}</span>
                      <span className="ml-auto text-[10px] text-muted-foreground">{m.group}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
              <CommandGroup heading="Modules">
                {visibleModules.map((m) => (
                  <CommandItem key={`module-${m.key}`} value={`module-${m.label}`} keywords={paletteKeywords(m)} onSelect={() => goToModule(m.key)}>
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
                    <CommandItem
                      key={`${r.type}-${r.id}`}
                      value={`${r.type}-${r.id}-${r.label}`}
                      onSelect={() => {
                        // deep-link: target module scrolls to + highlights this record's row
                        try {
                          window.sessionStorage.setItem('erp_deep_link', JSON.stringify({ module: r.module, id: r.id, ts: Date.now() }))
                          window.dispatchEvent(new CustomEvent('erp:deep-link', { detail: { module: r.module, id: r.id } }))
                        } catch { /* ignore */ }
                        goToModule(r.module)
                      }}
                    >
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

      {/* Security PIN prompt — registers itself with api() via setPinPrompt */}
      <PinDialog />

      {/* Possible duplicate / negative cash confirmations — registers itself with api() via setMoneyPrompt */}
      <MoneyConfirmDialog />

      {/* Create new firm (tenant admin) — switches to it once created */}
      {canCreateFirm && (
        <CreateFirmDialog open={firmOpen} onOpenChange={setFirmOpen} onCreated={(firm) => switchCompany(firm.id)} />
      )}

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
