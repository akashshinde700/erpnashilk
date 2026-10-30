'use client'

import * as React from 'react'
import { Clock, KeyRound, Loader2, PlugZap, RefreshCw, Unplug, XCircle } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { fmtDateTime } from '@/lib/erp-constants'
import { friendlyError } from '@/lib/import/wizard-helpers'
import type { ConnectorState, ConnectorStatus } from '@/lib/tally/connector'
import { apiDelete, apiGet, apiPost, currentRole } from '@/lib/use-api'
import { cn } from '@/lib/utils'

const ADMIN_ROLES = ['TENANT_ADMIN', 'MANAGEMENT', 'SUPER_ADMIN']
const POLL_MS = 10_000

const BADGE: Record<ConnectorState, { label: string; tone: string; icon: React.ElementType }> = {
  unavailable: { label: 'Connector not available', tone: 'text-muted-foreground', icon: Unplug },
  not_paired: { label: 'Not connected', tone: 'text-muted-foreground', icon: Unplug },
  pairing: { label: 'Waiting for pairing', tone: 'border-warning-border text-warning', icon: Clock },
  connected: { label: 'Connected to Tally', tone: 'border-success-border text-success', icon: PlugZap },
  tally_error: { label: 'Connector online · Tally not reachable', tone: 'border-danger-border text-destructive', icon: XCircle },
  offline: { label: 'Connector offline', tone: 'border-danger-border text-destructive', icon: XCircle },
}

/**
 * "Connect Tally" through the ManuFlow Tally Connector (proof of concept, src/lib/tally/connector.ts).
 * Shows only what the server reports; when the connector is switched off on the server it says so and offers nothing.
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
  React.useEffect(() => {
    if (!live) return
    const t = setInterval(() => void load(), POLL_MS)
    return () => clearInterval(t)
  }, [live, load])

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
      ? <p className="text-sm text-destructive" role="alert">{error}</p>
      : <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Checking the Tally connector…</p>
  }

  const b = BADGE[status.state]
  const c = status.connector
  const paired = !!c
  return (
    <div className="space-y-3 rounded-lg border p-4" data-testid="tally-connector">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className={cn('gap-1.5 py-1 text-sm', b.tone)}>
          <b.icon className="h-4 w-4" aria-hidden /> {b.label}
        </Badge>
        <span className="flex-1" />
        {status.state === 'not_paired' && isAdmin && (
          <Button onClick={() => void connect()} disabled={busy} className="bg-primary text-primary-foreground hover:bg-primary/90">
            {busy ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <KeyRound className="h-4 w-4 mr-2" />} Connect Tally
          </Button>
        )}
        {status.state !== 'unavailable' && status.state !== 'not_paired' && isAdmin && !confirmOff && (
          <Button size="sm" variant="outline" onClick={() => void connect()} disabled={busy}>
            <KeyRound className="h-4 w-4 mr-1.5" /> {status.state === 'pairing' ? 'New code' : 'Reconnect'}
          </Button>
        )}
        {(paired || status.state === 'pairing') && isAdmin && (
          confirmOff
            ? <>
                <Button size="sm" variant="destructive" onClick={() => void disconnect()} disabled={busy}>Yes, disconnect</Button>
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
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted-foreground">Last check-in</dt><dd>{c.lastSeenAt ? fmtDateTime(c.lastSeenAt) : 'Never'}</dd>
          <dt className="text-muted-foreground">Last successful Tally contact</dt><dd>{c.lastSuccessAt ? fmtDateTime(c.lastSuccessAt) : 'Never'}</dd>
          {c.tallyEndpoint && <><dt className="text-muted-foreground">Tally address (in your office)</dt><dd>{c.tallyEndpoint}{c.latencyMs != null ? ` · ${c.latencyMs} ms` : ''}</dd></>}
          <dt className="text-muted-foreground">Paired</dt><dd>{fmtDateTime(c.pairedAt)}{c.platform ? ` · ${c.platform}` : ''}{c.version ? ` · v${c.version}` : ''}</dd>
        </dl>
      )}

      {code && (
        <Alert>
          <KeyRound className="h-4 w-4" />
          <AlertTitle>Pairing code: <span className="font-mono text-lg tracking-wider" data-testid="pairing-code">{code.code}</span></AlertTitle>
          <AlertDescription>
            <p>Valid until {fmtDateTime(code.expiresAt)}, for one use only. It is shown only now — create a new one if you lose it. Do not send it to anyone else.</p>
            <ol className="mt-2 list-decimal space-y-1 pl-5">
              <li>On the computer with TallyPrime: open TallyPrime, load the company, and set Exchange → Data Synchronization → “TallyPrime act as” to Server (port 9000).</li>
              <li>On that computer (or another one in the same office network) install Node.js 18 or newer and get the ManuFlow Tally Connector from your ManuFlow administrator. A ready-to-install download is not published yet.</li>
              <li>Run: <code className="break-all rounded bg-muted px-1">node manuflow-tally-connector.mjs pair --server {typeof window !== 'undefined' ? window.location.origin : ''} --code {code.code}</code></li>
              <li>Then run: <code className="rounded bg-muted px-1">node manuflow-tally-connector.mjs run</code> and keep it running. This page updates by itself.</li>
            </ol>
            <p className="mt-2">Keep Tally’s port 9000 closed to the internet: the connector only connects out to ManuFlow.</p>
          </AlertDescription>
        </Alert>
      )}

    </div>
  )
}
