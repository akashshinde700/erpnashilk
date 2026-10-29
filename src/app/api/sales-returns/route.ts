import { db } from '@/lib/db'
import { ok, handleError, companyRequired, nextDocNumber, computeBillTotals, postStock, logAudit, ApiError, r2, requireWrite, requireRead } from '@/lib/erp-helpers'
import { withReturnInfo, challanBatchFor } from './shared'
import { batchNote, parseAllocation, parseSerials, receiveBatch, returnSerials, trackingOf } from '@/lib/batches'
import { liveSaleRows, originalUnitCost, saleStockMode } from '@/lib/sale-cost'

const optStr = (v: unknown) => (v === undefined || v === null || String(v).trim() === '' ? null : String(v).trim())

// GET /api/sales-returns?companyId=&invoiceId=&customerId=&status=&q=
export async function GET(req: Request) {
  try {
    requireRead(req, 'sales-returns') // Phase 5: financial read permission
    const companyId = await companyRequired(req)
    const sp = new URL(req.url).searchParams
    const where: any = { companyId }
    for (const k of ['invoiceId', 'customerId', 'status']) {
      const v = (sp.get(k) || '').trim()
      if (v) where[k] = v
    }
    const q = (sp.get('q') || '').trim()
    if (q) where.number = { contains: q }
    const rows = await db.salesReturn.findMany({ where, orderBy: [{ date: 'desc' }, { createdAt: 'desc' }], include: { items: true } })
    const items = await withReturnInfo(companyId, rows)
    return ok({ items, total: items.length })
  } catch (e) {
    return handleError(e)
  }
}

// POST /api/sales-returns
// { companyId, invoiceId, date?, warehouseId? (default FG store, else first), reason?, notes?, lines: [{ invoiceItemId, qty }] }
// Value of the return = the invoice line's rate less its line discount %, plus that line's GST.
// Bill-level discount / freight / packing on the original invoice are NOT apportioned to the return
// (kept simple on purpose — issue a manual adjustment if they must be reversed too).
// The credit is applied to the invoice (CREDIT_NOTE receipt) up to its outstanding; any excess is a refund
// due to the customer (reported in the response + audit log, no payment row).
// Stock (AC-B1): goods come back at the ORIGINAL inventory cost of the sale — the cost stored on the sale's outward
// stock rows (rebuilt from the ledger for older rows; 409 "needs review" when that is not reliable) — into the
// chosen warehouse, even if the sale left from another one. An invoice that moved no stock gets a credit note only.
export async function POST(req: Request) {
  try {
    requireWrite(req, 'sales-returns')
    const body = await req.json().catch(() => ({}) as any)
    const companyId = await companyRequired(req, body.companyId)

    if (!body.invoiceId) throw new ApiError('invoiceId is required', 400)
    const [company, invoice] = await Promise.all([
      db.company.findUnique({ where: { id: companyId }, select: { roundOffTotals: true } }),
      db.salesInvoice.findFirst({ where: { id: String(body.invoiceId), companyId }, include: { items: true } }),
    ])
    if (!company) throw new ApiError('Company not found', 404)
    if (!invoice) throw new ApiError('Sales invoice not found', 404)
    if (invoice.status === 'CANCELLED') throw new ApiError('Invoice is cancelled', 400)

    const date = body.date ? new Date(body.date) : new Date()
    if (isNaN(date.getTime())) throw new ApiError('date is not a valid date', 400)

    // Requested lines (merged per invoice line); zero-qty lines are skipped
    const raw: any[] = Array.isArray(body.lines) ? body.lines : Array.isArray(body.items) ? body.items : []
    const wanted = new Map<string, number>()
    const serialsWanted = new Map<string, string[]>() // serial-tracked items: the serials coming back, per invoice line
    for (const l of raw) {
      const qty = Number(l?.qty)
      if (!Number.isFinite(qty) || qty < 0) throw new ApiError('Return qty must be 0 or more', 400)
      if (qty === 0) continue
      const key = String(l?.invoiceItemId || '')
      if (!key) throw new ApiError('invoiceItemId is required on every line', 400)
      wanted.set(key, r2((wanted.get(key) || 0) + qty))
      const sn = parseSerials(l?.serials)
      if (sn.length) serialsWanted.set(key, parseSerials([...(serialsWanted.get(key) || []), ...sn]))
    }
    if (!wanted.size) throw new ApiError('Enter a return qty on at least one line', 400)
    const invItemById = new Map(invoice.items.map((i) => [i.id, i]))
    for (const key of wanted.keys()) {
      if (!invItemById.has(key)) throw new ApiError('A return line does not belong to this invoice', 400)
    }

    // Warehouse: the one asked for (tenant-checked), else the FG store, else the first warehouse
    let warehouseId: string
    if (body.warehouseId) {
      const w = await db.warehouse.findFirst({ where: { id: String(body.warehouseId), companyId }, select: { id: true } })
      if (!w) throw new ApiError('Warehouse not found', 404)
      warehouseId = w.id
    } else {
      const w = (await db.warehouse.findFirst({ where: { companyId, type: 'FG' }, orderBy: { createdAt: 'asc' }, select: { id: true } }))
        || (await db.warehouse.findFirst({ where: { companyId }, orderBy: { createdAt: 'asc' }, select: { id: true } }))
      if (!w) throw new ApiError('Create a warehouse first — returned goods need a store', 400)
      warehouseId = w.id
    }

    const result = await db.$transaction(async (tx) => {
      const t = tx as any
      // Lock the invoice row first (also serialises concurrent returns on this invoice), then read fresh state
      const lock = await tx.salesInvoice.updateMany({ where: { id: invoice.id, companyId, status: { not: 'CANCELLED' } }, data: { updatedAt: new Date() } })
      if (lock.count !== 1) throw new ApiError('This invoice was just cancelled — refresh and try again', 409)

      const prior = await tx.salesReturnItem.findMany({
        where: { invoiceItemId: { in: Array.from(wanted.keys()) }, ret: { companyId, status: { not: 'CANCELLED' } } },
        select: { invoiceItemId: true, qty: true },
      })
      const already = new Map<string, number>()
      for (const p of prior) if (p.invoiceItemId) already.set(p.invoiceItemId, r2((already.get(p.invoiceItemId) || 0) + p.qty))

      const lines = Array.from(wanted.entries()).map(([invoiceItemId, qty]) => {
        const src = invItemById.get(invoiceItemId)!
        const left = r2(src.qty - (already.get(invoiceItemId) || 0))
        if (qty > left + 0.005) {
          throw new ApiError(`Return qty ${qty} exceeds what can still be returned on a line (invoiced ${r2(src.qty)}, returnable ${Math.max(0, left)})`, 400)
        }
        return { invoiceItemId, itemId: src.itemId, qty, rate: src.rate, discountPct: src.discountPct || 0, gstRate: src.gstRate }
      })
      const totals = computeBillTotals(lines, invoice.isInterState, { roundOff: company.roundOffTotals ?? true })

      // Original cost per returned item, decided before anything is written (a review stop leaves no trace)
      const masters = await tx.item.findMany({ where: { companyId, id: { in: lines.map((l) => l.itemId) } }, select: { id: true, type: true, code: true, name: true } })
      const master = new Map(masters.map((m) => [m.id, m]))
      const goodsIds = Array.from(new Set(lines.map((l) => l.itemId))).filter((id) => master.get(id)?.type !== 'SERVICE')
      const invInfo = { id: invoice.id, number: invoice.number, challanId: invoice.challanId, salesOrderId: invoice.salesOrderId, deductStock: invoice.deductStock }
      const stockMode = goodsIds.length ? await saleStockMode(tx, companyId, invInfo, goodsIds) : 'NONE'
      const unitCost = new Map<string, number>()
      if (stockMode !== 'NONE') {
        for (const itemId of goodsIds) {
          const m = master.get(itemId)
          const live = await liveSaleRows(tx, companyId, invInfo, stockMode, itemId)
          unitCost.set(itemId, await originalUnitCost(tx, companyId, live.rows, `${m ? `${m.code} ${m.name}` : 'an item'} on invoice ${invoice.number}`))
        }
      }

      const number = await nextDocNumber(t, companyId, 'SRET', date)
      const ret = await tx.salesReturn.create({
        data: {
          companyId,
          number,
          invoiceId: invoice.id,
          customerId: invoice.customerId,
          warehouseId,
          date,
          reason: optStr(body.reason),
          isInterState: invoice.isInterState,
          // subtotal = taxable value (after the invoice line discounts)
          subtotal: r2(totals.subtotal - totals.discountTotal),
          cgst: totals.cgst,
          sgst: totals.sgst,
          igst: totals.igst,
          grandTotal: totals.grandTotal,
          status: 'POSTED',
          notes: optStr(body.notes),
          items: {
            create: lines.map((l, i) => ({
              invoiceItemId: l.invoiceItemId,
              itemId: l.itemId,
              qty: l.qty,
              rate: l.rate,
              gstRate: l.gstRate,
              lineTotal: totals.computed[i].taxable,
            })),
          },
        },
      })

      // Goods come back into stock at the original cost of the sale (none when the invoice moved no stock)
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i]
        const cost = unitCost.get(l.itemId)
        if (cost === undefined) continue
        // Batch-tracked: back into the original line's batch when it was a single batch, else a RET-<no> batch.
        // The batch used is remembered in the ledger note so a cancel can take it out again.
        const src = invItemById.get(l.invoiceItemId)!
        const tr = await trackingOf(tx, companyId, l.itemId)
        let allocs: { batchNo: string; qty: number }[] = []
        if (tr.batchTracked) {
          const orig = parseAllocation(src.batchNo || (await challanBatchFor(tx, invoice.challanId, l.itemId)), src.qty)
          const batchNo = orig.length === 1 ? orig[0].batchNo : `RET-${number}`
          allocs = [{ batchNo, qty: l.qty }]
        }
        await postStock(t, {
          companyId, itemId: l.itemId, warehouseId, type: 'SALES_RETURN_IN', qtyIn: l.qty,
          rate: cost, date,
          refType: 'SALES_RETURN', refId: ret.id, refNumber: number, notes: `Return against ${invoice.number} at original cost ₹${cost.toFixed(2)}${batchNote(allocs)}`,
        })
        for (const a of allocs) await receiveBatch(tx, { companyId, itemId: l.itemId, warehouseId, batchNo: a.batchNo, qty: a.qty })
        await returnSerials(tx, {
          companyId, itemId: l.itemId, warehouseId, serials: serialsWanted.get(l.invoiceItemId) || [], qty: l.qty,
          ref: { type: 'SALES_RETURN', id: ret.id },
        })
      }

      // Adjust the invoice: credit up to its outstanding balance
      const fresh = await tx.salesInvoice.findUniqueOrThrow({ where: { id: invoice.id } })
      const outstanding = Math.max(0, r2(fresh.grandTotal - fresh.paidAmount))
      const credit = r2(Math.min(totals.grandTotal, outstanding))
      const refundDue = r2(totals.grandTotal - credit)
      let invoiceStatus = fresh.status
      if (credit > 0.005) {
        const rcpt = await nextDocNumber(t, companyId, 'RCPT', date)
        await tx.payment.create({
          data: {
            companyId, number: rcpt, type: 'RECEIPT', partyType: 'CUSTOMER', customerId: invoice.customerId,
            invoiceType: 'SALES', invoiceId: invoice.id, amount: credit, mode: 'CREDIT_NOTE', date,
            reference: number, notes: `Credit note ${number} adjusted against ${invoice.number}`,
          },
        })
        const inc = await tx.salesInvoice.updateMany({
          where: { id: invoice.id, status: { not: 'CANCELLED' } },
          data: { paidAmount: { increment: credit } },
        })
        if (inc.count !== 1) throw new ApiError('Invoice was just cancelled — refresh and try again', 409)
        const after = await tx.salesInvoice.findUniqueOrThrow({ where: { id: invoice.id } })
        invoiceStatus = after.grandTotal - r2(after.paidAmount) <= 0.01 ? 'PAID' : 'PARTIALLY_PAID'
        await tx.salesInvoice.update({ where: { id: invoice.id }, data: { status: invoiceStatus } })
      }

      await logAudit(t, {
        companyId, userName: body.userName, action: 'CREATE', entity: 'SalesReturn', entityId: ret.id,
        details: `Credit note ${number} against ${invoice.number} • ₹${totals.grandTotal}${credit > 0.005 ? ` • ₹${credit} adjusted on invoice` : ''}${refundDue > 0.005 ? ` • ₹${refundDue} refund due to customer` : ''}${stockMode === 'NONE' ? ' • credit note only (the invoice moved no stock)' : ' • goods back in stock at original cost'}`,
      })
      return { ...ret, creditApplied: credit, refundDue, invoiceStatus, stockReturned: stockMode !== 'NONE' && unitCost.size > 0 }
    })

    const msg = result.refundDue > 0.005
      ? `Credit note ${result.number} created — ₹${result.refundDue.toFixed(2)} is a refund due to the customer`
      : `Credit note ${result.number} created`
    return ok(result, msg)
  } catch (e) {
    return handleError(e)
  }
}
