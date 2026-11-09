#!/usr/bin/env node
/**
 * Builds the customer package of the ManuFlow Tally Connector for Windows:
 *
 *   dist/connector/manuflow-tally-connector-<version>-windows.zip  (+ .zip.sha256)
 *     manuflow-tally-connector-<version>/
 *       manuflow-tally-connector.mjs        the connector (Node.js built-ins only — nothing to npm-install)
 *       windows/install-connector.ps1       installer / upgrader (administrator)
 *       windows/uninstall-connector.ps1     uninstaller
 *       INSTALL.md                          customer guide
 *       VERSION                             the connector version
 *       SHA256SUMS                          SHA-256 of every file above
 *
 * The .ps1 files get Windows line endings and a UTF-8 byte-order mark (Windows PowerShell 5.1 reads UTF-8 without a
 * BOM as ANSI). The zip uses stored entries with a fixed timestamp, so the same sources always give the same bytes
 * (and checksum). Nothing customer-specific is ever packaged: the build stops if a file looks like a token, a
 * pairing code or a settings file.
 *
 *   node scripts/build-connector-package.mjs [--out <folder>]
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCES = [
  ['manuflow-tally-connector.mjs', 'connector/tally/manuflow-tally-connector.mjs'],
  ['windows/install-connector.ps1', 'connector/tally/windows/install-connector.ps1'],
  ['windows/uninstall-connector.ps1', 'connector/tally/windows/uninstall-connector.ps1'],
  ['INSTALL.md', 'connector/tally/INSTALL.md'],
]
// A packaged file must never carry a customer secret
const FORBIDDEN = [
  [/mftc_[a-f0-9]{24}_[A-Za-z0-9_-]{43}/, 'a connector token'],
  [/"token"\s*:\s*"mftc_/, 'saved connector settings'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
  [/\b(?=[A-HJ-NP-Z2-9]{5}-)(?![A-Z]{5}-[A-Z]{5}\b)[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}\b/, 'a pairing code'],
]
const sha256 = (b) => createHash('sha256').update(b).digest('hex')

export function connectorVersion(root = ROOT) {
  const m = /export const VERSION = '([0-9]+\.[0-9]+\.[0-9]+)'/.exec(readFileSync(join(root, 'connector/tally/manuflow-tally-connector.mjs'), 'utf8'))
  if (!m) throw new Error('VERSION not found in the connector')
  return m[1]
}

function windowsText(text) {
  return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text.replace(/^﻿/, '').replace(/\r?\n/g, '\r\n'), 'utf8')])
}

// ---------------------------------------------------------------- minimal ZIP writer (stored entries)

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function crc32(buf) {
  let c = 0xffffffff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const DOS_TIME = 0 // 00:00:00
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1 // 2026-01-01: fixed, so builds are reproducible

export function zipStored(entries) {
  const parts = []
  const central = []
  let offset = 0
  for (const { name, data } of entries) {
    const n = Buffer.from(name, 'utf8')
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6) // UTF-8 names
    local.writeUInt16LE(0, 8); local.writeUInt16LE(DOS_TIME, 10); local.writeUInt16LE(DOS_DATE, 12)
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(n.length, 26); local.writeUInt16LE(0, 28)
    parts.push(local, n, data)
    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0x0800, 8)
    cd.writeUInt16LE(0, 10); cd.writeUInt16LE(DOS_TIME, 12); cd.writeUInt16LE(DOS_DATE, 14)
    cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(data.length, 24)
    cd.writeUInt16LE(n.length, 28); cd.writeUInt32LE(offset, 42)
    central.push(cd, n)
    offset += 30 + n.length + data.length
  }
  const cdBuf = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(cdBuf.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...parts, cdBuf, end])
}

// ---------------------------------------------------------------- build

export function buildPackage({ root = ROOT, out = join(ROOT, 'dist/connector') } = {}) {
  const version = connectorVersion(root)
  const dir = `manuflow-tally-connector-${version}`
  const files = SOURCES.map(([path, src]) => {
    const text = readFileSync(join(root, src), 'utf8')
    for (const [re, what] of FORBIDDEN) if (re.test(text)) throw new Error(`${src} looks like it contains ${what} — not packaged`)
    return { path, data: path.endsWith('.ps1') ? windowsText(text) : Buffer.from(text, 'utf8') }
  })
  files.push({ path: 'VERSION', data: Buffer.from(`${version}\n`) })
  const sums = files.map((f) => `${sha256(f.data)}  ${f.path}`).join('\n') + '\n'
  files.push({ path: 'SHA256SUMS', data: Buffer.from(sums) })
  const zip = zipStored(files.map((f) => ({ name: `${dir}/${f.path}`, data: f.data })))
  mkdirSync(out, { recursive: true })
  const zipName = `${dir}-windows.zip`
  const zipPath = join(out, zipName)
  writeFileSync(zipPath, zip)
  const zipSha = sha256(zip)
  writeFileSync(`${zipPath}.sha256`, `${zipSha}  ${zipName}\n`)
  return { version, zipPath, zipSha, files: files.map((f) => ({ path: `${dir}/${f.path}`, bytes: f.data.length, sha256: sha256(f.data) })) }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const i = process.argv.indexOf('--out')
  const r = buildPackage(i > 0 ? { out: resolve(process.argv[i + 1]) } : {})
  console.log(`ManuFlow Tally Connector ${r.version}`)
  for (const f of r.files) console.log(`  ${f.sha256}  ${f.path} (${f.bytes} bytes)`)
  console.log(`package: ${r.zipPath}\nsha256:  ${r.zipSha}`)
}
