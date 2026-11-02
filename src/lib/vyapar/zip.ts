import { inflateRawSync } from 'node:zlib'

/**
 * Read-only ZIP reader for a Vyapar backup (.vyb). A `.vyb` is an ordinary ZIP holding one or more
 * `.vyp` files (one per Vyapar company) and nothing else that matters.
 *
 * Like the .xlsx reader in src/lib/import/parse-file.ts, every entry is inflated here with a hard
 * output budget, so a zip bomb — including one that lies about its sizes in the directory — is
 * refused instead of filling the server's memory. Nothing is written to disk.
 */

export interface ZipEntry {
  name: string
  data: Buffer
}

export class ZipError extends Error {}

export const ZIP_LIMITS = {
  /** Entries in the archive. */
  maxEntries: 64,
  /** Total inflated bytes across all entries. */
  maxTotalBytes: 512 * 1024 * 1024,
  /** Inflated bytes of a single entry. */
  maxEntryBytes: 512 * 1024 * 1024,
} as const

const fail = (why: string): never => {
  throw new ZipError(`The backup file could not be read (${why})`)
}

export function isZip(buf: Buffer): boolean {
  return buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04
}

/** Names in the archive without inflating anything (cheap first look). */
export function zipEntryNames(buf: Buffer): string[] {
  return readDirectory(buf).map((e) => e.name)
}

interface DirectoryEntry {
  name: string
  method: number
  compressedSize: number
  dataStart: number
  flags: number
}

function readDirectory(buf: Buffer): DirectoryEntry[] {
  const minEocd = Math.max(0, buf.length - 22 - 0xffff)
  let eocd = -1
  for (let i = buf.length - 22; i >= minEocd; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) fail('no ZIP directory')
  if (eocd + 22 > buf.length) fail('truncated')
  const entries = buf.readUInt16LE(eocd + 10)
  const cdSize = buf.readUInt32LE(eocd + 12)
  const cdOffset = buf.readUInt32LE(eocd + 16)
  if (entries === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) fail('ZIP64 is not supported')
  if (entries === 0) fail('the archive is empty')
  if (entries > ZIP_LIMITS.maxEntries) fail('too many parts')
  if (cdOffset + cdSize > buf.length) fail('truncated directory')

  const out: DirectoryEntry[] = []
  let p = cdOffset
  for (let n = 0; n < entries; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) fail('corrupt directory')
    const flags = buf.readUInt16LE(p + 8)
    const method = buf.readUInt16LE(p + 10)
    const compressedSize = buf.readUInt32LE(p + 20)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOffset = buf.readUInt32LE(p + 42)
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen)
    p += 46 + nameLen + extraLen + commentLen
    if (flags & 0x1) fail('password-protected')
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== 0x04034b50) fail('corrupt entry')
    const dataStart = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28)
    if (dataStart + compressedSize > buf.length) fail('truncated entry')
    out.push({ name, method, compressedSize, dataStart, flags })
  }
  return out
}

/** Entries whose name passes `want`, inflated under the size budget. */
export function readZipEntries(buf: Buffer, want: (name: string) => boolean): ZipEntry[] {
  const directory = readDirectory(buf)
  let budget: number = ZIP_LIMITS.maxTotalBytes
  const out: ZipEntry[] = []
  for (const entry of directory) {
    if (entry.name.endsWith('/')) continue // directory
    if (!want(entry.name)) continue
    const compressed = buf.subarray(entry.dataStart, entry.dataStart + entry.compressedSize)
    let data: Buffer
    if (entry.method === 0) {
      if (compressed.length > ZIP_LIMITS.maxEntryBytes) fail('a part is too large')
      data = compressed
    } else if (entry.method === 8) {
      const cap = Math.min(budget, ZIP_LIMITS.maxEntryBytes)
      try {
        data = inflateRawSync(compressed, { maxOutputLength: cap })
      } catch {
        return fail('a part is corrupt or too large when unpacked')
      }
    } else {
      return fail('unsupported compression')
    }
    budget -= data.length
    if (budget < 0) fail('the archive is too large when unpacked')
    out.push({ name: entry.name, data })
  }
  return out
}
