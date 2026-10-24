import { describe, expect, test } from 'bun:test'
import { inspectZip, parseImportFile } from '@/lib/import/parse-file'
import { IMPORT_LIMITS } from '@/lib/import/fields'
import { csv, makeXlsx, makeZip } from './helpers/files'

const cellsOf = (r: ReturnType<typeof parseImportFile>) => r.rows.map((x) => x.cells)

describe('CSV / text files', () => {
  test('UTF-8 with BOM, semicolons, row numbers kept across blank lines', () => {
    const r = parseImportFile(Buffer.from('\ufeffName;City\nShah Traders;Pune\n\nPatel & Co;Surat\n'), 'parties.csv')
    expect(r.format).toBe('csv')
    expect(cellsOf(r)).toEqual([['Name', 'City'], ['Shah Traders', 'Pune'], ['Patel & Co', 'Surat']])
    expect(r.rows.map((x) => x.line)).toEqual([1, 2, 4])
  })

  test('Windows-1252 (ANSI) exports decode instead of failing', () => {
    const r = parseImportFile(Buffer.from([0x4e, 0x61, 0x6d, 0x65, 0x0a, 0x43, 0x61, 0x66, 0xe9]), 'ansi.csv') // "Name\nCafé" in cp1252
    expect(cellsOf(r)).toEqual([['Name'], ['Café']])
  })

  test('UTF-16 "Unicode text" (tab separated)', () => {
    const body = Buffer.from('Name\tGSTIN\nभारत Steels\t27ABCDE1234F1Z5', 'utf16le')
    const r = parseImportFile(Buffer.concat([Buffer.from([0xff, 0xfe]), body]), 'export.txt')
    expect(cellsOf(r)).toEqual([['Name', 'GSTIN'], ['भारत Steels', '27ABCDE1234F1Z5']])
  })

  test('binary content, wrong extensions, empty and oversize files are refused', () => {
    expect(() => parseImportFile(Buffer.from([0x00, 0x01, 0x02, 0x41]), 'x.csv')).toThrow('not a CSV')
    expect(() => parseImportFile(Buffer.from('a,b'), 'x.pdf')).toThrow('Unsupported file type')
    expect(() => parseImportFile(Buffer.alloc(0), 'x.csv')).toThrow('empty')
    expect(() => parseImportFile(Buffer.alloc(IMPORT_LIMITS.maxFileBytes + 1, 0x41), 'x.csv')).toThrow('larger than')
  })

  test('cells and column counts are capped', () => {
    expect(() => parseImportFile(Buffer.from(`a\n${'x'.repeat(IMPORT_LIMITS.maxCellChars + 1)}`), 'x.csv')).toThrow('longer than')
    expect(() => parseImportFile(Buffer.from(Array(IMPORT_LIMITS.maxColumns + 1).fill('c').join(',')), 'x.csv')).toThrow('columns')
  })
})

describe('Excel files', () => {
  test('reads .xlsx with title rows; formulas give their saved value, never the formula', () => {
    const buf = makeXlsx({ Ledgers: [['Acme Industries'], ['List of Ledgers'], ['Ledger Name', 'GST No', 'Balance'], ['Shree Traders', '27ABCDE1234F1Z5', '=10*4']] })
    const r = parseImportFile(buf, 'ledgers.xlsx')
    expect(r.format).toBe('xlsx')
    expect(r.sheetNames).toEqual(['Ledgers'])
    expect(cellsOf(r)).toEqual([['Acme Industries', '', ''], ['List of Ledgers', '', ''], ['Ledger Name', 'GST No', 'Balance'], ['Shree Traders', '27ABCDE1234F1Z5', '42']])
    expect(r.rows.map((x) => x.line)).toEqual([1, 2, 3, 4])
  })

  test('sheet selection', () => {
    const buf = makeXlsx({ First: [['a']], Items: [['Item Name'], ['Bolt']] })
    expect(cellsOf(parseImportFile(buf, 'w.xlsx', 'Items'))).toEqual([['Item Name'], ['Bolt']])
    expect(() => parseImportFile(buf, 'w.xlsx', 'Nope')).toThrow('not found')
  })

  test('reports the real row count of a long sheet (only the allowed rows are read)', () => {
    const rows: (string | number)[][] = [['Item Name']]
    for (let i = 0; i < 700; i++) rows.push([`Item ${i}`])
    const r = parseImportFile(makeXlsx({ S: rows }), 'big.xlsx')
    expect(r.totalRows).toBe(701)
    expect(r.rows.length).toBeLessThanOrEqual(IMPORT_LIMITS.headerScanRows + 1 + IMPORT_LIMITS.maxDataRows)
  })

  test('legacy .xls, non-workbook ZIPs and extension mismatches are refused', () => {
    const ole = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0])
    expect(() => parseImportFile(ole, 'old.xls')).toThrow('.xls')
    const ods = makeZip([{ name: 'content.xml', data: Buffer.from('<x/>'), deflate: true }])
    expect(() => parseImportFile(ods, 'sheet.xlsx')).toThrow('Only Excel .xlsx')
    expect(() => parseImportFile(makeXlsx({ S: [['a']] }), 'sheet.csv')).toThrow('ends in .csv')
  })

  test('zip bombs are refused before parsing — also when the archive lies about sizes', () => {
    const huge = Buffer.alloc(IMPORT_LIMITS.maxXlsxUncompressedBytes + 1024 * 1024) // zeros compress ~1000:1
    const honest = makeZip([{ name: 'xl/workbook.xml', data: huge, deflate: true }])
    expect(honest.length).toBeLessThan(IMPORT_LIMITS.maxFileBytes)
    expect(() => inspectZip(honest)).toThrow('too large when unpacked')
    const lying = makeZip([{ name: 'xl/workbook.xml', data: huge, deflate: true, claimedSize: 100 }])
    expect(() => inspectZip(lying)).toThrow('too large when unpacked')
  })

  test('corrupt and encrypted archives are refused', () => {
    expect(() => parseImportFile(Buffer.from('PK\u0003\u0004garbage'), 'x.xlsx')).toThrow('could not be read safely')
    const enc = makeZip([{ name: 'xl/workbook.xml', data: Buffer.from('x') }])
    enc.writeUInt16LE(1, enc.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 8) // set "encrypted" flag
    expect(() => inspectZip(enc)).toThrow('password-protected')
  })

  test('CSV helper round-trip used by the API tests', () => {
    expect(cellsOf(parseImportFile(Buffer.from(csv([['a', 'b, c']])), 'x.csv'))).toEqual([['a', 'b, c']])
  })
})
