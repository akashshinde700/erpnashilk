'use client'

import * as React from 'react'
import { ArrowRight, BookOpen, FileSpreadsheet, Store } from 'lucide-react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { PageHeader } from '@/components/erp/kit'
import ImportWizard, { type ImportEntry } from '@/components/erp/import-center/import-wizard'
import ImportHistory from '@/components/erp/import-center/import-history'
import TallyImport from '@/components/erp/import-center/tally-import'
import { useList } from '@/lib/use-api'
import { cn } from '@/lib/utils'

const CARDS: { entry: ImportEntry; emoji: string; title: string; text: string; button: string; icon: typeof BookOpen; tone: string }[] = [
  {
    entry: 'tally', emoji: '📘', title: 'Tally', icon: BookOpen,
    text: 'Import business data from Tally into ManuFlow ERP.',
    button: 'Import from Tally',
    tone: 'text-sky-700 dark:text-sky-400 bg-sky-50 dark:bg-sky-950/40',
  },
  {
    entry: 'vyapar', emoji: '🟢', title: 'Vyapar', icon: Store,
    text: 'Import supported Vyapar data or exported files into ManuFlow ERP.',
    button: 'Import from Vyapar',
    tone: 'text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/40',
  },
  {
    entry: 'excel', emoji: '📊', title: 'Excel / CSV', icon: FileSpreadsheet,
    text: 'Select a file and import your data in a few simple steps.',
    button: 'Import from Excel / CSV',
    tone: 'text-violet-700 dark:text-violet-400 bg-violet-50 dark:bg-violet-950/40',
  },
]

export default function ImportCenterModule({ companyId }: { companyId: string }) {
  // A new key per opening gives every wizard a fresh, empty state
  const [wizard, setWizard] = React.useState<{ entry: ImportEntry; key: number } | null>(null)
  // Tally opens the connector flow; its "use a file instead" link opens the file wizard
  const [tally, setTally] = React.useState<number | null>(null)
  const companies = useList<{ companies: { id: string; name: string }[] }>('/api/companies')
  const companyName = companies.data?.companies.find((c) => c.id === companyId)?.name ?? ''

  return (
    <div>
      <PageHeader title="Import Center" description="Import data from Tally, Vyapar, or Excel in a few simple steps." />
      <Tabs defaultValue="import">
        <TabsList>
          <TabsTrigger value="import">New Import</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>
        <TabsContent value="import" className="mt-4">
          <div className="grid gap-4 md:grid-cols-3">
            {CARDS.map((c) => (
              <div key={c.entry} className="flex flex-col rounded-xl border bg-card p-5 shadow-sm">
                <div className={cn('grid h-12 w-12 place-items-center rounded-xl text-2xl', c.tone)} aria-hidden>{c.emoji}</div>
                <h3 className="mt-3 flex items-center gap-2 text-lg font-semibold"><c.icon className="h-5 w-5 text-muted-foreground" aria-hidden /> {c.title}</h3>
                <p className="mt-1 flex-1 text-sm text-muted-foreground">{c.text}</p>
                <button
                  type="button"
                  onClick={() => (c.entry === 'tally' ? setTally(Date.now()) : setWizard({ entry: c.entry, key: Date.now() }))}
                  className="mt-4 inline-flex min-h-12 items-center justify-center gap-2 rounded-lg bg-emerald-600 px-4 text-base font-medium text-white transition-colors hover:bg-emerald-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600 focus-visible:ring-offset-2"
                >
                  {c.button} <ArrowRight className="h-4 w-4" aria-hidden />
                </button>
              </div>
            ))}
          </div>
          <p className="mt-4 text-xs text-muted-foreground">
            Your data is not saved during preview. It is imported into ManuFlow only after you confirm the import. Every import is recorded in Import History.
          </p>
        </TabsContent>
        <TabsContent value="history" className="mt-4">
          <ImportHistory companyId={companyId} />
        </TabsContent>
      </Tabs>

      {tally !== null && (
        <TallyImport
          key={tally}
          open
          onOpenChange={(o) => { if (!o) setTally(null) }}
          companyId={companyId}
          companyName={companyName}
          onUseFile={() => { setTally(null); setWizard({ entry: 'tally', key: Date.now() }) }}
        />
      )}
      {wizard && (
        <ImportWizard
          key={wizard.key}
          entry={wizard.entry}
          open
          onOpenChange={(o) => { if (!o) setWizard(null) }}
          companyId={companyId}
          companyName={companyName}
          onConnectDirect={wizard.entry === 'tally' ? () => { setWizard(null); setTally(Date.now()) } : undefined}
        />
      )}
    </div>
  )
}
