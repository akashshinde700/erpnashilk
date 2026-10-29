import { ApiError, companyRequired, requireWrite, type RequestActor } from '@/lib/erp-helpers'
import { IMPORT_LIMITS, IMPORT_SOURCES, findDataType, type ImportDataType } from '@/lib/import/fields'
import type { TableRow } from '@/lib/import/parse-file'
import type { MappingOptions } from '@/lib/import/apply-mapping'

/**
 * Common checks for every Import Center endpoint: the role may use the Import Center AND write the
 * target module (e.g. customers), the company is resolved server-side (companyRequired: home
 * company / linked firm only), and the data type is one that is actually enabled.
 */
export async function importContext(req: Request, body: { companyId?: unknown; dataType?: unknown }): Promise<{ actor: RequestActor; companyId: string; dataType: ImportDataType }> {
  const actor = requireWrite(req, 'import-center')
  const companyId = await companyRequired(req, typeof body.companyId === 'string' ? body.companyId : undefined)
  const dataType = findDataType(body.dataType)
  if (!dataType) throw new ApiError('Choose what to import (dataType)', 400)
  if (!dataType.available) throw new ApiError(`${dataType.label} import is not available yet`, 400)
  requireWrite(req, dataType.module)
  return { actor, companyId, dataType }
}

export function sourceLabel(v: unknown): string {
  return IMPORT_SOURCES.find((s) => s.key === v)?.label ?? 'Excel / CSV (any)'
}

/** File names are only ever shown as text; strip control characters and cap the length. */
export function cleanFileName(v: unknown): string {
  const s = String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim()
  return (s || 'upload').slice(0, 120)
}

const MAX_TABLE_ROWS = IMPORT_LIMITS.headerScanRows + 1 + IMPORT_LIMITS.maxDataRows
const MAX_TOTAL_CHARS = 3_000_000

/** The parsed table the browser sends back for preview / commit — re-checked, never trusted. */
export function readTable(raw: unknown): TableRow[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new ApiError('table is required — upload the file again', 400)
  if (raw.length > MAX_TABLE_ROWS) throw new ApiError(`Too many rows — the limit is ${IMPORT_LIMITS.maxDataRows} data rows per import`, 400)
  let chars = 0
  let lastLine = 0
  return raw.map((r) => {
    const row = r as { line?: unknown; cells?: unknown }
    if (!row || typeof row !== 'object' || !Number.isInteger(row.line) || !Array.isArray(row.cells)) throw new ApiError('table is malformed — upload the file again', 400)
    const line = row.line as number
    if (line <= lastLine) throw new ApiError('table is malformed — upload the file again', 400)
    lastLine = line
    if (row.cells.length > IMPORT_LIMITS.maxColumns) throw new ApiError(`Row ${line} has too many columns`, 400)
    const cells = row.cells.map((c) => {
      if (typeof c !== 'string') throw new ApiError('table is malformed — upload the file again', 400)
      if (c.length > IMPORT_LIMITS.maxCellChars) throw new ApiError(`Row ${line} has a cell that is too long`, 400)
      chars += c.length
      return c
    })
    if (chars > MAX_TOTAL_CHARS) throw new ApiError('The file is too large to import in one go', 400)
    return { line, cells }
  })
}

// One import at a time per company + data type in this server process, so a double-click or two
// tabs cannot race on duplicate checks (names are not unique in the database). Cluster deployments
// would need a database lock instead — see docs/import-center.md.
const running = new Set<string>()

export async function withImportLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  if (running.has(key)) throw new ApiError('An import of this kind is already running for this company — wait for it to finish', 409)
  running.add(key)
  try {
    return await fn()
  } finally {
    running.delete(key)
  }
}

const OPTION_KEYS = ['itemType', 'defaultWarehouseId', 'partyKind', 'unsignedMeans', 'goLiveDate'] as const

/** Import options from the browser: known keys only, short strings only. */
export function readOptions(raw: unknown): MappingOptions {
  const out: MappingOptions = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const k of OPTION_KEYS) {
    const v = (raw as Record<string, unknown>)[k]
    if (v === undefined || v === null || v === '') continue
    if (typeof v !== 'string' || v.length > 64) throw new ApiError(`Option ${k} is not valid`, 400)
    out[k] = v
  }
  return out
}
