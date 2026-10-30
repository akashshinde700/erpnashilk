import { test, expect } from '@playwright/test'
import { fxToInr, rchrgFlag, sumInr, toInrAmount } from '../../src/lib/gst-reports'

/**
 * The GST returns are filed in INR and reverse-charge supply is reported separately.
 * These helpers are the single place where a document's currency and RCM flag are
 * translated into return figures, so the three reports cannot drift apart.
 */
test.describe('GST return helpers', () => {
  test('an INR (or unrecorded) document is already in INR', () => {
    expect(fxToInr('INR', 83)).toBe(1)
    expect(fxToInr(null, 83)).toBe(1)
    expect(fxToInr(undefined, undefined)).toBe(1)
    expect(toInrAmount(1000, 1)).toBe(1000)
  })

  test('a foreign-currency amount is multiplied by the recorded rate', () => {
    expect(fxToInr('USD', 83)).toBe(83)
    expect(fxToInr('usd', 83.25)).toBe(83.25)
    expect(toInrAmount(1000, fxToInr('USD', 83))).toBe(83000)
    // A broken rate must never wipe the figure out of the return.
    expect(fxToInr('USD', 0)).toBe(1)
    expect(fxToInr('USD', null)).toBe(1)
    expect(fxToInr('USD', -5)).toBe(1)
  })

  test('reverse charge maps to the GSTR-1 rchrg flag', () => {
    expect(rchrgFlag(true)).toBe('Y')
    expect(rchrgFlag(false)).toBe('N')
    expect(rchrgFlag(null)).toBe('N')
    expect(rchrgFlag(undefined)).toBe('N')
  })

  test('a mixed-currency period sums in INR, row by row', () => {
    const rows = [
      { grandTotal: 1000, currency: 'INR', fxRate: 1 },
      { grandTotal: 100, currency: 'USD', fxRate: 83 },
      { grandTotal: 50000, currency: null, fxRate: null },
    ]
    expect(sumInr(rows, (r) => r.grandTotal, (r) => fxToInr(r.currency, r.fxRate))).toBe(59300)
    expect(sumInr([], (r: { grandTotal: number }) => r.grandTotal, () => 1)).toBe(0)
  })
})
