import { db } from '@/lib/db'
import { ok, handleError, companyRequired, r2 } from '@/lib/erp-helpers'

// GET /api/mrp?companyId=
// Material Requirements Planning:
//   demand  = net (qty - dispatched) of open sales orders, BOM-exploded for FINISHED/SEMI items
//   onHand  = sum of stock balances (all warehouses)
//   incoming= open purchase order quantities (APPROVED / PARTIALLY_RECEIVED) not yet received
//   shortage= required - onHand - incoming  (suggestedQty = max(0, shortage))
export async function GET(req: Request) {
  try {
    const companyId = await companyRequired(req)

    const [items, boms, balances, salesOrders, purchaseOrders] = await Promise.all([
      db.item.findMany({ where: { companyId } }),
      db.bom.findMany({
        where: { companyId, status: 'ACTIVE' },
        include: { items: true },
        orderBy: { createdAt: 'desc' },
      }),
      db.stockBalance.findMany({ where: { companyId } }),
      db.salesOrder.findMany({
        where: { companyId, status: { in: ['CONFIRMED', 'IN_PRODUCTION', 'PARTIALLY_DISPATCHED'] } },
        include: { items: true },
      }),
      db.purchaseOrder.findMany({
        where: { companyId, status: { in: ['APPROVED', 'PARTIALLY_RECEIVED'] } },
        include: { items: true },
      }),
    ])

    const itemMap = new Map(items.map((i) => [i.id, i]))

    // Latest ACTIVE BOM per output item
    const bomByOutput = new Map<string, (typeof boms)[number]>()
    for (const b of boms) {
      if (!bomByOutput.has(b.outputItemId)) bomByOutput.set(b.outputItemId, b)
    }

    // ---- Demand (BOM explosion) ----
    const demand = new Map<string, number>()
    const addDemand = (itemId: string, qty: number) => {
      demand.set(itemId, r2((demand.get(itemId) || 0) + qty))
    }

    for (const so of salesOrders) {
      for (const line of so.items) {
        const item = itemMap.get(line.itemId)
        if (!item || item.type === 'SERVICE') continue
        const netDemand = r2(line.qty - line.dispatchedQty)
        if (netDemand <= 0) continue

        if (item.type === 'FINISHED' || item.type === 'SEMI') {
          const bom = bomByOutput.get(item.id)
          if (bom) {
            // explode into components (with component scrap allowance)
            for (const bi of bom.items) {
              const comp = itemMap.get(bi.itemId)
              if (!comp || comp.type === 'SERVICE') continue
              addDemand(bi.itemId, bi.qty * netDemand * (1 + (bi.scrapPct || 0) / 100))
            }
          } else {
            // no BOM — demand the item itself (ordered directly)
            addDemand(item.id, netDemand)
          }
        } else {
          // RAW / CONSUMABLE ordered directly
          addDemand(item.id, netDemand)
        }
      }
    }

    // ---- On hand (all warehouses) ----
    const onHand = new Map<string, number>()
    for (const b of balances) {
      onHand.set(b.itemId, r2((onHand.get(b.itemId) || 0) + b.qty))
    }

    // ---- Incoming from open purchase orders ----
    const incoming = new Map<string, number>()
    for (const po of purchaseOrders) {
      for (const line of po.items) {
        const pending = r2(line.qty - line.receivedQty)
        if (pending > 0) {
          incoming.set(line.itemId, r2((incoming.get(line.itemId) || 0) + pending))
        }
      }
    }

    // ---- Rows ----
    const rows = Array.from(demand.entries())
      .map(([itemId, required]) => {
        const item = itemMap.get(itemId)
        const oh = r2(onHand.get(itemId) || 0)
        const inc = r2(incoming.get(itemId) || 0)
        const shortage = r2(required - oh - inc)
        return {
          itemId,
          item: item
            ? { code: item.code, name: item.name, uom: item.uom, type: item.type, reorderLevel: item.reorderLevel }
            : { code: '—', name: itemId, uom: '', type: 'UNKNOWN', reorderLevel: 0 },
          required: r2(required),
          onHand: oh,
          incoming: inc,
          shortage,
          suggestedQty: Math.max(0, shortage),
          belowReorder: !!item && item.reorderLevel > 0 && oh + inc <= item.reorderLevel,
        }
      })
      .sort((a, b) => (b.shortage - a.shortage) || a.item.code.localeCompare(b.item.code))

    return ok({ generatedAt: new Date().toISOString(), rows })
  } catch (e) {
    return handleError(e)
  }
}
