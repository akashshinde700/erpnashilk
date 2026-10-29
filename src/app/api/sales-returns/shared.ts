import { Prisma } from '@prisma/client'
import { salesReturnCredits } from '@/lib/party-credits'
import { db } from '@/lib/db'

/** Batch text of the challan line an invoice was billed from (invoice lines of challan bills carry no batch). */
export async function challanBatchFor(tx: Prisma.TransactionClient, challanId: string | null, itemId: string): Promise<string | null> {
  if (!challanId) return null
  const lines = await tx.deliveryChallanItem.findMany({ where: { challanId, itemId }, select: { batchNo: true } })
  const texts = Array.from(new Set(lines.map((l) => l.batchNo).filter((b): b is string => !!b)))
  return texts.length === 1 ? texts[0] : null
}

// SalesReturn has no Prisma relations (plain invoiceId/customerId/warehouseId) — attach names via JS mapping
export async function withReturnInfo<T extends { id: string; number: string; status: string; grandTotal: number; invoiceId: string; customerId: string; warehouseId: string; items: { itemId: string }[] }>(companyId: string, docs: T[]) {
  const ids = (pick: (d: T) => string) => Array.from(new Set(docs.map(pick)))
  const itemIds = Array.from(new Set(docs.flatMap((d) => d.items.map((i) => i.itemId))))
  const [invoices, customers, warehouses, items, credits] = await Promise.all([
    db.salesInvoice.findMany({ where: { companyId, id: { in: ids((d) => d.invoiceId) } }, select: { id: true, number: true, date: true, placeOfSupply: true } }),
    db.customer.findMany({ where: { companyId, id: { in: ids((d) => d.customerId) } }, select: { id: true, name: true, gstin: true, phone: true, email: true, addressLine: true, city: true, state: true, stateCode: true } }),
    db.warehouse.findMany({ where: { companyId, id: { in: ids((d) => d.warehouseId) } }, select: { id: true, code: true, name: true } }),
    db.item.findMany({ where: { companyId, id: { in: itemIds } }, select: { id: true, code: true, name: true, uom: true, hsn: true } }),
    // credit on the note: applied to its invoice / to other invoices / refunded / still owed to the customer
    salesReturnCredits(db, companyId, docs),
  ])
  const inv = new Map(invoices.map((x) => [x.id, x]))
  const cust = new Map(customers.map((x) => [x.id, x]))
  const wh = new Map(warehouses.map((x) => [x.id, x]))
  const it = new Map(items.map((x) => [x.id, x]))
  return docs.map((d) => ({
    ...d,
    invoice: inv.get(d.invoiceId) || null,
    customer: cust.get(d.customerId) || null,
    warehouse: wh.get(d.warehouseId) || null,
    items: d.items.map((i) => ({ ...i, item: it.get(i.itemId) || null })),
    credit: credits.get(d.id) ?? null,
  }))
}
