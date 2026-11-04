#!/usr/bin/env node
/**
 * Turns raw Tally replies (saved by `manuflow-tally-connector.mjs capture`) into anonymised test fixtures.
 * Plan and review steps: docs/tally-real-validation-plan.md.
 *
 *   node scripts/tally-fixtures/anonymise.mjs <capture folder> <output folder>
 *
 *  - Every value that identifies a business is replaced: names (ledgers, items, groups the company created, the
 *    company, godowns), GSTIN, PAN, phone, e-mail, address, contact person, pincode, narration, bank details, GUIDs
 *    and voucher keys, voucher numbers / references / bill names (one shared mapping, so bills still match invoices).
 *    Kept on purpose: amounts, quantities, rates and dates (needed to reconcile; decided with the data owner) and generic
 *    account names such as CGST / IGST / Round Off / Sales / Cash.
 *    The same original value gets the same fake value in every file of the folder (so names still match across files).
 *    Fakes come from counters, never from a hash of the original (a hash of a GSTIN could be reversed by trying them all).
 *  - Kept as they are: tags, attributes other than NAME, nesting, Tally's own group names (Sundry Debtors, …), units,
 *    HSN codes, GST rates, dates, the encoding (UTF-8, or UTF-16 with or without a byte-order mark).
 *  - The original → fake map stays in memory; nothing about the originals is written or printed.
 *  - The output is checked before the script reports success: no original value left, every GSTIN / PAN / e-mail /
 *    10-digit phone number is a generated fake, and the tag structure is identical to the input. Any failure → exit 1
 *    and the output folder is removed.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Tally's predefined groups and other built-in names: not business data, and tests need them as they are
const TALLY_NAMES = new Set([
  'Primary', 'Bank Accounts', 'Bank OD A/c', 'Branch / Divisions', 'Capital Account', 'Cash-in-Hand', 'Current Assets',
  'Current Liabilities', 'Deposits (Asset)', 'Direct Expenses', 'Direct Incomes', 'Duties &amp; Taxes', 'Fixed Assets',
  'Indirect Expenses', 'Indirect Incomes', 'Investments', 'Loans &amp; Advances (Asset)', 'Loans (Liability)',
  'Misc. Expenses (ASSET)', 'Provisions', 'Purchase Accounts', 'Reserves &amp; Surplus', 'Sales Accounts', 'Secured Loans',
  'Stock-in-Hand', 'Sundry Creditors', 'Sundry Debtors', 'Suspense A/c', 'Unsecured Loans', 'Profit &amp; Loss A/c',
  'Main Location', 'Not Applicable', 'Any',
])

// Generic account names that identify no business (tax, round-off, sales / purchase, cash): kept so GST and
// reconciliation tests can still recognise them
const GENERIC_LEDGER = /^(?:(?:input|output)\s*)?(?:c|s|i|ut)gst(?:\s*@?\s*\d+(?:\.\d+)?\s*%?)?$|^(?:state\s*)?cess$|^round(?:ing)?\s*off$|^(?:sales|purchase)(?:\s+(?:accounts?|a\/c|gst|local|inter-?state|igst|@\s*\d+(?:\.\d+)?\s*%))*$|^cash$/i

// Tally names a GST tax unit "<State> Registration" by default: kept only when it is exactly that (a state, not a business)
const STATES = new Set(['Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh', 'Goa', 'Gujarat', 'Haryana', 'Himachal Pradesh',
  'Jharkhand', 'Karnataka', 'Kerala', 'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha', 'Punjab',
  'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura', 'Uttar Pradesh', 'Uttarakhand', 'West Bengal', 'Andaman and Nicobar Islands',
  'Andaman & Nicobar Islands', 'Chandigarh', 'Dadra and Nagar Haveli and Daman and Diu', 'Dadra & Nagar Haveli and Daman & Diu', 'Delhi',
  'Jammu and Kashmir', 'Jammu & Kashmir', 'Ladakh', 'Lakshadweep', 'Puducherry'])
const isStateTaxUnit = (v) => { const m = /^(.+) Registration$/.exec(v.trim()); return !!m && STATES.has(m[1].replace(/&amp;/g, '&')) }

/** Tag → kind of value. Text of these elements is replaced. */
const TEXT_TAGS = {
  NAME: 'name', PARENT: 'name', MAILINGNAME: 'name', LEDGERNAME: 'name', PARTYNAME: 'name', PARTYLEDGERNAME: 'name',
  PARTYMAILINGNAME: 'name', BASICBUYERNAME: 'name', STOCKITEMNAME: 'name', COMPANYNAME: 'name', CATEGORY: 'name',
  // seen in a real Day Book reply (2026-11-03): the company and the party again, and the buyer's address
  SVCURRENTCOMPANY: 'name', REMOTECMPNAME: 'name', BASICBASEPARTYNAME: 'name', CONSIGNEENAME: 'name', BASICBUYERADDRESS: 'address',
  GSTREGISTRATION: 'taxunit', VCHSTATUSTAXUNIT: 'taxunit',
  LEDGERCONTACT: 'person', ADDRESS: 'address', EMAIL: 'email', EMAILCC: 'email', WEBSITE: 'website',
  LEDGERPHONE: 'phone', LEDGERMOBILE: 'phone', LEDGERFAX: 'phone', PINCODE: 'pincode',
  PARTYGSTIN: 'gstin', GSTIN: 'gstin', INCOMETAXNUMBER: 'pan', PANNUMBER: 'pan',
  NARRATION: 'text', VOUCHERNUMBER: 'ref', REFERENCE: 'ref', BATCHNAME: 'ref', GODOWNNAME: 'name', DESTINATIONGODOWNNAME: 'name',
  BUYERADDRESS: 'address', CONSIGNEEMAILINGNAME: 'name', CONSIGNEEGSTIN: 'gstin', CONSIGNEEPINCODE: 'pincode', CONSIGNEECONTACT: 'person', BANKNAME: 'text', BRANCHNAME: 'text', ACCOUNTNUMBER: 'account', IFSCODE: 'ifsc', BANKACCHOLDERNAME: 'person',
  GUID: 'guid', REMOTEID: 'guid', MASTERID: 'keep', ALTERID: 'keep',
}

const GSTIN_RE = /\b\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/g
const PAN_RE = /\b[A-Z]{5}\d{4}[A-Z]\b/g
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
const PHONE_RE = /(?<!\d)[6-9]\d{9}(?!\d)/g

// ---------------------------------------------------------------- encoding (same rules as the connector)

function decode(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return { text: new TextDecoder('utf-16le').decode(buf.subarray(2)), enc: 'utf16le-bom' }
  if (buf[0] === 0xfe && buf[1] === 0xff) return { text: new TextDecoder('utf-16be').decode(buf.subarray(2)), enc: 'utf16be-bom' }
  if (buf[0] === 0x3c && buf[1] === 0) return { text: new TextDecoder('utf-16le').decode(buf), enc: 'utf16le' }
  if (buf[0] === 0 && buf[1] === 0x3c) return { text: new TextDecoder('utf-16be').decode(buf), enc: 'utf16be' }
  return { text: new TextDecoder('utf-8').decode(buf), enc: 'utf8' }
}

function encode(text, enc) {
  const le = Buffer.from(text, 'utf16le')
  const be = () => { const b = Buffer.from(le); b.swap16(); return b }
  if (enc === 'utf16le-bom') return Buffer.concat([Buffer.from([0xff, 0xfe]), le])
  if (enc === 'utf16be-bom') return Buffer.concat([Buffer.from([0xfe, 0xff]), be()])
  if (enc === 'utf16le') return le
  if (enc === 'utf16be') return be()
  return Buffer.from(text, 'utf8')
}

// ---------------------------------------------------------------- consistent fakes

export function makeFaker() {
  const maps = new Map() // kind → Map(original → fake)
  const counters = new Map()
  const next = (kind) => { const n = (counters.get(kind) ?? 0) + 1; counters.set(kind, n); return n }
  const pad = (n, w) => String(n).padStart(w, '0')
  const letters = (n) => { let s = ''; for (let i = 0; i < 5; i++) { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) } return s }
  const make = {
    name: (_, n) => `Name ${pad(n, 4)}`,
    person: (_, n) => `Person ${pad(n, 4)}`,
    address: (_, n) => `Address line ${pad(n, 4)}`,
    text: (_, n) => `Text ${pad(n, 4)}`,
    email: (_, n) => `contact${pad(n, 4)}@example.test`,
    website: (_, n) => `www.example${pad(n, 4)}.test`,
    phone: (_, n) => `90000${pad(n, 5)}`,
    pincode: (v, n) => (/^\d{6}$/.test(v) ? `${v.slice(0, 2)}${pad(n % 10000, 4)}` : `99${pad(n, 4)}`), // keeps the postal circle
    pan: (_, n) => `ZZ${letters(n).slice(2)}${pad(n % 10000, 4)}Z`,
    // keeps the GST state code (it decides intra- vs inter-state tax); everything else is fake
    gstin: (v, n) => `${/^\d{2}/.test(v) ? v.slice(0, 2) : '99'}ZZ${letters(n).slice(2)}${pad(n % 10000, 4)}Z1Z${n % 10}`,
    account: (_, n) => `0000${pad(n, 8)}`,
    // voucher numbers, references and bill names share this kind, so a bill still points at its invoice
    ref: (_, n) => `REF-${pad(n, 4)}`,
    taxunit: (_, n) => `Tax Unit ${pad(n, 4)}`,
    ifsc: (_, n) => `ZZZZ0${pad(n, 6)}`,
    // a Tally GUID is "<uuid>-<object number>": the uuid part is replaced, the object number kept
    guid: (v, n) => {
      const m = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(.*)$/i.exec(v)
      return m ? `00000000-0000-4000-8000-${pad(n, 12)}${m[2]}` : `guid-${pad(n, 8)}`
    },
  }
  return {
    fake(kind, value) {
      // Tally writes its built-in names with a control character in front ("&#4; Primary")
      if (kind === 'name' && TALLY_NAMES.has(value.replace(/^(&#4;|\u0004)\s*/, ''))) return value
      if (kind === 'name' && GENERIC_LEDGER.test(value.trim())) return value
      if (kind === 'taxunit' && isStateTaxUnit(value)) return value
      if (/^REF-\d{4}$/.test(value)) return value // already replaced (a bill name, see anonymiseText)
      if (!maps.has(kind)) maps.set(kind, new Map())
      const m = maps.get(kind)
      if (!m.has(value)) m.set(value, make[kind](value, next(kind)))
      return m.get(value)
    },
    /** Originals that must not appear in the output (short ones and pure numbers are too ambiguous to search for). */
    originals() {
      const out = []
      for (const [kind, m] of maps) for (const [orig, fake] of m) if (orig !== fake && orig.trim().length >= 4 && !/^\d{1,5}$/.test(orig.trim())) out.push({ kind, orig })
      return out
    },
    fakes(kind) { return new Set(maps.get(kind)?.values() ?? []) },
    counts() { return Object.fromEntries([...maps].map(([k, m]) => [k, m.size])) },
  }
}

// ---------------------------------------------------------------- one document

export function anonymiseText(text, faker) {
  // NAME="…" attributes (company, ledger, item, group names); voucher keys in VCHKEY / REMOTEID attributes
  let out = text.replace(/(\sNAME=")([^"]*)(")/g, (_, a, v, b) => a + faker.fake('name', v) + b)
  out = out.replace(/(\s(?:VCHKEY|REMOTEID)=")([^"]+)(")/g, (_, a, v, b) => a + faker.fake('guid', v) + b)
  // a GSTIN can sit in the TAXREGISTRATION attribute of a GST registration
  out = out.replace(/(\sTAXREGISTRATION=")([^"]+)(")/g, (_, a, v, b) => a + faker.fake('gstin', v) + b)
  // bill names inside bill allocations are references (often the invoice number), not names
  out = out.replace(/<BILLALLOCATIONS\.LIST>[\s\S]*?<\/BILLALLOCATIONS\.LIST>/g, (block) =>
    block.replace(/<NAME>([^<]+)<\/NAME>/g, (whole, v) => (v.trim() ? `<NAME>${faker.fake('ref', v.trim())}</NAME>` : whole)))
  // element text of the sensitive tags (simple text content only; nested elements are reached on their own)
  out = out.replace(/<([A-Z][A-Z0-9.]*)((?:\s[^<>]*)?)>([^<]+)<\/\1>/g, (whole, tag, attrs, value) => {
    const kind = TEXT_TAGS[tag]
    if (!kind || kind === 'keep' || !value.trim()) return whole
    const lead = value.match(/^\s*/)[0]
    const trail = value.match(/\s*$/)[0]
    return `<${tag}${attrs}>${lead}${faker.fake(kind, value.trim())}${trail}</${tag}>`
  })
  return out
}

const tagSequence = (s) => (s.match(/<\/?[A-Za-z][A-Za-z0-9.:_-]*/g) ?? []).join(' ')

/** What is still in the output that should not be: originals, and patterns that are not generated fakes. */
export function leaks(text, faker) {
  const found = []
  const lower = text.toLowerCase()
  for (const { kind, orig } of faker.originals()) if (lower.includes(orig.toLowerCase())) found.push(`original ${kind} value still present`)
  const allowed = { gstin: faker.fakes('gstin'), pan: faker.fakes('pan'), email: faker.fakes('email'), phone: faker.fakes('phone') }
  for (const g of text.match(GSTIN_RE) ?? []) if (!allowed.gstin.has(g)) found.push('a GSTIN that is not a generated fake')
  for (const p of text.match(PAN_RE) ?? []) if (!allowed.pan.has(p) && ![...allowed.gstin].some((g) => g.includes(p))) found.push('a PAN that is not a generated fake')
  for (const e of text.match(EMAIL_RE) ?? []) if (!allowed.email.has(e) && !e.endsWith('.test')) found.push('an e-mail address that is not a generated fake')
  for (const p of text.match(PHONE_RE) ?? []) if (!allowed.phone.has(p)) found.push('a phone number that is not a generated fake')
  return found
}

// ---------------------------------------------------------------- folder

export function anonymiseFolder(input, output, log = console.log) {
  if (!existsSync(input)) throw new Error('The capture folder does not exist')
  if (existsSync(output) && readdirSync(output).length) throw new Error('The output folder must be new or empty')
  const files = readdirSync(input).filter((f) => f.endsWith('.xml')).sort()
  if (!files.length) throw new Error('No .xml files in the capture folder')
  const faker = makeFaker()
  const docs = files.map((f) => {
    const { text, enc } = decode(readFileSync(join(input, f)))
    return { f, enc, text, out: anonymiseText(text, faker) }
  })
  // Checked only after every file is done: a value replaced in one file must not survive in another
  const problems = []
  for (const d of docs) {
    if (tagSequence(d.text) !== tagSequence(d.out)) problems.push(`${d.f}: the tag structure changed`)
    for (const l of new Set(leaks(d.out, faker))) problems.push(`${d.f}: ${l}`)
  }
  if (problems.length) {
    for (const p of problems) log(`FAILED ${p}`)
    throw new Error(`Not anonymised safely (${problems.length} problem(s)); nothing was written`)
  }
  mkdirSync(output, { recursive: true, mode: 0o700 })
  for (const d of docs) writeFileSync(join(output, d.f), encode(d.out, d.enc), { mode: 0o600 })
  log(`Anonymised ${docs.length} file(s) into ${output}`)
  for (const d of docs) log(`  ${d.f}: ${d.enc}, tag structure identical`)
  log(`Values replaced, by kind: ${JSON.stringify(faker.counts())}`)
  log('Leak check: no original value, GSTIN, PAN, e-mail or phone number left.')
  return { files: docs.map((d) => d.f), counts: faker.counts() }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [input, output] = process.argv.slice(2)
  if (!input || !output) {
    console.log('Usage: node scripts/tally-fixtures/anonymise.mjs <capture folder> <output folder>')
    process.exit(1)
  }
  try {
    anonymiseFolder(input, output)
  } catch (e) {
    if (existsSync(output) && !readdirSync(output).length) rmSync(output, { recursive: true, force: true })
    console.log(e.message)
    process.exit(1)
  }
}
