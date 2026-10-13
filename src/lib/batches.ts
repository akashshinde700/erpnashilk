import { Prisma } from '@prisma/client'
import { ApiError, r2 } from '@/lib/erp-helpers'

// ============================================================================
// Batch / expiry and serial-number layer on top of postStock.
// postStock owns the quantity totals (StockBalance + StockLedger); these helpers
// keep ItemBatch rows and ItemSerial rows in step with it. Call them inside the
// same db.$transaction, AFTER the matching postStock call (postStock row-locks the
// item+warehouse balance, which serialises concurrent batch / serial changes too).
// Items without batchTracked / trackSerial are a no-op everywhere.
// ============================================================================

type Tx = Prisma.TransactionClient

export interface BatchAlloc { batchNo: string; qty: number }
export interface DocRef { type: string; id: string }

const EPS = 0.0005

/**
 * Pseudo-batch for stock that existed before an item became batch-tracked
 * (StockBalance.qty − Σ ItemBatch.qty). It never gets an ItemBatch row: taking from it
 * only lowers StockBalance (postStock), giving back to it is a no-op here.
 */
export const UNBATCHED = 'UNBATCHED'
export const isUnbatched = (batchNo: string | null | undefined) => String(batchNo || '').trim().toUpperCase() === UNBATCHED

async function itemFlags(tx: Tx, companyId: string, itemId: string) {
  const it = await tx.item.findFirst({
    where: { id: itemId, companyId },
    select: { code: true, name: true, batchTracked: true, trackSerial: true, type: true },
  })
  if (!it) throw new ApiError('Item not found', 404)
  return it
}
const label = (it: { code: string; name: string }) => `${it.code} ${it.name}`

/** Is the item batch-tracked / serial-tracked? (one query for both) */
export async function trackingOf(tx: Tx, companyId: string, itemId: string) {
  const it = await itemFlags(tx, companyId, itemId)
  return { batchTracked: it.batchTracked && it.type !== 'SERVICE', trackSerial: it.trackSerial && it.type !== 'SERVICE' }
}

function toDateOrNull(v: unknown): Date | null {
  if (v === undefined || v === null || v === '') return null
  const d = v instanceof Date ? v : new Date(String(v))
  return Number.isNaN(d.getTime()) ? null : d
}

// ------------------------------- batches -------------------------------

/** Upsert-increment a batch. No-op for items that are not batch-tracked. */
export async function receiveBatch(tx: Tx, input: {
  companyId: string; itemId: string; warehouseId: string; batchNo?: string | null
  mfgDate?: Date | string | null; expiryDate?: Date | string | null; qty: number
}): Promise<BatchAlloc | null> {
  const qty = r2(input.qty || 0)
  if (qty <= 0) return null
  const tr = await trackingOf(tx, input.companyId, input.itemId)
  if (!tr.batchTracked) return null
  const batchNo = String(input.batchNo || '').trim()
  if (!batchNo) throw new ApiError('Batch no is required for a batch-tracked item', 400)
  // back into the legacy un-batched pool: postStock already raised the balance
  if (isUnbatched(batchNo)) return { batchNo: UNBATCHED, qty }
  const mfgDate = toDateOrNull(input.mfgDate)
  const expiryDate = toDateOrNull(input.expiryDate)
  const existing = await tx.itemBatch.findUnique({
    where: { itemId_warehouseId_batchNo: { itemId: input.itemId, warehouseId: input.warehouseId, batchNo } },
  })
  if (existing) {
    if (existing.companyId !== input.companyId) throw new ApiError('Batch not found', 404)
    await tx.itemBatch.update({
      where: { id: existing.id },
      data: {
        qty: { increment: qty },
        // keep the dates already on the batch; fill them only when missing
        ...(mfgDate && !existing.mfgDate ? { mfgDate } : {}),
        ...(expiryDate && !existing.expiryDate ? { expiryDate } : {}),
      },
    })
  } else {
    await tx.itemBatch.create({
      data: { companyId: input.companyId, itemId: input.itemId, warehouseId: input.warehouseId, batchNo, mfgDate, expiryDate, qty },
    })
  }
  return { batchNo, qty }
}

/** FEFO order: earliest expiry first (no expiry last), then oldest batch. */
function fefo<T extends { expiryDate: Date | null; createdAt: Date }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    const ea = a.expiryDate ? a.expiryDate.getTime() : Number.POSITIVE_INFINITY
    const eb = b.expiryDate ? b.expiryDate.getTime() : Number.POSITIVE_INFINITY
    if (ea !== eb) return ea - eb
    return a.createdAt.getTime() - b.createdAt.getTime()
  })
}

/**
 * Take qty out of batches. With batchNo → only that batch (409 if short);
 * without → FEFO across the warehouse's batches. When batch stock is short, the rest
 * comes from the legacy un-batched pool (stock received before batch tracking was
 * switched on) and shows up as an UNBATCHED allocation; 409 only when batches + pool
 * are short. batchNo = UNBATCHED takes from the pool only.
 * Call AFTER the matching postStock qtyOut (the pool is StockBalance.qty + qty − Σ batches,
 * i.e. the pool as it was before this movement). Called before postStock the pool is
 * over-estimated by qty, but postStock's own balance check still caps the total.
 * Returns the allocation; [] for items that are not batch-tracked.
 */
export async function consumeBatches(tx: Tx, input: {
  companyId: string; itemId: string; warehouseId: string; qty: number; batchNo?: string | null
}): Promise<BatchAlloc[]> {
  let need = r2(input.qty || 0)
  if (need <= 0) return []
  const it = await itemFlags(tx, input.companyId, input.itemId)
  if (!it.batchTracked || it.type === 'SERVICE') return []
  const wanted = String(input.batchNo || '').trim()
  const poolOnly = isUnbatched(wanted)
  const all = await tx.itemBatch.findMany({
    where: { companyId: input.companyId, itemId: input.itemId, warehouseId: input.warehouseId, qty: { gt: EPS } },
  })
  const rows = poolOnly ? [] : wanted ? all.filter((b) => b.batchNo === wanted) : all
  const avail = r2(rows.reduce((s, b) => s + b.qty, 0))
  if (wanted && !poolOnly && avail + EPS < need) {
    throw new ApiError(`Batch ${wanted} of ${label(it)} has only ${avail} in this warehouse, ${need} required`, 409)
  }
  // Legacy un-batched pool, as it was before this movement
  let pool = 0
  if (poolOnly || avail + EPS < need) {
    const bal = await tx.stockBalance.findUnique({
      where: { itemId_warehouseId: { itemId: input.itemId, warehouseId: input.warehouseId } },
      select: { qty: true },
    })
    const batchSum = all.reduce((s, b) => s + b.qty, 0)
    pool = Math.max(0, r2((bal?.qty || 0) + need - batchSum))
  }
  if (avail + pool + EPS < need) {
    throw new ApiError(
      poolOnly
        ? `Only ${pool} un-batched stock of ${label(it)} in this warehouse, ${need} required`
        : `Batch stock short for ${label(it)}: ${avail} available across batches${pool > 0 ? ` + ${pool} un-batched` : ''} in this warehouse, ${need} required (receive the stock against a batch first)`,
      409,
    )
  }
  const out: BatchAlloc[] = []
  for (const b of fefo(rows)) {
    if (need <= EPS) break
    const take = r2(Math.min(b.qty, need))
    if (take <= 0) continue
    const upd = await tx.itemBatch.updateMany({ where: { id: b.id, qty: { gte: take - EPS } }, data: { qty: { decrement: take } } })
    if (upd.count !== 1) throw new ApiError(`Batch ${b.batchNo} was just changed by someone else — refresh and try again`, 409)
    out.push({ batchNo: b.batchNo, qty: take })
    need = r2(need - take)
  }
  if (need > EPS) out.push({ batchNo: UNBATCHED, qty: need })
  return out
}

/**
 * Transfer: take qty out of the source warehouse's batches (chosen batch or FEFO, un-batched
 * pool last) and put the same batch numbers / dates into the destination (un-batched stock
 * stays un-batched there). Call in the same transaction as the two postStock legs — before or
 * after them (see consumeBatches). [] for untracked items.
 */
export async function transferBatches(tx: Tx, input: {
  companyId: string; itemId: string; fromWarehouseId: string; toWarehouseId: string; qty: number; batchNo?: string | null
}): Promise<BatchAlloc[]> {
  const allocs = await consumeBatches(tx, {
    companyId: input.companyId, itemId: input.itemId, warehouseId: input.fromWarehouseId, qty: input.qty, batchNo: input.batchNo,
  })
  if (!allocs.length) return []
  const src = await tx.itemBatch.findMany({
    where: { companyId: input.companyId, itemId: input.itemId, warehouseId: input.fromWarehouseId, batchNo: { in: allocs.map((a) => a.batchNo) } },
    select: { batchNo: true, mfgDate: true, expiryDate: true },
  })
  for (const a of allocs) {
    const b = src.find((x) => x.batchNo === a.batchNo)
    await receiveBatch(tx, {
      companyId: input.companyId, itemId: input.itemId, warehouseId: input.toWarehouseId, batchNo: a.batchNo, qty: a.qty,
      mfgDate: b?.mfgDate ?? null, expiryDate: b?.expiryDate ?? null,
    })
  }
  return allocs
}

/** "B1" for a single batch, "B1×5, B2×3" when split. */
export function formatAllocation(allocs: BatchAlloc[]): string | null {
  if (!allocs.length) return null
  // un-batched stock is always written with its qty ("UNBATCHED×n") so it reads as legacy stock
  if (allocs.length === 1 && !isUnbatched(allocs[0].batchNo)) return allocs[0].batchNo
  return allocs.map((a) => `${a.batchNo}×${r2(a.qty)}`).join(', ')
}

/** Inverse of formatAllocation; a bare "B1" means the whole lineQty. */
export function parseAllocation(text: string | null | undefined, lineQty: number): BatchAlloc[] {
  const s = String(text || '').trim()
  if (!s) return []
  const parts = s.split(',').map((p) => p.trim()).filter(Boolean)
  if (parts.length === 1 && !parts[0].includes('×')) return [{ batchNo: parts[0], qty: r2(lineQty) }]
  const out: BatchAlloc[] = []
  for (const p of parts) {
    const i = p.lastIndexOf('×')
    if (i <= 0) { out.push({ batchNo: p, qty: r2(lineQty) }); continue }
    const q = Number(p.slice(i + 1))
    out.push({ batchNo: p.slice(0, i).trim(), qty: Number.isFinite(q) ? r2(q) : 0 })
  }
  return out.filter((a) => a.batchNo && a.qty > 0)
}

/**
 * Put stock back into the batches it came from (cancellations). Batches named in
 * batchText are restored; any qty not covered goes to fallbackBatchNo.
 */
export async function restoreBatches(tx: Tx, input: {
  companyId: string; itemId: string; warehouseId: string; qty: number; batchText?: string | null; fallbackBatchNo: string
}) {
  const tr = await trackingOf(tx, input.companyId, input.itemId)
  if (!tr.batchTracked) return
  const allocs = parseAllocation(input.batchText, input.qty)
  let left = r2(input.qty)
  for (const a of allocs) {
    const q = r2(Math.min(a.qty, left))
    if (q <= 0) continue
    await receiveBatch(tx, { companyId: input.companyId, itemId: input.itemId, warehouseId: input.warehouseId, batchNo: a.batchNo, qty: q })
    left = r2(left - q)
  }
  if (left > EPS) {
    await receiveBatch(tx, { companyId: input.companyId, itemId: input.itemId, warehouseId: input.warehouseId, batchNo: input.fallbackBatchNo, qty: left })
  }
}

/** Stock-ledger note suffix used to remember a batch allocation where the line has no batch column. */
export function batchNote(allocs: BatchAlloc[]): string {
  if (!allocs.length) return ''
  // always store explicit quantities so the note can be parsed without the line qty
  return ` · Batches: ${allocs.map((a) => `${a.batchNo}×${r2(a.qty)}`).join(', ')}`
}
/** Read the allocation back out of a ledger note written with batchNote. */
export function parseBatchNote(notes: string | null | undefined): BatchAlloc[] {
  const s = String(notes || '')
  const i = s.lastIndexOf(' · Batches: ')
  if (i < 0) return []
  return parseAllocation(s.slice(i + ' · Batches: '.length), 0)
}

// ------------------------------- serials -------------------------------

/** newline / comma separated text (or array) → trimmed, unique, non-empty serials */
export function parseSerials(text: unknown): string[] {
  const raw = Array.isArray(text) ? text.map((x) => String(x ?? '')).join('\n') : String(text ?? '')
  const out: string[] = []
  const seen = new Set<string>()
  for (const p of raw.split(/[\r\n,;]+/)) {
    const s = p.trim()
    if (!s || seen.has(s.toUpperCase())) continue
    seen.add(s.toUpperCase())
    out.push(s)
  }
  return out
}
export const joinSerials = (serials: string[]) => (serials.length ? serials.join('\n') : null)

function checkCount(it: { code: string; name: string }, serials: string[], qty: number) {
  const q = r2(qty)
  if (Math.abs(q - Math.round(q)) > EPS) throw new ApiError(`${label(it)} is serial-tracked — qty must be a whole number (got ${q})`, 400)
  if (serials.length !== Math.round(q)) {
    throw new ApiError(`${label(it)} is serial-tracked — enter exactly ${Math.round(q)} serial no(s) (got ${serials.length})`, 400)
  }
}

/** GRN / purchase in: create serials IN_STOCK (409 when one is already in stock). */
export async function receiveSerials(tx: Tx, input: {
  companyId: string; itemId: string; warehouseId: string; serials: string[]; qty: number; ref: DocRef
}): Promise<string[]> {
  const it = await itemFlags(tx, input.companyId, input.itemId)
  if (!it.trackSerial || it.type === 'SERVICE') return []
  checkCount(it, input.serials, input.qty)
  for (const serialNo of input.serials) {
    const ex = await tx.itemSerial.findUnique({ where: { companyId_itemId_serialNo: { companyId: input.companyId, itemId: input.itemId, serialNo } } })
    if (ex && ex.status === 'IN_STOCK') throw new ApiError(`Serial ${serialNo} of ${label(it)} is already in stock`, 409)
    const data = {
      status: 'IN_STOCK', warehouseId: input.warehouseId, inRefType: input.ref.type, inRefId: input.ref.id, outRefType: null, outRefId: null,
    }
    if (ex) await tx.itemSerial.update({ where: { id: ex.id }, data })
    else await tx.itemSerial.create({ data: { companyId: input.companyId, itemId: input.itemId, serialNo, ...data } })
  }
  return input.serials
}

/** Move serials from one status to another, each must currently match `from` (+ warehouse when given). */
async function moveSerials(tx: Tx, it: { code: string; name: string }, input: {
  companyId: string; itemId: string; serials: string[]; from: string; fromWarehouseId?: string; data: Prisma.ItemSerialUpdateManyMutationInput; what: string
}) {
  for (const serialNo of input.serials) {
    const upd = await tx.itemSerial.updateMany({
      where: { companyId: input.companyId, itemId: input.itemId, serialNo, status: input.from, ...(input.fromWarehouseId ? { warehouseId: input.fromWarehouseId } : {}) },
      data: input.data,
    })
    if (upd.count !== 1) throw new ApiError(`Serial ${serialNo} of ${label(it)} ${input.what}`, 409)
  }
}

/** Sale / dispatch: IN_STOCK (in that warehouse) → SOLD. */
export async function sellSerials(tx: Tx, input: {
  companyId: string; itemId: string; warehouseId: string; serials: string[]; qty: number; ref: DocRef
}): Promise<string[]> {
  const it = await itemFlags(tx, input.companyId, input.itemId)
  if (!it.trackSerial || it.type === 'SERVICE') return []
  checkCount(it, input.serials, input.qty)
  await moveSerials(tx, it, {
    companyId: input.companyId, itemId: input.itemId, serials: input.serials, from: 'IN_STOCK', fromWarehouseId: input.warehouseId,
    data: { status: 'SOLD', outRefType: input.ref.type, outRefId: input.ref.id }, what: 'is not in stock in this warehouse',
  })
  return input.serials
}

/** Sales return: SOLD → IN_STOCK in the return warehouse (the sale ref is kept as history). */
export async function returnSerials(tx: Tx, input: {
  companyId: string; itemId: string; warehouseId: string; serials: string[]; qty: number; ref: DocRef
}): Promise<string[]> {
  const it = await itemFlags(tx, input.companyId, input.itemId)
  if (!it.trackSerial || it.type === 'SERVICE') return []
  checkCount(it, input.serials, input.qty)
  await moveSerials(tx, it, {
    companyId: input.companyId, itemId: input.itemId, serials: input.serials, from: 'SOLD',
    data: { status: 'IN_STOCK', warehouseId: input.warehouseId, inRefType: input.ref.type, inRefId: input.ref.id }, what: 'is not a sold serial',
  })
  return input.serials
}

/** Purchase return: IN_STOCK (in that warehouse) → RETURNED_TO_SUPPLIER. */
export async function returnSerialsToSupplier(tx: Tx, input: {
  companyId: string; itemId: string; warehouseId: string; serials: string[]; qty: number; ref: DocRef
}): Promise<string[]> {
  const it = await itemFlags(tx, input.companyId, input.itemId)
  if (!it.trackSerial || it.type === 'SERVICE') return []
  checkCount(it, input.serials, input.qty)
  await moveSerials(tx, it, {
    companyId: input.companyId, itemId: input.itemId, serials: input.serials, from: 'IN_STOCK', fromWarehouseId: input.warehouseId,
    data: { status: 'RETURNED_TO_SUPPLIER', outRefType: input.ref.type, outRefId: input.ref.id }, what: 'is not in stock in this warehouse',
  })
  return input.serials
}

/**
 * Stock adjustment OUT / write-off: IN_STOCK (in that warehouse) → SOLD with outRefType 'ADJUSTMENT'.
 * The schema has no WRITTEN_OFF status, so a written-off serial is a SOLD serial whose out-ref is
 * the adjustment (it no longer counts as stock and cannot be dispatched again).
 */
export async function writeOffSerials(tx: Tx, input: {
  companyId: string; itemId: string; warehouseId: string; serials: string[]; qty: number; refId: string
}): Promise<string[]> {
  const it = await itemFlags(tx, input.companyId, input.itemId)
  if (!it.trackSerial || it.type === 'SERVICE') return []
  checkCount(it, input.serials, input.qty)
  await moveSerials(tx, it, {
    companyId: input.companyId, itemId: input.itemId, serials: input.serials, from: 'IN_STOCK', fromWarehouseId: input.warehouseId,
    data: { status: 'SOLD', outRefType: 'ADJUSTMENT', outRefId: input.refId }, what: 'is not in stock in this warehouse',
  })
  return input.serials
}

/** Stock transfer: IN_STOCK serials move from one warehouse to another (status unchanged). */
export async function transferSerials(tx: Tx, input: {
  companyId: string; itemId: string; fromWarehouseId: string; toWarehouseId: string; serials: string[]; qty: number
}): Promise<string[]> {
  const it = await itemFlags(tx, input.companyId, input.itemId)
  if (!it.trackSerial || it.type === 'SERVICE') return []
  checkCount(it, input.serials, input.qty)
  await moveSerials(tx, it, {
    companyId: input.companyId, itemId: input.itemId, serials: input.serials, from: 'IN_STOCK', fromWarehouseId: input.fromWarehouseId,
    data: { warehouseId: input.toWarehouseId }, what: 'is not in stock in the source warehouse',
  })
  return input.serials
}

// ---- reversals (cancellations) — keyed by the document ref ----

/** Cancelled sale: SOLD by ref → IN_STOCK. */
export async function unsellSerials(tx: Tx, companyId: string, ref: DocRef) {
  const r = await tx.itemSerial.updateMany({
    where: { companyId, status: 'SOLD', outRefType: ref.type, outRefId: ref.id },
    data: { status: 'IN_STOCK', outRefType: null, outRefId: null },
  })
  return r.count
}

/** Cancelled sales return: serials it brought in go back to SOLD (409 if one was sold / moved again). */
export async function unreturnSerials(tx: Tx, companyId: string, ref: DocRef) {
  const rows = await tx.itemSerial.findMany({ where: { companyId, inRefType: ref.type, inRefId: ref.id } })
  const moved = rows.find((s) => s.status !== 'IN_STOCK')
  if (moved) throw new ApiError(`Serial ${moved.serialNo} has already left stock again — it cannot be taken back`, 409)
  if (!rows.length) return 0
  const r = await tx.itemSerial.updateMany({
    where: { companyId, inRefType: ref.type, inRefId: ref.id, status: 'IN_STOCK' },
    data: { status: 'SOLD', inRefType: null, inRefId: null },
  })
  return r.count
}

/** Cancelled purchase return: RETURNED_TO_SUPPLIER by ref → IN_STOCK. */
export async function unreturnSerialsFromSupplier(tx: Tx, companyId: string, ref: DocRef) {
  const r = await tx.itemSerial.updateMany({
    where: { companyId, status: 'RETURNED_TO_SUPPLIER', outRefType: ref.type, outRefId: ref.id },
    data: { status: 'IN_STOCK', outRefType: null, outRefId: null },
  })
  return r.count
}

/** Cancelled receipt (GRN / bill): IN_STOCK by in-ref → removed (409 if one already left stock). */
export async function unreceiveSerials(tx: Tx, companyId: string, ref: DocRef) {
  const rows = await tx.itemSerial.findMany({ where: { companyId, inRefType: ref.type, inRefId: ref.id } })
  const moved = rows.find((s) => s.status !== 'IN_STOCK')
  if (moved) throw new ApiError(`Serial ${moved.serialNo} has already left stock — the receipt cannot be reversed`, 409)
  if (!rows.length) return 0
  const r = await tx.itemSerial.deleteMany({ where: { companyId, inRefType: ref.type, inRefId: ref.id, status: 'IN_STOCK' } })
  return r.count
}
