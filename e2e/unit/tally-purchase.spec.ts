import { test, expect } from '@playwright/test'
import { buildPurchaseVoucher, purchaseLedgerNames } from '@/lib/tally/voucher-purchase'
import { voucherToXml } from '@/lib/tally/voucher'

/**
 * Purchase-voucher side of the Tally connector push.
 *
 * A purchase bill is the mirror image of a sales invoice: the supplier is credited, the purchase and
 * input-tax ledgers are debited, and the voucher must balance to the paisa — Tally refuses an
 * unbalanced import with "No accounting or inventory entries are available", which reads like the
 * wrong tag but is really an arithmetic problem.
 */

const round = (n: number) => Math.round(n * 100) / 100
// In item mode the stock value rides on the inventory lines, so the debit side is
// ledger debits + those lines — exactly what Tally adds up.
const stockValue = (v: ReturnType<typeof buildPurchaseVoucher>) => round(v.items.reduce((s, i) => s + i.amount, 0))
const debit = (v: ReturnType<typeof buildPurchaseVoucher>) =>
  round(v.entries.filter((e) => e.isDebit).reduce((s, e) => s + e.amount, 0) + stockValue(v))
const credit = (v: ReturnType<typeof buildPurchaseVoucher>) =>
  round(v.entries.filter((e) => !e.isDebit).reduce((s, e) => s + e.amount, 0))

const bill = (over: Partial<Parameters<typeof buildPurchaseVoucher>[0]> = {}) => ({
  id: 'bill_1',
  number: 'BIL/26-27/0007',
  date: '2026-09-03',
  status: 'UNPAID',
  supplierInvNo: 'SUP/445',
  supplierInvDate: '2026-09-01',
  subtotal: 10000,
  cgst: 900,
  sgst: 900,
  igst: 0,
  cess: 0,
  grandTotal: 11800,
  supplier: { name: 'Shakti Steels', gstin: '27AABCU9603R1ZM' },
  items: [
    { itemName: 'EN8 Round Bar 40mm', description: 'RM-001 — EN8 Round Bar 40mm', hsn: '7214', uom: 'KG', qty: 100, rate: 100, amount: 10000 },
  ],
  ...over,
})

test.describe('Purchase voucher for the connector push', () => {
  test('balances: supplier credited, purchase + input tax debited', () => {
    const v = buildPurchaseVoucher(bill(), { name: 'Nashilk Engineering', gstin: '27AAACN1234C1Z5', state: 'Maharashtra' })

    expect(v.voucherType).toBe('Purchase')
    expect(v.remoteId).toBe('MANUFLOW-BILL-bill_1')
    expect(v.party).toBe('Shakti Steels')
    expect(v.partyGstin).toBe('27AABCU9603R1ZM')
    expect(v.grandTotal).toBe(11800)
    // Debits and credits agree to the paisa, which is what Tally checks
    expect(debit(v)).toBe(credit(v))
    expect(credit(v)).toBe(11800)
    // The supplier is the party credit, not a debit
    const party = v.entries.find((e) => e.isParty)!
    expect(party.isDebit).toBe(false)
    expect(party.amount).toBe(11800)
    // Input tax lands on the input ledgers, not the sales ones
    expect(v.entries.filter((e) => e.isDebit && e.ledger === 'Input Central Tax @ 9%').map((e) => e.amount)).toEqual([900])
    expect(v.entries.some((e) => e.ledger === 'Sales')).toBe(false)
  })

  test('the XML is a single Purchase import Tally can take', () => {
    const xml = voucherToXml(buildPurchaseVoucher(bill()), 'Nashilk Engineering')
    expect(xml.match(/<VOUCHER[\s>]/g)).toHaveLength(1)
    expect(xml).toContain('VCHTYPE="Purchase"')
    expect(xml).toContain('<VOUCHERTYPENAME>Purchase</VOUCHERTYPENAME>')
    expect(xml).toContain('REMOTEID="MANUFLOW-BILL-bill_1"')
    expect(xml).toContain('<TALLYREQUEST>Import Data</TALLYREQUEST>')
    // A purchase debits the stock item (a sales voucher credits it)
    expect(xml).toMatch(/<STOCKITEMNAME>EN8 Round Bar 40mm<\/STOCKITEMNAME>\s*<ISDEEMEDPOSITIVE>Yes</)
    expect(xml).not.toContain('<!DOCTYPE')
    expect(xml).toContain('<SVCURRENTCOMPANY>Nashilk Engineering</SVCURRENTCOMPANY>')
  })

  test('round-off keeps an odd bill balanced', () => {
    // 999.50 net + 18 % = 1179.41 → billed 1179.40 (a paise was rounded off)
    const v = buildPurchaseVoucher(bill({
      subtotal: 999.5, cgst: 89.96, sgst: 89.95, igst: 0, grandTotal: 1179.4,
      items: [{ itemName: 'EN8 Round Bar 40mm', description: 'RM-001 — EN8 Round Bar 40mm', hsn: '7214', uom: 'KG', qty: 10, rate: 99.95, amount: 999.5 }],
    }))
    // The party is credited the billed total; the odd paise ride on Round Off, so the two sides agree
    expect(debit(v)).toBe(credit(v))
    expect(v.entries.find((e) => e.isParty)!.amount).toBe(1179.4)
    expect(v.entries.some((e) => e.ledger === 'Round Off')).toBe(true)
  })

  test('warns about reverse charge and a missing GSTIN instead of failing silently', () => {
    const rcm = buildPurchaseVoucher(bill({ reverseCharge: true }))
    expect(rcm.flags.reverseCharge).toBe(true)
    expect(rcm.warnings.join(' ')).toMatch(/reverse charge/i)

    const noGstin = buildPurchaseVoucher(bill({ supplier: { name: 'Local Trader' } }))
    expect(noGstin.warnings.join(' ')).toMatch(/no GSTIN/i)
    expect(debit(noGstin)).toBe(credit(noGstin))
  })

  test('ledger names come from the environment, with Tally defaults', () => {
    const names = purchaseLedgerNames({ TALLY_LEDGER_PURCHASE: 'Purchase — Local', TALLY_LEDGER_CGST_INPUT: 'Input CGST 9' } as never)
    expect(names.purchase).toBe('Purchase — Local')
    expect(names.cgst).toBe('Input CGST 9')
    expect(names.sgst).toBe('Input State Tax @ 9%') // default kept
    const v = buildPurchaseVoucher(bill(), {}, names)
    expect(v.items[0].salesLedger).toBe('Purchase — Local')
    expect(v.entries.some((e) => e.ledger === 'Input CGST 9')).toBe(true)
  })

  test('a cancelled bill or an unusable date is refused', () => {
    expect(() => buildPurchaseVoucher(bill({ status: 'CANCELLED' }))).toThrow(/cancelled/i)
    expect(() => buildPurchaseVoucher(bill({ date: '' }))).toThrow(/date/i)
  })
})
