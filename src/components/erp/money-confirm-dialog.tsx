'use client'

import * as React from 'react'
import { AlertTriangle, Copy } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { setMoneyPrompt, type MoneyPrompt } from '@/lib/use-api'

type Ask = Parameters<MoneyPrompt>[0]

/**
 * Cash & Bank Phase 5 confirmations. Mounted once by the app shell; it registers itself with api() via
 * setMoneyPrompt. api() opens it when the server refuses an entry as a possible duplicate (any user may confirm) or
 * because it takes a cash account below zero (only shown to a Tenant Admin / Super Admin — the server checks the role
 * again). The form behind stays open with its values and its Save button busy until the answer is known.
 */
export default function MoneyConfirmDialog() {
  const [ask, setAsk] = React.useState<Ask | null>(null)
  // Concurrent questions are answered one at a time, in order
  const queue = React.useRef<{ ask: Ask; resolve: (v: boolean) => void }[]>([])

  const showNext = React.useCallback(() => setAsk(queue.current[0]?.ask ?? null), [])

  const answer = React.useCallback((value: boolean) => {
    const head = queue.current.shift()
    head?.resolve(value)
    showNext()
  }, [showNext])

  React.useEffect(() => {
    setMoneyPrompt((a) => new Promise<boolean>((resolve) => {
      queue.current.push({ ask: a, resolve })
      if (queue.current.length === 1) showNext()
    }))
    return () => {
      setMoneyPrompt(null)
      const list = queue.current
      queue.current = []
      for (const q of list) q.resolve(false)
    }
  }, [showNext])

  const duplicate = ask?.kind === 'duplicate'
  return (
    <Dialog open={!!ask} onOpenChange={(o) => { if (!o) answer(false) }}>
      <DialogContent className="sm:max-w-md max-sm:w-[calc(100%-2rem)]" data-testid="money-confirm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {duplicate
              ? <><Copy className="h-5 w-5 text-warning" /> Possible duplicate</>
              : <><AlertTriangle className="h-5 w-5 text-destructive" /> Cash will go below zero</>}
          </DialogTitle>
          <DialogDescription className="text-left">{ask?.message}</DialogDescription>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          {duplicate
            ? 'Check the entries listed above. Save only if this is a separate, real transaction.'
            : 'As an administrator you can save it anyway; the override is recorded in the audit log.'}
        </p>
        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" autoFocus onClick={() => answer(false)}>Cancel</Button>
          <Button
            type="button"
            onClick={() => answer(true)}
            className={duplicate ? 'bg-brand-accent text-brand-accent-foreground hover:bg-brand-accent/90' : 'bg-destructive text-destructive-foreground hover:bg-destructive/90'}
          >
            {duplicate ? 'Save anyway' : 'Save anyway (admin override)'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
