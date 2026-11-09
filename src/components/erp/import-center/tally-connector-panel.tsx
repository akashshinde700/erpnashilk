'use client'

import * as React from 'react'
import { ArrowUpCircle, Clock, KeyRound, Loader2, PlugZap, RefreshCw, ShieldAlert, Unplug, XCircle } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { fmtDateTime } from '@/lib/erp-constants'
import { friendlyError } from '@/lib/import/wizard-helpers'
import type { ConnectorState, ConnectorStatus } from '@/lib/tally/connector'
import { apiDelete, apiGet, apiPost, currentRole } from '@/lib/use-api'
import { cn } from '@/lib/utils'

const ADMIN_ROLES = ['TENANT_ADMIN', 'MANAGEMENT', 'SUPER_ADMIN']
const POLL_MS = 10_000
// Right after a code is created or a connector is paired, the first check-in should show within seconds
const FAST_POLL_MS = 3_000

export const CONNECTOR_BADGE: Record<ConnectorState, { label: string; tone: string; icon: React.ElementType }> = {
  unavailable: { label: 'Connector not available', tone: 'text-muted-foreground', icon: Unplug },
  not_paired: { label: 'Not connected', tone: 'text-muted-foreground', icon: Unplug },
  pairing: { label: 'Waiting for pairing', tone: 'border-warning-border text-warning', icon: Clock },
  connecting: { label: 'Connecting…', tone: 'border-warning-border text-warning', icon: Loader2 },
  connected: { label: 'Connected to Tally', tone: 'border-success-border text-success', icon: PlugZap },
  tally_error: { label: 'Connector online · Tally not reachable', tone: 'border-danger-border text-destructive', icon: XCircle },
  reconnecting: { label: 'Reconnecting…', tone: 'border-warning-border text-warning', icon: RefreshCw },
  offline: { label: 'Connector offline', tone: 'border-danger-border text-destructive', icon: XCircle },
  auth_failed: { label: 'Authentication failed', tone: 'border-danger-border text-destructive', icon: ShieldAlert },
  outdated: { label: 'Connector update required', tone: 'border-warning-border text-warning', icon: ArrowUpCircle },
}

// The pairing code is needed once per computer, and again only after "Authentication failed"; otherwise the connector
// reconnects by itself and pairing a new computer is a secondary action.
const NEEDS_PAIRING: ConnectorState[] = ['not_paired', 'pairing', 'auth_failed']

/**
 * "Connect Tally" through the ManuFlow Tally Connector (src/lib/tally/connector.ts).
 * Shows only what the server reports; when the connector is switched off on the server it says so and offers nothing.
 * First time on a computer: an administrator creates a one-time code (the device authorisation). After that the
 * connector reconnects by itself and this panel only reports its state.
 */
export default function TallyConnectorPanel({ companyId, onStatus }: { companyId: string; onStatus?: (s: ConnectorStatus) => void }) {
  const [status, setStatus] = React.useState<ConnectorStatus | null>(null)
  const [code, setCode] = React.useState<{ code: string; expiresAt: string } | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [confirmOff, setConfirmOff] = React.useState(false)
  const [error, setError] = React.useState('')
  const isAdmin = ADMIN_ROLES.includes(currentRole())
  const url = `/api/import-center/tally/connector?companyId=${companyId}`

  const load = React.useCallback(async () => {
    try {
      const s = await apiGet<ConnectorStatus>(url)
      setStatus(s)
      onStatus?.(s)
      if (s.state !== 'pairing' && !s.pairingExpiresAt) setCode(null) // used or expired
    } catch (e) {
      setError(friendlyError(e))
    }
  }, [url, onStatus])

  React.useEffect(() => { void load() }, [load])
  const live = status && status.state !== 'unavailable' && status.state !== 'not_paired'
  const waiting = status?.state === 'pairing' || status?.state === 'connecting'
  React.useEffect(() => {
    if (!live) return
    const t = setInterval(() => void load(), waiting ? FAST_POLL_MS : POLL_MS)
    return () => clearInterval(t)
  }, [live, waiting, load])

  async function connect() {
    setBusy(true); setError('')
    try {
      setCode(await apiPost<{ code: string; expiresAt: string }>(url, {}))
      await load()
    } catch (e) {
      setError(friendlyError(e))
    } finally {
      setBusy(false)
    }
  }

  async function disconnect() {
    setBusy(true); setError(''); setConfirmOff(false)
    try {
      await apiDelete(url)
      setCode(null)
      await load()
    } catch (e) {
      setError(friendlyError(e))
    } finally {
      setBusy(false)
    }
  }

  if (!status) {
    return error
      ? <p className="rounded-xl border border-danger-border bg-danger-soft px-4 py-3 text-sm text-destructive" role="alert">{error}</p>
      : <p className="flex items-center gap-2 rounded-xl border px-4 py-3 text-sm text-muted-foreground" role="status"><Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Checking the Tally connector…</p>
  }

  const b = CONNECTOR_BADGE[status.state]
  const c = status.connector
  const paired = !!c
  const needsPairing = NEEDS_PAIRING.includes(status.state)
  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  return (
    <div className="space-y-4 rounded-xl border bg-card p-4 shadow-xs sm:p-5" data-testid="tally-connector">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className={cn('gap-1.5 rounded-full px-3 py-1 text-sm', b.tone)}>
          <b.icon className={cn('h-4 w-4', status.state === 'connecting' && 'animate-spin')} aria-hidden /> {b.label}
        </Badge>
        <span className="flex-1" />
        {status.state === 'not_paired' && isAdmin && (
          <Button onClick={() => void connect()} disabled={busy} className="rounded-lg bg-primary px-5 text-primary-foreground hover:bg-primary/90">
            {busy ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <KeyRound className="h-4 w-4 mr-2" />} Connect Tally
          </Button>
        )}
        {(status.state === 'pairing' || status.state === 'auth_failed') && isAdmin && !confirmOff && (
          <Button size="sm" variant={status.state === 'auth_failed' ? 'default' : 'outline'} onClick={() => void connect()} disabled={busy} className="rounded-lg">
            <KeyRound className="h-4 w-4 mr-1.5" /> {status.state === 'pairing' ? 'New code' : 'Pair again'}
          </Button>
        )}
        {paired && !needsPairing && isAdmin && !confirmOff && (
          <Button size="sm" variant="ghost" onClick={() => void connect()} disabled={busy} title="Only needed to move the connector to another computer">
            <KeyRound className="h-4 w-4 mr-1.5" /> Pair another computer
          </Button>
        )}
        {(paired || status.state === 'pairing') && isAdmin && (
          confirmOff
            ? <>
                <Button size="sm" variant="destructive" onClick={() => void disconnect()} disabled={busy} className="rounded-lg">Yes, disconnect</Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmOff(false)}>Keep</Button>
              </>
            : <Button size="sm" variant="ghost" onClick={() => setConfirmOff(true)} disabled={busy}>
                <Unplug className="h-4 w-4 mr-1.5" /> {paired ? 'Disconnect' : 'Cancel'}
              </Button>
        )}
        {status.state !== 'unavailable' && status.state !== 'not_paired' && (
          <Button size="icon" variant="ghost" onClick={() => void load()} disabled={busy} aria-label="Check the connection again" title="Check again">
            <RefreshCw className="h-4 w-4" />
          </Button>
        )}
      </div>

      <p className="text-sm" role="status">{status.message}</p>
      {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
      {status.state !== 'unavailable' && !isAdmin && !paired && (
        <p className="text-sm text-muted-foreground">Ask an administrator to connect Tally.</p>
      )}

      {c && (
        <dl className="grid gap-x-6 gap-y-3 rounded-lg bg-muted/30 p-4 text-sm sm:grid-cols-2">
          <ConnectorFact label="Last check-in">{c.lastSeenAt ? fmtDateTime(c.lastSeenAt) : 'Never'}</ConnectorFact>
          <ConnectorFact label="Last successful Tally contact">{c.lastSuccessAt ? fmtDateTime(c.lastSuccessAt) : 'Never'}</ConnectorFact>
          {c.tallyEndpoint && <ConnectorFact label="Tally address (in your office)">{c.tallyEndpoint}{c.latencyMs != null ? ` · ${c.latencyMs} ms` : ''}</ConnectorFact>}
          <ConnectorFact label="Computer">{c.deviceName || 'Name not reported'}{c.platform ? ` · ${c.platform}` : ''}{c.version ? ` · connector v${c.version}` : ''}</ConnectorFact>
          <ConnectorFact label="Paired">{fmtDateTime(c.pairedAt)}</ConnectorFact>
        </dl>
      )}
      {c?.updateAvailable && status.state !== 'outdated' && (
        <p className="text-xs text-muted-foreground">A newer connector version is available; this one keeps working.</p>
      )}

      {code && (
        <div className="overflow-hidden rounded-xl border border-success-border" role="region" aria-label="Pairing code and instructions">
          <div className="flex flex-col gap-3 bg-success-soft px-4 py-4 sm:flex-row sm:items-center sm:px-5">
            <KeyRound className="hidden h-5 w-5 shrink-0 text-success sm:block" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium text-muted-foreground">Pairing code</p>
              <p className="mt-0.5"><span className="select-all font-mono text-2xl font-semibold tracking-[0.2em]" data-testid="pairing-code">{code.code}</span></p>
            </div>
            <p className="text-xs text-muted-foreground sm:max-w-[15rem] sm:text-right">
              Valid until {fmtDateTime(code.expiresAt)}, for one use only. It is shown only now — create a new one if you lose it. Do not send it to anyone else.
            </p>
          </div>
          <ol className="space-y-4 px-4 py-5 text-sm sm:px-5">
            <PairStep n={1} title="Prepare TallyPrime">
              On the computer with TallyPrime: open TallyPrime, load the company, and set it to act as Server on port 9000
              (Exchange → Data Synchronization → “TallyPrime act as”, or F1 → Settings → Connectivity in newer releases).
            </PairStep>
            <PairStep n={2} title="Get the connector">
              On that computer (or another one in the same office network) install Node.js 18 or newer and get the ManuFlow Tally Connector from your
              ManuFlow administrator. A ready-to-install download is not published yet.
            </PairStep>
            <PairStep n={3} title="Pair the computer">
              <span className="block">
                Windows: run <code className="rounded bg-muted px-1.5 py-0.5 text-xs">install-connector.ps1</code> once (as administrator) and type this code when it asks; the connector then starts with the computer.
              </span>
              <span className="mt-1.5 block">
                Otherwise run <code className="break-all rounded bg-muted px-1.5 py-0.5 text-xs">node manuflow-tally-connector.mjs pair --server {origin} --code {code.code}</code>,
                then <code className="rounded bg-muted px-1.5 py-0.5 text-xs">node manuflow-tally-connector.mjs run</code> and keep it running.
              </span>
            </PairStep>
          </ol>
          <div className="space-y-1.5 border-t bg-muted/20 px-4 py-3 text-xs text-muted-foreground sm:px-5">
            <p>This is needed once per computer. Afterwards the connector reconnects by itself, also after a restart; this page updates by itself.</p>
            <p>Keep Tally’s port 9000 closed to the internet: the connector only connects out to ManuFlow.</p>
          </div>
        </div>
      )}

    </div>
  )
}

function ConnectorFact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 break-words">{children}</dd>
    </div>
  )
}

function PairStep({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-primary text-xs font-semibold text-primary-foreground" aria-hidden>{n}</span>
      <div className="min-w-0">
        <p className="font-medium"><span className="sr-only">Step {n}: </span>{title}</p>
        <p className="mt-1 text-muted-foreground">{children}</p>
      </div>
    </li>
  )
}
