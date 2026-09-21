import { db } from '@/lib/db'
import { ok, handleError, companyRequired, ApiError, logAudit } from '@/lib/erp-helpers'

function num(v: unknown, def = 0, field = 'value'): number {
  if (v === undefined || v === null || v === '') return def
  const n = Number(v)
  if (Number.isNaN(n)) throw new ApiError(`${field} must be a number`, 400)
  return n
}

interface RawLine { itemId?: unknown; qty?: unknown; scrapPct?: unknown }

/** Parse + validate BOM lines: >=1 line, itemId present, qty > 0. */
function parseLines(raw: unknown): { itemId: string; qty: number; scrapPct: number }[] {
  const rawLines: RawLine[] = Array.isArray(raw) ? raw : []
  if (rawLines.length === 0) throw new ApiError('At least one BOM line is required', 400)
  return rawLines.map((l) => {
    const itemId = String(l?.itemId || '')
    const qty = num(l?.qty, 0, 'qty')
    if (!itemId) throw new ApiError('Each BOM line requires an itemId', 400)
    if (qty <= 0) throw new ApiError('BOM line qty must be greater than 0', 400)
    return { itemId, qty, scrapPct: num(l?.scrapPct, 0, 'scrapPct') }
  })
}

/** Verify output item + line items all belong to the company. */
async function verifyItems(companyId: string, outputItemId: string, lines: { itemId: string }[]) {
  const ids = Array.from(new Set([outputItemId, ...lines.map((l) => l.itemId)]))
  const found = await db.item.findMany({ where: { companyId, id: { in: ids } }, select: { id: true } })
  const foundIds = new Set(found.map((f) => f.id))
  if (!foundIds.has(outputItemId)) throw new ApiError('Output item not found in this company', 400)
  if (lines.some((l) => !foundIds.has(l.itemId))) {
    throw new ApiError('One or more BOM line items are invalid for this company', 400)
  }
}

// ============================== GET /api/boms?q= ==============================
export async function GET(req: Request) {
  try {
    const companyId = await companyRequired(req)
    const { searchParams } = new URL(req.url)
    const q = (searchParams.get('q') || '').trim()
    const where = {
      companyId,
      ...(q ? { code: { contains: q } } : {}),
    }
    const [boms, total] = await Promise.all([
      db.bom.findMany({ where, orderBy: { code: 'asc' }, include: { items: true } }),
      db.bom.count({ where }),
    ])
    // Bom/BomItem have no Item relations in schema — attach {code,name,uom} for the UI.
    const ids = Array.from(
      new Set(boms.flatMap((b) => [b.outputItemId, ...b.items.map((l) => l.itemId)])),
    )
    const itemRows = ids.length
      ? await db.item.findMany({ where: { companyId, id: { in: ids } }, select: { id: true, code: true, name: true, uom: true } })
      : []
    const map = new Map(itemRows.map((i) => [i.id, i]))
    const items = boms.map((b) => {
      const out = map.get(b.outputItemId)
      return {
        ...b,
        outputItem: out ? { id: out.id, code: out.code, name: out.name, uom: out.uom } : null,
        items: b.items.map((l) => ({
          id: l.id,
          itemId: l.itemId,
          qty: l.qty,
          scrapPct: l.scrapPct,
          item: map.get(l.itemId) || null,
        })),
      }
    })
    return ok({ items, total })
  } catch (e) {
    return handleError(e)
  }
}

// ============================== POST /api/boms ==============================
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}))
    const companyId = await companyRequired(req, body.companyId)
    const code = String(body.code || '').trim()
    if (!code) throw new ApiError('code is required', 400)
    const outputItemId = String(body.outputItemId || '')
    if (!outputItemId) throw new ApiError('outputItemId is required', 400)
    const outputQty = num(body.outputQty, 1, 'outputQty')
    if (outputQty <= 0) throw new ApiError('outputQty must be greater than 0', 400)
    const lines = parseLines(body.items)
    await verifyItems(companyId, outputItemId, lines)

    const version = body.version || 'V1'
    const bom = await db.$transaction(async (tx) => {
      const created = await tx.bom.create({
        data: {
          companyId,
          code,
          outputItemId,
          outputQty,
          version,
          scrapPct: num(body.scrapPct, 0, 'scrapPct'),
          notes: body.notes || null,
          status: body.status || 'ACTIVE',
        },
      })
      for (const l of lines) {
        await tx.bomItem.create({
          data: { bomId: created.id, itemId: l.itemId, qty: l.qty, scrapPct: l.scrapPct },
        })
      }
      await logAudit(tx as any, {
        companyId,
        userName: body.userName,
        action: 'CREATE',
        entity: 'Bom',
        entityId: created.id,
        details: `${code} (${version}) — ${lines.length} component(s)`,
      })
      return created
    })
    return ok(bom, 'BOM created')
  } catch (e) {
    return handleError(e)
  }
}
