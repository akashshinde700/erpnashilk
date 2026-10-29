import type { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { ApiError, logAudit } from '@/lib/erp-helpers'
import { findSimilarItems } from '@/lib/item-match'
import { parseSerials } from '@/lib/batches'
import { postOpeningStock, type OpeningStockInput } from '@/lib/services/opening-stock'

/**
 * Item master creation, shared by POST /api/items and the items CSV import.
 * Validation order and messages are those of the item form endpoint.
 */

type Tx = Prisma.TransactionClient
type Body = Record<string, any>

function num(v: unknown, def = 0, field = 'value'): number {
  if (v === undefined || v === null || v === '') return def
  const n = Number(v)
  if (Number.isNaN(n)) throw new ApiError(`${field} must be a number`, 400)
  return n
}

function optInt(v: unknown, field: string): number | null {
  if (v === undefined || v === null || v === '') return null
  const n = Number(v)
  if (!Number.isInteger(n) || n < 0) throw new ApiError(`${field} must be a whole number of 0 or more`, 400)
  return n
}

const optStr = (v: unknown): string | null => (v === undefined || v === null ? null : String(v).trim() || null)

/** Optional number that must be >= 0 when given ('' / null → null). */
function optNonNeg(v: unknown, field: string): number | null {
  if (v === undefined || v === null || v === '') return null
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0) throw new ApiError(`${field} must be a number of 0 or more`, 400)
  return n
}

/** Secondary unit: both altUom + altFactor or neither; 1 altUom = altFactor × uom. */
function altUnit(altUomRaw: unknown, altFactorRaw: unknown, uom: string): { altUom: string | null; altFactor: number | null } {
  const altUom = optStr(altUomRaw)?.toUpperCase() ?? null
  const hasFactor = !(altFactorRaw === undefined || altFactorRaw === null || altFactorRaw === '')
  if (!altUom && !hasFactor) return { altUom: null, altFactor: null }
  if (!altUom || !hasFactor) throw new ApiError('Secondary unit needs both the unit and its conversion factor', 400)
  if (altUom.length > 20) throw new ApiError('Secondary unit is too long', 400)
  if (altUom === uom.toUpperCase()) throw new ApiError('Secondary unit must differ from the primary UOM', 400)
  const altFactor = Number(altFactorRaw)
  if (!Number.isFinite(altFactor) || altFactor <= 0) throw new ApiError('Conversion factor must be greater than 0', 400)
  return { altUom, altFactor }
}

const CODE_PREFIX: Record<string, string> = { RAW: 'RM', SEMI: 'SF', FINISHED: 'FG', CONSUMABLE: 'CN', SERVICE: 'SV' }

/** Next free code like RM-007 for the item type (follows existing PREFIX-<number> codes). */
export function nextItemCode(existing: { code: string }[], type: string): string {
  const prefix = CODE_PREFIX[type] || 'IT'
  const re = new RegExp(`^${prefix}-?(\\d+)$`, 'i')
  const max = existing.reduce((m, it) => {
    const hit = re.exec(it.code)
    return hit ? Math.max(m, Number(hit[1])) : m
  }, 0)
  return `${prefix}-${String(max + 1).padStart(3, '0')}`
}

export function itemName(body: Body): string {
  const name = String(body.name || '').trim()
  if (!name) throw new ApiError('Item name is required', 400)
  return name
}

/** Same name ignoring case/spaces/punctuation = the same item, not a new one (409). */
export function assertNoSameName(existing: { id: string; code: string; name: string }[], name: string) {
  const { exact } = findSimilarItems(existing, name)
  if (exact) throw new ApiError(`Item already exists: ${exact.code} — ${exact.name}`, 409)
}

/** A barcode identifies exactly one item per company (scanners pick by it). */
export async function assertBarcodeFree(companyId: string, barcode: string | null) {
  if (!barcode) return
  const clash = await db.item.findFirst({ where: { companyId, barcode }, select: { code: true } })
  if (clash) throw new ApiError(`Barcode already used by ${clash.code}`, 409)
}

export interface PreparedItem {
  data: Omit<Prisma.ItemUncheckedCreateInput, 'companyId' | 'code' | 'name'>
  opening: OpeningStockInput
}

/** Validate + normalise the item-form body (everything except name / code / uniqueness checks). */
export function prepareItem(body: Body): PreparedItem {
  const gstRate = num(body.gstRate, 18, 'gstRate')
  const purchasePrice = num(body.purchasePrice, 0, 'purchasePrice')
  const openingQty = num(body.openingQty, 0, 'openingQty')
  const openingRate = num(body.openingRate, 0, 'openingRate')
  const uom = String(body.uom || 'NOS').trim().toUpperCase() || 'NOS'
  const { altUom, altFactor } = altUnit(body.altUom, body.altFactor, uom)
  const mrp = optNonNeg(body.mrp, 'MRP')
  const cessRate = optNonNeg(body.cessRate, 'Cess %') ?? 0
  if (cessRate > 100) throw new ApiError('Cess % cannot exceed 100', 400)
  return {
    data: {
      type: body.type || 'RAW',
      category: body.category || null,
      uom,
      altUom,
      altFactor,
      hsn: body.hsn || null,
      gstRate,
      batchTracked: !!body.batchTracked,
      reorderLevel: num(body.reorderLevel, 0, 'reorderLevel'),
      minStock: num(body.minStock, 0, 'minStock'),
      maxStock:
        body.maxStock === undefined || body.maxStock === null || body.maxStock === ''
          ? null
          : num(body.maxStock, 0, 'maxStock'),
      purchasePrice,
      sellingPrice: num(body.sellingPrice, 0, 'sellingPrice'),
      standardCost: num(body.standardCost, 0, 'standardCost'),
      description: body.description || null,
      status: body.status || 'ACTIVE',
      brand: optStr(body.brand),
      partNo: optStr(body.partNo),
      barcode: optStr(body.barcode),
      leadTimeDays: optInt(body.leadTimeDays, 'leadTimeDays'),
      mrp,
      priceIncludesTax: !!body.priceIncludesTax,
      rack: optStr(body.rack),
      cessRate,
      trackSerial: !!body.trackSerial,
    },
    opening: {
      qty: openingQty,
      rate: openingRate || purchasePrice,
      warehouseId: body.openingWarehouseId ? String(body.openingWarehouseId) : null,
      batchNo: String(body.openingBatchNo || '').trim() || 'OPENING',
      expiryDate: body.openingExpiry || null,
      mfgDate: body.openingMfgDate || null,
      serials: parseSerials(body.openingSerials),
    },
  }
}

export interface CreateItemOptions {
  /** Write the per-item CREATE audit row (default true; bulk imports write one summary instead). */
  audit?: boolean
  userName?: string
}

/** Create the item and (when given) its opening stock, inside the caller's transaction. */
export async function createItem(tx: Tx, companyId: string, code: string, name: string, item: PreparedItem, opts: CreateItemOptions = {}) {
  const created = await tx.item.create({ data: { companyId, code, name, ...item.data } })
  const { opening } = item
  const withOpening = opening.qty > 0 && !!opening.warehouseId
  // Optional opening stock post (warehouse is checked against the company there)
  if (withOpening) await postOpeningStock(tx, companyId, created.id, { ...opening, warehouseId: opening.warehouseId as string })
  if (opts.audit !== false) {
    await logAudit(tx as any, {
      companyId,
      userName: opts.userName,
      action: 'CREATE',
      entity: 'Item',
      entityId: created.id,
      details: `${code} — ${name}${withOpening ? ` (opening stock ${opening.qty})` : ''}`,
    })
  }
  return created
}
