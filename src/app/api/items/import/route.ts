import { db } from '@/lib/db'
import { ApiError, companyRequired, handleError, logAudit, ok, requireWrite } from '@/lib/erp-helpers'
import { legacyResult } from '@/lib/services/customer-import'
import { importItems } from '@/lib/services/item-import'

type Row = Record<string, string>

// ============================== POST /api/items/import ==============================
// Body: { companyId, rows: Array<Record<string,string>> }
// Headers (case-insensitive, matched by the client): code, name, type, uom,
// standardCost, sellPrice, reorderLevel, openingStock
// Optional: hsn, gstRate (blank = 18), purchasePrice, category, mrp, rack, altUom,
// altFactor (1 altUom = altFactor uom), cessRate, barcode, brand, status
// Validation, duplicates, opening stock and transactions: see src/lib/services/item-import.ts.
export async function POST(req: Request) {
  try {
    const actor = requireWrite(req, 'items')
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
    const companyId = await companyRequired(req, typeof body.companyId === 'string' ? body.companyId : undefined)

    if (!Array.isArray(body.rows) || body.rows.length === 0) throw new ApiError('rows array is required', 400)
    if (body.rows.length > 500) throw new ApiError('Maximum 500 rows per import', 400)
    const rows = (body.rows as unknown[]).map((raw, i) => ({
      row: i + 1,
      data: (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Row,
    }))

    const summary = await importItems(companyId, rows)

    try {
      await logAudit(db as never, {
        companyId,
        userName: actor.userName,
        action: 'IMPORT',
        entity: 'ITEM',
        details: `CSV import: ${summary.imported} items`,
      })
    } catch {
      // audit is best-effort
    }

    return ok(legacyResult(summary), `Imported ${summary.imported} items`)
  } catch (e) {
    return handleError(e)
  }
}
