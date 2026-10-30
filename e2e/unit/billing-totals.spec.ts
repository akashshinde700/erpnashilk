import { test, expect } from '@playwright/test'
import { computeBillTotals, computeGst } from '@/lib/erp-helpers'

/**
 * Billing accuracy — the printed line column, the saved totals and the reports must agree to the paisa.
 *
 * The builder used to spread a bill discount over the lines with unrounded division and then round the
 * totals separately, which left a 1-paisa gap between Σ(line taxable) and the bill's taxable value
 * (and between the printed total and the sum of its own lines). Every assertion below is made in
 * integer paise for exactly that reason.
 */
const c = (n: number) => Math.round(n * 100)
const sum = (ns: number[]) => ns.reduce((s, n) => s + n, 0)

test.describe('Bill totals are paisa-exact', () => {
  test('a bill discount no longer drifts from the printed lines (the original bug)', () => {
    const lines = [1, 2, 3].map(() => ({ qty: 1, rate: 100, gstRate: 18 }))
    const t = computeBillTotals(lines, false, { billDiscount: 1 })

    // Σ line taxable === bill taxable (299.00), not 299.01 as before
    expect(sum(t.computed.map((l) => c(l.taxable)))).toBe(29900)
    expect(c(t.billDiscount)).toBe(100)
    // Σ line tax === CGST + SGST exactly
    expect(c(t.cgst) + c(t.sgst)).toBe(sum(t.computed.map((l) => c(l.tax))))
    // The bill total is the sum of its own printed lines
    expect(c(t.grandTotal)).toBe(29900 + c(t.cgst) + c(t.sgst))
  })

  test('random bills always reconcile (400 cases)', () => {
    // Deterministic PRNG so a failure is reproducible
    let seed = 20261030
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed / 2147483648
    }
    for (let n = 0; n < 400; n++) {
      const count = 1 + Math.floor(rnd() * 6)
      const lines = Array.from({ length: count }, () => ({
        qty: Math.round(rnd() * 5000) / 100,
        rate: Math.round(rnd() * 200000) / 100,
        discountPct: Math.round(rnd() * 3000) / 100,
        gstRate: [0, 5, 12, 18, 28][Math.floor(rnd() * 5)],
        cessRate: Math.round(rnd() * 300) / 100,
      }))
      const interState = rnd() > 0.5
      const adj = {
        billDiscount: Math.round(rnd() * 5000) / 100,
        freight: rnd() > 0.6 ? { amount: Math.round(rnd() * 2000) / 100, gstRate: 18 } : undefined,
        packing: rnd() > 0.7 ? { amount: Math.round(rnd() * 1000) / 100, gstRate: 12 } : undefined,
        roundOff: rnd() > 0.5,
      }
      const t = computeBillTotals(lines, interState, adj)
      const taxableC = sum(t.computed.map((l) => c(l.taxable)))
      const taxC = sum(t.computed.map((l) => c(l.tax)))
      const cessC = sum(t.computed.map((l) => c(l.cess)))

      // 1. the line column adds up to the bill's own taxable value
      const baseC = sum(lines.map((l) => c(l.qty * l.rate) - c(Math.round(l.qty * l.rate * 100) / 100 * ((l.discountPct || 0) / 100))))
      expect(taxableC).toBe(baseC - c(t.billDiscount))

      // 2. the tax heads are exactly the lines' tax plus the tax on the freight / packing charges
      const chargeTaxC =
        (adj.freight ? Math.round((c(adj.freight.amount) * adj.freight.gstRate) / 100) : 0) +
        (adj.packing ? Math.round((c(adj.packing.amount) * adj.packing.gstRate) / 100) : 0)
      const taxHeadsC = taxC + chargeTaxC
      expect(c(t.cgst) + c(t.sgst) + c(t.igst)).toBe(taxHeadsC)
      expect(c(t.cess)).toBe(cessC)
      if (interState) {
        expect(c(t.igst)).toBe(taxHeadsC)
        expect(c(t.cgst) + c(t.sgst)).toBe(0)
      } else {
        expect(c(t.igst)).toBe(0)
      }

      // 3. the grand total is the sum of everything that is printed on the bill
      const expectedC = taxableC + c(t.freight) + c(t.packing) + taxHeadsC + cessC
      expect(c(t.grandTotal) - c(t.roundOff)).toBe(expectedC)
      // Round-off can never move a bill by more than 50 paise, and lands on a whole rupee
      if (adj.roundOff) {
        expect(Math.abs(c(t.roundOff))).toBeLessThanOrEqual(50)
        expect(c(t.grandTotal) % 100).toBe(0)
      } else {
        expect(c(t.roundOff)).toBe(0)
      }

      // 4. no line can carry a negative taxable value
      for (const l of t.computed) expect(c(l.taxable)).toBeGreaterThanOrEqual(0)
    }
  })

  test('an over-large bill discount is capped at the bill value, never negative', () => {
    const lines = [{ qty: 2, rate: 250, gstRate: 18 }]
    const t = computeBillTotals(lines, false, { billDiscount: 1000000 })
    expect(c(t.billDiscount)).toBe(50000)
    expect(c(t.grandTotal)).toBe(0)
    expect(c(t.computed[0].taxable)).toBe(0)
    expect(c(t.computed[0].tax)).toBe(0)
    // and a negative discount is treated as none
    expect(c(computeBillTotals(lines, false, { billDiscount: -50 }).billDiscount)).toBe(0)
  })

  test('freight and packing are taxable charges, round-off lands on a rupee', () => {
    const lines = [{ qty: 1, rate: 1000, gstRate: 18 }]
    const t = computeBillTotals(lines, false, { freight: { amount: 100, gstRate: 18 }, packing: { amount: 50, gstRate: 12 } })
    expect(c(t.freight)).toBe(10000)
    expect(c(t.packing)).toBe(5000)
    // 1000 @18% = 180 · freight 100 @18% = 18 · packing 50 @12% = 6
    expect(c(t.cgst) + c(t.sgst)).toBe(c(204))
    expect(c(t.grandTotal)).toBe(c(1000 + 150 + 204))

    const rounded = computeBillTotals(lines, false, { freight: { amount: 4.33, gstRate: 18 }, roundOff: true })
    expect(c(rounded.grandTotal) % 100).toBe(0)
  })

  test('service and zero-qty lines do not break the totals', () => {
    const t = computeBillTotals([
      { qty: 0, rate: 500, gstRate: 18 },
      { qty: 1, rate: 4500, gstRate: 18, cessRate: 0 },
    ], false, { billDiscount: 100 })
    expect(c(t.computed[0].taxable)).toBe(0)
    expect(c(t.computed[1].taxable)).toBe(c(4400))
    expect(c(t.grandTotal)).toBe(c(4400 + 792))
    const empty = computeBillTotals([], false, { billDiscount: 20 })
    expect(empty.grandTotal).toBe(0)
    expect(empty.billDiscount).toBe(0)
  })

  test('quotation/PO totals (computeGst) use the same rounding rule', () => {
    const t = computeGst([{ qty: 3, rate: 33.335, discountPct: 2.5, gstRate: 18 }], false)
    expect(c(t.subtotal)).toBe(c(100.01))
    expect(c(t.cgst) + c(t.sgst)).toBe(c(t.computed[0].tax))
    expect(c(t.grandTotal)).toBe(c(t.subtotal - t.discountTotal + t.cgst + t.sgst + t.igst))
  })
})
