import { db } from '@/lib/db'
import { ok, handleError, companyRequired, r2, requireRead } from '@/lib/erp-helpers'
import { parsePeriod } from '@/lib/accounting'

// GET /api/reports/gstr2?companyId=&from=&to=   (UI passes a month)
// Purchase register (GSTR-2 style): every non-cancelled bill with supplier GSTIN, taxable value,
// CGST / SGST / IGST / cess and an ITC-eligible flag (bills from suppliers with a GSTIN), the debit
// notes of the period, and a supplier-GSTIN-wise summary.
export async function GET(req: Request) {
  try {
    requireRead(req, 'gst-report') // Phase 5: financial read permission
    const companyId = await companyRequired(req)
    const { searchParams } = new URL(req.url)
    const { fromStr, toStr, from, to } = parsePeriod(searchParams)
    const date = { gte: from, lte: to }

    const [bills, returns] = await Promise.all([
      db.purchaseInvoice.findMany({
        where: { companyId, status: { not: 'CANCELLED' }, date },
        orderBy: { date: 'asc' },
        select: {
          id: true, number: true, supplierInvNo: true, supplierInvDate: true, date: true, isInterState: true,
          grandTotal: true, cgst: true, sgst: true, igst: true, cess: true, roundOff: true,
          supplier: { select: { id: true, name: true, gstin: true, state: true } },
        },
      }),
      db.purchaseReturn.findMany({
        where: { companyId, status: { not: 'CANCELLED' }, date },
        orderBy: { date: 'asc' },
        select: { id: true, number: true, date: true, invoiceId: true, supplierId: true, subtotal: true, cgst: true, sgst: true, igst: true, grandTotal: true },
      }),
    ])
    const suppIds = [...new Set(returns.map((r) => r.supplierId))]
    const invIds = [...new Set(returns.map((r) => r.invoiceId))]
    const [rSupps, rInvs] = await Promise.all([
      suppIds.length ? db.supplier.findMany({ where: { companyId, id: { in: suppIds } }, select: { id: true, name: true, gstin: true } }) : [],
      invIds.length ? db.purchaseInvoice.findMany({ where: { companyId, id: { in: invIds } }, select: { id: true, number: true } }) : [],
    ])
    const suppMap = new Map(rSupps.map((s) => [s.id, s] as const))
    const invMap = new Map(rInvs.map((i) => [i.id, i.number] as const))

    const items = bills.map((b) => {
      const taxable = r2(b.grandTotal - b.cgst - b.sgst - b.igst - b.cess - b.roundOff)
      return {
        id: b.id,
        number: b.number,
        supplierInvNo: b.supplierInvNo,
        supplierInvDate: b.supplierInvDate,
        date: b.date,
        supplierId: b.supplier?.id ?? null,
        supplierName: b.supplier?.name || '—',
        gstin: b.supplier?.gstin || null,
        state: b.supplier?.state || null,
        isInterState: b.isInterState,
        taxable,
        cgst: r2(b.cgst), sgst: r2(b.sgst), igst: r2(b.igst), cess: r2(b.cess),
        totalTax: r2(b.cgst + b.sgst + b.igst + b.cess),
        grandTotal: r2(b.grandTotal),
        itcEligible: !!b.supplier?.gstin,
      }
    })
    const debitNotes = returns.map((r) => {
      const s = suppMap.get(r.supplierId)
      return {
        id: r.id, number: r.number, date: r.date, invoiceNumber: invMap.get(r.invoiceId) || '—',
        supplierName: s?.name || '—', gstin: s?.gstin || null,
        taxable: r2(r.subtotal), cgst: r2(r.cgst), sgst: r2(r.sgst), igst: r2(r.igst), grandTotal: r2(r.grandTotal),
      }
    })

    const groups = new Map<string, { key: string; gstin: string | null; name: string; bills: number; taxable: number; cgst: number; sgst: number; igst: number; cess: number; total: number; itcEligible: boolean }>()
    for (const b of items) {
      const key = b.gstin || `UNREG:${b.supplierId}`
      const g = groups.get(key) ?? { key, gstin: b.gstin, name: b.supplierName, bills: 0, taxable: 0, cgst: 0, sgst: 0, igst: 0, cess: 0, total: 0, itcEligible: b.itcEligible }
      g.bills += 1
      g.taxable = r2(g.taxable + b.taxable)
      g.cgst = r2(g.cgst + b.cgst)
      g.sgst = r2(g.sgst + b.sgst)
      g.igst = r2(g.igst + b.igst)
      g.cess = r2(g.cess + b.cess)
      g.total = r2(g.total + b.grandTotal)
      groups.set(key, g)
    }

    const t = (k: 'taxable' | 'cgst' | 'sgst' | 'igst' | 'cess' | 'grandTotal', rows = items) => r2(rows.reduce((s, r) => s + r[k], 0))
    const eligible = items.filter((b) => b.itcEligible)
    const totals = {
      bills: items.length,
      taxable: t('taxable'), cgst: t('cgst'), sgst: t('sgst'), igst: t('igst'), cess: t('cess'), grandTotal: t('grandTotal'),
      itcEligibleTax: r2(eligible.reduce((s, b) => s + b.totalTax, 0)),
      itcIneligibleTax: r2(items.filter((b) => !b.itcEligible).reduce((s, b) => s + b.totalTax, 0)),
      debitNotes: debitNotes.length,
      debitNoteTax: r2(debitNotes.reduce((s, d) => s + d.cgst + d.sgst + d.igst, 0)),
    }

    return ok({
      items,
      debitNotes,
      bySupplier: [...groups.values()].sort((a, b) => b.total - a.total),
      totals,
      from: fromStr,
      to: toStr,
    })
  } catch (e) {
    return handleError(e)
  }
}
