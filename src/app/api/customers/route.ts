import { db } from '@/lib/db'
import { requireWrite, ok, handleError, companyRequired, ApiError, logAudit } from '@/lib/erp-helpers'

function num(v: unknown, def = 0, field = 'value'): number {
  if (v === undefined || v === null || v === '') return def
  const n = Number(v)
  if (Number.isNaN(n)) throw new ApiError(`${field} must be a number`, 400)
  return n
}

// ============================== GET /api/customers?q=&status=&page=&pageSize= ==============================
export async function GET(req: Request) {
  try {
    const companyId = await companyRequired(req)
    const { searchParams } = new URL(req.url)
    const q = (searchParams.get('q') || '').trim()
    const status = searchParams.get('status') || ''
    // Server-side pagination: page is 1-based; pageSize defaults to 200 (cap 500).
    // Only an explicit page >= 1 slices the findMany — without it the response
    // stays byte-compatible (all matching rows, accurate total).
    const page = Math.max(0, Number.parseInt(searchParams.get('page') || '', 10) || 0)
    const pageSize = Math.min(Number.parseInt(searchParams.get('pageSize') || '', 10) || 200, 500)
    const where = {
      companyId,
      ...(q ? { OR: [{ code: { contains: q } }, { name: { contains: q } }] } : {}),
      ...(status ? { status } : {}),
    }
    const [items, total] = await Promise.all([
      db.customer.findMany({
        where,
        orderBy: { code: 'asc' },
        ...(page >= 1 ? { skip: (page - 1) * pageSize, take: pageSize } : {}),
      }),
      db.customer.count({ where }),
    ])
    return ok({ items, total })
  } catch (e) {
    return handleError(e)
  }
}

// ============================== POST /api/customers ==============================
export async function POST(req: Request) {
  try {
    requireWrite(req, 'customers')
    const body = await req.json().catch(() => ({}))
    const companyId = await companyRequired(req, body.companyId)
    const code = String(body.code || '').trim()
    const name = String(body.name || '').trim()
    if (!code || !name) throw new ApiError('code and name are required', 400)

    const customer = await db.$transaction(async (tx) => {
      const created = await tx.customer.create({
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
          creditLimit: num(body.creditLimit, 0, 'creditLimit'),
          status: body.status || 'ACTIVE',
        },
      })
      await logAudit(tx as any, {
        companyId,
        userName: body.userName,
        action: 'CREATE',
        entity: 'Customer',
        entityId: created.id,
        details: `${code} — ${name}`,
      })
      return created
    })
    return ok(customer, 'Customer created')
  } catch (e) {
    return handleError(e)
  }
}
