import { ApiError } from '@/lib/erp-helpers'
import { GST_STATES, ITEM_TYPES, UOMS } from '@/lib/erp-constants'
import { IMPORT_LIMITS, normalizeHeader, type ColumnMapping, type ImportDataType } from '@/lib/import/fields'
import type { TableRow } from '@/lib/import/parse-file'
import type { ImportInputRow } from '@/lib/services/customer-import'

/**
 * Import Center: turn the uploaded table + the user-reviewed column mapping into service rows.
 * Everything here comes from the browser, so it is validated again on every preview / commit:
 * the mapping may only use catalogue fields and existing columns, each column once, and the
 * required fields must be mapped. Values are normalised only where the meaning is unambiguous
 * (e.g. "18%" → 18, "Pcs" → PCS, "Maharashtra" → state code 27); nothing is invented — a missing
 * GST rate or unit is a row error, a blank price is a visible warning.
 */

export interface MappedRow {
  line: number
  /** Field values after normalisation (what will be imported). */
  values: Record<string, string>
  errors: string[]
  warnings: string[]
}

export interface MappingResult {
  headers: string[]
  rows: MappedRow[]
  /** Rows that passed the mapping checks, ready for the import service. */
  serviceRows: ImportInputRow[]
  /** Batch-level notes (e.g. an optional field that is not mapped). */
  notes: string[]
}

export interface MappingOptions {
  /** Items: type for every row when no "Item type" column is mapped. */
  itemType?: string
  /** Opening stock: warehouse id for rows without a warehouse column / value. */
  defaultWarehouseId?: string
  /** Opening balances: whose balances the file holds. */
  partyKind?: string
  /** Opening balances: how to read amounts that carry no Dr / Cr marker ('DR' or 'CR' for positive amounts). */
  unsignedMeans?: string
  /** Opening figures: the go-live date the user confirmed (must equal the company's). */
  goLiveDate?: string
}

const bad = (m: string): never => { throw new ApiError(m, 400) }

/** Validate the client mapping against the catalogue and the file's header row. */
export function checkMapping(dataType: ImportDataType, raw: unknown, columnCount: number): ColumnMapping {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) bad('mapping must be an object of field → column number')
  const allowed = new Map(dataType.fields.map((f) => [f.key, f]))
  const mapping: ColumnMapping = {}
  const usedColumns = new Map<number, string>()
  for (const [field, col] of Object.entries(raw as Record<string, unknown>)) {
    if (!allowed.has(field)) bad(`Unknown field "${field}" for ${dataType.label}`)
    if (col === null || col === undefined || col === '') continue // explicitly not mapped
    if (typeof col !== 'number' || !Number.isInteger(col) || col < 0 || col >= columnCount) bad(`Column for ${allowed.get(field)!.label} is not a column of this file`)
    const other = usedColumns.get(col as number)
    if (other) bad(`One column is mapped to both ${allowed.get(other)!.label} and ${allowed.get(field)!.label}`)
    usedColumns.set(col as number, field)
    mapping[field] = col as number
  }
  const missing = dataType.fields.filter((f) => f.required && mapping[f.key] === undefined)
  if (missing.length) bad(`Map the required field${missing.length > 1 ? 's' : ''}: ${missing.map((f) => f.label).join(', ')}`)
  for (const g of dataType.requireOneOf ?? []) {
    if (!g.fields.some((f) => mapping[f] !== undefined)) bad(`Map at least one of: ${g.label}`)
  }
  return mapping
}

const FORMULA = /^[=@]/

const UOM_SYNONYMS: Record<string, string> = {
  nos: 'NOS', no: 'NOS', number: 'NOS', numbers: 'NOS',
  pcs: 'PCS', pc: 'PCS', piece: 'PCS', pieces: 'PCS',
  kg: 'KG', kgs: 'KG', kilogram: 'KG', kilograms: 'KG',
  gm: 'GM', gms: 'GM', g: 'GM', gram: 'GM', grams: 'GM',
  ltr: 'LTR', ltrs: 'LTR', l: 'LTR', litre: 'LTR', litres: 'LTR', liter: 'LTR', liters: 'LTR',
  mtr: 'MTR', mtrs: 'MTR', m: 'MTR', metre: 'MTR', metres: 'MTR', meter: 'MTR', meters: 'MTR',
  mtr2: 'MTR2', sqm: 'MTR2', sqmtr: 'MTR2', m2: 'MTR2',
  box: 'BOX', boxes: 'BOX', set: 'SET', sets: 'SET', roll: 'ROLL', rolls: 'ROLL',
  hrs: 'HRS', hr: 'HRS', hour: 'HRS', hours: 'HRS',
}

const GST_TYPE_SYNONYMS: Record<string, string> = {
  regular: 'REGULAR', registered: 'REGULAR', composition: 'COMPOSITION', unregistered: 'UNREGISTERED',
  consumer: 'CONSUMER', overseas: 'OVERSEAS', sez: 'SEZ',
}

const STATE_CODES = new Map(GST_STATES.map((s) => [normalizeHeader(s.name), s.code]))
const STANDARD_GST = new Set([0, 0.1, 0.25, 1.5, 3, 5, 6, 7.5, 12, 18, 28, 40])

/** "₹ 1,23,456.50" / "Rs. 40" / "120.00/Nos" → "123456.50"; '' stays ''. Returns null when it is not a number. */
function money(v: string): string | null {
  const s = v.replace(/\/\s*[a-z.]+$/i, '').replace(/₹|rs\.?|inr/gi, '').replace(/[,\s]/g, '')
  if (!s) return ''
  return /^-?\d+(\.\d+)?$/.test(s) ? s : null
}

/** Tally-style quantity "1,250.50 Nos" / "(-)5 Kgs" → { qty: "1250.50", unit: "Nos" }; null when unreadable. */
function quantity(v: string): { qty: string; unit: string } | null {
  const m = /^(\(-\)\s*|-)?\s*([\d,]*\.?\d+)\s*([A-Za-z][A-Za-z0-9.]*)?$/.exec(v.trim())
  if (!m) return null
  return { qty: `${m[1] ? '-' : ''}${m[2].replace(/,/g, '')}`, unit: m[3] ?? '' }
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 }

/** YYYY-MM-DD, DD-MM-YYYY, DD/MM/YYYY or 01-Apr-2027 / 1-Apr-27 → YYYY-MM-DD; null when ambiguous / invalid. */
export function importDate(v: string): string | null {
  const s = v.trim()
  let y: number, m: number, d: number
  let hit = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s)
  if (hit) [y, m, d] = [Number(hit[1]), Number(hit[2]), Number(hit[3])]
  else if ((hit = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(s))) [d, m, y] = [Number(hit[1]), Number(hit[2]), Number(hit[3])]
  else if ((hit = /^(\d{1,2})[-\s]([A-Za-z]{3})[A-Za-z]*[-\s,]*(\d{2}|\d{4})$/.exec(s)) && MONTHS[hit[2].toLowerCase()]) {
    d = Number(hit[1]); m = MONTHS[hit[2].toLowerCase()]; y = Number(hit[3]); if (y < 100) y += 2000
  } else return null
  const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
  const dt = new Date(iso)
  return Number.isNaN(dt.getTime()) || dt.toISOString().slice(0, 10) !== iso ? null : iso
}

const unitCode = (raw: string) => UOM_SYNONYMS[normalizeHeader(raw)] ?? (UOMS as readonly string[]).find((x) => x === raw.toUpperCase())

/** "12,500.00 Dr" / "Cr 400" / "(1,200)" / "-500" → amount + side; side null when the text carries none. */
function balanceText(v: string): { amount: number; side: 'DR' | 'CR' | null; negative: boolean } | null {
  let s = v.trim()
  let side: 'DR' | 'CR' | null = null
  const marker = /\b(dr|cr)\.?\s*$|^\s*(dr|cr)\.?\b/i.exec(s)
  if (marker) {
    side = (marker[1] || marker[2]).toUpperCase() as 'DR' | 'CR'
    s = s.replace(marker[0], '')
  }
  let negative = false
  if (/^\(.*\)$/.test(s.trim())) { negative = true; s = s.trim().slice(1, -1) }
  const m = money(s)
  if (m === null) return null
  if (m === '') return { amount: 0, side, negative: false }
  const n = Number(m)
  return { amount: Math.abs(n), side, negative: negative || n < 0 }
}

export function applyMapping(
  dataType: ImportDataType, table: TableRow[], headerIndex: number, rawMapping: unknown, options: MappingOptions = {},
): MappingResult {
  if (!Number.isInteger(headerIndex) || headerIndex < 0 || headerIndex >= table.length) bad('Choose the header row')
  if (headerIndex >= IMPORT_LIMITS.headerScanRows) bad(`The header row must be one of the first ${IMPORT_LIMITS.headerScanRows} rows`)
  const headers = table[headerIndex].cells.map((h) => h.trim())
  const dataRows = table.slice(headerIndex + 1)
  if (!dataRows.length) bad('There are no data rows below the header row')
  if (dataRows.length > IMPORT_LIMITS.maxDataRows) bad(`The file has ${dataRows.length} data rows — the limit is ${IMPORT_LIMITS.maxDataRows} per import. Split the file and import it in parts.`)
  const mapping = checkMapping(dataType, rawMapping, headers.length)
  const isItems = dataType.key === 'items'
  const kind = dataType.key

  const notes: string[] = []
  let itemType: string | undefined
  if (kind === 'opening-stock') {
    if (mapping.warehouse === undefined && !options.defaultWarehouseId) bad('Map a warehouse column or choose the default warehouse')
    if (mapping.rate === undefined) notes.push('Rate is not mapped — it is worked out as value ÷ quantity')
  }
  let partyKind: 'customer' | 'supplier' = 'customer'
  let unsignedMeans: 'DR' | 'CR' | null = null
  if (kind === 'opening-balances') {
    if (options.partyKind !== 'customer' && options.partyKind !== 'supplier') bad('Choose whether the file holds customer or supplier balances')
    partyKind = options.partyKind as 'customer' | 'supplier'
    if (options.unsignedMeans === 'DR' || options.unsignedMeans === 'CR') unsignedMeans = options.unsignedMeans
  }
  if (isItems) {
    if (mapping.type === undefined) {
      const t = String(options.itemType || '').toUpperCase()
      if (!(ITEM_TYPES as readonly string[]).includes(t)) bad(`Choose the item type (${ITEM_TYPES.join(', ')}) — there is no "Item type" column mapped`)
      itemType = t
    }
    if (mapping.purchasePrice === undefined) notes.push('Purchase price is not mapped — items are saved with purchase price 0')
    if (mapping.sellPrice === undefined) notes.push('Sale price is not mapped — items are saved with sale price 0')
    if (mapping.hsn === undefined) notes.push('HSN / SAC is not mapped — add it before billing these items on GST invoices')
    if (mapping.code === undefined) notes.push('Item code is not mapped — codes are generated from the item type series')
  }

  const rows: MappedRow[] = []
  const serviceRows: ImportInputRow[] = []
  for (const r of dataRows) {
    const values: Record<string, string> = {}
    const errors: string[] = []
    const warnings: string[] = []
    for (const [field, col] of Object.entries(mapping)) {
      const v = (r.cells[col] ?? '').trim()
      if (FORMULA.test(v)) errors.push(`${dataType.fields.find((f) => f.key === field)!.label} looks like a spreadsheet formula — enter the value itself`)
      values[field] = v
    }

    if (kind === 'opening-stock') {
      const q = quantity(values.qty ?? '')
      if (!values.qty) errors.push('Quantity is blank')
      else if (!q) errors.push(`Quantity "${values.qty}" is not a number`)
      else {
        values.qty = q.qty
        const unitRaw = values.unit || q.unit
        if (unitRaw) {
          const u = unitCode(unitRaw)
          if (!u) errors.push(`Unit "${unitRaw}" is not one of ${UOMS.join(', ')}`)
          else values.unit = u
        }
      }
      for (const [field, label] of [['rate', 'Rate'], ['value', 'Value']] as const) {
        if (mapping[field] === undefined) continue
        const m = money(values[field] ?? '')
        if (m === null) errors.push(`${label} "${values[field]}" is not a number`)
        else values[field] = m
      }
      if (values.expiryDate) {
        const d = importDate(values.expiryDate)
        if (!d) errors.push(`Expiry date "${values.expiryDate}" is not understood — use YYYY-MM-DD`)
        else values.expiryDate = d
      }
    } else if (kind === 'opening-balances') {
      let amount = 0
      let side: 'DR' | 'CR' | null = null
      if (mapping.debit !== undefined || mapping.credit !== undefined) {
        const d = balanceText(values.debit ?? '')
        const c = balanceText(values.credit ?? '')
        if (!d || !c) errors.push('Debit / credit is not a number')
        else if (d.amount && c.amount) errors.push('Both a debit and a credit amount — keep only the net balance')
        else if (d.amount) { amount = d.amount; side = 'DR' }
        else if (c.amount) { amount = c.amount; side = 'CR' }
      }
      if (!errors.length && amount === 0 && mapping.balance !== undefined) {
        const b = balanceText(values.balance ?? '')
        if (!b) errors.push(`Balance "${values.balance}" is not a number`)
        else if (b.amount) {
          amount = b.amount
          const col = (values.drCr ?? '').trim().toLowerCase()
          const colSide = /^(dr|debit|d)\.?$/.test(col) ? 'DR' : /^(cr|credit|c)\.?$/.test(col) ? 'CR' : null
          if (col && !colSide) errors.push(`Dr / Cr value "${values.drCr}" is not understood`)
          side = b.side ?? colSide
          if (!side && unsignedMeans) side = b.negative ? (unsignedMeans === 'DR' ? 'CR' : 'DR') : unsignedMeans
          else if (side && b.negative) side = side === 'DR' ? 'CR' : 'DR'
          if (!side && !errors.length) errors.push('No Dr / Cr marker — map the Dr / Cr column or choose how to read plain amounts')
        }
      }
      values.amount = String(amount)
      values.side = side ?? ''
      if (partyKind && side) values.sideLabel = side === 'DR' ? 'Dr' : 'Cr'
    } else if (isItems) {
      const gst = (values.gstRate ?? '').replace(/%|\s/g, '')
      if (!gst) errors.push('GST rate is blank — enter the rate (0 for exempt / nil-rated items)')
      else if (!/^\d+(\.\d+)?$/.test(gst)) errors.push(`GST rate "${values.gstRate}" is not a number`)
      else {
        values.gstRate = gst
        if (!STANDARD_GST.has(Number(gst))) warnings.push(`GST rate ${gst}% is not a standard GST slab — check it`)
      }
      const unitRaw = values.uom ?? ''
      if (!unitRaw) errors.push('Unit is blank')
      else {
        const u = unitCode(unitRaw)
        if (!u) errors.push(`Unit "${unitRaw}" is not one of ${UOMS.join(', ')}`)
        else values.uom = u
      }
      for (const [field, label] of [['purchasePrice', 'Purchase price'], ['sellPrice', 'Sale price'], ['mrp', 'MRP']] as const) {
        if (mapping[field] === undefined) continue
        const m = money(values[field] ?? '')
        if (m === null) errors.push(`${label} "${values[field]}" is not a number`)
        else {
          values[field] = m
          if (m === '' && field !== 'mrp') warnings.push(`${label} is blank — saved as 0`)
        }
      }
      if (mapping.hsn !== undefined && !values.hsn) warnings.push('HSN / SAC is blank')
      if (mapping.type === undefined) values.type = itemType as string
      else values.type = (values.type ?? '').toUpperCase()
      if (mapping.code !== undefined && !values.code) warnings.push('Code is blank — one is generated')
    } else {
      if (values.gstType) {
        const g = GST_TYPE_SYNONYMS[normalizeHeader(values.gstType)]
        if (g) values.gstType = g
      }
      const gstin = (values.gstin ?? '').toUpperCase().replace(/\s/g, '')
      const gstinState = /^\d{2}/.test(gstin) ? gstin.slice(0, 2) : ''
      const fromName = values.state ? STATE_CODES.get(normalizeHeader(values.state)) : undefined
      if (values.state && !fromName) warnings.push(`State "${values.state}" is not a recognised GST state name`)
      // The GSTIN's own state code wins (the party validation derives it); the state name fills it only without a GSTIN
      if (!values.stateCode && fromName && !gstinState) values.stateCode = fromName
      const given = values.stateCode || fromName
      if (gstinState && given && given !== gstinState) {
        warnings.push(`GSTIN state code ${gstinState} differs from ${values.state || 'state code'} (${given}) — the GSTIN's state is used`)
        delete values.stateCode
      }
    }

    rows.push({ line: r.line, values, errors, warnings })
    if (!errors.length) serviceRows.push({ row: r.line, data: values })
  }
  return { headers, rows, serviceRows, notes }
}
