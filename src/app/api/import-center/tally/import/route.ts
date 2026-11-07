import { db } from '@/lib/db'
import { ApiError, handleError, logAudit, ok, requireWrite } from '@/lib/erp-helpers'
import { IMPORT_HISTORY_ENTITY } from '@/lib/import/fields'
import { runImport, type RunResult, type RunRow } from '@/lib/import/run'
import { assertConnectorEnabled } from '@/lib/tally/connector'
import { EXPORT_JOB, getJobFor, jobRecords } from '@/lib/tally/jobs'
import { linkImported, linkedGuids } from '@/lib/tally/links'
import { TALLY_BATCH_ROWS, batchCount, tallyBatchTable, type TallyImportKind } from '@/lib/tally/to-import'
import { importContext, readOptions, withImportLock } from '../../_shared'

const MAX_HISTORY_ERRORS = 25
// Rows sent back per batch besides the counts: the ones that need attention (never silently dropped from history)
const MAX_ROWS_BACK = 200

// POST /api/import-center/tally/import
//   { companyId?, jobId, dataType: customers | suppliers | items, mode: 'preview' | 'commit', batch, options?, confirm? }
// → { batch, batches, totalRecords, result }
// Takes the records of a finished Tally export job (TallyJobChunk — the browser never sends Tally data) and runs one
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
    if (job.status !== 'done') throw new ApiError('The data has not been read from Tally yet', 409)
    const records = await jobRecords(job)
    if (records.length !== job.recordCount) throw new ApiError('The data read from Tally is no longer kept — read it from Tally again', 410)
    const mode = body.mode
    if (mode !== 'preview' && mode !== 'commit') throw new ApiError('mode must be preview or commit', 400)
    if (mode === 'commit' && body.confirm !== true) throw new ApiError('Confirm the import first', 400)
    const batches = batchCount(records)
    const batch = Number(body.batch)
    if (!Number.isInteger(batch) || batch < 0 || batch >= batches) throw new ApiError('batch is out of range', 400)
    if (records.length === 0) {
      return ok({ batch, batches, totalRecords: 0, result: emptyResult() })
    }
    let canWriteSuppliers = true
    try { requireWrite(req, 'suppliers') } catch { canWriteSuppliers = false }
    const { table, mapping } = tallyBatchTable(kind, records, batch)
    // Line n of the table is Tally record n - 2 of the whole export
    const recordAt = (line: number) => records[line - 2]
    const tallyCompany = job.tallyCompany ?? ''
    // Records whose Tally GUID was imported before (into a record that still exists) are not imported again, even if
    // they were renamed in Tally since
    const known = await linkedGuids(companyId, tallyCompany, kind, table.slice(1).map((t) => recordAt(t.line)?.guid).filter((g): g is string => !!g))
    const isKnown = (line: number) => known.has(recordAt(line)?.guid ?? '')
    const rest = [table[0], ...table.slice(1).filter((t) => !isKnown(t.line))]
    const linkedRows: RunRow[] = table.slice(1).filter((t) => isKnown(t.line)).map((t) => ({
      line: t.line, status: 'duplicate', messages: ['Already imported from Tally before (same Tally GUID), so not imported again'], warnings: [],
      values: { name: recordAt(t.line)?.name ?? '' },
    }))
    const options = readOptions(body.options)
    const run = () => runImport({ companyId, dataType, canWriteSuppliers, table: rest, headerRow: 0, mapping, options, dryRun: mode === 'preview' })
    let result = rest.length > 1 ? (mode === 'preview' ? await run() : await withImportLock(`${companyId}:${dataType.key}`, run)) : emptyResult()
    if (linkedRows.length) {
      result = {
        ...result, rows: [...result.rows, ...linkedRows].sort((a, b) => a.line - b.line),
        counts: { ...result.counts, total: result.counts.total + linkedRows.length, duplicates: result.counts.duplicates + linkedRows.length },
      }
    }
    if (mode === 'commit') {
      // Keep the Tally GUID of each record this batch created (TallyMasterLink; the business tables are not changed)
      const imported = result.rows.filter((r) => r.status === 'imported' && r.code && recordAt(r.line)?.guid)
        .map((r) => ({ guid: recordAt(r.line)!.guid, code: r.code! }))
      try {
        await linkImported(companyId, tallyCompany, kind, imported)
      } catch (e) {
        console.error('[tally] saving Tally GUID links failed', { jobId: job.id, error: (e as { code?: string })?.code ?? (e instanceof Error ? e.name : 'unknown') })
      }
    }

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
      batch, batches, totalRecords: records.length, batchSize: TALLY_BATCH_ROWS,
      result: { ...result, rows: result.rows.filter((r) => r.status !== 'ready' && r.status !== 'imported').slice(0, MAX_ROWS_BACK) },
    })
  } catch (e) {
    return handleError(e)
  }
}

function emptyResult(): RunResult {
  return { headers: [], notes: [], rows: [], counts: { total: 0, ready: 0, imported: 0, duplicates: 0, errors: 0, failed: 0, withWarnings: 0 } }
}
