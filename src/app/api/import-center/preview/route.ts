import { handleError, ok, requireWrite } from '@/lib/erp-helpers'
import { requireGoLive } from '@/lib/go-live'
import { runImport } from '@/lib/import/run'
import { importContext, readOptions, readTable } from '../_shared'

// POST /api/import-center/preview
// { companyId?, dataType, table: [{ line, cells }], headerRow, mapping: { field: column }, options? }
// Validates every row exactly as the import would (duplicates included) — read-only, writes nothing.
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
    const { companyId, dataType } = await importContext(req, body)
    let canWriteSuppliers = true
    try { requireWrite(req, 'suppliers') } catch { canWriteSuppliers = false }
    const result = await runImport({
      companyId, dataType, canWriteSuppliers,
      table: readTable(body.table),
      headerRow: Number(body.headerRow),
      mapping: body.mapping,
      options: readOptions(body.options),
      goLive: dataType.needsGoLive ? await requireGoLive(companyId) : undefined,
      dryRun: true,
    })
    return ok(result)
  } catch (e) {
    return handleError(e)
  }
}
