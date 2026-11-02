import type { ColumnMapping } from '@/lib/import/fields'
import type { TableRow } from '@/lib/import/parse-file'
import { vyaparPhone, VYAPAR_UNITS, type VyaparItem, type VyaparSnapshot } from '@/lib/vyapar/shared'

/**
 * Vyapar backup records → the table + column mapping the Import Center pipeline takes
 * (src/lib/import/run.ts), exactly like the Tally connector does (src/lib/tally/to-import.ts).
 * Every row therefore goes through the same checks, duplicate rules and import services as an
 * uploaded file — nothing is written here and nothing is trusted.
 *
 * Mapping decisions:
 *  - Customers (kb_names name_type 1) / suppliers (name_type 2) → name, GSTIN, GST type, phone,
 *    email, address, state, pincode. Vyapar has no party code: the import generates C-0001 / S-0001.
 *    Balances are NOT imported (they need the go-live date and their own accounting treatment).
 *  - Items → name, code, HSN, GST rate, unit, purchase price, sale price, MRP, category. Vyapar's
 *    services become ManuFlow SERVICE items; everything else gets the type the user picked.
 *    Current stock is NOT put on the item — opening stock has its own data type.
 *  - Opening stock → item name, quantity, rate and value from Vyapar's current stock. The rate is
 *    Vyapar's own stock value ÷ quantity, so the posted value equals Vyapar's stock value.
 *  - Inactive parties / items are skipped (Vyapar keeps them for history; ManuFlow's import has no
 *    "inactive" column) and the counts are reported.
 */

export type VyaparImportKind = 'customers' | 'suppliers' | 'items' | 'opening-stock'
export const VYAPAR_BATCH_ROWS = 500

/** Options the user chooses in the Import Center when Vyapar's data cannot fill a field. */
export interface VyaparOptions {
  /** Item type for products (Vyapar's services are always SERVICE). */
  itemType?: string
  /** GST rate for items Vyapar has no tax on ('' = leave blank → row error). */
  gstFallback?: string
  /** ManuFlow unit for items whose Vyapar unit has no equivalent ('' = leave as is → row error). */
  uomFallback?: string
}

const COLUMNS: Record<VyaparImportKind, [field: string, header: string][]> = {
  customers: [
    ['name', 'Party name'], ['gstin', 'GSTIN'], ['gstType', 'GST type'], ['phone', 'Phone'], ['email', 'Email'],
    ['addressLine', 'Address'], ['state', 'State'], ['pincode', 'Pincode'],
  ],
  suppliers: [
    ['name', 'Party name'], ['gstin', 'GSTIN'], ['gstType', 'GST type'], ['phone', 'Phone'], ['email', 'Email'],
    ['addressLine', 'Address'], ['state', 'State'], ['pincode', 'Pincode'],
  ],
  items: [
    ['name', 'Item name'], ['code', 'Item code'], ['hsn', 'HSN'], ['gstRate', 'GST rate'], ['uom', 'Unit'],
    ['purchasePrice', 'Purchase price'], ['sellPrice', 'Sale price'], ['mrp', 'MRP'], ['category', 'Category'], ['type', 'Item type'],
  ],
  'opening-stock': [
    ['itemName', 'Item name'], ['qty', 'Quantity'], ['rate', 'Rate'], ['value', 'Value'],
  ],
}

/** Rows that this data type will produce from the backup (batch counting + the UI's totals). */
export function vyaparRecordCount(kind: VyaparImportKind, snapshot: VyaparSnapshot): number {
  switch (kind) {
    case 'customers': return snapshot.parties.filter((p) => p.kind === 'customer' && p.active).length
    case 'suppliers': return snapshot.parties.filter((p) => p.kind === 'supplier' && p.active).length
    case 'items': return snapshot.items.filter((i) => i.active).length
    case 'opening-stock': return snapshot.items.filter((i) => i.active && i.stockQty > 0).length
  }
}

export function vyaparBatchCount(kind: VyaparImportKind, snapshot: VyaparSnapshot): number {
  return Math.max(1, Math.ceil(vyaparRecordCount(kind, snapshot) / VYAPAR_BATCH_ROWS))
}

const clean = (v: string, max = 1000) => String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)

const gstType = (gstin: string) => (gstin ? 'Regular' : 'Unregistered')

/** ManuFlow unit for a Vyapar unit; the user's fallback wins when Vyapar's unit has no equivalent. */
export function vyaparUnit(raw: string, fallback?: string): string {
  const mapped = VYAPAR_UNITS[raw.toUpperCase()]
  if (mapped) return mapped
  return fallback ? fallback.toUpperCase() : raw
}

function itemRow(item: VyaparItem, options: VyaparOptions): string[] {
  const gst = item.gstRate === null ? (options.gstFallback ?? '') : String(item.gstRate)
  const uom = vyaparUnit(item.unit, options.uomFallback)
  const type = item.service ? 'SERVICE' : (options.itemType ?? '')
  return [
    clean(item.name, 200), clean(item.code, 60), clean(item.hsn, 20), gst, clean(uom, 20),
    String(item.purchasePrice), String(item.salePrice), item.mrp === null ? '' : String(item.mrp),
    clean(item.category, 120), type,
  ]
}

function openingStockRow(item: VyaparItem): string[] {
  const qty = item.stockQty
  const rate = qty > 0 ? Math.round((item.stockValue / qty) * 10000) / 10000 : 0
  return [clean(item.name, 200), String(qty), String(rate), String(item.stockValue)]
}

function partyRow(p: VyaparSnapshot['parties'][number]): string[] {
  const gstin = clean(p.gstin, 20).toUpperCase()
  return [
    clean(p.name, 200), gstin, gstType(gstin), vyaparPhone(p.phone) ?? '', clean(p.email, 200),
    clean(p.address, 1000), clean(p.state, 60), clean(p.pincode, 10),
  ]
}

/**
 * One batch (≤ 500 rows) as an import table: header on line 1, line n+1 = record n of the whole
 * data set, so a problem message can name the record ("Vyapar record 12").
 */
export function vyaparBatchTable(
  kind: VyaparImportKind, snapshot: VyaparSnapshot, batch: number, options: VyaparOptions = {},
): { table: TableRow[]; mapping: ColumnMapping; firstRecord: number; totalRecords: number; batchRows: number } {
  const cols = COLUMNS[kind]
  let rows: string[][]
  switch (kind) {
    case 'customers': rows = snapshot.parties.filter((p) => p.kind === 'customer' && p.active).map(partyRow); break
    case 'suppliers': rows = snapshot.parties.filter((p) => p.kind === 'supplier' && p.active).map(partyRow); break
    case 'items': rows = snapshot.items.filter((i) => i.active).map((i) => itemRow(i, options)); break
    case 'opening-stock': rows = snapshot.items.filter((i) => i.active && i.stockQty > 0).map(openingStockRow); break
  }
  const start = Math.max(0, Math.floor(batch)) * VYAPAR_BATCH_ROWS
  const slice = rows.slice(start, start + VYAPAR_BATCH_ROWS)
  const table: TableRow[] = [{ line: 1, cells: cols.map((c) => c[1]) }]
  slice.forEach((cells, i) => table.push({ line: start + i + 2, cells }))
  const mapping: ColumnMapping = Object.fromEntries(cols.map(([field], i) => [field, i]))
  return { table, mapping, firstRecord: start, totalRecords: rows.length, batchRows: slice.length }
}
