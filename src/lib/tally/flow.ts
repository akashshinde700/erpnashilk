import type { ConnectorStatus } from '@/lib/tally/connector'

/**
 * The "Import from Tally" connection flow as the user sees it, worked out from the connector status the server reports
 * and the company-list read the screen started. Pure (no React), so the mapping is tested on its own.
 *
 *   detecting → (authorization_required | auth_failed | connector_offline | outdated)
 *             → connecting → (tally_unreachable) → connected → fetching_companies → companies_available | no_companies
 *
 * Every state is the server's own report; nothing here assumes a connection the server has not seen.
 */
export type TallyFlowState =
  | 'detecting' | 'unavailable' | 'authorization_required' | 'auth_failed' | 'connector_offline' | 'outdated' | 'connecting'
  | 'tally_unreachable' | 'connected' | 'fetching_companies' | 'companies_available' | 'no_companies' | 'retry'

export interface TallyFlow {
  state: TallyFlowState
  label: string
  /** 0 nothing yet · 1 connector online · 2 Tally answering · 3 companies listed */
  reached: 0 | 1 | 2 | 3
  /** The user can do something now (pair, retry); otherwise the screen updates by itself. */
  action: 'pair' | 'retry' | 'choose' | null
}

export const FLOW_LABEL: Record<TallyFlowState, string> = {
  detecting: 'Detecting connector',
  unavailable: 'Connector not available',
  authorization_required: 'Device authorization required',
  auth_failed: 'Authentication failed',
  connector_offline: 'Connector offline',
  outdated: 'Connector update required',
  connecting: 'Connecting to Tally',
  tally_unreachable: 'Tally not reachable',
  connected: 'Connected',
  fetching_companies: 'Fetching companies',
  companies_available: 'Companies available',
  no_companies: 'No company open in Tally',
  retry: 'Retry available',
}

export function tallyFlow(
  conn: ConnectorStatus | null,
  list: { listing: boolean; companies: readonly unknown[] | null; error: string } = { listing: false, companies: null, error: '' },
): TallyFlow {
  const f = (state: TallyFlowState, reached: TallyFlow['reached'], action: TallyFlow['action'] = null): TallyFlow =>
    ({ state, label: FLOW_LABEL[state], reached, action })
  if (!conn) return f('detecting', 0)
  switch (conn.state) {
    case 'unavailable': return f('unavailable', 0)
    case 'not_paired':
    case 'pairing': return f('authorization_required', 0, 'pair')
    case 'auth_failed': return f('auth_failed', 0, 'pair')
    case 'offline':
    case 'reconnecting': return f('connector_offline', 0)
    case 'connecting': return f('connecting', 0)
    case 'outdated': return f('outdated', 1)
    case 'tally_error': return f('tally_unreachable', 1)
    case 'connected':
      if (list.listing) return f('fetching_companies', 2)
      if (list.error) return f('retry', 2, 'retry')
      if (list.companies && list.companies.length > 0) return f('companies_available', 3, 'choose')
      if (list.companies) return f('no_companies', 2, 'retry')
      return f('connected', 2)
  }
}

// ---------------------------------------------------------------- automatic connection (Import from Tally, step 1)

/**
 * What "Connecting to TallyPrime…" shows, worked out only from what the server reports — a step is shown as done
 * only after the server has confirmed it:
 *  1 search        a connector is paired with this company (registration);
 *  2 availability  it has checked in recently (heartbeat freshness);
 *  3 auth          that check-in was accepted with its token and device id (a fresh check-in proves both);
 *  4 tally         the connector reports TallyPrime answering;
 *  5 companies     Tally's company list was read.
 * outcome: working (keep checking), needs-pairing (first time or re-pairing: the one-time code screen),
 * blocked (waiting will not help), ready (connected and the company list is in).
 */
export type ConnectStep = 'search' | 'availability' | 'auth' | 'tally' | 'companies'
export type StepState = 'pending' | 'active' | 'done' | 'failed'
export const CONNECT_STEPS: { key: ConnectStep; label: string }[] = [
  { key: 'search', label: 'Searching for Tally connector…' },
  { key: 'availability', label: 'Checking connector availability…' },
  { key: 'auth', label: 'Verifying secure device authentication…' },
  { key: 'tally', label: 'Connecting to TallyPrime…' },
  { key: 'companies', label: 'Fetching available companies…' },
]

export type AutoConnectOutcome =
  | { kind: 'working' }
  | { kind: 'needs-pairing'; reason: 'not_paired' | 'pairing' | 'auth_failed' }
  | { kind: 'blocked'; reason: 'unavailable' | 'outdated' }
  | { kind: 'ready' }

export interface AutoConnect { steps: Record<ConnectStep, StepState>; outcome: AutoConnectOutcome }

export function autoConnectProgress(
  conn: ConnectorStatus | null,
  list: { listing: boolean; companies: readonly unknown[] | null; error: string } = { listing: false, companies: null, error: '' },
): AutoConnect {
  const order: ConnectStep[] = CONNECT_STEPS.map((s) => s.key)
  // the first `done` steps are done, the next one has `state`, the rest are pending
  const at = (done: number, state: StepState, outcome: AutoConnectOutcome): AutoConnect => ({
    steps: Object.fromEntries(order.map((k, i) => [k, i < done ? 'done' : i === done ? state : 'pending'])) as Record<ConnectStep, StepState>,
    outcome,
  })
  if (!conn) return at(0, 'active', { kind: 'working' })
  switch (conn.state) {
    case 'unavailable': return at(0, 'failed', { kind: 'blocked', reason: 'unavailable' })
    case 'not_paired':
    case 'pairing': return at(0, 'failed', { kind: 'needs-pairing', reason: conn.state })
    case 'auth_failed': return at(2, 'failed', { kind: 'needs-pairing', reason: 'auth_failed' })
    case 'connecting':
    case 'reconnecting':
    case 'offline': return at(1, 'active', { kind: 'working' })
    case 'outdated': return at(3, 'failed', { kind: 'blocked', reason: 'outdated' })
    case 'tally_error': return at(3, 'active', { kind: 'working' })
    case 'connected':
      if (list.companies && !list.listing) return at(5, 'done', { kind: 'ready' })
      return at(4, 'active', { kind: 'working' })
  }
}

/** Waits between automatic checks: quick at first, then backing off to 8 s. */
export const pollDelay = (attempt: number) => Math.min(8000, Math.round(1500 * 1.6 ** Math.max(0, attempt - 1)))
/** After this long without a connection the screen stops waiting and says what is wrong (no endless spinner). */
export const CONNECT_DEADLINE_MS = 75_000
/** Company list reads tried by themselves before the error is shown. */
export const LIST_AUTO_RETRIES = 2

export interface ConnectFailure { title: string; why: string[]; todo: string[] }

/** What failed, why it may have failed and what to do — for the state the connection was left in. */
export function connectFailure(conn: ConnectorStatus | null, list: { error: string }, networkError: string): ConnectFailure {
  if (!conn && networkError) {
    return {
      title: 'ManuFlow could not be reached',
      why: ['This browser lost its internet connection, or ManuFlow did not answer in time.'],
      todo: ['Check your internet connection.', 'Press Retry.'],
    }
  }
  switch (conn?.state) {
    case 'connecting':
    case 'reconnecting':
    case 'offline':
      return {
        title: 'The Tally connector is not responding',
        why: [
          conn.state === 'connecting' ? 'The connector was paired but has not checked in yet.' : 'The connector has not checked in recently.',
          'The computer running it may be off, asleep or offline, or the connector is not running.',
        ],
        todo: [
          'Switch on the computer with the connector and check its internet connection.',
          'Where it was installed to start with Windows, restarting that computer starts it again; otherwise start it with “run”.',
          'Press Retry.',
        ],
      }
    case 'tally_error':
      return {
        title: 'TallyPrime is not reachable',
        why: [conn.message],
        todo: ['Open TallyPrime on that computer and load the company.', 'Press Retry.'],
      }
    case 'outdated':
      return { title: 'The Tally connector needs an update', why: [conn.message], todo: ['Install the newer connector on that computer (no new pairing is needed), then press Retry.'] }
    case 'unavailable':
      return { title: 'Import from Tally is not available on this server', why: [conn.message], todo: ['Export the report from Tally to Excel / CSV and import that file instead.'] }
    case 'connected':
      return {
        title: 'The company list could not be read from TallyPrime',
        why: [list.error || 'TallyPrime did not return the company list.'],
        todo: ['Check that TallyPrime is open with at least one company loaded and no dialog waiting.', 'Press Retry.'],
      }
    default:
      return { title: 'Tally could not be connected', why: [networkError || 'The connection was not completed in time.'], todo: ['Press Retry.'] }
  }
}
