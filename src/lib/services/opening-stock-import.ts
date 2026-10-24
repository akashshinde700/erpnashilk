import { db } from '@/lib/db'
import { ApiError, r2 } from '@/lib/erp-helpers'
import { goLiveForOpening, goLiveString, openingDateFor } from '@/lib/go-live'
import { normalizeItemName } from '@/lib/item-match'
import { postOpeningStock } from '@/lib/services/opening-stock'
import { lockCompanyForImport } from '@/lib/import/lock'
import { rowMessage, type ImportInputRow, type ImportRowResult, type ImportSummary } from '@/lib/services/customer-import'

/**
 * Opening stock import (Import Center). Posts through the same stock service as the item form
 * (postOpeningStock → postStock: immutable StockLedger row type OPENING + StockBalance at moving
 * average, batch layer for batch-tracked items) — StockBalance is never written on its own.
 *
 * Every row is dated at the company's go-live opening timestamp and tagged with the import
 * reference (StockLedger.refNumber), which the reconciliation reads back.
 *
 * Row keys (already normalised by apply-mapping): itemCode, itemName, warehouse, qty, rate, value,
 * unit, batchNo, expiryDate. Nothing is assumed: the item must exist, the warehouse must be given
 * (column or explicit default), a rate or value is required and must agree with each other, the
 * unit must be the item's unit, batch-tracked items need a batch number.
 *
 * Refused / skipped:
 *  - the item + warehouse already has an OPENING entry (item form or an earlier import) → duplicate
 *  - the item + warehouse has other stock movements dated before go-live → error (opening must come first)
 *  - the same item + warehouse (+ batch) twice in the file → error
 *  - zero quantity → skipped; negative quantity → error
 *  - service items, serial-tracked items (serial numbers are not imported yet) → error
 */

export interface OpeningStockOptions {
  dryRun?: boolean
  goLive: Date
  defaultWarehouseId?: string | null
  /** StockLedger.refNumber of every posted row (reconciliation key). */
  importRef: string
}

export interface ReconLine {
  item: string
  warehouse: string
  sourceQty: number
  sourceValue: number
  postedQty: number
  postedValue: number
  qtyDiff: number
  valueDiff: number
}

export interface StockReconciliation {
  ref: string
  openingDate: string
  goLiveDate: string
  lines: ReconLine[]
  totals: { sourceQty: number; sourceValue: number; postedQty: number; postedValue: number; qtyDiff: number; valueDiff: number }
}

const cell = (row: Record<string, string>, key: string) => String(row[key] ?? '').trim()
const r4 = (n: number) => Math.round(n * 10000) / 10000
const key = (...p: string[]) => p.join('|')

interface Prepared { res: ImportRowResult; itemId: string; itemLabel: string; warehouseId: string; warehouseLabel: string; qty: number; rate: number; value: number; batchNo: string; expiryDate: string | null }

export async function importOpeningStock(companyId: string, rows: ImportInputRow[], opts: OpeningStockOptions): Promise<ImportSummary & { reconciliation?: StockReconciliation }> {
  const goLive = opts.goLive
  const openingDate = openingDateFor(goLive)
  const [items, warehouses, openings, before, after] = await Promise.all([
    db.item.findMany({ where: { companyId }, select: { id: true, code: true, name: true, uom: true, type: true, batchTracked: true, trackSerial: true } }),
    db.warehouse.findMany({ where: { companyId }, select: { id: true, code: true, name: true } }),
    db.stockLedger.groupBy({ by: ['itemId', 'warehouseId'], where: { companyId, type: 'OPENING' }, _count: { _all: true } }),
    db.stockLedger.groupBy({ by: ['itemId', 'warehouseId'], where: { companyId, type: { not: 'OPENING' }, date: { lt: goLive } }, _count: { _all: true } }),
    db.stockLedger.groupBy({ by: ['itemId', 'warehouseId'], where: { companyId, type: { not: 'OPENING' }, date: { gte: goLive } }, _count: { _all: true } }),
  ])
  let defaultWarehouse: (typeof warehouses)[number] | undefined
  if (opts.defaultWarehouseId) {
    defaultWarehouse = warehouses.find((w) => w.id === opts.defaultWarehouseId)
    if (!defaultWarehouse) throw new ApiError('The chosen default warehouse does not belong to this company', 400)
  }
  const byCode = new Map(items.map((i) => [i.code.toUpperCase(), i]))
  const byName = new Map<string, typeof items>()
  for (const i of items) {
    const k = normalizeItemName(i.name)
    byName.set(k, [...(byName.get(k) ?? []), i])
  }
  const whByKey = new Map<string, (typeof warehouses)[number]>()
  for (const w of warehouses) { whByKey.set(w.code.trim().toLowerCase(), w); whByKey.set(w.name.trim().toLowerCase(), w) }
  const hasOpening = new Set(openings.map((o) => key(o.itemId, o.warehouseId)))
  const movedBefore = new Set(before.map((o) => key(o.itemId, o.warehouseId)))
  const movedAfter = new Map(after.map((o) => [key(o.itemId, o.warehouseId), o._count._all]))

  const results: ImportRowResult[] = []
  const ready: Prepared[] = []
  const seen = new Map<string, number>()
  let skipped = 0

  for (const { row: rowNo, data: row } of rows) {
    const code = cell(row, 'itemCode')
    const name = cell(row, 'itemName')
    const res: ImportRowResult = { row: rowNo, status: 'ready', warnings: [], name: name || code || undefined }
    results.push(res)
    const reject = (message: string, dup = false) => {
      res.status = dup ? 'skipped' : 'error'
      res.message = message
      if (dup) skipped++
    }

    // ---- item ----
    let item: (typeof items)[number] | undefined
    if (code) {
      item = byCode.get(code.toUpperCase())
      if (!item) { reject(`No item with code ${code} — import or create the item first`); continue }
      if (name && normalizeItemName(name) !== normalizeItemName(item.name)) { reject(`Code ${item.code} is "${item.name}", but the file says "${name}"`); continue }
    } else if (name) {
      const hits = byName.get(normalizeItemName(name)) ?? []
      if (hits.length === 0) { reject(`No item named ${name} — import or create the item first`); continue }
      if (hits.length > 1) { reject(`More than one item is named like ${name} (${hits.map((h) => h.code).join(', ')}) — use item codes`); continue }
      item = hits[0]
    } else {
      reject('Item code or name is required'); continue
    }
    res.name = `${item.code} ${item.name}`
    if (item.type === 'SERVICE') { reject(`${item.code} is a service — it has no stock`); continue }
    if (item.trackSerial) { reject(`${item.code} is serial-tracked — serial numbers cannot be imported yet; add its opening stock from the item screen`); continue }

    // ---- warehouse ----
    const whText = cell(row, 'warehouse')
    const wh = whText ? whByKey.get(whText.toLowerCase()) : defaultWarehouse
    if (!wh) { reject(whText ? `No warehouse "${whText}" in this company` : 'No warehouse — map a warehouse column or choose a default warehouse'); continue }

    // ---- quantity / unit ----
    const qty = Number(cell(row, 'qty'))
    if (!Number.isFinite(qty)) { reject('Quantity is not a number'); continue }
    if (qty < 0) { reject(`Negative quantity ${qty} — correct the stock in the source before importing`); continue }
    if (qty === 0) { reject('Zero quantity — nothing to import', true); continue }
    const unit = cell(row, 'unit')
    if (unit && unit.toUpperCase() !== item.uom.toUpperCase()) { reject(`Quantity is in ${unit} but ${item.code} is kept in ${item.uom} — convert the quantity first`); continue }

    // ---- valuation (never assumed) ----
    const rateText = cell(row, 'rate')
    const valueText = cell(row, 'value')
    const rateIn = rateText === '' ? null : Number(rateText)
    const valueIn = valueText === '' ? null : Number(valueText)
    if ((rateIn !== null && !Number.isFinite(rateIn)) || (valueIn !== null && !Number.isFinite(valueIn))) { reject('Rate / value is not a number'); continue }
    if (rateIn === null && valueIn === null) { reject('No rate or value — the stock cannot be valued'); continue }
    if ((rateIn ?? 0) < 0 || (valueIn ?? 0) < 0) { reject('Rate / value cannot be negative'); continue }
    let rate: number
    let value: number
    if (rateIn !== null && valueIn !== null) {
      const expected = qty * rateIn
      if (Math.abs(expected - valueIn) > Math.max(0.5, valueIn * 0.001)) { reject(`Value ${valueIn} does not match quantity × rate (${r2(expected)})`); continue }
      rate = r4(rateIn)
      value = r2(valueIn)
    } else if (rateIn !== null) {
      rate = r4(rateIn)
      value = r2(qty * rateIn)
    } else {
      rate = r4((valueIn as number) / qty)
      value = r2(valueIn as number)
    }
    if (rate === 0) res.warnings.push('Valued at 0')

    // ---- batch ----
    const batchNo = cell(row, 'batchNo')
    const expiry = cell(row, 'expiryDate')
    if (item.batchTracked && !batchNo) { reject(`${item.code} is batch-tracked — a batch number is required`); continue }
    if (!item.batchTracked && batchNo) res.warnings.push('Batch number ignored — the item is not batch-tracked')

    // ---- duplicates / ordering ----
    const ik = key(item.id, wh.id)
    if (hasOpening.has(ik)) { reject(`${item.code} already has opening stock in ${wh.code} — skipped`, true); continue }
    if (movedBefore.has(ik)) { reject(`${item.code} has stock movements in ${wh.code} dated before the go-live date — opening stock must come first; use a stock adjustment instead`); continue }
    const fk = key(ik, item.batchTracked ? batchNo.toUpperCase() : '')
    const earlier = seen.get(fk)
    if (earlier !== undefined) { reject(`${item.code} in ${wh.code}${item.batchTracked ? ` batch ${batchNo}` : ''} is already on row ${earlier} — combine the rows`); continue }
    seen.set(fk, rowNo)
    const later = movedAfter.get(ik)
    if (later) res.warnings.push(`${later} movement(s) after go-live already recorded for this item in ${wh.code} — its balance will include this opening stock`)

    res.code = item.code
    res.extra = { item: `${item.code} ${item.name}`, warehouse: wh.code, qty, rate, value, uom: item.uom, batchNo: item.batchTracked ? batchNo : null }
    ready.push({
      res, itemId: item.id, itemLabel: `${item.code} ${item.name}`, warehouseId: wh.id, warehouseLabel: wh.code, qty, rate, value,
      batchNo: item.batchTracked ? batchNo : 'OPENING', expiryDate: item.batchTracked && expiry ? expiry : null,
    })
  }

  let imported = 0
  let failed = 0
  if (opts.dryRun || ready.length === 0) return { imported, skipped, failed, results }

  for (const p of ready) {
    try {
      await db.$transaction(async (tx) => {
        // Serialise with other imports of this company (any process), then re-check: another import
        // may have posted opening stock meanwhile
        await lockCompanyForImport(tx, companyId)
        const already = await tx.stockLedger.count({ where: { companyId, itemId: p.itemId, warehouseId: p.warehouseId, type: 'OPENING' } })
        if (already && !(await tx.stockLedger.count({ where: { companyId, itemId: p.itemId, warehouseId: p.warehouseId, type: 'OPENING', refNumber: opts.importRef } }))) {
          throw new ApiError(`${p.itemLabel} already has opening stock in ${p.warehouseLabel}`, 409)
        }
        await postOpeningStock(tx, companyId, p.itemId, {
          qty: p.qty, rate: p.rate, warehouseId: p.warehouseId, batchNo: p.batchNo, expiryDate: p.expiryDate, serials: [],
          date: openingDate, refNumber: opts.importRef, notes: `Opening stock import (go-live ${goLiveString(goLive)})`,
        })
      })
      p.res.status = 'imported'
      imported++
    } catch (e) {
      p.res.status = 'failed'
      p.res.message = rowMessage(e, 'Failed to post opening stock', 'opening-stock/import')
      failed++
    }
  }
  const reconciliation = await reconcileOpeningStock(companyId, opts.importRef, ready.map((p) => ({ itemId: p.itemId, warehouseId: p.warehouseId, item: p.itemLabel, warehouse: p.warehouseLabel, qty: p.qty, value: p.value })))
  return { imported, skipped, failed, results, reconciliation }
}

/**
 * Source (file) vs posted (stock ledger rows of this import reference), per item + warehouse.
 * Without `source` (e.g. later from the history), the posted side is reported on its own.
 */
export async function reconcileOpeningStock(
  companyId: string, ref: string, source: { itemId: string; warehouseId: string; item: string; warehouse: string; qty: number; value: number }[] = [],
): Promise<StockReconciliation> {
  const posted = await db.stockLedger.findMany({
    where: { companyId, type: 'OPENING', refNumber: ref },
    select: { itemId: true, warehouseId: true, qtyIn: true, rate: true, date: true, item: { select: { code: true, name: true } } },
  })
  const whIds = [...new Set(posted.map((p) => p.warehouseId))]
  const whs = whIds.length ? await db.warehouse.findMany({ where: { companyId, id: { in: whIds } }, select: { id: true, code: true } }) : []
  const whCode = new Map(whs.map((w) => [w.id, w.code]))
  const lines = new Map<string, ReconLine>()
  const line = (k: string, item: string, warehouse: string) => {
    let l = lines.get(k)
    if (!l) { l = { item, warehouse, sourceQty: 0, sourceValue: 0, postedQty: 0, postedValue: 0, qtyDiff: 0, valueDiff: 0 }; lines.set(k, l) }
    return l
  }
  for (const s of source) {
    const l = line(key(s.itemId, s.warehouseId), s.item, s.warehouse)
    l.sourceQty = r4(l.sourceQty + s.qty)
    l.sourceValue = r2(l.sourceValue + s.value)
  }
  for (const p of posted) {
    const l = line(key(p.itemId, p.warehouseId), `${p.item.code} ${p.item.name}`, whCode.get(p.warehouseId) ?? '')
    l.postedQty = r4(l.postedQty + p.qtyIn)
    l.postedValue = r2(l.postedValue + p.qtyIn * p.rate)
  }
  const all = [...lines.values()].map((l) => ({ ...l, qtyDiff: r4(l.postedQty - l.sourceQty), valueDiff: r2(l.postedValue - l.sourceValue) }))
  const sum = (f: (l: ReconLine) => number) => all.reduce((s, l) => s + f(l), 0)
  const openingDate = posted[0]?.date ?? null
  return {
    ref,
    openingDate: openingDate ? openingDate.toISOString() : '',
    goLiveDate: openingDate ? goLiveForOpening(openingDate) ?? '' : '',
    lines: all,
    totals: {
      sourceQty: r4(sum((l) => l.sourceQty)), sourceValue: r2(sum((l) => l.sourceValue)),
      postedQty: r4(sum((l) => l.postedQty)), postedValue: r2(sum((l) => l.postedValue)),
      qtyDiff: r4(sum((l) => l.qtyDiff)), valueDiff: r2(sum((l) => l.valueDiff)),
    },
  }
}
