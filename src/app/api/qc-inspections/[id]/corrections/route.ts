import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { QC_CORRECTION_ROLES } from '@/lib/erp-constants'
import { ApiError, companyRequired, handleError, logAudit, notify, ok, r2, requireWrite } from '@/lib/erp-helpers'
import { QC_TX, matchInspectionsToLines, qcComplete, readQcResult, serialsAfterResult } from '@/lib/grn-qc'

type HelperTx = Prisma.TransactionClient & Parameters<typeof logAudit>[0] & Parameters<typeof notify>[0]

const MIN_REASON = 10

// POST /api/qc-inspections/[id]/corrections
//   { qtyAccepted, qtyRejected, basedOn: { qtyAccepted, qtyRejected }, inspectedBy, reason, physicalCheckConfirmed: true }
// Corrects a submitted GRN inspection result while the GRN is not posted. Every correction adds a QcCorrection row with
// the values before and after; rows are never changed, and there is deliberately no PATCH or DELETE here. The person
// states the accepted and rejected qty after counting the material: nothing is derived from what is missing.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = requireWrite(req, 'qc-inspections')
    if (!QC_CORRECTION_ROLES.includes(actor.role)) throw new ApiError('Only a quality manager or administrator can correct a QC result', 403)
    const { id } = await params
    const body = await req.json()
    const companyId = await companyRequired(req, body.companyId)

    const found = await db.qcInspection.findFirst({ where: { id, companyId } })
    if (!found) throw new ApiError('Inspection not found', 404)
    if (found.refType !== 'GRN') throw new ApiError('Only GRN inspection results can be corrected', 400)
    if (found.status === 'PENDING') throw new ApiError(`${found.number} has no result yet — submit it instead`, 400, 'QC_NOT_SUBMITTED')

    const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
    if (reason.length < MIN_REASON) throw new ApiError(`Explain the correction (at least ${MIN_REASON} characters)`, 400, 'QC_REASON_REQUIRED')
    const inspectedBy = typeof body.inspectedBy === 'string' ? body.inspectedBy.trim() : ''
    if (!inspectedBy) throw new ApiError('Enter who inspected the material', 400, 'QC_INSPECTOR_REQUIRED')
    if (body.physicalCheckConfirmed !== true) throw new ApiError('Confirm that the material was physically inspected', 400, 'QC_CHECK_NOT_CONFIRMED')
    const { qtyAccepted, qtyRejected, status } = readQcResult({ qtyAccepted: body.qtyAccepted, qtyRejected: body.qtyRejected }, found.qtyChecked)

    const updated = await db.$transaction(async (txRaw) => {
      const tx = txRaw as HelperTx
      // GRN row lock first: a post, a delete or another correction waits for this transaction
      const lock = await tx.grn.updateMany({
        where: { id: found.refId, companyId, status: { in: ['PENDING_QC', 'QC_COMPLETED'] } }, data: { updatedAt: new Date() },
      })
      if (lock.count !== 1) throw new ApiError(`${found.refNumber || 'The GRN'} is posted or no longer exists, so this result cannot be corrected`, 409, 'GRN_NOT_CORRECTABLE')

      const qc = await tx.qcInspection.findFirstOrThrow({ where: { id, companyId } })
      // Someone else corrected it after this form was opened: they must see the new values first
      const basedOn = (body.basedOn ?? {}) as { qtyAccepted?: unknown; qtyRejected?: unknown }
      if (r2(Number(basedOn.qtyAccepted)) !== r2(qc.qtyAccepted) || r2(Number(basedOn.qtyRejected)) !== r2(qc.qtyRejected)) {
        throw new ApiError(`${qc.number} was changed by someone else — reopen it and check the current result`, 409, 'QC_CHANGED')
      }
      if (r2(qc.qtyAccepted) === qtyAccepted && r2(qc.qtyRejected) === qtyRejected) {
        throw new ApiError('These are already the recorded quantities', 400, 'QC_NO_CHANGE')
      }

      const grn = await tx.grn.findFirstOrThrow({ where: { id: qc.refId, companyId }, include: { items: true } })
      const inspections = await tx.qcInspection.findMany({ where: { companyId, refType: 'GRN', refId: grn.id } })
      const { byLine } = matchInspectionsToLines(grn.items, inspections)
      const line = grn.items.find((l) => byLine.get(l.id)?.id === qc.id)
      if (!line) throw new ApiError(`${qc.number} cannot be matched to one line of ${grn.number}`, 409, 'QC_LINE_UNKNOWN')

      const item = await tx.item.findFirst({ where: { id: line.itemId, companyId }, select: { code: true, name: true, trackSerial: true } })
      const serials = item?.trackSerial ? serialsAfterResult(item, line.serials, qtyAccepted, body.acceptedSerials) : line.serials

      await tx.qcCorrection.create({
        data: {
          companyId, inspectionId: qc.id, inspectionNumber: qc.number, grnId: grn.id, grnNumber: grn.number, grnItemId: line.id,
          previousAccepted: qc.qtyAccepted, previousRejected: qc.qtyRejected, previousStatus: qc.status, previousInspector: qc.inspector,
          newAccepted: qtyAccepted, newRejected: qtyRejected, newStatus: status,
          inspectedBy, reason, correctedByUserId: actor.userId, correctedBy: actor.userName,
        },
      })
      const u = await tx.qcInspection.update({
        where: { id: qc.id },
        data: { qtyAccepted, qtyRejected, status, inspector: inspectedBy, grnItemId: line.id },
      })
      await tx.grnItem.update({
        where: { id: line.id },
        data: { acceptedQty: qtyAccepted, rejectedQty: qtyRejected, qcStatus: status, serials },
      })

      const complete = qcComplete(inspections.map((i) => (i.id === qc.id ? u : i)))
      const grnStatus = complete ? 'QC_COMPLETED' : 'PENDING_QC'
      if (grn.status !== grnStatus) await tx.grn.update({ where: { id: grn.id }, data: { status: grnStatus } })

      await logAudit(tx, {
        companyId, userName: body.userName, action: 'CORRECT', entity: 'QcInspection', entityId: qc.id,
        details: `${qc.number} (${grn.number}) corrected: accepted ${qc.qtyAccepted} / rejected ${qc.qtyRejected} (${qc.status}) → accepted ${qtyAccepted} / rejected ${qtyRejected} (${status}). Inspected by ${inspectedBy}. ${reason}`.slice(0, 4000),
      })
      await notify(tx, {
        companyId, title: `QC corrected: ${qc.number}`, level: 'WARNING',
        message: `${grn.number}: now ${qtyAccepted} accepted, ${qtyRejected} rejected (by ${actor.userName})`,
      })
      return u
    }, QC_TX)
    return ok(updated, 'QC result corrected')
  } catch (e) {
    return handleError(e)
  }
}
