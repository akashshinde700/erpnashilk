/**
 * Unit tests for the Tally voucher and e-Invoice JSON builders.
 *
 * These are pure functions (no database, no browser), so they run in the same
 * Playwright invocation as the UI suite — see the `unit` project in
 * playwright.config.ts. They guard the accounting shape that the UI test can only
 * see through the fake API.
 */
import { test, expect } from '@playwright/test'
import { buildTallyVoucher, ledgerNames, voucherFileName, voucherToXml } from '../../src/lib/tally/voucher'
import { buildEInvoiceJson, validateForIrp } from '../../src/lib/einvoice'
import { buildMastersXml, mastersFileName } from '../../src/lib/tally/masters'

const company = {
  name: 'Nashilk Precision Works',
  gstin: '27AABCN1234M1Z8',
  state: 'Maharashtra',
  stateCode: '27',
  addressLine: 'Plot 12, Bhosari MIDC',
  city: 'Pune',
  pincode: '411026',
}

const customer = {
  name: 'Precision Tools & Co',
  gstin: '27AABCP1234C1ZU',
  addressLine: 'Shop 8, Kothrud',
  city: 'Pune',
  stateCode: '27',
  pincode: '411038',
}

const invoice = {
  id: 'si_1',
  number: 'INV/26-27/0001',
  date: new Date('2026-09-03T00:00:00.000Z'),
  status: 'POSTED',
  subtotal: 25000,
  cgst: 2250,
  sgst: 2250,
  igst: 0,
  grandTotal: 29500,
  roundOff: 0,
  placeOfSupply: '27',
  isInterState: false,
  customer,
  items: [
    {
      description: 'FG-SFT — Shaft Assembly ₹',
      itemName: 'Shaft Assembly SF-220',
      hsn: '84836090',
      uom: 'NOS',
      qty: 5,
      rate: 5000,
      amount: 25000,
      gstRate: 18,
      cessRate: 0,
    },
  ],
}

test.describe('Tally voucher builder', () => {
  test('debits the party with the grand total and balances the voucher', () => {
    const v = buildTallyVoucher(invoice as any, company)
    expect(v.remoteId).toBe('MANUFLOW-INV-si_1')
    expect(v.date).toBe('20260903')
    expect(v.party).toBe('Precision Tools & Co')
    expect(v.entries[0]).toMatchObject({ isParty: true, isDebit: true, amount: 29500 })

    const credits = v.entries.filter((e) => !e.isParty).reduce((s, e) => s + e.amount, 0)
    const stock = v.items.reduce((s, i) => s + i.amount, 0)
    expect(Math.round((credits + stock) * 100) / 100).toBe(29500)
  })

  test('puts the rounding residual on the Round Off ledger', () => {
    const rounded = buildTallyVoucher({ ...invoice, grandTotal: 29500.47, roundOff: 0.47 } as any, company)
    expect(rounded.entries.some((e) => e.ledger === 'Round Off')).toBe(true)
    const credits = rounded.entries.filter((e) => !e.isParty).reduce((s, e) => s + e.amount, 0)
    const stock = rounded.items.reduce((s, i) => s + i.amount, 0)
    expect(Math.round((credits + stock) * 100) / 100).toBe(29500.47)
  })

  test('writes TallyPrime-shaped XML with escaped, ASCII-only text', () => {
    const xml = voucherToXml(buildTallyVoucher(invoice as any, company), 'Nashilk Precision Works')
    expect(xml).toContain('<TALLYREQUEST>Import Data</TALLYREQUEST>')
    expect(xml).toContain('REMOTEID="MANUFLOW-INV-si_1"')
    expect(xml).toContain('<VOUCHERNUMBER>INV/26-27/0001</VOUCHERNUMBER>')
    expect(xml).toContain('<SVCURRENTCOMPANY>Nashilk Precision Works</SVCURRENTCOMPANY>')
    // The party name carries an ampersand — the import parser aborts on an unescaped one.
    expect(xml).toContain('<PARTYLEDGERNAME>Precision Tools &amp; Co</PARTYLEDGERNAME>')
    // Non-ASCII (the rupee sign) would be mangled by Tally, so it is transliterated away.
    expect(xml).not.toContain('₹')
    // Inventory lines + invoice-mode ledger entries.
    expect(xml).toContain('<ALLINVENTORYENTRIES.LIST>')
    expect(xml).not.toContain('ALLLEDGERENTRIES.LIST')
  })

  test('refuses cancelled invoices and missing dates', () => {
    expect(() => buildTallyVoucher({ ...invoice, status: 'CANCELLED' } as any, company)).toThrow(/cancelled/i)
    expect(() => buildTallyVoucher({ ...invoice, date: null } as any, company)).toThrow(/date/i)
  })

  test('ledger names resolve company setting → env → default', () => {
    expect(ledgerNames({ tallySalesLedger: 'Job Work Sales' }, {}).sales).toBe('Job Work Sales')
    expect(ledgerNames({}, { TALLY_LEDGER_SALES: 'Sales A/c' }).sales).toBe('Sales A/c')
    expect(ledgerNames({}, {}).sales).toBe('Sales')
    expect(voucherFileName('INV/26-27/0001', 'xml')).toBe('INV-26-27-0001_tally.xml')
  })
})

test.describe('e-Invoice JSON builder', () => {
  test('accepts a complete B2B invoice', () => {
    expect(validateForIrp(invoice as any, company)).toEqual([])
  })

  test('flags what the portal would reject', () => {
    const problems = validateForIrp({ ...invoice, items: [{ qty: 1 }], customer: { name: 'No GST' } } as any, company)
    expect(problems.some((p) => /invalid GSTIN/.test(p))).toBe(true)
    expect(problems.some((p) => /HSN/.test(p))).toBe(true)
    expect(problems.some((p) => /PIN/.test(p))).toBe(true)
    expect(validateForIrp({ ...invoice, docType: 'PROFORMA' } as any, company).some((p) => /proforma/i.test(p))).toBe(true)
  })

  test('splits CGST/SGST intra-state and IGST inter-state', () => {
    const [intra] = buildEInvoiceJson(invoice as any, company)
    expect(intra.Version).toBe('1.1')
    expect(intra.TranDtls.SupTyp).toBe('B2B')
    expect(intra.DocDtls.Dt).toBe('03/09/2026')
    expect(intra.SellerDtls.Stcd).toBe('27')
    expect(intra.BuyerDtls.Pos).toBe('27')
    expect(intra.ItemList[0]).toMatchObject({ CgstAmt: 2250, SgstAmt: 2250, IgstAmt: 0, TotItemVal: 29500, IsServc: 'N' })
    expect(intra.ValDtls.TotInvVal).toBe(29500)

    const [inter] = buildEInvoiceJson(
      {
        ...invoice,
        isInterState: true,
        cgst: 0,
        sgst: 0,
        igst: 4500,
        customer: { ...customer, gstin: '29AACCD9876K1Z3', stateCode: '29' },
      } as any,
      company,
    )
    expect(inter.BuyerDtls.Pos).toBe('29')
    expect(inter.ItemList[0]).toMatchObject({ IgstAmt: 4500, CgstAmt: 0 })
    expect(inter.ValDtls.IgstVal).toBe(4500)
  })

  test('marks SAC (99xx) lines as services', () => {
    const [doc] = buildEInvoiceJson(
      { ...invoice, items: [{ ...invoice.items[0], hsn: '998873', qty: 1, rate: 1000, amount: 1000, gstRate: 18 }] } as any,
      company,
    )
    expect(doc.ItemList[0].IsServc).toBe('Y')
  })
})

test.describe('Tally masters file', () => {
  const ledgers = {
    sales: 'Sales',
    cgst: 'Central Tax on Sales @ 9%',
    sgst: 'State Tax on Sales @ 9%',
    igst: 'Integrated Tax on Sales @ 18%',
    cess: 'Cess on Sales',
    freight: 'Transport & Freight Charges',
    roundOff: 'Round Off',
  }

  test('creates every ledger the voucher names, under the right groups', () => {
    const xml = buildMastersXml(
      {
        ledgers,
        units: ['NOS', 'KGS'],
        parties: [{ name: 'Precision Tools Pvt Ltd', gstin: '27AABCP1234C1ZU' }],
      },
      'Nashilk Precision Works',
    )
    expect(xml).toContain('<REPORTNAME>All Masters</REPORTNAME>')
    expect(xml).toContain('<SVCURRENTCOMPANY>Nashilk Precision Works</SVCURRENTCOMPANY>')
    expect(xml).toContain('<LEDGER NAME="Sales" ACTION="Create">')
    expect(xml).toContain('<PARENT>Sales Accounts</PARENT>')
    expect(xml).toContain('<PARENT>Duties &amp; Taxes</PARENT>')
    expect(xml).toContain('<LEDGER NAME="Transport &amp; Freight Charges" ACTION="Create">')
    expect(xml).toContain('<PARENT>Indirect Expenses</PARENT>')
    // Units from the item master, plus the customer as a Sundry Debtor.
    expect(xml).toContain('<UNIT NAME="NOS" ACTION="Create">')
    expect(xml).toContain('<UNIT NAME="KGS" ACTION="Create">')
    expect(xml).toContain('<LEDGER NAME="Precision Tools Pvt Ltd" ACTION="Create">')
    expect(xml).toContain('<PARENT>Sundry Debtors</PARENT>')
  })

  test('honours the configured ledger names and the party override', () => {
    const xml = buildMastersXml({
      ledgers: { ...ledgers, sales: 'Job Work Income' },
      units: ['nos'],
      parties: [{ name: 'Precision Tools Pvt Ltd', tallyLedgerName: 'PRECISION TOOLS' }],
    })
    expect(xml).toContain('<LEDGER NAME="Job Work Income" ACTION="Create">')
    expect(xml).toContain('<LEDGER NAME="PRECISION TOOLS" ACTION="Create">')
    expect(xml).not.toContain('<LEDGER NAME="Precision Tools Pvt Ltd"')
    // units are normalised and de-duplicated
    expect(xml.match(/<UNIT NAME="NOS"/g)?.length).toBe(1)
  })

  test('does not create the same ledger twice', () => {
    const xml = buildMastersXml({ ledgers: { ...ledgers, sgst: 'GST Output' , cgst: 'GST Output' }, units: [] })
    expect(xml.match(/<LEDGER NAME="GST Output"/g)?.length).toBe(1)
    expect(xml).toContain('<UNIT NAME="NOS" ACTION="Create">') // default unit when the master is empty
    expect(mastersFileName('Nashilk Precision Works')).toBe('tally-masters-nashilk-precision-works.xml')
  })
})
