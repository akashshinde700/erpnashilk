import { db } from '@/lib/db'
import { findSimilarItems } from '@/lib/item-match'
import { requireWrite, ok, handleError, companyRequired, ApiError, postStock, logAudit, assertLimit } from '@/lib/erp-helpers'
import { parseSerials, receiveBatch, receiveSerials } from '@/lib/batches'

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

// ============================== GET /api/items?q=&type=&status=&hideVariants=1&page=&pageSize= ==============================
export async function GET(req: Request) {
  try {
    const companyId = await companyRequired(req)
    const { searchParams } = new URL(req.url)
    const q = (searchParams.get('q') || '').trim()
    const type = searchParams.get('type') || ''
    const status = searchParams.get('status') || ''
    const hideVariants = searchParams.get('hideVariants') === '1'
    // Server-side pagination: page is 1-based; pageSize defaults to 200 (cap 500).
    // Only an explicit page >= 1 slices the findMany — without it the response
    // stays byte-compatible (all matching rows, accurate total).
    const page = Math.max(0, Number.parseInt(searchParams.get('page') || '', 10) || 0)
    const pageSize = Math.min(Number.parseInt(searchParams.get('pageSize') || '', 10) || 200, 500)
    const where = {
      companyId,
      ...(q ? { OR: [{ code: { contains: q } }, { name: { contains: q } }] } : {}),
      ...(type ? { type } : {}),
      ...(status ? { status } : {}),
      ...(hideVariants ? { variantOf: null } : {}),
    }
    const [items, total] = await Promise.all([
      db.item.findMany({
        where,
        orderBy: { code: 'asc' },
        ...(page >= 1 ? { skip: (page - 1) * pageSize, take: pageSize } : {}),
      }),
      db.item.count({ where }),
    ])
    // Available stock per item (all stores) + store-wise breakdown and stock value at moving average
    const ids = items.map((i) => i.id)
    const [balances, stores] = ids.length
      ? await Promise.all([
        db.stockBalance.findMany({ where: { companyId, itemId: { in: ids } }, select: { itemId: true, warehouseId: true, qty: true, avgRate: true } }),
        db.warehouse.findMany({ where: { companyId }, select: { id: true, code: true, name: true } }),
      ])
      : [[], []]
    // Size/colour children per parent on this page (children may sit on other pages)
    const variantCount = new Map<string, number>()
    if (ids.length) {
      const children = await db.item.findMany({ where: { companyId, variantOf: { in: ids } }, select: { variantOf: true } })
      for (const c of children) if (c.variantOf) variantCount.set(c.variantOf, (variantCount.get(c.variantOf) ?? 0) + 1)
    }
    const storeMap = new Map(stores.map((w) => [w.id, w]))
    const byItem = new Map<string, { qty: number; value: number; stores: { code: string; name: string; qty: number }[] }>()
    for (const b of balances) {
      const e = byItem.get(b.itemId) ?? { qty: 0, value: 0, stores: [] }
      e.qty += b.qty
      e.value += b.qty * b.avgRate
      const w = storeMap.get(b.warehouseId)
      if (Math.abs(b.qty) > 0.0001) e.stores.push({ code: w?.code ?? '', name: w?.name ?? '', qty: Math.round(b.qty * 100) / 100 })
      byItem.set(b.itemId, e)
    }
    const rows = items.map((i) => {
      const s = byItem.get(i.id)
      return { ...i, stockQty: s ? Math.round(s.qty * 100) / 100 : 0, stockValue: s ? Math.round(s.value * 100) / 100 : 0, stockByStore: s?.stores ?? [], variantCount: variantCount.get(i.id) ?? 0 }
    })
    return ok({ items: rows, total })
  } catch (e) {
    return handleError(e)
  }
}

const CODE_PREFIX: Record<string, string> = { RAW: 'RM', SEMI: 'SF', FINISHED: 'FG', CONSUMABLE: 'CN', SERVICE: 'SV' }

/** Next free code like RM-007 for the item type (follows existing PREFIX-<number> codes). */
function nextItemCode(existing: { code: string }[], type: string): string {
  const prefix = CODE_PREFIX[type] || 'IT'
  const re = new RegExp(`^${prefix}-?(\\d+)$`, 'i')
  const max = existing.reduce((m, it) => {
    const hit = re.exec(it.code)
    return hit ? Math.max(m, Number(hit[1])) : m
  }, 0)
  return `${prefix}-${String(max + 1).padStart(3, '0')}`
}

// ============================== POST /api/items ==============================
export async function POST(req: Request) {
  try {
    requireWrite(req, 'items')
    const body = await req.json().catch(() => ({}))
    const companyId = await companyRequired(req, body.companyId)
    const name = String(body.name || '').trim()
    if (!name) throw new ApiError('Item name is required', 400)
    // Same name ignoring case/spaces/punctuation = the same item, not a new one
    const existing = await db.item.findMany({ where: { companyId }, select: { id: true, code: true, name: true } })
    const { exact } = findSimilarItems(existing, name)
    if (exact) throw new ApiError(`Item already exists: ${exact.code} — ${exact.name}`, 409)
    // Code is optional: blank → next number for the type's prefix (RM-001, FG-001…)
    const code = String(body.code || '').trim() || nextItemCode(existing, String(body.type || 'RAW'))
    const gstRate = num(body.gstRate, 18, 'gstRate')
    const purchasePrice = num(body.purchasePrice, 0, 'purchasePrice')
    const openingQty = num(body.openingQty, 0, 'openingQty')
    const openingRate = num(body.openingRate, 0, 'openingRate')
    const uom = String(body.uom || 'NOS').trim().toUpperCase() || 'NOS'
    const { altUom, altFactor } = altUnit(body.altUom, body.altFactor, uom)
    const mrp = optNonNeg(body.mrp, 'MRP')
    const cessRate = optNonNeg(body.cessRate, 'Cess %') ?? 0
    if (cessRate > 100) throw new ApiError('Cess % cannot exceed 100', 400)
    // A barcode identifies exactly one item per company (scanners pick by it)
    const barcode = optStr(body.barcode)
    if (barcode) {
      const clash = await db.item.findFirst({ where: { companyId, barcode }, select: { code: true } })
      if (clash) throw new ApiError(`Barcode already used by ${clash.code}`, 409)
    }

    await assertLimit(companyId, 'items')
    const item = await db.$transaction(async (tx) => {
      const created = await tx.item.create({
        data: {
          companyId,
          code,
          name,
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
          barcode,
          leadTimeDays: optInt(body.leadTimeDays, 'leadTimeDays'),
          mrp,
          priceIncludesTax: !!body.priceIncludesTax,
          rack: optStr(body.rack),
          cessRate,
          trackSerial: !!body.trackSerial,
        },
      })
      // Optional opening stock post
      if (openingQty > 0 && body.openingWarehouseId) {
        await postStock(tx as any, {
          companyId,
          itemId: created.id,
          warehouseId: String(body.openingWarehouseId),
          type: 'OPENING',
          qtyIn: openingQty,
          rate: openingRate || purchasePrice,
          refType: 'OPENING',
          notes: 'Opening stock',
        })
        // Batch / serial layer (no-op unless the new item is batch / serial tracked)
        await receiveBatch(tx, {
          companyId, itemId: created.id, warehouseId: String(body.openingWarehouseId),
          batchNo: String(body.openingBatchNo || '').trim() || 'OPENING', expiryDate: body.openingExpiry || null,
          mfgDate: body.openingMfgDate || null, qty: openingQty,
        })
        await receiveSerials(tx, {
          companyId, itemId: created.id, warehouseId: String(body.openingWarehouseId),
          serials: parseSerials(body.openingSerials), qty: openingQty, ref: { type: 'OPENING', id: created.id },
        })
      }
      await logAudit(tx as any, {
        companyId,
        userName: body.userName,
        action: 'CREATE',
        entity: 'Item',
        entityId: created.id,
        details: `${code} — ${name}${openingQty > 0 && body.openingWarehouseId ? ` (opening stock ${openingQty})` : ''}`,
      })
      return created
    })
    return ok(item, 'Item created')
  } catch (e) {
    return handleError(e)
  }
}
