import { db } from '@/lib/db'
import { createParty } from '@/lib/services/parties'
import { requireWrite, ok, handleError, companyRequired } from '@/lib/erp-helpers'


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
        include: { supplier: { select: { id: true, code: true } } }, // linked supplier → "Both"
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
    // Code is optional: blank → next free C-0001 style code.
    const customer = await db.$transaction((tx) => createParty(tx, companyId, 'customer', body, { userName: body.userName }))
    return ok(customer, 'Customer created')
  } catch (e) {
    return handleError(e)
  }
}
