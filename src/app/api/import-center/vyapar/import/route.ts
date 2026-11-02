import { randomBytes } from 'node:crypto'
import { db } from '@/lib/db'
import { ApiError, handleError, logAudit, ok, requireWrite } from '@/lib/erp-helpers'
import { OPENING_IMPORT_PREFIX, goLiveString, requireGoLive, todayIst } from '@/lib/go-live'
import { UOMS } from '@/lib/erp-constants'
import { IMPORT_HISTORY_ENTITY } from '@/lib/import/fields'
import { runImport } from '@/lib/import/run'
import { VYAPAR_BATCH_ROWS, vyaparBatchCount, vyaparBatchTable, type VyaparImportKind, type VyaparOptions } from '@/lib/vyapar/to-import'
import { getSnapshot } from '@/lib/vyapar/store'
import { importContext, readOptions, withImportLock } from '../../_shared'

const MAX_HISTORY_ERRORS = 25
const MAX_ROWS_BACK = 200

/**
 * POST /api/import-center/vyapar/import
 *   { companyId?, snapshotId, dataType: customers | suppliers | items | opening-stock,
 *     mode: 'preview' | 'commit', batch, options?, confirm? }
 * → { batch, batches, totalRecords, batchSize, result }
 *
 * One batch (≤ 500 records) of the backup the server read from the uploaded file goes through the
 * normal Import Center pipeline: preview is a read-only dry run, commit runs exactly the same import
 * services as a file import (duplicates skipped, one transaction per row) and writes one Import
 * History entry per batch. Opening stock additionally needs the company's go-live date.
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
    const { actor, companyId, dataType } = await importContext(req, body)
    const kind = dataType.key as VyaparImportKind
    if (!['customers', 'suppliers', 'items', 'opening-stock'].includes(kind)) {
      throw new ApiError(`${dataType.label} cannot be imported from a Vyapar backup yet`, 400)
    }
    const { snapshot } = getSnapshot(companyId, body.snapshotId)
    const mode = body.mode
    if (mode !== 'preview' && mode !== 'commit') throw new ApiError('mode must be preview or commit', 400)
    if (mode === 'commit' && body.confirm !== true) throw new ApiError('Confirm the import first', 400)
    const batches = vyaparBatchCount(kind, snapshot)
    const batch = Number(body.batch)
    if (!Number.isInteger(batch) || batch < 0 || batch >= batches) throw new ApiError('batch is out of range', 400)

    let canWriteSuppliers = true
    try { requireWrite(req, 'suppliers') } catch { canWriteSuppliers = false }

    const options = readOptions(body.options)
    const vyaparOptions = readVyaparOptions(body.options)

    // Opening stock: the go-live date must be configured already (the user sets it in the Import
    // Center) and, on commit, confirmed for this import; it may not be in the future.
    let goLive: Date | undefined
    let importRef: string | undefined
    if (dataType.needsGoLive) {
      goLive = await requireGoLive(companyId)
      if (mode === 'commit') {
        const configured = goLiveString(goLive) as string
        if (options.goLiveDate !== configured) throw new ApiError(`Confirm the go-live date ${configured} for this import`, 400)
        if (configured > todayIst()) throw new ApiError(`The go-live date ${configured} is in the future — import opening stock on or after that date`, 400)
        importRef = `${OPENING_IMPORT_PREFIX}${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}-${randomBytes(3).toString('hex').toUpperCase()}`
      }
    }

    const { table, mapping, totalRecords, batchRows } = vyaparBatchTable(kind, snapshot, batch, vyaparOptions)
    const run = () => runImport({
      companyId, dataType, canWriteSuppliers, table, headerRow: 0, mapping, options, goLive, importRef,
      dryRun: mode === 'preview',
    })
    const result = mode === 'preview' ? await run() : await withImportLock(`${companyId}:${dataType.key}`, run)

    if (mode === 'commit') {
      const { imported, duplicates, errors, failed } = result.counts
      const problems = result.rows.filter((r) => r.status !== 'imported' && r.messages.length)
      const lines = problems.slice(0, MAX_HISTORY_ERRORS).map((r) => `Vyapar record ${r.line - 1}: ${r.messages.join('; ')}`)
      if (problems.length > MAX_HISTORY_ERRORS) lines.push(`… and ${problems.length - MAX_HISTORY_ERRORS} more`)
      const recon = result.reconciliation
      const reconLine = recon
        ? [`Reference ${recon.ref} · go-live ${goLiveString(goLive)} · source qty ${recon.totals.sourceQty}, value ${recon.totals.sourceValue} · posted qty ${recon.totals.postedQty}, value ${recon.totals.postedValue}`]
        : []
      const fallbacks = [
        vyaparOptions.gstFallback ? `items without a GST rate → ${vyaparOptions.gstFallback}%` : '',
        vyaparOptions.uomFallback ? `units with no ManuFlow equivalent → ${vyaparOptions.uomFallback}` : '',
      ].filter(Boolean)
      try {
        await logAudit(db as never, {
          companyId, userName: actor.userName, action: 'IMPORT', entity: IMPORT_HISTORY_ENTITY[dataType.key], entityId: recon?.ref,
          details: [
            `Import Center · ${dataType.label} from Vyapar backup of "${snapshot.firm.name}" (${snapshot.source.companyFile}), batch ${batch + 1} of ${batches}: ${imported} imported, ${duplicates} skipped (duplicates), ${errors + failed} failed`,
            ...(fallbacks.length ? [`Choices: ${fallbacks.join('; ')}`] : []),
            ...reconLine,
            ...lines,
          ].join('\n').slice(0, 4000),
        })
      } catch {
        // history is best-effort; the import itself already happened
      }
    }

    return ok({
      batch, batches, totalRecords, batchSize: VYAPAR_BATCH_ROWS, batchRows,
      result: { ...result, rows: result.rows.filter((r) => r.status !== 'ready' && r.status !== 'imported').slice(0, MAX_ROWS_BACK) },
    })
  } catch (e) {
    return handleError(e)
  }
}

/** The Vyapar-specific choices: a GST rate for items without one, a unit for unmapped units. */
function readVyaparOptions(raw: unknown): VyaparOptions {
  const out: VyaparOptions = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  const gst = (raw as Record<string, unknown>).gstFallback
  if (gst !== undefined && gst !== null && gst !== '') {
    const n = Number(String(gst).replace(/%/g, ''))
    if (!Number.isFinite(n) || n < 0 || n > 100) throw new ApiError('The GST rate for items without one must be a number between 0 and 100', 400)
    out.gstFallback = String(n)
  }
  const uom = (raw as Record<string, unknown>).uomFallback
  if (uom !== undefined && uom !== null && uom !== '') {
    const u = String(uom).toUpperCase()
    if (!(UOMS as readonly string[]).includes(u)) throw new ApiError(`The fallback unit must be one of ${UOMS.join(', ')}`, 400)
    out.uomFallback = u
  }
  const itemType = (raw as Record<string, unknown>).itemType
  if (typeof itemType === 'string' && itemType) out.itemType = itemType.toUpperCase()
  return out
}
