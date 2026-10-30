import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import {
  ok, handleError, companyRequired, nextDocNumber, computeBillTotals, isInterStateParty, logAudit, ApiError, requireWrite, requireRead,
} from '@/lib/erp-helpers'
import { PAYMENT_MODES } from '@/lib/erp-constants'
import { assertOnOrAfterOpening, chequeDetails, ensureCashFor, postingAccount } from '@/lib/accounts'
import { businessDate } from '@/lib/business-date'
import { CASH_TX, assertCashNotNegative, negativeCashOverride } from '@/lib/cash-guard'
import { claimIdempotency, type Idempotency } from '@/lib/idempotency'
import { joinSerials, parseSerials } from '@/lib/batches'
import { billTaxLines, gstPct, num, receiveBillStock, receiveWarehouse, toDate, trackingFlags, type PinvLineInput } from './_bill'

// prisma 6.x generated delegates are not structurally assignable to the shared helpers' minimal
// tx types — intersect once and cast the transaction client at the boundary.
type HelperTx = Prisma.TransactionClient & Parameters<typeof nextDocNumber>[0] & Parameters<typeof logAudit>[0]

// Line items carry only itemId (no Item relation in schema) — attach {code,name,uom} for the UI.
async function attachItemInfo<T extends { items: { itemId: string }[] }>(companyId: string, docs: T[], client: Pick<typeof db, 'item'> = db) {
  const ids = Array.from(new Set(docs.flatMap((d) => d.items.map((i) => i.itemId))))
  const items = ids.length
    ? await client.item.findMany({ where: { companyId, id: { in: ids } }, select: { id: true, code: true, name: true, uom: true } })
    : []
  const map = new Map(items.map((i) => [i.id, i]))
  return docs.map((d) => ({ ...d, items: d.items.map((i) => ({ ...i, item: map.get(i.itemId) || null })) }))
}

// ============================== GET /api/purchase-invoices ==============================
export async function GET(req: Request) {
  try {
    requireRead(req, ['purchase-invoices', 'payables', 'gst-report']) // Phase 5: financial read permission
    const companyId = await companyRequired(req)
    const { searchParams } = new URL(req.url)
    const status = searchParams.get('status') || ''
    const q = searchParams.get('q') || ''
    const where: Prisma.PurchaseInvoiceWhereInput = { companyId }
    if (status) where.status = status
    if (q) {
      where.OR = [
        { number: { contains: q } },
        { supplierInvNo: { contains: q } },
        { supplier: { is: { name: { contains: q } } } },
        { po: { is: { number: { contains: q } } } },
      ]
    }
    const rows = await db.purchaseInvoice.findMany({
      where,
      orderBy: { date: 'desc' },
      include: {
        supplier: { select: { id: true, code: true, name: true } },
        po: { select: { id: true, number: true } },
        items: true,
      },
    })
    return ok({ items: await attachItemInfo(companyId, rows), total: rows.length })
  } catch (e) {
    return handleError(e)
  }
}

// ============================== POST /api/purchase-invoices ==============================
export async function POST(req: Request) {
  let idem: Idempotency | null = null
  try {
    requireWrite(req, 'purchase-invoices')
    const body = await req.json()
    const companyId = await companyRequired(req, body.companyId)
    // Business day in India (UTC midnight of the IST day) — same rule as its payment and the reports
    const date = businessDate(body.date, 'date')
    // Bill-level discount and taxable charges (GST on freight / packing at their own rates)
    const billDiscount = num(body.billDiscount, 'Bill discount')
    const freightCharge = num(body.freightCharge, 'Freight')
    const freightGstRate = gstPct(body.freightGstRate, 'Freight GST')
    const packingCharge = num(body.packingCharge, 'Packing')
    const packingGstRate = gstPct(body.packingGstRate, 'Packing GST')
    // Amount paid to the supplier along with this bill (recorded as a Payment). Named `paidNow`
    // so it never clashes with the bill's running `paidAmount`.
    const paidNow = num(body.paidNow, 'Paid now')
    const payMode = String(body.paymentMode || body.mode || 'CASH')
    if (paidNow > 0 && !(PAYMENT_MODES as readonly string[]).includes(payMode)) {
      throw new ApiError(`Payment mode must be one of ${PAYMENT_MODES.join(', ')}`, 400)
    }

    const override = negativeCashOverride(req, body)
    idem = await claimIdempotency(req, companyId, 'POST /api/purchase-invoices', body)
    if (idem.replay) return idem.replay
    if (paidNow > 0) await ensureCashFor(companyId, payMode, body.accountId ? String(body.accountId) : null)
    const pinv = await db.$transaction(async (txRaw) => {
      const tx = txRaw as HelperTx
      // Resolve PO first (its items seed the invoice lines when no explicit lines are sent)
      let po: {
        id: string; number: string; supplierId: string; status: string
        items: { itemId: string; qty: number; rate: number; gstRate: number }[]
      } | null = null
      // Optional GRN link — the bill for one specific receipt. Its PO is implied when poId is omitted.
      let grn: { id: string; number: string; poId: string } | null = null
      if (body.grnId) {
        grn = await tx.grn.findFirst({ where: { id: String(body.grnId), companyId }, select: { id: true, number: true, poId: true } })
        if (!grn) throw new ApiError('GRN not found', 404)
        if (body.poId && grn.poId !== body.poId) throw new ApiError(`GRN ${grn.number} does not belong to the selected purchase order`, 400)
        // Row-lock the GRN (status-guarded touch) so two bills for the same receipt serialise here
        const lock = await tx.grn.updateMany({
          where: { id: grn.id, companyId, status: { in: ['POSTED', 'PARTIALLY_ACCEPTED'] } },
          data: { updatedAt: new Date() },
        })
        if (lock.count !== 1) throw new ApiError(`GRN ${grn.number} must be posted to stock before it can be billed`, 400)
        const linked = await tx.purchaseInvoice.findFirst({
          where: { companyId, grnId: grn.id, status: { not: 'CANCELLED' } }, select: { number: true },
        })
        if (linked) throw new ApiError(`GRN ${grn.number} is already billed on ${linked.number}`, 409)
      }
      const poId = body.poId || (grn ? grn.poId : null)
      if (poId) {
        po = await tx.purchaseOrder.findFirst({ where: { id: poId, companyId }, include: { items: true } })
        if (!po) throw new ApiError('Purchase order not found', 404)
      }

      // Accept `lines` (API clients) or `items` (the ERP form)
      const rawLines = Array.isArray(body.lines) && body.lines.length ? body.lines : Array.isArray(body.items) ? body.items : []
      let lines: PinvLineInput[] = rawLines
      if (!lines.length && po) {
        // Full item qty invoiced per PO line
        lines = po.items.map((p) => ({ itemId: p.itemId, qty: p.qty, rate: p.rate, gstRate: p.gstRate }))
      }
      const { ids, taxLines } = await billTaxLines(tx, companyId, lines)

      const supplierId = body.supplierId || (po ? po.supplierId : null)
      if (!supplierId) throw new ApiError('supplierId is required', 400)
      const supplier = await tx.supplier.findFirst({ where: { id: supplierId, companyId } })
      if (!supplier) throw new ApiError('Supplier not found', 404)
      const company = await tx.company.findUnique({ where: { id: companyId } })
      if (!company) throw new ApiError('Company not found', 404)

      const interState = isInterStateParty(company ?? {}, supplier ?? {})
      const totals = computeBillTotals(taxLines, interState, {
        billDiscount,
        freight: { amount: freightCharge, gstRate: freightGstRate },
        packing: { amount: packingCharge, gstRate: packingGstRate },
        roundOff: company.roundOffTotals ?? true,
      })
      if (paidNow > totals.grandTotal + 0.01) {
        throw new ApiError(`Paid amount (₹${paidNow.toFixed(2)}) exceeds the bill total (₹${totals.grandTotal.toFixed(2)})`, 400)
      }
      const number = await nextDocNumber(tx, companyId, 'PINV', date)
      // Due date: explicit, else invoice date + supplier credit terms
      let dueDate = toDate(body.dueDate)
      if (!dueDate) {
        dueDate = new Date(date)
        dueDate.setDate(dueDate.getDate() + (Number(supplier.paymentTermsDays) || 0))
      }
      if (dueDate.toISOString().slice(0, 10) < date.toISOString().slice(0, 10)) throw new ApiError('Due date cannot be before the invoice date', 400)

      const directReceive = !!body.receiveStock && !po && !grn
      // Tracking flags (direct receive only): batch-tracked lines default to the bill number as batch
      const flags = directReceive ? await trackingFlags(tx, companyId, ids) : new Map<string, { batch: boolean; serial: boolean }>()
      const created = await tx.purchaseInvoice.create({
        data: {
          companyId,
          number,
          poId: po ? po.id : null,
          grnId: grn ? grn.id : null,
          supplierId: supplier.id,
          date,
          supplierInvNo: body.supplierInvNo || null,
          supplierInvDate: toDate(body.supplierInvDate),
          dueDate,
          isInterState: interState,
          // Buyer pays the tax (Sec 9(3)/9(4)) — GSTR-3B reports it under 3.1(d) and the ITC is claimable.
          reverseCharge: !!body.reverseCharge,
          subtotal: totals.subtotal,
          discountTotal: totals.discountTotal,
          cgst: totals.cgst,
          sgst: totals.sgst,
          igst: totals.igst,
          grandTotal: totals.grandTotal,
          billDiscount: totals.billDiscount,
          freightCharge: totals.freight,
          freightGstRate,
          packingCharge: totals.packing,
          packingGstRate,
          roundOff: totals.roundOff,
          cess: totals.cess,
          status: 'UNPAID',
          notes: body.notes || null,
          items: {
            create: totals.computed.map((c, idx) => ({
              itemId: lines[idx].itemId as string,
              qty: c.qty,
              rate: c.rate,
              gstRate: c.gstRate,
              cessRate: c.cessRate || 0,
              lineTotal: c.taxable, // final taxable value (after the pro-rata bill discount)
              // tracking details are kept only when the bill itself receives the goods
              ...(flags.get(lines[idx].itemId as string)?.batch ? {
                batchNo: String(lines[idx].batchNo || '').trim() || number,
                mfgDate: toDate(lines[idx].mfgDate),
                expiryDate: toDate(lines[idx].expiryDate),
              } : {}),
              ...(flags.get(lines[idx].itemId as string)?.serial ? { serials: joinSerials(parseSerials(lines[idx].serials)) } : {}),
            })),
          },
        },
        include: { items: true },
      })

      // Paid with the bill: one Payment row for the amount, bill paidAmount + status updated with it
      let bill = created
      if (paidNow > 0) {
        // Paid on the bill's business day (IST) from a chosen (existing, active) or default account
        const payDate = businessDate(date)
        const payAccount = await postingAccount(tx, companyId, payMode, body.accountId ? String(body.accountId) : null)
        assertOnOrAfterOpening(payAccount, payDate, 'The amount paid')
        const payAccountId = payAccount.id
        const payNumber = await nextDocNumber(tx, companyId, 'PYMT', payDate)
        await tx.payment.create({
          data: {
            companyId, number: payNumber, type: 'PAYMENT', partyType: 'SUPPLIER', supplierId: supplier.id,
            invoiceType: 'PURCHASE', invoiceId: created.id, amount: paidNow, mode: payMode, date: payDate, accountId: payAccountId,
            ...chequeDetails(payMode, body.chequeNo, body.chequeDate),
            reference: body.paymentReference ? String(body.paymentReference) : null,
            notes: `Paid with bill ${number}`,
          },
        })
        bill = await tx.purchaseInvoice.update({
          where: { id: created.id },
          data: { paidAmount: paidNow, accountId: payAccountId, status: totals.grandTotal - paidNow <= 0.01 ? 'PAID' : 'PARTIALLY_PAID' },
          include: { items: true },
        })
      }

      // PO → INVOICED only when fully received already; otherwise leave PO status untouched
      // Direct purchase (no PO / GRN): optionally receive the goods into stock with this bill.
      // Bills from a PO or GRN never post stock — the GRN already did.
      if (directReceive) {
        const wh = await receiveWarehouse(tx, companyId, body.warehouseId ? String(body.warehouseId) : null)
        await receiveBillStock(tx, { companyId, warehouseId: wh.id, date, bill: created, supplierInvNo: body.supplierInvNo || null })
      }

      if (po && po.status === 'RECEIVED') {
        await tx.purchaseOrder.update({ where: { id: po.id }, data: { status: 'INVOICED' } })
      }

      await logAudit(tx, {
        companyId, userName: body.userName, action: 'CREATE', entity: 'PurchaseInvoice',
        entityId: created.id,
        details: `Created ${number} for ${supplier.name}${po ? ` (PO ${po.number})` : ''}${grn ? ` (GRN ${grn.number})` : ''} — grand total ${totals.grandTotal}${paidNow > 0 ? `, paid ₹${paidNow.toFixed(2)} (${payMode})` : ''}`,
      })
      // Phase 5: the amount paid with the bill must not take cash below zero (last step: locks the cash account)
      if (paidNow > 0 && bill.accountId) {
        await assertCashNotNegative(tx, { companyId, accounts: [{ accountId: bill.accountId }], from: businessDate(date), override, what: `The amount paid with ${number}`, entity: 'PurchaseInvoice', entityId: created.id, userName: body.userName })
      }
      // The response is built inside the transaction so an Idempotency-Key replay returns exactly it
      const [row] = await attachItemInfo(companyId, [bill], tx) // through tx: no second pool connection
      await idem!.done(tx, row, 'Purchase invoice created')
      return row
    }, paidNow > 0 ? CASH_TX : undefined)
    return ok(pinv, 'Purchase invoice created')
  } catch (e) {
    await idem?.release()
    return handleError(e)
  }
}
