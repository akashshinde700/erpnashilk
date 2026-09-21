import { db } from '@/lib/db'
import { ok, handleError, companyRequired } from '@/lib/erp-helpers'

interface SearchResult { id: string; type: string; label: string; sub: string; module: string }

// GET /api/search?companyId=&q=
// Global cross-module search (items, customers, suppliers, SO, PO, sales invoices, work orders).
// SQLite `contains` is case-sensitive — for reliable case-insensitive matching we fetch bounded
// tenant-filtered sets and compare lowercased in JS (one consistent approach across all entities).
export async function GET(req: Request) {
  try {
    const companyId = await companyRequired(req)
    const { searchParams } = new URL(req.url)
    const q = (searchParams.get('q') || '').trim()
    if (q.length < 2) return ok({ results: [] })

    const needle = q.toLowerCase()
    const has = (...vals: (string | null | undefined)[]) => vals.some((v) => !!v && v.toLowerCase().includes(needle))

    const [items, customers, suppliers, salesOrders, purchaseOrders, salesInvoices, workOrders] = await Promise.all([
      db.item.findMany({ where: { companyId }, take: 1000, select: { id: true, code: true, name: true, type: true } }),
      db.customer.findMany({ where: { companyId }, take: 1000, select: { id: true, code: true, name: true, city: true } }),
      db.supplier.findMany({ where: { companyId }, take: 1000, select: { id: true, code: true, name: true, city: true } }),
      db.salesOrder.findMany({
        where: { companyId, status: { not: 'CANCELLED' } },
        take: 500, orderBy: { orderDate: 'desc' },
        select: { id: true, number: true, status: true, customer: { select: { name: true } } },
      }),
      db.purchaseOrder.findMany({
        where: { companyId },
        take: 500, orderBy: { orderDate: 'desc' },
        select: { id: true, number: true, status: true, supplier: { select: { name: true } } },
      }),
      db.salesInvoice.findMany({
        where: { companyId },
        take: 500, orderBy: { date: 'desc' },
        select: { id: true, number: true, status: true, customer: { select: { name: true } } },
      }),
      db.workOrder.findMany({
        where: { companyId },
        take: 500, orderBy: { createdAt: 'desc' },
        select: { id: true, number: true, status: true, itemId: true },
      }),
    ])

    // WorkOrder has no item relation in the schema — batch-attach item info in JS
    const woItemIds = Array.from(new Set(workOrders.map((w) => w.itemId)))
    const woItems = woItemIds.length
      ? await db.item.findMany({ where: { companyId, id: { in: woItemIds } }, select: { id: true, code: true, name: true } })
      : []
    const woItemMap = new Map(woItems.map((m) => [m.id, m]))

    const buckets: SearchResult[][] = [
      items.filter((r) => has(r.code, r.name)).slice(0, 5).map((r) => ({
        id: r.id, type: 'ITEM', label: `${r.code} — ${r.name}`, sub: r.type, module: 'items',
      })),
      customers.filter((r) => has(r.name, r.code, r.city)).slice(0, 5).map((r) => ({
        id: r.id, type: 'CUSTOMER', label: r.name, sub: [r.code, r.city].filter(Boolean).join(' · '), module: 'customers',
      })),
      suppliers.filter((r) => has(r.name, r.code, r.city)).slice(0, 5).map((r) => ({
        id: r.id, type: 'SUPPLIER', label: r.name, sub: [r.code, r.city].filter(Boolean).join(' · '), module: 'suppliers',
      })),
      salesOrders.filter((r) => has(r.number, r.customer?.name)).slice(0, 5).map((r) => ({
        id: r.id, type: 'SALES_ORDER', label: [r.number, r.customer?.name].filter(Boolean).join(' — '), sub: r.status, module: 'sales-orders',
      })),
      purchaseOrders.filter((r) => has(r.number, r.supplier?.name)).slice(0, 5).map((r) => ({
        id: r.id, type: 'PURCHASE_ORDER', label: [r.number, r.supplier?.name].filter(Boolean).join(' — '), sub: r.status, module: 'purchase-orders',
      })),
      salesInvoices.filter((r) => has(r.number, r.customer?.name)).slice(0, 5).map((r) => ({
        id: r.id, type: 'SALES_INVOICE', label: [r.number, r.customer?.name].filter(Boolean).join(' — '), sub: r.status, module: 'sales-invoices',
      })),
      workOrders.filter((r) => has(r.number, woItemMap.get(r.itemId)?.code, woItemMap.get(r.itemId)?.name)).slice(0, 5).map((r) => {
        const it = woItemMap.get(r.itemId)
        return {
          id: r.id, type: 'WORK_ORDER', label: r.number,
          sub: [it?.code, r.status].filter(Boolean).join(' · '), module: 'work-orders',
        }
      }),
    ]

    // Round-robin merge so every module gets a fair slot, cap at 25
    const results: SearchResult[] = []
    const maxLen = Math.max(0, ...buckets.map((b) => b.length))
    for (let i = 0; i < maxLen && results.length < 25; i++) {
      for (const b of buckets) {
        if (results.length >= 25) break
        if (b[i]) results.push(b[i])
      }
    }

    return ok({ results })
  } catch (e) {
    return handleError(e)
  }
}
