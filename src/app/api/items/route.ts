import { db } from '@/lib/db'
import { requireWrite, ok, handleError, companyRequired, ApiError, postStock, logAudit } from '@/lib/erp-helpers'

function num(v: unknown, def = 0, field = 'value'): number {
  if (v === undefined || v === null || v === '') return def
  const n = Number(v)
  if (Number.isNaN(n)) throw new ApiError(`${field} must be a number`, 400)
  return n
}

// ============================== GET /api/items?q=&type=&status=&page=&pageSize= ==============================
export async function GET(req: Request) {
  try {
    const companyId = await companyRequired(req)
    const { searchParams } = new URL(req.url)
    const q = (searchParams.get('q') || '').trim()
    const type = searchParams.get('type') || ''
    const status = searchParams.get('status') || ''
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
    }
    const [items, total] = await Promise.all([
      db.item.findMany({
        where,
        orderBy: { code: 'asc' },
        ...(page >= 1 ? { skip: (page - 1) * pageSize, take: pageSize } : {}),
      }),
      db.item.count({ where }),
    ])
    return ok({ items, total })
  } catch (e) {
    return handleError(e)
  }
}

// ============================== POST /api/items ==============================
export async function POST(req: Request) {
  try {
    requireWrite(req, 'items')
    const body = await req.json().catch(() => ({}))
    const companyId = await companyRequired(req, body.companyId)
    const code = String(body.code || '').trim()
    const name = String(body.name || '').trim()
    if (!code || !name) throw new ApiError('code and name are required', 400)
    const gstRate = num(body.gstRate, 18, 'gstRate')
    const purchasePrice = num(body.purchasePrice, 0, 'purchasePrice')
    const openingQty = num(body.openingQty, 0, 'openingQty')
    const openingRate = num(body.openingRate, 0, 'openingRate')

    const item = await db.$transaction(async (tx) => {
      const created = await tx.item.create({
        data: {
          companyId,
          code,
          name,
          type: body.type || 'RAW',
          category: body.category || null,
          uom: body.uom || 'NOS',
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
