'use client'

import * as React from 'react'
import { WifiOff, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'

/**
 * Connection banner for the app shell.
 *
 * Manufacturing users are frequently on a shop-floor Wi-Fi that drops. Two rules:
 *  1. Never imply a transaction was saved while offline — the banner says explicitly that nothing is
 *     being saved, and the app's own API calls surface their real errors.
 *  2. Nothing is queued or replayed. Stock movements and invoices are *not* buffered offline; that
 *     would need an idempotent sync design and server-side reconciliation.
 *
 * `navigator.onLine` is only a hint (it is true on a captive portal), so this is a status notice,
 * not a gate: requests still go out and fail honestly.
 */
export function ConnectionStatus() {
  const [online, setOnline] = React.useState(true)
  const [mounted, setMounted] = React.useState(false)

  React.useEffect(() => {
    setMounted(true)
    setOnline(navigator.onLine)
    const up = () => setOnline(true)
    const down = () => setOnline(false)
    window.addEventListener('online', up)
    window.addEventListener('offline', down)
    return () => {
      window.removeEventListener('online', up)
      window.removeEventListener('offline', down)
    }
  }, [])

  // Render nothing on the server and in the online state: zero layout shift, no hydration mismatch.
  if (!mounted || online) return null

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center gap-2 border-b border-warning-border bg-warning-soft px-3 py-2 text-xs text-warning sm:px-4"
    >
      <WifiOff className="h-4 w-4 shrink-0" aria-hidden="true" />
      <p className="min-w-0 flex-1">
        <span className="font-semibold">You&apos;re offline.</span>{' '}
        <span className="hidden sm:inline">
          Lists already on screen show their last loaded values. Nothing you enter now is saved, and no stock
          or invoice entry is queued — reconnect to continue.
        </span>
        <span className="sm:hidden">Nothing is saved until you reconnect.</span>
      </p>
      <Button
        variant="outline"
        size="sm"
        className="h-7 shrink-0 gap-1 border-warning-border px-2 text-[11px]"
        onClick={() => window.location.reload()}
      >
        <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
        Retry
      </Button>
    </div>
  )
}
