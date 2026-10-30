#!/usr/bin/env node
/**
 * ManuFlow Tally Connector — proof of concept. Needs Node.js 18 or newer; no other packages.
 *
 * Runs on a computer in the customer's office network (normally the TallyPrime PC itself) and connects OUT to
 * ManuFlow over HTTPS. Nothing has to be opened to the internet: Tally's XML port (default 9000, no
 * authentication) stays inside the office.
 *
 *   node manuflow-tally-connector.mjs check  [--tally http://127.0.0.1:9000]
 *   node manuflow-tally-connector.mjs pair   --server https://your-manuflow --code ABCDE-FGHJK [--tally http://127.0.0.1:9000]
 *   node manuflow-tally-connector.mjs run
 *   node manuflow-tally-connector.mjs status
 *   node manuflow-tally-connector.mjs forget
 *
 * What it sends to Tally: TALLY_HEALTH_REQUEST below (an Export of a report that does not exist, so Tally answers with
 * a short status reply) and, when ManuFlow asks for one of four NAMED read jobs, the matching fixed Export request
 * built here (company list; Sundry Debtors / Sundry Creditors ledgers; stock items).
 *
 * The ONE write path is the `push-voucher` job: ManuFlow builds one Tally Import envelope from a sales invoice and
 * sends it with the job, and this program posts that document to Tally unchanged after checking it (a single
 * `<VOUCHER ACTION="Create">`, no DTD / entities, ≤ 256 KB). The connector never builds an Import request itself,
 * never alters the document and never invents an address — a job without a well-formed envelope is refused.
 * Push stays off unless the ManuFlow server was started with TALLY_CONNECTOR_PUSH=1.
 *
 * The Tally address is set here, on this computer, and must be this computer or a private network address; ManuFlow
 * cannot send it an address.
 * NOTE: the export requests and the field names read from Tally's replies have only been tested against a mock
 * server, not a real TallyPrime.
 *
 * What it sends to ManuFlow: the pairing code (once), a heartbeat every 5–30 s with the result of that check, and the
 * records of a job it was asked for (names, GSTIN, address… — no balances or vouchers).
 * The connector token is saved in the user's settings folder (file readable by this user only) and is never printed.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { homedir, platform as osPlatform } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const VERSION = '0.1.0-poc'
export const TALLY_DEFAULT_URL = 'http://127.0.0.1:9000'
const TALLY_TIMEOUT_MS = 4000
const TALLY_MAX_BYTES = 256 * 1024
const SERVER_TIMEOUT_MS = 15000
const EXPORT_TIMEOUT_MS = 120000
const EXPORT_MAX_BYTES = 64 * 1024 * 1024
const MAX_RECORDS = 20000
const MAX_RESULT_BYTES = 8 * 1024 * 1024

// Must stay identical to TALLY_HEALTH_REQUEST in src/lib/tally/client.ts (a test checks this)
export const TALLY_HEALTH_REQUEST =
  '<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE>' +
  '<ID>ManuFlow Connectivity Check</ID></HEADER><BODY><DESC><STATICVARIABLES>' +
  '<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES></DESC></BODY></ENVELOPE>'

// ---------------------------------------------------------------- addresses

function isPrivateIPv4(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!m) return false
  const [a, b, c, d] = m.slice(1).map(Number)
  if ([a, b, c, d].some((n) => n > 255)) return false
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)
}

/** The Tally address: http, this computer or a private LAN IPv4 address, explicit port, nothing else. */
export function validateTallyUrl(raw) {
  let u
  try { u = new URL(String(raw ?? '').trim()) } catch { return { error: 'Tally address is not valid (example: http://127.0.0.1:9000)' } }
  if (u.protocol !== 'http:') return { error: 'Tally address must start with http://' }
  if (u.username || u.password) return { error: 'Tally address must not contain a user name or password' }
  if ((u.pathname && u.pathname !== '/') || u.search || u.hash) return { error: 'Tally address must be just the address and port, e.g. http://127.0.0.1:9000' }
  const host = u.hostname
  if (!(host === 'localhost' || host === '[::1]' || isPrivateIPv4(host))) {
    return { error: 'Tally address must be this computer (127.0.0.1) or a private network address (10.x, 172.16–31.x, 192.168.x) — never an internet address or a host name' }
  }
  const port = u.port || '80'
  return { url: `http://${host}:${port}/`, endpoint: `${host}:${port}` }
}

/** The ManuFlow address: https (plain http only to this computer, for local testing). */
export function validateServerUrl(raw) {
  let u
  try { u = new URL(String(raw ?? '').trim()) } catch { return { error: 'ManuFlow address is not valid (example: https://erp.example.com)' } }
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1'
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return { error: 'ManuFlow address must start with https://' }
  if (u.username || u.password || u.search || u.hash) return { error: 'ManuFlow address must not contain a user name, password or query' }
  return { url: u.origin }
}

// ---------------------------------------------------------------- Tally check (read-only)

export function looksLikeTallyXml(body) {
  const s = body.replace(/^﻿/, '').trim().replace(/^<\?xml[^>]*\?>\s*/i, '')
  if (/<!DOCTYPE|<!ENTITY/i.test(s)) return false
  const m = /^<(ENVELOPE|RESPONSE)[\s>]/i.exec(s)
  if (!m) return false
  return new RegExp(`</${m[1]}>\\s*$`, 'i').test(s)
}

async function readCapped(res, max) {
  if (!res.body) return ''
  const reader = res.body.getReader()
  const chunks = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      await reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  return new TextDecoder('utf-8').decode(Buffer.concat(chunks))
}

/** { status, endpoint?, latencyMs? } — status is one of connected / unreachable / timeout / invalid_response / invalid_config */
export async function checkTally(tallyUrl, opts = {}) {
  const t = validateTallyUrl(tallyUrl)
  if (t.error) return { status: 'invalid_config', message: t.error }
  const timeoutMs = opts.timeoutMs ?? TALLY_TIMEOUT_MS
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  const started = Date.now()
  try {
    const res = await fetch(t.url, {
      method: 'POST',
      headers: { 'content-type': 'text/xml; charset=utf-8' },
      body: TALLY_HEALTH_REQUEST,
      signal: ctrl.signal,
      redirect: 'manual',
    })
    const body = await readCapped(res, TALLY_MAX_BYTES)
    const latencyMs = Date.now() - started
    const ok = res.status === 200 && body !== null && looksLikeTallyXml(body)
    return { status: ok ? 'connected' : 'invalid_response', endpoint: t.endpoint, latencyMs }
  } catch {
    return { status: ctrl.signal.aborted ? 'timeout' : 'unreachable', endpoint: t.endpoint }
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------- named jobs (read-only exports)

const escXml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')

/** A Tally collection Export with an inline (read-only) collection definition. */
function collectionRequest(id, type, fetch, { company, childOf } = {}) {
  return '<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE>' +
    `<ID>${id}</ID></HEADER><BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>` +
    (company ? `<SVCURRENTCOMPANY>${escXml(company)}</SVCURRENTCOMPANY>` : '') +
    `</STATICVARIABLES><TDL><TDLMESSAGE><COLLECTION NAME="${id}" ISMODIFY="No"><TYPE>${type}</TYPE>` +
    (childOf ? `<CHILDOF>${childOf}</CHILDOF><BELONGSTO>Yes</BELONGSTO>` : '') +
    `<FETCH>${fetch}</FETCH></COLLECTION></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`
}

const PARTY_FETCH = 'NAME, GUID, PARENT, PARTYGSTIN, GSTREGISTRATIONTYPE, INCOMETAXNUMBER, LEDSTATENAME, PINCODE, ADDRESS, LEDGERPHONE, LEDGERMOBILE, EMAIL, LEDGERCONTACT, LEDGSTREGDETAILS, LEDMAILINGDETAILS'

/** The only jobs the connector runs. Anything else ManuFlow might send is refused. */
export const JOBS = {
  'list-companies': {
    request: () => collectionRequest('ManuFlowCompanies', 'Company', 'NAME, STARTINGFROM, BOOKSFROM'),
    tag: 'COMPANY',
    read: (n) => ({ name: objName(n), startingFrom: tallyDate(text(n, 'STARTINGFROM')), booksFrom: tallyDate(text(n, 'BOOKSFROM')) }),
  },
  'export-customers': {
    request: (company) => collectionRequest('ManuFlowDebtors', 'Ledger', PARTY_FETCH, { company, childOf: '$$GroupSundryDebtors' }),
    tag: 'LEDGER',
    read: readParty,
  },
  'export-suppliers': {
    request: (company) => collectionRequest('ManuFlowCreditors', 'Ledger', PARTY_FETCH, { company, childOf: '$$GroupSundryCreditors' }),
    tag: 'LEDGER',
    read: readParty,
  },
  'export-items': {
    request: (company) => collectionRequest('ManuFlowStockItems', 'StockItem', 'NAME, GUID, PARENT, BASEUNITS, HSNCODE, GSTDETAILS, HSNDETAILS', { company }),
    tag: 'STOCKITEM',
    read: (n) => ({
      guid: text(n, 'GUID'), name: objName(n), parent: text(n, 'PARENT'), unit: text(n, 'BASEUNITS'),
      hsn: text(n, 'HSNCODE') || text(n, 'GSTDETAILS.LIST', 'HSNCODE') || text(n, 'HSNDETAILS.LIST', 'HSNCODE'),
      gstRate: igstRate(n),
    }),
  },
}

function readParty(n) {
  const addr = all(n, 'ADDRESS.LIST', 'ADDRESS').length ? all(n, 'ADDRESS.LIST', 'ADDRESS') : all(n, 'LEDMAILINGDETAILS.LIST', 'ADDRESS.LIST', 'ADDRESS')
  return {
    guid: text(n, 'GUID'), name: objName(n), parent: text(n, 'PARENT'),
    gstin: text(n, 'PARTYGSTIN') || text(n, 'LEDGSTREGDETAILS.LIST', 'GSTIN'),
    gstType: text(n, 'GSTREGISTRATIONTYPE') || text(n, 'LEDGSTREGDETAILS.LIST', 'GSTREGISTRATIONTYPE'),
    pan: text(n, 'INCOMETAXNUMBER'),
    phone: text(n, 'LEDGERMOBILE') || text(n, 'LEDGERPHONE'),
    email: text(n, 'EMAIL'),
    contactPerson: text(n, 'LEDGERCONTACT'),
    address: addr.join(', '),
    state: text(n, 'LEDSTATENAME') || text(n, 'LEDMAILINGDETAILS.LIST', 'STATE'),
    pincode: text(n, 'PINCODE') || text(n, 'LEDMAILINGDETAILS.LIST', 'PINCODE'),
  }
}

// IGST rate of the item's GST details (TallyPrime keeps it under ...RATEDETAILS.LIST with GSTRATEDUTYHEAD = IGST)
function igstRate(n) {
  for (const r of descendants(n, 'RATEDETAILS.LIST')) {
    const head = text(r, 'GSTRATEDUTYHEAD').toUpperCase()
    if (head === 'IGST' || head === 'INTEGRATED TAX') return text(r, 'GSTRATE')
  }
  return ''
}

const tallyDate = (s) => (/^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6)}` : '')

// ---------------- minimal XML reader: no DTD / entity declarations, no external anything

/** @typedef {{ name: string, attrs: Record<string, string>, children: XmlNode[], text: string }} XmlNode */

/**
 * Parse XML into { name, attrs, children, text }. Throws on DOCTYPE / ENTITY or broken nesting.
 * @param {string} src
 * @returns {XmlNode}
 */
export function parseXml(src) {
  if (/<!DOCTYPE|<!ENTITY/i.test(src)) throw new Error('DTD not allowed')
  /** @type {XmlNode} */
  const root = { name: '#root', attrs: {}, children: [], text: '' }
  const stack = [root]
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<\/\s*([^\s>]+)\s*>|<([^\s/>]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g
  let m
  let pos = 0
  while ((m = re.exec(src))) {
    if (m.index !== pos) throw new Error('Malformed XML')
    pos = re.lastIndex
    const top = stack[stack.length - 1]
    if (m[1] !== undefined) top.text += m[1]
    else if (m[2]) {
      const closed = stack.pop()
      if (!closed || closed.name !== m[2].toUpperCase() || stack.length === 0) throw new Error('Malformed XML')
    } else if (m[3]) {
      const node = { name: m[3].toUpperCase(), attrs: {}, children: [], text: '' }
      for (const a of m[4].matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) node.attrs[a[1].toUpperCase()] = decodeEntities(a[2] ?? a[3] ?? '')
      top.children.push(node)
      if (!m[5]) stack.push(node)
    } else if (m[6] !== undefined) top.text += decodeEntities(m[6])
  }
  if (pos !== src.length || stack.length !== 1) throw new Error('Malformed XML')
  return root
}

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e) => {
    const k = e.toLowerCase()
    if (k[0] === '#') {
      const code = k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10)
      // Tally writes control characters such as &#4; — dropped
      return code >= 32 && code <= 0x10ffff ? String.fromCodePoint(code) : ''
    }
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[k]
  })
}

function descendants(n, tag, out = []) {
  for (const c of n.children) {
    if (c.name === tag) out.push(c)
    else descendants(c, tag, out)
  }
  return out
}
/** All texts at a child path, e.g. all(n, 'ADDRESS.LIST', 'ADDRESS'). */
function all(n, ...path) {
  let level = [n]
  for (const p of path) level = level.flatMap((x) => x.children.filter((c) => c.name === p))
  return level.map((x) => x.text.trim()).filter(Boolean)
}
const text = (n, ...path) => all(n, ...path)[0] ?? ''
const objName = (n) => (n.attrs.NAME || text(n, 'NAME') || text(n, 'LANGUAGENAME.LIST', 'NAME.LIST', 'NAME')).trim()

function decodeBody(buf) {
  // TallyPrime may answer in UTF-16 (with a byte-order mark) or UTF-8
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2))
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2))
  return new TextDecoder('utf-8').decode(buf)
}

// ---------------------------------------------------------------- push (the only write)

export const PUSH_MAX_BYTES = 256 * 1024
const PUSH_TIMEOUT_MS = 60 * 1000

/** Why a pushed envelope is not acceptable, or null. Repeated here so the connector never trusts the server blindly. */
export function pushProblem(xml) {
  if (typeof xml !== 'string' || !xml.trim()) return 'empty'
  if (Buffer.byteLength(xml, 'utf8') > PUSH_MAX_BYTES) return 'too_large'
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) return 'unsafe_xml'
  if (!/<TALLYREQUEST>\s*Import Data\s*<\/TALLYREQUEST>/i.test(xml)) return 'not_an_import'
  if (!/<ENVELOPE[\s>]/i.test(xml) || !/<\/ENVELOPE>\s*$/i.test(xml)) return 'not_an_envelope'
  if ((xml.match(/<VOUCHER[\s>]/gi) ?? []).length !== 1) return 'one_voucher_only'
  if (!/ACTION\s*=\s*"Create"/i.test(xml)) return 'not_a_create'
  return null
}

const tagText = (xml, tag) => {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(xml)
  return m ? m[1].trim() : ''
}

/**
 * POST one server-built Import envelope to Tally.
 * → { ok: true, records: [{ name, status }] } | { ok: false, error }
 */
export async function pushVoucher(tallyUrl, job, opts = {}) {
  const problem = pushProblem(job?.xml)
  if (problem) return { ok: false, error: 'tally_error' }
  const t = validateTallyUrl(tallyUrl)
  if (t.error) return { ok: false, error: 'tally_unreachable' }
  const voucherNumber = tagText(job.xml, 'VOUCHERNUMBER') || 'voucher'
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? PUSH_TIMEOUT_MS)
  try {
    const res = await fetch(t.url, {
      method: 'POST', headers: { 'content-type': 'text/xml; charset=utf-8' },
      body: job.xml, signal: ctrl.signal, redirect: 'manual',
    })
    if (res.status !== 200) return { ok: false, error: 'bad_response' }
    const body = await readCapped(res, PUSH_MAX_BYTES)
    if (body === null) return { ok: false, error: 'too_large' }
    const text = body.replace(/^\uFEFF/, '')
    if (!looksLikeTallyXml(text) && !/<STATUS>/i.test(text)) return { ok: false, error: 'bad_response' }
    const ok = /<STATUS>\s*1\s*<\/STATUS>/i.test(text)
    const lineError = (/<LINEERROR>([\s\S]*?)<\/LINEERROR>/i.exec(text)?.[1] ?? '').trim()
    if (!ok) {
      // Tally says the remote id / voucher number is already there → not an error the user can fix
      if (/duplicate|already (exists|exist)|record already/i.test(lineError)) {
        return { ok: true, records: [{ name: voucherNumber, status: 'exists', message: lineError.slice(0, 200) }] }
      }
      return { ok: false, error: 'voucher_rejected' }
    }
    return { ok: true, records: [{ name: voucherNumber, status: 'created' }] }
  } catch {
    return { ok: false, error: ctrl.signal.aborted ? 'timeout' : 'tally_unreachable' }
  } finally {
    clearTimeout(timer)
  }
}

/** Run one named job against Tally → { ok: true, records } | { ok: false, error } */
export async function runJob(tallyUrl, job, opts = {}) {
  const def = JOBS[job?.type]
  if (!def) return { ok: false, error: 'tally_error' }
  if (job.type !== 'list-companies' && (typeof job.company !== 'string' || !job.company.trim() || job.company.length > 200)) return { ok: false, error: 'tally_error' }
  const t = validateTallyUrl(tallyUrl)
  if (t.error) return { ok: false, error: 'tally_unreachable' }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? EXPORT_TIMEOUT_MS)
  try {
    const res = await fetch(t.url, {
      method: 'POST', headers: { 'content-type': 'text/xml; charset=utf-8' },
      body: def.request(job.company), signal: ctrl.signal, redirect: 'manual',
    })
    if (res.status !== 200) return { ok: false, error: 'bad_response' }
    const reader = res.body.getReader()
    const chunks = []
    let size = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > EXPORT_MAX_BYTES) { await reader.cancel().catch(() => {}); return { ok: false, error: 'too_large' } }
      chunks.push(value)
    }
    let tree
    try { tree = parseXml(decodeBody(Buffer.concat(chunks)).replace(/^﻿/, '')) } catch { return { ok: false, error: 'bad_response' } }
    const env = tree.children.find((c) => c.name === 'ENVELOPE')
    if (!env) return { ok: false, error: 'bad_response' }
    const lineError = descendants(env, 'LINEERROR')[0]?.text ?? ''
    if (lineError) return { ok: false, error: /compan/i.test(lineError) ? 'company_not_found' : 'tally_error' }
    const records = descendants(env, def.tag).map(def.read).filter((r) => r.name)
    if (records.length > MAX_RECORDS) return { ok: false, error: 'too_large' }
    return { ok: true, records: records.map((r) => Object.fromEntries(Object.entries(r).filter(([, v]) => v))) }
  } catch {
    return { ok: false, error: ctrl.signal.aborted ? 'timeout' : 'tally_unreachable' }
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------- settings file

export function configPath(env = process.env, plat = osPlatform()) {
  if (env.MANUFLOW_CONNECTOR_CONFIG) return env.MANUFLOW_CONNECTOR_CONFIG
  const dir = plat === 'win32'
    ? join(env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'ManuFlowTallyConnector')
    : plat === 'darwin'
      ? join(homedir(), 'Library', 'Application Support', 'ManuFlowTallyConnector')
      : join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'manuflow-tally-connector')
  return join(dir, 'connector.json')
}

export function loadConfig(path = configPath()) {
  try {
    const c = JSON.parse(readFileSync(path, 'utf8'))
    return c && typeof c.token === 'string' && typeof c.server === 'string' ? c : null
  } catch {
    return null
  }
}

export function saveConfig(cfg, path = configPath()) {
  const dir = path.replace(/[\\/][^\\/]+$/, '')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const tmp = `${path}.tmp`
  // 0600: only this user can read the token (on Windows the user profile folder's permissions apply)
  writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 })
  try { chmodSync(tmp, 0o600) } catch { /* not supported on this file system */ }
  renameSync(tmp, path)
}

export function forgetConfig(path = configPath()) {
  rmSync(path, { force: true })
}

// ---------------------------------------------------------------- ManuFlow calls

async function postJson(url, body, token) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), SERVER_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
      signal: ctrl.signal,
      redirect: 'error', // a redirect could carry the token elsewhere
    })
    let json = null
    try { json = await res.json() } catch { /* not JSON */ }
    return { status: res.status, json }
  } finally {
    clearTimeout(timer)
  }
}

export async function pair({ server, code, tally = TALLY_DEFAULT_URL, path = configPath() }) {
  const s = validateServerUrl(server)
  if (s.error) throw new Error(s.error)
  const t = validateTallyUrl(tally)
  if (t.error) throw new Error(t.error)
  const r = await postJson(`${s.url}/api/tally-connector/pair`, { code, version: VERSION, platform: osPlatform() })
  if (r.status !== 200 || !r.json?.data?.token) throw new Error(r.json?.error?.message || `Pairing failed (HTTP ${r.status})`)
  saveConfig({ server: s.url, token: r.json.data.token, tally: t.url, pairedAt: new Date().toISOString() }, path)
  return { connectorId: r.json.data.connectorId }
}

/** One check + heartbeat. → { ok, revoked?, nextSec, tally } */
export async function heartbeatOnce(cfg, path = configPath()) {
  const tally = await checkTally(cfg.tally)
  const r = await postJson(`${cfg.server}/api/tally-connector/heartbeat`, {
    version: VERSION,
    platform: osPlatform(),
    tally: { status: tally.status, latencyMs: tally.latencyMs, endpoint: tally.endpoint },
  }, cfg.token)
  if (r.status === 401) {
    forgetConfig(path) // disconnected in ManuFlow: the token is useless now
    return { ok: false, revoked: true, nextSec: 0, tally }
  }
  if (r.status !== 200) return { ok: false, nextSec: 60, tally, error: r.json?.error?.message || `HTTP ${r.status}` }
  const next = Number(r.json?.data?.nextHeartbeatSec)
  const job = r.json?.data?.job
  let jobDone
  if (job && typeof job.id === 'string') {
    const out = job.type === 'push-voucher'
      ? await pushVoucher(cfg.tally, job)
      : JOBS[job.type] ? await runJob(cfg.tally, job) : { ok: false, error: 'tally_error' }
    let payload = JSON.stringify({ jobId: job.id, ...out })
    if (Buffer.byteLength(payload) > MAX_RESULT_BYTES) payload = JSON.stringify({ jobId: job.id, ok: false, error: 'too_large' })
    await postJson(`${cfg.server}/api/tally-connector/result`, JSON.parse(payload), cfg.token)
    jobDone = { type: job.type, ok: out.ok, count: out.ok ? out.records.length : 0, error: out.ok ? undefined : out.error }
  }
  return { ok: true, nextSec: Number.isFinite(next) ? Math.min(300, Math.max(5, next)) : 30, tally, job: jobDone }
}

export async function runLoop({ path = configPath(), log = console.log, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), maxBeats = Infinity } = {}) {
  let backoff = 15
  for (let i = 0; i < maxBeats; i++) {
    const cfg = loadConfig(path)
    if (!cfg) { log('Not paired. Run: pair --server <ManuFlow address> --code <code from ManuFlow>'); return 2 }
    let wait
    try {
      const r = await heartbeatOnce(cfg, path)
      if (r.revoked) { log('This connector was disconnected in ManuFlow. Its token was deleted; pair again to reconnect.'); return 2 }
      log(`${new Date().toISOString()} Tally: ${r.tally.status}${r.ok ? '' : ` · ManuFlow: ${r.error}`}${r.job ? ` · ${r.job.type}: ${r.job.ok ? `${r.job.count} ${r.job.type === 'push-voucher' ? 'voucher(s) pushed' : 'records sent'}` : r.job.error}` : ''}`)
      wait = r.nextSec
      backoff = 15
    } catch (e) {
      log(`${new Date().toISOString()} Cannot reach ManuFlow (${e?.name === 'AbortError' ? 'timeout' : 'network error'}) — retrying in ${backoff} s`)
      wait = backoff
      backoff = Math.min(300, backoff * 2)
    }
    if (i + 1 < maxBeats) await sleep(wait * 1000)
  }
  return 0
}

// ---------------------------------------------------------------- command line

function arg(argv, name) {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}

export async function main(argv = process.argv.slice(2), log = console.log) {
  const cmd = argv[0]
  if (cmd === 'check') {
    const r = await checkTally(arg(argv, 'tally') || loadConfig()?.tally || TALLY_DEFAULT_URL)
    log(`Tally: ${r.status}${r.endpoint ? ` at ${r.endpoint}` : ''}${r.latencyMs != null ? ` (${r.latencyMs} ms)` : ''}${r.message ? ` — ${r.message}` : ''}`)
    return r.status === 'connected' ? 0 : 1
  }
  if (cmd === 'pair') {
    try {
      await pair({ server: arg(argv, 'server'), code: arg(argv, 'code'), tally: arg(argv, 'tally') || TALLY_DEFAULT_URL })
      log(`Paired. Settings saved in ${configPath()}. Start it with: run`)
      return 0
    } catch (e) {
      log(`Pairing failed: ${e.message}`)
      return 1
    }
  }
  if (cmd === 'run') return runLoop({ log })
  if (cmd === 'status') {
    const c = loadConfig()
    log(c ? `Paired with ${c.server} on ${c.pairedAt}; Tally address ${c.tally}` : 'Not paired')
    return 0
  }
  if (cmd === 'forget') {
    forgetConfig()
    log('Connector settings deleted. Also click "Disconnect" in ManuFlow if this computer is lost or replaced.')
    return 0
  }
  log('Commands: check | pair --server <url> --code <code> [--tally http://127.0.0.1:9000] | run | status | forget')
  return 1
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then((code) => process.exit(code))
}
