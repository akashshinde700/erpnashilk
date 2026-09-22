import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import {
  ok, handleError, companyRequired, nextDocNumber, logAudit, ApiError, r2, requireWrite,
} from '@/lib/erp-helpers'
import { emitEvent } from '@/lib/emit-event'

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

interface GrnLineInput {
  poItemId?: string; itemId?: string
  orderedQty?: number | string; receivedQty?: number | string
  acceptedQty?: number | string; rejectedQty?: number | string
}

// ============================== GET /api/grns ==============================
export async function GET(req: Request) {
  try {
    const companyId = await companyRequired(req)
    const { searchParams } = new URL(req.url)
    const poId = searchParams.get('poId') || ''
    const status = searchParams.get('status') || ''
    const q = searchParams.get('q') || ''
    const where: Prisma.GrnWhereInput = { companyId }
    if (poId) where.poId = poId
    if (status) where.status = status
    if (q) {
      where.OR = [
        { number: { contains: q } },
        { supplierInvNo: { contains: q } },
        { po: { is: { number: { contains: q } } } },
      ]
    }
    const rows = await db.grn.findMany({
      where,
      orderBy: { date: 'desc' },
      include: {
        po: { select: { id: true, number: true, supplier: { select: { id: true, name: true } } } },
        items: true,
      },
    })
    return ok({ items: await attachItemInfo(companyId, rows), total: rows.length })
  } catch (e) {
    return handleError(e)
  }
}

// ============================== POST /api/grns ==============================
export async function POST(req: Request) {
  try {
    requireWrite(req, 'grns')
    const body = await req.json()
    const companyId = await companyRequired(req, body.companyId)
    if (!body.poId) throw new ApiError('poId is required', 400)
    if (!body.warehouseId) throw new ApiError('warehouseId is required', 400)
    const lines: GrnLineInput[] = Array.isArray(body.items) ? body.items : []
    if (!lines.length) throw new ApiError('At least one receipt line is required', 400)
    const date = toDate(body.date) || new Date()

    const grn = await db.$transaction(async (txRaw) => {
      const tx = txRaw as HelperTx
      const po = await tx.purchaseOrder.findFirst({ where: { id: body.poId, companyId }, include: { items: true } })
      if (!po) throw new ApiError('Purchase order not found', 404)
      if (!['APPROVED', 'PARTIALLY_RECEIVED'].includes(po.status)) {
        throw new ApiError(`GRN can only be created against an APPROVED or PARTIALLY_RECEIVED PO (current: ${po.status})`, 400)
      }
      const warehouse = await tx.warehouse.findFirst({ where: { id: body.warehouseId, companyId } })
      if (!warehouse) throw new ApiError('Warehouse not found', 404)

      // PO item receivedQty is only incremented at GRN POST — so also count unposted (PENDING_QC) GRN qty
      // of this PO when guarding against over-receipt.
      const pendingGrnItems = await tx.grnItem.findMany({
        where: { grn: { poId: po.id, status: 'PENDING_QC' } },
        select: { poItemId: true, receivedQty: true },
      })
      const pendingByPoItem = new Map<string, number>()
      for (const gi of pendingGrnItems) {
        if (!gi.poItemId) continue
        pendingByPoItem.set(gi.poItemId, r2((pendingByPoItem.get(gi.poItemId) || 0) + gi.receivedQty))
      }
      const batchByPoItem = new Map<string, number>()

      for (const l of lines) {
        if (!l.poItemId) throw new ApiError('poItemId is required on every line', 400)
        if (!l.itemId) throw new ApiError('itemId is required on every line', 400)
        const received = Number(l.receivedQty) || 0
        if (received <= 0) throw new ApiError('Received qty must be greater than 0 on every line', 400)
        const accepted = Number(l.acceptedQty) || 0
        const rejected = Number(l.rejectedQty) || 0
        if (accepted < 0 || rejected < 0) throw new ApiError('Accepted/rejected qty cannot be negative', 400)
        if (accepted + rejected > received + 0.01) {
          throw new ApiError('Accepted + rejected qty cannot exceed received qty', 400)
        }
        const poItem = po.items.find((p) => p.id === l.poItemId)
        if (!poItem) throw new ApiError('poItemId does not belong to this purchase order', 400)
        if (poItem.itemId !== l.itemId) throw new ApiError('itemId does not match the selected PO line', 400)
        const pending = pendingByPoItem.get(l.poItemId) || 0
        const batch = batchByPoItem.get(l.poItemId) || 0
        if (r2(poItem.receivedQty + pending + batch + received) > r2(poItem.qty + 0.01)) {
          throw new ApiError('Received qty exceeds ordered', 400)
        }
        batchByPoItem.set(l.poItemId, r2(batch + received))
      }

      const number = await nextDocNumber(tx, companyId, 'GRN', date)
      const created = await tx.grn.create({
        data: {
          companyId,
          number,
          poId: po.id,
          warehouseId: body.warehouseId,
          date,
          supplierInvNo: body.supplierInvNo || null,
          status: 'PENDING_QC',
          notes: body.notes || null,
          items: {
            create: lines.map((l) => {
              const poItem = po.items.find((p) => p.id === l.poItemId)
              return {
                poItemId: l.poItemId as string,
                itemId: l.itemId as string,
                orderedQty: l.orderedQty != null && Number(l.orderedQty) > 0 ? r2(Number(l.orderedQty)) : poItem ? poItem.qty : 0,
                receivedQty: r2(Number(l.receivedQty)),
                acceptedQty: r2(Number(l.acceptedQty) || 0),
                rejectedQty: r2(Number(l.rejectedQty) || 0),
              }
            }),
          },
        },
        include: { items: true },
      })

      // Auto-create one PENDING INCOMING inspection per receipt line
      for (const it of created.items) {
        await tx.qcInspection.create({
          data: {
            companyId,
            number: await nextDocNumber(tx, companyId, 'QC', date),
            type: 'INCOMING',
            refType: 'GRN',
            refId: created.id,
            refNumber: created.number,
            itemId: it.itemId,
            qtyChecked: it.receivedQty,
            status: 'PENDING',
            inspector: 'pending',
            date,
            parameters: JSON.stringify([
              { name: 'Visual inspection', expected: 'OK', actual: '-', ok: true },
              { name: 'Dimension check', expected: 'OK', actual: '-', ok: true },
            ]),
          },
        })
      }

      await logAudit(tx, {
        companyId, userName: body.userName, action: 'CREATE', entity: 'Grn',
        entityId: created.id, details: `Created ${number} against ${po.number} (${created.items.length} lines)`,
      })
      return created
    })
    void emitEvent({ companyId, title: 'GRN created', message: `${grn.number} — QC pending`, topic: 'quality' })
    const [row] = await attachItemInfo(companyId, [grn])
    return ok(row, 'GRN created — pending QC')
  } catch (e) {
    return handleError(e)
  }
}
