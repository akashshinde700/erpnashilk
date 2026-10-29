import { handleError, ok } from '@/lib/erp-helpers'
import { assertConnectorEnabled, authenticateConnector } from '@/lib/tally/connector'
import { recordJobResult } from '@/lib/tally/jobs'
import { MAX_RESULT_BYTES, connectorBody } from '../_shared'

// POST /api/tally-connector/result (Authorization: Bearer <connector token>)
//   { jobId, ok: true, records: [...] } | { jobId, ok: false, error: <code> } → { accepted }
// Only the connector's own running job; records are reduced to the known fields of that job type.
export async function POST(req: Request) {
  try {
    assertConnectorEnabled()
    const c = await authenticateConnector(req)
    return ok(await recordJobResult(c, await connectorBody(req, MAX_RESULT_BYTES)))
  } catch (e) {
    return handleError(e)
  }
}
