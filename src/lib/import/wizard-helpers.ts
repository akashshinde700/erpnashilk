// Import Center wizard helpers — client + server safe (no Node / DB imports), unit-tested.
import { IMPORT_LIMITS, findDataType } from '@/lib/import/fields'
import { normalizeItemName } from '@/lib/item-match'
import type { TableRow } from '@/lib/import/parse-file'
import type { RunResult, RunRow, RunRowStatus } from '@/lib/import/run'

/** Names and one-line hints of the data types as shown in the wizard. */
export const DATA_TYPE_UI: Record<string, { name: string; hint: string }> = {
  customers: { name: 'Customers', hint: 'Name, GSTIN, phone, address' },
  suppliers: { name: 'Suppliers', hint: 'Name, GSTIN, bank details' },
  items: { name: 'Items', hint: 'Name, HSN, GST rate, unit, price' },
  'opening-stock': { name: 'Opening Stock', hint: 'Stock on hand at the go-live date' },
  'opening-balances': { name: 'Opening Balances', hint: 'Check only — nothing is saved' },
  'tally-vouchers': { name: 'Tally Vouchers (XML)', hint: 'Check only — sales, purchases… read from a Tally XML file; nothing is saved' },
  sales: { name: 'Sales Transactions', hint: 'Coming soon' },
  purchases: { name: 'Purchase Transactions', hint: 'Coming soon' },
  receipts: { name: 'Receipts', hint: 'Coming soon' },
  payments: { name: 'Payments', hint: 'Coming soon' },
  'credit-notes': { name: 'Credit Notes', hint: 'Coming soon' },
  'debit-notes': { name: 'Debit Notes', hint: 'Coming soon' },
  'company-info': { name: 'Company Information', hint: 'Coming soon' },
}

export const STATUS_LABEL: Record<RunRowStatus, string> = {
  ready: 'Ready', duplicate: 'Skipped (already exists)', error: 'Error', imported: 'Imported', failed: 'Failed',
}

/** Example values for the sample templates (keys = catalogue field keys). */
const SAMPLES: Record<string, Record<string, string>[]> = {
  customers: [
    { name: 'Shree Traders', gstin: '27ABCDE1234F1Z5', phone: '9876543210', email: 'accounts@shreetraders.in', addressLine: 'Plot 14, MIDC', city: 'Pune', state: 'Maharashtra', pincode: '411026' },
    { name: 'Patel & Co', phone: '9822012345', city: 'Surat', state: 'Gujarat' },
  ],
  suppliers: [
    { name: 'Tata Steel Processing', gstin: '27AAACT9876M1ZR', phone: '9822166666', city: 'Navi Mumbai', state: 'Maharashtra', paymentTermsDays: '45', bankIfsc: 'HDFC0001234', bankAccountNo: '50100123456789' },
    { name: 'SK Bearings', city: 'Delhi', state: 'Delhi' },
  ],
  items: [
    { name: 'MS Plate 10mm', code: 'RM-001', hsn: '7208', gstRate: '18', uom: 'KG', purchasePrice: '110', sellPrice: '140', category: 'Steel' },
    { name: 'Machining Labour', hsn: '998898', gstRate: '18', uom: 'HRS', sellPrice: '500' },
  ],
  'opening-stock': [
    { itemCode: 'RM-001', warehouse: 'MAIN', qty: '100', rate: '110', value: '11000' },
    { itemName: 'Machining Oil', warehouse: 'MAIN', qty: '20', value: '3000' },
  ],
  'opening-balances': [
    { name: 'Shree Traders', balance: '12500 Dr' },
    { name: 'Patel & Co', balance: '400 Cr' },
  ],
}

const csvCell = (v: string) => (/[",\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v)

/**
 * Sample CSV for a data type: one column per field, headed by the field's first alias — the same
 * names the column matcher recognises, so a filled-in template maps itself.
 */
export function templateCsv(dataTypeKey: string): string | null {
  const dt = findDataType(dataTypeKey)
  if (!dt || !dt.available || !dt.fields.length) return null
  const header = dt.fields.map((f) => f.aliases[0])
  const rows = (SAMPLES[dt.key] ?? []).map((s) => dt.fields.map((f) => s[f.key] ?? ''))
  return [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\n')
}

/** Cell for a downloaded report: anything a spreadsheet would run as a formula is neutralised. */
export function reportCell(v: string | number): string {
  let s = String(v ?? '')
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return csvCell(s)
}

/** Problem rows (errors, failures, skips, warnings) as CSV for the user to fix in the source file. */
export function problemRowsCsv(rows: RunRow[]): string {
  const out = [['Row', 'Status', 'Name', 'Problems', 'Warnings']]
  for (const r of rows) {
    if (r.status === 'ready' || r.status === 'imported') { if (!r.warnings.length) continue }
    out.push([String(r.line), STATUS_LABEL[r.status], r.values.name || r.values.itemName || r.values.itemCode || '', r.messages.join('; '), r.warnings.join('; ')])
  }
  return out.map((r) => r.map(reportCell).join(',')).join('\n')
}

/** Message for a failed request, in plain words where the cause is generic; the server's own text otherwise. */
export function friendlyError(e: unknown): string {
  const msg = e instanceof Error ? e.message : ''
  if (/Failed to fetch|NetworkError|Load failed|network/i.test(msg)) return 'Could not reach the server. Check your internet connection and try again.'
  if (/not allowed|permission|403/i.test(msg)) return 'You do not have permission to do this. Please contact your administrator.'
  if (/larger than|413/i.test(msg)) return 'The file is too large (limit 2 MB). Split it into smaller files and import them one by one.'
  if (/session|sign in/i.test(msg)) return 'Your session has ended. Please sign in again.'
  if (/already running/i.test(msg)) return 'Another import of this kind is running right now. Try again when it has finished.'
  if (/Request failed \(5|Something went wrong/i.test(msg)) return 'Something went wrong on the server. Please try again in a moment.'
  return msg || 'Something went wrong. Please try again.'
}

/** Browser download of a text file (UTF-8 with BOM so Excel shows non-ASCII text and ₹ correctly). */
export function downloadText(fileName: string, text: string) {
  const blob = new Blob(['\ufeff' + text], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  a.click()
  URL.revokeObjectURL(url)
}

// ---------------------------------------------------------------- file types (the server checks the content again)

/** File types the Import Center reads, as offered in the file picker and explained to the user. */
export const FILE_TYPES: { ext: string; label: string; maxBytes: number; structured: boolean }[] = [
  { ext: 'xlsx', label: 'Excel workbook', maxBytes: IMPORT_LIMITS.maxFileBytes, structured: false },
  { ext: 'csv', label: 'CSV', maxBytes: IMPORT_LIMITS.maxFileBytes, structured: false },
  { ext: 'tsv', label: 'Tab-separated text', maxBytes: IMPORT_LIMITS.maxFileBytes, structured: false },
  { ext: 'txt', label: 'Text in columns (tab, comma, ; or |)', maxBytes: IMPORT_LIMITS.maxFileBytes, structured: false },
  { ext: 'xml', label: 'XML (Tally XML too)', maxBytes: IMPORT_LIMITS.maxStructuredBytes, structured: true },
  { ext: 'json', label: 'JSON', maxBytes: IMPORT_LIMITS.maxStructuredBytes, structured: true },
]
export const FILE_ACCEPT = [...FILE_TYPES.map((t) => `.${t.ext}`), '.pdf'].join(',')

/** First check of a chosen file in the browser (name and size only): '' = fine, else the problem in words. */
export function fileProblemFor(name: string, size: number): string {
  const ext = name.toLowerCase().split('.').pop() ?? ''
  if (ext === 'vyb') return 'Vyapar backup files (.vyb) are read in Import from Vyapar → "Upload a Vyapar backup".'
  if (ext === 'xls') return 'Old Excel files (.xls) are not supported. Open the file in Excel and use "Save As → .xlsx".'
  if (ext === 'pdf') return 'PDF files cannot be imported: the rows and columns of a PDF cannot be read back reliably. Export the same report to Excel, CSV or XML instead.'
  const type = FILE_TYPES.find((t) => t.ext === ext)
  if (!type) return `Files of this type cannot be imported. Supported: ${FILE_TYPES.map((t) => `.${t.ext}`).join(', ')}.`
  if (size === 0) return 'The file is empty.'
  if (size > type.maxBytes) return `The file is too large (${(size / 1024 / 1024).toFixed(1)} MB). The limit for .${ext} is ${type.maxBytes / 1024 / 1024} MB.`
  return ''
}

// ---------------------------------------------------------------- parts (XML / JSON with more than 500 records)

/**
 * A parsed table with more data rows than one import takes, cut into parts of `size` data rows: each part is the
 * header row plus its rows, with the original line numbers (so problems point at the right record).
 */
export function splitParts(table: TableRow[], headerRow: number, size: number = IMPORT_LIMITS.maxDataRows): { table: TableRow[]; headerRow: number }[] {
  const data = table.slice(headerRow + 1)
  if (data.length <= size) return [{ table, headerRow }]
  const parts: { table: TableRow[]; headerRow: number }[] = []
  for (let i = 0; i < data.length; i += size) parts.push({ table: [table[headerRow], ...data.slice(i, i + size)], headerRow: 0 })
  return parts
}

/** The results of the parts as one result (rows in file order, counts added up, notes once). */
export function mergeRunResults(parts: RunResult[]): RunResult {
  if (parts.length === 1) return parts[0]
  const counts = { total: 0, ready: 0, imported: 0, duplicates: 0, errors: 0, failed: 0, withWarnings: 0 }
  for (const p of parts) for (const k of Object.keys(counts) as (keyof typeof counts)[]) counts[k] += p.counts[k]
  return {
    headers: parts[0]?.headers ?? [],
    notes: [...new Set(parts.flatMap((p) => p.notes))],
    rows: parts.flatMap((p) => p.rows),
    counts,
  }
}

// ---------------------------------------------------------------- duplicates across the whole file (all parts)

/**
 * What makes two rows the same record for the import services: customers / suppliers by name (case-insensitive) or an
 * explicit code (customer-import.ts, supplier-import.ts); items by code, by name as the item form compares it
 * (normalizeItemName, 3+ characters) or by barcode (item-import.ts).
 */
export function duplicateKeys(dataTypeKey: string, v: Record<string, string>): { key: string; label: string }[] {
  const keys: { key: string; label: string }[] = []
  const code = (v.code ?? '').trim().toUpperCase()
  if (dataTypeKey === 'customers' || dataTypeKey === 'suppliers') {
    const name = (v.name ?? '').trim()
    if (name) keys.push({ key: `name:${name.toLowerCase()}`, label: `name “${name}”` })
    if (code) keys.push({ key: `code:${code}`, label: `code ${code}` })
  } else if (dataTypeKey === 'items') {
    const n = normalizeItemName(v.name ?? '')
    if (code) keys.push({ key: `code:${code}`, label: `code ${code}` })
    if (n.length >= 3) keys.push({ key: `name:${n}`, label: `name “${(v.name ?? '').trim()}”` })
    if ((v.barcode ?? '').trim()) keys.push({ key: `barcode:${v.barcode.trim()}`, label: `barcode ${v.barcode.trim()}` })
  }
  return keys
}

/**
 * Duplicates across the whole file, also between parts that were checked separately: in file order, a row that is
 * ready claims its keys, and a later ready row with a claimed key becomes a duplicate (the import services apply the
 * same rule within one part). Returns the result with those rows marked, and their lines (left out of the import).
 */
export function markFileDuplicates(dataTypeKey: string, result: RunResult): { result: RunResult; fileDuplicates: Map<number, string> } {
  const claimed = new Map<string, number>()
  const fileDuplicates = new Map<number, string>()
  const rows = [...result.rows].sort((a, b) => a.line - b.line).map((r) => {
    if (r.status !== 'ready') return r
    const keys = duplicateKeys(dataTypeKey, r.values)
    const hit = keys.find((k) => claimed.has(k.key))
    if (hit) {
      const message = `Same ${hit.label} as row ${claimed.get(hit.key)} earlier in this file — skipped`
      fileDuplicates.set(r.line, message)
      return { ...r, status: 'duplicate' as const, messages: [message] }
    }
    for (const k of keys) claimed.set(k.key, r.line)
    return r
  })
  if (!fileDuplicates.size) return { result, fileDuplicates }
  return { result: { ...result, rows, counts: recount(rows, result.counts) }, fileDuplicates }
}

/** Counts again after rows changed status (imported / failed are kept from the server). */
export function recount(rows: RunRow[], before: RunResult['counts']): RunResult['counts'] {
  const n = (st: RunRowStatus) => rows.filter((r) => r.status === st).length
  return { ...before, total: rows.length, ready: n('ready'), duplicates: n('duplicate'), errors: n('error'), imported: n('imported'), failed: n('failed'), withWarnings: rows.filter((r) => r.warnings.length).length }
}

/** The table without the rows found to be file duplicates (they are not sent to the import at all). */
export function withoutLines(table: TableRow[], headerRow: number, lines: Set<number>): TableRow[] {
  return table.filter((r, i) => i <= headerRow || !lines.has(r.line))
}

/** The import result with the left-out file duplicates added back as skipped rows, in file order. */
export function addFileDuplicates(result: RunResult, preview: RunResult, fileDuplicates: Map<number, string>): RunResult {
  if (!fileDuplicates.size) return result
  const extra = preview.rows.filter((r) => fileDuplicates.has(r.line)).map((r) => ({ ...r, status: 'duplicate' as const, messages: [fileDuplicates.get(r.line)!] }))
  const rows = [...result.rows, ...extra].sort((a, b) => a.line - b.line)
  return { ...result, rows, counts: recount(rows, result.counts) }
}
