import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { requireSecurityPin } from '@/lib/security-pin'
import { ok, handleError, companyRequired, logAudit, ApiError, r2, requireWrite, computeBillTotals, isInterStateParty, requireRead } from '@/lib/erp-helpers'
import { joinSerials, parseSerials } from '@/lib/batches'
import { businessDate } from '@/lib/business-date'
import {
  billTaxLines, gstPct, liveReceipts, num, receiveBillStock, receiveWarehouse, reverseBillStock, toDate, trackingFlags, type PinvLineInput,
} from '../_bill'

// prisma 6.x generated delegates are not structurally assignable to the shared helpers' minimal
// tx types — intersect once and cast the transaction client at the boundary.
type HelperTx = Prisma.TransactionClient & Parameters<typeof logAudit>[0]

async function attachItemInfo<T extends { items: { itemId: string }[] }>(companyId: string, docs: T[]) {
  const ids = Array.from(new Set(docs.flatMap((d) => d.items.map((i) => i.itemId))))
  const items = ids.length
    ? await db.item.findMany({ where: { companyId, id: { in: ids } }, select: { id: true, code: true, name: true, uom: true } })
    : []
  const map = new Map(items.map((i) => [i.id, i]))
  return docs.map((d) => ({ ...d, items: d.items.map((i) => ({ ...i, item: map.get(i.itemId) || null })) }))
}

async function findInvoice(id: string, companyId: string) {
  const pinv = await db.purchaseInvoice.findFirst({
    where: { id, companyId },
    include: {
      supplier: { select: { id: true, code: true, name: true, gstin: true, state: true, stateCode: true, paymentTermsDays: true } },
      po: { select: { id: true, number: true, status: true } },
      items: true,
    },
  })
  if (!pinv) throw new ApiError('Purchase invoice not found', 404)
  return pinv
}

// ============================== GET /api/purchase-invoices/[id] ==============================
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireRead(req, ['purchase-invoices', 'payables', 'gst-report']) // Phase 5: financial read permission
    const { id } = await params
    const companyId = await companyRequired(req)
    const pinv = await findInvoice(id, companyId)
    const [row] = await attachItemInfo(companyId, [pinv])
    // Direct bills that put the goods into stock: where they went (the edit form re-receives there)
    const live = pinv.poId || pinv.grnId || pinv.status === 'CANCELLED' ? [] : await liveReceipts(db, companyId, pinv.id)
    return ok({ ...row, receivedStock: live.length > 0, receivedWarehouseId: live[0]?.warehouseId ?? null })
  } catch (e) {
    return handleError(e)
  }
}

// ============================== PATCH /api/purchase-invoices/[id] — action=cancel | edit ==============================
// edit: same body as POST (lines/items, date, dueDate, supplierInvNo/Date, billDiscount, freight/packing, notes,
// receiveStock + warehouseId). Only for direct bills (no PO / GRN) with no payments and no purchase returns.
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireWrite(req, 'purchase-invoices')
    const { id } = await params
    const body = await req.json()
    const companyId = await companyRequired(req, body.companyId)
    await requireSecurityPin(req, companyId)
    const pinv = await findInvoice(id, companyId)

    if (body.action === 'edit') return ok(await editInvoice(body, companyId, pinv), 'Purchase invoice updated')
    if (body.action !== 'cancel') throw new ApiError(`Unknown action '${body.action}' (use cancel or edit)`, 400)
    if (pinv.status === 'CANCELLED') throw new ApiError('Invoice is already cancelled', 400)
    if (pinv.paidAmount > 0) throw new ApiError('Cannot cancel: payments already recorded against this invoice', 400)

    const updated = await db.$transaction(async (txRaw) => {
      const tx = txRaw as HelperTx
      // Atomic claim: only while still unpaid, so a payment landing concurrently can't be lost
      const claim = await tx.purchaseInvoice.updateMany({
        where: { id: pinv.id, status: { in: ['UNPAID', 'PARTIALLY_PAID', 'PAID'] }, paidAmount: { lte: 0.005 } },
        data: { status: 'CANCELLED' },
      })
      if (claim.count !== 1) throw new ApiError('This invoice was just changed (payment or cancel) — refresh and try again', 409)
      // Bill that received stock directly: take that stock back out (fails if it was already used)
      await reverseBillStock(tx, { companyId, bill: pinv, note: `Reversed: bill ${pinv.number} cancelled` })
      // POST moved a fully-received PO to INVOICED — revert when no other live invoice remains
      if (pinv.poId) {
        const others = await tx.purchaseInvoice.count({ where: { poId: pinv.poId, status: { not: 'CANCELLED' } } })
        if (!others) await tx.purchaseOrder.updateMany({ where: { id: pinv.poId, status: 'INVOICED' }, data: { status: 'RECEIVED' } })
      }
      const u = await tx.purchaseInvoice.findUniqueOrThrow({ where: { id: pinv.id }, include: { items: true } })
      await logAudit(tx, {
        companyId, userName: body.userName, action: 'CANCEL', entity: 'PurchaseInvoice',
        entityId: pinv.id, details: `Cancelled ${pinv.number} (grand total ${r2(pinv.grandTotal)})`,
      })
      return u
    })
    return ok(updated, 'Purchase invoice cancelled')
  } catch (e) {
    return handleError(e)
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function editInvoice(body: any, companyId: string, pinv: Awaited<ReturnType<typeof findInvoice>>) {
  if (pinv.status === 'CANCELLED') throw new ApiError('A cancelled bill cannot be edited', 400)
  if (pinv.poId || pinv.grnId) {
    const src = pinv.grnId ? 'GRN' : 'purchase order'
    throw new ApiError(
      `${pinv.number} was created from a ${src} — its lines are tied to that ${src}. Cancel the bill and create it again instead of editing.`,
      400,
    )
  }
  if (pinv.paidAmount > 0.005) throw new ApiError('Cannot edit: payments are already recorded against this bill', 400)

  // Omitted fields keep the bill's current values
  const keep = <T,>(v: unknown, current: T, parse: (x: unknown) => T): T => (v === undefined ? current : parse(v))
  // Business day in India (UTC midnight of the IST day)
  const date = body.date ? businessDate(body.date, 'date') : pinv.date
  const billDiscount = keep(body.billDiscount, pinv.billDiscount, (v) => num(v, 'Bill discount'))
  const freightCharge = keep(body.freightCharge, pinv.freightCharge, (v) => num(v, 'Freight'))
  const freightGstRate = keep(body.freightGstRate, pinv.freightGstRate, (v) => gstPct(v, 'Freight GST'))
  const packingCharge = keep(body.packingCharge, pinv.packingCharge, (v) => num(v, 'Packing'))
  const packingGstRate = keep(body.packingGstRate, pinv.packingGstRate, (v) => gstPct(v, 'Packing GST'))
  const rawLines: PinvLineInput[] = Array.isArray(body.lines) && body.lines.length ? body.lines : Array.isArray(body.items) ? body.items : []

  const updated = await db.$transaction(async (txRaw) => {
    const tx = txRaw as HelperTx
    // Row-lock the bill while it is still unpaid, so a payment / cancel can't slip in between
    const claim = await tx.purchaseInvoice.updateMany({
      where: { id: pinv.id, status: { in: ['UNPAID', 'PARTIALLY_PAID', 'PAID'] }, paidAmount: { lte: 0.005 } },
      data: { updatedAt: new Date() },
    })
    if (claim.count !== 1) throw new ApiError('This bill was just changed (payment or cancel) — refresh and try again', 409)
    const ret = await tx.purchaseReturn.findFirst({
      where: { companyId, invoiceId: pinv.id, status: { not: 'CANCELLED' } }, select: { number: true },
    })
    if (ret) throw new ApiError(`Cannot edit: purchase return ${ret.number} is recorded against this bill — cancel it first`, 400)

    const { ids, taxLines } = await billTaxLines(tx, companyId, rawLines)
    const supplierId = body.supplierId ? String(body.supplierId) : pinv.supplierId
    const supplier = await tx.supplier.findFirst({ where: { id: supplierId, companyId } })
    if (!supplier) throw new ApiError('Supplier not found', 404)
    const company = await tx.company.findUnique({ where: { id: companyId } })
    if (!company) throw new ApiError('Company not found', 404)
    const interState = isInterStateParty(company, supplier)
    const totals = computeBillTotals(taxLines, interState, {
      billDiscount,
      freight: { amount: freightCharge, gstRate: freightGstRate },
      packing: { amount: packingCharge, gstRate: packingGstRate },
      roundOff: company.roundOffTotals ?? true,
    })
    let dueDate = body.dueDate === undefined ? pinv.dueDate : toDate(body.dueDate)
    if (!dueDate) {
      dueDate = new Date(date)
      dueDate.setDate(dueDate.getDate() + (Number(supplier.paymentTermsDays) || 0))
    }
    if (dueDate.toISOString().slice(0, 10) < date.toISOString().slice(0, 10)) throw new ApiError('Due date cannot be before the invoice date', 400)

    // Stock the bill received: back out first (409 if it has been used since), re-received below
    const previous = await reverseBillStock(tx, { companyId, bill: pinv, note: `Reversed: bill ${pinv.number} edited` })
    await tx.purchaseInvoiceItem.deleteMany({ where: { invoiceId: pinv.id } })

    const directReceive = !!body.receiveStock
    const flags = directReceive ? await trackingFlags(tx, companyId, ids) : new Map<string, { batch: boolean; serial: boolean }>()
    const supplierInvNo: string | null = body.supplierInvNo === undefined ? pinv.supplierInvNo : (body.supplierInvNo ? String(body.supplierInvNo) : null)
    const bill = await tx.purchaseInvoice.update({
      where: { id: pinv.id },
      data: {
        supplierId: supplier.id,
        date,
        supplierInvNo,
        supplierInvDate: body.supplierInvDate === undefined ? pinv.supplierInvDate : toDate(body.supplierInvDate),
        dueDate,
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
        status: 'UNPAID',
        notes: body.notes === undefined ? pinv.notes : (body.notes ? String(body.notes) : null),
        items: {
          create: totals.computed.map((c, idx) => ({
            itemId: rawLines[idx].itemId as string,
            qty: c.qty,
            rate: c.rate,
            gstRate: c.gstRate,
            cessRate: c.cessRate || 0,
            lineTotal: c.taxable, // final taxable value (after the pro-rata bill discount)
            // tracking details are kept only when the bill itself receives the goods
            ...(flags.get(rawLines[idx].itemId as string)?.batch ? {
              batchNo: String(rawLines[idx].batchNo || '').trim() || pinv.number,
              mfgDate: toDate(rawLines[idx].mfgDate),
              expiryDate: toDate(rawLines[idx].expiryDate),
            } : {}),
            ...(flags.get(rawLines[idx].itemId as string)?.serial ? { serials: joinSerials(parseSerials(rawLines[idx].serials)) } : {}),
          })),
        },
      },
      include: { items: true },
    })

    let stockNote = ''
    if (directReceive) {
      const wh = await receiveWarehouse(tx, companyId, body.warehouseId ? String(body.warehouseId) : previous[0]?.warehouseId ?? null)
      await receiveBillStock(tx, { companyId, warehouseId: wh.id, date, bill, supplierInvNo })
      stockNote = `, stock re-received into ${wh.name}`
    } else if (previous.length) {
      stockNote = ', received stock reversed'
    }

    await logAudit(tx, {
      companyId, userName: body.userName, action: 'UPDATE', entity: 'PurchaseInvoice', entityId: pinv.id,
      details: `Edited ${pinv.number}: grand total ${r2(pinv.grandTotal)} → ${totals.grandTotal}, ${bill.items.length} line(s)${stockNote}`,
    })
    return bill
  })
  const [row] = await attachItemInfo(companyId, [updated])
  return row
}

// NOTE: No DELETE — purchase invoices are accounting records; cancel instead.
