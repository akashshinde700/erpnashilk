'use client'

import { CheckCircle2, Circle, KeyRound, Loader2, RefreshCw, ShieldAlert, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { CONNECT_STEPS, type ConnectFailure, type ConnectStep, type StepState } from '@/lib/tally/flow'
import { cn } from '@/lib/utils'

/**
 * The screens of the automatic Tally connection (Import from Tally, step 1). Presentation only: tally-import.tsx runs
 * the checks against the server and passes in what they found (src/lib/tally/flow.ts → autoConnectProgress).
 */

const STEP_ICON: Record<StepState, { icon: typeof Circle; tone: string; label: string }> = {
  done: { icon: CheckCircle2, tone: 'text-success', label: 'done' },
  active: { icon: Loader2, tone: 'text-primary', label: 'in progress' },
  pending: { icon: Circle, tone: 'text-muted-foreground/60', label: 'waiting' },
  failed: { icon: XCircle, tone: 'text-destructive', label: 'failed' },
}

/** "Connecting to TallyPrime…": spinner, then each step as the server confirms it. */
export function ConnectingCard({ steps, note }: { steps: Record<ConnectStep, StepState>; note?: string }) {
  const active = CONNECT_STEPS.find((s) => steps[s.key] === 'active')
  return (
    <div className="mx-auto flex max-w-md flex-col items-center px-2 py-6 text-center" data-testid="tally-auto-connect" data-step={active?.key ?? 'none'}>
      <div className="relative grid h-16 w-16 place-items-center" aria-hidden>
        <span className="absolute inset-0 rounded-full border-4 border-muted" />
        <span className="absolute inset-0 animate-spin rounded-full border-4 border-transparent border-t-primary" />
      </div>
      <h3 className="mt-5 text-lg font-semibold">Connecting to TallyPrime…</h3>
      <p className="mt-1 text-sm text-muted-foreground">Searching for your Tally connector and establishing a secure connection.</p>
      <ol className="mt-5 w-full space-y-2 text-left" aria-label="Connection progress">
        {CONNECT_STEPS.map((s) => {
          const st = STEP_ICON[steps[s.key]]
          return (
            <li key={s.key} data-testid={`connect-step-${s.key}`} data-state={steps[s.key]}
              className={cn('flex items-center gap-2.5 text-sm', steps[s.key] === 'pending' ? 'text-muted-foreground' : 'text-foreground')}>
              <st.icon className={cn('h-4 w-4 shrink-0', st.tone, steps[s.key] === 'active' && 'animate-spin')} aria-hidden />
              <span>{s.label}<span className="sr-only"> ({st.label})</span></span>
            </li>
          )
        })}
      </ol>
      <p className="mt-4 min-h-5 text-xs text-muted-foreground" role="status" aria-live="polite">{note || active?.label}</p>
    </div>
  )
}

/** The connection could not be made automatically: what failed, why, what to do, and Retry. */
export function ConnectErrorCard({ failure, onRetry, onUseFile, retrying, children }: {
  failure: ConnectFailure; onRetry?: () => void; onUseFile: () => void; retrying?: boolean; children?: React.ReactNode
}) {
  return (
    <div className="space-y-4 rounded-lg border border-danger-border p-4 sm:p-5" data-testid="tally-connect-error" role="alert">
      <div className="flex items-start gap-3">
        <XCircle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" aria-hidden />
        <div className="min-w-0 space-y-3">
          <h3 className="text-base font-semibold">{failure.title}</h3>
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Why this can happen</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm">{failure.why.map((w) => <li key={w}>{w}</li>)}</ul>
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">What you can do</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm">{failure.todo.map((t) => <li key={t}>{t}</li>)}</ul>
          </div>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {onRetry && (
          <Button onClick={onRetry} disabled={retrying} className="bg-primary text-primary-foreground hover:bg-primary/90">
            <RefreshCw className={cn('mr-2 h-4 w-4', retrying && 'animate-spin')} aria-hidden /> Retry
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={onUseFile}>Import an Excel / CSV file instead</Button>
      </div>
      {children}
    </div>
  )
}

/** First time on a computer, or after the saved authorisation stopped working: the one-time code is needed. */
export function PairingIntro({ reason }: { reason: 'not_paired' | 'pairing' | 'auth_failed' }) {
  const again = reason === 'auth_failed'
  return (
    <div className="flex items-start gap-3 rounded-lg bg-muted/40 p-4" data-testid="tally-pairing-intro">
      {again ? <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-destructive" aria-hidden /> : <KeyRound className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden />}
      <div className="space-y-1">
        <h3 className="text-base font-semibold">{again ? 'This computer must be authorized again' : 'Authorize the Tally connector (one time)'}</h3>
        <p className="text-sm text-muted-foreground">
          {again
            ? 'ManuFlow did not accept the connector’s saved authorization. For your security it is not renewed automatically: create a new one-time code and pair the computer again.'
            : 'ManuFlow reads TallyPrime through a small connector on your office computer. It has to be authorized once with a one-time code from an administrator; after that, Import from Tally connects by itself.'}
        </p>
      </div>
    </div>
  )
}
