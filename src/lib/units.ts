// Secondary (alternate) unit helpers for line entry.
// An item has a base `uom` and optionally `altUom` + `altFactor` where 1 altUom = altFactor × uom
// (e.g. 1 BOX = 24 PCS). Forms let the user type qty/rate in either unit; every API still
// receives qty and rate in the BASE unit, so the conversion happens here, client-side only.

export interface UnitItem {
  uom?: string | null
  altUom?: string | null
  altFactor?: number | null
}

export interface PriceItem {
  sellingPrice?: number | null
  gstRate?: number | null
  priceIncludesTax?: boolean | null
}

const r2 = (n: number) => Math.round(n * 100) / 100
const r3 = (n: number) => Math.round(n * 1000) / 1000
const r4 = (n: number) => Math.round(n * 10000) / 10000

/** True when the item has a usable secondary unit. */
export function hasAltUnit(item?: UnitItem | null): boolean {
  return !!item?.altUom && Number(item.altFactor) > 0 && item.altUom !== item.uom
}

/** Base units per one `unit` — altFactor for the item's altUom, 1 for anything else (base / unset). */
export function unitFactor(unit: string | null | undefined, item?: UnitItem | null): number {
  return unit && hasAltUnit(item) && unit === item?.altUom ? Number(item?.altFactor) : 1
}

/** True when `unit` is the item's secondary unit (i.e. the line needs converting). */
export function isAltUnit(unit: string | null | undefined, item?: UnitItem | null): boolean {
  return unitFactor(unit, item) !== 1
}

/** Qty typed in `unit` → qty in the base unit (3 decimals). */
export function toBaseQty(qty: number, unit: string | null | undefined, item?: UnitItem | null): number {
  const f = unitFactor(unit, item)
  return f === 1 ? qty : r3((qty || 0) * f)
}

/**
 * Rate per `unit` → rate per base unit. Rounded to 4 decimals (the sales APIs store line rates
 * at 4 dp) so 2 BOX @ ₹100 with 1 BOX = 24 PCS still totals ₹200.00 — at 2 dp the base rate
 * ₹4.17 would drift the line to ₹200.16. Totals previews must use this same rounded value.
 */
export function toBaseRate(rate: number, unit: string | null | undefined, item?: UnitItem | null): number {
  const f = unitFactor(unit, item)
  return f === 1 ? rate : r4((rate || 0) / f)
}

/** Re-express a rate when the line's unit changes (e.g. ₹10 / PCS → ₹240 / BOX). */
export function convertRate(rate: number, fromUnit: string | null | undefined, toUnit: string | null | undefined, item?: UnitItem | null): number {
  const from = unitFactor(fromUnit, item), to = unitFactor(toUnit, item)
  if (from === to) return rate
  const v = ((rate || 0) / from) * to
  // a rate per base unit keeps 4 dp (see toBaseRate); per the secondary unit 2 dp is enough
  return to === 1 ? r4(v) : r2(v)
}

/** Options for the line's unit select: base uom first, then the secondary unit ([] when the item has none). */
export function unitOptions(item?: UnitItem | null): { value: string; label: string }[] {
  if (!hasAltUnit(item)) return []
  const base = item?.uom || ''
  return [
    { value: base, label: base || 'Base' },
    // Short label — the trigger is narrow; the "= 48 PCS" hint shows the conversion
    { value: String(item?.altUom), label: String(item?.altUom) },
  ]
}

/** "= 48 PCS" under the qty when the secondary unit is used, else ''. */
export function baseQtyHint(qty: number, unit: string | null | undefined, item?: UnitItem | null): string {
  if (!isAltUnit(unit, item)) return ''
  return `= ${toBaseQty(qty, unit, item)} ${item?.uom || ''}`.trim()
}

/** A draft line converted to base qty/rate, with the client-only `unit` field dropped. */
export function lineToBase<L extends { qty: number; rate: number; unit?: string }>(line: L, item?: UnitItem | null): Omit<L, 'unit'> {
  const { unit, ...rest } = line
  return { ...rest, qty: toBaseQty(line.qty, unit, item), rate: toBaseRate(line.rate, unit, item) }
}

/**
 * Default selling rate from the item master. When the master price includes GST, the taxable
 * (pre-GST) rate is backed out: sellingPrice / (1 + gstRate/100), 2 decimals.
 */
export function defaultSellRate(item?: PriceItem | null): number {
  const sp = Number(item?.sellingPrice || 0)
  if (!item?.priceIncludesTax || !sp) return sp
  return r2(sp / (1 + Number(item.gstRate || 0) / 100))
}

/** "incl. GST ₹118" hint for tax-inclusive items ('' otherwise); scaled to the line's unit. */
export function inclGstHint(item: (PriceItem & UnitItem) | null | undefined, unit?: string | null): string {
  const sp = Number(item?.sellingPrice || 0)
  if (!item?.priceIncludesTax || !sp) return ''
  const amt = r2(sp * unitFactor(unit, item))
  return `incl. GST ₹${amt.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`
}
