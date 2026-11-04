import { gunzipSync } from 'node:zlib'
import { ApiError, handleError, ok } from '@/lib/erp-helpers'
import { IMPORT_LIMITS, PARTS_DATA_TYPES, detectHeaderRow, suggestMapping } from '@/lib/import/fields'
import { STRUCTURED_FORMATS, parseImportFile } from '@/lib/import/parse-file'
import { TALLY_TABLE_FOR } from '@/lib/import/tally-xml'
import { LARGE_UPLOAD_BYTES, cleanFileName, importContext, takeLargeUploadSlot } from '../_shared'

const MB = 1024 * 1024

// POST /api/import-center/parse — multipart form: file, dataType, companyId?, sheet?, encoding? ('gzip')
// Parses the upload in memory (nothing is stored, nothing is written) and returns the rows, the detected header row
// and a suggested column mapping for the user to review. Large XML / JSON is sent gzip-compressed by the browser (the
// proxy passes at most 10 MB); it is unpacked here with a hard cap, so a compressed "bomb" cannot fill memory.
// A Tally voucher file returns the voucher check instead of rows (vouchers are not imported from a file).
export async function POST(req: Request) {
  let release: (() => void) | null = null
  try {
    // Refuse oversize bodies before reading them (multipart overhead allowance on top of the upload cap)
    const len = Number(req.headers.get('content-length') || '')
    if (!Number.isFinite(len) || len <= 0) throw new ApiError('Upload size is required (Content-Length)', 411)
    if (len > IMPORT_LIMITS.maxUploadBytes + 64 * 1024) throw new ApiError(`The upload is larger than ${IMPORT_LIMITS.maxUploadBytes / MB} MB`, 413)
    // A large body, or a compressed one (it may unpack to 32 MB), needs one of the few large-upload slots
    if (len >= LARGE_UPLOAD_BYTES) release = takeLargeUploadSlot()

    const form = await req.formData().catch(() => null)
    if (!form) throw new ApiError('Send the file as multipart/form-data', 400)
    const { dataType } = await importContext(req, { companyId: form.get('companyId') ?? undefined, dataType: form.get('dataType') })
    const file = form.get('file')
    if (!file || typeof file === 'string') throw new ApiError('Choose a file to upload', 400)
    if (file.size > IMPORT_LIMITS.maxUploadBytes) throw new ApiError(`The upload is larger than ${IMPORT_LIMITS.maxUploadBytes / MB} MB`, 413)
    const sheet = form.get('sheet')
    const fileName = cleanFileName(file.name)
    // Spreadsheets and text keep their own, smaller cap (refused before reading, as before XML / JSON were accepted)
    const ext = fileName.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? ''
    if (form.get('encoding') !== 'gzip' && !['xml', 'json'].includes(ext) && file.size > IMPORT_LIMITS.maxFileBytes) {
      throw new ApiError(`The file is larger than ${IMPORT_LIMITS.maxFileBytes / MB} MB`, 413)
    }

    if (form.get('encoding') === 'gzip' && !release) release = takeLargeUploadSlot()
    let buf = Buffer.from(await file.arrayBuffer())
    if (form.get('encoding') === 'gzip') {
      if (buf[0] !== 0x1f || buf[1] !== 0x8b) throw new ApiError('The compressed upload is not gzip data', 400)
      try {
        buf = gunzipSync(buf, { maxOutputLength: IMPORT_LIMITS.maxStructuredBytes + 1 })
      } catch {
        throw new ApiError(`The file could not be unpacked, or it is larger than ${IMPORT_LIMITS.maxStructuredBytes / MB} MB`, 400)
      }
    }

    const parsed = parseImportFile(buf, fileName, typeof sheet === 'string' && sheet ? sheet : null, { preferredSheet: TALLY_TABLE_FOR[dataType.key] })
    const vouchers = dataType.key === 'tally-vouchers'
    if (vouchers || (parsed.vouchers && !parsed.rows.length)) {
      if (!parsed.vouchers) throw new ApiError('This file has no Tally vouchers. Choose what the file holds (customers, suppliers, items…) instead.', 400)
      if (!vouchers) {
        throw new ApiError(`This file holds ${parsed.vouchers.count} Tally vouchers, not ${dataType.label.toLowerCase()}. Choose "Tally vouchers (check only)" to check them — vouchers are not imported into ManuFlow's books.`, 400)
      }
      return ok({
        fileName, format: parsed.format, sheetNames: [], sheet: null, table: [], headerRow: 0, notes: parsed.notes,
        suggestion: suggestMapping(dataType, []), tally: parsed.tally, vouchers: parsed.vouchers,
      })
    }
    if (!parsed.rows.length) throw new ApiError('No rows found in the file', 400)
    const structured = STRUCTURED_FORMATS.includes(parsed.format)
    const readLimit = IMPORT_LIMITS.headerScanRows + 1 + IMPORT_LIMITS.maxDataRows
    if (parsed.format === 'xlsx' && parsed.totalRows > readLimit) {
      throw new ApiError(`The sheet has about ${parsed.totalRows} rows — the limit is ${IMPORT_LIMITS.maxDataRows} data rows per import. Split it and import in parts.`, 400)
    }
    // XML / JSON: the field names are the first row; a spreadsheet's header row is detected (title rows above it)
    const headerRow = structured ? 0 : detectHeaderRow(dataType, parsed.rows.map((r) => r.cells))
    const dataRows = parsed.rows.length - headerRow - 1
    // More rows than one import takes: XML / JSON masters are checked and imported in parts of 500 by the browser
    const rowLimit = structured && PARTS_DATA_TYPES.includes(dataType.key) ? IMPORT_LIMITS.maxStructuredDataRows : IMPORT_LIMITS.maxDataRows
    if (dataRows > rowLimit) {
      throw new ApiError(`The file has ${dataRows} records — the limit is ${rowLimit} per import${structured && rowLimit === IMPORT_LIMITS.maxDataRows ? ` for ${dataType.label.toLowerCase()}` : ''}. Split it and import in parts.`, 400)
    }
    const suggestion = suggestMapping(dataType, parsed.rows[headerRow]?.cells ?? [])
    return ok({
      fileName, format: parsed.format, sheetNames: parsed.sheetNames, sheet: parsed.sheet,
      table: parsed.rows, headerRow, suggestion, notes: parsed.notes, tally: parsed.tally,
    })
  } catch (e) {
    return handleError(e)
  } finally {
    release?.()
  }
}
