import { ApiError } from '@/lib/erp-helpers'

/**
 * A small, safe XML reader for uploaded files (generic XML and Tally XML).
 *
 * Safety: a DOCTYPE or ENTITY declaration is refused outright, so external entities (XXE) and entity expansion
 * ("billion laughs") cannot happen; only the five predefined entities and numeric character references are decoded.
 * Nothing is ever fetched or executed. Depth and element count are capped, and the reader is a loop (no recursion),
 * so deeply nested input cannot exhaust the stack.
 */

export interface XmlNode {
  name: string
  attrs: Record<string, string>
  children: XmlNode[]
  /** Text directly inside this element (CDATA included), entities decoded, not trimmed. */
  text: string
}

export interface XmlLimits { maxDepth: number; maxElements: number; maxAttributes: number }
export const XML_LIMITS: XmlLimits = { maxDepth: 64, maxElements: 2_000_000, maxAttributes: 64 }

const fail = (message: string): never => { throw new ApiError(message, 400) }
const NAME = /^[A-Za-z_:][\w.:-]*$/

const PREDEFINED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

export function decodeEntities(s: string): string {
  if (!s.includes('&')) return s
  return s.replace(/&(#x[0-9a-fA-F]{1,6}|#\d{1,7}|[A-Za-z]+);/g, (m, e: string) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1))
      if (!Number.isFinite(cp) || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) fail('The XML file contains an invalid character reference')
      return String.fromCodePoint(cp)
    }
    if (e in PREDEFINED) return PREDEFINED[e]
    return fail(`The XML file uses the entity &${e}; — entities other than the standard five are not allowed`)
  })
}

function readAttrs(src: string, where: number, limits: XmlLimits): Record<string, string> {
  const attrs: Record<string, string> = {}
  const re = /([A-Za-z_:][\w.:-]*)\s*=\s*("([^"]*)"|'([^']*)')/g
  let rest = src
  let n = 0
  for (const m of src.matchAll(re)) {
    if (++n > limits.maxAttributes) fail(`An XML element has more than ${limits.maxAttributes} attributes`)
    attrs[m[1]] = decodeEntities(m[3] ?? m[4] ?? '')
    rest = rest.replace(m[0], '')
  }
  if (rest.trim()) fail(`The XML file is not well formed (attributes near character ${where})`)
  return attrs
}

/** Parses an XML document into a tree. Throws a 400 ApiError with a plain message on anything unsafe or malformed. */
export function parseXml(text: string, limits: XmlLimits = XML_LIMITS): XmlNode {
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) fail('XML files with a DOCTYPE or entity declarations are not accepted (they can be used to attack the server)')
  const root: XmlNode = { name: '#document', attrs: {}, children: [], text: '' }
  const stack: XmlNode[] = [root]
  let elements = 0
  let i = 0
  const len = text.length
  while (i < len) {
    const lt = text.indexOf('<', i)
    const chunk = lt < 0 ? text.slice(i) : text.slice(i, lt)
    // Whitespace-only text between elements (indentation) is not kept: every reader trims it anyway, and in a large,
    // indented export it would be a large share of the memory
    if (chunk && /\S/.test(chunk)) {
      if (stack.length === 1) fail('The XML file has text outside its root element')
      stack[stack.length - 1].text += decodeEntities(chunk)
    }
    if (lt < 0) break
    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4)
      if (end < 0) fail('The XML file has an unclosed comment')
      i = end + 3
      continue
    }
    if (text.startsWith('<![CDATA[', lt)) {
      const end = text.indexOf(']]>', lt + 9)
      if (end < 0) fail('The XML file has an unclosed CDATA section')
      if (stack.length === 1) fail('The XML file has text outside its root element')
      stack[stack.length - 1].text += text.slice(lt + 9, end)
      i = end + 3
      continue
    }
    if (text.startsWith('<?', lt)) {
      const end = text.indexOf('?>', lt + 2)
      if (end < 0) fail('The XML file has an unclosed processing instruction')
      i = end + 2
      continue
    }
    if (text.startsWith('<!', lt)) fail('The XML file contains a declaration that is not allowed')
    // the end of the tag, skipping quoted attribute values (a '>' inside quotes is allowed)
    let gt = -1
    let quote = ''
    for (let j = lt + 1; j < len; j++) {
      const ch = text[j]
      if (quote) { if (ch === quote) quote = '' } else if (ch === '"' || ch === "'") quote = ch
      else if (ch === '>') { gt = j; break }
    }
    if (gt < 0) fail('The XML file ends in the middle of a tag')
    const raw = text.slice(lt + 1, gt)
    i = gt + 1
    if (raw.startsWith('/')) {
      const name = raw.slice(1).trim()
      const top = stack.pop()
      if (!top || top === root || top.name !== name) fail(`The XML file is not well formed (</${name.slice(0, 40)}> does not close the open element)`)
      continue
    }
    const selfClosing = raw.endsWith('/')
    const body = selfClosing ? raw.slice(0, -1) : raw
    const sp = body.search(/\s/)
    const name = sp < 0 ? body : body.slice(0, sp)
    if (!NAME.test(name)) fail(`The XML file is not well formed (bad element name near character ${lt})`)
    if (stack.length === 1 && root.children.length) fail('The XML file has more than one root element')
    if (++elements > limits.maxElements) fail(`The XML file has more than ${limits.maxElements.toLocaleString('en-IN')} elements — export a smaller part`)
    const node: XmlNode = { name, attrs: sp < 0 ? {} : readAttrs(body.slice(sp), lt, limits), children: [], text: '' }
    stack[stack.length - 1].children.push(node)
    if (!selfClosing) {
      stack.push(node)
      if (stack.length - 1 > limits.maxDepth) fail(`The XML file is nested more than ${limits.maxDepth} levels deep`)
    }
  }
  if (stack.length !== 1) fail(`The XML file is not complete (<${stack[stack.length - 1].name}> is never closed)`)
  if (root.children.length !== 1) fail('The XML file has no root element')
  return root.children[0]
}

// ---------------------------------------------------------------- small helpers shared by the XML readers

/** Children of n with this element name. */
export const kids = (n: XmlNode | undefined, name: string) => (n ? n.children.filter((c) => c.name === name) : [])
/** First node along a path of element names (e.g. 'BODY', 'DATA'). */
export function at(n: XmlNode | undefined, ...path: string[]): XmlNode | undefined {
  let cur = n
  for (const p of path) cur = cur?.children.find((c) => c.name === p)
  return cur
}
/** Every node along a path, following every repeated element (e.g. 'ADDRESS.LIST', 'ADDRESS'). */
export function all(n: XmlNode | undefined, ...path: string[]): XmlNode[] {
  let cur = n ? [n] : []
  for (const p of path) cur = cur.flatMap((c) => c.children.filter((x) => x.name === p))
  return cur
}
/** Trimmed text of the first node along a path ('' if none). */
export const textAt = (n: XmlNode | undefined, ...path: string[]) => (at(n, ...path)?.text ?? '').trim()
