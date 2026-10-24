import { db } from '@/lib/db'
import { ApiError, companyRequired, handleError, logAudit, ok, requireWrite } from '@/lib/erp-helpers'
import { goLiveState, goLiveString, openingDateFor, parseGoLiveDate } from '@/lib/go-live'

// GET /api/import-center/go-live → { goLiveDate, locked, importedRows, openingDate }
export async function GET(req: Request) {
  try {
    requireWrite(req, 'import-center')
    const companyId = await companyRequired(req)
    const s = await goLiveState(companyId)
    return ok({ goLiveDate: s.goLiveDate, locked: s.locked, importedRows: s.importedRows, openingDate: s.goLive ? openingDateFor(s.goLive).toISOString() : null })
  } catch (e) {
    return handleError(e)
  }
}

// PUT /api/import-center/go-live { companyId?, goLiveDate: 'YYYY-MM-DD' }
// Administrators only (Import Center + company settings). Refused once opening stock was imported
// against the current date.
export async function PUT(req: Request) {
  try {
    const actor = requireWrite(req, 'import-center')
    requireWrite(req, 'settings')
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
    const companyId = await companyRequired(req, typeof body.companyId === 'string' ? body.companyId : undefined)
    const next = parseGoLiveDate(body.goLiveDate)
    const s = await goLiveState(companyId)
    if (s.goLiveDate === goLiveString(next)) return ok({ goLiveDate: s.goLiveDate, locked: s.locked, importedRows: s.importedRows, openingDate: openingDateFor(next).toISOString() })
    if (s.locked) throw new ApiError(`The go-live date ${s.goLiveDate} is locked: opening stock was already imported against it`, 409)
    await db.company.update({ where: { id: companyId }, data: { goLiveDate: next } })
    await logAudit(db as never, {
      companyId, userName: actor.userName, action: 'CONFIG', entity: 'COMPANY', entityId: companyId,
      details: `Go-live date ${s.goLiveDate ? `changed from ${s.goLiveDate} ` : ''}set to ${goLiveString(next)}`,
    })
    return ok({ goLiveDate: goLiveString(next), locked: false, importedRows: 0, openingDate: openingDateFor(next).toISOString() }, 'Go-live date saved')
  } catch (e) {
    return handleError(e)
  }
}
