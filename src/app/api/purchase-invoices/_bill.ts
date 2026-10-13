import { Prisma } from '@prisma/client'
import { ApiError, r2, postStock } from '@/lib/erp-helpers'
import { consumeBatches, parseSerials, receiveBatch, receiveSerials, unreceiveSerials, UNBATCHED } from '@/lib/batches'

// Shared by POST /api/purchase-invoices (create) and PATCH /api/purchase-invoices/[id] (edit / cancel).
// Private module (underscore folder-file, not a route).

type Tx = Prisma.TransactionClient

export interface PinvLineInput {
  itemId?: string; qty?: number | string; rate?: number | string; gstRate?: number | string; cessRate?: number | string | null
  // direct receive (receiveStock) only: batch / serial tracking for the goods coming in
  batchNo?: string | null; mfgDate?: string | null; expiryDate?: string | null; serials?: string | string[] | null
}

/** Unit rates keep 4 decimals (₹0.0125 per piece); money totals stay at 2. */
export const r4 = (n: number) => Math.round(n * 10000) / 10000

export function toDate(v: unknown): Date | null {
  if (!v) return null
  const d = new Date(String(v))
  return Number.isNaN(d.getTime()) ? null : d
}

/** Optional non-negative money/percent field from the body (blank → 0 / fallback). */
export function num(v: unknown, label: string, fallback = 0): number {
  if (v === undefined || v === null || v === '') return fallback
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0) throw new ApiError(`${label} must be 0 or more`, 400)
  return r2(n)
}
export function gstPct(v: unknown, label: string): number {
  const n = num(v, label, 18)
  if (n > 100) throw new ApiError(`${label} cannot exceed 100%`, 400)
  return n
}

/**
 * Validate bill lines and build the computeBillTotals input. Cess % comes from the line when sent,
 * else from the item master. Returns the distinct item ids too.
 */
export async function billTaxLines(tx: Tx, companyId: string, lines: PinvLineInput[]) {
  if (!lines.length) throw new ApiError('At least one invoice line is required', 400)
  for (const l of lines) {
    if (!l.itemId) throw new ApiError('itemId is required on every line', 400)
    if (!(Number(l.qty) > 0)) throw new ApiError('Line qty must be greater than 0', 400)
    if (!(Number(l.rate) >= 0)) throw new ApiError('Line rate must be 0 or more', 400)
  }
  const ids = Array.from(new Set(lines.map((l) => l.itemId as string)))
  const master = await tx.item.findMany({ where: { companyId, id: { in: ids } }, select: { id: true, cessRate: true } })
  if (master.length !== ids.length) throw new ApiError('One or more itemId values are invalid for this company', 400)
  const cessOf = new Map(master.map((m) => [m.id, m.cessRate || 0]))
  const taxLines = lines.map((l) => {
    const cess = l.cessRate === undefined || l.cessRate === null || l.cessRate === ''
      ? cessOf.get(l.itemId as string) || 0
      : num(l.cessRate, 'Cess %')
    if (cess > 100) throw new ApiError('Cess % cannot exceed 100', 400)
    return { qty: r2(Number(l.qty)), rate: r4(Number(l.rate)), gstRate: Number(l.gstRate ?? 18), cessRate: cess }
  })
  return { ids, taxLines }
}

/** Batch / serial flags of the bill's items (only needed when the bill receives stock). */
export async function trackingFlags(tx: Tx, companyId: string, ids: string[]) {
  const flags = new Map<string, { batch: boolean; serial: boolean }>()
  const tracked = await tx.item.findMany({ where: { companyId, id: { in: ids } }, select: { id: true, batchTracked: true, trackSerial: true, type: true } })
  for (const i of tracked) flags.set(i.id, { batch: i.batchTracked && i.type !== 'SERVICE', serial: i.trackSerial && i.type !== 'SERVICE' })
  return flags
}

/** Warehouse for a direct receive: the chosen one, else the first raw-material store, else the first store. */
export async function receiveWarehouse(tx: Tx, companyId: string, warehouseId?: string | null) {
  const wh = warehouseId
    ? await tx.warehouse.findFirst({ where: { id: String(warehouseId), companyId } })
    : (await tx.warehouse.findFirst({ where: { companyId, type: 'RM' }, orderBy: { createdAt: 'asc' } }))
      ?? (await tx.warehouse.findFirst({ where: { companyId }, orderBy: { createdAt: 'asc' } }))
  if (!wh) throw new ApiError(warehouseId ? 'Warehouse not found' : 'Create a warehouse first', 404)
  return wh
}

/** Post the bill's lines into stock (PURCHASE_IN) with their batch / serial details. */
export async function receiveBillStock(tx: Tx, input: {
  companyId: string; warehouseId: string; date: Date
  bill: { id: string; number: string; items: { itemId: string; qty: number; rate: number; batchNo: string | null; mfgDate: Date | null; expiryDate: Date | null; serials: string | null }[] }
  supplierInvNo?: string | null
}) {
  const { companyId, warehouseId, date, bill } = input
  for (const it of bill.items) {
    await postStock(tx as never, {
      companyId, itemId: it.itemId, warehouseId, type: 'PURCHASE_IN', qtyIn: it.qty, rate: it.rate, date,
      refType: 'PURCHASE_INVOICE', refId: bill.id, refNumber: bill.number,
      notes: `Received with bill ${bill.number}${input.supplierInvNo ? ` (supplier inv ${input.supplierInvNo})` : ''}`,
    })
    // Batch / serial layer (no-op for untracked items)
    await receiveBatch(tx, {
      companyId, itemId: it.itemId, warehouseId, batchNo: it.batchNo, mfgDate: it.mfgDate, expiryDate: it.expiryDate, qty: it.qty,
    })
    await receiveSerials(tx, {
      companyId, itemId: it.itemId, warehouseId, serials: parseSerials(it.serials), qty: it.qty,
      ref: { type: 'PURCHASE_INVOICE', id: bill.id },
    })
  }
}

/**
 * Stock this bill currently holds: its PURCHASE_IN ledger rows minus the ones already reversed
 * (each PURCHASE_RETURN row on the bill cancels one receipt of the same item / store / qty).
 * An edited bill has old receipts + their reversals + the new receipts in the ledger.
 */
export async function liveReceipts(tx: Tx, companyId: string, billId: string) {
  const rows = await tx.stockLedger.findMany({
    where: { companyId, refType: 'PURCHASE_INVOICE', refId: billId, type: { in: ['PURCHASE_IN', 'PURCHASE_RETURN'] } },
    select: { id: true, type: true, itemId: true, warehouseId: true, qtyIn: true, qtyOut: true, rate: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
  const live = rows.filter((r) => r.type === 'PURCHASE_IN')
  for (const out of rows.filter((r) => r.type === 'PURCHASE_RETURN')) {
    const i = live.findIndex((r) => r.itemId === out.itemId && r.warehouseId === out.warehouseId && Math.abs(r.qtyIn - out.qtyOut) < 0.0005)
    if (i >= 0) live.splice(i, 1)
  }
  return live
}

/**
 * Take the stock this bill received back out (bill cancelled / edited), incl. its batches and serials.
 * Fails (409) when that stock has already been used. Returns the reversed receipts.
 */
export async function reverseBillStock(tx: Tx, input: { companyId: string; bill: { id: string; number: string }; note: string }) {
  const { companyId, bill } = input
  const received = await liveReceipts(tx, companyId, bill.id)
  const billLines = received.length ? await tx.purchaseInvoiceItem.findMany({ where: { invoiceId: bill.id } }) : []
  const usedLines = new Set<string>()
  for (const r of received) {
    await postStock(tx as never, {
      companyId, itemId: r.itemId, warehouseId: r.warehouseId, type: 'PURCHASE_RETURN', qtyOut: r.qtyIn, rate: r.rate,
      refType: 'PURCHASE_INVOICE', refId: bill.id, refNumber: bill.number, notes: input.note,
    })
    // Batch layer: take the qty back out of the batch the bill received it into (no-op for untracked items)
    const line = billLines.find((l) => !usedLines.has(l.id) && l.itemId === r.itemId && Math.abs(l.qty - r.qtyIn) < 0.0005)
    if (line) usedLines.add(line.id)
    const batchNo = line?.batchNo || null
    if (batchNo) {
      await consumeBatches(tx, { companyId, itemId: r.itemId, warehouseId: r.warehouseId, qty: r.qtyIn, batchNo })
    } else {
      // received before batch tracking → it sits in the un-batched pool; else FEFO
      try {
        await consumeBatches(tx, { companyId, itemId: r.itemId, warehouseId: r.warehouseId, qty: r.qtyIn, batchNo: UNBATCHED })
      } catch (e) {
        if (!(e instanceof ApiError)) throw e
        await consumeBatches(tx, { companyId, itemId: r.itemId, warehouseId: r.warehouseId, qty: r.qtyIn })
      }
    }
  }
  // Serials received on this bill are removed again (409 if one has already left stock)
  if (received.length) await unreceiveSerials(tx, companyId, { type: 'PURCHASE_INVOICE', id: bill.id })
  return received
}
