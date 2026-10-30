import { test, expect } from '@playwright/test'
import { buildTallyVoucher, ledgerNames, voucherToXml } from '@/lib/tally/voucher'
import { MAX_PUSH_XML_BYTES, checkPushXml, pushEnabled } from '@/lib/tally/push-xml'

/**
 * Push to Tally (connector) — the envelope checks.
 *
 * The connector repeats these checks before it posts anything to Tally, so a regression here would
 * either block a valid voucher or (worse) let something other than one sales voucher through.
 */

const invoice = {
  id: 'si_1',
  number: 'INV/26-27/0001',
  date: new Date('2026-09-10T00:00:00.000Z'),
  grandTotal: 29500,
  subtotal: 25000,
  cgst: 2250,
  sgst: 2250,
  igst: 0,
  cess: 0,
  roundOff: 0,
  isInterState: false,
  customer: { name: 'Precision Tools Pvt Ltd', gstin: '27AABCP1234C1ZU', state: 'Maharashtra' },
  items: [
    { itemId: 'itm_1', description: 'RM-EN8 — EN8 Round Bar 40mm', hsn: '7214', qty: 10, rate: 2500, uom: 'KG', amount: 25000, gstRate: 18 },
  ],
}

const company = { name: 'Nashilk Precision', gstin: '27AABCN9999C1Z2', state: 'Maharashtra', stateCode: '27' }

function voucherXml(): string {
  return voucherToXml(buildTallyVoucher(invoice as never, company as never, ledgerNames(company as never)), 'Nashilk Precision')
}

test.describe('Push to Tally envelope', () => {
  test('the server-built voucher is a single Import envelope Tally can take', () => {
    const xml = voucherXml()
    expect(checkPushXml(xml)).toBeNull()
    expect(xml).toContain('<TALLYREQUEST>Import Data</TALLYREQUEST>')
    expect(xml).toContain('ACTION="Create"')
    expect(xml).toContain('<VOUCHERNUMBER>INV/26-27/0001</VOUCHERNUMBER>')
  })

  test('anything that is not one create-voucher is refused', () => {
    const xml = voucherXml()
    expect(checkPushXml('')).toBe('empty')
    expect(checkPushXml(undefined)).toBe('empty')

    // A DTD could define its own entities — never accepted.
    expect(checkPushXml(xml.replace('<ENVELOPE>', '<!DOCTYPE x [<!ENTITY a "b">]><ENVELOPE>'))).toBe('unsafe_xml')

    // An Export (read) request is not a push.
    expect(checkPushXml(xml.replace('Import Data', 'Export'))).toBe('not_an_import')

    // Deleting / altering is never pushed.
    expect(checkPushXml(xml.replace('ACTION="Create"', 'ACTION="Delete"'))).toBe('not_a_create')

    // Two vouchers in one job would break the "one invoice = one job" rule.
    const doubled = xml.replace('</TALLYMESSAGE>', '</TALLYMESSAGE><TALLYMESSAGE><VOUCHER VCHTYPE="Sales"></VOUCHER>')
    expect(checkPushXml(doubled)).toBe('one_voucher_only')

    // Too large for a voucher (and bigger than the connector would accept).
    expect(checkPushXml(xml + 'x'.repeat(MAX_PUSH_XML_BYTES))).toBe('too_large')
  })

  test('the push switch is off unless the server opts in', () => {
    expect(pushEnabled({})).toBe(false)
    expect(pushEnabled({ TALLY_CONNECTOR_PUSH: '0' })).toBe(false)
    expect(pushEnabled({ TALLY_CONNECTOR_PUSH: '1' })).toBe(true)
  })
})
