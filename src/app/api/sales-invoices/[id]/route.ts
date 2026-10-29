import { db } from '@/lib/db'
import { requireSecurityPin } from '@/lib/security-pin'
import { businessDate } from '@/lib/business-date'
import { ok, fail, handleError, companyRequired, nextDocNumber, computeGst, isInterState, computeBillTotals, isInterStateParty, logAudit, notify, ApiError, r2, requireWrite, requireRead } from '@/lib/erp-helpers'
import { optStr, optNum, gstRateOf, parseLine, withMasterInfo, resolveStockWarehouse, postSaleStock, reverseSaleStock } from '../shared'

// SalesInvoiceItem carries only itemId (no Prisma relation to Item) — attach master info via JS mapping
async function withItemInfo<T extends { items: { itemId: string }[] }>(companyId: string, docs: T[]) {
  const ids = Array.from(new Set(docs.flatMap((d) => d.items.map((i) => i.itemId))))
  const masters = ids.length
    ? await db.item.findMany({ where: { companyId, id: { in: ids } }, select: { id: true, code: true, name: true, uom: true, hsn: true } })
    : []
  const map = new Map(masters.map((m) => [m.id, m]))
  return docs.map((d) => ({ ...d, items: d.items.map((i) => ({ ...i, item: map.get(i.itemId) || null })) }))
}

// Mock e-invoice gateway helpers
function randomHex(byteCount: number): string {
  const buf = new Uint8Array(byteCount)
  crypto.getRandomValues(buf)
  return Array.from(buf).map((b) => b.toString(16).padStart(2, '0')).join('')
}
function generateIrn(): string {
  return 'IRN' + randomHex(20) // IRN + 40 hex chars
}
function generateEwayBillNo(): string {
  const buf = new Uint32Array(1)
  crypto.getRandomValues(buf)
  return String(100000000000 + (buf[0] % 900000000000)) // 12-digit number
}

// GET /api/sales-invoices/[id]?companyId=  — full detail incl customer + hsn (used for GST invoice print)
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireRead(req, ['sales-invoices', 'receivables', 'gst-report']) // Phase 5: financial read permission
    const { id } = await params
    const companyId = await companyRequired(req)
    const invoice = await db.salesInvoice.findFirst({
      where: { id, companyId },
      include: {
        customer: true,
        salesOrder: { select: { id: true, number: true, orderDate: true } },
        items: true,
      },
    })
    if (!invoice) throw new ApiError('Invoice not found', 404)
    const [company, printAccount] = await Promise.all([
      db.company.findUnique({
        where: { id: companyId },
        select: { name: true, gstin: true, pan: true, addressLine: true, city: true, state: true, stateCode: true, phone: true, email: true, logoText: true, logoImage: true, signatureImage: true, bankAccountName: true, bankAccountNumber: true, bankIfsc: true, bankUpiId: true, bankName: true, bankBranch: true, invoiceTerms: true },
      }),
      // Cash & Bank account flagged "print on invoice" — its UPI id is the fallback for the pay QR
      db.moneyAccount.findFirst({
        where: { companyId, type: 'BANK', active: true, printOnInvoice: true },
        select: { upiId: true },
      }),
    ])
    // UPI payee for the "scan to pay" QR on prints: company UPI id, else the print-on-invoice bank account's
    const upiId = (company?.bankUpiId || printAccount?.upiId || '').trim()
    const upi = upiId ? { id: upiId, payeeName: company?.name || '' } : null
    // Qty already taken back on live sales returns, per invoice line (drives the Sales Return form)
    const returned = await db.salesReturnItem.findMany({
      where: { invoiceItemId: { in: invoice.items.map((i) => i.id) }, ret: { companyId, status: { not: 'CANCELLED' } } },
      select: { invoiceItemId: true, qty: true },
    })
    const retMap = new Map<string, number>()
    for (const r of returned) if (r.invoiceItemId) retMap.set(r.invoiceItemId, r2((retMap.get(r.invoiceItemId) || 0) + r.qty))
    const withReturned = { ...invoice, company, upi, items: invoice.items.map((i) => ({ ...i, returnedQty: retMap.get(i.id) || 0 })) }
    const [row] = await withItemInfo(companyId, [withReturned])
    return ok(row)
  } catch (e) {
    return handleError(e)
  }
}

// PATCH /api/sales-invoices/[id]
//  - { action: 'cancel' }          : → CANCELLED (blocked if paidAmount > 0); direct-sale stock goes back in
//  - { action: 'edit', ...same body as POST } : re-bill an UNPAID direct invoice in place (same number) — see below
//  - { action: 'generate-irn' }    : mock E-Invoice/EWB gateway → sets irn + ewayBillNo
//  - { irn?, ewayBillNo? }         : direct set (e.g. from real gateway response)
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireWrite(req, 'sales-invoices')
    const { id } = await params
    const body = await req.json().catch(() => ({}) as any)
    const companyId = await companyRequired(req, body.companyId)
    if (body.action === 'cancel' || body.action === 'edit' || body.irn !== undefined || body.ewayBillNo !== undefined) await requireSecurityPin(req, companyId)

    const current = await db.salesInvoice.findFirst({ where: { id, companyId } })
    if (!current) throw new ApiError('Invoice not found', 404)
    if (current.status === 'CANCELLED') throw new ApiError('Invoice is cancelled', 400)

    // ---- Cancel ----
    if (body.action === 'cancel') {
      if (current.paidAmount > 0.005) throw new ApiError('Cannot cancel invoice with payments recorded', 400)
      const liveReturns = await db.salesReturn.count({ where: { companyId, invoiceId: id, status: { not: 'CANCELLED' } } })
      if (liveReturns > 0) throw new ApiError('Cancel the sales returns (credit notes) against this invoice first', 400)
      const updated = await db.$transaction(async (tx) => {
        const t = tx as any
        // Atomic claim: only while still unpaid, so a payment landing concurrently can't be lost
        const claim = await tx.salesInvoice.updateMany({
          where: { id, status: { in: ['UNPAID', 'PARTIALLY_PAID', 'PAID'] }, paidAmount: { lte: 0.005 } },
          data: { status: 'CANCELLED' },
        })
        if (claim.count !== 1) throw new ApiError('This invoice was just changed (payment or cancel) — refresh and try again', 409)

        // Roll back SO invoicedQty (POST increments it; it does not change SO status)
        if (current.salesOrderId) {
          const invItems = await tx.salesInvoiceItem.findMany({ where: { invoiceId: id } })
          const soItems = await tx.salesOrderItem.findMany({ where: { salesOrderId: current.salesOrderId } })
          const byItem = new Map<string, number>()
          for (const l of invItems) byItem.set(l.itemId, r2((byItem.get(l.itemId) || 0) + l.qty))
          // Reverse SO line order — mirrors the forward allocation in POST
          for (const si of [...soItems].reverse()) {
            const want = byItem.get(si.itemId)
            if (!want) continue
            const back = Math.min(want, Math.max(0, r2(si.invoicedQty)))
            if (back > 0) {
              await tx.salesOrderItem.update({ where: { id: si.id }, data: { invoicedQty: { decrement: back } } })
              byItem.set(si.itemId, r2(want - back))
            }
          }
        }

        // Direct sale that took goods out of stock → put them back into the same warehouse
        if (current.deductStock && current.stockWarehouseId) {
          // Same warehouse, back into the batch(es) it was drawn from; sold serials back in stock
          await reverseSaleStock(tx, {
            companyId, invoiceId: id, number: current.number, warehouseId: current.stockWarehouseId,
            note: `Invoice ${current.number} cancelled — stock returned`, fallbackBatchNo: `CANCEL-${current.number}`,
          })
        }

        const u = await tx.salesInvoice.findUniqueOrThrow({ where: { id } })
        await logAudit(t, {
          companyId, userName: body.userName, action: 'CANCEL', entity: 'SalesInvoice', entityId: id,
          details: `Cancelled tax invoice ${current.number}${current.deductStock ? ' • stock returned' : ''}`,
        })
        return u
      })
      return ok(updated, 'Invoice cancelled')
    }

    // ---- Edit (Vyapar-style: correct a saved bill, keep its number) ----
    // Only an UNPAID invoice with no payments, no live sales returns, no IRN and not billed from a
    // sales order / challan (those move SO invoiced qty — cancel and re-create them instead).
    // One transaction: put back any stock it took (batches + serials), replace the lines, recompute
    // totals exactly like POST, take the stock out again when deductStock is (still) on.
    if (body.action === 'edit') {
      if (current.salesOrderId || current.challanId) {
        throw new ApiError('This invoice was billed from a sales order / delivery challan — cancel it and create a new invoice instead of editing', 400)
      }
      if (current.status !== 'UNPAID' || current.paidAmount > 0.005) throw new ApiError('Only an unpaid invoice with no payments recorded can be edited', 400)
      if (current.irn) throw new ApiError('An e-invoice (IRN) is already generated for this invoice — cancel it and create a new one instead', 400)
      const liveReturns = await db.salesReturn.count({ where: { companyId, invoiceId: id, status: { not: 'CANCELLED' } } })
      if (liveReturns > 0) throw new ApiError('This invoice has sales returns (credit notes) — it cannot be edited', 400)

      const company = await db.company.findUnique({ where: { id: companyId } })
      if (!company) throw new ApiError('Company not found', 404)
      // Cash sales stay on the walk-in customer; other invoices may move to another customer
      const isCashSale = current.isCashSale
      const customerId = isCashSale ? current.customerId : String(body.customerId || current.customerId)
      const customer = await db.customer.findFirst({ where: { id: customerId, companyId } })
      if (!customer) throw new ApiError('Customer not found', 404)
      const customerChanged = customerId !== current.customerId

      const rawLines: any[] = Array.isArray(body.lines) ? body.lines : Array.isArray(body.items) ? body.items : []
      if (!rawLines.length) throw new ApiError('Add at least one line', 400)
      // rate kept at 4 dp (see parseLine); HSN + default cess % from the item master
      const master = await withMasterInfo(companyId, rawLines.map((l) => parseLine(l)))
      const lines = master.lines
      const hsnMap = master.hsnMap

      const deductStock = body.deductStock === undefined ? current.deductStock : (body.deductStock === true || body.deductStock === 'true')
      const stockWarehouseId: string | null = deductStock
        ? await resolveStockWarehouse(companyId, body.stockWarehouseId || current.stockWarehouseId)
        : null

      // Business day in India (UTC midnight of the IST day)
      const date = body.date ? businessDate(body.date, 'date') : current.date
      const dueDate = body.dueDate ? new Date(body.dueDate) : current.dueDate
      if (dueDate && isNaN(dueDate.getTime())) throw new ApiError('dueDate is not a valid date', 400)
      const placeOfSupply = optStr(body.placeOfSupply) ?? (customerChanged ? customer.state ?? null : current.placeOfSupply)
      const customerPoDate = body.customerPoDate ? new Date(body.customerPoDate) : null
      if (customerPoDate && isNaN(customerPoDate.getTime())) throw new ApiError('customerPoDate is not a valid date', 400)

      const interState = isCashSale ? false : isInterStateParty(company, customer)
      const freightGstRate = gstRateOf(body.freightGstRate, 'Freight GST %')
      const packingGstRate = gstRateOf(body.packingGstRate, 'Packing GST %')
      const totals = computeBillTotals(lines, interState, {
        billDiscount: optNum(body.billDiscount, 'Bill discount', 0),
        freight: { amount: optNum(body.freightCharge, 'Freight', 0), gstRate: freightGstRate },
        packing: { amount: optNum(body.packingCharge, 'Packing', 0), gstRate: packingGstRate },
        roundOff: company.roundOffTotals ?? true,
      })

      await db.$transaction(async (tx) => {
        const t = tx as any
        // Atomic claim (row lock): only while still unpaid, so a payment landing concurrently can't slip in
        const claim = await tx.salesInvoice.updateMany({
          where: { id, companyId, status: 'UNPAID', paidAmount: { lte: 0.005 }, salesOrderId: null, challanId: null },
          data: { updatedAt: new Date() },
        })
        if (claim.count !== 1) throw new ApiError('This invoice was just changed (payment or cancel) — refresh and try again', 409)
        const lateReturns = await tx.salesReturn.count({ where: { companyId, invoiceId: id, status: { not: 'CANCELLED' } } })
        if (lateReturns > 0) throw new ApiError('This invoice has sales returns (credit notes) — it cannot be edited', 400)

        // 1) Stock the old lines took goes back (same warehouse, batches, serials)
        if (current.deductStock && current.stockWarehouseId) {
          await reverseSaleStock(tx, {
            companyId, invoiceId: id, number: current.number, warehouseId: current.stockWarehouseId,
            note: `Invoice ${current.number} edited — previous lines returned to stock`, fallbackBatchNo: `EDIT-${current.number}`,
          })
        }

        // 2) Replace the lines and the header (number unchanged)
        await tx.salesInvoiceItem.deleteMany({ where: { invoiceId: id } })
        await tx.salesInvoice.update({
          where: { id },
          data: {
            customerId,
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
                // the requested batch / serials; the batch actually drawn is written back by postSaleStock
                ...(deductStock ? { batchNo: l.batchNo ?? null, serials: l.serials ?? null } : {}),
              })),
            },
          },
        })

        // 3) Goods leave stock again for the new lines
        if (deductStock && stockWarehouseId) {
          await postSaleStock(tx, {
            companyId, invoiceId: id, number: current.number, date, warehouseId: stockWarehouseId, lines,
            note: `Sold on invoice ${current.number} (edited)`,
          })
        }

        await logAudit(t, {
          companyId, userName: body.userName, action: 'UPDATE', entity: 'SalesInvoice', entityId: id,
          details: `Edited tax invoice ${current.number} • ₹${current.grandTotal} → ₹${totals.grandTotal} • ${lines.length} line(s)${customerChanged ? ` • customer → ${customer.name}` : ''}${current.deductStock || deductStock ? ' • stock re-posted' : ''}`,
        })
      })
      const full = await db.salesInvoice.findFirst({
        where: { id, companyId },
        include: { customer: { select: { name: true, gstin: true, state: true, stateCode: true } }, salesOrder: { select: { number: true } }, items: true },
      })
      if (!full) throw new ApiError('Invoice not found', 404)
      const [row] = await withItemInfo(companyId, [full])
      return ok(row, 'Invoice updated')
    }

    // ---- Generate IRN (mock integration) ----
    if (body.action === 'generate-irn') {
      if (current.irn) throw new ApiError('IRN already generated for this invoice', 400)
      const irn = generateIrn()
      const ewayBillNo = generateEwayBillNo()
      const updated = await db.$transaction(async (tx) => {
        const t = tx as any
        // Only while no IRN is set and the invoice is live
        const set = await tx.salesInvoice.updateMany({
          where: { id, status: { not: 'CANCELLED' }, OR: [{ irn: null }, { irn: '' }] },
          data: { irn, ewayBillNo },
        })
        if (set.count !== 1) throw new ApiError('This invoice was just changed by someone else — refresh and try again', 409)
        const u = await tx.salesInvoice.findUniqueOrThrow({ where: { id } })
        await logAudit(t, {
          companyId, userName: body.userName, action: 'POST', entity: 'SalesInvoice', entityId: id,
          details: `E-Invoice generated (mock gateway) for ${current.number} • IRN ${irn} • EWB ${ewayBillNo}`,
        })
        return u
      })
      return ok(updated, 'IRN + E-Way Bill generated')
    }

    // ---- Direct set of gateway fields (only fills empty fields; never overwrites) ----
    if (body.irn !== undefined || body.ewayBillNo !== undefined) {
      const irn = typeof body.irn === 'string' ? body.irn.trim() : ''
      const ewb = typeof body.ewayBillNo === 'string' ? body.ewayBillNo.trim() : ''
      if (body.irn !== undefined && !irn) throw new ApiError('irn must be a non-empty string', 400)
      if (body.ewayBillNo !== undefined && !ewb) throw new ApiError('ewayBillNo must be a non-empty string', 400)
      if (irn && current.irn) throw new ApiError('IRN is already set on this invoice and cannot be changed', 400)
      if (ewb && current.ewayBillNo) throw new ApiError('E-Way Bill no. is already set on this invoice and cannot be changed', 400)
      const data: any = {}
      const where: any = { id, status: { not: 'CANCELLED' }, AND: [] as any[] }
      if (irn) { data.irn = irn; where.AND.push({ OR: [{ irn: null }, { irn: '' }] }) }
      if (ewb) { data.ewayBillNo = ewb; where.AND.push({ OR: [{ ewayBillNo: null }, { ewayBillNo: '' }] }) }
      const updated = await db.$transaction(async (tx) => {
        const t = tx as any
        const set = await tx.salesInvoice.updateMany({ where, data })
        if (set.count !== 1) throw new ApiError('This invoice was just changed by someone else — refresh and try again', 409)
        const u = await tx.salesInvoice.findUniqueOrThrow({ where: { id } })
        await logAudit(t, {
          companyId, userName: body.userName, action: 'UPDATE', entity: 'SalesInvoice', entityId: id,
          details: `Updated e-invoice refs on ${current.number}`,
        })
        return u
      })
      return ok(updated, 'Invoice updated')
    }

    throw new ApiError('Nothing to update — use action=cancel | edit | generate-irn, or send irn/ewayBillNo', 400)
  } catch (e) {
    return handleError(e)
  }
}

// NOTE: no DELETE — tax invoices are cancelled, never deleted.
