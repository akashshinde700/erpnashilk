import { db } from '@/lib/db'
import { ApiError, assertLimit } from '@/lib/erp-helpers'
import { ITEM_TYPES, UOMS } from '@/lib/erp-constants'
import { normalizeItemName } from '@/lib/item-match'
import { createItem, nextItemCode, prepareItem, type PreparedItem } from '@/lib/services/items'
import { rowMessage, type ImportInputRow, type ImportRowResult, type ImportSummary } from '@/lib/services/customer-import'
import { ImportDuplicateError, lockCompanyForImport } from '@/lib/import/lock'

/**
 * Bulk item import, shared by POST /api/items/import (CSV dialog) and the Import Center.
 * Row keys: code, name, type, uom, hsn, gstRate (blank = 18), purchasePrice, category, standardCost,
 * sellPrice, reorderLevel, openingStock, mrp, rack, altUom, altFactor, cessRate, barcode, brand, status.
 * Rows are validated like the item form (prepareItem). Duplicates by code, barcode or same name
 * (ignoring case / spaces / punctuation) are skipped — against the database and within the file.
 *
 * dryRun: validate + detect duplicates only. Otherwise the plan item limit is checked for the whole
 * batch first, then each row is saved in its own transaction with its opening stock, so a failed
 * stock posting never leaves the item behind.
 * autoCode: blank codes get the next code of the item type's series (RM-001, FG-001…) instead of
 * being rejected.
 */

function cell(row: Record<string, string>, key: string): string {
  const v = row[key]
  return (v === undefined || v === null ? '' : String(v)).trim()
}

/** Number column ('' → 0); the message names the CSV column. */
function numOr0(v: string, field: string): number {
  if (!v) return 0
  const n = Number(v)
  if (Number.isNaN(n)) throw new ApiError(`${field} must be a number`, 400)
  return n
}

interface Ready { res: ImportRowResult; code: string; name: string; item: PreparedItem }

export async function importItems(companyId: string, rows: ImportInputRow[], opts: { dryRun?: boolean; autoCode?: boolean } = {}): Promise<ImportSummary> {
  const startedAt = new Date(Date.now() - 1000) // items created after this are re-checked inside each write
  // Default warehouse (code asc) for optional opening stock + existing items for dupe skips
  const [warehouse, existingItems] = await Promise.all([
    db.warehouse.findFirst({ where: { companyId }, orderBy: { code: 'asc' } }),
    db.item.findMany({ where: { companyId }, select: { code: true, name: true, barcode: true } }),
  ])
  const codes = new Set(existingItems.map((i) => i.code.toUpperCase()))
  const allCodes = existingItems.map((i) => ({ code: i.code })) // for the auto-code series
  const barcodes = new Set(existingItems.map((i) => i.barcode).filter((b): b is string => !!b))
  const names = new Map<string, string>() // normalised name → code (same rule as the item form's duplicate check)
  for (const i of existingItems) {
    const key = normalizeItemName(i.name)
    if (key.length >= 3 && !names.has(key)) names.set(key, i.code)
  }
  // Explicit codes are reserved first so an auto-generated code never takes one used later in the file
  for (const r of rows) {
    const c = cell(r.data, 'code').toUpperCase()
    if (c) allCodes.push({ code: c })
  }

  const results: ImportRowResult[] = []
  const ready: Ready[] = []
  let skipped = 0

  for (const { row: rowNo, data: row } of rows) {
    const name = cell(row, 'name')
    const res: ImportRowResult = { row: rowNo, status: 'ready', warnings: [], name: name || undefined }
    results.push(res)
    const reject = (message: string, dup = false) => {
      res.status = dup ? 'skipped' : 'error'
      res.message = message
      if (dup) skipped++
    }

    let code = cell(row, 'code').toUpperCase()
    if (!code && !opts.autoCode) { reject('code is required'); continue }
    if (!name) { reject('name is required'); continue }
    const type = (cell(row, 'type') || 'RAW').toUpperCase()
    if (!(ITEM_TYPES as readonly string[]).includes(type)) { reject(`Invalid type ${type} — must be one of ${ITEM_TYPES.join(', ')}`); continue }
    const uom = (cell(row, 'uom') || 'NOS').toUpperCase()
    if (!(UOMS as readonly string[]).includes(uom)) { reject(`Invalid uom ${uom} — must be one of ${UOMS.join(', ')}`); continue }

    let item: PreparedItem
    try {
      // Number columns, reported under the CSV column names
      const standardCost = numOr0(cell(row, 'standardCost'), 'standardCost')
      const purchasePrice = numOr0(cell(row, 'purchasePrice'), 'purchasePrice')
      numOr0(cell(row, 'sellPrice'), 'sellPrice')
      numOr0(cell(row, 'reorderLevel'), 'reorderLevel')
      const openingStock = numOr0(cell(row, 'openingStock'), 'openingStock')
      const gstRaw = cell(row, 'gstRate')
      const gstRate = gstRaw ? numOr0(gstRaw, 'gstRate') : 18
      if (gstRate < 0 || gstRate > 100) throw new ApiError('gstRate must be between 0 and 100', 400)
      if (openingStock > 0 && !warehouse) throw new ApiError('openingStock provided but the company has no warehouse', 400)
      // Same validation / normalisation as the item form (MRP, cess, secondary unit…)
      item = prepareItem({
        type, uom, gstRate, purchasePrice, standardCost,
        hsn: cell(row, 'hsn') || null,
        category: cell(row, 'category') || null,
        sellingPrice: cell(row, 'sellPrice'),
        reorderLevel: cell(row, 'reorderLevel'),
        mrp: cell(row, 'mrp'),
        rack: cell(row, 'rack'),
        altUom: cell(row, 'altUom'),
        altFactor: cell(row, 'altFactor'),
        cessRate: cell(row, 'cessRate'),
        barcode: cell(row, 'barcode'),
        brand: cell(row, 'brand'),
        status: cell(row, 'status').toUpperCase() === 'INACTIVE' ? 'INACTIVE' : 'ACTIVE',
        openingQty: openingStock,
        // Opening stock is valued at standard cost, else purchase price
        openingRate: standardCost || purchasePrice,
        openingWarehouseId: openingStock > 0 ? warehouse?.id : null,
      })
    } catch (e) {
      reject(rowMessage(e, 'Invalid row', 'items/import'))
      continue
    }

    if (code && codes.has(code)) { reject(`Duplicate code ${code} — skipped`, true); continue }
    const nameKey = normalizeItemName(name)
    const sameName = nameKey.length >= 3 ? names.get(nameKey) : undefined
    if (sameName) { reject(`Item already exists: ${sameName} has the same name as ${name} — skipped`, true); continue }
    const barcode = item.data.barcode ?? null
    if (barcode && barcodes.has(barcode)) { reject(`Barcode ${barcode} already used — skipped`, true); continue }
    if (!code) {
      code = nextItemCode(allCodes, type)
      allCodes.push({ code })
      res.warnings.push(`Code ${code} generated`)
    }
    codes.add(code)
    if (nameKey.length >= 3) names.set(nameKey, code)
    if (barcode) barcodes.add(barcode)
    res.code = code
    ready.push({ res, code, name, item })
  }

  let imported = 0
  let failed = 0
  if (ready.length > 0 && !opts.dryRun) {
    await assertLimit(companyId, 'items', ready.length)
    for (const r of ready) {
      try {
        // One transaction per row: the item and its opening stock are saved together or not at all
        const created = await db.$transaction(async (tx) => {
          // Serialise with other imports of this company (any process) and re-check items created meanwhile
          await lockCompanyForImport(tx, companyId)
          const key = normalizeItemName(r.name)
          const recent = await tx.item.findMany({ where: { companyId, createdAt: { gte: startedAt } }, select: { code: true, name: true } })
          const clash = recent.find((i) => i.code.toUpperCase() === r.code || (key.length >= 3 && normalizeItemName(i.name) === key))
          if (clash) throw new ImportDuplicateError(`Item already exists: ${clash.code} ${clash.name} — skipped`)
          return createItem(tx, companyId, r.code, r.name, r.item, { audit: false })
        })
        r.res.status = 'imported'
        r.res.entityId = created.id
        imported++
      } catch (e) {
        if (e instanceof ImportDuplicateError) { r.res.status = 'skipped'; r.res.message = e.message; skipped++; continue }
        r.res.status = 'failed'
        r.res.message = rowMessage(e, 'Failed to create item', 'items/import')
        failed++
      }
    }
  }
  return { imported, skipped, failed, results }
}
