import { db } from '@/lib/db'
import { ok, handleError, companyRequired, ApiError, logAudit } from '@/lib/erp-helpers'

function num(v: unknown, def = 0, field = 'value'): number {
  if (v === undefined || v === null || v === '') return def
  const n = Number(v)
  if (Number.isNaN(n)) throw new ApiError(`${field} must be a number`, 400)
  return n
}

// ============================== GET /api/suppliers?q=&status= ==============================
export async function GET(req: Request) {
  try {
    const companyId = await companyRequired(req)
    const { searchParams } = new URL(req.url)
    const q = (searchParams.get('q') || '').trim()
    const status = searchParams.get('status') || ''
    const where = {
      companyId,
      ...(q ? { OR: [{ code: { contains: q } }, { name: { contains: q } }] } : {}),
      ...(status ? { status } : {}),
    }
    const [items, total] = await Promise.all([
      db.supplier.findMany({ where, orderBy: { code: 'asc' } }),
      db.supplier.count({ where }),
    ])
    return ok({ items, total })
  } catch (e) {
    return handleError(e)
  }
}

// ============================== POST /api/suppliers ==============================
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}))
    const companyId = await companyRequired(req, body.companyId)
    const code = String(body.code || '').trim()
    const name = String(body.name || '').trim()
    if (!code || !name) throw new ApiError('code and name are required', 400)

    const supplier = await db.$transaction(async (tx) => {
      const created = await tx.supplier.create({
        data: {
          companyId,
          code,
          name,
          gstin: body.gstin || null,
          contactPerson: body.contactPerson || null,
          phone: body.phone || null,
          email: body.email || null,
          addressLine: body.addressLine || null,
          city: body.city || null,
          state: body.state || null,
          stateCode: body.stateCode || null,
          paymentTermsDays: Math.round(num(body.paymentTermsDays, 30, 'paymentTermsDays')),
          status: body.status || 'ACTIVE',
        },
      })
      await logAudit(tx as any, {
        companyId,
        userName: body.userName,
        action: 'CREATE',
        entity: 'Supplier',
        entityId: created.id,
        details: `${code} — ${name}`,
      })
      return created
    })
    return ok(supplier, 'Supplier created')
  } catch (e) {
    return handleError(e)
  }
}
