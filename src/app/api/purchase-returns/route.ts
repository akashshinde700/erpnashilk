import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import {
  ok, handleError, companyRequired, nextDocNumber, computeBillTotals, logAudit, ApiError, r2, requireWrite, postStock,
} from '@/lib/erp-helpers'
import { attachReturnInfo, billStatus } from './shared'
import { batchNote, consumeBatches, parseSerials, returnSerialsToSupplier } from '@/lib/batches'

// prisma 6.x generated delegates are not structurally assignable to the shared helpers' minimal
// tx types — intersect once and cast the transaction client at the boundary.
type HelperTx = Prisma.TransactionClient & Parameters<typeof nextDocNumber>[0] & Parameters<typeof logAudit>[0]

function toDate(v: unknown): Date | null {
  if (!v) return null
  const d = new Date(String(v))
  return Number.isNaN(d.getTime()) ? null : d
}

// ============================== GET /api/purchase-returns ==============================
// ?invoiceId= (returns of one bill) &status= &q= (return no / reason)
export async function GET(req: Request) {
  try {
    const companyId = await companyRequired(req)
    const { searchParams } = new URL(req.url)
    const where: Prisma.PurchaseReturnWhereInput = { companyId }
    const invoiceId = searchParams.get('invoiceId') || ''
    const status = searchParams.get('status') || ''
    const q = searchParams.get('q') || ''
    if (invoiceId) where.invoiceId = invoiceId
    if (status) where.status = status
    if (q) where.OR = [{ number: { contains: q } }, { reason: { contains: q } }]
    const rows = await db.purchaseReturn.findMany({ where, orderBy: { date: 'desc' }, include: { items: true } })
    return ok({ items: await attachReturnInfo(companyId, rows), total: rows.length })
  } catch (e) {
    return handleError(e)
  }
}

interface ReturnLineInput { invoiceItemId?: string; qty?: number | string; batchNo?: string | null; serials?: string | string[] | null }

// ============================== POST /api/purchase-returns ==============================
// { invoiceId, date?, warehouseId?, reason?, notes?, lines: [{ invoiceItemId, qty, batchNo?, serials? }] }
// batchNo: batch-tracked items (blank = FEFO); serials: serial-tracked items (newline-separated, count = qty)
export async function POST(req: Request) {
  try {
    requireWrite(req, 'purchase-returns')
    const body = await req.json()
    const companyId = await companyRequired(req, body.companyId)
    const date = toDate(body.date) || new Date()
    if (!body.invoiceId) throw new ApiError('invoiceId is required', 400)

    // Merge repeated lines for the same bill line
    const wanted = new Map<string, number>()
    const tracking = new Map<string, { batchNo: string | null; serials: string[] }>()
    for (const l of (Array.isArray(body.lines) ? body.lines : []) as ReturnLineInput[]) {
      if (!l.invoiceItemId) throw new ApiError('invoiceItemId is required on every line', 400)
      const qty = Number(l.qty)
      if (!Number.isFinite(qty) || qty < 0) throw new ApiError('Return qty must be 0 or more', 400)
      if (qty > 0) {
        const key = String(l.invoiceItemId)
        wanted.set(key, r2((wanted.get(key) || 0) + qty))
        const prev = tracking.get(key) ?? { batchNo: null, serials: [] }
        tracking.set(key, {
          batchNo: (l.batchNo ? String(l.batchNo).trim() : '') || prev.batchNo,
          serials: parseSerials([...prev.serials, ...parseSerials(l.serials)]),
        })
      }
    }
    if (!wanted.size) throw new ApiError('Enter a return qty on at least one line', 400)

    const result = await db.$transaction(async (txRaw) => {
      const tx = txRaw as HelperTx
      // Row-lock the bill first so concurrent returns / payments on it serialise here
      const lock = await tx.purchaseInvoice.updateMany({
        where: { id: String(body.invoiceId), companyId, status: { not: 'CANCELLED' } },
        data: { updatedAt: new Date() },
      })
      if (lock.count !== 1) {
        const exists = await tx.purchaseInvoice.count({ where: { id: String(body.invoiceId), companyId } })
        throw new ApiError(exists ? 'Cannot return against a cancelled bill' : 'Purchase invoice not found', exists ? 400 : 404)
      }
      const invoice = await tx.purchaseInvoice.findUniqueOrThrow({
        where: { id: String(body.invoiceId) },
        include: { items: true, supplier: { select: { id: true, name: true } } },
      })

      // Already returned per bill line (non-cancelled returns)
      const prior = await tx.purchaseReturnItem.findMany({
        where: { ret: { companyId, invoiceId: invoice.id, status: { not: 'CANCELLED' } } },
        select: { invoiceItemId: true, qty: true },
      })
      const returned = new Map<string, number>()
      for (const p of prior) if (p.invoiceItemId) returned.set(p.invoiceItemId, r2((returned.get(p.invoiceItemId) || 0) + p.qty))

      const lines = Array.from(wanted.entries()).map(([invoiceItemId, qty]) => {
        const bl = invoice.items.find((i) => i.id === invoiceItemId)
        if (!bl) throw new ApiError('A return line does not belong to this bill', 400)
        const left = r2(bl.qty - (returned.get(bl.id) || 0))
        if (qty > left + 0.0005) {
          throw new ApiError(`Return qty ${qty} exceeds what can still be returned on this bill line (${left} of ${bl.qty} billed)`, 400)
        }
        return { bl, qty }
      })

      const wh = body.warehouseId
        ? await tx.warehouse.findFirst({ where: { id: String(body.warehouseId), companyId } })
        : (await tx.warehouse.findFirst({ where: { companyId, type: 'RM' }, orderBy: { createdAt: 'asc' } }))
          ?? (await tx.warehouse.findFirst({ where: { companyId }, orderBy: { createdAt: 'asc' } }))
      if (!wh) throw new ApiError(body.warehouseId ? 'Warehouse not found' : 'Create a warehouse first', 404)

      const company = await tx.company.findUnique({ where: { id: companyId }, select: { roundOffTotals: true } })
      // Rates and GST come from the bill lines. Bill-level discount / freight / packing are NOT
      // apportioned to the return — the debit note values goods at the bill's line rate only.
      const totals = computeBillTotals(
        lines.map((l) => ({ qty: l.qty, rate: l.bl.rate, gstRate: l.bl.gstRate })),
        invoice.isInterState,
        { roundOff: company?.roundOffTotals ?? true },
      )
      const number = await nextDocNumber(tx, companyId, 'PRET', date)

      const ret = await tx.purchaseReturn.create({
        data: {
          companyId, number, invoiceId: invoice.id, supplierId: invoice.supplierId, warehouseId: wh.id, date,
          reason: body.reason ? String(body.reason) : null,
          isInterState: invoice.isInterState,
          subtotal: totals.subtotal, cgst: totals.cgst, sgst: totals.sgst, igst: totals.igst, grandTotal: totals.grandTotal,
          status: 'POSTED',
          notes: body.notes ? String(body.notes) : null,
          items: {
            create: lines.map((l, i) => ({
              invoiceItemId: l.bl.id, itemId: l.bl.itemId, qty: l.qty, rate: l.bl.rate, gstRate: l.bl.gstRate,
              lineTotal: totals.computed[i].taxable,
            })),
          },
        },
        include: { items: true },
      })

      // Goods go back to the supplier (409 from postStock when the warehouse does not hold enough)
      for (const it of ret.items) {
        // Batch layer first (chosen batch, else FEFO) so the ledger note records which batches left —
        // a cancel puts the qty back into those batches. No-op for untracked items.
        const trk = it.invoiceItemId ? tracking.get(it.invoiceItemId) : undefined
        const allocs = await consumeBatches(tx, { companyId, itemId: it.itemId, warehouseId: wh.id, qty: it.qty, batchNo: trk?.batchNo })
        await postStock(tx as never, {
          companyId, itemId: it.itemId, warehouseId: wh.id, type: 'PURCHASE_RETURN_OUT', qtyOut: it.qty, rate: it.rate, date,
          refType: 'PURCHASE_RETURN', refId: ret.id, refNumber: number,
          notes: `Returned to ${invoice.supplier.name} against bill ${invoice.number}${batchNote(allocs)}`,
        })
        await returnSerialsToSupplier(tx, {
          companyId, itemId: it.itemId, warehouseId: wh.id, serials: trk?.serials ?? [], qty: it.qty,
          ref: { type: 'PURCHASE_RETURN', id: ret.id },
        })
      }

      // Adjust the bill: the debit note settles what is still outstanding on it
      const outstanding = Math.max(0, r2(invoice.grandTotal - invoice.paidAmount))
      const debit = r2(Math.min(ret.grandTotal, outstanding))
      const refundDue = r2(ret.grandTotal - debit) // beyond the outstanding: the supplier owes us this back
      if (debit > 0.005) {
        const payNumber = await nextDocNumber(tx, companyId, 'PYMT', date)
        await tx.payment.create({
          data: {
            companyId, number: payNumber, type: 'PAYMENT', partyType: 'SUPPLIER', supplierId: invoice.supplierId,
            invoiceType: 'PURCHASE', invoiceId: invoice.id, amount: debit, mode: 'DEBIT_NOTE', date,
            reference: number, notes: `Debit note ${number} adjusted against bill ${invoice.number}`,
          },
        })
        await tx.purchaseInvoice.updateMany({ where: { id: invoice.id, status: { not: 'CANCELLED' } }, data: { paidAmount: { increment: debit } } })
        const fresh = await tx.purchaseInvoice.findUniqueOrThrow({ where: { id: invoice.id }, select: { grandTotal: true, paidAmount: true } })
        await tx.purchaseInvoice.update({ where: { id: invoice.id }, data: { status: billStatus(fresh.grandTotal, fresh.paidAmount) } })
      }

      await logAudit(tx, {
        companyId, userName: body.userName, action: 'CREATE', entity: 'PurchaseReturn', entityId: ret.id,
        details: `Debit note ${number} for ${invoice.supplier.name} against bill ${invoice.number} — ₹${totals.grandTotal.toFixed(2)}`
          + (debit > 0.005 ? `; ₹${debit.toFixed(2)} adjusted against the bill` : '')
          + (refundDue > 0.005 ? `; ₹${refundDue.toFixed(2)} refund receivable from supplier` : ''),
      })
      return { ret, debitApplied: debit > 0.005 ? debit : 0, refundDue: refundDue > 0.005 ? refundDue : 0 }
    })
    const [row] = await attachReturnInfo(companyId, [result.ret])
    const msg = result.refundDue > 0
      ? `Debit note ${row.number} created — ₹${result.refundDue.toFixed(2)} to be refunded by the supplier`
      : `Debit note ${row.number} created`
    return ok({ ...row, debitApplied: result.debitApplied, refundDue: result.refundDue }, msg)
  } catch (e) {
    return handleError(e)
  }
}
