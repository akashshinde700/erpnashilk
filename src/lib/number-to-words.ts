// Indian numbering (crore / lakh / thousand / hundred) amount-in-words.
// Pure TypeScript, no dependencies. Used on GST tax invoice prints.
//
// Examples:
//   amountInWords(0)        → 'Zero'
//   amountInWords(15)       → 'Fifteen'
//   amountInWords(84016)    → 'Eighty Four Thousand Sixteen'
//   amountInWords(1250000)  → 'Twelve Lakh Fifty Thousand'
//   amountInWords(123.45)   → 'One Hundred Twenty Three and Paise Forty Five'
//   amountInWords(-500)     → 'Minus Five Hundred'

const ONES = [
  '', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
  'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen',
  'Seventeen', 'Eighteen', 'Nineteen',
]

const TENS = [
  '', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety',
]

/** 1–99 → words ('Forty Five'); 0/negative → ''. */
function twoDigitWords(n: number): string {
  if (n <= 0) return ''
  if (n < 20) return ONES[n]
  const t = TENS[Math.floor(n / 10)]
  const o = n % 10
  return o ? `${t} ${ONES[o]}` : t
}

/** Indian-system integer words. Robust well beyond 99 crore via recursion on the crore quotient. */
function integerWords(n: number): string {
  if (n <= 0) return ''
  const parts: string[] = []
  const crore = Math.floor(n / 1e7)
  const lakh = Math.floor((n % 1e7) / 1e5)
  const thousand = Math.floor((n % 1e5) / 1e3)
  const hundred = Math.floor((n % 1e3) / 100)
  const rest = n % 100
  if (crore > 0) parts.push(`${integerWords(crore)} Crore`)
  if (lakh > 0) parts.push(`${twoDigitWords(lakh)} Lakh`)
  if (thousand > 0) parts.push(`${twoDigitWords(thousand)} Thousand`)
  if (hundred > 0) parts.push(`${twoDigitWords(hundred)} Hundred`)
  if (rest > 0) parts.push(twoDigitWords(rest))
  return parts.join(' ')
}

/**
 * Convert a rupee amount to Indian-format words (no trailing 'Only' — the caller
 * adds it, e.g. `Rupees ${amountInWords(total)} Only`).
 */
export function amountInWords(amount: number): string {
  if (!Number.isFinite(amount)) return ''
  const negative = amount < 0
  const abs = Math.abs(amount)
  let rupees = Math.floor(abs)
  // Round paise separately; a floating-point carry (e.g. 1.999) rolls into the rupees.
  let paise = Math.round((abs - rupees) * 100)
  if (paise >= 100) {
    rupees += 1
    paise = 0
  }

  let words: string
  if (rupees > 0 && paise > 0) {
    words = `${integerWords(rupees)} and Paise ${twoDigitWords(paise)}`
  } else if (rupees > 0) {
    words = integerWords(rupees)
  } else if (paise > 0) {
    words = `Paise ${twoDigitWords(paise)}`
  } else {
    words = 'Zero'
  }

  return negative ? `Minus ${words}` : words
}
