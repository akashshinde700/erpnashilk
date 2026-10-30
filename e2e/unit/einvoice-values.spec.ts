import { test, expect } from '@playwright/test'
import { buildEInvoiceJson, FREIGHT_SAC, PACKING_SAC } from '../../src/lib/einvoice'
import { computeBillTotals } from '../../src/lib/erp-helpers'

/**
 * The IRP checks that the value block adds up: AssVal == Σ item AssAmt, and AssVal + taxes + other
 * charges + round-off == TotInvVal. The builder used to send the pre-discount subtotal as AssVal
 * and freight/packing as non-taxable "other charges", so any invoice with a discount or a charge
 * was rejected. The invoices here are built with the app's own computeBillTotals.
 */

const seller = { name: 'Shree Tools', gstin: '27AAAAA0000A1Z5', addressLine: 'Plot 1', city: 'Nashik', pincode: '422010', stateCode: '27' }
const buyer = { name: 'Buyer', gstin: '27AAPFU0939F1ZV', addressLine: 'MIDC', city: 'Nashik', pincode: '422010', stateCode: '27' }

function invoiceFrom(lines: { qty: number; rate: number; discountPct?: number; gstRate: number; hsn: string }[], adj: Parameters<typeof computeBillTotals>[2], interState = false) {
  const t = computeBillTotals(lines.map((l) => ({ qty: l.qty, rate: l.rate, discountPct: l.discountPct ?? 0, gstRate: l.gstRate })), interState, adj)
  return {
    number: 'INV-1', date: '2026-10-31', customer: buyer, isInterState: interState,
    subtotal: t.subtotal, cgst: t.cgst, sgst: t.sgst, igst: t.igst, cess: t.cess, roundOff: t.roundOff, grandTotal: t.grandTotal,
    freightCharge: t.freight, freightGstRate: adj?.freight?.gstRate, packingCharge: t.packing, packingGstRate: adj?.packing?.gstRate,
    items: lines.map((l, i) => ({ itemName: `Part ${i + 1}`, hsn: l.hsn, uom: 'NOS', qty: l.qty, rate: l.rate, discountPct: l.discountPct ?? 0, gstRate: l.gstRate, lineTotal: t.computed[i].taxable })),
  }
}

const P = (n: number) => Math.round(n * 100)

function expectBalanced(doc: ReturnType<typeof buildEInvoiceJson>[number], inv: ReturnType<typeof invoiceFrom>) {
  const items = doc.ItemList
  const sum = (k: 'AssAmt' | 'CgstAmt' | 'SgstAmt' | 'IgstAmt') => items.reduce((s, l) => s + P(l[k]), 0)
  const v = doc.ValDtls
  expect(P(v.AssVal)).toBe(sum('AssAmt'))
  expect(P(v.CgstVal)).toBe(sum('CgstAmt'))
  expect(P(v.SgstVal)).toBe(sum('SgstAmt'))
  expect(P(v.IgstVal)).toBe(sum('IgstAmt'))
  expect(P(v.AssVal) + P(v.CgstVal) + P(v.SgstVal) + P(v.IgstVal) + P(v.OthChrg) + P(v.RndOffAmt)).toBe(P(v.TotInvVal))
  expect(P(v.TotInvVal)).toBe(P(inv.grandTotal))
  for (const l of items) {
    expect(P(l.TotAmt) - P(l.Discount)).toBe(P(l.AssAmt))
    expect(P(l.AssAmt) + P(l.CgstAmt) + P(l.SgstAmt) + P(l.IgstAmt)).toBe(P(l.TotItemVal))
  }
}

test.describe('e-Invoice value block adds up', () => {
  test('line discount: 12.5 KG × 480.50 less 2.5 %, rounded to the rupee', () => {
    const inv = invoiceFrom([{ qty: 12.5, rate: 480.5, discountPct: 2.5, gstRate: 18, hsn: '7408' }], { roundOff: true })
    const [doc] = buildEInvoiceJson(inv, seller)
    expectBalanced(doc, inv)
    expect(doc.ItemList[0]).toMatchObject({ TotAmt: 6006.25, Discount: 150.16, AssAmt: 5856.09, CgstAmt: 527.05, SgstAmt: 527.05 })
    expect(doc.ValDtls).toMatchObject({ AssVal: 5856.09, RndOffAmt: -0.19, TotInvVal: 6910, OthChrg: 0 })
  })

  test('bill discount, freight and packing (the 299.00 case)', () => {
    const inv = invoiceFrom(
      [1, 2, 3].map(() => ({ qty: 1, rate: 100, gstRate: 18, hsn: '7326' })),
      { billDiscount: 1, freight: { amount: 250, gstRate: 18 }, packing: { amount: 75, gstRate: 12 }, roundOff: true },
    )
    const [doc] = buildEInvoiceJson(inv, seller)
    expectBalanced(doc, inv)
    const goods = doc.ItemList.slice(0, 3)
    expect(goods.reduce((s, l) => s + P(l.AssAmt), 0)).toBe(29900)
    expect(doc.ItemList[3]).toMatchObject({ PrdDesc: 'Freight charges', IsServc: 'Y', HsnCd: FREIGHT_SAC, AssAmt: 250, GstRt: 18, CgstAmt: 22.5, SgstAmt: 22.5 })
    expect(doc.ItemList[4]).toMatchObject({ PrdDesc: 'Packing charges', IsServc: 'Y', HsnCd: PACKING_SAC, AssAmt: 75, GstRt: 12, CgstAmt: 4.5, SgstAmt: 4.5 })
    expect(doc.ValDtls.TotInvVal).toBe(732)
  })

  test('inter-state with an odd-paisa tax and mixed rates', () => {
    const inv = invoiceFrom(
      [{ qty: 3, rate: 33.33, gstRate: 18, hsn: '7318' }, { qty: 7, rate: 12.07, discountPct: 3, gstRate: 5, hsn: '7318' }],
      { billDiscount: 7.77, freight: { amount: 99.99, gstRate: 18 } }, true,
    )
    const [doc] = buildEInvoiceJson(inv, seller)
    expectBalanced(doc, inv)
    expect(doc.ItemList.every((l) => l.CgstAmt === 0 && l.SgstAmt === 0)).toBe(true)
  })
})
