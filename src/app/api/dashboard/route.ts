import { db } from '@/lib/db'
import { ok, handleError, companyRequired, r2 } from '@/lib/erp-helpers'

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

interface MonthBucket {
  key: string
  month: string
  start: Date
  end: Date
}

/** Last 6 months including current, as [start, end) windows with short labels. */
function lastSixMonths(now: Date): MonthBucket[] {
  const months: MonthBucket[] = []
  for (let i = 5; i >= 0; i--) {
    const start = new Date(now.getFullYear(), now.getMonth() - i, 1)
    const end = new Date(now.getFullYear(), now.getMonth() - i + 1, 1)
    months.push({
      key: `${start.getFullYear()}-${start.getMonth()}`,
      month: MONTH_LABELS[start.getMonth()],
      start,
      end,
    })
  }
  return months
}

/** Sum rows into the given month windows. */
function trendByMonth(rows: { date: Date; value: number }[], months: MonthBucket[]) {
  const sums = new Map<string, number>(months.map((m) => [m.key, 0]))
  for (const r of rows) {
    const key = `${r.date.getFullYear()}-${r.date.getMonth()}`
    sums.set(key, (sums.get(key) || 0) + r.value)
  }
  return months.map((m) => ({ month: m.month, value: r2(sums.get(m.key) || 0) }))
}

// GET /api/dashboard?companyId= — KPIs + charts + operational lists (single object)
export async function GET(req: Request) {
  try {
    const companyId = await companyRequired(req)
    const now = new Date()
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1)
    const months = lastSixMonths(now)
    const trendStart = months[0].start
    const notCancelled = { not: 'CANCELLED' }

    const [
      salesMonth,
      purchaseMonth,
      salesAll,
      purchaseAll,
      balances,
      openSO,
      openWO,
      wipRows,
      prCount,
      poCount,
      recentSOs,
      pendingPRs,
      pendingPOs,
      lowItems,
      balanceSums,
      notifications,
      salesRows,
      productionRows,
    ] = await Promise.all([
      // salesThisMonth
      db.salesInvoice.aggregate({
        _sum: { grandTotal: true },
        where: { companyId, status: notCancelled, date: { gte: monthStart, lt: monthEnd } },
      }),
      // purchasesThisMonth
      db.purchaseInvoice.aggregate({
        _sum: { grandTotal: true },
        where: { companyId, status: notCancelled, date: { gte: monthStart, lt: monthEnd } },
      }),
      // receivables = Σ(grandTotal - paidAmount), non-cancelled sales invoices
      db.salesInvoice.aggregate({ _sum: { grandTotal: true, paidAmount: true }, where: { companyId, status: notCancelled } }),
      // payables = Σ(grandTotal - paidAmount), non-cancelled purchase invoices
      db.purchaseInvoice.aggregate({ _sum: { grandTotal: true, paidAmount: true }, where: { companyId, status: notCancelled } }),
      // stockValue = Σ qty * avgRate
      db.stockBalance.findMany({ where: { companyId }, select: { qty: true, avgRate: true } }),
      // openSalesOrders (not completed/cancelled)
      db.salesOrder.count({ where: { companyId, status: { notIn: ['COMPLETED', 'CANCELLED'] } } }),
      // openWorkOrders
      db.workOrder.count({ where: { companyId, status: { notIn: ['COMPLETED', 'CANCELLED'] } } }),
      // wipQty = Σ(plannedQty - producedQty) for RELEASED / IN_PROGRESS
      db.workOrder.findMany({
        where: { companyId, status: { in: ['RELEASED', 'IN_PROGRESS'] } },
        select: { plannedQty: true, producedQty: true },
      }),
      // pendingApprovals count = PR PENDING + PO PENDING_APPROVAL
      db.purchaseRequisition.count({ where: { companyId, status: 'PENDING' } }),
      db.purchaseOrder.count({ where: { companyId, status: 'PENDING_APPROVAL' } }),
      // 5 latest sales orders
      db.salesOrder.findMany({
        where: { companyId },
        orderBy: { orderDate: 'desc' },
        take: 5,
        select: {
          id: true, number: true, status: true, grandTotal: true, orderDate: true,
          customer: { select: { name: true } },
        },
      }),
      // pending PR list
      db.purchaseRequisition.findMany({
        where: { companyId, status: 'PENDING' },
        orderBy: { date: 'desc' },
        select: { id: true, number: true, date: true, raisedBy: true, department: true },
      }),
      // pending PO list
      db.purchaseOrder.findMany({
        where: { companyId, status: 'PENDING_APPROVAL' },
        orderBy: { orderDate: 'desc' },
        select: { id: true, number: true, orderDate: true, grandTotal: true, supplier: { select: { name: true } } },
      }),
      // low-stock candidates (reorderLevel > 0)
      db.item.findMany({
        where: { companyId, reorderLevel: { gt: 0 } },
        select: { id: true, code: true, name: true, uom: true, reorderLevel: true },
      }),
      // total on-hand qty per item
      db.stockBalance.groupBy({ by: ['itemId'], _sum: { qty: true }, where: { companyId } }),
      // 5 latest unread notifications
      db.notification.findMany({
        where: { companyId, read: false },
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: { id: true, title: true, message: true, level: true, createdAt: true },
      }),
      // 6-month sales trend rows
      db.salesInvoice.findMany({
        where: { companyId, status: notCancelled, date: { gte: trendStart, lt: monthEnd } },
        select: { date: true, grandTotal: true },
      }),
      // 6-month production trend rows
      db.productionEntry.findMany({
        where: { companyId, date: { gte: trendStart, lt: monthEnd } },
        select: { date: true, producedQty: true },
      }),
    ])

    // Low stock: total balance qty per item vs reorderLevel
    const qtyByItem = new Map<string, number>()
    for (const b of balanceSums) qtyByItem.set(b.itemId, r2(b._sum.qty || 0))
    const lowRows = lowItems
      .map((it) => ({
        item: { code: it.code, name: it.name, uom: it.uom },
        reorderLevel: it.reorderLevel,
        qty: r2(qtyByItem.get(it.id) || 0),
      }))
      .filter((r) => r.qty <= r.reorderLevel)
      .sort((a, b) => a.qty / a.reorderLevel - b.qty / b.reorderLevel) // most critical first

    const pendingApprovals = [
      ...pendingPRs.map((p) => ({
        type: 'PR' as const,
        id: p.id,
        number: p.number,
        date: p.date,
        amount: 0, // PRs carry no valuation
        name: p.raisedBy || p.department || '',
      })),
      ...pendingPOs.map((p) => ({
        type: 'PO' as const,
        id: p.id,
        number: p.number,
        date: p.orderDate,
        amount: r2(p.grandTotal),
        name: p.supplier?.name || '',
      })),
    ]

    return ok({
      kpis: {
        salesThisMonth: r2(salesMonth._sum.grandTotal || 0),
        purchasesThisMonth: r2(purchaseMonth._sum.grandTotal || 0),
        receivables: r2((salesAll._sum.grandTotal || 0) - (salesAll._sum.paidAmount || 0)),
        payables: r2((purchaseAll._sum.grandTotal || 0) - (purchaseAll._sum.paidAmount || 0)),
        stockValue: r2(balances.reduce((s, b) => s + b.qty * b.avgRate, 0)),
        openSalesOrders: openSO,
        wipQty: r2(wipRows.reduce((s, w) => s + Math.max(0, w.plannedQty - w.producedQty), 0)),
        lowStockCount: lowRows.length,
        openWorkOrders: openWO,
        pendingApprovals: prCount + poCount,
      },
      charts: {
        salesTrend: trendByMonth(salesRows.map((i) => ({ date: i.date, value: i.grandTotal })), months),
        productionTrend: trendByMonth(productionRows.map((p) => ({ date: p.date, value: p.producedQty })), months),
      },
      lists: {
        recentSalesOrders: recentSOs,
        pendingApprovals,
        lowStock: lowRows.slice(0, 8),
        notifications,
      },
    })
  } catch (e) {
    return handleError(e)
  }
}
