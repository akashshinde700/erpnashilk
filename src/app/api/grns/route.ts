import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import {
  ok, handleError, companyRequired, nextDocNumber, logAudit, ApiError, r2, requireWrite,
} from '@/lib/erp-helpers'
import { emitEvent } from '@/lib/emit-event'
import { parseSerials, joinSerials } from '@/lib/batches'
import { qcResultAddsUp } from '@/lib/grn-qc'
import { outstandingQty, poLineProgress, type PoLineProgress } from '@/lib/po-receipt'

// prisma 6.x generated delegates are not structurally assignable to the shared helpers' minimal
// tx types — intersect once and cast the transaction client at the boundary.
type HelperTx = Prisma.TransactionClient & Parameters<typeof nextDocNumber>[0] & Parameters<typeof logAudit>[0]

// Line items carry only itemId (no Item relation in schema) — attach {code,name,uom} for the UI.
async function attachItemInfo<T extends { items: { itemId: string }[] }>(companyId: string, docs: T[]) {
  const ids = Array.from(new Set(docs.flatMap((d) => d.items.map((i) => i.itemId))))
  const items = ids.length
    ? await db.item.findMany({ where: { companyId, id: { in: ids } }, select: { id: true, code: true, name: true, uom: true, batchTracked: true, trackSerial: true } })
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
  batchNo?: string | null; mfgDate?: string | null; expiryDate?: string | null; serials?: string | string[] | null
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
    const inspections = await db.qcInspection.findMany({
      where: { companyId, refType: 'GRN', refId: { in: rows.filter((r) => r.status !== 'POSTED').map((r) => r.id) } },
      select: { refId: true, status: true, qtyChecked: true, qtyAccepted: true, qtyRejected: true },
    })
    const count = (id: string, test: (q: (typeof inspections)[number]) => boolean) => inspections.filter((q) => q.refId === id && test(q)).length
    const withItems = await attachItemInfo(companyId, rows)
    return ok({
      items: withItems.map((r) => ({
        ...r,
        qcPending: count(r.id, (q) => q.status === 'PENDING'),
        qcUnreconciled: count(r.id, (q) => !qcResultAddsUp(q)),
      })),
      total: rows.length,
    })
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

      // PO item receivedQty is only incremented at GRN POST — so also count unposted GRN qty
      // of this PO when guarding against over-receipt.
      const pendingGrnItems = await tx.grnItem.findMany({
        where: { grn: { poId: po.id, status: { in: ['PENDING_QC', 'QC_COMPLETED'] } } },
        select: { poItemId: true, receivedQty: true },
      })
      const pendingByPoItem = new Map<string, number>()
      for (const gi of pendingGrnItems) {
        if (!gi.poItemId) continue
        pendingByPoItem.set(gi.poItemId, r2((pendingByPoItem.get(gi.poItemId) || 0) + gi.receivedQty))
      }
      const batchByPoItem = new Map<string, number>()
      const progress = await poLineProgress(tx, po.items.map((p) => p.id))

      for (const l of lines) {
        if (!l.poItemId) throw new ApiError('poItemId is required on every line', 400)
        if (!l.itemId) throw new ApiError('itemId is required on every line', 400)
        const received = Number(l.receivedQty) || 0
        if (received <= 0) throw new ApiError('Received qty must be greater than 0 on every line', 400)
        const poItem = po.items.find((p) => p.id === l.poItemId)
        if (!poItem) throw new ApiError('poItemId does not belong to this purchase order', 400)
        if (poItem.itemId !== l.itemId) throw new ApiError('itemId does not match the selected PO line', 400)
        const pending = pendingByPoItem.get(l.poItemId) || 0
        const batch = batchByPoItem.get(l.poItemId) || 0
        // Replacements for rejected material fit here: only accepted and formally closed qty uses up the order
        const outstanding = outstandingQty(poItem.qty, progress.get(poItem.id) as PoLineProgress)
        if (r2(pending + batch + received) > r2(outstanding + 0.01)) {
          throw new ApiError(`Received qty exceeds what is outstanding on the order (${r2(Math.max(0, outstanding - pending - batch))})`, 400)
        }
        batchByPoItem.set(l.poItemId, r2(batch + received))
      }

      // Batch / serial details per line (only kept for batch- / serial-tracked items; stock moves at Post)
      const lineItemIds = Array.from(new Set(lines.map((l) => String(l.itemId))))
      const flagRows = await tx.item.findMany({
        where: { companyId, id: { in: lineItemIds } },
        select: { id: true, code: true, name: true, batchTracked: true, trackSerial: true },
      })
      const flags = new Map(flagRows.map((f) => [f.id, f]))
      const tracking = lines.map((l) => {
        const f = flags.get(String(l.itemId))
        const received = r2(Number(l.receivedQty) || 0)
        const batchNo = f?.batchTracked && l.batchNo ? String(l.batchNo).trim() || null : null
        const mfgDate = f?.batchTracked ? toDate(l.mfgDate) : null
        const expiryDate = f?.batchTracked ? toDate(l.expiryDate) : null
        if (mfgDate && expiryDate && expiryDate < mfgDate) throw new ApiError(`Expiry date is before the mfg date for ${f?.code}`, 400)
        const serials = f?.trackSerial ? parseSerials(l.serials) : []
        if (f?.trackSerial) {
          if (Math.abs(received - Math.round(received)) > 0.0005) throw new ApiError(`${f.code} ${f.name} is serial-tracked — received qty must be a whole number`, 400)
          if (serials.length !== Math.round(received)) {
            throw new ApiError(`${f.code} ${f.name} is serial-tracked — enter exactly ${Math.round(received)} serial no(s) for the received qty (got ${serials.length})`, 400)
          }
        }
        return { batchNo, mfgDate, expiryDate, serials: joinSerials(serials) }
      })

      const number = await nextDocNumber(tx, companyId, 'GRN', date)
      const created = await tx.grn.create({
        data: {
          companyId,
          number,
          poId: po.id,
          warehouseId: body.warehouseId,
          date,
          supplierInvNo: body.supplierInvNo || null,
          supplierInvDate: toDate(body.supplierInvDate),
          supplierChallanNo: body.supplierChallanNo ? String(body.supplierChallanNo).trim() || null : null,
          vehicleNo: body.vehicleNo ? String(body.vehicleNo).trim().toUpperCase() || null : null,
          status: 'PENDING_QC',
          notes: body.notes || null,
          items: {
            create: lines.map((l, idx) => {
              const poItem = po.items.find((p) => p.id === l.poItemId)
              return {
                ...tracking[idx],
                poItemId: l.poItemId as string,
                itemId: l.itemId as string,
                orderedQty: l.orderedQty != null && Number(l.orderedQty) > 0 ? r2(Number(l.orderedQty)) : poItem ? poItem.qty : 0,
                receivedQty: r2(Number(l.receivedQty)),
                // Accepted / rejected qty come only from the line's QC inspection
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
            grnItemId: it.id,
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
