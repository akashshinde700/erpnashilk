'use client'

import * as React from 'react'
import { CalendarClock, Lock } from 'lucide-react'
import { toast } from 'sonner'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { fmtDate } from '@/lib/erp-constants'
import { api, apiGet } from '@/lib/use-api'

export interface GoLive { goLiveDate: string | null; locked: boolean; importedRows: number; openingDate: string | null }

/** Go-live (cutover) date of the company: shown for opening figures, settable until opening stock is imported. */
export default function GoLivePanel({ companyId, onChange }: { companyId: string; onChange: (g: GoLive | null) => void }) {
  const [state, setState] = React.useState<GoLive | null>(null)
  const [draft, setDraft] = React.useState('')
  const [saving, setSaving] = React.useState(false)
  // Latest onChange for the async load below (refs are updated in an effect, never during render).
  // Declared before the load effect, so it has run by the time the fetch resolves.
  const onChangeRef = React.useRef(onChange)
  React.useEffect(() => { onChangeRef.current = onChange })

  React.useEffect(() => {
    let cancelled = false
    apiGet<GoLive>(`/api/import-center/go-live?companyId=${companyId}`)
      .then((g) => { if (!cancelled) { setState(g); setDraft(g.goLiveDate ?? ''); onChangeRef.current(g) } })
      .catch((e) => toast.error('Could not load the go-live date', { description: e instanceof Error ? e.message : undefined }))
    return () => { cancelled = true }
  }, [companyId])

  async function save() {
    setSaving(true)
    try {
      const g = await api<GoLive>('/api/import-center/go-live', { method: 'PUT', body: JSON.stringify({ companyId, goLiveDate: draft }) })
      setState(g)
      onChangeRef.current(g)
      toast.success('Go-live date saved')
    } catch (e) {
      toast.error('Could not save the go-live date', { description: e instanceof Error ? e.message : undefined })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Alert className="mt-3">
      <CalendarClock className="h-4 w-4" />
      <AlertTitle>Go-live date {state?.goLiveDate ? `· ${fmtDate(state.goLiveDate)}` : '· not set'}</AlertTitle>
      <AlertDescription>
        <p>
          The first day your books are kept in ManuFlow. Opening stock is recorded on the day before
          {state?.openingDate ? ` (${fmtDate(state.openingDate)})` : ''}, so it counts as opening stock — not as purchases or profit.
        </p>
        {state?.locked ? (
          <p className="mt-2 flex items-center gap-1.5 font-medium"><Lock className="h-3.5 w-3.5" /> Locked — opening stock has already been imported against this date, so it cannot be changed.</p>
        ) : (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Input type="date" value={draft} onChange={(e) => setDraft(e.target.value)} className="h-9 w-44" aria-label="Go-live date" />
            <Button size="sm" variant="outline" disabled={!draft || draft === state?.goLiveDate || saving} onClick={() => void save()}>
              {state?.goLiveDate ? 'Change date' : 'Save go-live date'}
            </Button>
          </div>
        )}
      </AlertDescription>
    </Alert>
  )
}
