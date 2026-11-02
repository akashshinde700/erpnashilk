import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readVyaparBackup } from '@/lib/vyapar/backup'
import { VYAPAR_UNITS, vyaparPhone } from '@/lib/vyapar/shared'
import { openSqlite } from '@/lib/vyapar/sqlite'
import { vyaparBatchCount, vyaparBatchTable, vyaparRecordCount, vyaparUnit } from '@/lib/vyapar/to-import'
import { isZip, readZipEntries, zipEntryNames } from '@/lib/vyapar/zip'

/**
 * Vyapar backup import — the file reader only (no database).
 *
 * The sample is a real backup the customer sent (data/…VypBackup.vyb): a ZIP holding one .vyp
 * SQLite database of the company "SAI NIRMAN INDUSTRIES". The tests check that the reader finds the
 * same numbers Vyapar's own database has — parties, items, stock value, vouchers — and that the
 * import tables are built from them. Nothing is written.
 */

const DATA = join(import.meta.dir, '..', 'data')
// The customer's backup, as committed: the .vyb (a ZIP) unpacked into a folder with the .vyp inside.
const backupDir = join(DATA, '02-11-2026_16.27.10_SAI_NIRMAN_INDUSTRIES_VypBackup.vyb')
const VYP = join(backupDir, 'VaibhavGadge__t_2025_10_25_12_17_58_q741.vyp')
const hasSample = existsSync(VYP)
const vypBytes = hasSample ? readFileSync(VYP) : Buffer.alloc(0)

/** A real ZIP (stored entries, no compression) so the .vyb path is exercised without a second sample. */
function makeZip(entries: { name: string; data: Buffer }[]): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc32 = (b: Buffer) => {
    let c = 0xffffffff
    for (const byte of b) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const parts: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8')
    const crc = crc32(e.data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6)
    local.writeUInt16LE(0, 8); local.writeUInt16LE(0, 10); local.writeUInt16LE(0, 12)
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(e.data.length, 18); local.writeUInt32LE(e.data.length, 22)
    local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28)
    const dir = Buffer.alloc(46)
    dir.writeUInt32LE(0x02014b50, 0); dir.writeUInt16LE(20, 4); dir.writeUInt16LE(20, 6); dir.writeUInt16LE(0, 8)
    dir.writeUInt16LE(0, 10); dir.writeUInt16LE(0, 12); dir.writeUInt16LE(0, 14)
    dir.writeUInt32LE(crc, 16); dir.writeUInt32LE(e.data.length, 20); dir.writeUInt32LE(e.data.length, 24)
    dir.writeUInt16LE(name.length, 28); dir.writeUInt32LE(offset, 42)
    parts.push(local, name, e.data)
    central.push(dir, name)
    offset += local.length + name.length + e.data.length
  }
  const cd = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...parts, cd, end])
}

describe('read-only SQLite reader', () => {
  test('reads every table of the Vyapar company file', () => {
    if (!hasSample) return
    const db = openSqlite(readFileSync(VYP))
    const names = db.tableNames()
    for (const t of ['kb_firms', 'kb_names', 'kb_items', 'kb_item_units', 'kb_tax_code', 'kb_transactions', 'kb_lineitems']) {
      expect(names).toContain(t)
    }
    expect(db.table('kb_firms').rows.length).toBe(1)
    expect(db.table('kb_item_units').rows.length).toBe(31)
    expect(db.table('kb_tax_code').rows.length).toBe(33)
  })

  test('INTEGER PRIMARY KEY values come from the rowid, not from the record', () => {
    if (!hasSample) return
    const db = openSqlite(readFileSync(VYP))
    const parties = db.records('kb_names')
    const items = db.records('kb_items')
    expect(parties[0].name_id).toBe(1)
    expect(items[0].item_id).toBe(1)
    expect(new Set(parties.map((p) => p.name_id)).size).toBe(parties.length)
    expect(new Set(items.map((i) => i.item_id)).size).toBe(items.length)
  })

  test('refuses a file that is not an SQLite database', () => {
    expect(() => openSqlite(Buffer.from('PK\u0003\u0004 not a database at all'))).toThrow(/could not be read/i)
  })
})

describe('ZIP reader (.vyb)', () => {
  test('lists and extracts the .vyp inside a backup', () => {
    if (!hasSample) return
    const buf = makeZip([{ name: 'backup/SAI_NIRMAN_INDUSTRIES_VypBackup.vyp', data: vypBytes }])
    expect(isZip(buf)).toBe(true)
    expect(zipEntryNames(buf)).toEqual(['backup/SAI_NIRMAN_INDUSTRIES_VypBackup.vyp'])
    const entries = readZipEntries(buf, (n) => n.toLowerCase().endsWith('.vyp'))
    expect(entries.length).toBe(1)
    expect(entries[0].data.toString('latin1', 0, 16)).toBe('SQLite format 3\u0000')
    expect(entries[0].data.length).toBe(vypBytes.length)
  })

  test('refuses a corrupt archive instead of throwing raw zlib errors', () => {
    if (!hasSample) return
    const buf = makeZip([{ name: 'company.vyp', data: vypBytes.subarray(0, 4096) }])
    const truncated = buf.subarray(0, 100)
    expect(() => zipEntryNames(truncated)).toThrow(/could not be read/i)
  })

  test('a .vyb holding the company file reads like the .vyp itself', () => {
    if (!hasSample) return
    const buf = makeZip([{ name: 'SAI_NIRMAN_INDUSTRIES_VypBackup.vyp', data: vypBytes }])
    const { snapshot } = readVyaparBackup(buf, 'SAI_NIRMAN_INDUSTRIES_VypBackup.vyb')
    expect(snapshot.firm.name).toBe('SAI NIRMAN INDUSTRIES')
    expect(snapshot.items.length).toBeGreaterThan(0)
    expect(snapshot.source.parts).toContain('SAI_NIRMAN_INDUSTRIES_VypBackup.vyp')
  })

  test('a ZIP without a .vyp is refused with the reason', () => {
    const buf = makeZip([{ name: 'readme.txt', data: Buffer.from('not a vyapar backup') }])
    expect(() => readVyaparBackup(buf, 'backup.vyb')).toThrow(/not a Vyapar backup/i)
  })
})

describe('backup snapshot', () => {
  test('reads the company, its parties, items and stock', () => {
    if (!hasSample) return
    const buf = readFileSync(VYP)
    const { snapshot } = readVyaparBackup(buf, 'SAI_NIRMAN_INDUSTRIES.vyb')
    expect(snapshot.firm.name).toBe('SAI NIRMAN INDUSTRIES')
    expect(snapshot.firm.gstin).toBe('27BEKPG6599D1Z4')
    expect(snapshot.firm.state).toBe('Maharashtra')

    const db = openSqlite(buf)
    const names = db.records('kb_names')
    const items = db.records('kb_items')

    expect(snapshot.parties.length).toBe(names.length)
    expect(snapshot.items.length).toBe(items.length)
    expect(snapshot.stats.customers).toBe(snapshot.parties.filter((p) => p.kind === 'customer').length)
    expect(snapshot.stats.suppliers).toBe(snapshot.parties.filter((p) => p.kind === 'supplier').length)
    expect(snapshot.stats.customers).toBeGreaterThan(0)
    expect(snapshot.stats.suppliers).toBeGreaterThan(0)

    // Stock totals are Vyapar's own stock value, rounded to paise
    const withStock = snapshot.items.filter((i) => i.stockQty > 0)
    expect(snapshot.stats.itemsWithStock).toBe(withStock.length)
    expect(snapshot.stats.stockValue).toBe(Math.round(withStock.reduce((s, i) => s + i.stockValue, 0) * 100) / 100)
    expect(snapshot.stats.stockValue).toBeGreaterThan(0)

    // Vouchers are counted per type, never invented
    expect(snapshot.stats.transactions).toBe(db.records('kb_transactions').length)
    expect(snapshot.stats.txnGroups.length).toBeGreaterThan(0)
    expect(snapshot.stats.txnGroups.reduce((s, g) => s + g.count, 0)).toBe(snapshot.stats.transactions)
    // Vyapar type 1 = sale, 2 = purchase — both must be labelled, not lumped into "other"
    const labels = snapshot.stats.txnGroups.map((g) => g.label)
    expect(labels).toContain('Sales invoices')
    expect(labels).toContain('Purchase bills')

    // GST rates come from kb_tax_code through the item's tax id
    const taxed = snapshot.items.filter((i) => i.gstRate !== null)
    expect(taxed.length).toBeGreaterThan(0)
    expect(taxed.every((i) => [0, 0.25, 3, 5, 12, 18, 28, 40].includes(Number(i.gstRate)))).toBe(true)
  })

  test('reports units ManuFlow has no equivalent for, instead of guessing one', () => {
    if (!hasSample) return
    const { snapshot } = readVyaparBackup(readFileSync(VYP), 'backup.vyb')
    const mapped = new Set(Object.keys(VYAPAR_UNITS))
    for (const u of snapshot.unknownUnits) expect(mapped.has(u.unit.toUpperCase())).toBe(false)
    expect(snapshot.unknownUnits.reduce((s, u) => s + u.count, 0)).toBe(
      snapshot.items.filter((i) => !VYAPAR_UNITS[i.unit.toUpperCase()]).length,
    )
  })

  test('refuses files that are not a Vyapar backup, with a message a user can act on', () => {
    expect(() => readVyaparBackup(Buffer.from('name,phone\nA,1\n'), 'parties.csv')).toThrow(/not a Vyapar backup/i)
    expect(() => readVyaparBackup(Buffer.alloc(0), 'empty.vyb')).toThrow(/empty/i)
  })
})

describe('records → Import Center tables', () => {
  const snapshot = hasSample ? readVyaparBackup(readFileSync(VYP), 'backup.vyb').snapshot : null

  test('batch counts cover every record exactly once', () => {
    if (!snapshot) return
    for (const kind of ['customers', 'suppliers', 'items', 'opening-stock'] as const) {
      const total = vyaparRecordCount(kind, snapshot)
      expect(total).toBeGreaterThan(0)
      const batches = vyaparBatchCount(kind, snapshot)
      let seen = 0
      for (let b = 0; b < batches; b++) {
        const { table, firstRecord } = vyaparBatchTable(kind, snapshot, b)
        expect(firstRecord).toBe(seen)
        expect(table.length).toBeLessThanOrEqual(501)
        seen += table.length - 1
      }
      expect(seen).toBe(total)
    }
  })

  test('customer rows carry the party fields the import expects', () => {
    if (!snapshot) return
    const { table, mapping } = vyaparBatchTable('customers', snapshot, 0)
    expect(table[0].cells).toEqual(['Party name', 'GSTIN', 'GST type', 'Phone', 'Email', 'Address', 'State', 'Pincode'])
    expect(mapping.name).toBe(0)
    const row = table[1].cells
    expect(row[0].length).toBeGreaterThan(0)
    // GST type follows the GSTIN: registered parties are Regular, the rest Unregistered
    expect(row[2]).toBe(row[1] ? 'Regular' : 'Unregistered')
  })

  test('item rows use the chosen item type for products, SERVICE for Vyapar services', () => {
    if (!snapshot) return
    const { table } = vyaparBatchTable('items', snapshot, 0, { itemType: 'FINISHED', gstFallback: '18', uomFallback: 'NOS' })
    const header = table[0].cells
    const typeCol = header.indexOf('Item type')
    const gstCol = header.indexOf('GST rate')
    const uomCol = header.indexOf('Unit')
    for (const row of table.slice(1)) {
      expect(['FINISHED', 'SERVICE']).toContain(row.cells[typeCol])
      expect(row.cells[gstCol]).toMatch(/^\d+(\.\d+)?$/)
      expect(row.cells[uomCol].length).toBeGreaterThan(0)
    }
    // Without a fallback the gaps stay visible (the pipeline then reports them as row errors)
    const plain = vyaparBatchTable('items', snapshot, 0, { itemType: 'RAW' })
    const firstBatch = snapshot.items.filter((i) => i.active).slice(0, 500)
    const blanks = plain.table.slice(1).filter((r) => !r.cells[header.indexOf('GST rate')])
    expect(blanks.length).toBe(firstBatch.filter((i) => i.gstRate === null).length)
    expect(blanks.length).toBeGreaterThan(0)
  })

  test('opening stock rows keep Vyapar’s stock value (rate × qty = value)', () => {
    if (!snapshot) return
    const { table } = vyaparBatchTable('opening-stock', snapshot, 0)
    expect(table[0].cells).toEqual(['Item name', 'Quantity', 'Rate', 'Value'])
    for (const row of table.slice(1)) {
      const [, qty, rate, value] = row.cells
      expect(Number(qty)).toBeGreaterThan(0)
      // Same tolerance the opening-stock import uses (rate is rounded to 4 decimals)
      expect(Math.abs(Number(qty) * Number(rate) - Number(value))).toBeLessThanOrEqual(Math.max(0.5, Number(value) * 0.001))
    }
  })

  test('phone numbers are cleaned to the 10 digits the party form accepts', () => {
    expect(vyaparPhone('9822012345')).toBe('9822012345')
    expect(vyaparPhone('+91 98220 12345')).toBe('9822012345')
    expect(vyaparPhone('091-9822-012345')).toBe('9822012345')
    expect(vyaparPhone('09822012345')).toBe('9822012345')
    expect(vyaparPhone('')).toBeNull()
    expect(vyaparPhone('98230695594')).toBeNull() // 11 digits, no leading 0 — left out, not guessed
  })

  test('every party row has a valid phone or none at all', () => {
    if (!snapshot) return
    for (const kind of ['customers', 'suppliers'] as const) {
      const { table } = vyaparBatchTable(kind, snapshot, 0)
      const col = table[0].cells.indexOf('Phone')
      for (const row of table.slice(1)) {
        const phone = row.cells[col]
        expect(phone === '' || /^\d{10}$/.test(phone)).toBe(true)
      }
    }
    expect(snapshot?.stats.partiesWithoutValidPhone).toBeGreaterThan(0)
  })

  test('unmapped units use the fallback the user picked', () => {
    expect(vyaparUnit('KILOGRAMS')).toBe('KG')
    expect(vyaparUnit('Numbers')).toBe('NOS')
    expect(vyaparUnit('PACKS')).toBe('PACKS')
    expect(vyaparUnit('PACKS', 'nos')).toBe('NOS')
  })
})
