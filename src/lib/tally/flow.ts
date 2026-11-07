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
