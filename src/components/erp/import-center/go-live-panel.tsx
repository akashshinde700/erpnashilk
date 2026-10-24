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
      .catch((e) => toast.error('Go-live date मिळाली नाही', { description: e instanceof Error ? e.message : undefined }))
    return () => { cancelled = true }
  }, [companyId])

  async function save() {
    setSaving(true)
    try {
      const g = await api<GoLive>('/api/import-center/go-live', { method: 'PUT', body: JSON.stringify({ companyId, goLiveDate: draft }) })
      setState(g)
      onChangeRef.current(g)
      toast.success('Go-live date जतन झाली')
    } catch (e) {
      toast.error('Go-live date जतन झाली नाही', { description: e instanceof Error ? e.message : undefined })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Alert className="mt-3">
      <CalendarClock className="h-4 w-4" />
      <AlertTitle>Go-live date {state?.goLiveDate ? `· ${fmtDate(state.goLiveDate)}` : '· अजून ठरवलेली नाही'}</AlertTitle>
      <AlertDescription>
        <p>
          ज्या दिवसापासून तुमचे हिशोब ManuFlow मध्ये ठेवले जातील तो दिवस. Opening stock त्याच्या आदल्या दिवशीच्या तारखेने
          {state?.openingDate ? ` (${fmtDate(state.openingDate)})` : ''} नोंदवला जातो — त्यामुळे तो खरेदी किंवा नफा म्हणून नाही, तर सुरुवातीचा साठा म्हणून मोजला जातो.
        </p>
        {state?.locked ? (
          <p className="mt-2 flex items-center gap-1.5 font-medium"><Lock className="h-3.5 w-3.5" /> Lock झाली आहे — या तारखेने opening stock आधीच Import झाला आहे, त्यामुळे ती बदलता येत नाही.</p>
        ) : (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Input type="date" value={draft} onChange={(e) => setDraft(e.target.value)} className="h-9 w-44" aria-label="Go-live date निवडा" />
            <Button size="sm" variant="outline" disabled={!draft || draft === state?.goLiveDate || saving} onClick={() => void save()}>
              {state?.goLiveDate ? 'तारीख बदला' : 'Go-live date जतन करा'}
            </Button>
          </div>
        )}
      </AlertDescription>
    </Alert>
  )
}
