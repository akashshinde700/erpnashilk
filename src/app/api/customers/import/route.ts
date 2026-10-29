import { db } from '@/lib/db'
import { ApiError, companyRequired, handleError, logAudit, ok, requireWrite } from '@/lib/erp-helpers'
import { importCustomers, legacyResult } from '@/lib/services/customer-import'

type Row = Record<string, string>

// ============================== POST /api/customers/import ==============================
// Body: { companyId, rows: Array<Record<string,string>> }
// Headers (case-insensitive, matched by the client): name, gstin, city, state, stateCode, phone,
// email, addressLine. Optional: code, partyType (CUSTOMER | BOTH), gstType, pan, contactPerson, pincode.
// Validation, codes, duplicates and BOTH rows: see src/lib/services/customer-import.ts.
export async function POST(req: Request) {
  try {
    const actor = requireWrite(req, 'customers')
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
    const companyId = await companyRequired(req, typeof body.companyId === 'string' ? body.companyId : undefined)

    if (!Array.isArray(body.rows) || body.rows.length === 0) throw new ApiError('rows array is required', 400)
    if (body.rows.length > 500) throw new ApiError('Maximum 500 rows per import', 400)
    const rows = (body.rows as unknown[]).map((raw, i) => ({
      row: i + 1,
      data: (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Row,
    }))

    let canWriteSuppliers = true
    try { requireWrite(req, 'suppliers') } catch { canWriteSuppliers = false }

    const summary = await importCustomers(companyId, rows, { canWriteSuppliers })
    const alsoSuppliers = summary.results.filter((r) => r.status === 'imported' && r.warnings.length).length

    try {
      await logAudit(db as never, {
        companyId,
        userName: actor.userName,
        action: 'IMPORT',
        entity: 'CUSTOMER',
        details: `CSV import: ${summary.imported} customers${alsoSuppliers ? ` (${alsoSuppliers} also as suppliers)` : ''}`,
      })
    } catch {
      // audit is best-effort
    }

    return ok(legacyResult(summary), `Imported ${summary.imported} customers`)
  } catch (e) {
    return handleError(e)
  }
}
