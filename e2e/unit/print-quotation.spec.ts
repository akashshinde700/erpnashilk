import { test, expect } from '@playwright/test'
import { quotationPrintHtml, type PrintQuotation } from '@/lib/print-quotation'

/**
 * The quotation print body used to drop the customer and item names in raw (stored XSS in the
 * same-origin print window) and printed a fixed company name on every tenant's quotation.
 */

const XSS = `</p><script>alert('xss')</script> & "Sons"`

const quotation = (over: Partial<PrintQuotation> = {}): PrintQuotation => ({
  number: 'QT-2627-000001', date: '2026-10-31', status: 'SENT',
  subtotal: 100, discountTotal: 0, cgst: 9, sgst: 9, igst: 0, grandTotal: 118,
  customer: { name: XSS, gstin: '27AAPFU0939F1ZV', city: '<b>Nashik</b>', state: 'Maharashtra' },
  items: [{ itemId: 'i1', qty: 1, rate: 100, discountPct: 0, gstRate: 18, lineTotal: 100, item: { name: `<img src=x onerror=alert(1)>` } }],
  ...over,
})

test.describe('Quotation print body', () => {
  test('party, city and item names cannot inject markup', () => {
    const html = quotationPrintHtml(quotation(), { name: 'Shree Tools', gstin: '27AAAAA0000A1Z5' })
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('<b>Nashik')
    expect(html).toContain('&lt;/p&gt;&lt;script&gt;alert(&#39;xss&#39;)&lt;/script&gt; &amp; &quot;Sons&quot;')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
  })

  test("the header is the tenant's own company, not a fixed name", () => {
    const html = quotationPrintHtml(quotation(), { name: 'Shree & Sons Tools', gstin: '27AAAAA0000A1Z5' })
    expect(html).toContain('<h1>Shree &amp; Sons Tools</h1>')
    expect(html).toContain('GSTIN 27AAAAA0000A1Z5')
    expect(html).not.toContain('Acme Precision')
  })

  test('without a company profile it falls back to a neutral heading', () => {
    expect(quotationPrintHtml(quotation(), null)).toContain('<h1>Quotation</h1>')
  })
})
