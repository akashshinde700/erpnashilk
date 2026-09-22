import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import {
  ok, handleError, companyRequired, nextDocNumber, logAudit, ApiError, r2, requireWrite,
} from '@/lib/erp-helpers'

// prisma 6.x generated delegates are not structurally assignable to the shared helpers' minimal
// tx types — intersect once and cast the transaction client at the boundary.
type HelperTx = Prisma.TransactionClient & Parameters<typeof nextDocNumber>[0] & Parameters<typeof logAudit>[0]

// QcInspection carries only itemId (no Item relation in schema) — attach {code,name,uom} for the UI.
async function attachItem<T extends { itemId: string }>(companyId: string, rows: T[]) {
  const ids = Array.from(new Set(rows.map((r) => r.itemId)))
  const items = ids.length
    ? await db.item.findMany({ where: { companyId, id: { in: ids } }, select: { id: true, code: true, name: true, uom: true } })
    : []
  const map = new Map(items.map((i) => [i.id, i]))
  return rows.map((r) => ({ ...r, item: map.get(r.itemId) || null }))
}

function toDate(v: unknown): Date | null {
  if (!v) return null
  const d = new Date(String(v))
  return Number.isNaN(d.getTime()) ? null : d
}

// ============================== GET /api/qc-inspections ==============================
export async function GET(req: Request) {
  try {
    const companyId = await companyRequired(req)
    const { searchParams } = new URL(req.url)
    const type = searchParams.get('type') || ''
    const status = searchParams.get('status') || ''
    const itemId = searchParams.get('itemId') || ''
    const q = searchParams.get('q') || ''
    const where: Prisma.QcInspectionWhereInput = { companyId }
    if (type) where.type = type
    if (status) where.status = status
    if (itemId) where.itemId = itemId
    if (q) {
      where.OR = [
        { number: { contains: q } },
        { refNumber: { contains: q } },
        { inspector: { contains: q } },
      ]
    }
    const rows = await db.qcInspection.findMany({ where, orderBy: { date: 'desc' }, take: 300 })
    return ok({ items: await attachItem(companyId, rows), total: rows.length })
  } catch (e) {
    return handleError(e)
  }
}

// ============================== POST /api/qc-inspections (manual) ==============================
export async function POST(req: Request) {
  try {
    requireWrite(req, 'qc-inspections')
    const body = await req.json()
    const companyId = await companyRequired(req, body.companyId)
    const type = String(body.type || '')
    if (!['INCOMING', 'IN_PROCESS', 'FINAL'].includes(type)) {
      throw new ApiError('type must be INCOMING, IN_PROCESS or FINAL', 400)
    }
    if (!body.itemId) throw new ApiError('itemId is required', 400)
    if (!(Number(body.qtyChecked) > 0)) throw new ApiError('qtyChecked must be greater than 0', 400)
    const item = await db.item.findFirst({ where: { id: body.itemId, companyId } })
    if (!item) throw new ApiError('Item not found', 404)
    const date = toDate(body.date) || new Date()

    const qc = await db.$transaction(async (txRaw) => {
      const tx = txRaw as HelperTx
      const number = await nextDocNumber(tx, companyId, 'QC', date)
      const created = await tx.qcInspection.create({
        data: {
          companyId,
          number,
          type,
          refType: body.refType || 'MANUAL',
          refId: body.refId || 'MANUAL',
          refNumber: body.refNumber || null,
          itemId: body.itemId,
          qtyChecked: r2(Number(body.qtyChecked)),
          status: 'PENDING',
          inspector: body.inspector || null,
          date,
          remarks: body.remarks || null,
        },
      })
      await logAudit(tx, {
        companyId, userName: body.userName, action: 'CREATE', entity: 'QcInspection',
        entityId: created.id, details: `Created ${number} (${type}) for ${item.code} — qty ${created.qtyChecked}`,
      })
      return created
    })
    return ok({ ...qc, item }, 'Inspection created')
  } catch (e) {
    return handleError(e)
  }
}
