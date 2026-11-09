#!/usr/bin/env node
/**
 * ManuFlow Tally Connector — proof of concept. Needs Node.js 18 or newer; no other packages.
 *
 * Runs on a computer in the customer's office network (normally the TallyPrime PC itself) and connects OUT to
 * ManuFlow over HTTPS. Nothing has to be opened to the internet: Tally's XML port (default 9000, no
 * authentication) stays inside the office.
 *
 *   node manuflow-tally-connector.mjs check  [--tally http://127.0.0.1:9000] [--server https://your-manuflow]
 *   node manuflow-tally-connector.mjs pair   --server https://your-manuflow --code ABCDE-FGHJK [--tally http://127.0.0.1:9000]
 *            (or --code-stdin: the code is read from standard input, so it is not in the command line)
 *   node manuflow-tally-connector.mjs version
 *   node manuflow-tally-connector.mjs run    [--log-file <file>]
 *   node manuflow-tally-connector.mjs set-tally --tally http://192.168.1.20:9000
 *   node manuflow-tally-connector.mjs status
 *   node manuflow-tally-connector.mjs forget
 *   (every command except capture also takes --config <file>: where the settings are kept; Windows task, docs)
 *   node manuflow-tally-connector.mjs capture --tally http://127.0.0.1:9000 --out /absolute/new/folder [--company "Exact name"]
 *            [--vouchers-from YYYYMMDD --vouchers-to YYYYMMDD]   (vouchers of that period instead of masters)
 *            [--daybook]          (diagnostic: TallyPrime's own Day Book report for the period instead)
 *
 * What it sends to Tally: TALLY_HEALTH_REQUEST below (an Export of a report that does not exist, so Tally answers with
 * a short status reply) and, when ManuFlow asks for one of its NAMED read jobs, the matching fixed Export request
 * built here (company list; Sundry Debtors / Sundry Creditors ledgers; stock items; groups, all ledgers, stock groups,
 * units, godowns).
 *
 * READ-ONLY: this program never writes to Tally. Every request goes through postToTally(), which refuses anything but
 * TALLYREQUEST=Export, and there is no code here that builds or forwards an Import request. A job with any other name,
 * or XML sent along with a job, is refused or ignored.
 *
 * The Tally address is set here, on this computer, and must be this computer or a private network address; ManuFlow
 * cannot send it an address.
 * NOTE: the export requests and the field names read from Tally's replies have only been tested against a mock
 * server, not a real TallyPrime.
 *
 * What it sends to ManuFlow: the pairing code (once), a heartbeat every 5–30 s with the result of that check, and the
 * records of a job it was asked for (masters: names, GSTIN, address, units…, and a ledger's opening balance; no vouchers).
 * The connector token is saved in the user's settings folder (file readable by this user only) and is never printed.
 * ManuFlow replaces it every 7 days through the heartbeat reply; if that reply is lost, the old token still works (for up
 * to 30 days after the rotation) and ManuFlow hands out a new one at the next contact. The token is
 * deleted ONLY when ManuFlow answers CONNECTOR_REVOKED (disconnected there); network errors, timeouts, server errors or
 * odd replies never delete it — the connector retries with increasing waits and reconnects by itself.
 */
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { homedir, hostname, platform as osPlatform, uptime } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const VERSION = '0.3.3'
export const TALLY_DEFAULT_URL = 'http://127.0.0.1:9000'
const TALLY_TIMEOUT_MS = 4000
const TALLY_MAX_BYTES = 256 * 1024
const SERVER_TIMEOUT_MS = 15000
const EXPORT_TIMEOUT_MS = 120000
const EXPORT_MAX_BYTES = 64 * 1024 * 1024
const MAX_RECORDS = 20000
const MAX_RESULT_BYTES = 8 * 1024 * 1024
const TOKEN_RE = /^mftc_[a-f0-9]{24}_[A-Za-z0-9_-]{43}$/

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
  return decodeBody(Buffer.concat(chunks))
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
    const res = await postToTally(t.url, TALLY_HEALTH_REQUEST, ctrl.signal)
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

const PARTY_FETCH = 'NAME, GUID, PARENT, ALTERID, PARTYGSTIN, GSTREGISTRATIONTYPE, INCOMETAXNUMBER, LEDSTATENAME, PINCODE, ADDRESS, LEDGERPHONE, LEDGERMOBILE, EMAIL, LEDGERCONTACT, LEDGSTREGDETAILS, LEDMAILINGDETAILS'

/** The only jobs the connector runs. Anything else ManuFlow might send is refused. */
export const JOBS = {
  'list-companies': {
    // GUID added in 0.3.0 (tells two open companies with the same name apart); not yet seen in a real TallyPrime reply
    request: () => collectionRequest('ManuFlowCompanies', 'Company', 'NAME, GUID, STARTINGFROM, BOOKSFROM'),
    tag: 'COMPANY',
    read: (n) => ({ name: objName(n), guid: text(n, 'GUID'), startingFrom: tallyDate(text(n, 'STARTINGFROM')), booksFrom: tallyDate(text(n, 'BOOKSFROM')) }),
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
    request: (company) => collectionRequest('ManuFlowStockItems', 'StockItem', 'NAME, GUID, PARENT, ALTERID, BASEUNITS, HSNCODE, GSTDETAILS, HSNDETAILS', { company }),
    tag: 'STOCKITEM',
    read: (n) => ({
      guid: text(n, 'GUID'), name: objName(n), parent: text(n, 'PARENT'), alterId: text(n, 'ALTERID'), unit: text(n, 'BASEUNITS'),
      hsn: text(n, 'HSNCODE') || text(n, 'GSTDETAILS.LIST', 'HSNCODE') || text(n, 'HSNDETAILS.LIST', 'HSNCODE'),
      gstRate: igstRate(n),
    }),
  },
  // Masters kept as a source copy in ManuFlow (Layer 1), never imported into its business tables by themselves.
  // NOTE: these five requests have not been run against a real TallyPrime yet (docs/tally-real-validation-plan.md).
  'export-groups': {
    request: (company) => collectionRequest('ManuFlowGroups', 'Group', 'NAME, GUID, PARENT, ALTERID, ISREVENUE, AFFECTSGROSSPROFIT, ISDEEMEDPOSITIVE, ISSUBLEDGER, ISBILLWISEON', { company }),
    tag: 'GROUP',
    read: (n) => ({
      ...master(n), isRevenue: text(n, 'ISREVENUE'), affectsGrossProfit: text(n, 'AFFECTSGROSSPROFIT'),
      isDeemedPositive: text(n, 'ISDEEMEDPOSITIVE'), isSubLedger: text(n, 'ISSUBLEDGER'), isBillWiseOn: text(n, 'ISBILLWISEON'),
    }),
  },
  'export-ledgers': {
    request: (company) => collectionRequest('ManuFlowLedgers', 'Ledger', 'NAME, GUID, PARENT, ALTERID, OPENINGBALANCE, ISBILLWISEON, ISCOSTCENTRESON, CURRENCYNAME, PARTYGSTIN, LEDGSTREGDETAILS, LEDSTATENAME, LEDMAILINGDETAILS', { company }),
    tag: 'LEDGER',
    read: (n) => ({
      ...master(n), openingBalance: text(n, 'OPENINGBALANCE'), isBillWiseOn: text(n, 'ISBILLWISEON'), isCostCentresOn: text(n, 'ISCOSTCENTRESON'),
      currency: text(n, 'CURRENCYNAME'), gstin: text(n, 'PARTYGSTIN') || text(n, 'LEDGSTREGDETAILS.LIST', 'GSTIN'),
      state: text(n, 'LEDSTATENAME') || text(n, 'LEDMAILINGDETAILS.LIST', 'STATE'),
    }),
  },
  'export-stockgroups': {
    request: (company) => collectionRequest('ManuFlowStockGroups', 'StockGroup', 'NAME, GUID, PARENT, ALTERID', { company }),
    tag: 'STOCKGROUP',
    read: master,
  },
  'export-units': {
    request: (company) => collectionRequest('ManuFlowUnits', 'Unit', 'NAME, GUID, ALTERID, ORIGINALNAME, ISSIMPLEUNIT, DECIMALPLACES, BASEUNITS, ADDITIONALUNITS, CONVERSION, GSTREPUOM', { company }),
    tag: 'UNIT',
    read: (n) => ({
      guid: text(n, 'GUID'), name: objName(n), alterId: text(n, 'ALTERID'), formalName: text(n, 'ORIGINALNAME'), isSimple: text(n, 'ISSIMPLEUNIT'),
      decimals: text(n, 'DECIMALPLACES'), baseUnits: text(n, 'BASEUNITS'), additionalUnits: text(n, 'ADDITIONALUNITS'),
      conversion: text(n, 'CONVERSION'), gstUqc: text(n, 'GSTREPUOM'),
    }),
  },
  'export-godowns': {
    request: (company) => collectionRequest('ManuFlowGodowns', 'Godown', 'NAME, GUID, PARENT, ALTERID', { company }),
    tag: 'GODOWN',
    read: master,
  },
}

/**
 * PROPOSED, NOT USED: the fixed read-only request for one period of vouchers (Phase F; docs/tally-vouchers-design.md).
 * It is deliberately not in JOBS, so ManuFlow cannot ask for it and nothing runs it until a capture is approved.
 * The period goes in as SVFROMDATE / SVTODATE and a read-only filter formula; dates must be exactly YYYYMMDD.
 */
export function voucherRequest(company, from, to) {
  if (typeof company !== 'string' || !company.trim() || company.length > 200) throw new Error('company is required')
  if (!/^\d{8}$/.test(String(from)) || !/^\d{8}$/.test(String(to)) || from > to) throw new Error('from and to must be YYYYMMDD, from <= to')
  return '<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE>' +
    '<ID>ManuFlowVouchers</ID></HEADER><BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>' +
    `<SVCURRENTCOMPANY>${escXml(company)}</SVCURRENTCOMPANY>` +
    `<SVFROMDATE TYPE="Date">${from}</SVFROMDATE><SVTODATE TYPE="Date">${to}</SVTODATE></STATICVARIABLES>` +
    '<TDL><TDLMESSAGE><COLLECTION NAME="ManuFlowVouchers" ISMODIFY="No"><TYPE>Voucher</TYPE>' +
    '<FETCH>GUID, MASTERID, ALTERID, DATE, EFFECTIVEDATE, VOUCHERTYPENAME, VOUCHERNUMBER, REFERENCE, REFERENCEDATE, ' +
    'PARTYLEDGERNAME, NARRATION, ISCANCELLED, ISOPTIONAL, ISINVOICE, PLACEOFSUPPLY, PARTYGSTIN, GSTREGISTRATIONTYPE, ' +
    'ALLLEDGERENTRIES, LEDGERENTRIES, ALLINVENTORYENTRIES, INVENTORYENTRIES</FETCH>' +
    '<FILTER>ManuFlowInPeriod</FILTER></COLLECTION>' +
    '<SYSTEM TYPE="Formulae" NAME="ManuFlowInPeriod">$Date &gt;= ##SVFromDate AND $Date &lt;= ##SVToDate</SYSTEM>' +
    '</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>'
}

/**
 * One <VOUCHER> → the record shape ManuFlow's voucher staging takes (TallyVoucherRecord). Values are passed on as
 * text, exactly as Tally wrote them (amounts, quantities, rates, Yes/No); nothing is interpreted or guessed here.
 * NOTE: built from Tally's object XML tag names (a Tally-format voucher file); NOT yet checked against a real
 * TallyPrime Export reply. Of ALL…ENTRIES.LIST and …ENTRIES.LIST, the first one that has entries with content is used
 * (a real Day Book reply had only LEDGERENTRIES.LIST); entries without any content are skipped.
 */
export function readVoucher(n) {
  const hasContent = (c) => c.children.some((x) => x.text.trim() || x.children.length)
  const list = (node, ...tags) => {
    for (const t of tags) {
      const found = node.children.filter((c) => c.name === t && hasContent(c))
      if (found.length) return found
    }
    return []
  }
  const pick = (node, fields) => Object.fromEntries(fields.map((f) => [f, text(node, f)]).filter(([, v]) => v))
  const ledger = (e) => ({
    ledgerName: text(e, 'LEDGERNAME'), amount: text(e, 'AMOUNT'), isDeemedPositive: text(e, 'ISDEEMEDPOSITIVE'), isPartyLedger: text(e, 'ISPARTYLEDGER'),
    // an allocation with no name, type or amount is an empty placeholder (Tally sends one under accounting allocations)
    bills: list(e, 'BILLALLOCATIONS.LIST').map((b) => ({ name: text(b, 'NAME'), billType: text(b, 'BILLTYPE'), amount: text(b, 'AMOUNT'), extra: pick(b, ['BILLCREDITPERIOD', 'BILLDATE']) }))
      .filter((b) => b.name || b.billType || b.amount),
    extra: pick(e, ['GSTCLASS', 'GSTOVRDNNATURE', 'GSTOVRDNTAXABILITY', 'GSTHSNNAME', 'TAXCLASSIFICATIONNAME', 'VATEXPAMOUNT']),
  })
  return {
    guid: text(n, 'GUID'), masterId: text(n, 'MASTERID'), alterId: text(n, 'ALTERID'),
    date: text(n, 'DATE'), effectiveDate: text(n, 'EFFECTIVEDATE'),
    voucherType: text(n, 'VOUCHERTYPENAME') || n.attrs.VCHTYPE || '', voucherNumber: text(n, 'VOUCHERNUMBER'),
    reference: text(n, 'REFERENCE'), referenceDate: text(n, 'REFERENCEDATE'), partyLedger: text(n, 'PARTYLEDGERNAME'),
    narration: text(n, 'NARRATION'), isCancelled: text(n, 'ISCANCELLED'), isOptional: text(n, 'ISOPTIONAL'), isInvoice: text(n, 'ISINVOICE'),
    extra: pick(n, ['PLACEOFSUPPLY', 'PARTYGSTIN', 'GSTREGISTRATIONTYPE', 'STATENAME', 'COUNTRYOFRESIDENCE', 'VCHGSTCLASS', 'CURRENCYNAME', 'BASICBUYERNAME']),
    ledgerEntries: list(n, 'ALLLEDGERENTRIES.LIST', 'LEDGERENTRIES.LIST').map(ledger),
    inventoryEntries: list(n, 'ALLINVENTORYENTRIES.LIST', 'INVENTORYENTRIES.LIST').map((e) => ({
      stockItemName: text(e, 'STOCKITEMNAME'), actualQty: text(e, 'ACTUALQTY'), billedQty: text(e, 'BILLEDQTY'), rate: text(e, 'RATE'),
      amount: text(e, 'AMOUNT'), isDeemedPositive: text(e, 'ISDEEMEDPOSITIVE'),
      batches: list(e, 'BATCHALLOCATIONS.LIST').map((b) => ({
        godownName: text(b, 'GODOWNNAME'), batchName: text(b, 'BATCHNAME'), actualQty: text(b, 'ACTUALQTY'), billedQty: text(b, 'BILLEDQTY'), amount: text(b, 'AMOUNT'),
      })),
      accountingAllocations: list(e, 'ACCOUNTINGALLOCATIONS.LIST').map(ledger),
      extra: pick(e, ['DISCOUNT', 'GSTHSNNAME', 'HSNCODE', 'GSTOVRDNTAXABILITY']),
    })),
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** YYYYMMDD → Tally's documented date text, e.g. 20260401 → 1-Apr-2026. */
export const tallyDateText = (d) => `${Number(d.slice(6, 8))}-${MONTHS[Number(d.slice(4, 6)) - 1]}-${d.slice(0, 4)}`

/**
 * PROPOSED, NOT USED: TallyPrime's own Day Book report for a period (TYPE Data, ID DayBook — as in Tally's integration
 * documentation). Tally applies the period itself, as on its Day Book screen. No TDL, no filter. Not in JOBS.
 */
export function dayBookRequest(company, from, to) {
  if (typeof company !== 'string' || !company.trim() || company.length > 200) throw new Error('company is required')
  if (!/^\d{8}$/.test(String(from)) || !/^\d{8}$/.test(String(to)) || from > to) throw new Error('from and to must be YYYYMMDD, from <= to')
  return '<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE><ID>DayBook</ID></HEADER>' +
    '<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>' +
    `<SVCURRENTCOMPANY>${escXml(company)}</SVCURRENTCOMPANY>` +
    `<SVFROMDATE TYPE="Date">${tallyDateText(from)}</SVFROMDATE><SVTODATE TYPE="Date">${tallyDateText(to)}</SVTODATE>` +
    '</STATICVARIABLES></DESC></BODY></ENVELOPE>'
}

/**
 * Vouchers in a Day Book reply. Its layout is NOT documented; only these two voucher-object layouts are read:
 *   BODY/IMPORTDATA/REQUESTDATA/TALLYMESSAGE/VOUCHER   (Tally's data-interchange layout)
 *   BODY/DATA/TALLYMESSAGE/VOUCHER
 * Anything else (e.g. a display layout with DSP… tags and no voucher objects) → { layout: 'unknown' }: reported, not guessed.
 */
export function readDayBook(xmlText) {
  const env = parseXml(xmlText.replace(/^\uFEFF/, '')).children.find((c) => c.name === 'ENVELOPE')
  if (!env) throw new Error('Not a Tally reply')
  const child = (n, name) => n?.children.filter((c) => c.name === name) ?? []
  const body = child(env, 'BODY')[0]
  const paths = [['interchange', child(child(body, 'IMPORTDATA')[0], 'REQUESTDATA')[0]], ['data', child(body, 'DATA')[0]]]
  for (const [layout, holder] of paths) {
    const vouchers = child(holder, 'TALLYMESSAGE').flatMap((m) => child(m, 'VOUCHER'))
    if (vouchers.length || child(holder, 'TALLYMESSAGE').length) return { layout, vouchers: vouchers.map(readVoucher) }
  }
  return { layout: 'unknown', vouchers: [] }
}

/** Vouchers in a reply: only BODY/DATA/COLLECTION/VOUCHER (as for masters). */
export function readVouchers(xmlText) {
  const env = parseXml(xmlText.replace(/^\uFEFF/, '')).children.find((c) => c.name === 'ENVELOPE')
  if (!env) throw new Error('Not a Tally reply')
  const coll = env.children.find((c) => c.name === 'BODY')?.children.find((c) => c.name === 'DATA')?.children.find((c) => c.name === 'COLLECTION')
  return (coll ? coll.children.filter((c) => c.name === 'VOUCHER') : []).map(readVoucher)
}

/** Fields every master has. */
function master(n) {
  return { guid: text(n, 'GUID'), name: objName(n), parent: text(n, 'PARENT'), alterId: text(n, 'ALTERID') }
}

function readParty(n) {
  const addr = all(n, 'ADDRESS.LIST', 'ADDRESS').length ? all(n, 'ADDRESS.LIST', 'ADDRESS') : all(n, 'LEDMAILINGDETAILS.LIST', 'ADDRESS.LIST', 'ADDRESS')
  return {
    guid: text(n, 'GUID'), name: objName(n), parent: text(n, 'PARENT'), alterId: text(n, 'ALTERID'),
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
  // TallyPrime may answer in UTF-16 (with or without a byte-order mark) or UTF-8
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2))
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2))
  if (buf[0] === 0x3c && buf[1] === 0) return new TextDecoder('utf-16le').decode(buf)
  if (buf[0] === 0 && buf[1] === 0x3c) return new TextDecoder('utf-16be').decode(buf)
  return new TextDecoder('utf-8').decode(buf)
}

// ---------------------------------------------------------------- the only way to reach Tally

/** Is this exactly one Export request? Anything that could write (Import, or a second envelope) is not. */
export function isExportRequest(xml) {
  if (typeof xml !== 'string' || /<!DOCTYPE|<!ENTITY/i.test(xml)) return false
  const kinds = xml.match(/<TALLYREQUEST>[^<]*<\/TALLYREQUEST>/gi) ?? []
  return kinds.length === 1 && /^<TALLYREQUEST>\s*Export\s*<\/TALLYREQUEST>$/i.test(kinds[0]) && !/<[^>]*\sACTION\s*=|<IMPORTDATA|<TALLYMESSAGE/i.test(xml)
}

/** Every request to Tally passes here; a request that is not a plain Export is never sent. */
function postToTally(url, xml, signal) {
  if (!isExportRequest(xml)) throw new Error('Refused: the connector only sends Export requests to Tally')
  return fetch(url, {
    method: 'POST', headers: { 'content-type': 'text/xml; charset=utf-8' },
    body: xml, signal, redirect: 'manual',
  })
}

/** Run one named job against Tally → { ok: true, records } | { ok: false, error } (+ raw: the reply bytes, with keepRaw) */
export async function runJob(tallyUrl, job, opts = {}) {
  const def = JOBS[job?.type]
  if (!def) return { ok: false, error: 'tally_error' }
  if (job.type !== 'list-companies' && (typeof job.company !== 'string' || !job.company.trim() || job.company.length > 200)) return { ok: false, error: 'tally_error' }
  const t = validateTallyUrl(tallyUrl)
  if (t.error) return { ok: false, error: 'tally_unreachable' }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? EXPORT_TIMEOUT_MS)
  try {
    const res = await postToTally(t.url, def.request(job.company), ctrl.signal)
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
    const raw = Buffer.concat(chunks)
    const out = (r) => (opts.keepRaw ? { ...r, raw } : r)
    let tree
    try { tree = parseXml(decodeBody(raw).replace(/^﻿/, '')) } catch { return out({ ok: false, error: 'bad_response' }) }
    const env = tree.children.find((c) => c.name === 'ENVELOPE')
    if (!env) return out({ ok: false, error: 'bad_response' })
    const lineError = descendants(env, 'LINEERROR')[0]?.text ?? ''
    if (lineError) return out({ ok: false, error: /compan/i.test(lineError) ? 'company_not_found' : 'tally_error' })
    // Records only from BODY/DATA/COLLECTION: Tally's BODY/DESC/CMPINFO uses the same tag names (LEDGER, STOCKITEM, …)
    // for its counts (seen in the first real capture, 2026-11-03)
    const coll = env.children.find((c) => c.name === 'BODY')?.children.find((c) => c.name === 'DATA')?.children.find((c) => c.name === 'COLLECTION')
    const records = (coll ? coll.children.filter((c) => c.name === def.tag) : []).map(def.read).filter((r) => r.name)
    if (records.length > MAX_RECORDS) return out({ ok: false, error: 'too_large' })
    return out({ ok: true, records: records.map((r) => Object.fromEntries(Object.entries(r).filter(([, v]) => v))) })
  } catch {
    return { ok: false, error: ctrl.signal.aborted ? 'timeout' : 'tally_unreachable' }
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------- capture (test fixtures; docs/tally-real-validation-plan.md)

/** One request through the guard, the reply bytes kept as they are (capture only). → { raw?, error? } */
async function exportRaw(url, xml, timeoutMs = EXPORT_TIMEOUT_MS) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await postToTally(url, xml, ctrl.signal)
    if (res.status !== 200) return { error: 'bad_response' }
    const reader = res.body.getReader()
    const chunks = []
    let size = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > EXPORT_MAX_BYTES) { await reader.cancel().catch(() => {}); return { error: 'too_large' } }
      chunks.push(value)
    }
    return { raw: Buffer.concat(chunks) }
  } catch {
    return { error: ctrl.signal.aborted ? 'timeout' : 'tally_unreachable' }
  } finally {
    clearTimeout(timer)
  }
}

/** Is this path (or the nearest folder above it that exists) inside a Git working tree? */
export function insideGitRepo(path) {
  for (let dir = resolve(path); ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git'))) return true
    if (dirname(dir) === dir) return false
  }
}

const CAPTURE_EXPORTS = ['export-customers', 'export-suppliers', 'export-items']

/**
 * Saves Tally's raw replies to the existing read-only requests, for turning into anonymised test fixtures.
 * Same requests and guard as the jobs (Export only). Never contacts ManuFlow and never reads the saved token.
 * Without `company`: the company list only (so the data owner can choose). With it: customers, suppliers, stock items.
 * `out` must be an absolute, new or empty folder outside any Git working tree; folder 0700, files 0600.
 * With `from` and `to` (YYYYMMDD, plus `company`): the vouchers of that period instead of the masters — the request
 * voucherRequest() builds, through the same guard; one reply file, a manifest with the voucher count per type.
 * With `dayBook` (and the same dates): TallyPrime's own Day Book report instead of the voucher collection (diagnostic).
 * @param {{ tally?: string, out?: string, company?: string, from?: string, to?: string, dayBook?: boolean, log?: (m: string) => void }} opts
 */
export async function capture({ tally, out, company, from, to, dayBook = false, log = console.log }) {
  const t = validateTallyUrl(tally)
  if (t.error) throw new Error(t.error)
  const vouchers = from !== undefined || to !== undefined
  if (dayBook && !vouchers) throw new Error('--daybook needs --vouchers-from and --vouchers-to')
  if (vouchers) (dayBook ? dayBookRequest(company ?? '', from, to) : voucherRequest(company ?? '', from, to)) // checks company and dates before anything is created or sent
  if (typeof out !== 'string' || !isAbsolute(out)) throw new Error('--out must be an absolute folder path')
  if (insideGitRepo(out)) throw new Error('--out must be outside any Git working tree: raw Tally data is never committed')
  if (existsSync(out) && readdirSync(out).length) throw new Error('--out must be a new or empty folder')
  mkdirSync(out, { recursive: true, mode: 0o700 })
  try { chmodSync(out, 0o700) } catch { /* not supported on this file system */ }
  const files = []
  const save = (job, r) => {
    const name = `${job}.xml`
    if (r.raw) {
      writeFileSync(join(out, name), r.raw, { mode: 0o600 })
      try { chmodSync(join(out, name), 0o600) } catch { /* not supported on this file system */ }
    }
    files.push({ job, file: r.raw ? name : null, bytes: r.raw?.length ?? 0, ok: r.ok, records: r.ok ? r.records.length : null, error: r.ok ? null : r.error })
    log(`${job}: ${r.ok ? `${r.records.length} records` : r.error}${r.raw ? ` · ${r.raw.length} bytes saved` : ''}`)
  }
  const writeManifest = (extra = {}) => {
    const manifest = { capturedAt: new Date().toISOString(), connectorVersion: VERSION, tallyEndpoint: t.endpoint, company: company ?? null, ...extra, files }
    writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 })
  }

  const list = await runJob(t.url, { type: 'list-companies' }, { keepRaw: true })
  save('list-companies', list)
  if (!list.ok) { writeManifest(); throw new Error(`Tally did not return the company list (${list.error})`) }
  const names = list.records.map((r) => r.name)
  if (!company) {
    writeManifest()
    log('Companies open in TallyPrime:')
    names.forEach((n, i) => log(`  ${i + 1}. ${n}`))
    log('Choose one, then run capture again with --company "<exact name>" and a NEW --out folder.')
    return { companies: names, files }
  }
  if (!names.includes(company)) { writeManifest(); throw new Error('That company is not open in TallyPrime (the name must match exactly)') }
  if (vouchers) {
    const r = await exportRaw(t.url, dayBook ? dayBookRequest(company, from, to) : voucherRequest(company, from, to))
    const name = `${dayBook ? 'daybook' : 'vouchers'}-${from}-${to}`
    let summary = null
    let layout = null
    let parsed = { ok: false, error: r.error ?? 'bad_response' }
    if (r.raw) {
      try {
        const read = dayBook ? readDayBook(decodeBody(r.raw)) : { layout: 'collection', vouchers: readVouchers(decodeBody(r.raw)) }
        const list = read.vouchers
        layout = read.layout
        const byType = {}
        for (const v of list) byType[v.voucherType || '(none)'] = (byType[v.voucherType || '(none)'] ?? 0) + 1
        summary = { vouchers: list.length, byType }
        parsed = { ok: true, records: list }
      } catch { parsed = { ok: false, error: 'bad_response' } }
    }
    save(name, { ...parsed, raw: r.raw })
    writeManifest({ period: { from, to }, request: dayBook ? 'daybook' : 'collection', layout, summary })
    log(`Saved in ${out}. Nothing was sent to ManuFlow; Tally was only read.`)
    return { companies: names, files, summary }
  }
  for (const type of CAPTURE_EXPORTS) save(type, await runJob(t.url, { type, company }, { keepRaw: true }))
  writeManifest()
  log(`Saved in ${out}. Nothing was sent to ManuFlow; Tally was only read.`)
  return { companies: names, files }
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
  // 0600: only this user can read the token (on Windows the folder's access list applies; the install script sets it)
  writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 })
  try { chmodSync(tmp, 0o600) } catch { /* not supported on this file system */ }
  renameSync(tmp, path)
}

export function forgetConfig(path = configPath()) {
  rmSync(path, { force: true })
}

/**
 * This computer's identity for ManuFlow: random, made once when it is first paired and kept in the settings (never
 * derived from the hardware). ManuFlow binds the token to it, so the token alone does not work from another computer.
 */
const DEVICE_ID_RE = /^[a-f0-9]{32}$/
export const newDeviceId = () => globalThis.crypto.randomUUID().replace(/-/g, '')

/** The computer's name, shown to the company's administrators in ManuFlow so they can tell which computer is connected. */
export function deviceName() {
  try {
    return String(hostname()).replace(/[^\w.\- ]/g, '').trim().slice(0, 60) || undefined
  } catch {
    return undefined
  }
}

/** Is version a older than version b? (numeric x.y.z; anything unreadable counts as 0) */
export function olderThan(a, b) {
  const pa = String(a).split('.').map((x) => Number.parseInt(x, 10) || 0)
  const pb = String(b).split('.').map((x) => Number.parseInt(x, 10) || 0)
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0)
  return false
}

// ---------------------------------------------------------------- one running copy per settings file

/**
 * `run` holds <settings>.lock while it runs, so a scheduled task and a copy started by hand cannot both use one token.
 * The lock is touched at every heartbeat; a lock whose process is gone, or that was not touched for LOCK_STALE_MS (the
 * longest wait between heartbeats is 5 minutes), was left behind by a crash or a restart and is taken over. So is a lock
 * last touched before Windows started (a stopped task or a shutdown never removes it, and Windows soon reuses process
 * numbers, so after a restart its number may belong to an unrelated process). BOOT_SLACK_MS allows for the clock being
 * corrected after startup.
 */
const LOCK_STALE_MS = 10 * 60 * 1000
const BOOT_SLACK_MS = 2 * 60 * 1000
/** When this computer started (ms since 1970), from its uptime */
export const bootTime = (now = Date.now()) => now - uptime() * 1000
const lockFile = (path) => `${path}.lock`

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0) // signal 0: only asks whether the process exists
    return true
  } catch (e) {
    return e?.code === 'EPERM'
  }
}

export function acquireLock(path, now = Date.now(), bootAt = bootTime(now)) {
  const f = lockFile(path)
  mkdirSync(dirname(f), { recursive: true, mode: 0o700 })
  for (let i = 0; i < 2; i++) {
    try {
      writeFileSync(f, String(process.pid), { flag: 'wx', mode: 0o600 })
      return true
    } catch (e) {
      if (e?.code !== 'EEXIST') throw e
    }
    let pid = 0
    let touched = -Infinity
    try {
      pid = Number(readFileSync(f, 'utf8').trim())
      touched = statSync(f).mtimeMs
    } catch { /* removed meanwhile */ }
    const sinceThisStart = touched >= bootAt - BOOT_SLACK_MS
    if (pid !== process.pid && processAlive(pid) && now - touched < LOCK_STALE_MS && sinceThisStart) return false
    rmSync(f, { force: true })
  }
  return false
}

export function touchLock(path) {
  try {
    const t = new Date()
    utimesSync(lockFile(path), t, t)
  } catch { /* re-created at the next start */ }
}

export function releaseLock(path) {
  try {
    if (Number(readFileSync(lockFile(path), 'utf8').trim()) === process.pid) rmSync(lockFile(path), { force: true })
  } catch { /* already gone */ }
}

// ---------------------------------------------------------------- log file (the Windows task has no console)

const LOG_MAX_BYTES = 1024 * 1024

/** Writes each line to `file` too, rotated at 1 MB (one older file kept). The token is never logged. */
export function fileLogger(file, echo = console.log) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  return (line) => {
    echo(line)
    try {
      if (existsSync(file) && statSync(file).size > LOG_MAX_BYTES) renameSync(file, `${file}.1`)
      appendFileSync(file, `${line}\n`, { mode: 0o600 })
    } catch { /* logging must never stop the connector */ }
  }
}

// ---------------------------------------------------------------- ManuFlow calls

/**
 * ManuFlow is reached over https with the certificate checked (Node's default). If certificate checks were switched
 * off for this process (NODE_TLS_REJECT_UNAUTHORIZED=0), nothing is sent: the token and pairing code would go to
 * whoever answers.
 */
export function tlsProblem(url, env = process.env) {
  return /^https:/i.test(url) && env.NODE_TLS_REJECT_UNAUTHORIZED === '0'
    ? 'TLS certificate checks are switched off for this program (NODE_TLS_REJECT_UNAUTHORIZED=0) — remove that setting; nothing was sent to ManuFlow'
    : ''
}

async function postJson(url, body, token) {
  const tls = tlsProblem(url)
  if (tls) throw Object.assign(new Error(tls), { code: 'TLS_CHECKS_OFF' })
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

/** Can this computer reach ManuFlow, is the connector switched on there, and is this version accepted? (no token sent) */
export async function pingServer(server) {
  const s = validateServerUrl(server)
  if (s.error) return { ok: false, message: s.error }
  try {
    const r = await postJson(`${s.url}/api/tally-connector/ping`, { version: VERSION })
    const d = r.json?.data
    if (r.status === 503) return { ok: false, message: `${s.url} answers, but the Tally Connector is switched off on that ManuFlow server` }
    if (r.status !== 200 || !d || d.service !== 'manuflow-tally-connector') return { ok: false, message: `${s.url} answers, but not as ManuFlow (HTTP ${r.status})` }
    if (typeof d.minVersion === 'string' && olderThan(VERSION, d.minVersion)) {
      return { ok: false, message: `${s.url} answers, but this connector (${VERSION}) is too old: install version ${d.minVersion} or newer` }
    }
    const newer = typeof d.latestVersion === 'string' && olderThan(VERSION, d.latestVersion) ? ` (a newer connector, ${d.latestVersion}, is available)` : ''
    return { ok: true, message: `${s.url} can be reached${newer}` }
  } catch (e) {
    return { ok: false, message: e?.name === 'AbortError' ? `${s.url} did not answer in time` : `${s.url} cannot be reached from this computer (network, proxy or firewall)` }
  }
}

export async function pair({ server, code, tally = TALLY_DEFAULT_URL, path = configPath() }) {
  const s = validateServerUrl(server)
  if (s.error) throw new Error(s.error)
  const t = validateTallyUrl(tally)
  if (t.error) throw new Error(t.error)
  // Pairing this computer again keeps its identity, so ManuFlow shows it as the same computer
  const old = loadConfig(path)
  const deviceId = DEVICE_ID_RE.test(old?.deviceId ?? '') ? old.deviceId : newDeviceId()
  const r = await postJson(`${s.url}/api/tally-connector/pair`, { code, version: VERSION, platform: osPlatform(), deviceId, deviceName: deviceName() })
  if (r.status !== 200 || !r.json?.data?.token) throw new Error(r.json?.error?.message || `Pairing failed (HTTP ${r.status})`)
  saveConfig({ server: s.url, token: r.json.data.token, tally: t.url, deviceId, pairedAt: new Date().toISOString() }, path)
  return { connectorId: r.json.data.connectorId }
}

/** One check + heartbeat. → { ok, revoked?, nextSec, tally, notice? } */
export async function heartbeatOnce(cfg, path = configPath()) {
  if (!DEVICE_ID_RE.test(cfg.deviceId ?? '')) {
    // Settings from connector 0.2 have no identity: made once here (sent only once it is saved, so it cannot change)
    cfg = { ...cfg, deviceId: newDeviceId() }
    try { saveConfig(cfg, path) } catch { cfg = { ...cfg, deviceId: undefined } }
  }
  const tally = await checkTally(cfg.tally)
  const r = await postJson(`${cfg.server}/api/tally-connector/heartbeat`, {
    version: VERSION,
    platform: osPlatform(),
    ...(cfg.deviceId ? { deviceId: cfg.deviceId } : {}),
    deviceName: deviceName(),
    tally: { status: tally.status, latencyMs: tally.latencyMs, endpoint: tally.endpoint },
  }, cfg.token)
  if (r.status === 401 && r.json?.error?.code === 'CONNECTOR_REVOKED') {
    forgetConfig(path) // disconnected in ManuFlow: the token is useless now
    return { ok: false, revoked: true, nextSec: 0, tally }
  }
  if (r.status === 401 && r.json?.error?.code === 'CONNECTOR_TOKEN_EXPIRED') {
    return { ok: false, tally, error: 'this connector was offline too long and must be paired again (the token was kept; run pair with a new code)' }
  }
  if (r.status === 401 && r.json?.error?.code === 'CONNECTOR_DEVICE_MISMATCH') {
    return { ok: false, tally, error: 'ManuFlow knows this token from another computer (were the settings copied?): pair this computer with its own code (the token was kept)' }
  }
  // Anything else that is not a proper answer: keep the token and try again later
  if (r.status === 401) return { ok: false, tally, error: 'ManuFlow did not accept the token (kept; if this goes on, pair the connector again)' }
  const data = r.json?.data
  if (r.status !== 200 || !data || typeof data !== 'object') return { ok: false, tally, error: r.json?.error?.message || `HTTP ${r.status}` }
  let token = cfg.token
  if (typeof data.newToken === 'string' && TOKEN_RE.test(data.newToken)) {
    try {
      saveConfig({ ...cfg, token: data.newToken, rotatedAt: new Date().toISOString() }, path)
      token = data.newToken
    } catch {
      // the old token stays saved; ManuFlow still accepts it and hands out a new one at the next contact
    }
  }
  const notice = typeof data.minVersion === 'string' && olderThan(VERSION, data.minVersion)
    ? `this connector (${VERSION}) is too old for this ManuFlow: install version ${data.minVersion} or newer`
    : typeof data.latestVersion === 'string' && olderThan(VERSION, data.latestVersion) ? `a newer connector (${data.latestVersion}) is available` : undefined
  const next = Number(data.nextHeartbeatSec)
  const job = data.job
  let jobDone
  if (job && typeof job.id === 'string') {
    const out = JOBS[job.type] ? await runJob(cfg.tally, job) : { ok: false, error: 'tally_error' }
    let payload = JSON.stringify({ jobId: job.id, ...out })
    if (Buffer.byteLength(payload) > MAX_RESULT_BYTES) payload = JSON.stringify({ jobId: job.id, ok: false, error: 'too_large' })
    await postJson(`${cfg.server}/api/tally-connector/result`, JSON.parse(payload), token)
    jobDone = { type: job.type, ok: out.ok, count: out.ok ? out.records.length : 0, error: out.ok ? undefined : out.error }
  }
  return { ok: true, nextSec: Number.isFinite(next) ? Math.min(300, Math.max(5, next)) : 30, tally, job: jobDone, notice }
}

/** A line is written when the state changes, for every job, and otherwise at most hourly (a small log over months). */
const SAME_LINE_EVERY_MS = 60 * 60 * 1000

export async function runLoop({ path = configPath(), log = console.log, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), maxBeats = Infinity, lock = false } = {}) {
  let backoff = 15
  let lastLine = ''
  let lastAt = 0
  const say = (line, always = false) => {
    const t = Date.now()
    if (!always) {
      if (line === lastLine && t - lastAt < SAME_LINE_EVERY_MS) return
      lastLine = line
      lastAt = t
    }
    log(`${new Date(t).toISOString()} ${line}`)
  }
  for (let i = 0; i < maxBeats; i++) {
    if (lock) touchLock(path)
    const cfg = loadConfig(path)
    if (!cfg) { log('Not paired. Run: pair --server <ManuFlow address> --code <code from ManuFlow>'); return 2 }
    let wait
    try {
      const r = await heartbeatOnce(cfg, path)
      if (r.revoked) { log('This connector was disconnected in ManuFlow. Its token was deleted; pair again to reconnect.'); return 2 }
      say(`Tally: ${r.tally.status}${r.ok ? '' : ` · ManuFlow: ${r.error} — retrying in ${backoff} s`}`)
      if (r.job) say(`${r.job.type}: ${r.job.ok ? `${r.job.count} records sent` : r.job.error}`, true)
      if (r.notice) say(r.notice)
      if (r.ok) {
        wait = r.nextSec
        backoff = 15
      } else {
        wait = backoff
        backoff = Math.min(300, backoff * 2)
      }
    } catch (e) {
      say(e?.code === 'TLS_CHECKS_OFF' ? `${e.message} — retrying in ${backoff} s`
        : `Cannot reach ManuFlow (${e?.name === 'AbortError' ? 'timeout' : 'network error'}) — retrying in ${backoff} s`)
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

const USAGE = 'Commands: check [--tally <url>] [--server <url>] | pair --server <url> (--code <code> | --code-stdin) [--tally http://127.0.0.1:9000] | ' +
  'run [--log-file <file>] | set-tally --tally <url> | status | version | forget | capture --tally <url> --out <folder> [--company <name>] ' +
  '(all but capture: [--config <settings file>])'

/** io.stdin: how --code-stdin reads the code (standard input; replaced in tests). */
export async function main(argv = process.argv.slice(2), log = console.log, io = { stdin: () => readFileSync(0, 'utf8') }) {
  const cmd = argv[0]
  const path = arg(argv, 'config') ? resolve(arg(argv, 'config')) : configPath()
  if (cmd === 'check') {
    const cfg = loadConfig(path)
    const r = await checkTally(arg(argv, 'tally') || cfg?.tally || TALLY_DEFAULT_URL)
    log(`Tally: ${r.status}${r.endpoint ? ` at ${r.endpoint}` : ''}${r.latencyMs != null ? ` (${r.latencyMs} ms)` : ''}${r.message ? ` — ${r.message}` : ''}`)
    const server = arg(argv, 'server') || cfg?.server
    let serverOk = true
    if (server) {
      const p = await pingServer(server)
      log(`ManuFlow: ${p.message}`)
      serverOk = p.ok
    }
    return r.status === 'connected' && serverOk ? 0 : 1
  }
  if (cmd === 'version') {
    log(`ManuFlow Tally Connector ${VERSION} (Node.js ${process.versions.node}) — reads TallyPrime with Export requests only`)
    return 0
  }
  if (cmd === 'pair') {
    try {
      // --code-stdin keeps the one-time code out of the command line (and the Windows process list / history)
      const code = argv.includes('--code-stdin') ? String(io.stdin()).trim().split(/\r?\n/)[0] : arg(argv, 'code')
      await pair({ server: arg(argv, 'server'), code, tally: arg(argv, 'tally') || TALLY_DEFAULT_URL, path })
      log(`Paired. Settings saved in ${path}. Start it with: run`)
      return 0
    } catch (e) {
      log(`Pairing failed: ${e.message}`)
      return 1
    }
  }
  if (cmd === 'run') {
    const logFile = arg(argv, 'log-file')
    const out = logFile ? fileLogger(resolve(logFile), log) : log
    if (!acquireLock(path)) {
      out(`${new Date().toISOString()} Another copy of the connector is already running with these settings; this one stops.`)
      return 3
    }
    const release = () => releaseLock(path)
    process.once('exit', release)
    for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => process.exit(0))
    out(`${new Date().toISOString()} ManuFlow Tally Connector ${VERSION} started`)
    try {
      return await runLoop({ path, log: out, lock: true })
    } finally {
      release()
    }
  }
  if (cmd === 'set-tally') {
    const c = loadConfig(path)
    if (!c) { log('Not paired yet: give the Tally address to pair with --tally'); return 1 }
    const t = validateTallyUrl(arg(argv, 'tally'))
    if (t.error) { log(t.error); return 1 }
    saveConfig({ ...c, tally: t.url }, path)
    log(`Tally address set to ${t.endpoint}. A running connector uses it from its next check; no restart or new pairing is needed.`)
    return 0
  }
  if (cmd === 'status') {
    const c = loadConfig(path)
    // never the token: the server, the Tally address, when it was paired, and a short form of the device id
    log(c
      ? `Connector ${VERSION} · paired with ${c.server} on ${c.pairedAt} · device ${String(c.deviceId ?? 'not set yet').slice(0, 8)}… · Tally address ${c.tally} · settings ${path}`
      : `Connector ${VERSION} · not paired (settings ${path})`)
    return 0
  }
  if (cmd === 'forget') {
    forgetConfig(path)
    log('Connector settings deleted. Also click "Disconnect" in ManuFlow if this computer is lost or replaced.')
    return 0
  }
  if (cmd === 'capture') {
    try {
      // The Tally address must be given: capture never uses the saved settings or token
      await capture({ tally: arg(argv, 'tally'), out: arg(argv, 'out'), company: arg(argv, 'company'), from: arg(argv, 'vouchers-from'), to: arg(argv, 'vouchers-to'), dayBook: argv.includes('--daybook'), log })
      return 0
    } catch (e) {
      log(`Capture stopped: ${e.message}`)
      return 1
    }
  }
  log(USAGE)
  return 1
}

const EXIT_GRACE_MS = 10_000

/**
 * Ends the program with `code` without calling process.exit() at once. On Windows, Node.js 23 and newer can abort
 * with "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c" when process.exit() runs just
 * after a network request (nodejs/node#56645): `check` then crashes after printing its result, and `pair` reports failure
 * although the pairing was saved. Node ends by itself once nothing is left to do (idle fetch connections do not keep
 * it running); the timer is only a safety net, is unref'd, and so never keeps the program alive.
 */
export function finish(code, proc = process, graceMs = EXIT_GRACE_MS) {
  proc.exitCode = code
  const t = setTimeout(() => proc.exit(code), graceMs)
  t.unref()
  return t
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then(finish, (e) => {
    console.error(`Stopped: ${e?.message ?? e}`)
    finish(1)
  })
}
