'use client'

import * as React from 'react'
import type { ComponentType } from 'react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { canAccessModule } from '@/lib/erp-constants'

/** Window event that switches a tab group to one of its tabs: detail = child module key. */
export const MODULE_TAB_EVENT = 'erp:module-tab'

export interface TabDef {
  key: string // child module key (also its RBAC key)
  label: string
  component: ComponentType<{ companyId: string }>
}

/**
 * One sidebar entry that hosts several related modules as tabs (e.g. Parties = Customers + Suppliers).
 * Only the tabs the signed-in role may access are shown; with a single tab it renders that module
 * directly. Navigating to a child key (search, shortcuts, quick actions) opens the right tab.
 */
export function makeTabGroup(tabs: TabDef[]): ComponentType<{ companyId: string }> {
  function TabGroupModule({ companyId }: { companyId: string }) {
    const [role, setRole] = React.useState<string | null>(null)
    const [tab, setTab] = React.useState(tabs[0].key)

    React.useEffect(() => {
      try {
        const s = JSON.parse(window.localStorage.getItem('erp_user') || '{}') as { user?: { role?: string } }
        setRole(s.user?.role ?? null)
      } catch { /* private mode */ }
      const onTab = (e: Event) => {
        const t = (e as CustomEvent<string>).detail
        if (tabs.some((x) => x.key === t)) setTab(t)
      }
      window.addEventListener(MODULE_TAB_EVENT, onTab)
      return () => window.removeEventListener(MODULE_TAB_EVENT, onTab)
    }, [])

    if (!role) return null
    const allowed = tabs.filter((t) => canAccessModule(role, t.key))
    if (!allowed.length) return null
    if (allowed.length === 1) {
      const Only = allowed[0].component
      return <Only companyId={companyId} />
    }
    const active = allowed.some((t) => t.key === tab) ? tab : allowed[0].key
    return (
      <Tabs value={active} onValueChange={setTab} className="gap-4">
        <TabsList className="max-w-full overflow-x-auto">
          {allowed.map((t) => <TabsTrigger key={t.key} value={t.key}>{t.label}</TabsTrigger>)}
        </TabsList>
        {allowed.map((t) => (
          <TabsContent key={t.key} value={t.key}><t.component companyId={companyId} /></TabsContent>
        ))}
      </Tabs>
    )
  }
  return TabGroupModule
}
