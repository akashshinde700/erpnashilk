import { ApiError } from '@/lib/erp-helpers'
import { IMPORT_LIMITS } from '@/lib/import/fields'
import type { TableRow } from '@/lib/import/parse-file'
import { parseXml, type XmlNode } from '@/lib/import/xml'

/**
 * Generic XML and JSON files → the same table of text cells a spreadsheet gives (header on the first row), so the
 * rest of the Import Center (column mapping, preview, duplicate checks, import) works unchanged.
 *
 * Records are found, not assumed: the repeated elements / objects that carry fields (e.g. <customer> under
 * <customers>, or the objects of a "customers" array). A file can hold several kinds of record; each is offered like a
 * sheet of a workbook. Attributes and simple nested fields become columns ("address.city"); a repeated nested group
 * inside a record (e.g. several <line> elements) is NOT squeezed into columns — it is left out and reported in a note,
 * because flattening it would lose which value belongs to which line. Tally XML has its own reader (tally-xml.ts).
 */

export interface RecordTable {
  /** Shown like a sheet name, e.g. "customer (120)". */
  name: string
  rows: TableRow[]
  notes: string[]
}

const fail = (message: string): never => { throw new ApiError(message, 400) }
const NESTED_PREFIX_DEPTH = 3

/** Records (ordered field → value maps) → a table: header = every field in order of first appearance. */
export function tableFromRecords(name: string, records: Map<string, string>[], notes: string[] = []): RecordTable {
  const headers: string[] = []
  const index = new Map<string, number>()
  for (const r of records) for (const k of r.keys()) if (!index.has(k)) { index.set(k, headers.length); headers.push(k) }
  if (headers.length > IMPORT_LIMITS.maxColumns) fail(`The records in this file have ${headers.length} different fields — the limit is ${IMPORT_LIMITS.maxColumns}`)
  const rows: TableRow[] = [{ line: 1, cells: headers }]
  records.forEach((r, i) => {
    const cells = headers.map((h) => r.get(h) ?? '')
    for (const c of cells) if (c.length > IMPORT_LIMITS.maxCellChars) fail(`Record ${i + 1} has a value longer than ${IMPORT_LIMITS.maxCellChars} characters`)
    rows.push({ line: i + 2, cells })
  })
  return { name: `${name} (${records.length})`, rows, notes }
}

// ---------------------------------------------------------------- XML

const hasStructure = (n: XmlNode) => n.children.length > 0 || Object.keys(n.attrs).length > 0

/** Element paths whose elements are records: repeated, carrying fields, and not inside another such record. */
function xmlRecordPaths(root: XmlNode): { path: string; nodes: XmlNode[] }[] {
  const byPath = new Map<string, XmlNode[]>()
  const walk: [XmlNode, string][] = [[root, root.name]]
  while (walk.length) {
    const [n, p] = walk.pop()!
    if (hasStructure(n) && n !== root) {
      const list = byPath.get(p)
      if (list) list.push(n)
      else byPath.set(p, [n])
    }
    for (let i = n.children.length - 1; i >= 0; i--) walk.push([n.children[i], `${p}/${n.children[i].name}`])
  }
  let candidates = [...byPath.entries()].filter(([, nodes]) => nodes.length >= 2)
  // A file with a single record: the root's one structured child (or the root itself when it holds only fields)
  if (!candidates.length) {
    const single = root.children.filter(hasStructure)
    if (single.length === 1) candidates = [[`${root.name}/${single[0].name}`, single]]
    else candidates = [[root.name, [root]]]
  }
  candidates.sort((a, b) => a[0].split('/').length - b[0].split('/').length)
  const kept: [string, XmlNode[]][] = []
  for (const c of candidates) if (!kept.some(([k]) => c[0].startsWith(`${k}/`))) kept.push(c)
  return kept.map(([path, nodes]) => ({ path, nodes }))
}

function flattenXml(n: XmlNode, prefix: string, depth: number, out: Map<string, string>, skipped: Set<string>) {
  for (const [k, v] of Object.entries(n.attrs)) if (!k.startsWith('xmlns')) out.set(prefix ? `${prefix}.${k}` : k, v.trim())
  const counts = new Map<string, number>()
  for (const c of n.children) counts.set(c.name, (counts.get(c.name) ?? 0) + 1)
  for (const c of n.children) {
    const key = prefix ? `${prefix}.${c.name}` : c.name
    if (!hasStructure(c)) {
      // a repeated simple field (several <phone>) is one column with the values joined
      const prev = out.get(key)
      const t = c.text.trim()
      out.set(key, prev && counts.get(c.name)! > 1 ? (t ? `${prev}; ${t}` : prev) : t || (prev ?? ''))
    } else if (counts.get(c.name)! > 1 || depth >= NESTED_PREFIX_DEPTH) {
      skipped.add(key)
    } else {
      flattenXml(c, key, depth + 1, out, skipped)
    }
  }
}

export function xmlTables(text: string): RecordTable[] {
  const root = parseXml(text)
  const found = xmlRecordPaths(root)
  const counts = new Map<string, number>()
  for (const f of found) { const last = f.path.split('/').pop()!; counts.set(last, (counts.get(last) ?? 0) + 1) }
  return found.map(({ path, nodes }) => {
    const skipped = new Set<string>()
    const records = nodes.map((n) => {
      const m = new Map<string, string>()
      flattenXml(n, '', 0, m, skipped)
      return m
    })
    const last = path.split('/').pop()!
    const notes = skipped.size ? [`Nested lists inside each record are not imported (${[...skipped].slice(0, 5).join(', ')}): they cannot be turned into columns without losing which value belongs where.`] : []
    return tableFromRecords(counts.get(last)! > 1 ? path : last, records, notes)
  })
}

// ---------------------------------------------------------------- JSON

/** Nesting depth of a JSON text, counted outside strings, without parsing it (so a hostile file cannot recurse). */
export function jsonDepth(text: string): number {
  let depth = 0
  let max = 0
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i)
    if (inString) {
      if (ch === 92) i++ // backslash: skip the escaped character
      else if (ch === 34) inString = false
    } else if (ch === 34) inString = true
    else if (ch === 123 || ch === 91) { if (++depth > max) max = depth }
    else if (ch === 125 || ch === 93) depth--
  }
  return max
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const scalar = (v: unknown) => (v === null || v === undefined ? '' : typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : null)

function flattenJson(o: Record<string, unknown>, prefix: string, depth: number, out: Map<string, string>, skipped: Set<string>) {
  for (const [k, v] of Object.entries(o)) {
    const key = prefix ? `${prefix}.${k}` : k
    const s = scalar(v)
    if (s !== null) out.set(key, s.trim())
    else if (Array.isArray(v) && v.every((x) => scalar(x) !== null)) out.set(key, v.map((x) => scalar(x)!.trim()).filter(Boolean).join('; '))
    else if (isObj(v) && depth < NESTED_PREFIX_DEPTH) flattenJson(v, key, depth + 1, out, skipped)
    else skipped.add(key)
  }
}

export function jsonTables(text: string): RecordTable[] {
  if (jsonDepth(text) > IMPORT_LIMITS.maxJsonDepth) fail(`The JSON file is nested more than ${IMPORT_LIMITS.maxJsonDepth} levels deep`)
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch (e) {
    return fail(`The JSON file is not valid JSON (${e instanceof Error ? e.message.slice(0, 120) : 'parse error'})`)
  }
  // Lists of records: the top-level array, or arrays of objects under (nested) keys, e.g. { "data": { "customers": [...] } }
  const lists: { name: string; items: Record<string, unknown>[] }[] = []
  const visit = (v: unknown, name: string, depth: number) => {
    if (Array.isArray(v)) {
      if (v.length && v.every(isObj)) lists.push({ name, items: v })
      else if (v.length && v.some(isObj)) fail(`The list "${name}" mixes records with other values`)
    } else if (isObj(v) && depth < 3) {
      for (const [k, x] of Object.entries(v)) visit(x, name ? `${name}.${k}` : k, depth + 1)
    }
  }
  visit(data, '', 0)
  if (!lists.length && isObj(data)) lists.push({ name: 'record', items: [data] })
  if (!lists.length) fail('The JSON file holds no records (expected a list of objects, e.g. [{"name": "…"}])')
  return lists.map(({ name, items }) => {
    const skipped = new Set<string>()
    const records = items.map((o) => {
      const m = new Map<string, string>()
      flattenJson(o, '', 0, m, skipped)
      return m
    })
    const notes = skipped.size ? [`Nested lists inside each record are not imported (${[...skipped].slice(0, 5).join(', ')}).`] : []
    return tableFromRecords(name || 'records', records, notes)
  })
}
