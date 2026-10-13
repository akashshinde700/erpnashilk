import { db } from '@/lib/db'
import { ApiError, companyRequired, DOC_PREFIX, handleError, logAudit, ok, requireWrite } from '@/lib/erp-helpers'

const parsePrefixes = (raw: string | null | undefined): Record<string, string> => {
  try { return raw ? (JSON.parse(raw) as Record<string, string>) : {} } catch { return {} }
}

// GET /api/numbering?companyId= → { seqs, prefixes } — counters per FY + effective prefix per document type
export async function GET(req: Request) {
  try {
    const companyId = await companyRequired(req)
    const [seqs, company] = await Promise.all([
      db.numberSeq.findMany({ where: { companyId }, orderBy: [{ docType: 'asc' }, { financialYear: 'desc' }] }),
      db.company.findUnique({ where: { id: companyId }, select: { docPrefixes: true } }),
    ])
    const overrides = parsePrefixes(company?.docPrefixes)
    const prefixes = Object.keys(DOC_PREFIX).map((docType) => ({
      docType, defaultPrefix: DOC_PREFIX[docType], prefix: overrides[docType] || DOC_PREFIX[docType],
    }))
    return ok({ seqs, prefixes })
  } catch (e) {
    return handleError(e)
  }
}

// PATCH /api/numbering { prefixes: { INV: 'SI', ... } } — change document number prefixes (admins).
// Applies to documents created from now on; existing numbers never change. Blank = default.
export async function PATCH(req: Request) {
  try {
    requireWrite(req, 'settings')
    const body = await req.json().catch(() => ({}))
    const companyId = await companyRequired(req, body.companyId)
    const input = (body.prefixes ?? {}) as Record<string, unknown>
    const company = await db.company.findUnique({ where: { id: companyId }, select: { docPrefixes: true } })
    const next = parsePrefixes(company?.docPrefixes)
    for (const [docType, v] of Object.entries(input)) {
      if (!(docType in DOC_PREFIX)) throw new ApiError(`Unknown document type ${docType}`, 400)
      const p = String(v ?? '').trim().toUpperCase()
      if (!p || p === DOC_PREFIX[docType]) { delete next[docType]; continue }
      if (!/^[A-Z0-9/]{1,10}$/.test(p)) throw new ApiError(`Prefix for ${docType} may use A–Z, 0–9 and / (max 10)`, 400)
      next[docType] = p
    }
    const used = Object.entries(next).filter(([, p]) => Object.entries(next).filter(([, q]) => q === p).length > 1)
    if (used.length) throw new ApiError(`Prefix ${used[0][1]} is used for more than one document type`, 400)
    await db.company.update({ where: { id: companyId }, data: { docPrefixes: Object.keys(next).length ? JSON.stringify(next) : null } })
    await logAudit(db as never, { companyId, action: 'CONFIG', entity: 'COMPANY', entityId: companyId, details: `Document prefixes updated: ${JSON.stringify(next)}` })
    return ok({ prefixes: next }, 'Document prefixes saved')
  } catch (e) {
    return handleError(e)
  }
}
