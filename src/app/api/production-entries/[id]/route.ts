import { db } from '@/lib/db'
import { ok, fail, handleError, companyRequired, ApiError } from '@/lib/erp-helpers'

type Ctx = { params: Promise<{ id: string }> }

// GET /api/production-entries/[id]?companyId=
export async function GET(req: Request, { params }: Ctx) {
  try {
    const companyId = await companyRequired(req)
    const { id } = await params

    const entry = await db.productionEntry.findFirst({
      where: { id, companyId },
      include: {
        workOrder: {
          select: {
            id: true,
            number: true,
            status: true,
            plannedQty: true,
            producedQty: true,
            rejectedQty: true,
            scrapQty: true,
            itemId: true,
          },
        },
      },
    })
    if (!entry) throw new ApiError('Production entry not found', 404)

    // WorkOrder has no item relation in the schema — join in JS
    const item = await db.item.findUnique({
      where: { id: entry.workOrder.itemId },
      select: { id: true, code: true, name: true, uom: true },
    })

    return ok({
      ...entry,
      workOrder: { ...entry.workOrder, item },
    })
  } catch (e) {
    return handleError(e)
  }
}

// POST/PATCH/DELETE not allowed — production entries are posted and immutable
export async function POST() {
  return fail('Production entries are immutable once posted', 405)
}

export async function PATCH() {
  return fail('Production entries are immutable once posted', 400)
}

export async function DELETE() {
  return fail('Production entries cannot be deleted', 400)
}
