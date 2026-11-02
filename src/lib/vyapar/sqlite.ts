/**
 * Minimal, read-only SQLite file reader — just enough for a Vyapar backup (.vyp).
 *
 * Why not a library: the file is an untrusted upload that has to be read on the server of the ERP,
 * and the app must not gain a native SQLite binding (Prisma talks to MySQL in production; the server
 * runs on Bun in production and Node in development, so a runtime-specific module such as
 * `bun:sqlite` / `node:sqlite` cannot be used for both). This module only parses the file format:
 * the header, `sqlite_master`, table b-tree pages (leaf + interior), overflow chains and the record
 * format. Nothing is executed, nothing is written, and every structure is bounds-checked.
 *
 * Supported: SQLite format 3, UTF-8 / UTF-16 (LE + BE) text, all serial types, WITHOUT ROWID tables
 * are refused (Vyapar does not use them). Not supported: WAL (a Vyapar backup is a single file).
 *
 * Reference: https://www.sqlite.org/fileformat2.html
 */

export type SqliteValue = null | number | string | Uint8Array

export interface SqliteColumn {
  name: string
  /** Declared type text, upper-cased (`INTEGER`, `VARCHAR(50)`, `DOUBLE` …). */
  type: string
}

export interface SqliteTable {
  name: string
  columns: SqliteColumn[]
  /** Row values in column order; a column added later in the file's life reads as null. */
  rows: SqliteValue[][]
}

export class SqliteError extends Error {}

/**
 * Index of the `INTEGER PRIMARY KEY` column (its stored value is the rowid), or -1. A PRIMARY KEY
 * declared at the end of the column list counts too; a composite primary key does not.
 */
function integerPrimaryKeyIndex(sql: string, columns: SqliteColumn[]): number {
  const single = sql.match(/(?:^|[(,\s])(?:"([^"]+)"|`([^`]+)`|\[([^\]]+)\]|([A-Za-z_][\w$]*))\s+INTEGER\s+PRIMARY\s+KEY/i)
  if (single) {
    const name = (single[1] ?? single[2] ?? single[3] ?? single[4] ?? '').toLowerCase()
    const idx = columns.findIndex((c) => c.name.toLowerCase() === name)
    if (idx >= 0) return idx
  }
  const trailing = sql.match(/PRIMARY\s+KEY\s*\(\s*(?:"([^"]+)"|([A-Za-z_][\w$]*))\s*\)/i)
  if (trailing) {
    const name = (trailing[1] ?? trailing[2] ?? '').toLowerCase()
    const idx = columns.findIndex((c) => c.name.toLowerCase() === name && c.type.toUpperCase() === 'INTEGER')
    if (idx >= 0 && !/,/.test(sql.slice(sql.indexOf('PRIMARY KEY'), sql.lastIndexOf(')'))) ) return idx
  }
  return -1
}

const MAGIC = 'SQLite format 3\u0000'
/** Hard ceiling on rows read from one table — a backup never needs more. */
const MAX_ROWS_PER_TABLE = 500_000
/** Hard ceiling on b-tree pages visited while reading one table (loops / corrupt files). */
const MAX_PAGES_PER_TABLE = 400_000

function bad(why: string): never {
  throw new SqliteError(`The Vyapar data file could not be read (${why})`)
}

/** SQLite varint: 1–9 bytes, big-endian 7-bit groups; the 9th byte contributes all 8 bits. */
export function readVarint(buf: Buffer, offset: number): [value: number, bytes: number] {
  let value = 0
  for (let i = 0; i < 9; i++) {
    const b = buf[offset + i]
    if (b === undefined) bad('truncated varint')
    if (i === 8) return [value * 256 + b, 9]
    value = value * 128 + (b & 0x7f)
    if ((b & 0x80) === 0) return [value, i + 1]
  }
  bad('bad varint')
}

/** Column names + declared types from a CREATE TABLE statement (table constraints are skipped). */
export function parseColumns(sql: string): SqliteColumn[] {
  const open = sql.indexOf('(')
  const close = sql.lastIndexOf(')')
  if (open < 0 || close <= open) return []
  const body = sql.slice(open + 1, close)
  const parts: string[] = []
  let depth = 0
  let current = ''
  let quote = ''
  for (const ch of body) {
    if (quote) {
      current += ch
      if (ch === quote) quote = ''
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; current += ch; continue }
    if (ch === '[') { quote = ']'; current += ch; continue }
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) { parts.push(current); current = ''; continue }
    current += ch
  }
  parts.push(current)
  const CONSTRAINT = new Set(['constraint', 'primary', 'unique', 'check', 'foreign', 'key'])
  const columns: SqliteColumn[] = []
  for (const part of parts) {
    const text = part.trim()
    if (!text) continue
    const token = text.match(/^(?:"([^"]+)"|`([^`]+)`|\[([^\]]+)\]|'([^']+)'|([A-Za-z_][\w$]*))/)
    if (!token) continue
    const name = token[1] ?? token[2] ?? token[3] ?? token[4] ?? token[5] ?? ''
    if (!name || CONSTRAINT.has(name.toLowerCase())) continue
    const rest = text.slice(token[0].length).trim()
    const type = (rest.match(/^([A-Za-z][\w ]*(?:\s*\([^)]*\))?)/)?.[1] ?? '').toUpperCase().trim()
    columns.push({ name, type })
  }
  return columns
}

export class SqliteFile {
  private readonly buf: Buffer
  private readonly pageSize: number
  private readonly usableSize: number
  private readonly encoding: 'utf8' | 'utf16le' | 'utf16be'
  private readonly maxPage: number
  private readonly entries: { type: string; name: string; rootPage: number; sql: string | null }[]
  private readonly cache = new Map<string, SqliteTable>()

  constructor(buf: Buffer) {
    if (buf.length < 512) bad('file is too small')
    if (buf.toString('latin1', 0, 16) !== MAGIC) bad('not an SQLite database')
    const raw = buf.readUInt16BE(16)
    const pageSize = raw === 1 ? 65536 : raw
    if (pageSize < 512 || pageSize > 65536 || (pageSize & (pageSize - 1)) !== 0) bad('bad page size')
    const reserved = buf[20] ?? 0
    const usableSize = pageSize - reserved
    if (usableSize < 480) bad('bad reserved space')
    const enc = buf.readUInt32BE(56)
    this.buf = buf
    this.pageSize = pageSize
    this.usableSize = usableSize
    this.encoding = enc === 2 ? 'utf16le' : enc === 3 ? 'utf16be' : 'utf8'
    this.maxPage = Math.floor(buf.length / pageSize)
    if (this.maxPage < 1) bad('truncated')
    this.entries = this.readMaster()
  }

  tableNames(): string[] {
    return this.entries.filter((e) => e.type === 'table').map((e) => e.name)
  }

  hasTable(name: string): boolean {
    return this.entries.some((e) => e.type === 'table' && e.name === name)
  }

  /** Columns of a table, without reading any rows. */
  columns(name: string): SqliteColumn[] {
    const entry = this.entries.find((e) => e.type === 'table' && e.name === name)
    if (!entry) return []
    return parseColumns(entry.sql ?? '')
  }

  table(name: string): SqliteTable {
    const hit = this.cache.get(name)
    if (hit) return hit
    const entry = this.entries.find((e) => e.type === 'table' && e.name === name)
    if (!entry) bad(`table ${name} is missing`)
    const columns = parseColumns(entry.sql ?? '')
    if (!columns.length) bad(`table ${name} has no columns`)
    if (/\bWITHOUT\s+ROWID\b/i.test(entry.sql ?? '')) bad(`table ${name} is a WITHOUT ROWID table`)
    const raw = this.readTree(entry.rootPage)
    // An `INTEGER PRIMARY KEY` column is stored as NULL in the record; its value is the rowid.
    const ipk = integerPrimaryKeyIndex(entry.sql ?? '', columns)
    const rows = raw.map(({ rowid, values }) => {
      const out: SqliteValue[] = new Array(columns.length).fill(null)
      for (let i = 0; i < columns.length && i < values.length; i++) out[i] = values[i] ?? null
      if (ipk >= 0 && out[ipk] === null) out[ipk] = rowid
      return out
    })
    const table = { name, columns, rows }
    this.cache.set(name, table)
    return table
  }

  /** Rows as objects keyed by column name (convenience for the Vyapar mapping code). */
  records(name: string): Record<string, SqliteValue>[] {
    const t = this.table(name)
    return t.rows.map((row) => {
      const o: Record<string, SqliteValue> = {}
      t.columns.forEach((c, i) => { o[c.name] = row[i] ?? null })
      return o
    })
  }

  // ---------------------------------------------------------------- internals

  private readMaster() {
    const rows = this.readTree(1)
    const entries: { type: string; name: string; rootPage: number; sql: string | null }[] = []
    for (const { rowid, values: r } of rows) {
      void rowid
      const type = typeof r[0] === 'string' ? r[0] : ''
      const name = typeof r[1] === 'string' ? r[1] : ''
      const rootPage = typeof r[3] === 'number' ? r[3] : 0
      const sql = typeof r[4] === 'string' ? r[4] : null
      if (!type || !name) continue
      entries.push({ type, name, rootPage, sql })
    }
    if (!entries.length) bad('no schema found')
    return entries
  }

  private readTree(rootPage: number): { rowid: number; values: SqliteValue[] }[] {
    const out: { rowid: number; values: SqliteValue[] }[] = []
    const visited = new Set<number>()
    let pages = 0
    const walk = (pageNo: number) => {
      if (!Number.isInteger(pageNo) || pageNo < 1 || pageNo > this.maxPage) bad('page out of range')
      if (visited.has(pageNo)) bad('page loop')
      visited.add(pageNo)
      if (++pages > MAX_PAGES_PER_TABLE) bad('too many pages')
      const pageStart = (pageNo - 1) * this.pageSize
      // Page 1 also carries the 100-byte database header; its b-tree header starts after it. Cell
      // content offsets stay relative to the start of the page (they include the 100 bytes).
      const header = pageNo === 1 ? pageStart + 100 : pageStart
      const type = this.buf[header]
      const cells = this.buf.readUInt16BE(header + 3)
      if (type === 0x0d) {
        for (let i = 0; i < cells; i++) {
          const ptr = header + 8 + 2 * i
          if (ptr + 2 > this.buf.length) bad('truncated cell pointer')
          const cell = pageStart + this.buf.readUInt16BE(ptr)
          const { payload, rowid } = this.cellPayload(cell)
          out.push({ rowid, values: this.decodeRecord(payload) })
          if (out.length > MAX_ROWS_PER_TABLE) bad('too many rows')
        }
        return
      }
      if (type === 0x05) {
        for (let i = 0; i < cells; i++) {
          const ptr = header + 12 + 2 * i
          if (ptr + 2 > this.buf.length) bad('truncated cell pointer')
          walk(this.buf.readUInt32BE(pageStart + this.buf.readUInt16BE(ptr)))
        }
        walk(this.buf.readUInt32BE(header + 8))
        return
      }
      bad(`unexpected page type ${type}`)
    }
    walk(rootPage)
    return out
  }

  /** Local payload size for a cell, per the SQLite b-tree payload rules. */
  private localSize(payloadLength: number): number {
    const usable = this.usableSize
    // fileformat2.html §1.5: U = usable page size, X = U-35 (largest payload kept on the page),
    // M = ((U-12)*32/255)-23 (smallest local payload of an overflowing cell).
    const maxLocal = usable - 35
    const minLocal = Math.floor(((usable - 12) * 32) / 255) - 23
    if (payloadLength <= maxLocal) return payloadLength
    const surplus = minLocal + ((payloadLength - minLocal) % (usable - 4))
    return surplus <= maxLocal ? surplus : minLocal
  }

  private cellPayload(cell: number): { payload: Buffer; rowid: number } {
    if (cell + 2 > this.buf.length) bad('truncated cell')
    const [payloadLength, n1] = readVarint(this.buf, cell)
    const [rowid, n2] = readVarint(this.buf, cell + n1)
    const start = cell + n1 + n2
    const local = this.localSize(payloadLength)
    if (start + local > this.buf.length) bad('truncated payload')
    if (local === payloadLength) return { payload: this.buf.subarray(start, start + payloadLength), rowid }

    const parts: Buffer[] = [this.buf.subarray(start, start + local)]
    let remaining = payloadLength - local
    let next = this.buf.readUInt32BE(start + local)
    const seen = new Set<number>()
    while (remaining > 0) {
      if (!next || next > this.maxPage || seen.has(next)) bad('broken overflow chain')
      seen.add(next)
      const off = (next - 1) * this.pageSize
      const take = Math.min(this.usableSize - 4, remaining)
      if (off + 4 + take > this.buf.length) bad('truncated overflow page')
      parts.push(this.buf.subarray(off + 4, off + 4 + take))
      remaining -= take
      next = this.buf.readUInt32BE(off)
    }
    return { payload: Buffer.concat(parts), rowid }
  }

  private decodeRecord(payload: Buffer): SqliteValue[] {
    if (!payload.length) return []
    const [headerSize, n] = readVarint(payload, 0)
    if (headerSize < n || headerSize > payload.length) bad('bad record header')
    const types: number[] = []
    let p = n
    while (p < headerSize) {
      const [t, m] = readVarint(payload, p)
      types.push(t)
      p += m
    }
    const values: SqliteValue[] = []
    let data = headerSize
    for (const t of types) {
      if (t === 0) { values.push(null); continue } // NULL
      if (t >= 1 && t <= 6) {
        const size = [0, 1, 2, 3, 4, 6, 8][t]
        if (data + size > payload.length) bad('truncated integer')
        values.push(readSigned(payload, data, size))
        data += size
        continue
      }
      if (t === 7) {
        if (data + 8 > payload.length) bad('truncated float')
        values.push(payload.readDoubleBE(data))
        data += 8
        continue
      }
      if (t === 8) { values.push(0); continue }
      if (t === 9) { values.push(1); continue }
      if (t === 10 || t === 11) { values.push(null); continue } // internal / reserved
      const size = t % 2 === 0 ? (t - 12) / 2 : (t - 13) / 2
      if (data + size > payload.length) bad('truncated value')
      const slice = payload.subarray(data, data + size)
      values.push(t % 2 === 0 ? slice : this.text(slice))
      data += size
    }
    return values
  }

  private text(bytes: Buffer): string {
    if (this.encoding === 'utf8') return bytes.toString('utf8')
    if (this.encoding === 'utf16le') return bytes.toString('utf16le')
    const swapped = Buffer.from(bytes)
    swapped.swap16()
    return swapped.toString('utf16le')
  }
}

function readSigned(buf: Buffer, offset: number, size: number): number {
  switch (size) {
    case 1: return buf.readInt8(offset)
    case 2: return buf.readInt16BE(offset)
    case 3: {
      const v = (buf[offset] << 16) | (buf[offset + 1] << 8) | buf[offset + 2]
      return v >= 0x800000 ? v - 0x1000000 : v
    }
    case 4: return buf.readInt32BE(offset)
    case 6: {
      // 48-bit big-endian signed
      const hi = buf.readUInt16BE(offset)
      const lo = buf.readUInt32BE(offset + 2)
      const unsigned = hi * 2 ** 32 + lo
      return unsigned >= 2 ** 47 ? unsigned - 2 ** 48 : unsigned
    }
    default: {
      const big = buf.readBigInt64BE(offset)
      return big >= BigInt(Number.MIN_SAFE_INTEGER) && big <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(big) : Number(big)
    }
  }
}

/** Open an SQLite buffer; throws SqliteError with a user-safe message when it is not one. */
export function openSqlite(buf: Buffer): SqliteFile {
  return new SqliteFile(buf)
}
