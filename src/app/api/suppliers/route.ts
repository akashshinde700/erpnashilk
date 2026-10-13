import { db } from '@/lib/db'
import { nextPartyCode, partyData } from '@/lib/party'
import { requireWrite, ok, handleError, companyRequired, ApiError, logAudit } from '@/lib/erp-helpers'


// ============================== GET /api/suppliers?q=&status=&page=&pageSize= ==============================
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
      db.supplier.findMany({
        where,
        include: { customer: { select: { id: true, code: true } } }, // linked customer → "Both"
        orderBy: { code: 'asc' },
        ...(page >= 1 ? { skip: (page - 1) * pageSize, take: pageSize } : {}),
      }),
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
    requireWrite(req, 'suppliers')
    const body = await req.json().catch(() => ({}))
    const companyId = await companyRequired(req, body.companyId)
    const name = String(body.name || '').trim()
    if (!name) throw new ApiError('Party name is required', 400)
    // Code is optional: blank → next free S-0001 style code.
    const code = String(body.code || '').trim() || (await nextPartyCode(companyId, 'supplier'))

    const supplier = await db.$transaction(async (tx) => {
      const created = await tx.supplier.create({
        data: {
          companyId,
          code,
          name,
          ...partyData(body, 'create'),
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
