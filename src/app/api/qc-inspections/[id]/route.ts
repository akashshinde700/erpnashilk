import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import {
  ok, handleError, companyRequired, logAudit, notify, ApiError, r2,
} from '@/lib/erp-helpers'

// prisma 6.x generated delegates are not structurally assignable to the shared helpers' minimal
// tx types — intersect once and cast the transaction client at the boundary.
type HelperTx = Prisma.TransactionClient & Parameters<typeof logAudit>[0] & Parameters<typeof notify>[0]

async function attachItem<T extends { itemId: string }>(companyId: string, rows: T[]) {
  const ids = Array.from(new Set(rows.map((r) => r.itemId)))
  const items = ids.length
    ? await db.item.findMany({ where: { companyId, id: { in: ids } }, select: { id: true, code: true, name: true, uom: true } })
    : []
  const map = new Map(items.map((i) => [i.id, i]))
  return rows.map((r) => ({ ...r, item: map.get(r.itemId) || null }))
}

async function findInspection(id: string, companyId: string) {
  const qc = await db.qcInspection.findFirst({ where: { id, companyId } })
  if (!qc) throw new ApiError('Inspection not found', 404)
  return qc
}

// ============================== GET /api/qc-inspections/[id] ==============================
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const companyId = await companyRequired(req)
    const qc = await findInspection(id, companyId)
    const [row] = await attachItem(companyId, [qc])
    return ok(row)
  } catch (e) {
    return handleError(e)
  }
}

// ============================== PATCH /api/qc-inspections/[id] — submit result ==============================
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const body = await req.json()
    const companyId = await companyRequired(req, body.companyId)
    const qc = await findInspection(id, companyId)

    const status = String(body.status || '')
    if (!['PASSED', 'FAILED', 'PARTIAL'].includes(status)) {
      throw new ApiError('status must be PASSED, FAILED or PARTIAL', 400)
    }
    const qtyAccepted = r2(Number(body.qtyAccepted) || 0)
    const qtyRejected = r2(Number(body.qtyRejected) || 0)
    if (qtyAccepted < 0 || qtyRejected < 0) throw new ApiError('Accepted/rejected qty cannot be negative', 400)
    if (qtyAccepted + qtyRejected <= 0) throw new ApiError('Provide accepted and/or rejected qty', 400)
    if (qtyAccepted + qtyRejected > r2(qc.qtyChecked) + 0.01) {
      throw new ApiError('Accepted + rejected qty cannot exceed checked qty', 400)
    }

    let parameters = qc.parameters
    if (body.parameters !== undefined && body.parameters !== null) {
      parameters = typeof body.parameters === 'string' ? body.parameters : JSON.stringify(body.parameters)
    }
    const remarks = body.remarks !== undefined ? (body.remarks || null) : qc.remarks
    const inspector = body.inspector !== undefined ? (body.inspector || null) : qc.inspector

    const updated = await db.$transaction(async (txRaw) => {
      const tx = txRaw as HelperTx
      const u = await tx.qcInspection.update({
        where: { id: qc.id },
        data: { qtyAccepted, qtyRejected, status, parameters, remarks, inspector },
      })

      // GRN-linked inspection → propagate result to ALL matching GrnItem rows of that GRN
      if (qc.refType === 'GRN' && qc.refId) {
        await tx.grnItem.updateMany({
          where: { grnId: qc.refId, itemId: qc.itemId },
          data: { qcStatus: status },
        })
      }

      if (status === 'FAILED') {
        await notify(tx, {
          companyId,
          title: `QC Failed: inspection ${qc.number}`,
          message: `${qtyRejected} of ${qc.qtyChecked} qty rejected${qc.refNumber ? ` (${qc.refNumber})` : ''}${remarks ? ` — ${remarks}` : ''}`,
          level: 'CRITICAL',
        })
      } else if (status === 'PASSED') {
        await notify(tx, {
          companyId,
          title: `QC Passed: inspection ${qc.number}`,
          message: `${qtyAccepted} of ${qc.qtyChecked} qty accepted${qc.refNumber ? ` (${qc.refNumber})` : ''}`,
          level: 'INFO',
        })
      }

      await logAudit(tx, {
        companyId, userName: body.userName, action: 'UPDATE', entity: 'QcInspection',
        entityId: qc.id,
        details: `${qc.number} → ${status} (accepted ${qtyAccepted} / rejected ${qtyRejected})`,
      })
      return u
    })
    const [row] = await attachItem(companyId, [updated])
    return ok(row, `Inspection ${status.toLowerCase()}`)
  } catch (e) {
    return handleError(e)
  }
}
