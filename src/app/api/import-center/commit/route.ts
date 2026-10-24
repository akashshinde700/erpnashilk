import { randomBytes } from 'node:crypto'
import { db } from '@/lib/db'
import { ApiError, handleError, logAudit, ok, requireWrite } from '@/lib/erp-helpers'
import { OPENING_IMPORT_PREFIX, goLiveString, requireGoLive, todayIst } from '@/lib/go-live'
import { IMPORT_HISTORY_ENTITY } from '@/lib/import/fields'
import { runImport } from '@/lib/import/run'
import { cleanFileName, importContext, readOptions, readTable, sourceLabel, withImportLock } from '../_shared'

const MAX_HISTORY_ERRORS = 25

// POST /api/import-center/commit
// { companyId?, dataType, source, fileName, table, headerRow, mapping, options?, confirm: true }
// Re-validates everything server-side, then imports the valid rows (one transaction per row) and
// records one IMPORT entry in the audit log as the import history.
// Opening stock additionally needs options.goLiveDate = the company's go-live date (the user
// confirmed it) and a go-live date that is not in the future.
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
    const { actor, companyId, dataType } = await importContext(req, body)
    if (dataType.commit === false) throw new ApiError(dataType.commitBlocked ?? `${dataType.label} cannot be imported yet`, 400)
    if (body.confirm !== true) throw new ApiError('Confirm the import first', 400)
    let canWriteSuppliers = true
    try { requireWrite(req, 'suppliers') } catch { canWriteSuppliers = false }
    const table = readTable(body.table)
    const fileName = cleanFileName(body.fileName)
    const options = readOptions(body.options)

    let goLive: Date | undefined
    let importRef: string | undefined
    if (dataType.needsGoLive) {
      goLive = await requireGoLive(companyId)
      const configured = goLiveString(goLive) as string
      if (options.goLiveDate !== configured) throw new ApiError(`Confirm the go-live date ${configured} for this import`, 400)
      if (configured > todayIst()) throw new ApiError(`The go-live date ${configured} is in the future — import opening stock on or after that date`, 400)
      importRef = `${OPENING_IMPORT_PREFIX}${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}-${randomBytes(3).toString('hex').toUpperCase()}`
    }

    const result = await withImportLock(`${companyId}:${dataType.key}`, () => runImport({
      companyId, dataType, canWriteSuppliers, table,
      headerRow: Number(body.headerRow),
      mapping: body.mapping,
      options,
      goLive,
      importRef,
      dryRun: false,
    }))

    const { imported, duplicates, errors, failed } = result.counts
    const problems = result.rows.filter((r) => r.status !== 'imported' && r.messages.length)
    const lines = problems.slice(0, MAX_HISTORY_ERRORS).map((r) => `Row ${r.line}: ${r.messages.join('; ')}`)
    if (problems.length > MAX_HISTORY_ERRORS) lines.push(`… and ${problems.length - MAX_HISTORY_ERRORS} more`)
    const recon = result.reconciliation
    const reconLine = recon
      ? [`Reference ${recon.ref} · go-live ${goLiveString(goLive)} · source qty ${recon.totals.sourceQty}, value ${recon.totals.sourceValue} · posted qty ${recon.totals.postedQty}, value ${recon.totals.postedValue}`]
      : []
    try {
      await logAudit(db as never, {
        companyId,
        userName: actor.userName,
        action: 'IMPORT',
        entity: IMPORT_HISTORY_ENTITY[dataType.key],
        entityId: recon?.ref,
        details: [
          `Import Center · ${dataType.label} from ${sourceLabel(body.source)} file "${fileName}": ${imported} imported, ${duplicates} skipped (duplicates), ${errors + failed} failed`,
          ...reconLine,
          ...lines,
        ].join('\n').slice(0, 4000),
      })
    } catch {
      // history is best-effort; the import itself already happened
    }
    return ok(result, `Imported ${imported} ${dataType.label.toLowerCase()}`)
  } catch (e) {
    return handleError(e)
  }
}
