import { db } from '@/lib/db'
import { ok, handleError, companyRequired, nextDocNumber, postStock, logAudit, ApiError, r2, requireWrite } from '@/lib/erp-helpers'
import { claimIdempotency, type Idempotency } from '@/lib/idempotency'
import { emitEvent } from '@/lib/emit-event'
import { batchNote, consumeBatches, parseSerials, receiveBatch, receiveSerials, writeOffSerials, type BatchAlloc } from '@/lib/batches'

const REASON_TYPES = ['DAMAGE', 'EXPIRY', 'THEFT', 'SAMPLE', 'CORRECTION', 'OTHER']

function reasonTypeOf(v: unknown, fallback: string): string {
  if (v === undefined || v === null || v === '') return fallback
  const t = String(v).trim().toUpperCase()
  if (!REASON_TYPES.includes(t)) throw new ApiError(`reasonType must be one of ${REASON_TYPES.join(', ')}`, 400)
  return t
}

// GET /api/stock-adjustments?companyId= — ADJUST_IN / ADJUST_OUT ledger rows
export async function GET(req: Request) {
  try {
    const companyId = await companyRequired(req)
    const { searchParams } = new URL(req.url)
    const itemId = searchParams.get('itemId') || undefined
    const warehouseId = searchParams.get('warehouseId') || undefined

    const [rows, warehouses] = await Promise.all([
      db.stockLedger.findMany({
        where: {
          companyId,
          type: { in: ['ADJUST_IN', 'ADJUST_OUT'] },
          ...(itemId ? { itemId } : {}),
          ...(warehouseId ? { warehouseId } : {}),
        },
        include: {
          item: { select: { code: true, name: true, uom: true } },
        },
        orderBy: { date: 'desc' },
        take: 100,
      }),
      db.warehouse.findMany({ where: { companyId }, select: { id: true, code: true, name: true } }),
    ])
    const whMap = new Map(warehouses.map((w) => [w.id, w]))

    // StockLedger has no warehouse relation in the schema — join in JS
    const items = rows.map((l) => ({ ...l, warehouse: whMap.get(l.warehouseId) || null }))

    return ok({ items, total: items.length })
  } catch (e) {
    return handleError(e)
  }
}

// POST /api/stock-adjustments  { warehouseId, date?, reason?, reasonType?, userName?, lines: [{itemId, qty, reason?, reasonType?}] }
// reasonType (DAMAGE|EXPIRY|THEFT|SAMPLE|CORRECTION|OTHER) per line, else the adjustment's, else CORRECTION
// Tracking (no-op for untracked items), per line:
//   batch items — IN: batchNo (blank = adjustment number), mfgDate?, expiryDate? · OUT: batchNo? (blank = FEFO)
//   serial items — serials (newline / comma separated, count = |qty|). IN adds them IN_STOCK; OUT writes them
//   off: status SOLD with outRefType 'ADJUSTMENT' / outRefId = adjustment number (there is no WRITTEN_OFF status).
export async function POST(req: Request) {
  let idem: Idempotency | null = null
  try {
    requireWrite(req, 'stock-adjustments')
    const body = await req.json().catch(() => ({}) as any)
    const companyId = await companyRequired(req, body.companyId)
    const { warehouseId, date, reason, userName, lines } = body

    if (!warehouseId) throw new ApiError('warehouseId is required', 400)
    if (!Array.isArray(lines) || lines.length === 0) throw new ApiError('At least one adjustment line is required', 400)

    const warehouse = await db.warehouse.findFirst({ where: { id: warehouseId, companyId } })
    if (!warehouse) throw new ApiError('Warehouse not found', 404)

    const adjDate = date ? new Date(date) : new Date()
    if (isNaN(adjDate.getTime())) throw new ApiError('Invalid date', 400)

    const defaultReasonType = reasonTypeOf(body.reasonType, 'CORRECTION')
    const cleanLines = lines
      .map((l: any) => ({
        itemId: String(l.itemId || ''), qty: r2(Number(l.qty) || 0), lineReason: (l.reason || '') as string,
        reasonType: reasonTypeOf(l?.reasonType, defaultReasonType),
        batchNo: String(l?.batchNo || '').trim(), mfgDate: l?.mfgDate || null, expiryDate: l?.expiryDate || null,
        serials: parseSerials(l?.serials),
      }))
      .filter((l: any) => l.itemId && l.qty !== 0)
    if (cleanLines.length === 0) throw new ApiError('Adjustment qty cannot be zero', 400)

    // A retried submission must not adjust stock twice. See src/lib/idempotency.ts.
    idem = await claimIdempotency(req, companyId, 'POST /api/stock-adjustments', body)
    if (idem.replay) return idem.replay

    const result = await db.$transaction(async (tx) => {
      const itemIds = Array.from(new Set(cleanLines.map((l: any) => l.itemId)))
      const itemRows = await tx.item.findMany({ where: { id: { in: itemIds }, companyId } })
      const itemMap = new Map(itemRows.map((i) => [i.id, i]))
      for (const l of cleanLines) {
        if (!itemMap.has(l.itemId)) throw new ApiError(`Item not found: ${l.itemId}`, 404)
      }

      const balances = await tx.stockBalance.findMany({
        where: { companyId, warehouseId, itemId: { in: itemIds } },
      })
      const balMap = new Map(balances.map((b) => [b.itemId, b]))

      const number = await nextDocNumber(tx as any, companyId, 'ADJ', adjDate)

      for (const l of cleanLines) {
        const item = itemMap.get(l.itemId)!
        const bal = balMap.get(l.itemId)
        const lineNotes = l.lineReason || reason || ''
        const base = {
          companyId, itemId: l.itemId, warehouseId, date: adjDate,
          refType: 'ADJUSTMENT', refNumber: number,
          notes: lineNotes || undefined,
        }

        let allocs: BatchAlloc[] = []
        if (l.qty > 0) {
          await postStock(tx as any, {
            ...base, type: 'ADJUST_IN', qtyIn: l.qty,
            rate: bal?.avgRate && bal.avgRate > 0 ? bal.avgRate : item.standardCost,
          })
          const got = await receiveBatch(tx, {
            companyId, itemId: l.itemId, warehouseId, batchNo: l.batchNo || number, mfgDate: l.mfgDate, expiryDate: l.expiryDate, qty: l.qty,
          })
          if (got) allocs = [got]
          await receiveSerials(tx, {
            companyId, itemId: l.itemId, warehouseId, serials: l.serials, qty: l.qty, ref: { type: 'ADJUSTMENT', id: number },
          })
        } else {
          const qtyOut = r2(-l.qty)
          const available = r2(bal?.qty || 0)
          if (available < qtyOut) {
            throw new ApiError(`Insufficient stock in ${warehouse.code}: ${item.code} (available ${r2(available)}, needed ${r2(qtyOut)})`, 400)
          }
          await postStock(tx as any, {
            ...base, type: 'ADJUST_OUT', qtyOut,
            rate: bal?.avgRate && bal.avgRate > 0 ? bal.avgRate : item.standardCost,
          })
          allocs = await consumeBatches(tx, { companyId, itemId: l.itemId, warehouseId, qty: qtyOut, batchNo: l.batchNo || null })
          await writeOffSerials(tx, { companyId, itemId: l.itemId, warehouseId, serials: l.serials, qty: qtyOut, refId: number })
        }
        // postStock has no reasonType — tag the row it just wrote (the only untagged one for
        // this item in this adjustment, so repeated lines of one item each keep their own reason)
        await tx.stockLedger.updateMany({
          where: { companyId, refType: 'ADJUSTMENT', refNumber: number, itemId: l.itemId, warehouseId, reasonType: null },
          data: { reasonType: l.reasonType, ...(allocs.length ? { notes: `${lineNotes}${batchNote(allocs)}` } : {}) },
        })
      }

      await logAudit(tx as any, {
        companyId, userName, action: 'POST', entity: 'StockAdjustment',
        details: `Adjustment ${number}: ${cleanLines.length} line(s) in ${warehouse.code}${reason ? ` — ${reason}` : ''}`,
      })

      const payload = { number, date: adjDate, warehouseId, lines: cleanLines.length }
      await idem!.done(tx, payload, `Stock adjustment ${number} posted`)
      return payload
    })

    void emitEvent({ companyId, title: 'Stock adjusted', message: reason || `Adjustment ${result.number}`, level: 'WARNING', topic: 'inventory' })

    return ok(result, `Stock adjustment ${result.number} posted`)
  } catch (e) {
    await idem?.release()
    return handleError(e)
  }
}
