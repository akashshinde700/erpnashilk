import { inflateRawSync } from 'node:zlib'
import * as XLSX from 'xlsx'
import { ApiError } from '@/lib/erp-helpers'
import { parseCsv, sniffDelimiter } from '@/lib/import/csv'
import { IMPORT_LIMITS } from '@/lib/import/fields'
import { jsonTables, xmlTables, type RecordTable } from '@/lib/import/structured'
import { looksLikeTally, readTallyXml, type TallyFile, type TallyVoucherCheck } from '@/lib/import/tally-xml'

/**
 * Server-side parsing of an uploaded import file into rows of text cells.
 *
 * The format is decided by the file's bytes, not its name (a name that contradicts the content is refused):
 *  - ZIP → only an .xlsx workbook. Before SheetJS sees it, every ZIP entry is inflated here with a hard output cap, so
 *    a zip bomb (including one that lies about its sizes) is rejected up front. Formulas are never evaluated.
 *  - %PDF → refused with a clear message: tables in a PDF cannot be read back reliably, and business fields are never
 *    guessed. OLE (.xls) and other binaries are refused.
 *  - text (UTF-8, UTF-16 LE/BE; Windows-1252 for old ANSI exports) starting with '<' → XML: Tally XML has its own
 *    reader (tally-xml.ts), any other XML the generic one (structured.ts); '{' / '[' → JSON (structured.ts); anything
 *    else → delimited text (CSV / TSV; .txt also with '|' or ';').
 * XML and JSON may hold several kinds of record; each is offered like a sheet of a workbook. Nothing is stored and
 * nothing in the file is ever executed.
 */

export interface TableRow {
  /** Row number as the user sees it: spreadsheet row / CSV record number. */
  line: number
  cells: string[]
}

export type FileFormat = 'csv' | 'txt' | 'xlsx' | 'xml' | 'tally-xml' | 'json'

export interface ParsedFile {
  format: FileFormat
  /** Sheets of a workbook, or the kinds of record found in an XML / JSON file. */
  sheetNames: string[]
  sheet: string | null
  rows: TableRow[]
  /** Rows in the sheet beyond what was read (xlsx), so the caller can refuse oversize files. */
  totalRows: number
  /** Things the user should know about how the file was read (e.g. nested lists left out). */
  notes: string[]
  /** Tally XML: what the file holds. */
  tally?: Pick<TallyFile, 'layout' | 'company' | 'objectCounts'>
  /** Tally XML with vouchers: the check (vouchers are never imported from a file). */
  vouchers?: TallyVoucherCheck
}

export const STRUCTURED_FORMATS: FileFormat[] = ['xml', 'tally-xml', 'json']

const fail = (message: string): never => { throw new ApiError(message, 400) }

const isZip = (b: Buffer) => b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04
const isOle = (b: Buffer) => b.length >= 8 && b.readUInt32BE(0) === 0xd0cf11e0 && b.readUInt32BE(4) === 0xa1b11ae1
const isPdf = (b: Buffer) => b.subarray(0, 1024).includes('%PDF-')

/** Walk the ZIP central directory and inflate every entry under a total output budget. Returns entry names. */
export function inspectZip(buf: Buffer, limits = IMPORT_LIMITS): string[] {
  const bad = (why: string): never => fail(`This .xlsx file could not be read safely (${why})`)
  const minEocd = Math.max(0, buf.length - 22 - 0xffff)
  let eocd = -1
  for (let i = buf.length - 22; i >= minEocd; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) bad('no ZIP directory')
  const entries = buf.readUInt16LE(eocd + 10)
  const cdSize = buf.readUInt32LE(eocd + 12)
  const cdOffset = buf.readUInt32LE(eocd + 16)
  if (entries === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) bad('ZIP64 is not supported')
  if (entries > limits.maxXlsxEntries) bad('too many parts')
  if (cdOffset + cdSize > buf.length) bad('truncated')

  let budget: number = limits.maxXlsxUncompressedBytes
  const names: string[] = []
  let p = cdOffset
  for (let n = 0; n < entries; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) bad('corrupt directory')
    const flags = buf.readUInt16LE(p + 8)
    const method = buf.readUInt16LE(p + 10)
    const compSize = buf.readUInt32LE(p + 20)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOffset = buf.readUInt32LE(p + 42)
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen)
    p += 46 + nameLen + extraLen + commentLen
    if (flags & 0x1) bad('password-protected')
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== 0x04034b50) bad('corrupt entry')
    const dataStart = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28)
    if (dataStart + compSize > buf.length) bad('truncated entry')
    const data = buf.subarray(dataStart, dataStart + compSize)
    let size: number
    if (method === 0) {
      size = compSize
    } else if (method === 8) {
      if (budget <= 0) bad('too large when unpacked')
      try {
        size = inflateRawSync(data, { maxOutputLength: budget }).length
      } catch {
        return bad('too large when unpacked or corrupt')
      }
    } else {
      return bad('unsupported compression')
    }
    budget -= size
    if (budget < 0) bad('too large when unpacked')
    names.push(name)
  }
  return names
}

function decodeText(buf: Buffer): string {
  let text: string
  if (buf[0] === 0xff && buf[1] === 0xfe) {
    text = new TextDecoder('utf-16le').decode(buf.subarray(2)) // Excel "Unicode text", Tally XML
  } else if (buf[0] === 0xfe && buf[1] === 0xff) {
    text = new TextDecoder('utf-16be').decode(buf.subarray(2))
  } else if (buf.length >= 4 && buf[1] === 0 && buf[3] === 0 && buf[0] !== 0 && buf[2] !== 0) {
    text = new TextDecoder('utf-16le').decode(buf) // UTF-16 LE without a byte-order mark
  } else {
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(buf)
    } catch {
      text = new TextDecoder('windows-1252').decode(buf) // older Windows exports (ANSI)
    }
  }
  if (text.includes('\u0000')) fail('This file is not a CSV / text file (it contains binary data) — upload .xlsx, .csv, .txt, .xml or .json')
  return text.replace(/^\ufeff/, '')
}

function checkCells(rows: TableRow[], limits = IMPORT_LIMITS) {
  for (const r of rows) {
    if (r.cells.length > limits.maxColumns) fail(`Row ${r.line} has ${r.cells.length} columns — the limit is ${limits.maxColumns}`)
    for (const c of r.cells) {
      if (c.length > limits.maxCellChars) fail(`Row ${r.line} has a cell longer than ${limits.maxCellChars} characters`)
    }
  }
}

const nonBlank = (rows: TableRow[]) => rows.filter((r) => r.cells.some((c) => c.trim() !== ''))

/** Most rows read from a sheet: room for title rows above the header + the data row cap. */
const READ_ROWS = IMPORT_LIMITS.headerScanRows + 1 + IMPORT_LIMITS.maxDataRows

export function parseImportFile(buf: Buffer, fileName: string, sheetName?: string | null, opts: { preferredSheet?: string } = {}): ParsedFile {
  if (buf.length === 0) fail('The file is empty')
  const ext = (fileName.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1]) ?? ''

  if (isOle(buf)) fail('Legacy Excel 97-2003 (.xls) files are not supported — open the file in Excel and save it as .xlsx or CSV')
  if (isZip(buf)) {
    if (ext === 'vyb' || ext === 'vyp') {
      fail('This is a Vyapar backup — import it from Import Center → Vyapar → "Upload a Vyapar backup (.vyb)", where customers, suppliers, items and opening stock are read from the backup itself.')
    }
    if (ext && ext !== 'xlsx') fail(`The file content is a ZIP / Excel workbook but the name ends in .${ext}`)
    if (buf.length > IMPORT_LIMITS.maxFileBytes) fail(`The file is larger than ${IMPORT_LIMITS.maxFileBytes / (1024 * 1024)} MB`)
    const parts = inspectZip(buf)
    if (!parts.includes('xl/workbook.xml')) fail('Only Excel .xlsx workbooks are supported (this ZIP is not one — .xlsb, .ods and others are not supported)')
    let wb: XLSX.WorkBook
    try {
      wb = XLSX.read(buf, {
        type: 'buffer', dense: true, sheetRows: READ_ROWS,
        cellFormula: false, cellHTML: false, cellNF: false, cellStyles: false, bookVBA: false, WTF: false,
      })
    } catch {
      return fail('The workbook could not be read — save it again from Excel as .xlsx')
    }
    const sheetNames = wb.SheetNames.slice()
    if (!sheetNames.length) fail('The workbook has no sheets')
    const sheet = sheetName ?? sheetNames[0]
    const ws = sheetNames.includes(sheet) ? wb.Sheets[sheet] : undefined
    if (!ws) return fail(`Sheet "${sheetName}" not found`)
    const ref = ws['!fullref'] || ws['!ref']
    const range = ref ? XLSX.utils.decode_range(ref) : null
    const totalRows = range ? range.e.r - range.s.r + 1 : 0
    const startRow = ws['!ref'] ? XLSX.utils.decode_range(ws['!ref']).s.r : 0
    // raw:false → the text Excel displays (formatted numbers / dates), never formulas
    const grid = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: false, defval: '', blankrows: true })
    const rows = nonBlank(grid.map((cells, i) => ({ line: startRow + i + 1, cells: cells.map((c) => (c === null || c === undefined ? '' : String(c))) })))
    checkCells(rows)
    return { format: 'xlsx', sheetNames, sheet, rows, totalRows, notes: [] }
  }

  if (isPdf(buf)) {
    fail('PDF files cannot be imported: the rows and columns of a PDF cannot be read back reliably, and ManuFlow does not guess business data. Export the same report to Excel (.xlsx), CSV or XML instead.')
  }
  const known = ['csv', 'tsv', 'txt', 'xml', 'json', '']
  if (!known.includes(ext)) fail(`Unsupported file type .${ext} — upload .xlsx, .csv, .txt, .xml or .json`)
  if (buf.length > IMPORT_LIMITS.maxStructuredBytes) fail(`The file is larger than ${IMPORT_LIMITS.maxStructuredBytes / (1024 * 1024)} MB`)
  const text = decodeText(buf)
  // the first non-blank character, without copying the (up to 32 MB) text
  const start = /\S/.exec(text.slice(0, 4096))?.[0] ?? ''
  const kind = start === '<' ? 'xml' : start === '{' || start === '[' ? 'json' : 'text'
  if (ext === 'xml' && kind !== 'xml') fail('The file name ends in .xml but the content is not XML')
  if (ext === 'json' && kind !== 'json') fail('The file name ends in .json but the content is not JSON')
  if (['csv', 'tsv', 'txt'].includes(ext) && kind !== 'text') fail(`The file name ends in .${ext} but the content is ${kind.toUpperCase()} — save it as .${kind}`)
  if (kind === 'text') {
    if (buf.length > IMPORT_LIMITS.maxFileBytes) fail(`The file is larger than ${IMPORT_LIMITS.maxFileBytes / (1024 * 1024)} MB`)
    return delimited(text, ext === 'txt')
  }
  if (kind === 'json') return fromTables('json', jsonTables(text), sheetName, opts.preferredSheet)
  if (looksLikeTally(text)) {
    let tally: TallyFile
    try {
      tally = readTallyXml(text)
    } catch (e) {
      if (e instanceof ApiError) throw e
      return fail('This looks like a Tally XML file, but it could not be read')
    }
    const meta = { layout: tally.layout, company: tally.company, objectCounts: tally.objectCounts }
    if (!tally.tables.length) {
      return { format: 'tally-xml', sheetNames: [], sheet: null, rows: [], totalRows: 0, notes: [], tally: meta, ...(tally.vouchers ? { vouchers: tally.vouchers } : {}) }
    }
    return { ...fromTables('tally-xml', tally.tables, sheetName, opts.preferredSheet), tally: meta, ...(tally.vouchers ? { vouchers: tally.vouchers } : {}) }
  }
  return fromTables('xml', xmlTables(text), sheetName, opts.preferredSheet)
}

/** CSV / TSV, and .txt: text in columns. A .txt with no column separator at all is refused (it has no fields). */
function delimited(text: string, isTxt: boolean): ParsedFile {
  let delimiter = sniffDelimiter(text)
  if (isTxt) {
    // Columns only if most lines split into as many fields as the first one (free text with a stray comma does not)
    const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '')
    const consistent = (d: string) => {
      const n = parseCsv(lines[0] ?? '', d)[0]?.length ?? 0
      if (n < 2) return 0
      const same = lines.filter((l) => (parseCsv(l, d)[0]?.length ?? 0) === n).length
      return same >= Math.max(2, Math.ceil(lines.length * 0.9)) ? n : 0
    }
    const best = ['\t', '|', ';', ','].map((d) => [d, consistent(d)] as const).sort((a, b) => b[1] - a[1])[0]
    if (!best[1]) fail('This text file has no columns: use one record per line with the fields separated by a tab, comma, semicolon or | (and the column names on the first line)')
    delimiter = best[0]
  }
  const records = parseCsv(text, delimiter, { keepBlank: true })
  const rows = nonBlank(records.map((cells, i) => ({ line: i + 1, cells })))
  checkCells(rows)
  return { format: isTxt ? 'txt' : 'csv', sheetNames: [], sheet: null, rows, totalRows: records.length, notes: [] }
}

/** One of the record tables of an XML / JSON file: the one asked for, else the preferred one, else the first. */
function fromTables(format: FileFormat, tables: RecordTable[], sheetName?: string | null, preferred?: string): ParsedFile {
  if (!tables.length) fail('No records were found in the file')
  const pick = (sheetName && tables.find((t) => t.name === sheetName))
    || (preferred && tables.find((t) => t.name.startsWith(preferred)))
    || tables.find((t) => t.rows.length > 1) || tables[0]
  if (sheetName && pick.name !== sheetName) fail(`"${sheetName}" was not found in the file`)
  checkCells(pick.rows)
  return {
    format, sheetNames: tables.map((t) => t.name), sheet: pick.name, rows: pick.rows, totalRows: pick.rows.length, notes: pick.notes,
  }
}
