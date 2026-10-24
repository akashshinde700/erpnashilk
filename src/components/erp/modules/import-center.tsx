'use client'

import * as React from 'react'
import { ArrowRight, BookOpen, FileSpreadsheet, Store } from 'lucide-react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { PageHeader } from '@/components/erp/kit'
import ImportWizard, { type ImportEntry } from '@/components/erp/import-center/import-wizard'
import ImportHistory from '@/components/erp/import-center/import-history'
import { useList } from '@/lib/use-api'
import { cn } from '@/lib/utils'

const CARDS: { entry: ImportEntry; emoji: string; button: string; text: string; note: string; icon: typeof BookOpen; tone: string }[] = [
  {
    entry: 'tally', emoji: '📘', button: 'Tally मधून डेटा आणा', icon: BookOpen,
    text: 'Tally मधील उपलब्ध Business Data ManuFlow ERP मध्ये आणा.',
    note: 'आत्ता: Tally मधून Export केलेली Excel / CSV फाइल',
    tone: 'text-sky-700 dark:text-sky-400 bg-sky-50 dark:bg-sky-950/40',
  },
  {
    entry: 'vyapar', emoji: '🟢', button: 'Vyapar मधून डेटा आणा', icon: Store,
    text: 'Vyapar मधील समर्थित डेटा किंवा Export केलेली फाइल Import करा.',
    note: 'आत्ता: Vyapar मधून Export केलेली Excel फाइल',
    tone: 'text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/40',
  },
  {
    entry: 'excel', emoji: '📊', button: 'Excel / CSV मधून डेटा आणा', icon: FileSpreadsheet,
    text: 'Excel किंवा CSV फाइल निवडा आणि काही सोप्या Steps मध्ये डेटा Import करा.',
    note: 'Customers, Suppliers, Items, Opening Stock',
    tone: 'text-violet-700 dark:text-violet-400 bg-violet-50 dark:bg-violet-950/40',
  },
]

export default function ImportCenterModule({ companyId }: { companyId: string }) {
  // A new key per opening gives every wizard a fresh, empty state
  const [wizard, setWizard] = React.useState<{ entry: ImportEntry; key: number } | null>(null)
  const companies = useList<{ companies: { id: string; name: string }[] }>('/api/companies')
  const companyName = companies.data?.companies.find((c) => c.id === companyId)?.name ?? ''

  return (
    <div>
      <PageHeader title="Import Center" description="Tally, Vyapar किंवा Excel मधून डेटा सोप्या Steps मध्ये आणा" />
      <Tabs defaultValue="import">
        <TabsList>
          <TabsTrigger value="import">नवीन Import</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>
        <TabsContent value="import" className="mt-4">
          <div className="grid gap-4 md:grid-cols-3">
            {CARDS.map((c) => (
              <div key={c.entry} className="flex flex-col rounded-xl border bg-card p-5 shadow-sm">
                <div className={cn('grid h-12 w-12 place-items-center rounded-xl text-2xl', c.tone)} aria-hidden>{c.emoji}</div>
                <h3 className="mt-3 flex items-center gap-2 text-lg font-semibold"><c.icon className="h-5 w-5 text-muted-foreground" aria-hidden /> {c.button.replace(' मधून डेटा आणा', '')}</h3>
                <p className="mt-1 flex-1 text-sm text-muted-foreground">{c.text}</p>
                <p className="mt-2 text-xs text-muted-foreground">{c.note}</p>
                <button
                  type="button"
                  onClick={() => setWizard({ entry: c.entry, key: Date.now() })}
                  className="mt-4 inline-flex min-h-12 items-center justify-center gap-2 rounded-lg bg-emerald-600 px-4 text-base font-medium text-white transition-colors hover:bg-emerald-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600 focus-visible:ring-offset-2"
                >
                  <span aria-hidden>{c.emoji}</span> {c.button} <ArrowRight className="h-4 w-4" aria-hidden />
                </button>
              </div>
            ))}
          </div>
          <p className="mt-4 text-xs text-muted-foreground">
            Preview करताना काहीही save होत नाही. “होय, Import करा” दाबल्यावरच डेटा ManuFlow मध्ये येतो, आणि प्रत्येक Import History मध्ये नोंदवला जातो.
          </p>
        </TabsContent>
        <TabsContent value="history" className="mt-4">
          <ImportHistory companyId={companyId} />
        </TabsContent>
      </Tabs>

      {wizard && (
        <ImportWizard
          key={wizard.key}
          entry={wizard.entry}
          open
          onOpenChange={(o) => { if (!o) setWizard(null) }}
          companyId={companyId}
          companyName={companyName}
        />
      )}
    </div>
  )
}
