import { Prisma } from '@prisma/client'
import { ApiError, r2 } from '@/lib/erp-helpers'

/**
 * Inventory cost of goods sold, for sales returns and invoice reversals (AC-B1).
 *
 * Costing is weighted average per item + warehouse (postStock). Since the `costRate` column exists, every outward
 * stock row stores the average cost at the moment the goods left. Older rows (costRate null) get it rebuilt by
 * replaying that item + warehouse's ledger with postStock's own formula; the replay is trusted only when it
 * reproduces today's StockBalance exactly — otherwise the caller must stop for review (never selling price,
 * never a guess).
 */

type Tx = Prisma.TransactionClient

interface OutRow { id: string; createdAt: Date; itemId: string; warehouseId: string; qtyOut: number; costRate: number | null }

/** How the invoice's goods left stock. */
export type SaleStockMode = 'DIRECT' | 'CHALLAN' | 'NONE'

export interface InvoiceStockInfo { id: string; number: string; challanId: string | null; salesOrderId: string | null; deductStock: boolean }

/**
 * DIRECT = the invoice took the goods out (SALE_OUT), CHALLAN = its delivery challan did (DISPATCH_OUT),
 * NONE = no stock left with this invoice (credit note only on return). An invoice billed from a sales order
 * without a challan, whose order had goods dispatched on challans, cannot be tied to those movements → review.
 */
export async function saleStockMode(tx: Tx, companyId: string, inv: InvoiceStockInfo, itemIds: string[]): Promise<SaleStockMode> {
  if (inv.challanId) return 'CHALLAN'
  if (inv.deductStock) return 'DIRECT'
  if (inv.salesOrderId) {
    const challans = await tx.deliveryChallan.findMany({ where: { companyId, salesOrderId: inv.salesOrderId }, select: { id: true } })
    const dispatched = challans.length
      ? await tx.stockLedger.count({ where: { companyId, type: 'DISPATCH_OUT', refType: 'DELIVERY', refId: { in: challans.map((c) => c.id) }, itemId: { in: itemIds } } })
      : 0
    if (dispatched) {
      throw new ApiError(
        `Invoice ${inv.number} was billed from its sales order without a delivery challan, but goods of that order left stock on challans — `
        + 'the original cost and warehouse cannot be tied to this invoice. This return needs review.', 409,
      )
    }
  }
  return 'NONE'
}

/**
 * Outward rows still standing for one item of the sale. CHALLAN: the challan's DISPATCH_OUT rows.
 * DIRECT: the invoice's SALE_OUT rows net of SALE_CANCEL_IN reversals (an edit reverses everything and posts again)
 * — the newest SALE_OUT rows covering the net quantity.
 */
export async function liveSaleRows(tx: Tx, companyId: string, inv: InvoiceStockInfo, mode: SaleStockMode, itemId: string): Promise<{ rows: OutRow[]; qty: number }> {
  if (mode === 'NONE') return { rows: [], qty: 0 }
  const select = { id: true, createdAt: true, itemId: true, warehouseId: true, qtyOut: true, costRate: true }
  if (mode === 'CHALLAN') {
    const rows = await tx.stockLedger.findMany({ where: { companyId, itemId, type: 'DISPATCH_OUT', refType: 'DELIVERY', refId: inv.challanId! }, select, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
    return { rows, qty: r2(rows.reduce((s, r) => s + r.qtyOut, 0)) }
  }
  const [outs, ins] = await Promise.all([
    tx.stockLedger.findMany({ where: { companyId, itemId, type: 'SALE_OUT', refType: 'SALES_INVOICE', refId: inv.id }, select, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] }),
    tx.stockLedger.aggregate({ where: { companyId, itemId, type: 'SALE_CANCEL_IN', refType: 'SALES_INVOICE', refId: inv.id }, _sum: { qtyIn: true } }),
  ])
  const net = r2(outs.reduce((s, r) => s + r.qtyOut, 0) - (ins._sum.qtyIn || 0))
  const rows: OutRow[] = []
  let covered = 0
  for (const r of outs) {
    if (covered >= net - 0.0005) break
    const take = Math.min(r.qtyOut, r2(net - covered))
    rows.push({ ...r, qtyOut: take })
    covered = r2(covered + take)
  }
  return { rows: rows.reverse(), qty: Math.max(0, net) }
}

/**
 * Rebuild the average cost an older outward row left at: replay the item + warehouse ledger (postStock's formula,
 * same rounding) and require the full replay to match today's StockBalance. Throws 409 (review) when it cannot.
 */
export async function reconstructOutCost(tx: Tx, companyId: string, row: OutRow, what: string): Promise<number> {
  const fail = (why: string): never => {
    throw new ApiError(`The original cost of ${what} cannot be rebuilt reliably from the stock history (${why}). This return needs review.`, 409)
  }
  const [hist, bal] = await Promise.all([
    tx.stockLedger.findMany({
      where: { companyId, itemId: row.itemId, warehouseId: row.warehouseId },
      select: { id: true, qtyIn: true, qtyOut: true, rate: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    }),
    tx.stockBalance.findUnique({ where: { itemId_warehouseId: { itemId: row.itemId, warehouseId: row.warehouseId } }, select: { qty: true, avgRate: true } }),
  ])
  let qty = 0
  let rate = 0
  let found: number | null = null
  for (const h of hist) {
    if (h.id === row.id) {
      if (qty + 0.005 < h.qtyOut) fail('the history shows less stock than was sold')
      found = rate
    }
    const qtyIn = Math.max(0, h.qtyIn || 0)
    if (qtyIn > 0 && h.rate > 0) rate = qty > 0 ? r2((qty * rate + qtyIn * h.rate) / (qty + qtyIn)) : r2(h.rate)
    qty = r2(qty + qtyIn - Math.max(0, h.qtyOut || 0))
    if (qty < -0.005) fail('the history goes below zero stock')
  }
  if (found === null) fail('the sale is missing from the stock history')
  if (!bal || Math.abs(bal.qty - qty) > 0.005 || Math.abs(bal.avgRate - rate) > 0.005) fail('the history does not add up to the current stock balance')
  return found as number
}

/**
 * Unit cost to put returned / reversed goods back at, from the sale's live outward rows (quantity-weighted when
 * several rows stand, e.g. two lines of the same item). Stored costRate when present, rebuilt otherwise.
 */
export async function originalUnitCost(tx: Tx, companyId: string, rows: OutRow[], what: string): Promise<number> {
  let qty = 0
  let value = 0
  for (const r of rows) {
    const cost = r.costRate ?? await reconstructOutCost(tx, companyId, r, what)
    qty += r.qtyOut
    value += r.qtyOut * cost
  }
  if (qty <= 0) throw new ApiError(`No stock record of the original sale was found for ${what}. This return needs review.`, 409)
  return r2(value / qty)
}
