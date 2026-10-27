import { db } from '@/lib/db'
import { ok, handleError, companyRequired, r2, requireRead } from '@/lib/erp-helpers'
import { fyRange, gstTotals, headsTotal, type TaxHeads } from '@/lib/accounting'

// GET /api/reports/gstr9?companyId=&fy=YYYY   (FY = 1 Apr YYYY → 31 Mar YYYY+1; default current FY)
// GSTR-9 annual return HELPER summary — computed from the same documents as GSTR-1 / GSTR-3B:
//   Table 4  outward supplies: B2B (customer has a GSTIN), B2C, credit notes (sales returns), net
//   Table 6  ITC availed: purchase bills from registered suppliers (net of debit notes) + ITC-eligible expenses
//   Table 9  tax payable (output) vs ITC per head → net cash payable / credit (cross-head set-off not applied;
//            actual tax paid through challans / electronic cash ledger is NOT recorded in the ERP)
//   Table 17 HSN summary of outward supplies (invoice lines, before credit notes)
// It is a helper to fill GSTR-9 on the portal — not a filing.

interface Row extends TaxHeads { count: number; taxable: number }
const zero = (): Row => ({ count: 0, taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 })
const roundRow = (r: Row): Row => ({ count: r.count, taxable: r2(r.taxable), igst: r2(r.igst), cgst: r2(r.cgst), sgst: r2(r.sgst), cess: r2(r.cess) })
const HEADS: (keyof TaxHeads)[] = ['igst', 'cgst', 'sgst', 'cess']

export async function GET(req: Request) {
  try {
    requireRead(req, 'gst-report') // Phase 5: financial read permission
    const companyId = await companyRequired(req)
    const { searchParams } = new URL(req.url)
    const period = fyRange(searchParams.get('fy'))
    const date = { gte: period.from, lte: period.to }

    const [company, invoices, returns, gst, unreg] = await Promise.all([
      db.company.findUnique({ where: { id: companyId }, select: { name: true, gstin: true } }),
      db.salesInvoice.findMany({
        where: { companyId, status: { not: 'CANCELLED' }, date },
        select: {
          grandTotal: true, cgst: true, sgst: true, igst: true, cess: true, roundOff: true, isInterState: true,
          customer: { select: { gstin: true } },
          items: { select: { itemId: true, hsn: true, qty: true, gstRate: true, cessRate: true, lineTotal: true } },
        },
      }),
      db.salesReturn.findMany({
        where: { companyId, status: { not: 'CANCELLED' }, date },
        select: { customerId: true, subtotal: true, cgst: true, sgst: true, igst: true },
      }),
      gstTotals(companyId, date, { registeredOnly: true }),
      db.purchaseInvoice.aggregate({
        where: { companyId, status: { not: 'CANCELLED' }, date, supplier: { gstin: null } },
        _sum: { cgst: true, sgst: true, igst: true, cess: true },
      }),
    ])

    const custIds = [...new Set(returns.map((r) => r.customerId))]
    const itemIds = [...new Set(invoices.flatMap((i) => i.items.map((l) => l.itemId)))]
    const [retCustomers, masters] = await Promise.all([
      custIds.length ? db.customer.findMany({ where: { companyId, id: { in: custIds } }, select: { id: true, gstin: true } }) : [],
      itemIds.length ? db.item.findMany({ where: { companyId, id: { in: itemIds } }, select: { id: true, name: true, hsn: true, uom: true } }) : [],
    ])
    const registered = new Set(retCustomers.filter((c) => c.gstin).map((c) => c.id))
    const itemMap = new Map(masters.map((i) => [i.id, i] as const))

    // ---- Table 4: outward supplies ----
    const b2b = zero()
    const b2c = zero()
    const hsnMap = new Map<string, { hsn: string; desc: string; uqc: string; rate: number; qty: number; taxable: number; igst: number; cgst: number; sgst: number; cess: number }>()
    for (const inv of invoices) {
      const row = inv.customer?.gstin ? b2b : b2c
      row.count += 1
      row.taxable += (inv.grandTotal || 0) - (inv.cgst || 0) - (inv.sgst || 0) - (inv.igst || 0) - (inv.cess || 0) - (inv.roundOff || 0)
      row.igst += inv.igst || 0
      row.cgst += inv.cgst || 0
      row.sgst += inv.sgst || 0
      row.cess += inv.cess || 0
      for (const l of inv.items) {
        const master = itemMap.get(l.itemId)
        const hsn = l.hsn || master?.hsn || 'NA'
        const rate = l.gstRate || 0
        const key = `${hsn}|${rate}`
        const h = hsnMap.get(key) ?? { hsn, desc: master?.name || '', uqc: (master?.uom || 'OTH').slice(0, 3).toUpperCase(), rate, qty: 0, taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 }
        const txval = l.lineTotal || 0
        const tax = (txval * rate) / 100
        h.qty += l.qty || 0
        h.taxable += txval
        if (inv.isInterState) h.igst += tax
        else { h.cgst += tax / 2; h.sgst += tax / 2 }
        h.cess += (txval * (l.cessRate || 0)) / 100
        hsnMap.set(key, h)
      }
    }
    const cnB2b = zero()
    const cnB2c = zero()
    for (const r of returns) {
      const row = registered.has(r.customerId) ? cnB2b : cnB2c
      row.count += 1
      row.taxable += r.subtotal || 0
      row.igst += r.igst || 0
      row.cgst += r.cgst || 0
      row.sgst += r.sgst || 0
    }
    const net: Row = {
      count: b2b.count + b2c.count,
      taxable: b2b.taxable + b2c.taxable - cnB2b.taxable - cnB2c.taxable,
      igst: b2b.igst + b2c.igst - cnB2b.igst - cnB2c.igst,
      cgst: b2b.cgst + b2c.cgst - cnB2b.cgst - cnB2c.cgst,
      sgst: b2b.sgst + b2c.sgst - cnB2b.sgst - cnB2c.sgst,
      cess: b2b.cess + b2c.cess,
    }

    // ---- Table 6: ITC availed ----
    const ineligible: TaxHeads = {
      cgst: r2(unreg._sum.cgst || 0), sgst: r2(unreg._sum.sgst || 0), igst: r2(unreg._sum.igst || 0), cess: r2(unreg._sum.cess || 0),
    }

    // ---- Table 9: tax payable vs ITC (per head, no cross-head set-off) ----
    const payable = Object.fromEntries(HEADS.map((h) => {
      const out = gst.output[h]
      const itc = gst.input[h]
      return [h, { payable: out, itc, cash: r2(Math.max(0, out - itc)), credit: r2(Math.max(0, itc - out)) }]
    })) as Record<keyof TaxHeads, { payable: number; itc: number; cash: number; credit: number }>

    const hsn = [...hsnMap.values()]
      .sort((a, b) => a.hsn.localeCompare(b.hsn) || a.rate - b.rate)
      .map((h) => ({ ...h, qty: r2(h.qty), taxable: r2(h.taxable), igst: r2(h.igst), cgst: r2(h.cgst), sgst: r2(h.sgst), cess: r2(h.cess), totalTax: r2(h.igst + h.cgst + h.sgst + h.cess) }))

    return ok({
      fy: period.fy,
      fyLabel: period.label,
      from: period.fromStr,
      to: period.toStr,
      company: { name: company?.name || '', gstin: company?.gstin || '' },
      table4: {
        b2b: roundRow(b2b),
        b2c: roundRow(b2c),
        creditNotesB2b: roundRow(cnB2b),
        creditNotesB2c: roundRow(cnB2c),
        net: roundRow(net),
        totalTax: r2(net.igst + net.cgst + net.sgst + net.cess),
      },
      table6: {
        bills: gst.billItc,
        expenses: gst.expenseItc,
        total: gst.input,
        totalTax: gst.inputTotal,
        ineligible,
        ineligibleTotal: headsTotal(ineligible),
      },
      table9: {
        heads: payable,
        totalPayable: gst.outputTotal,
        totalItc: gst.inputTotal,
        totalCash: r2(HEADS.reduce((s, h) => s + payable[h].cash, 0)),
        totalCredit: r2(HEADS.reduce((s, h) => s + payable[h].credit, 0)),
      },
      table17: {
        rows: hsn,
        totals: {
          qty: r2(hsn.reduce((s, h) => s + h.qty, 0)),
          taxable: r2(hsn.reduce((s, h) => s + h.taxable, 0)),
          totalTax: r2(hsn.reduce((s, h) => s + h.totalTax, 0)),
        },
      },
    })
  } catch (e) {
    return handleError(e)
  }
}
