import type { Prisma } from '@prisma/client'
import { r2 } from '@/lib/erp-helpers'

/**
 * How far a purchase order line has really been delivered.
 *
 *   received    physically received on posted GRNs (PurchaseOrderItem.receivedQty, rejected material included)
 *   accepted    passed QC on posted GRNs
 *   rejected    failed QC on posted GRNs
 *   closed      formally given up on: waived or settled by a supplier credit note (PurchaseOrderClosure)
 *   outstanding ordered - accepted - closed
 *
 * Rejected material does not reduce what is outstanding: the supplier still owes it until a replacement passes QC or
 * someone closes it with a reason. Accepted qty is summed from the GRN lines, so older purchase orders need no data
 * migration. Stock and bills never read these figures.
 */

export interface PoLineProgress {
  accepted: number
  rejected: number
  closed: number
  /** Received on GRNs that are not posted yet: not accepted, but already on its way through QC. */
  inQc: number
}

const POSTED = ['POSTED', 'PARTIALLY_ACCEPTED']
const UNPOSTED = ['PENDING_QC', 'QC_COMPLETED']
const EPS = 0.01

export async function poLineProgress(client: Prisma.TransactionClient, poItemIds: string[]) {
  const map = new Map<string, PoLineProgress>(poItemIds.map((id) => [id, { accepted: 0, rejected: 0, closed: 0, inQc: 0 }]))
  if (!poItemIds.length) return map
  const [lines, closures] = await Promise.all([
    client.grnItem.findMany({
      where: { poItemId: { in: poItemIds }, grn: { status: { in: [...POSTED, ...UNPOSTED] } } },
      select: { poItemId: true, receivedQty: true, acceptedQty: true, rejectedQty: true, grn: { select: { status: true } } },
    }),
    client.purchaseOrderClosure.findMany({ where: { poItemId: { in: poItemIds } }, select: { poItemId: true, qty: true } }),
  ])
  for (const l of lines) {
    const p = map.get(l.poItemId as string)
    if (!p) continue
    if (POSTED.includes(l.grn.status)) {
      p.accepted = r2(p.accepted + l.acceptedQty)
      p.rejected = r2(p.rejected + l.rejectedQty)
    } else p.inQc = r2(p.inQc + l.receivedQty)
  }
  for (const c of closures) {
    const p = map.get(c.poItemId)
    if (p) p.closed = r2(p.closed + c.qty)
  }
  return map
}

export const outstandingQty = (qty: number, p: PoLineProgress) => Math.max(0, r2(qty - p.accepted - p.closed))

/** RECEIVED only when every line is accepted or formally closed. Call inside the transaction that changed it. */
export async function refreshPoReceiptStatus(tx: Prisma.TransactionClient, poId: string) {
  const items = await tx.purchaseOrderItem.findMany({ where: { poId }, select: { id: true, qty: true } })
  const progress = await poLineProgress(tx, items.map((i) => i.id))
  const done = items.length > 0 && items.every((i) => outstandingQty(i.qty, progress.get(i.id) as PoLineProgress) <= EPS)
  const status = done ? 'RECEIVED' : 'PARTIALLY_RECEIVED'
  await tx.purchaseOrder.update({ where: { id: poId }, data: { status } })
  return status
}
