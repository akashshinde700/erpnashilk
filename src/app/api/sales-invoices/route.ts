import { db } from '@/lib/db'
import { ok, fail, handleError, companyRequired, nextDocNumber, computeBillTotals, isInterStateParty, logAudit, notify, ApiError, r2, requireWrite, claimStatus, requireRead } from '@/lib/erp-helpers'
import { cashSaleCustomer } from '@/lib/party'
import { PAYMENT_MODES } from '@/lib/erp-constants'
import { assertOnOrAfterOpening, chequeDetails, ensureCashFor, postingAccount } from '@/lib/accounts'
import { businessDate } from '@/lib/business-date'
import { claimIdempotency, type Idempotency } from '@/lib/idempotency'
import { type InvLine, optStr, optNum, gstRateOf, parseLine, withMasterInfo, resolveStockWarehouse, postSaleStock } from './shared'

// Modes accepted for money received at billing time (credit/debit notes come only from returns)
const RECEIVE_MODES: readonly string[] = PAYMENT_MODES

// SalesInvoiceItem carries only itemId (no Prisma relation to Item) — attach master info via JS mapping
async function withItemInfo<T extends { items: { itemId: string }[] }>(companyId: string, docs: T[], client: Pick<typeof db, 'item'> = db) {
  const ids = Array.from(new Set(docs.flatMap((d) => d.items.map((i) => i.itemId))))
  const masters = ids.length
    ? await client.item.findMany({ where: { companyId, id: { in: ids } }, select: { id: true, code: true, name: true, uom: true, hsn: true } })
    : []
  const map = new Map(masters.map((m) => [m.id, m]))
  return docs.map((d) => ({ ...d, items: d.items.map((i) => ({ ...i, item: map.get(i.itemId) || null })) }))
}

// GET /api/sales-invoices?companyId=&status=&customerId=&q=
export async function GET(req: Request) {
  try {
    requireRead(req, ['sales-invoices', 'receivables', 'gst-report']) // Phase 5: financial read permission
    const companyId = await companyRequired(req)
    const { searchParams } = new URL(req.url)
    const status = (searchParams.get('status') || '').trim()
    const customerId = (searchParams.get('customerId') || '').trim()
    const q = (searchParams.get('q') || '').trim()

    const where: any = { companyId }
    if (status) where.status = status
    if (customerId) where.customerId = customerId
    if (q) {
      where.OR = [
        { number: { contains: q } },
        { customer: { is: { name: { contains: q } } } },
      ]
    }

    const items = await db.salesInvoice.findMany({
      where,
      orderBy: { date: 'desc' },
      include: {
        customer: { select: { name: true, gstin: true, phone: true, email: true, state: true, stateCode: true } },
        salesOrder: { select: { number: true } },
      },
    })
    return ok({ items, total: items.length })
  } catch (e) {
    return handleError(e)
  }
}

// POST /api/sales-invoices
// { companyId, salesOrderId?, challanId?, customerId, date?, dueDate?, placeOfSupply?, notes?,
//   customerPoNo?, customerPoDate?, shippingAddress?, vehicleNo?, transporter?,
//   lines? (alias: items): [{itemId, qty, rate, discountPct, gstRate, salesOrderItemId?}],
//   billDiscount?, freightCharge?, freightGstRate? (18), packingCharge?, packingGstRate? (18),
//   isCashSale?, receivedAmount?, receivedMode? (CASH), receivedReference?, receivedAccountId?, receivedChequeNo?, receivedChequeDate?,
//   billingName?, driverPhone?, deductStock?, stockWarehouseId?, lines[].cessRate? (default: item master) }
// - deductStock (only without salesOrderId/challanId) → SALE_OUT stock posting per line from stockWarehouseId
//   (default: FG store, else first warehouse); with an SO/challan the challan dispatch moves the stock instead
// - totals via computeBillTotals (bill discount pro-rata before GST, freight/packing taxable, round-off per company setting)
// - isCashSale → billed to the company's walk-in "Cash Sale" customer, intra-state, received defaults to the full total
// - receivedAmount > 0 → a RECEIPT payment is recorded in the same transaction
// - salesOrderId without lines → auto-build lines from SO items with remaining (qty - invoicedQty)
// - challanId (needs salesOrderId) → bills that DISPATCHED challan; without lines, lines are built from its items
// - SO auto-completes once every line is fully dispatched AND fully invoiced
export async function POST(req: Request) {
  let idem: Idempotency | null = null
  try {
    requireWrite(req, 'sales-invoices')
    const body = await req.json().catch(() => ({}) as any)
    const companyId = await companyRequired(req, body.companyId)

    const isCashSale = body.isCashSale === true || body.isCashSale === 'true'
    if (isCashSale && (body.salesOrderId || body.challanId)) throw new ApiError('A cash sale cannot be billed against a sales order or challan', 400)
    const customerId: string | null = isCashSale ? null : (body.customerId ? String(body.customerId) : null)
    if (!isCashSale && !customerId) throw new ApiError('customerId is required', 400)

    const [company, customer] = await Promise.all([
      db.company.findUnique({ where: { id: companyId } }),
      customerId ? db.customer.findFirst({ where: { id: customerId, companyId } }) : Promise.resolve(null),
    ])
    if (!company) throw new ApiError('Company not found', 404)
    if (!isCashSale && !customer) throw new ApiError('Customer not found', 404)

    const so: any = body.salesOrderId
      ? await db.salesOrder.findFirst({ where: { id: body.salesOrderId, companyId }, include: { items: true } })
      : null
    if (body.salesOrderId && !so) throw new ApiError('Sales order not found', 404)
    if (so && (so.status === 'DRAFT' || so.status === 'CANCELLED')) {
      throw new ApiError(`Cannot invoice a ${so.status} sales order`, 400)
    }
    if (so && so.customerId !== customerId) throw new ApiError('Sales order belongs to a different customer', 400)

    // Delivery challan link: same tenant, DISPATCHED, same sales order, not already billed
    let challan: { id: string; number: string; items: { salesOrderItemId: string | null; itemId: string; qty: number }[] } | null = null
    if (body.challanId) {
      if (!so) throw new ApiError('salesOrderId is required when invoicing a delivery challan', 400)
      const ch = await db.deliveryChallan.findFirst({ where: { id: String(body.challanId), companyId }, include: { items: true } })
      if (!ch) throw new ApiError('Delivery challan not found', 404)
      if (ch.status !== 'DISPATCHED') throw new ApiError(`Delivery challan ${ch.number} is ${ch.status} — only DISPATCHED challans can be invoiced`, 400)
      if (ch.salesOrderId !== so.id) throw new ApiError(`Delivery challan ${ch.number} belongs to a different sales order`, 400)
      const billed = await db.salesInvoice.findFirst({
        where: { companyId, challanId: ch.id, status: { not: 'CANCELLED' } },
        select: { number: true },
      })
      if (billed) throw new ApiError(`Delivery challan ${ch.number} is already invoiced on ${billed.number}`, 409)
      challan = { id: ch.id, number: ch.number, items: ch.items }
    }

    const rawLines = Array.isArray(body.lines) ? body.lines : Array.isArray(body.items) ? body.items : null
    const provided: any[] | null = rawLines && rawLines.length ? rawLines : null
    const soItemById = new Map<string, any>(so ? so.items.map((si: any) => [si.id, si]) : [])

    let lines: InvLine[] = []
    if (so && challan && !provided) {
      // Auto-build from the challan's lines, priced from the SO
      const chNo = challan.number
      lines = challan.items.map((ci) => {
        const si = ci.salesOrderItemId ? soItemById.get(ci.salesOrderItemId) : so.items.find((x: any) => x.itemId === ci.itemId)
        if (!si) throw new ApiError(`Challan ${chNo} has a line that is not on the sales order`, 400)
        return { soItemId: si.id, itemId: ci.itemId, qty: r2(ci.qty), rate: si.rate, discountPct: si.discountPct, gstRate: si.gstRate, cessRate: NaN }
      })
      if (!lines.length) throw new ApiError(`Challan ${challan.number} has no lines`, 400)
    } else if (so && !provided) {
      // Auto-build from SO items with un-invoiced balance
      const pending = so.items.filter((si: any) => r2(si.qty - si.invoicedQty) > 0.005)
      if (!pending.length) throw new ApiError('No un-invoiced qty remaining on this sales order', 400)
      lines = pending.map((si: any) => ({
        soItemId: si.id,
        itemId: si.itemId,
        qty: r2(si.qty - si.invoicedQty),
        rate: si.rate,
        discountPct: si.discountPct,
        gstRate: si.gstRate,
        cessRate: NaN, // filled from the item master below
      }))
    } else if (provided) {
      lines = provided.map((l) => {
        // rate kept at 4 dp (see parseLine)
        const line = parseLine(l)
        // Optional explicit SO line link (must be a line of this SO, same item)
        if (l.salesOrderItemId && so) {
          const si = soItemById.get(String(l.salesOrderItemId))
          if (!si || si.itemId !== line.itemId) throw new ApiError('salesOrderItemId does not match a line of this sales order', 400)
          line.soItemId = si.id
        }
        return line
      })
    } else {
      throw new ApiError('Provide salesOrderId (auto-lines) or explicit lines', 400)
    }

    // HSN (and default cess %) from item master
    const master = await withMasterInfo(companyId, lines)
    lines = master.lines
    const hsnMap = master.hsnMap

    // Direct sale (no SO / challan): optionally take the goods out of stock with this invoice
    const deductStock = !so && !challan && (body.deductStock === true || body.deductStock === 'true')
    const stockWarehouseId: string | null = deductStock ? await resolveStockWarehouse(companyId, body.stockWarehouseId) : null

    // Business day in India (UTC midnight of the IST day) — same rule as its receipt and the reports
    const date = businessDate(body.date, 'date')
    const dueDate = body.dueDate
      ? new Date(body.dueDate)
      : isCashSale ? date : new Date(date.getTime() + (customer?.paymentTermsDays || 30) * 24 * 60 * 60 * 1000)
    const placeOfSupply = body.placeOfSupply ?? (isCashSale ? company.state : customer?.state) ?? null
    const customerPoDate = body.customerPoDate ? new Date(body.customerPoDate) : null
    if (customerPoDate && isNaN(customerPoDate.getTime())) throw new ApiError('customerPoDate is not a valid date', 400)

    // Cash (counter) sales are always intra-state
    const interState = isCashSale ? false : isInterStateParty(company, customer ?? {})
    const billDiscount = optNum(body.billDiscount, 'Bill discount', 0)
    const freightCharge = optNum(body.freightCharge, 'Freight', 0)
    const freightGstRate = gstRateOf(body.freightGstRate, 'Freight GST %')
    const packingCharge = optNum(body.packingCharge, 'Packing', 0)
    const packingGstRate = gstRateOf(body.packingGstRate, 'Packing GST %')
    const totals = computeBillTotals(lines, interState, {
      billDiscount,
      freight: { amount: freightCharge, gstRate: freightGstRate },
      packing: { amount: packingCharge, gstRate: packingGstRate },
      roundOff: company.roundOffTotals ?? true,
    })

    // Money received at billing time (cash sale defaults to the full bill)
    const received = optNum(body.receivedAmount, 'Received amount', isCashSale ? totals.grandTotal : 0)
    if (received > totals.grandTotal + 0.01) throw new ApiError(`Received amount exceeds the invoice total (₹${totals.grandTotal.toFixed(2)})`, 400)
    const receivedMode = body.receivedMode ? String(body.receivedMode).toUpperCase() : 'CASH'
    if (received > 0 && !RECEIVE_MODES.includes(receivedMode)) throw new ApiError(`Payment mode must be one of ${RECEIVE_MODES.join(', ')}`, 400)
    const paid = r2(Math.min(received, totals.grandTotal))
    // The receipt is dated on the invoice's business day (IST); a cheque dated after today is post-dated (PENDING)
    const receiptDate = businessDate(date)
    const receivedCheque = chequeDetails(receivedMode, body.receivedChequeNo, body.receivedChequeDate)
    const status = paid <= 0.005 ? 'UNPAID' : totals.grandTotal - paid <= 0.01 ? 'PAID' : 'PARTIALLY_PAID'

    idem = await claimIdempotency(req, companyId, 'POST /api/sales-invoices', body)
    if (idem.replay) return idem.replay
    if (paid > 0.005) await ensureCashFor(companyId, receivedMode, optStr(body.receivedAccountId))
    const created = await db.$transaction(async (tx) => {
      const t = tx as any
      if (challan) {
        // Lock the challan row first so two invoices for the same challan serialise, then re-check
        const lock = await tx.deliveryChallan.updateMany({ where: { id: challan.id, companyId, status: 'DISPATCHED' }, data: { updatedAt: new Date() } })
        if (lock.count !== 1) throw new ApiError('This delivery challan was just changed by someone else — refresh and try again', 409)
        const dup = await tx.salesInvoice.count({ where: { companyId, challanId: challan.id, status: { not: 'CANCELLED' } } })
        if (dup > 0) throw new ApiError(`Delivery challan ${challan.number} is already invoiced`, 409)
      }
      const party = isCashSale ? await cashSaleCustomer(t, companyId) : { id: customerId as string, name: customer?.name || '' }
      const number = await nextDocNumber(t, companyId, 'INV', date)
      // Cash & Bank account the money received now goes into — a chosen account must exist and be active
      let accountId: string | null = null
      if (paid > 0.005) {
        const account = await postingAccount(t, companyId, receivedMode, optStr(body.receivedAccountId))
        assertOnOrAfterOpening(account, receiptDate, 'The amount received')
        accountId = account.id
      }
      const inv = await tx.salesInvoice.create({
        data: {
          companyId,
          number,
          salesOrderId: so?.id ?? null,
          challanId: challan?.id ?? null,
          customerId: party.id,
          date,
          dueDate,
          placeOfSupply,
          isInterState: interState,
          subtotal: totals.subtotal,
          discountTotal: totals.discountTotal,
          cgst: totals.cgst,
          sgst: totals.sgst,
          igst: totals.igst,
          cess: totals.cess,
          grandTotal: totals.grandTotal,
          billDiscount: totals.billDiscount,
          freightCharge: totals.freight,
          freightGstRate,
          packingCharge: totals.packing,
          packingGstRate,
          roundOff: totals.roundOff,
          isCashSale,
          paidAmount: paid,
          status,
          notes: body.notes ?? null,
          customerPoNo: optStr(body.customerPoNo),
          customerPoDate,
          shippingAddress: optStr(body.shippingAddress),
          vehicleNo: optStr(body.vehicleNo),
          transporter: optStr(body.transporter),
          billingName: optStr(body.billingName),
          driverPhone: optStr(body.driverPhone),
          deductStock,
          stockWarehouseId,
          accountId,
          items: {
            create: lines.map((l, i) => ({
              itemId: l.itemId,
              hsn: hsnMap.get(l.itemId) ?? null,
              qty: l.qty,
              rate: l.rate,
              discountPct: l.discountPct,
              gstRate: l.gstRate,
              cessRate: l.cessRate,
              lineTotal: r2(totals.computed[i].taxable),
              // the requested batch / serials; the batch actually drawn is written back below
              ...(deductStock ? { batchNo: l.batchNo ?? null, serials: l.serials ?? null } : {}),
            })),
          },
        },
      })

      // Payment received with the bill → receipt against this invoice
      let receiptNo: string | null = null
      if (paid > 0.005) {
        receiptNo = await nextDocNumber(t, companyId, 'RCPT', receiptDate)
        await tx.payment.create({
          data: {
            companyId,
            number: receiptNo,
            type: 'RECEIPT',
            partyType: 'CUSTOMER',
            customerId: party.id,
            invoiceType: 'SALES',
            invoiceId: inv.id,
            amount: paid,
            mode: receivedMode,
            date: receiptDate,
            ...receivedCheque,
            reference: optStr(body.receivedReference),
            notes: `Received at billing — ${number}`,
            accountId,
          },
        })
      }

      // Direct sale: goods leave the chosen warehouse now (services are skipped by postStock)
      if (deductStock && stockWarehouseId) {
        // Batch / serial layer (no-op for untracked items): chosen batch, else FEFO; drawn batches written back
        await postSaleStock(tx, { companyId, invoiceId: inv.id, number, date, warehouseId: stockWarehouseId, lines })
      }

      // Move SO invoicedQty forward
      if (so) {
        if (lines.every((l) => l.soItemId)) {
          for (const l of lines) {
            const si = await tx.salesOrderItem.update({ where: { id: l.soItemId as string }, data: { invoicedQty: { increment: l.qty } } })
            // A concurrent invoice on the same SO line makes the later one overshoot → roll back
            if (r2(si.invoicedQty) > r2(si.qty) + 0.005) {
              throw new ApiError(`Invoice exceeds the sales order quantity for a line (ordered ${r2(si.qty)}, invoiced would be ${r2(si.invoicedQty)})`, 409)
            }
          }
        } else {
          // Explicit lines against an SO: consume remaining qty per itemId, in SO line order
          const byItem = new Map<string, number>()
          for (const l of lines) byItem.set(l.itemId, r2((byItem.get(l.itemId) || 0) + l.qty))
          for (const si of so.items) {
            const want = byItem.get(si.itemId)
            if (!want) continue
            const remaining = r2(si.qty - si.invoicedQty)
            const apply = Math.min(want, Math.max(0, remaining))
            if (apply > 0) {
              const upd = await tx.salesOrderItem.update({ where: { id: si.id }, data: { invoicedQty: { increment: apply } } })
              if (r2(upd.invoicedQty) > r2(upd.qty) + 0.005) {
                throw new ApiError(`Invoice exceeds the sales order quantity for a line (ordered ${r2(upd.qty)}, invoiced would be ${r2(upd.invoicedQty)})`, 409)
              }
              byItem.set(si.itemId, r2(want - apply))
            }
          }
        }

        // Fully dispatched AND fully invoiced → the order is done
        const fresh = await tx.salesOrderItem.findMany({ where: { salesOrderId: so.id } })
        const done = fresh.length > 0 && fresh.every((si) =>
          r2(si.dispatchedQty) >= r2(si.qty) - 0.005 && r2(si.invoicedQty) >= r2(si.qty) - 0.005)
        if (done) {
          const soNow = await tx.salesOrder.findUnique({ where: { id: so.id }, select: { status: true } })
          if (soNow && soNow.status === 'DISPATCHED') await claimStatus(t.salesOrder, so.id, ['DISPATCHED'], 'COMPLETED')
        }
      }

      await logAudit(t, {
        companyId, userName: body.userName, action: 'CREATE', entity: 'SalesInvoice', entityId: inv.id,
        details: `Tax invoice ${number} for ${party.name}${isCashSale ? ' (cash sale)' : ''} • ₹${totals.grandTotal}${so ? ` against ${so.number}` : ''}${challan ? ` / ${challan.number}` : ''}${receiptNo ? ` • received ₹${paid} ${receivedMode} (${receiptNo})` : ''}${deductStock ? ' • stock deducted' : ''}`,
      })
      // The response is built inside the transaction so an Idempotency-Key replay returns exactly it
      const full = await tx.salesInvoice.findFirst({
        where: { id: inv.id, companyId },
        include: {
          customer: { select: { name: true, gstin: true, state: true, stateCode: true } },
          salesOrder: { select: { number: true } },
          items: true,
        },
      })
      const [row] = await withItemInfo(companyId, full ? [full] : [], tx) // through tx: no second pool connection
      await idem!.done(tx, row, 'Invoice created')
      return row
    })

    return ok(created, 'Invoice created')
  } catch (e) {
    await idem?.release()
    return handleError(e)
  }
}
