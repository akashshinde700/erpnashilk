import { db } from '@/lib/db'
import { requireWrite, ok, handleError, companyRequired, ApiError, logAudit, assertLimit } from '@/lib/erp-helpers'

const WAREHOUSE_TYPES = ['RM', 'FG', 'GENERAL', 'SCRAP']

const optStr = (v: unknown): string | null => (v === undefined || v === null ? null : String(v).trim() || null)

// ============================== GET /api/warehouses?q=&type= ==============================
export async function GET(req: Request) {
  try {
    const companyId = await companyRequired(req)
    const { searchParams } = new URL(req.url)
    const q = (searchParams.get('q') || '').trim()
    const type = searchParams.get('type') || ''
    const where = {
      companyId,
      ...(q ? { OR: [{ code: { contains: q } }, { name: { contains: q } }] } : {}),
      ...(type ? { type } : {}),
    }
    const [items, total] = await Promise.all([
      db.warehouse.findMany({ where, orderBy: { code: 'asc' } }),
      db.warehouse.count({ where }),
    ])
    return ok({ items, total })
  } catch (e) {
    return handleError(e)
  }
}

// ============================== POST /api/warehouses ==============================
export async function POST(req: Request) {
  try {
    requireWrite(req, 'warehouses')
    const body = await req.json().catch(() => ({}))
    const companyId = await companyRequired(req, body.companyId)
    const code = String(body.code || '').trim()
    const name = String(body.name || '').trim()
    if (!code || !name) throw new ApiError('code and name are required', 400)
    const type = body.type || 'GENERAL'
    if (!WAREHOUSE_TYPES.includes(type)) {
      throw new ApiError('type must be one of RM, FG, GENERAL, SCRAP', 400)
    }

    await assertLimit(companyId, 'warehouses')
    const warehouse = await db.$transaction(async (tx) => {
      const created = await tx.warehouse.create({
        data: {
          companyId,
          code,
          name,
          type,
          location: body.location || null,
          address: optStr(body.address),
          inCharge: optStr(body.inCharge),
        },
      })
      await logAudit(tx as any, {
        companyId,
        userName: body.userName,
        action: 'CREATE',
        entity: 'Warehouse',
        entityId: created.id,
        details: `${code} — ${name} (${type})`,
      })
      return created
    })
    return ok(warehouse, 'Warehouse created')
  } catch (e) {
    return handleError(e)
  }
}
