import { test, expect } from '@playwright/test'
import { escapeHtml, printDocument } from '@/lib/html'

/**
 * Print documents are written into a new window with document.write, and that window inherits the
 * app's origin — so anything unescaped in the shell is a stored XSS, not a cosmetic bug. The title is
 * the risky part: callers pass party names into it ("Statement of Account — <customer>").
 */

test.describe('Print document shell', () => {
  test('a party name in the title cannot break out of <title>', () => {
    const doc = printDocument('Statement of Account — </title><script>alert(1)</script>', '<p>ok</p>')
    expect(doc).toContain('&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;')
    // the only <script> left is the print trigger the shell adds itself
    expect(doc.match(/<script>/g)).toHaveLength(1)
    expect(doc).toContain('<script>window.onload = function(){ window.print(); }</script>')
  })

  test('quotes and ampersands are escaped too (attribute-safe)', () => {
    expect(escapeHtml(`R&D "Tools" 'n' <b>`)).toBe('R&amp;D &quot;Tools&quot; &#39;n&#39; &lt;b&gt;')
    expect(escapeHtml(null)).toBe('')
    expect(escapeHtml(0)).toBe('0')
  })

  test('the caller-built body is left exactly as it is', () => {
    const body = '<table><tr><td>EN8 Bar</td></tr></table>'
    expect(printDocument('Invoice INV/26-27/0001', body)).toContain(body)
  })

  test('the document is a complete, printable page', () => {
    const doc = printDocument('GSTR-2 Purchase Register', '<p>x</p>')
    expect(doc.startsWith('<!DOCTYPE html>')).toBe(true)
    expect(doc.trimEnd().endsWith('</html>')).toBe(true)
    expect(doc).toContain('@media print')
  })
})
