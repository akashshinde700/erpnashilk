import { handleError, ok } from '@/lib/erp-helpers'
import { CONNECTOR_LATEST_VERSION, CONNECTOR_MIN_VERSION, assertConnectorEnabled } from '@/lib/tally/connector'

// POST /api/tally-connector/ping → { service, minVersion, latestVersion }
// Called by the connector's `check --server` before pairing: can this computer reach ManuFlow, is the connector switched
// on here, and is its version accepted? No session or token, nothing read from the database, nothing about any company.
export async function POST() {
  try {
    assertConnectorEnabled()
    return ok({ service: 'manuflow-tally-connector', minVersion: CONNECTOR_MIN_VERSION, latestVersion: CONNECTOR_LATEST_VERSION })
  } catch (e) {
    return handleError(e)
  }
}
