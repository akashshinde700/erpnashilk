import { db } from '@/lib/db'
import { ApiError, companyRequired, handleError, logAudit, ok, requireWrite } from '@/lib/erp-helpers'
import { assertConnectorEnabled, connectorStatus, issuePairingCode, markWatching, revokeConnector } from '@/lib/tally/connector'

// Pairing a connector gives a program read access to the company's Tally books, so only admins may do it.
const PAIRING_ROLES = ['TENANT_ADMIN', 'MANAGEMENT', 'SUPER_ADMIN']

function requirePairingAdmin(req: Request) {
  const actor = requireWrite(req, 'import-center')
  if (!PAIRING_ROLES.includes(actor.role)) throw new ApiError('Only an administrator can connect or disconnect Tally', 403)
  return actor
}

// GET /api/import-center/tally/connector → ConnectorStatus (never the pairing code or token)
export async function GET(req: Request) {
  try {
    requireWrite(req, 'import-center')
    const companyId = await companyRequired(req)
    markWatching(companyId) // someone is on the Tally screen: the connector checks in every 5 s for a while
    return ok(await connectorStatus(companyId))
  } catch (e) {
    return handleError(e)
  }
}

// POST /api/import-center/tally/connector → { code, expiresAt } — the code is shown once
export async function POST(req: Request) {
  try {
    const actor = requirePairingAdmin(req)
    const companyId = await companyRequired(req)
    assertConnectorEnabled()
    const r = await issuePairingCode(companyId, actor.userId)
    await logAudit(db as never, { companyId, action: 'CREATE', entity: 'TallyConnectorPairing', details: `Pairing code created, expires ${r.expiresAt}` })
    return ok(r, 'Pairing code created')
  } catch (e) {
    return handleError(e)
  }
}

// DELETE /api/import-center/tally/connector → disconnects (revokes) the company's connector and open codes
export async function DELETE(req: Request) {
  try {
    requirePairingAdmin(req)
    const companyId = await companyRequired(req)
    assertConnectorEnabled()
    const r = await revokeConnector(companyId)
    await logAudit(db as never, { companyId, action: 'DELETE', entity: 'TallyConnector', details: r.revoked ? 'Connector disconnected' : 'Open pairing code cancelled' })
    return ok(r, r.revoked ? 'Tally connector disconnected' : 'Nothing was connected')
  } catch (e) {
    return handleError(e)
  }
}
