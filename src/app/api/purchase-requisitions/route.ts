import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import {
  ok, handleError, companyRequired, nextDocNumber, logAudit, ApiError, r2,
} from '@/lib/erp-helpers'

// prisma 6.x generated delegates are not structurally assignable to the shared helpers' minimal
// tx types — intersect once and cast the transaction client at the boundary.
type HelperTx = Prisma.TransactionClient & Parameters<typeof nextDocNumber>[0] & Parameters<typeof logAudit>[0]

// Line items carry only itemId (no Item relation in schema) — attach {code,name,uom} for the UI.
async function attachItemInfo<T extends { items: { itemId: string }[] }>(companyId: string, docs: T[]) {
  const ids = Array.from(new Set(docs.flatMap((d) => d.items.map((i) => i.itemId))))
  const items = ids.length
    ? await db.item.findMany({ where: { companyId, id: { in: ids } }, select: { id: true, code: true, name: true, uom: true } })
    : []
  const map = new Map(items.map((i) => [i.id, i]))
  return docs.map((d) => ({ ...d, items: d.items.map((i) => ({ ...i, item: map.get(i.itemId) || null })) }))
}

function toDate(v: unknown): Date | null {
  if (!v) return null
  const d = new Date(String(v))
  return Number.isNaN(d.getTime()) ? null : d
}

interface LineInput { itemId?: string; qty?: number | string; notes?: string }

async function validateLines(companyId: string, lines: LineInput[]) {
  if (!lines.length) throw new ApiError('At least one item line is required', 400)
  for (const l of lines) {
    if (!l.itemId) throw new ApiError('itemId is required on every line', 400)
    if (!(Number(l.qty) > 0)) throw new ApiError('Line qty must be greater than 0', 400)
  }
  const ids = Array.from(new Set(lines.map((l) => l.itemId as string)))
  const count = await db.item.count({ where: { companyId, id: { in: ids } } })
  if (count !== ids.length) throw new ApiError('One or more itemId values are invalid for this company', 400)
}

// ============================== GET /api/purchase-requisitions ==============================
export async function GET(req: Request) {
  try {
    const companyId = await companyRequired(req)
    const { searchParams } = new URL(req.url)
    const q = searchParams.get('q') || ''
    const status = searchParams.get('status') || ''
    const where: Prisma.PurchaseRequisitionWhereInput = { companyId }
    if (status) where.status = status
    if (q) {
      where.OR = [
        { number: { contains: q } },
        { department: { contains: q } },
        { raisedBy: { contains: q } },
        { notes: { contains: q } },
      ]
    }
    const rows = await db.purchaseRequisition.findMany({ where, orderBy: { date: 'desc' }, include: { items: true } })
    return ok({ items: await attachItemInfo(companyId, rows), total: rows.length })
  } catch (e) {
    return handleError(e)
  }
}

// ============================== POST /api/purchase-requisitions ==============================
export async function POST(req: Request) {
  try {
    const body = await req.json()
    const companyId = await companyRequired(req, body.companyId)
    const lines: LineInput[] = Array.isArray(body.items) ? body.items : []
    await validateLines(companyId, lines)
    const date = toDate(body.date) || new Date()

    const pr = await db.$transaction(async (txRaw) => {
      const tx = txRaw as HelperTx
      const number = await nextDocNumber(tx, companyId, 'PR', date)
      const created = await tx.purchaseRequisition.create({
        data: {
          companyId,
          number,
          date,
          requiredBy: toDate(body.requiredBy),
          department: body.department || null,
          raisedBy: body.raisedBy || null,
          status: 'PENDING',
          notes: body.notes || null,
          items: {
            create: lines.map((l) => ({ itemId: l.itemId as string, qty: r2(Number(l.qty)), notes: l.notes || null })),
          },
        },
        include: { items: true },
      })
      await logAudit(tx, {
        companyId, userName: body.userName, action: 'CREATE', entity: 'PurchaseRequisition',
        entityId: created.id, details: `Created ${number} with ${lines.length} line(s)`,
      })
      return created
    })
    const [row] = await attachItemInfo(companyId, [pr])
    return ok(row, 'Purchase requisition created')
  } catch (e) {
    return handleError(e)
  }
}
