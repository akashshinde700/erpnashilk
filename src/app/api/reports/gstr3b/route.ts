import { db } from '@/lib/db'
import { ok, handleError, companyRequired, r2, requireRead } from '@/lib/erp-helpers'
import { gstTotals, headsTotal, parsePeriod, type TaxHeads } from '@/lib/accounting'

// GET /api/reports/gstr3b?companyId=&from=&to=   (UI passes a month)
// GSTR-3B summary (best effort, from documents):
//   3.1(a) outward taxable supplies = sales taxable − credit-note taxable, with tax per head
//   4(A)(5) ITC = GST on bills from registered suppliers − debit-note GST + GST on ITC-eligible expenses
//   4(D) ineligible = GST on bills from suppliers without a GSTIN
//   6.1 net payable per head = output − ITC (negative = credit carried forward; cross-head set-off not applied)
export async function GET(req: Request) {
  try {
    requireRead(req, 'gst-report') // Phase 5: financial read permission
    const companyId = await companyRequired(req)
    const { searchParams } = new URL(req.url)
    const { fromStr, toStr, from, to } = parsePeriod(searchParams)
    const date = { gte: from, lte: to }
    const billSum = { grandTotal: true, cgst: true, sgst: true, igst: true, cess: true, roundOff: true } as const

    const [gst, si, sr, unreg] = await Promise.all([
      gstTotals(companyId, date, { registeredOnly: true }),
      db.salesInvoice.aggregate({ where: { companyId, status: { not: 'CANCELLED' }, date }, _sum: billSum, _count: { _all: true } }),
      db.salesReturn.aggregate({ where: { companyId, status: { not: 'CANCELLED' }, date }, _sum: { subtotal: true }, _count: { _all: true } }),
      db.purchaseInvoice.aggregate({
        where: { companyId, status: { not: 'CANCELLED' }, date, supplier: { gstin: null } },
        _sum: { cgst: true, sgst: true, igst: true, cess: true },
      }),
    ])
    const s = si._sum
    const salesTaxable = (s.grandTotal || 0) - (s.cgst || 0) - (s.sgst || 0) - (s.igst || 0) - (s.cess || 0) - (s.roundOff || 0)
    const outwardTaxable = r2(salesTaxable - (sr._sum.subtotal || 0))

    const ineligible: TaxHeads = {
      cgst: r2(unreg._sum.cgst || 0), sgst: r2(unreg._sum.sgst || 0), igst: r2(unreg._sum.igst || 0), cess: r2(unreg._sum.cess || 0),
    }
    const heads: (keyof TaxHeads)[] = ['igst', 'cgst', 'sgst', 'cess']
    const net = Object.fromEntries(heads.map((h) => [h, r2(gst.output[h] - gst.input[h])])) as unknown as TaxHeads
    const payable = Object.fromEntries(heads.map((h) => [h, Math.max(0, net[h])])) as unknown as TaxHeads
    const credit = Object.fromEntries(heads.map((h) => [h, Math.max(0, -net[h])])) as unknown as TaxHeads

    return ok({
      from: fromStr,
      to: toStr,
      outward: {
        taxable: outwardTaxable,
        salesTaxable: r2(salesTaxable),
        returnsTaxable: r2(sr._sum.subtotal || 0),
        invoices: si._count._all,
        creditNotes: sr._count._all,
        tax: gst.output,
        totalTax: gst.outputTotal,
      },
      itc: {
        bills: gst.billItc,
        expenses: gst.expenseItc,
        total: gst.input,
        totalTax: gst.inputTotal,
        ineligible,
        ineligibleTotal: headsTotal(ineligible),
      },
      net,
      payable,
      credit,
      totalPayable: r2(headsTotal(payable)),
      totalCredit: r2(headsTotal(credit)),
      netTotal: gst.net,
    })
  } catch (e) {
    return handleError(e)
  }
}
