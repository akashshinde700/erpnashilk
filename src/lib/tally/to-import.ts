import type { ColumnMapping } from '@/lib/import/fields'
import type { TableRow } from '@/lib/import/parse-file'

/**
 * Tally records (as normalised by the connector) → the table + column mapping the existing Import Center pipeline
 * takes (src/lib/import/run.ts). So Tally data goes through exactly the same checks, duplicate rules and import
 * services as an uploaded file — nothing is written to the database here.
 *
 * Mapping decisions (field names verified only against mock data, not a real TallyPrime):
 *  - Sundry Debtors ledgers → customers, Sundry Creditors ledgers → suppliers (name, GSTIN, GST type, PAN, phone,
 *    email, address, state, pincode, contact person). Opening balances are NOT imported (go-live decision pending).
 *  - Stock items → items (name, unit, HSN, IGST rate as GST %, stock group as category). The item type is the user's
 *    choice. Opening stock is NOT imported.
 *  - Tally's GUID is not stored: ManuFlow has no column for it (schema change). Re-imports are kept duplicate-free by
 *    the import services' own name / code / GSTIN checks.
 */

export type TallyImportKind = 'customers' | 'suppliers' | 'items'
export const TALLY_BATCH_ROWS = 500

const COLUMNS: Record<TallyImportKind, [field: string, header: string, from: string][]> = {
  customers: partyColumns('Customer name'),
  suppliers: partyColumns('Supplier name'),
  items: [
    ['name', 'Item name', 'name'], ['uom', 'Unit', 'unit'], ['hsn', 'HSN', 'hsn'], ['gstRate', 'GST rate', 'gstRate'], ['category', 'Stock group', 'parent'],
  ],
}
function partyColumns(nameHeader: string): [string, string, string][] {
  return [
    ['name', nameHeader, 'name'], ['gstin', 'GSTIN', 'gstin'], ['gstType', 'GST type', 'gstType'], ['pan', 'PAN', 'pan'],
    ['contactPerson', 'Contact person', 'contactPerson'], ['phone', 'Phone', 'phone'], ['email', 'Email', 'email'],
    ['addressLine', 'Address', 'address'], ['state', 'State', 'state'], ['pincode', 'Pincode', 'pincode'],
  ]
}

// Tally registration types the import understands; anything else is left blank (the import then decides from GSTIN)
const GST_TYPES = new Set(['regular', 'composition', 'unregistered', 'consumer', 'overseas', 'sez'])

function cell(kind: TallyImportKind, field: string, v: string | undefined): string {
  const s = (v ?? '').trim()
  if (field === 'gstType') return GST_TYPES.has(s.toLowerCase()) ? s : ''
  if (field === 'gstRate' && kind === 'items') return /^\d+(\.\d+)?$/.test(s) ? s : ''
  return s.slice(0, 1000)
}

export function batchCount(records: unknown[]): number {
  return Math.max(1, Math.ceil(records.length / TALLY_BATCH_ROWS))
}

/** One batch (≤ 500 rows) as an import table: header on line 1; line n+1 = record n of the whole export. */
export function tallyBatchTable(kind: TallyImportKind, records: Record<string, string>[], batch: number): { table: TableRow[]; mapping: ColumnMapping; firstRecord: number } {
  const cols = COLUMNS[kind]
  const start = batch * TALLY_BATCH_ROWS
  const slice = records.slice(start, start + TALLY_BATCH_ROWS)
  const table: TableRow[] = [{ line: 1, cells: cols.map((c) => c[1]) }]
  slice.forEach((r, i) => table.push({ line: start + i + 2, cells: cols.map(([field, , from]) => cell(kind, field, r[from])) }))
  const mapping: ColumnMapping = Object.fromEntries(cols.map(([field], i) => [field, i]))
  return { table, mapping, firstRecord: start }
}
