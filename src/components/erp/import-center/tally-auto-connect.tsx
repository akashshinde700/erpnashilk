'use client'

import { CheckCircle2, Circle, KeyRound, Loader2, PlugZap, RefreshCw, ShieldAlert, XCircle } from 'lucide-react'
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
// Shown next to each step, so the state is not told by colour alone
const STEP_WORD: Record<StepState, string> = { done: 'Done', active: 'Checking…', pending: 'Waiting', failed: 'Failed' }

/** "Connecting to TallyPrime…": spinner, then each step as the server confirms it. */
export function ConnectingCard({ steps, note }: { steps: Record<ConnectStep, StepState>; note?: string }) {
  const active = CONNECT_STEPS.find((s) => steps[s.key] === 'active')
  return (
    <div className="mx-auto flex max-w-md flex-col items-center px-2 py-4 text-center sm:py-8" data-testid="tally-auto-connect" data-step={active?.key ?? 'none'}>
      <div className="relative grid h-20 w-20 place-items-center" aria-hidden>
        <span className="absolute inset-0 rounded-full bg-success-soft" />
        <span className="absolute inset-1.5 rounded-full border-4 border-muted" />
        <span className="absolute inset-1.5 animate-spin rounded-full border-4 border-transparent border-t-primary" />
        <PlugZap className="relative h-6 w-6 text-success" />
      </div>
      <h3 className="mt-6 text-lg font-semibold tracking-tight sm:text-xl">Connecting to TallyPrime…</h3>
      <p className="mt-1.5 text-sm text-muted-foreground">Searching for your Tally connector and establishing a secure connection.</p>
      <ol className="mt-6 w-full divide-y overflow-hidden rounded-xl border bg-card text-left shadow-xs" aria-label="Connection progress">
        {CONNECT_STEPS.map((s) => {
          const state = steps[s.key]
          const st = STEP_ICON[state]
          return (
            <li key={s.key} data-testid={`connect-step-${s.key}`} data-state={state}
              className={cn('flex items-center gap-3 px-4 py-3 text-sm transition-colors',
                state === 'pending' ? 'text-muted-foreground' : 'text-foreground', state === 'active' && 'bg-success-soft/60')}>
              <st.icon className={cn('h-4 w-4 shrink-0', st.tone, state === 'active' && 'animate-spin')} aria-hidden />
              <span className={cn('flex-1', state === 'active' && 'font-medium')}>{s.label}<span className="sr-only"> ({st.label})</span></span>
              <span className={cn('text-xs', state === 'failed' ? 'text-destructive' : 'text-muted-foreground')} aria-hidden>{STEP_WORD[state]}</span>
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
    <div className="overflow-hidden rounded-xl border border-danger-border bg-card shadow-xs" data-testid="tally-connect-error" role="alert">
      <div className="flex items-start gap-3 border-b border-danger-border bg-danger-soft px-4 py-4 sm:px-5">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-background" aria-hidden>
          <XCircle className="h-5 w-5 text-destructive" />
        </span>
        <h3 className="min-w-0 self-center text-base font-semibold">{failure.title}</h3>
      </div>
      <div className="space-y-5 px-4 py-5 sm:px-5">
        <div className="grid gap-5 sm:grid-cols-2">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Why this can happen</p>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">{failure.why.map((w) => <li key={w}>{w}</li>)}</ul>
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">What you can do</p>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">{failure.todo.map((t) => <li key={t}>{t}</li>)}</ul>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {onRetry && (
            <Button onClick={onRetry} disabled={retrying} className="rounded-lg bg-primary px-5 text-primary-foreground hover:bg-primary/90">
              <RefreshCw className={cn('mr-2 h-4 w-4', retrying && 'animate-spin')} aria-hidden /> Retry
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={onUseFile}>Import an Excel / CSV file instead</Button>
        </div>
        {children}
      </div>
    </div>
  )
}

/** First time on a computer, or after the saved authorisation stopped working: the one-time code is needed. */
export function PairingIntro({ reason }: { reason: 'not_paired' | 'pairing' | 'auth_failed' }) {
  const again = reason === 'auth_failed'
  return (
    <div className={cn('flex items-start gap-4 rounded-xl border p-4 sm:p-5', again ? 'border-danger-border bg-danger-soft' : 'border-success-border bg-success-soft')} data-testid="tally-pairing-intro">
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-background shadow-xs" aria-hidden>
        {again ? <ShieldAlert className="h-5 w-5 text-destructive" /> : <KeyRound className="h-5 w-5 text-success" />}
      </span>
      <div className="min-w-0 space-y-1.5">
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
