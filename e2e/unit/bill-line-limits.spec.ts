import { test, expect } from '@playwright/test'
import { computeBillTotals, computeGst } from '../../src/lib/erp-helpers'

/**
 * A line discount above 100 % used to give a negative taxable value and a negative bill, and a huge
 * quantity silently lost paise. Both calculators now refuse such lines (every route goes through them).
 */

const line = (over: Record<string, unknown> = {}) => ({ qty: 1, rate: 100, discountPct: 0, gstRate: 18, ...over })

test.describe('bill line limits', () => {
  for (const [label, over, msg] of [
    ['discount over 100 %', { discountPct: 150 }, /discount must be between 0 and 100/],
    ['negative discount', { discountPct: -5 }, /discount must be between 0 and 100/],
    ['GST rate over 100 %', { gstRate: 180 }, /GST rate must be between 0 and 100/],
    ['negative cess', { cessRate: -1 }, /cess rate must be between 0 and 100/],
    ['quantity beyond 1e9', { qty: 1e15 }, /quantity is not a usable number/],
    ['NaN rate', { rate: Number.NaN }, /rate is not a usable number/],
    ['line value beyond ₹1e11', { qty: 1e6, rate: 1e6 }, /split it across documents/],
  ] as const) {
    test(`refuses ${label}`, () => {
      expect(() => computeBillTotals([line(over)], false)).toThrow(msg)
      expect(() => computeGst([line(over)], false)).toThrow(msg)
    })
  }

  test('refuses a negative or non-numeric freight charge', () => {
    expect(() => computeBillTotals([line()], false, { freight: { amount: -10, gstRate: 18 } })).toThrow(/freight charge/)
    expect(() => computeBillTotals([line()], false, { packing: { amount: 10, gstRate: 120 } })).toThrow(/packing GST rate/)
  })

  test('ordinary lines, a 100 % discount and the largest allowed value still work', () => {
    expect(computeBillTotals([line({ discountPct: 100 })], false).grandTotal).toBe(0)
    expect(computeBillTotals([line({ qty: 1e5, rate: 1e6 })], true).grandTotal).toBe(118000000000)
    expect(computeGst([line({ qty: 2.5, rate: 480.5, discountPct: 2.5 })], false).grandTotal).toBe(1382.04)
  })
})
