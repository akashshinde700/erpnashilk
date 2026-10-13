'use client'

import * as React from 'react'
import { ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { setPinPrompt } from '@/lib/use-api'

/**
 * Security PIN prompt (Settings → Security). Mounted once by the app shell; it registers itself
 * with api() via setPinPrompt, which awaits it when the server replies 423 PIN_REQUIRED.
 */
export default function PinDialog() {
  const [open, setOpen] = React.useState(false)
  const [reason, setReason] = React.useState<string | null>(null)
  const [pin, setPin] = React.useState('')
  // Several guarded requests may ask at once — they all get the same answer.
  const waiting = React.useRef<((v: string | null) => void)[]>([])

  const finish = React.useCallback((value: string | null) => {
    const list = waiting.current
    waiting.current = []
    setOpen(false)
    setPin('')
    for (const resolve of list) resolve(value)
  }, [])

  React.useEffect(() => {
    setPinPrompt((why) => new Promise<string | null>((resolve) => {
      waiting.current.push(resolve)
      setReason(why)
      setPin('')
      setOpen(true)
    }))
    return () => {
      setPinPrompt(null)
      const list = waiting.current
      waiting.current = []
      for (const resolve of list) resolve(null)
    }
  }, [])

  function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!/^\d{4,6}$/.test(pin)) return
    finish(pin)
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) finish(null) }}>
      <DialogContent className="sm:max-w-xs">
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-emerald-600" /> Security PIN
            </DialogTitle>
            <DialogDescription>
              {reason === 'Wrong security PIN'
                ? 'That PIN was wrong — try again.'
                : 'This action changes a saved document. Enter the company security PIN to continue.'}
            </DialogDescription>
          </DialogHeader>
          <Input
            type="password"
            inputMode="numeric"
            autoComplete="off"
            autoFocus
            maxLength={6}
            placeholder="4–6 digit PIN"
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
            className="text-center tracking-[0.5em] text-lg"
            aria-invalid={reason === 'Wrong security PIN' || undefined}
          />
          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" onClick={() => finish(null)}>Cancel</Button>
            <Button type="submit" disabled={!/^\d{4,6}$/.test(pin)} className="bg-emerald-600 hover:bg-emerald-700 text-white">
              Continue
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
