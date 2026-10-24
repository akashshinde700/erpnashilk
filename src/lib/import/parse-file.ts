import { inflateRawSync } from 'node:zlib'
import * as XLSX from 'xlsx'
import { ApiError } from '@/lib/erp-helpers'
import { parseCsv, sniffDelimiter } from '@/lib/import/csv'
import { IMPORT_LIMITS } from '@/lib/import/fields'

/**
 * Server-side parsing of an uploaded import file into rows of text cells.
 *
 * The format is decided by the file's bytes, not its name: a ZIP is accepted only when it is an
 * .xlsx workbook, OLE (.xls) and other binaries are refused, anything else must decode as text
 * and is read as CSV / TSV. Before SheetJS sees an .xlsx, every ZIP entry is inflated here with a
 * hard output cap, so a zip bomb (including one that lies about its sizes) is rejected up front.
 * Formulas are never evaluated: a formula cell contributes only its last saved value.
 */

export interface TableRow {
  /** Row number as the user sees it: spreadsheet row / CSV record number. */
  line: number
  cells: string[]
}

export interface ParsedFile {
  format: 'csv' | 'xlsx'
  sheetNames: string[]
  sheet: string | null
  rows: TableRow[]
  /** Rows in the sheet beyond what was read (xlsx), so the caller can refuse oversize files. */
  totalRows: number
}

const fail = (message: string): never => { throw new ApiError(message, 400) }

const isZip = (b: Buffer) => b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04
const isOle = (b: Buffer) => b.length >= 8 && b.readUInt32BE(0) === 0xd0cf11e0 && b.readUInt32BE(4) === 0xa1b11ae1

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
    text = new TextDecoder('utf-16le').decode(buf.subarray(2)) // Excel "Unicode text"
  } else {
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(buf)
    } catch {
      text = new TextDecoder('windows-1252').decode(buf) // older Windows exports (ANSI)
    }
  }
  if (text.includes('\u0000')) fail('This file is not a CSV / text file — upload .csv or .xlsx')
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

export function parseImportFile(buf: Buffer, fileName: string, sheetName?: string | null): ParsedFile {
  if (buf.length === 0) fail('The file is empty')
  if (buf.length > IMPORT_LIMITS.maxFileBytes) fail(`The file is larger than ${IMPORT_LIMITS.maxFileBytes / (1024 * 1024)} MB`)
  const ext = (fileName.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1]) ?? ''

  if (isOle(buf)) fail('Legacy Excel 97-2003 (.xls) files are not supported — open the file in Excel and save it as .xlsx or CSV')
  if (isZip(buf)) {
    if (ext && ext !== 'xlsx') fail(`The file content is a ZIP / Excel workbook but the name ends in .${ext}`)
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
    return { format: 'xlsx', sheetNames, sheet, rows, totalRows }
  }

  if (ext && !['csv', 'tsv', 'txt'].includes(ext)) fail(`Unsupported file type .${ext} — upload .csv or .xlsx`)
  const text = decodeText(buf)
  const records = parseCsv(text, sniffDelimiter(text), { keepBlank: true })
  const rows = nonBlank(records.map((cells, i) => ({ line: i + 1, cells })))
  checkCells(rows)
  return { format: 'csv', sheetNames: [], sheet: null, rows, totalRows: records.length }
}
