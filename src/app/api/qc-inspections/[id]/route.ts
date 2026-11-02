import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import {
  ok, handleError, companyRequired, logAudit, notify, ApiError, requireWrite, claimStatus, getActor,
} from '@/lib/erp-helpers'
import { QC_TX, matchInspectionsToLines, qcComplete, readQcResult, serialsAfterResult } from '@/lib/grn-qc'

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

/**
 * Copies the result of a GRN inspection to its own line (under the GRN row lock). When this was the last pending
 * inspection, the GRN becomes QC_COMPLETED.
 */
async function applyToGrn(tx: HelperTx, companyId: string, qc: { id: string; number: string; refId: string; refNumber: string | null }, result: { qtyAccepted: number; qtyRejected: number; status: string }, acceptedSerials: unknown, userName?: string) {
  const grn = await tx.grn.findFirst({ where: { id: qc.refId, companyId }, include: { items: true } })
  if (!grn) throw new ApiError('The GRN of this inspection was not found', 404)
  const inspections = await tx.qcInspection.findMany({ where: { companyId, refType: 'GRN', refId: grn.id } })
  const { byLine } = matchInspectionsToLines(grn.items, inspections)
  const line = grn.items.find((l) => byLine.get(l.id)?.id === qc.id)
  if (!line) throw new ApiError(`${qc.number} cannot be matched to one line of ${grn.number} — delete the GRN and receive it again`, 409, 'QC_LINE_UNKNOWN')

  const item = await tx.item.findFirst({ where: { id: line.itemId, companyId }, select: { code: true, name: true, trackSerial: true } })
  const serials = item?.trackSerial ? serialsAfterResult(item, line.serials, result.qtyAccepted, acceptedSerials) : line.serials

  await tx.qcInspection.update({ where: { id: qc.id }, data: { grnItemId: line.id } })
  await tx.grnItem.update({
    where: { id: line.id },
    data: { acceptedQty: result.qtyAccepted, rejectedQty: result.qtyRejected, qcStatus: result.status, serials },
  })
  if (qcComplete(inspections.filter((i) => i.id !== qc.id))) {
    await tx.grn.update({ where: { id: grn.id }, data: { status: 'QC_COMPLETED' } })
    await logAudit(tx, {
      companyId, userName, action: 'UPDATE', entity: 'Grn', entityId: grn.id,
      details: `${grn.number} → QC_COMPLETED, all inspections have results`,
    })
  }
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
    const corrections = await db.qcCorrection.findMany({ where: { companyId, inspectionId: qc.id }, orderBy: { createdAt: 'asc' } })
    return ok({ ...row, corrections })
  } catch (e) {
    return handleError(e)
  }
}

// ============================== PATCH /api/qc-inspections/[id] — submit result ==============================
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireWrite(req, 'qc-inspections')
    const { id } = await params
    const body = await req.json()
    const companyId = await companyRequired(req, body.companyId)
    const qc = await findInspection(id, companyId)

    if (qc.status !== 'PENDING') throw new ApiError(`Result already recorded for this inspection (current: ${qc.status})`, 400)
    const { qtyAccepted, qtyRejected, status } = readQcResult(body, qc.qtyChecked)

    let parameters = qc.parameters
    if (body.parameters !== undefined && body.parameters !== null) {
      parameters = typeof body.parameters === 'string' ? body.parameters : JSON.stringify(body.parameters)
    }
    const remarks = body.remarks !== undefined ? (body.remarks || null) : qc.remarks
    // GRN inspections start with the placeholder inspector 'pending'; a result always names who recorded it
    const named = body.inspector !== undefined ? (body.inspector || null) : qc.inspector
    const inspector = named && named !== 'pending' ? named : getActor(req)?.userName || null

    const updated = await db.$transaction(async (txRaw) => {
      const tx = txRaw as HelperTx
      // GRN row lock first: a post, a delete or the last other result of this GRN waits for this transaction
      if (qc.refType === 'GRN') {
        const lock = await tx.grn.updateMany({ where: { id: qc.refId, companyId, status: 'PENDING_QC' }, data: { updatedAt: new Date() } })
        if (lock.count !== 1) throw new ApiError(`${qc.refNumber || 'The GRN'} is no longer waiting for QC — refresh and check it`, 409, 'GRN_NOT_PENDING_QC')
      }
      // Atomic: a result can only be recorded once, while PENDING
      await claimStatus((tx as any).qcInspection, qc.id, ['PENDING'], status)
      const u = await tx.qcInspection.update({
        where: { id: qc.id },
        data: { qtyAccepted, qtyRejected, parameters, remarks, inspector },
      })

      if (qc.refType === 'GRN') {
        await applyToGrn(tx, companyId, qc, { qtyAccepted, qtyRejected, status }, body.acceptedSerials, body.userName)
      }

      if (status === 'FAILED') {
        await notify(tx, {
          companyId,
          title: `QC Failed: inspection ${qc.number}`,
          message: `${qtyRejected} of ${qc.qtyChecked} qty rejected${qc.refNumber ? ` (${qc.refNumber})` : ''}${remarks ? ` — ${remarks}` : ''}`,
          level: 'CRITICAL',
        })
      } else if (status === 'PARTIAL') {
        await notify(tx, {
          companyId,
          title: `QC Partial: inspection ${qc.number}`,
          message: `${qtyAccepted} accepted, ${qtyRejected} rejected of ${qc.qtyChecked} qty${qc.refNumber ? ` (${qc.refNumber})` : ''}${remarks ? ` — ${remarks}` : ''}`,
          level: 'WARNING',
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
    }, QC_TX)
    const [row] = await attachItem(companyId, [updated])
    return ok(row, `Inspection ${status.toLowerCase()}`)
  } catch (e) {
    return handleError(e)
  }
}
