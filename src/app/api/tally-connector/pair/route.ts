import { db } from '@/lib/db'
import { handleError, logAudit, ok } from '@/lib/erp-helpers'
import { clientIp } from '@/lib/session'
import { assertConnectorEnabled, pairConnector } from '@/lib/tally/connector'
import { connectorBody } from '../_shared'

// POST /api/tally-connector/pair { code, version?, platform? } → { connectorId, token }
// Called by the connector program, not the browser (no session; public in middleware). The pairing code is the
// credential: single use, 10 minutes, wrong codes rate-limited per IP. The token is returned only here, once.
export async function POST(req: Request) {
  try {
    assertConnectorEnabled()
    const body = await connectorBody(req)
    const r = await pairConnector(body.code, clientIp(req), { version: body.version, platform: body.platform })
    await logAudit(db as never, {
      companyId: r.companyId, userName: 'Tally connector', action: 'CREATE', entity: 'TallyConnector', entityId: r.connectorId,
      details: r.replacedConnector ? 'Connector paired (the earlier connector was disconnected)' : 'Connector paired',
    })
    return ok({ connectorId: r.connectorId, token: r.token }, 'Connector paired')
  } catch (e) {
    return handleError(e)
  }
}
