import type { Prisma } from '@prisma/client'
import { ApiError, postStock } from '@/lib/erp-helpers'
import { receiveBatch, receiveSerials } from '@/lib/batches'

/**
 * Opening stock of an item: an OPENING movement in the stock ledger (moving-average balance via
 * postStock) plus the batch / serial layer for tracked items. Shared by POST /api/items and the
 * items CSV import. Runs inside the caller's transaction; both the item and the warehouse must
 * belong to `companyId` — ids from the request are never trusted across tenants.
 */

type Tx = Prisma.TransactionClient

export interface OpeningStockInput {
  qty: number
  rate: number
  warehouseId: string | null
  batchNo: string
  expiryDate?: unknown
  mfgDate?: unknown
  serials: string[]
  /** Ledger date; default now (item form). Imports pass the go-live opening date. */
  date?: Date
  /** Ledger refNumber, e.g. the import reference used for reconciliation. */
  refNumber?: string
  notes?: string
}

export async function postOpeningStock(tx: Tx, companyId: string, itemId: string, opening: OpeningStockInput & { warehouseId: string }) {
  const [warehouse, item] = await Promise.all([
    tx.warehouse.findFirst({ where: { id: opening.warehouseId, companyId }, select: { id: true } }),
    tx.item.findFirst({ where: { id: itemId, companyId }, select: { id: true } }),
  ])
  if (!warehouse) throw new ApiError('Opening stock warehouse not found', 404)
  if (!item) throw new ApiError('Item not found', 404)

  await postStock(tx as never, {
    companyId,
    itemId,
    warehouseId: warehouse.id,
    type: 'OPENING',
    qtyIn: opening.qty,
    rate: opening.rate,
    refType: 'OPENING',
    date: opening.date,
    refNumber: opening.refNumber,
    notes: opening.notes ?? 'Opening stock',
  })
  // Batch / serial layer (no-op unless the item is batch / serial tracked)
  await receiveBatch(tx, {
    companyId, itemId, warehouseId: warehouse.id,
    batchNo: opening.batchNo, expiryDate: (opening.expiryDate ?? null) as never,
    mfgDate: (opening.mfgDate ?? null) as never, qty: opening.qty,
  })
  await receiveSerials(tx, {
    companyId, itemId, warehouseId: warehouse.id,
    serials: opening.serials, qty: opening.qty, ref: { type: 'OPENING', id: itemId },
  })
}
