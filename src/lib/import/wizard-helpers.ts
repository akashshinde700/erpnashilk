// Import Center wizard helpers — client + server safe (no Node / DB imports), unit-tested.
import { findDataType } from '@/lib/import/fields'
import type { RunRow, RunRowStatus } from '@/lib/import/run'

/** Marathi names shown in the wizard (the catalogue keeps the English labels used in history / audit). */
export const DATA_TYPE_MR: Record<string, { name: string; hint: string }> = {
  customers: { name: 'ग्राहक (Customers)', hint: 'नाव, GSTIN, फोन, पत्ता' },
  suppliers: { name: 'पुरवठादार (Suppliers)', hint: 'नाव, GSTIN, बँक तपशील' },
  items: { name: 'Items / वस्तू', hint: 'नाव, HSN, GST दर, Unit, किंमत' },
  'opening-stock': { name: 'Opening Stock', hint: 'Go-live च्या दिवशीचा साठा' },
  'opening-balances': { name: 'Opening Balances', hint: 'फक्त तपासणी — save होत नाही' },
  sales: { name: 'Sales Transactions', hint: 'लवकरच' },
  purchases: { name: 'Purchase Transactions', hint: 'लवकरच' },
  receipts: { name: 'Receipts', hint: 'लवकरच' },
  payments: { name: 'Payments', hint: 'लवकरच' },
  'credit-notes': { name: 'Credit Notes', hint: 'लवकरच' },
  'debit-notes': { name: 'Debit Notes', hint: 'लवकरच' },
  'company-info': { name: 'Company Information', hint: 'लवकरच' },
}

export const STATUS_MR: Record<RunRowStatus, string> = {
  ready: 'तयार', duplicate: 'Skip (आधीच आहे)', error: 'चूक', imported: 'Import झाला', failed: 'अयशस्वी',
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
    out.push([String(r.line), STATUS_MR[r.status], r.values.name || r.values.itemName || r.values.itemCode || '', r.messages.join('; '), r.warnings.join('; ')])
  }
  return out.map((r) => r.map(reportCell).join(',')).join('\n')
}

/** Message for a failed request, in plain Marathi where the cause is generic; the server's own text otherwise. */
export function friendlyError(e: unknown): string {
  const msg = e instanceof Error ? e.message : ''
  if (/Failed to fetch|NetworkError|Load failed|network/i.test(msg)) return 'सर्व्हरशी संपर्क तुटला. Internet तपासा आणि पुन्हा प्रयत्न करा.'
  if (/not allowed|permission|403/i.test(msg)) return 'तुम्हाला हे करण्याची परवानगी नाही. Admin शी संपर्क करा.'
  if (/larger than|413/i.test(msg)) return 'फाइल खूप मोठी आहे (मर्यादा 2 MB). फाइलचे भाग करून Import करा.'
  if (/session|sign in/i.test(msg)) return 'तुमचे login संपले आहे. पुन्हा login करा.'
  if (/already running/i.test(msg)) return 'याच प्रकारचा दुसरा Import आत्ता चालू आहे. तो पूर्ण झाल्यावर पुन्हा प्रयत्न करा.'
  if (/Request failed \(5|Something went wrong/i.test(msg)) return 'सर्व्हरवर अडचण आली. थोड्या वेळाने पुन्हा प्रयत्न करा.'
  return msg || 'काहीतरी चूक झाली. पुन्हा प्रयत्न करा.'
}

/** Browser download of a text file (UTF-8 with BOM so Excel shows Marathi / ₹ correctly). */
export function downloadText(fileName: string, text: string) {
  const blob = new Blob(['\ufeff' + text], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  a.click()
  URL.revokeObjectURL(url)
}
