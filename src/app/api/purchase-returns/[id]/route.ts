import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { requireSecurityPin } from '@/lib/security-pin'
import { ok, handleError, companyRequired, claimStatus, logAudit, ApiError, r2, requireWrite, postStock, requireRead } from '@/lib/erp-helpers'
import { attachReturnInfo, billStatus } from '../shared'
import { parseBatchNote, receiveBatch, unreturnSerialsFromSupplier } from '@/lib/batches'
import { PURCHASE_RETURN } from '@/lib/party-credits'

// prisma 6.x generated delegates are not structurally assignable to the shared helpers' minimal
// tx types — intersect once and cast the transaction client at the boundary.
type HelperTx = Prisma.TransactionClient & Parameters<typeof logAudit>[0]

async function findReturn(id: string, companyId: string) {
  const ret = await db.purchaseReturn.findFirst({ where: { id, companyId }, include: { items: true } })
  if (!ret) throw new ApiError('Purchase return not found', 404)
  return ret
}

// ============================== GET /api/purchase-returns/[id] ==============================
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireRead(req, 'purchase-returns') // Phase 5: financial read permission
    const { id } = await params
    const companyId = await companyRequired(req)
    const [row] = await attachReturnInfo(companyId, [await findReturn(id, companyId)])
    return ok(row)
  } catch (e) {
    return handleError(e)
  }
}

// ============================== PATCH /api/purchase-returns/[id] — action=cancel ==============================
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireWrite(req, 'purchase-returns')
    const { id } = await params
    const body = await req.json()
    const companyId = await companyRequired(req, body.companyId)
    await requireSecurityPin(req, companyId)
    if (body.action !== 'cancel') throw new ApiError(`Unknown action '${body.action}' (use cancel)`, 400)
    const ret = await findReturn(id, companyId)
    if (ret.status === 'CANCELLED') throw new ApiError('This debit note is already cancelled', 400)

    const updated = await db.$transaction(async (txRaw) => {
      const tx = txRaw as HelperTx
      await claimStatus(tx.purchaseReturn, ret.id, ['POSTED'], 'CANCELLED')
      // The status flip locked the note: refunds received against it must be voided first
      const refunds = await tx.payment.count({ where: { companyId, invoiceType: PURCHASE_RETURN, invoiceId: ret.id, OR: [{ chequeStatus: null }, { chequeStatus: { not: 'BOUNCED' } }] } })
      if (refunds) throw new ApiError(`${ret.number} has ${refunds} refund${refunds === 1 ? '' : 's'} received — void ${refunds === 1 ? 'it' : 'them'} first`, 400)

      // Goods come back into the warehouse they left from, at the same rate
      for (const it of ret.items) {
        await postStock(tx as never, {
          companyId, itemId: it.itemId, warehouseId: ret.warehouseId, type: 'PURCHASE_RETURN_REVERSAL', qtyIn: it.qty, rate: it.rate,
          refType: 'PURCHASE_RETURN', refId: ret.id, refNumber: ret.number, notes: `Reversed: debit note ${ret.number} cancelled`,
        })
      }
      // Batch layer: back into the batches recorded on the outward ledger rows; serials back IN_STOCK
      const outRows = await tx.stockLedger.findMany({
        where: { companyId, refType: 'PURCHASE_RETURN', refId: ret.id, type: 'PURCHASE_RETURN_OUT' },
        select: { itemId: true, notes: true },
      })
      for (const row of outRows) {
        for (const a of parseBatchNote(row.notes)) {
          await receiveBatch(tx, { companyId, itemId: row.itemId, warehouseId: ret.warehouseId, batchNo: a.batchNo, qty: a.qty })
        }
      }
      await unreturnSerialsFromSupplier(tx, companyId, { type: 'PURCHASE_RETURN', id: ret.id })

      // Undo the bill adjustment: remove the debit-note payment rows and reduce the bill's paid amount
      const notes = await tx.payment.findMany({
        where: { companyId, invoiceId: ret.invoiceId, invoiceType: 'PURCHASE', mode: 'DEBIT_NOTE', reference: ret.number },
        select: { id: true, amount: true },
      })
      const debit = r2(notes.reduce((s, p) => s + p.amount, 0))
      if (notes.length) {
        await tx.payment.deleteMany({ where: { id: { in: notes.map((p) => p.id) } } })
        await tx.purchaseInvoice.updateMany({ where: { id: ret.invoiceId, companyId }, data: { paidAmount: { decrement: debit } } })
        const bill = await tx.purchaseInvoice.findUniqueOrThrow({ where: { id: ret.invoiceId }, select: { status: true, grandTotal: true, paidAmount: true } })
        const paid = Math.max(0, r2(bill.paidAmount))
        await tx.purchaseInvoice.update({
          where: { id: ret.invoiceId },
          data: { paidAmount: paid, ...(bill.status !== 'CANCELLED' ? { status: billStatus(bill.grandTotal, paid) } : {}) },
        })
      }

      await logAudit(tx, {
        companyId, userName: body.userName, action: 'CANCEL', entity: 'PurchaseReturn', entityId: ret.id,
        details: `Cancelled debit note ${ret.number} (₹${r2(ret.grandTotal).toFixed(2)})${debit > 0 ? `; ₹${debit.toFixed(2)} added back to the bill outstanding` : ''}`,
      })
      return tx.purchaseReturn.findUniqueOrThrow({ where: { id: ret.id }, include: { items: true } })
    })
    const [row] = await attachReturnInfo(companyId, [updated])
    return ok(row, `Debit note ${ret.number} cancelled`)
  } catch (e) {
    return handleError(e)
  }
}
// NOTE: No DELETE — debit notes are accounting records; cancel instead.
