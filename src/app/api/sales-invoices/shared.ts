import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { ApiError, postStock, r2 } from '@/lib/erp-helpers'
import { consumeBatches, formatAllocation, joinSerials, parseSerials, restoreBatches, sellSerials, unsellSerials } from '@/lib/batches'

// Shared by POST /api/sales-invoices (create) and PATCH /api/sales-invoices/[id] (action 'edit').

type Tx = Prisma.TransactionClient

// Optional free-text field: blank → null
export const optStr = (v: unknown) => (v === undefined || v === null || String(v).trim() === '' ? null : String(v).trim())

// Line rates keep 4 decimals so alt-unit rates (₹100 per BOX of 24 PCS = ₹4.1667 / PCS) don't drift
// the line total; lineTotal and every money total stay at 2 decimals (computeBillTotals rounds them).
export const r4 = (n: number) => Math.round(n * 10000) / 10000

// batchNo / serials: only used by the direct-sale stock deduction (deductStock) for batch- / serial-tracked items
export interface InvLine { soItemId: string | null; itemId: string; qty: number; rate: number; discountPct: number; gstRate: number; cessRate: number; batchNo?: string | null; serials?: string | null }

// Optional non-negative amount / rate: blank → fallback
export function optNum(v: unknown, label: string, fallback: number): number {
  if (v === undefined || v === null || v === '') return fallback
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0) throw new ApiError(`${label} must be 0 or more`, 400)
  return r2(n)
}
export function gstRateOf(v: unknown, label: string): number {
  const n = optNum(v, label, 18)
  if (n > 100) throw new ApiError(`${label} cannot exceed 100`, 400)
  return n
}

/** One client-supplied line → InvLine (soItemId null; cessRate NaN = take it from the item master). */
export function parseLine(l: any): InvLine {
  if (!l || !l.itemId) throw new ApiError('itemId is required on every line', 400)
  const qty = Number(l.qty)
  const rate = Number(l.rate)
  if (!(qty > 0)) throw new ApiError('Line qty must be greater than 0', 400)
  if (Number.isNaN(rate) || rate < 0) throw new ApiError('Line rate must be 0 or more', 400)
  return {
    soItemId: null,
    itemId: String(l.itemId),
    qty: r2(qty),
    rate: r4(rate),
    discountPct: Number(l.discountPct ?? 0) || 0,
    gstRate: l.gstRate === undefined || l.gstRate === null || l.gstRate === '' ? 18 : Number(l.gstRate),
    cessRate: l.cessRate === undefined || l.cessRate === null || l.cessRate === '' ? NaN : Number(l.cessRate),
    batchNo: l.batchNo ? String(l.batchNo).trim() || null : null,
    serials: joinSerials(parseSerials(l.serials)),
  }
}

/** HSN (and default cess %) from the item master; 400 when an item is not in this company. */
export async function withMasterInfo(companyId: string, lines: InvLine[]) {
  const itemIds = Array.from(new Set(lines.map((l) => l.itemId)))
  const masterItems = await db.item.findMany({ where: { companyId, id: { in: itemIds } }, select: { id: true, hsn: true, cessRate: true } })
  if (masterItems.length !== itemIds.length) throw new ApiError('One or more line items were not found', 400)
  const hsnMap = new Map(masterItems.map((m) => [m.id, m.hsn]))
  const cessMap = new Map(masterItems.map((m) => [m.id, m.cessRate || 0]))
  const out = lines.map((l) => {
    const cessRate = Number.isFinite(l.cessRate) ? l.cessRate : (cessMap.get(l.itemId) || 0)
    if (cessRate < 0 || cessRate > 400) throw new ApiError('Cess % must be between 0 and 400', 400)
    return { ...l, cessRate: r2(cessRate) }
  })
  return { lines: out, hsnMap }
}

/** Warehouse a direct sale takes stock from: the requested one, else the FG store, else the first warehouse. */
export async function resolveStockWarehouse(companyId: string, requested: unknown): Promise<string> {
  if (requested) {
    const wh = await db.warehouse.findFirst({ where: { id: String(requested), companyId }, select: { id: true } })
    if (!wh) throw new ApiError('Stock warehouse not found', 404)
    return wh.id
  }
  const whs = await db.warehouse.findMany({ where: { companyId }, select: { id: true, type: true }, orderBy: { createdAt: 'asc' } })
  const wh = whs.find((w) => w.type === 'FG') ?? whs[0]
  if (!wh) throw new ApiError('No warehouse set up to deduct stock from', 400)
  return wh.id
}

/**
 * Direct sale: goods leave the warehouse with the invoice (services are skipped by postStock).
 * Batch / serial layer: chosen batch else FEFO; the batch(es) / serials actually drawn are written
 * back onto the invoice lines (identical lines are interchangeable).
 */
export async function postSaleStock(tx: Tx, input: {
  companyId: string; invoiceId: string; number: string; date: Date; warehouseId: string; lines: InvLine[]; note?: string
}) {
  const { companyId, invoiceId, number, date, warehouseId, lines } = input
  const t = tx as any
  const createdLines = await tx.salesInvoiceItem.findMany({ where: { invoiceId } })
  const usedLineIds = new Set<string>()
  for (const l of lines) {
    await postStock(t, {
      companyId, itemId: l.itemId, warehouseId, type: 'SALE_OUT', qtyOut: l.qty, rate: l.rate,
      date, refType: 'SALES_INVOICE', refId: invoiceId, refNumber: number, notes: input.note || `Sold on invoice ${number}`,
    })
    const allocs = await consumeBatches(tx, { companyId, itemId: l.itemId, warehouseId, qty: l.qty, batchNo: l.batchNo })
    const sold = await sellSerials(tx, {
      companyId, itemId: l.itemId, warehouseId, serials: parseSerials(l.serials), qty: l.qty,
      ref: { type: 'SALES_INVOICE', id: invoiceId },
    })
    const line = createdLines.find((c) => !usedLineIds.has(c.id) && c.itemId === l.itemId && Math.abs(c.qty - l.qty) < 0.0005
      && (c.batchNo ?? null) === (l.batchNo ?? null) && (c.serials ?? null) === (l.serials ?? null))
    if (line) {
      usedLineIds.add(line.id)
      const batchText = formatAllocation(allocs)
      const serialText = joinSerials(sold)
      if (batchText !== line.batchNo || serialText !== line.serials) {
        await tx.salesInvoiceItem.update({ where: { id: line.id }, data: { batchNo: batchText, serials: serialText } })
      }
    }
  }
}

/** Put a direct sale's goods back (same warehouse, batches and serials) — cancel and edit. */
export async function reverseSaleStock(tx: Tx, input: {
  companyId: string; invoiceId: string; number: string; warehouseId: string; note: string; fallbackBatchNo: string
}) {
  const { companyId, invoiceId, number, warehouseId } = input
  const t = tx as any
  const invLines = await tx.salesInvoiceItem.findMany({ where: { invoiceId } })
  for (const l of invLines) {
    // Back in at the current average cost (the sale price would distort the moving average)
    const bal = await tx.stockBalance.findUnique({ where: { itemId_warehouseId: { itemId: l.itemId, warehouseId } }, select: { avgRate: true } })
    await postStock(t, {
      companyId, itemId: l.itemId, warehouseId, type: 'SALE_CANCEL_IN', qtyIn: l.qty, rate: bal?.avgRate || 0,
      refType: 'SALES_INVOICE', refId: invoiceId, refNumber: number, notes: input.note,
    })
    // Back into the batch(es) it was drawn from (no-op for untracked items)
    await restoreBatches(tx, { companyId, itemId: l.itemId, warehouseId, qty: l.qty, batchText: l.batchNo, fallbackBatchNo: input.fallbackBatchNo })
  }
  // Serials sold on this invoice go back in stock
  await unsellSerials(tx, companyId, { type: 'SALES_INVOICE', id: invoiceId })
}
