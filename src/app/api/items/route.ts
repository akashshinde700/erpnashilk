import { db } from '@/lib/db'
import { requireWrite, ok, handleError, companyRequired, assertLimit } from '@/lib/erp-helpers'
import { assertBarcodeFree, assertNoSameName, createItem, itemName, nextItemCode, prepareItem } from '@/lib/services/items'

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

// ============================== POST /api/items ==============================
export async function POST(req: Request) {
  try {
    requireWrite(req, 'items')
    const body = await req.json().catch(() => ({}))
    const companyId = await companyRequired(req, body.companyId)
    const name = itemName(body)
    // Same name ignoring case/spaces/punctuation = the same item, not a new one
    const existing = await db.item.findMany({ where: { companyId }, select: { id: true, code: true, name: true } })
    assertNoSameName(existing, name)
    // Code is optional: blank → next number for the type's prefix (RM-001, FG-001…)
    const code = String(body.code || '').trim() || nextItemCode(existing, String(body.type || 'RAW'))
    const prepared = prepareItem(body)
    await assertBarcodeFree(companyId, prepared.data.barcode ?? null)

    await assertLimit(companyId, 'items')
    const item = await db.$transaction((tx) => createItem(tx, companyId, code, name, prepared, { userName: body.userName }))
    return ok(item, 'Item created')
  } catch (e) {
    return handleError(e)
  }
}
