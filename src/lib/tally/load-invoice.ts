import { db } from '@/lib/db'
import { ApiError } from '@/lib/erp-helpers'

/**
 * Load one sales invoice in the shape `buildTallyVoucher()` expects.
 *
 * Shared by the file download (`GET /api/sales-invoices/:id/tally`) and the connector push
 * (`POST /api/import-center/tally/push`), so both produce exactly the same voucher XML.
 */
export async function loadTallyInvoice(id: string, companyId: string) {
  const invoice = await db.salesInvoice.findFirst({
    where: { id, companyId },
    include: {
      customer: true,
      salesOrder: { select: { number: true } },
      items: true,
    },
  })
  if (!invoice) throw new ApiError('Invoice not found', 404)

  // Line masters (HSN, UOM, display name) — SalesInvoiceItem only carries itemId
  const itemIds = Array.from(new Set(invoice.items.map((i) => i.itemId)))
  type ItemMaster = { id: string; code: string; name: string; uom: string; hsn: string | null }
  const masters: ItemMaster[] = itemIds.length
    ? await db.item.findMany({ where: { companyId, id: { in: itemIds } }, select: { id: true, code: true, name: true, uom: true, hsn: true } })
    : []
  const byId = new Map(masters.map((m) => [m.id, m]))

  const company = await db.company.findUnique({
    where: { id: companyId },
    select: {
      name: true, gstin: true, state: true, stateCode: true,
      tallyCompanyName: true, tallySalesLedger: true, tallyCgstLedger: true, tallySgstLedger: true,
      tallyIgstLedger: true, tallyFreightLedger: true, tallyRoundOffLedger: true,
    },
  })
  if (!company) throw new ApiError('Company not found', 404)

  return {
    company,
    invoice: {
      ...invoice,
      items: invoice.items.map((line) => {
        const master = byId.get(line.itemId)
        return {
          ...line,
          hsn: line.hsn || master?.hsn || '',
          uom: master?.uom || 'Nos',
          itemName: master?.name || 'Sales',
          description: [master?.code, master?.name].filter(Boolean).join(' — ') || 'Sales',
          amount: line.lineTotal,
        }
      }),
    },
  }
}

/**
 * Load one purchase bill in the shape `buildPurchaseVoucher()` expects.
 *
 * PurchaseInvoiceItem carries only itemId, so the item master (HSN, UOM, display name) is joined in
 * here — the same way the sales loader does it.
 */
export async function loadTallyBill(id: string, companyId: string) {
  const bill = await db.purchaseInvoice.findFirst({
    where: { id, companyId },
    include: { supplier: true, items: true },
  })
  if (!bill) throw new ApiError('Bill not found', 404)

  const itemIds = Array.from(new Set(bill.items.map((i) => i.itemId)))
  type ItemMaster = { id: string; code: string; name: string; uom: string; hsn: string | null }
  const masters: ItemMaster[] = itemIds.length
    ? await db.item.findMany({ where: { companyId, id: { in: itemIds } }, select: { id: true, code: true, name: true, uom: true, hsn: true } })
    : []
  const byId = new Map(masters.map((m) => [m.id, m]))

  const company = await db.company.findUnique({
    where: { id: companyId },
    select: {
      name: true, gstin: true, state: true, stateCode: true,
      tallyCompanyName: true, tallyFreightLedger: true, tallyRoundOffLedger: true,
    },
  })
  if (!company) throw new ApiError('Company not found', 404)

  return {
    company,
    bill: {
      ...bill,
      items: bill.items.map((line) => {
        const master = byId.get(line.itemId)
        return {
          ...line,
          hsn: line.hsn || master?.hsn || '',
          uom: master?.uom || 'Nos',
          itemName: master?.name || 'Purchase',
          description: [master?.code, master?.name].filter(Boolean).join(' — ') || 'Purchase',
          amount: line.lineTotal,
        }
      }),
    },
  }
}
