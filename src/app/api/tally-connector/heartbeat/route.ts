import { handleError, ok } from '@/lib/erp-helpers'
import { assertConnectorEnabled, authenticateConnector, recordHeartbeat } from '@/lib/tally/connector'
import { connectorBody } from '../_shared'

// POST /api/tally-connector/heartbeat (Authorization: Bearer <connector token>)
//   { version, platform, tally: { status, latencyMs?, endpoint? } } → { nextHeartbeatSec }
// The connector reports its own read-only check of Tally. The reply carries no command, URL or XML.
export async function POST(req: Request) {
  try {
    assertConnectorEnabled()
    const c = await authenticateConnector(req)
    return ok(await recordHeartbeat(c, await connectorBody(req)))
  } catch (e) {
    return handleError(e)
  }
}
