import { db } from '@/lib/db'

// Shared by /api/purchase-returns and /api/purchase-returns/[id] (route files may only export handlers).

/** Bill status from its paid amount (cancelled bills are never touched here). */
export function billStatus(grandTotal: number, paidAmount: number) {
  if (paidAmount <= 0.005) return 'UNPAID'
  return grandTotal - paidAmount <= 0.01 ? 'PAID' : 'PARTIALLY_PAID'
}

// PurchaseReturn has no relations besides its items — attach item / bill / supplier / warehouse info for the UI.
export async function attachReturnInfo<T extends { invoiceId: string; supplierId: string; warehouseId: string; items: { itemId: string }[] }>(companyId: string, docs: T[]) {
  const itemIds = Array.from(new Set(docs.flatMap((d) => d.items.map((i) => i.itemId))))
  const invIds = Array.from(new Set(docs.map((d) => d.invoiceId)))
  const supIds = Array.from(new Set(docs.map((d) => d.supplierId)))
  const whIds = Array.from(new Set(docs.map((d) => d.warehouseId)))
  const [items, invoices, suppliers, warehouses] = await Promise.all([
    itemIds.length ? db.item.findMany({ where: { companyId, id: { in: itemIds } }, select: { id: true, code: true, name: true, uom: true, hsn: true } }) : [],
    invIds.length ? db.purchaseInvoice.findMany({ where: { companyId, id: { in: invIds } }, select: { id: true, number: true, date: true, supplierInvNo: true, supplierInvDate: true } }) : [],
    supIds.length ? db.supplier.findMany({ where: { companyId, id: { in: supIds } }, select: { id: true, code: true, name: true, gstin: true, addressLine: true, city: true, state: true, stateCode: true } }) : [],
    whIds.length ? db.warehouse.findMany({ where: { companyId, id: { in: whIds } }, select: { id: true, code: true, name: true } }) : [],
  ])
  const im = new Map(items.map((i) => [i.id, i] as const))
  const vm = new Map(invoices.map((i) => [i.id, i] as const))
  const sm = new Map(suppliers.map((s) => [s.id, s] as const))
  const wm = new Map(warehouses.map((w) => [w.id, w] as const))
  return docs.map((d) => ({
    ...d,
    invoice: vm.get(d.invoiceId) || null,
    supplier: sm.get(d.supplierId) || null,
    warehouse: wm.get(d.warehouseId) || null,
    items: d.items.map((i) => ({ ...i, item: im.get(i.itemId) || null })),
  }))
}
