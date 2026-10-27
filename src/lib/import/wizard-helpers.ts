// Import Center wizard helpers — client + server safe (no Node / DB imports), unit-tested.
import { findDataType } from '@/lib/import/fields'
import type { RunRow, RunRowStatus } from '@/lib/import/run'

/** Names and one-line hints of the data types as shown in the wizard. */
export const DATA_TYPE_UI: Record<string, { name: string; hint: string }> = {
  customers: { name: 'Customers', hint: 'Name, GSTIN, phone, address' },
  suppliers: { name: 'Suppliers', hint: 'Name, GSTIN, bank details' },
  items: { name: 'Items', hint: 'Name, HSN, GST rate, unit, price' },
  'opening-stock': { name: 'Opening Stock', hint: 'Stock on hand at the go-live date' },
  'opening-balances': { name: 'Opening Balances', hint: 'Check only — nothing is saved' },
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
