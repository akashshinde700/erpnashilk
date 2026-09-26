import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import {
  ok, handleError, companyRequired, nextDocNumber, computeGst, isInterStateParty, logAudit, ApiError, r2, requireWrite,
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

interface PoLineInput { itemId?: string; qty?: number | string; rate?: number | string; gstRate?: number | string }

function validateLines(lines: PoLineInput[]) {
  if (!lines.length) throw new ApiError('At least one item line is required', 400)
  for (const l of lines) {
    if (!l.itemId) throw new ApiError('itemId is required on every line', 400)
    if (!(Number(l.qty) > 0)) throw new ApiError('Line qty must be greater than 0', 400)
    if (!(Number(l.rate) >= 0)) throw new ApiError('Line rate must be 0 or more', 400)
  }
}

// ============================== GET /api/purchase-orders ==============================
export async function GET(req: Request) {
  try {
    const companyId = await companyRequired(req)
    const { searchParams } = new URL(req.url)
    const status = searchParams.get('status') || ''
    const q = searchParams.get('q') || ''
    const where: Prisma.PurchaseOrderWhereInput = { companyId }
    if (status) where.status = status
    if (q) {
      where.OR = [
        { number: { contains: q } },
        { notes: { contains: q } },
        { supplier: { is: { name: { contains: q } } } },
      ]
    }
    const rows = await db.purchaseOrder.findMany({
      where,
      orderBy: { orderDate: 'desc' },
      include: {
        supplier: { select: { id: true, code: true, name: true, gstin: true, state: true, stateCode: true } },
        items: true,
      },
    })
    return ok({ items: await attachItemInfo(companyId, rows), total: rows.length })
  } catch (e) {
    return handleError(e)
  }
}

// ============================== POST /api/purchase-orders ==============================
export async function POST(req: Request) {
  try {
    requireWrite(req, 'purchase-orders')
    const body = await req.json()
    const companyId = await companyRequired(req, body.companyId)
    if (!body.supplierId) throw new ApiError('supplierId is required', 400)
    const lines: PoLineInput[] = Array.isArray(body.items) ? body.items : []
    validateLines(lines)

    const ids = Array.from(new Set(lines.map((l) => l.itemId as string)))
    const itemCount = await db.item.count({ where: { companyId, id: { in: ids } } })
    if (itemCount !== ids.length) throw new ApiError('One or more itemId values are invalid for this company', 400)

    const supplier = await db.supplier.findFirst({ where: { id: body.supplierId, companyId } })
    if (!supplier) throw new ApiError('Supplier not found', 404)
    const company = await db.company.findUnique({ where: { id: companyId } })
    if (!company) throw new ApiError('Company not found', 404)

    const interState = isInterStateParty(company ?? {}, supplier ?? {})
    const date = toDate(body.orderDate) || new Date()

    const po = await db.$transaction(async (txRaw) => {
      const tx = txRaw as HelperTx
      if (body.prId) {
        const pr = await tx.purchaseRequisition.findFirst({ where: { id: body.prId, companyId } })
        if (!pr) throw new ApiError('Purchase requisition not found', 404)
        if (!['PENDING', 'APPROVED'].includes(pr.status)) {
          throw new ApiError(`PR ${pr.number} is ${pr.status} and cannot be converted to a PO`, 400)
        }
      }

      const taxLines = lines.map((l) => ({ qty: r2(Number(l.qty)), rate: r2(Number(l.rate)), gstRate: Number(l.gstRate ?? 18) }))
      const totals = computeGst(taxLines, interState)
      const number = await nextDocNumber(tx, companyId, 'PO', date)

      const created = await tx.purchaseOrder.create({
        data: {
          companyId,
          number,
          prId: body.prId || null,
          supplierId: supplier.id,
          orderDate: date,
          expectedDate: toDate(body.expectedDate),
          status: 'PENDING_APPROVAL',
          subtotal: totals.subtotal,
          discountTotal: totals.discountTotal,
          cgst: totals.cgst,
          sgst: totals.sgst,
          igst: totals.igst,
          grandTotal: totals.grandTotal,
          notes: body.notes || null,
          items: {
            create: totals.computed.map((c, idx) => ({
              itemId: lines[idx].itemId as string,
              qty: c.qty,
              rate: c.rate,
              gstRate: c.gstRate,
              lineTotal: r2(c.taxable),
            })),
          },
        },
        include: { items: true },
      })

      if (body.prId) {
        await tx.purchaseRequisition.update({ where: { id: body.prId }, data: { status: 'CONVERTED' } })
      }

      await logAudit(tx, {
        companyId, userName: body.userName, action: 'CREATE', entity: 'PurchaseOrder',
        entityId: created.id, details: `Created ${number} for ${supplier.name} (${lines.length} lines)`,
      })
      return created
    })
    const [row] = await attachItemInfo(companyId, [po])
    return ok(row, 'Purchase order created')
  } catch (e) {
    return handleError(e)
  }
}
