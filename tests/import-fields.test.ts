import { describe, expect, test } from 'bun:test'
import { IMPORT_DATA_TYPES, detectHeaderRow, findDataType, normalizeHeader, suggestMapping } from '@/lib/import/fields'
import { parseCsv, sniffDelimiter } from '@/lib/import/csv'

const customers = findDataType('customers')!
const items = findDataType('items')!

describe('column alias suggestions', () => {
  test('customer aliases from Tally / Vyapar style headings', () => {
    const s = suggestMapping(customers, ['Ledger Name', 'GST No.', 'Mobile', 'E-mail', 'Address', 'City', 'State', 'Pin Code', 'Opening Balance'])
    expect(s.mapping).toEqual({ name: 0, gstin: 1, phone: 2, email: 3, addressLine: 4, city: 5, state: 6, pincode: 7 })
    expect(s.matchedFrom.gstin).toBe('GST No.')
    // Opening balance is recognised but never mapped (no accounting treatment yet)
    expect(s.notImported.map((n) => n.header)).toEqual(['Opening Balance'])
  })

  test('other customer synonyms', () => {
    expect(suggestMapping(customers, ['Party Name', 'GSTIN/UIN', 'Contact Number']).mapping).toEqual({ name: 0, gstin: 1, phone: 2 })
    expect(suggestMapping(customers, ['Customer Name', 'GST Number', 'Phone']).mapping).toEqual({ name: 0, gstin: 1, phone: 2 })
  })

  test('item aliases', () => {
    const s = suggestMapping(items, ['Stock Item', 'SKU', 'HSN Code', 'Tax Rate', 'UOM', 'Purchase Price', 'Selling Price', 'Category', 'Opening Quantity'])
    expect(s.mapping).toEqual({ name: 0, code: 1, hsn: 2, gstRate: 3, uom: 4, purchasePrice: 5, sellPrice: 6, category: 7 })
    expect(s.notImported.map((n) => n.label)).toEqual(['Opening stock'])
    expect(suggestMapping(items, ['Product Name', 'Item Code', 'HSN', 'GST Rate', 'Unit', 'Sale Price']).mapping)
      .toEqual({ name: 0, code: 1, hsn: 2, gstRate: 3, uom: 4, sellPrice: 5 })
  })

  test('matching is exact after normalisation — no fuzzy guesses, each column used once', () => {
    expect(normalizeHeader(' GST No. ')).toBe('gstno')
    expect(suggestMapping(customers, ['Custmer Nme', 'GST Num']).mapping).toEqual({})
    // "Name" twice: only the first column is used
    expect(suggestMapping(customers, ['Name', 'Name']).mapping).toEqual({ name: 0 })
  })

  test('enabled data types; opening balances are check-only; vouchers are listed as planned', () => {
    expect(IMPORT_DATA_TYPES.filter((d) => d.available).map((d) => d.key)).toEqual(['customers', 'suppliers', 'items', 'opening-stock', 'opening-balances'])
    expect(findDataType('opening-balances')).toMatchObject({ commit: false })
    expect(findDataType('opening-stock')?.commit).not.toBe(false)
    for (const k of ['sales', 'purchases', 'receipts', 'payments']) {
      expect(findDataType(k)?.available).toBe(false)
    }
  })
})

describe('header row detection', () => {
  test('skips title rows of a report export', () => {
    const table = [['Acme Industries'], ['List of Ledgers'], ['1-Apr-2025 to 31-Mar-2026'], ['Ledger Name', 'GSTIN/UIN', 'State'], ['Shree Traders', '27ABCDE1234F1Z5', 'Maharashtra']]
    expect(detectHeaderRow(customers, table)).toBe(3)
  })
  test('falls back to the first row when nothing matches', () => {
    expect(detectHeaderRow(customers, [['a', 'b'], ['c', 'd']])).toBe(0)
  })
})

describe('CSV parsing', () => {
  test('delimiters, quotes and blank-row positions', () => {
    expect(sniffDelimiter('a;b;c\n1;2;3')).toBe(';')
    expect(sniffDelimiter('a\tb\n1\t2')).toBe('\t')
    expect(sniffDelimiter('"x;y",b,c')).toBe(',')
    expect(parseCsv('name,city\n"Shah, Sons","Pune"\n\n"A ""B""",X', ',', { keepBlank: true })).toEqual([['name', 'city'], ['Shah, Sons', 'Pune'], [''], ['A "B"', 'X']])
  })
})
