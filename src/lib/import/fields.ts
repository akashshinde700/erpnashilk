// Import Center field catalogue — client + server safe (no Node / DB imports).

export const IMPORT_SOURCES = [
  { key: 'TALLY', label: 'Tally (Excel / CSV export)' },
  { key: 'VYAPAR', label: 'Vyapar (Excel export)' },
  { key: 'EXCEL', label: 'Excel / CSV (any)' },
] as const
export type ImportSource = (typeof IMPORT_SOURCES)[number]['key']

export const IMPORT_LIMITS = {
  /** Upload size cap (bytes). */
  maxFileBytes: 2 * 1024 * 1024,
  /** Data rows per import (same cap as the bulk import services). */
  maxDataRows: 500,
  maxColumns: 60,
  maxCellChars: 1000,
  /** Rows searched for the header line (Tally/Vyapar reports put titles above it). */
  headerScanRows: 15,
  /** Total uncompressed size of an .xlsx (zip) — guards against zip bombs. */
  maxXlsxUncompressedBytes: 40 * 1024 * 1024,
  maxXlsxEntries: 2000,
} as const

export interface ImportField {
  key: string
  label: string
  required?: boolean
  /** Source column names (Tally / Vyapar / common exports) suggested for this field. */
  aliases: string[]
  hint?: string
}

export interface ImportDataType {
  key: string
  label: string
  /** Registry module the rows are written to (write permission is checked on it). */
  module: string
  available: boolean
  /** Why it is not available yet (shown in the UI). */
  plannedNote?: string
  /** false = preview / reconciliation only — the commit endpoint refuses it (reason in commitBlocked). */
  commit?: boolean
  commitBlocked?: string
  /** Each group needs at least one of its fields mapped (e.g. item code or item name). */
  requireOneOf?: { fields: string[]; label: string }[]
  /** Needs the company's go-live date (opening figures). */
  needsGoLive?: boolean
  fields: ImportField[]
  /** Columns recognised but deliberately not imported in this phase. */
  notImported: { label: string; aliases: string[]; reason: string }[]
}

const OPENING_BALANCE_REASON = 'Opening balances need a go-live date and their own accounting treatment — not imported yet'
const OPENING_STOCK_REASON = 'Opening stock needs a verified go-live date, warehouse and valuation — not imported yet'

export const IMPORT_DATA_TYPES: ImportDataType[] = [
  {
    key: 'customers',
    label: 'Customers',
    module: 'customers',
    available: true,
    fields: [
      { key: 'name', label: 'Customer name', required: true, aliases: ['Customer Name', 'Party Name', 'Ledger Name', 'Name', 'Party', 'Customer'] },
      { key: 'code', label: 'Customer code', aliases: ['Customer Code', 'Party Code', 'Code'], hint: 'Blank → next C-0001 code' },
      { key: 'gstin', label: 'GSTIN', aliases: ['GSTIN', 'GST No', 'GST Number', 'GSTIN/UIN', 'GSTIN No', 'GST IN'] },
      { key: 'gstType', label: 'GST type', aliases: ['GST Type', 'Registration Type', 'GST Registration Type'], hint: 'Regular, Composition, Unregistered, Consumer, Overseas, SEZ — blank: Regular when a GSTIN is given' },
      { key: 'pan', label: 'PAN', aliases: ['PAN', 'PAN No', 'PAN Number', 'IT PAN'] },
      { key: 'contactPerson', label: 'Contact person', aliases: ['Contact Person', 'Contact Name'] },
      { key: 'phone', label: 'Phone', aliases: ['Phone', 'Mobile', 'Contact Number', 'Phone No', 'Phone Number', 'Mobile No', 'Mobile Number', 'Contact No'] },
      { key: 'email', label: 'Email', aliases: ['Email', 'Email ID', 'E-mail', 'Email Address'] },
      { key: 'addressLine', label: 'Address', aliases: ['Address', 'Address Line 1', 'Billing Address', 'Address 1'] },
      { key: 'city', label: 'City', aliases: ['City', 'Town', 'City/Town'] },
      { key: 'state', label: 'State', aliases: ['State', 'State Name'] },
      { key: 'stateCode', label: 'GST state code', aliases: ['State Code', 'GST State Code'] },
      { key: 'pincode', label: 'Pincode', aliases: ['Pincode', 'Pin Code', 'PIN', 'Postal Code', 'Zip', 'Zip Code'] },
      { key: 'partyType', label: 'Party type', aliases: ['Party Type'], hint: 'CUSTOMER (default) or BOTH (also creates the supplier)' },
    ],
    notImported: [
      { label: 'Opening / closing balance', aliases: ['Opening Balance', 'Opening Bal', 'Balance', 'Closing Balance', 'Receivable Balance'], reason: OPENING_BALANCE_REASON },
      { label: 'Credit limit', aliases: ['Credit Limit'], reason: 'Not imported yet — set it on the customer after import' },
    ],
  },
  {
    key: 'suppliers',
    label: 'Suppliers',
    module: 'suppliers',
    available: true,
    fields: [
      { key: 'name', label: 'Supplier name', required: true, aliases: ['Supplier Name', 'Vendor Name', 'Party Name', 'Ledger Name', 'Name', 'Party', 'Supplier', 'Vendor'] },
      { key: 'code', label: 'Supplier code', aliases: ['Supplier Code', 'Vendor Code', 'Party Code', 'Code'], hint: 'Blank → next S-0001 code' },
      { key: 'gstin', label: 'GSTIN', aliases: ['GSTIN', 'GST No', 'GST Number', 'GSTIN/UIN', 'GSTIN No', 'GST IN'] },
      { key: 'gstType', label: 'GST type', aliases: ['GST Type', 'Registration Type', 'GST Registration Type'], hint: 'Regular, Composition, Unregistered, Consumer, Overseas, SEZ — blank: Regular when a GSTIN is given' },
      { key: 'pan', label: 'PAN', aliases: ['PAN', 'PAN No', 'PAN Number', 'IT PAN'] },
      { key: 'contactPerson', label: 'Contact person', aliases: ['Contact Person', 'Contact Name'] },
      { key: 'phone', label: 'Phone', aliases: ['Phone', 'Mobile', 'Contact Number', 'Phone No', 'Phone Number', 'Mobile No', 'Mobile Number', 'Contact No'] },
      { key: 'email', label: 'Email', aliases: ['Email', 'Email ID', 'E-mail', 'Email Address'] },
      { key: 'addressLine', label: 'Address', aliases: ['Address', 'Address Line 1', 'Billing Address', 'Address 1'] },
      { key: 'city', label: 'City', aliases: ['City', 'Town', 'City/Town'] },
      { key: 'state', label: 'State', aliases: ['State', 'State Name'] },
      { key: 'stateCode', label: 'GST state code', aliases: ['State Code', 'GST State Code'] },
      { key: 'pincode', label: 'Pincode', aliases: ['Pincode', 'Pin Code', 'PIN', 'Postal Code', 'Zip', 'Zip Code'] },
      { key: 'paymentTermsDays', label: 'Credit days', aliases: ['Credit Days', 'Credit Period', 'Payment Terms', 'Payment Terms Days'], hint: 'Whole days; blank → 30' },
      { key: 'bankName', label: 'Bank name', aliases: ['Bank Name', 'Bank'] },
      { key: 'bankAccountNo', label: 'Bank account no', aliases: ['Account No', 'Account Number', 'Bank Account No', 'Bank Account Number', 'A/c No'] },
      { key: 'bankIfsc', label: 'IFSC', aliases: ['IFSC', 'IFSC Code', 'Bank IFSC'] },
      { key: 'bankBranch', label: 'Bank branch', aliases: ['Branch', 'Bank Branch'] },
    ],
    notImported: [
      { label: 'Opening / closing balance', aliases: ['Opening Balance', 'Opening Bal', 'Balance', 'Closing Balance', 'Payable Balance'], reason: OPENING_BALANCE_REASON },
      { label: 'Credit limit', aliases: ['Credit Limit'], reason: 'Not imported yet — set it on the supplier after import' },
    ],
  },
  {
    key: 'items',
    label: 'Items',
    module: 'items',
    available: true,
    fields: [
      { key: 'name', label: 'Item name', required: true, aliases: ['Item Name', 'Product Name', 'Stock Item', 'Stock Item Name', 'Name', 'Item', 'Product'] },
      { key: 'code', label: 'Item code / SKU', aliases: ['Item Code', 'SKU', 'Code', 'Product Code'], hint: 'Blank → next code of the item type (RM-001…)' },
      { key: 'hsn', label: 'HSN / SAC code', aliases: ['HSN', 'HSN Code', 'HSN/SAC', 'HSN SAC', 'SAC', 'HSN/SAC Code'] },
      { key: 'gstRate', label: 'GST rate %', required: true, aliases: ['GST Rate', 'Tax Rate', 'GST %', 'GST', 'GST Rate %', 'Rate of Tax', 'IGST Rate'], hint: 'Required — never assumed' },
      { key: 'uom', label: 'Unit (UOM)', required: true, aliases: ['Unit', 'UOM', 'Units', 'Base Unit', 'Primary Unit', 'Unit of Measure'] },
      { key: 'purchasePrice', label: 'Purchase price', aliases: ['Purchase Price', 'Purchase Rate', 'Cost Price'] },
      { key: 'sellPrice', label: 'Sale price', aliases: ['Sale Price', 'Selling Price', 'Sales Price', 'Sale Rate', 'Selling Rate'] },
      { key: 'mrp', label: 'MRP', aliases: ['MRP'] },
      { key: 'category', label: 'Category', aliases: ['Category', 'Item Category', 'Stock Group', 'Group'] },
      { key: 'barcode', label: 'Barcode', aliases: ['Barcode', 'Bar Code', 'EAN'] },
      { key: 'brand', label: 'Brand', aliases: ['Brand', 'Make'] },
      { key: 'type', label: 'Item type', aliases: ['Item Type'], hint: 'RAW, SEMI, FINISHED, CONSUMABLE, SERVICE — else the type chosen below' },
    ],
    notImported: [
      { label: 'Opening stock', aliases: ['Opening Quantity', 'Opening Stock', 'Opening Qty', 'Opening Balance', 'Opening Value', 'Opening Rate', 'Closing Stock', 'Closing Quantity', 'Stock Quantity', 'Current Stock', 'Stock'], reason: OPENING_STOCK_REASON },
    ],
  },
  {
    key: 'opening-stock',
    label: 'Opening stock',
    module: 'stock-adjustments',
    available: true,
    needsGoLive: true,
    requireOneOf: [{ fields: ['itemCode', 'itemName'], label: 'Item code or item name' }, { fields: ['rate', 'value'], label: 'Rate or value' }],
    fields: [
      { key: 'itemCode', label: 'Item code', aliases: ['Item Code', 'SKU', 'Product Code', 'Code'], hint: 'Matched to existing items (preferred)' },
      { key: 'itemName', label: 'Item name', aliases: ['Item Name', 'Stock Item', 'Stock Item Name', 'Product Name', 'Particulars', 'Name', 'Item'], hint: 'Used when there is no code; must match exactly one item' },
      { key: 'warehouse', label: 'Warehouse', aliases: ['Warehouse', 'Godown', 'Location', 'Store', 'Warehouse Code'], hint: 'Code or name of a ManuFlow warehouse — else the default chosen below' },
      { key: 'qty', label: 'Quantity', required: true, aliases: ['Quantity', 'Qty', 'Opening Quantity', 'Opening Qty', 'Closing Quantity', 'Closing Qty', 'Stock Quantity', 'Current Stock'], hint: 'In the item\'s unit; "100 Nos" is understood' },
      { key: 'rate', label: 'Rate (cost per unit)', aliases: ['Rate', 'Opening Rate', 'Closing Rate', 'Unit Cost', 'Cost', 'Avg Rate', 'Average Rate'] },
      { key: 'value', label: 'Value', aliases: ['Value', 'Opening Value', 'Closing Value', 'Stock Value', 'Amount'], hint: 'Checked against quantity × rate when both are given' },
      { key: 'unit', label: 'Unit', aliases: ['Unit', 'UOM', 'Units'], hint: 'Must be the item\'s unit' },
      { key: 'batchNo', label: 'Batch no', aliases: ['Batch', 'Batch No', 'Batch Number', 'Lot', 'Lot No'], hint: 'Required for batch-tracked items' },
      { key: 'expiryDate', label: 'Expiry date', aliases: ['Expiry', 'Expiry Date', 'Exp Date', 'Best Before'], hint: 'YYYY-MM-DD, DD-MM-YYYY or 01-Apr-2027' },
    ],
    notImported: [],
  },
  {
    key: 'opening-balances',
    label: 'Opening balances (check only)',
    module: 'customers',
    available: true,
    commit: false,
    needsGoLive: true,
    commitBlocked: 'Party opening balances can be checked and reconciled here, but not imported yet: ManuFlow keeps them as a single undated number with no entries behind it, and receipts / payments must be made against an invoice, so an imported balance could never be settled. See docs/opening-balances.md.',
    requireOneOf: [{ fields: ['balance', 'debit', 'credit'], label: 'Balance, or Debit / Credit columns' }],
    fields: [
      { key: 'name', label: 'Party name', required: true, aliases: ['Party Name', 'Ledger Name', 'Customer Name', 'Supplier Name', 'Vendor Name', 'Particulars', 'Name', 'Party'] },
      { key: 'code', label: 'Party code', aliases: ['Party Code', 'Customer Code', 'Supplier Code', 'Code'] },
      { key: 'gstin', label: 'GSTIN', aliases: ['GSTIN', 'GST No', 'GST Number', 'GSTIN/UIN'], hint: 'Used to match when the name does not' },
      { key: 'balance', label: 'Balance', aliases: ['Opening Balance', 'Closing Balance', 'Balance', 'Outstanding', 'Amount'], hint: '"12,500.00 Dr" / "Cr" is understood' },
      { key: 'drCr', label: 'Dr / Cr', aliases: ['Dr/Cr', 'Dr Cr', 'Balance Type', 'Type'] },
      { key: 'debit', label: 'Debit', aliases: ['Debit', 'Dr', 'Debit Amount', 'Receivable', 'Receivable Balance'] },
      { key: 'credit', label: 'Credit', aliases: ['Credit', 'Cr', 'Credit Amount', 'Payable', 'Payable Balance'] },
    ],
    notImported: [],
  },
  ...[
    ['sales', 'Sales invoices', 'sales-invoices', 'Historical vouchers: original numbers, GST returns and stock effects must be verified first'],
    ['purchases', 'Purchase invoices', 'purchase-invoices', 'Historical vouchers: original numbers, GST returns and stock effects must be verified first'],
    ['receipts', 'Receipts', 'payments', 'Needs bill-wise allocation against imported invoices / opening balances'],
    ['payments', 'Payments', 'payments', 'Needs bill-wise allocation against imported bills / opening balances'],
    ['credit-notes', 'Credit notes', 'sales-returns', 'Historical vouchers: need the original invoices and their stock / GST effects first'],
    ['debit-notes', 'Debit notes', 'purchase-returns', 'Historical vouchers: need the original bills and their stock / GST effects first'],
    ['company-info', 'Company information', 'settings', 'Set the company profile in Settings — importing it is not supported yet'],
  ].map(([key, label, module, plannedNote]) => ({ key, label, module, available: false, plannedNote, fields: [], notImported: [] })),
]

/** AuditLog entity of each importable data type — the import history reads these rows. */
export const IMPORT_HISTORY_ENTITY: Record<string, string> = { customers: 'CUSTOMER', suppliers: 'SUPPLIER', items: 'ITEM', 'opening-stock': 'OPENING_STOCK' }

export function findDataType(key: unknown): ImportDataType | undefined {
  return IMPORT_DATA_TYPES.find((d) => d.key === key)
}

/** "GST No." / "gst-no" / "GST NO" → "gstno" (aliases are compared on this form only). */
export const normalizeHeader = (s: string) => s.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]/g, '')

export type ColumnMapping = Record<string, number> // field key → column index

export interface MappingSuggestion {
  mapping: ColumnMapping
  /** field key → the header it was matched from */
  matchedFrom: Record<string, string>
  /** Columns recognised as known-but-not-imported data (e.g. opening stock). */
  notImported: { column: number; header: string; label: string; reason: string }[]
}

/**
 * Suggest a mapping by exact (normalised) alias match — no fuzzy guessing. Each column is used at
 * most once; fields are matched in catalogue order. This is a suggestion only: the user reviews it.
 */
export function suggestMapping(dataType: ImportDataType, headers: string[]): MappingSuggestion {
  const norm = headers.map((h) => normalizeHeader(h ?? ''))
  const used = new Set<number>()
  const mapping: ColumnMapping = {}
  const matchedFrom: Record<string, string> = {}
  for (const f of dataType.fields) {
    for (const alias of f.aliases) {
      const a = normalizeHeader(alias)
      const idx = norm.findIndex((h, i) => h !== '' && h === a && !used.has(i))
      if (idx >= 0) {
        mapping[f.key] = idx
        matchedFrom[f.key] = headers[idx]
        used.add(idx)
        break
      }
    }
  }
  const notImported: MappingSuggestion['notImported'] = []
  norm.forEach((h, i) => {
    if (!h || used.has(i)) return
    const hit = dataType.notImported.find((n) => n.aliases.some((a) => normalizeHeader(a) === h))
    if (hit) notImported.push({ column: i, header: headers[i], label: hit.label, reason: hit.reason })
  })
  return { mapping, matchedFrom, notImported }
}

/**
 * Header line of a report-style export: among the first rows, the one matching the most known
 * aliases (at least two); otherwise the first row. Returns a 0-based row index.
 */
export function detectHeaderRow(dataType: ImportDataType, table: string[][], scan: number = IMPORT_LIMITS.headerScanRows): number {
  const known = new Set<string>()
  for (const f of dataType.fields) for (const a of f.aliases) known.add(normalizeHeader(a))
  for (const n of dataType.notImported) for (const a of n.aliases) known.add(normalizeHeader(a))
  let best = 0
  let bestScore = 1
  for (let r = 0; r < Math.min(scan, table.length); r++) {
    const score = new Set(table[r].map((c) => normalizeHeader(c ?? '')).filter((c) => known.has(c))).size
    if (score > bestScore) { best = r; bestScore = score }
  }
  return best
}
