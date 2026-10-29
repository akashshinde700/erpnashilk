import { deflateRawSync } from 'node:zlib'
import * as XLSX from 'xlsx'

/** Real .xlsx bytes (SheetJS writer). `sheets`: name → rows. Cells starting with "=" become formulas with a cached value. */
export function makeXlsx(sheets: Record<string, (string | number)[][]>): Buffer {
  const wb = XLSX.utils.book_new()
  for (const [name, rows] of Object.entries(sheets)) {
    const ws = XLSX.utils.aoa_to_sheet(rows.map((r) => r.map((c) => (typeof c === 'string' && c.startsWith('=') ? '' : c))))
    rows.forEach((r, ri) => r.forEach((c, ci) => {
      if (typeof c === 'string' && c.startsWith('=')) ws[XLSX.utils.encode_cell({ r: ri, c: ci })] = { t: 'n', f: c.slice(1), v: 42 }
    }))
    XLSX.utils.book_append_sheet(wb, ws, name)
  }
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer
}

interface Entry { name: string; data: Buffer; deflate?: boolean; claimedSize?: number }

/** Minimal ZIP writer for malformed / hostile archives (CRCs are not checked by the import guard). */
export function makeZip(entries: Entry[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const e of entries) {
    const name = Buffer.from(e.name)
    const body = e.deflate ? deflateRawSync(e.data) : e.data
    const size = e.claimedSize ?? e.data.length
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(e.deflate ? 8 : 0, 8)
    local.writeUInt32LE(body.length, 18); local.writeUInt32LE(size, 22); local.writeUInt16LE(name.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(e.deflate ? 8 : 0, 10)
    central.writeUInt32LE(body.length, 20); central.writeUInt32LE(size, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42)
    locals.push(local, name, body)
    centrals.push(central, name)
    offset += 30 + name.length + body.length
  }
  const cd = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, eocd])
}

export const csv = (rows: (string | number)[][]) =>
  rows.map((r) => r.map((c) => (/[",\n]/.test(String(c)) ? `"${String(c).replaceAll('"', '""')}"` : String(c))).join(',')).join('\n')
