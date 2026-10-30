/**
 * Multi-currency support for billing.
 *
 * Ported from the reference GST billing app (IamRamgarhia/Free-GST-Billing-Software,
 * MIT), which lets a business raise a document in one of 22 currencies while keeping
 * the GST return in INR.
 *
 * The document stores:
 *   currency  — ISO-4217 code, default INR
 *   fxRate    — how many INR one unit of `currency` is worth (1 for INR)
 *
 * Amounts on the document are always entered in the document currency; the GST
 * reports convert to INR with `toInr()` so GSTR-1/3B stay correct.
 */

export interface CurrencyDef {
  code: string
  symbol: string
  name: string
  decimals: number
  /** Static reference rate to INR, used only as a sensible default in the form. */
  inrRate: number
}

export const CURRENCIES: CurrencyDef[] = [
  { code: 'INR', symbol: '₹', name: 'Indian Rupee', decimals: 2, inrRate: 1 },
  { code: 'USD', symbol: '$', name: 'US Dollar', decimals: 2, inrRate: 83 },
  { code: 'EUR', symbol: '€', name: 'Euro', decimals: 2, inrRate: 90 },
  { code: 'GBP', symbol: '£', name: 'British Pound', decimals: 2, inrRate: 105 },
  { code: 'AED', symbol: 'د.إ', name: 'UAE Dirham', decimals: 2, inrRate: 22.6 },
  { code: 'SAR', symbol: '﷼', name: 'Saudi Riyal', decimals: 2, inrRate: 22.1 },
  { code: 'SGD', symbol: 'S$', name: 'Singapore Dollar', decimals: 2, inrRate: 61.5 },
  { code: 'AUD', symbol: 'A$', name: 'Australian Dollar', decimals: 2, inrRate: 54.5 },
  { code: 'CAD', symbol: 'C$', name: 'Canadian Dollar', decimals: 2, inrRate: 61 },
  { code: 'JPY', symbol: '¥', name: 'Japanese Yen', decimals: 0, inrRate: 0.55 },
  { code: 'CNY', symbol: '¥', name: 'Chinese Yuan', decimals: 2, inrRate: 11.5 },
  { code: 'CHF', symbol: 'CHF', name: 'Swiss Franc', decimals: 2, inrRate: 93 },
  { code: 'HKD', symbol: 'HK$', name: 'Hong Kong Dollar', decimals: 2, inrRate: 10.6 },
  { code: 'NZD', symbol: 'NZ$', name: 'New Zealand Dollar', decimals: 2, inrRate: 50 },
  { code: 'ZAR', symbol: 'R', name: 'South African Rand', decimals: 2, inrRate: 4.5 },
  { code: 'MYR', symbol: 'RM', name: 'Malaysian Ringgit', decimals: 2, inrRate: 17.7 },
  { code: 'THB', symbol: '฿', name: 'Thai Baht', decimals: 2, inrRate: 2.3 },
  { code: 'IDR', symbol: 'Rp', name: 'Indonesian Rupiah', decimals: 0, inrRate: 0.0053 },
  { code: 'PHP', symbol: '₱', name: 'Philippine Peso', decimals: 2, inrRate: 1.45 },
  { code: 'BDT', symbol: '৳', name: 'Bangladeshi Taka', decimals: 2, inrRate: 0.7 },
  { code: 'LKR', symbol: '₨', name: 'Sri Lankan Rupee', decimals: 2, inrRate: 0.28 },
  { code: 'NPR', symbol: '₨', name: 'Nepalese Rupee', decimals: 2, inrRate: 0.62 },
]

export const CURRENCY_CODES = CURRENCIES.map((c) => c.code)

export function currencyDef(code?: string | null): CurrencyDef {
  const found = CURRENCIES.find((c) => c.code === (code || 'INR').toUpperCase())
  return found || CURRENCIES[0]
}

/** Reference INR rate for a currency — pre-fills the exchange-rate field. */
export function defaultFxRate(code?: string | null): number {
  return currencyDef(code).inrRate
}

/** Format an amount in its own currency (Indian digit grouping for INR). */
export function formatInCurrency(amount: number, code?: string | null): string {
  const def = currencyDef(code)
  const value = Number.isFinite(amount) ? amount : 0
  const locale = def.code === 'INR' ? 'en-IN' : 'en-US'
  const formatted = Math.abs(value).toLocaleString(locale, {
    minimumFractionDigits: def.decimals,
    maximumFractionDigits: def.decimals,
  })
  return `${value < 0 ? '-' : ''}${def.symbol}${formatted}`
}

/** Convert a document-currency amount into INR using the document's exchange rate. */
export function toInr(amount: number, fxRate?: number | null): number {
  const rate = Number.isFinite(fxRate) && (fxRate as number) > 0 ? (fxRate as number) : 1
  return Math.round(amount * rate * 100) / 100
}

/** True for a foreign-currency document (i.e. anything but INR). */
export function isForeignCurrency(code?: string | null): boolean {
  return currencyDef(code).code !== 'INR'
}

/**
 * Declaration printed on foreign-currency invoices — GST is payable in INR, so the
 * exchange rate used has to be visible on the document.
 */
export function fxDeclaration(code: string, rate: number): string {
  const def = currencyDef(code)
  return `Amounts billed in ${def.name} (${def.code}). Exchange rate applied: 1 ${def.code} = ₹${rate.toFixed(2)}. GST is paid in INR.`
}
