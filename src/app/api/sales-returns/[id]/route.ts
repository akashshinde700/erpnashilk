import { db } from '@/lib/db'
import { requireSecurityPin } from '@/lib/security-pin'
import { ok, handleError, companyRequired, postStock, logAudit, ApiError, r2, requireWrite, claimStatus, requireRead } from '@/lib/erp-helpers'
import { withReturnInfo } from '../shared'
import { consumeBatches, parseBatchNote, unreturnSerials } from '@/lib/batches'
import { applyCustomerCredit } from '@/lib/credit-apply'
import { SALES_RETURN } from '@/lib/party-credits'
import { claimIdempotency, type Idempotency } from '@/lib/idempotency'

// GET /api/sales-returns/[id]?companyId= — full detail for the credit note print
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireRead(req, 'sales-returns') // Phase 5: financial read permission
    const { id } = await params
    const companyId = await companyRequired(req)
    const ret = await db.salesReturn.findFirst({ where: { id, companyId }, include: { items: true } })
    if (!ret) throw new ApiError('Sales return not found', 404)
    const [row] = await withReturnInfo(companyId, [ret])
    // Line discount % comes from the original invoice line (the return stores the gross rate)
    const invItemIds = ret.items.map((i) => i.invoiceItemId).filter((x): x is string => !!x)
    const [invLines, company] = await Promise.all([
      db.salesInvoiceItem.findMany({ where: { id: { in: invItemIds }, invoice: { companyId } }, select: { id: true, discountPct: true, hsn: true } }),
      db.company.findUnique({
        where: { id: companyId },
        select: { name: true, gstin: true, pan: true, addressLine: true, city: true, state: true, stateCode: true, phone: true, email: true, logoImage: true, signatureImage: true },
      }),
    ])
    const invMap = new Map(invLines.map((l) => [l.id, l]))
    return ok({
      ...row,
      company,
      items: ret.items.map((i, idx) => {
        const src = i.invoiceItemId ? invMap.get(i.invoiceItemId) : undefined
        const info = row.items[idx]?.item ?? null
        return { ...i, item: info, discountPct: src?.discountPct ?? 0, hsn: src?.hsn ?? info?.hsn ?? null }
      }),
    })
  } catch (e) {
    return handleError(e)
  }
}

// PATCH /api/sales-returns/[id]  { action: 'cancel' } | { action: 'apply', invoiceId, amount, date? }
// cancel: POSTED → CANCELLED: the returned goods go back out of stock (409 if they were already used) and the
//   CREDIT_NOTE receipt(s) for this note are removed from the invoice, restoring its balance. Refused while the
//   credit is refunded or applied to another invoice (void those first).
// apply: put the credit left on this note against another open invoice of the customer (no money moves).
//   Refunds of the credit are Payment rows (POST /api/payments, invoiceType 'SALES_RETURN').
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  let idem: Idempotency | null = null
  try {
    requireWrite(req, 'sales-returns')
    const { id } = await params
    const body = await req.json().catch(() => ({}) as any)
    const companyId = await companyRequired(req, body.companyId)
    if (body.action === 'apply') {
      idem = await claimIdempotency(req, companyId, `PATCH /api/sales-returns/${id} apply`, body)
      if (idem.replay) return idem.replay
      const row = await db.$transaction(async (tx) => {
        const r = await applyCustomerCredit(tx, {
          companyId, source: 'RETURN', sourceId: id, invoiceId: body.invoiceId, amount: body.amount, date: body.date, userName: body.userName,
        })
        await idem!.done(tx, r, `Credit applied to ${r.invoiceNumber}`)
        return r
      })
      return ok(row, `Credit applied to ${row.invoiceNumber}`)
    }
    await requireSecurityPin(req, companyId)

    if (body.action !== 'cancel') throw new ApiError("Nothing to update — use action='cancel' or 'apply'", 400)
    const current = await db.salesReturn.findFirst({ where: { id, companyId }, include: { items: true } })
    if (!current) throw new ApiError('Sales return not found', 404)
    if (current.status !== 'POSTED') throw new ApiError(`Sales return is ${current.status}`, 400)

    const updated = await db.$transaction(async (tx) => {
      const t = tx as any
      await claimStatus(t.salesReturn, id, ['POSTED'], 'CANCELLED')
      // The status flip locked the note: refunds and applications elsewhere must be removed first
      const [refunds, appliedElsewhere] = await Promise.all([
        tx.payment.count({ where: { companyId, invoiceType: SALES_RETURN, invoiceId: id, OR: [{ chequeStatus: null }, { chequeStatus: { not: 'BOUNCED' } }] } }),
        tx.payment.count({ where: { companyId, mode: 'CREDIT_NOTE', allocatedFromId: id } }),
      ])
      if (refunds || appliedElsewhere) {
        throw new ApiError(`${current.number} has ${refunds ? `${refunds} refund${refunds === 1 ? '' : 's'}` : ''}${refunds && appliedElsewhere ? ' and ' : ''}${appliedElsewhere ? `${appliedElsewhere} application${appliedElsewhere === 1 ? '' : 's'} to other invoices` : ''} — void ${refunds + appliedElsewhere === 1 ? 'it' : 'them'} first`, 400)
      }

      // Reverse exactly the stock this return received, at the cost it came in at. A credit-note-only return
      // (the invoice moved no stock) and service lines received nothing, so nothing goes out.
      const ledger = await tx.stockLedger.findMany({
        where: { companyId, refType: 'SALES_RETURN', refId: id, type: 'SALES_RETURN_IN' },
        select: { itemId: true, qtyIn: true, rate: true, notes: true },
      })
      const received = new Map<string, { qty: number; value: number }>()
      for (const l of ledger) {
        const r = received.get(l.itemId) ?? { qty: 0, value: 0 }
        received.set(l.itemId, { qty: r2(r.qty + l.qtyIn), value: r.value + l.qtyIn * l.rate })
      }
      for (const [itemId, r] of Array.from(received)) {
        if (r.qty <= 0) continue
        await postStock(t, {
          companyId, itemId, warehouseId: current.warehouseId, type: 'SALES_RETURN_REVERSAL', qtyOut: r.qty,
          rate: r2(r.value / r.qty), date: new Date(),
          refType: 'SALES_RETURN', refId: id, refNumber: current.number, notes: `Cancelled credit note ${current.number}`,
        })
      }
      // Batch layer: take the qty back out of the batch(es) the return put it in (recorded in the ledger notes)
      const byItem = new Map<string, Map<string, number>>()
      for (const row of ledger) {
        for (const a of parseBatchNote(row.notes)) {
          const m = byItem.get(row.itemId) ?? new Map<string, number>()
          m.set(a.batchNo, r2((m.get(a.batchNo) || 0) + a.qty))
          byItem.set(row.itemId, m)
        }
      }
      for (const [itemId, m] of Array.from(byItem)) {
        for (const [batchNo, qty] of Array.from(m)) {
          await consumeBatches(tx, { companyId, itemId, warehouseId: current.warehouseId, qty, batchNo })
        }
      }
      // Serials that came back on this note return to SOLD (409 if one has been sold again)
      await unreturnSerials(tx, companyId, { type: 'SALES_RETURN', id })

      // Remove the credit applied to the invoice
      const credits = await tx.payment.findMany({
        where: { companyId, invoiceId: current.invoiceId, invoiceType: 'SALES', mode: 'CREDIT_NOTE', reference: current.number, allocatedFromId: null },
        select: { id: true, amount: true },
      })
      const creditTotal = r2(credits.reduce((s, p) => s + p.amount, 0))
      if (credits.length) {
        const del = await tx.payment.deleteMany({ where: { id: { in: credits.map((p) => p.id) }, companyId } })
        if (del.count !== credits.length) throw new ApiError('This credit note was just changed by someone else — refresh and try again', 409)
        const dec = await tx.salesInvoice.updateMany({
          where: { id: current.invoiceId, companyId },
          data: { paidAmount: { decrement: creditTotal } },
        })
        if (dec.count === 1) {
          const inv = await tx.salesInvoice.findUniqueOrThrow({ where: { id: current.invoiceId } })
          const newPaid = Math.max(0, r2(inv.paidAmount))
          const newStatus = inv.status === 'CANCELLED'
            ? inv.status
            : (newPaid <= 0.01 ? 'UNPAID' : (inv.grandTotal - newPaid <= 0.01 ? 'PAID' : 'PARTIALLY_PAID'))
          await tx.salesInvoice.update({ where: { id: inv.id }, data: { paidAmount: newPaid, status: newStatus } })
        }
      }

      await logAudit(t, {
        companyId, userName: body.userName, action: 'CANCEL', entity: 'SalesReturn', entityId: id,
        details: `Cancelled credit note ${current.number} • stock reversed${creditTotal > 0 ? ` • ₹${creditTotal} credit removed from the invoice` : ''}`,
      })
      return tx.salesReturn.findUniqueOrThrow({ where: { id } })
    })
    return ok(updated, `Credit note ${current.number} cancelled`)
  } catch (e) {
    await idem?.release()
    return handleError(e)
  }
}
