import { ApiError, handleError, ok } from '@/lib/erp-helpers'
import { IMPORT_LIMITS, detectHeaderRow, suggestMapping } from '@/lib/import/fields'
import { parseImportFile } from '@/lib/import/parse-file'
import { cleanFileName, importContext } from '../_shared'

// POST /api/import-center/parse — multipart form: file, dataType, companyId?, sheet?
// Parses the upload in memory (nothing is stored, nothing is written) and returns the rows,
// the detected header row and a suggested column mapping for the user to review.
export async function POST(req: Request) {
  try {
    // Refuse oversize bodies before reading them (multipart overhead allowance on top of the file cap)
    const len = Number(req.headers.get('content-length') || '')
    if (!Number.isFinite(len) || len <= 0) throw new ApiError('Upload size is required (Content-Length)', 411)
    if (len > IMPORT_LIMITS.maxFileBytes + 64 * 1024) throw new ApiError(`The file is larger than ${IMPORT_LIMITS.maxFileBytes / (1024 * 1024)} MB`, 413)

    const form = await req.formData().catch(() => null)
    if (!form) throw new ApiError('Send the file as multipart/form-data', 400)
    const { dataType } = await importContext(req, { companyId: form.get('companyId') ?? undefined, dataType: form.get('dataType') })
    const file = form.get('file')
    if (!file || typeof file === 'string') throw new ApiError('Choose a file to upload', 400)
    if (file.size > IMPORT_LIMITS.maxFileBytes) throw new ApiError(`The file is larger than ${IMPORT_LIMITS.maxFileBytes / (1024 * 1024)} MB`, 413)
    const sheet = form.get('sheet')
    const fileName = cleanFileName(file.name)

    const parsed = parseImportFile(Buffer.from(await file.arrayBuffer()), fileName, typeof sheet === 'string' && sheet ? sheet : null)
    if (!parsed.rows.length) throw new ApiError('No rows found in the file', 400)
    const readLimit = IMPORT_LIMITS.headerScanRows + 1 + IMPORT_LIMITS.maxDataRows
    if (parsed.format === 'xlsx' && parsed.totalRows > readLimit) {
      throw new ApiError(`The sheet has about ${parsed.totalRows} rows — the limit is ${IMPORT_LIMITS.maxDataRows} data rows per import. Split it and import in parts.`, 400)
    }
    const headerRow = detectHeaderRow(dataType, parsed.rows.map((r) => r.cells))
    const dataRows = parsed.rows.length - headerRow - 1
    if (dataRows > IMPORT_LIMITS.maxDataRows) {
      throw new ApiError(`The file has ${dataRows} data rows — the limit is ${IMPORT_LIMITS.maxDataRows} per import. Split it and import in parts.`, 400)
    }
    const suggestion = suggestMapping(dataType, parsed.rows[headerRow]?.cells ?? [])
    return ok({
      fileName, format: parsed.format, sheetNames: parsed.sheetNames, sheet: parsed.sheet,
      table: parsed.rows, headerRow, suggestion,
    })
  } catch (e) {
    return handleError(e)
  }
}
