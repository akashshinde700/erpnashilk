/**
 * Small pure helpers shared by the GST returns.
 *
 * Two document attributes have to be applied when a transaction is turned into a
 * return figure, and getting either wrong misstates the return:
 *
 *  - **currency** — amounts are stored in the *document* currency (see
 *    `src/lib/currencies.ts`). GSTR-1 / 3B / 9 are filed in INR, so every amount
 *    is multiplied by the recorded exchange rate before it is reported.
 *  - **reverse charge** — the recipient pays the tax, so the invoice is flagged
 *    `rchrg: "Y"` in GSTR-1 and reported separately (3.1(d) / 4(A)(3)) in 3B.
 */

/** Rate that converts a document amount to INR: 1 for INR / unknown, else the recorded rate. */
export function fxToInr(currency?: string | null, fxRate?: number | null): number {
  const code = String(currency || 'INR').toUpperCase()
  if (code === 'INR') return 1
  const rate = Number(fxRate)
  return Number.isFinite(rate) && rate > 0 ? rate : 1
}

/** A stored (document-currency) amount in INR. */
export function toInrAmount(amount: number | null | undefined, rate = 1): number {
  return (Number(amount) || 0) * rate
}

/** GSTR-1 `rchrg` flag: "Y" when the recipient is liable to pay the tax. */
export function rchrgFlag(reverseCharge?: boolean | null): 'Y' | 'N' {
  return reverseCharge ? 'Y' : 'N'
}

/** Sum a list of amounts after converting each one at its own rate. */
export function sumInr<T>(rows: T[], pick: (row: T) => number | null | undefined, rate: (row: T) => number): number {
  return rows.reduce((total, row) => total + toInrAmount(pick(row), rate(row)), 0)
}
