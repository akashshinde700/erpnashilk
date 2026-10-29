import { db } from '@/lib/db'
import { ApiError, handleError, logAudit, ok, requireWrite } from '@/lib/erp-helpers'
import { IMPORT_HISTORY_ENTITY } from '@/lib/import/fields'
import { runImport, type RunResult } from '@/lib/import/run'
import { assertConnectorEnabled } from '@/lib/tally/connector'
import { EXPORT_JOB, getJobFor } from '@/lib/tally/jobs'
import { TALLY_BATCH_ROWS, batchCount, tallyBatchTable, type TallyImportKind } from '@/lib/tally/to-import'
import { importContext, readOptions, withImportLock } from '../../_shared'

const MAX_HISTORY_ERRORS = 25
// Rows sent back per batch besides the counts: the ones that need attention (never silently dropped from history)
const MAX_ROWS_BACK = 200

// POST /api/import-center/tally/import
//   { companyId?, jobId, dataType: customers | suppliers | items, mode: 'preview' | 'commit', batch, options?, confirm? }
// → { batch, batches, totalRecords, result }
// Takes the records of a finished Tally export job (server memory — the browser never sends Tally data) and runs one
// batch of ≤ 500 rows through the normal Import Center pipeline: preview = read-only dry run; commit = the same
// services as a file import (duplicates skipped, one transaction per row) + one Import History entry per batch.
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
    const { actor, companyId, dataType } = await importContext(req, body)
    assertConnectorEnabled()
    const kind = dataType.key as TallyImportKind
    if (!(kind in EXPORT_JOB)) throw new ApiError(`${dataType.label} cannot be imported from Tally yet`, 400)
    const job = await getJobFor(companyId, body.jobId)
    if (job.type !== EXPORT_JOB[kind]) throw new ApiError('This Tally data does not match what is being imported', 400)
    if (job.status !== 'done' || !job.records) throw new ApiError('The data has not been read from Tally yet', 409)
    const mode = body.mode
    if (mode !== 'preview' && mode !== 'commit') throw new ApiError('mode must be preview or commit', 400)
    if (mode === 'commit' && body.confirm !== true) throw new ApiError('Confirm the import first', 400)
    const batches = batchCount(job.records)
    const batch = Number(body.batch)
    if (!Number.isInteger(batch) || batch < 0 || batch >= batches) throw new ApiError('batch is out of range', 400)
    if (job.records.length === 0) {
      return ok({ batch, batches, totalRecords: 0, result: emptyResult() })
    }
    let canWriteSuppliers = true
    try { requireWrite(req, 'suppliers') } catch { canWriteSuppliers = false }
    const { table, mapping } = tallyBatchTable(kind, job.records, batch)
    const options = readOptions(body.options)
    const run = () => runImport({ companyId, dataType, canWriteSuppliers, table, headerRow: 0, mapping, options, dryRun: mode === 'preview' })
    const result = mode === 'preview' ? await run() : await withImportLock(`${companyId}:${dataType.key}`, run)

    if (mode === 'commit') {
      const { imported, duplicates, errors, failed } = result.counts
      const problems = result.rows.filter((r) => r.status !== 'imported' && r.messages.length)
      const lines = problems.slice(0, MAX_HISTORY_ERRORS).map((r) => `Tally record ${r.line - 1}: ${r.messages.join('; ')}`)
      if (problems.length > MAX_HISTORY_ERRORS) lines.push(`… and ${problems.length - MAX_HISTORY_ERRORS} more`)
      try {
        await logAudit(db as never, {
          companyId, userName: actor.userName, action: 'IMPORT', entity: IMPORT_HISTORY_ENTITY[dataType.key],
          details: [
            `Import Center · ${dataType.label} from Tally company "${job.tallyCompany}" (connector), batch ${batch + 1} of ${batches}: ${imported} imported, ${duplicates} skipped (duplicates), ${errors + failed} failed`,
            ...lines,
          ].join('\n').slice(0, 4000),
        })
      } catch {
        // history is best-effort; the import itself already happened
      }
    }
    return ok({
      batch, batches, totalRecords: job.records.length, batchSize: TALLY_BATCH_ROWS,
      result: { ...result, rows: result.rows.filter((r) => r.status !== 'ready' && r.status !== 'imported').slice(0, MAX_ROWS_BACK) },
    })
  } catch (e) {
    return handleError(e)
  }
}

function emptyResult(): RunResult {
  return { headers: [], notes: [], rows: [], counts: { total: 0, ready: 0, imported: 0, duplicates: 0, errors: 0, failed: 0, withWarnings: 0 } }
}
