import { IMPORT_CHECK_HEADER } from '@/lib/import/apply-mapping'
import { tableFromRecords, type RecordTable } from '@/lib/import/structured'
import { all, at, kids, parseXml, textAt, type XmlNode } from '@/lib/import/xml'
import { amountToPaise } from '@/lib/tally/layer1'
import { normaliseVoucher, parseQty, parseRate, type NormalisedVoucher, type TallyLedgerEntry, type TallyVoucherRecord } from '@/lib/tally/vouchers'

/**
 * Tally XML files (exported from TallyPrime / Tally.ERP 9) — kept apart from the generic XML reader.
 *
 * Layouts read: ENVELOPE/BODY/IMPORTDATA/REQUESTDATA/TALLYMESSAGE/<object> (Tally's export for import elsewhere, as in a
 * master.xml / voucher.xml), ENVELOPE/BODY/DATA/TALLYMESSAGE/<object> (report exports such as the Day Book) and
 * ENVELOPE/BODY/DATA/COLLECTION/<object> (collection exports). The file is only READ: an ACTION="Create" / "Cancel"
 * attribute in it is reported, never carried out, and nothing is ever sent to Tally.
 *
 * Masters → tables for the Import Center:
 *   - parties: ledgers under Sundry Debtors / Sundry Creditors (sub-groups followed through the groups in the file);
 *   - stock items: name, unit, HSN, GST rate (the latest GST details; IGST rate), stock group, opening stock;
 *   - opening stock: one row per opening batch / godown allocation of a stock item.
 * Vouchers → a check only (tallyVoucherCheck): every voucher keeps its header, ledger lines with their bill
 * allocations, and inventory lines with their batch and accounting allocations (normaliseVoucher, the same rules as
 * the connector's Layer 1). Vouchers are not imported into ManuFlow's books.
 *
 * Tally's conventions used: a built-in name carries a leading &#4; marker (removed); a negative amount is a debit; an
 * opening balance "-1,000.00" is therefore "1,000.00 Dr".
 */

export interface TallyFile {
  layout: 'import' | 'data' | 'collection'
  company: string | null
  objectCounts: Record<string, number>
  tables: RecordTable[]
  vouchers: TallyVoucherCheck | null
}

export const TALLY_TABLE = {
  debtors: 'Sundry Debtors ledgers (customers)',
  creditors: 'Sundry Creditors ledgers (suppliers)',
  items: 'Stock items',
  openingStock: 'Stock items — opening stock',
} as const

/** Which Tally table fits each Import Center data type (the user can still pick another). */
export const TALLY_TABLE_FOR: Record<string, string> = {
  customers: TALLY_TABLE.debtors, suppliers: TALLY_TABLE.creditors, 'opening-balances': TALLY_TABLE.debtors,
  items: TALLY_TABLE.items, 'opening-stock': TALLY_TABLE.openingStock,
}

const clean = (s: string | undefined) => (s ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim()
const nameOf = (n: XmlNode) => clean(n.attrs.NAME) || clean(textAt(n, 'NAME')) || clean(textAt(n, 'LANGUAGENAME.LIST', 'NAME.LIST', 'NAME'))
const t = (n: XmlNode, ...path: string[]) => clean(textAt(n, ...path))
const firstOf = (...v: string[]) => v.find((x) => x) ?? ''

/** Is this an ENVELOPE from Tally? (checked on the first characters, before a full parse) */
export function looksLikeTally(text: string): boolean {
  const head = text.slice(0, 4096)
  return /^\s*(<\?xml[^>]*\?>\s*)?<ENVELOPE[\s>]/i.test(head) && /<(TALLYMESSAGE|TALLYREQUEST|IMPORTDATA|COLLECTION)[\s>]/i.test(text.slice(0, 200_000))
}

function tallyObjects(env: XmlNode): { layout: TallyFile['layout']; objects: XmlNode[]; company: string | null } {
  const body = at(env, 'BODY')
  const imp = at(body, 'IMPORTDATA')
  if (imp) {
    return {
      layout: 'import',
      objects: all(imp, 'REQUESTDATA', 'TALLYMESSAGE').flatMap((m) => m.children),
      company: t(imp, 'REQUESTDESC', 'STATICVARIABLES', 'SVCURRENTCOMPANY') || null,
    }
  }
  const data = at(body, 'DATA')
  const coll = at(data, 'COLLECTION')
  if (coll) return { layout: 'collection', objects: coll.children, company: null }
  return { layout: 'data', objects: kids(data, 'TALLYMESSAGE').flatMap((m) => m.children), company: null }
}

export function readTallyXml(text: string): TallyFile {
  const env = parseXml(text)
  if (env.name !== 'ENVELOPE') throw new Error('not a Tally envelope')
  const { layout, objects, company } = tallyObjects(env)
  const objectCounts: Record<string, number> = {}
  for (const o of objects) objectCounts[o.name] = (objectCounts[o.name] ?? 0) + 1
  const of = (name: string) => objects.filter((o) => o.name === name)

  const tables: RecordTable[] = []
  const ledgers = of('LEDGER')
  if (ledgers.length) {
    const parents = new Map(of('GROUP').map((g) => [nameOf(g), t(g, 'PARENT')]))
    const under = (group: string, target: string) => {
      const seen = new Set<string>()
      for (let g = group; g && !seen.has(g); g = parents.get(g) ?? '') {
        if (g.toLowerCase() === target) return true
        seen.add(g)
      }
      return false
    }
    const debtors = ledgers.filter((l) => under(t(l, 'PARENT'), 'sundry debtors'))
    const creditors = ledgers.filter((l) => under(t(l, 'PARENT'), 'sundry creditors'))
    const notes = parents.size ? [] : ['The file has no ledger groups: only ledgers directly under Sundry Debtors / Sundry Creditors are recognised as parties.']
    tables.push(tableFromRecords(TALLY_TABLE.debtors, debtors.map(partyRecord), notes))
    tables.push(tableFromRecords(TALLY_TABLE.creditors, creditors.map(partyRecord), notes))
  }
  const items = of('STOCKITEM')
  if (items.length) {
    tables.push(tableFromRecords(TALLY_TABLE.items, items.map(itemRecord)))
    tables.push(tableFromRecords(TALLY_TABLE.openingStock, items.flatMap(openingStockRecords), [
      'Tally writes stock values as debits (with a minus sign); they are shown here as positive values.',
    ]))
  }
  const vouchers = of('VOUCHER')
  return { layout, company, objectCounts, tables, vouchers: vouchers.length ? tallyVoucherCheck(vouchers) : null }
}

// ---------------------------------------------------------------- masters

/** "-1234.5" → "1,234.50 Dr"; "500" → "500.00 Cr"; anything else is kept as Tally wrote it. */
function drCr(raw: string): string {
  const p = raw ? amountToPaise(raw) : null
  if (p === null) return raw
  if (p === 0) return ''
  const abs = Math.abs(p)
  return `${(abs / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${p < 0 ? 'Dr' : 'Cr'}`
}

/** The newest entry of a dated list (APPLICABLEFROM / DATE as YYYYMMDD), or the last one. */
function latest(list: XmlNode[]): XmlNode | undefined {
  return [...list].sort((a, b) => (t(a, 'APPLICABLEFROM') || t(a, 'DATE')).localeCompare(t(b, 'APPLICABLEFROM') || t(b, 'DATE'))).pop()
}

/** Tally's registration types in the words the import understands; anything else is left blank (decided from the GSTIN). */
const GST_TYPE: Record<string, string> = {
  regular: 'Regular', composition: 'Composition', 'unregistered/consumer': 'Unregistered', unregistered: 'Unregistered', consumer: 'Consumer',
  overseas: 'Overseas', sez: 'SEZ', 'regular - sez': 'SEZ',
}
const gstType = (s: string) => GST_TYPE[s.trim().toLowerCase()] ?? ''

const REGISTERED = new Set(['Regular', 'Composition', 'SEZ'])

/**
 * GSTIN and registration type of a party, both from ONE source: the latest dated GST registration
 * (LEDGSTREGDETAILS.LIST, TallyPrime 3+) when the ledger has any, else the ledger's own fields (older Tally).
 * Conflicts are not resolved by guessing: both values are left blank and the problem is reported, which makes the row
 * an error in the preview (Import check column) until it is corrected in Tally.
 */
export function partyGst(l: XmlNode): { gstin: string; type: string; problem: string } {
  const own = { gstin: t(l, 'PARTYGSTIN').toUpperCase(), type: t(l, 'GSTREGISTRATIONTYPE') }
  const regs = all(l, 'LEDGSTREGDETAILS.LIST')
  const problems: string[] = []
  let src = own
  if (regs.length) {
    const reg = latest(regs)!
    src = { gstin: t(reg, 'GSTIN').toUpperCase(), type: t(reg, 'GSTREGISTRATIONTYPE') }
    const date = t(reg, 'APPLICABLEFROM')
    const sameDay = regs.filter((r) => t(r, 'APPLICABLEFROM') === date)
    if (new Set(sameDay.map((r) => `${t(r, 'GSTIN').toUpperCase()}|${t(r, 'GSTREGISTRATIONTYPE')}`)).size > 1) problems.push(`two different GST registrations apply from the same date${date ? ` (${date})` : ''}`)
    if (own.gstin && own.gstin !== src.gstin) problems.push(`the ledger's GSTIN ${own.gstin} differs from its latest GST registration (${src.gstin || 'no GSTIN'})`)
  }
  const type = gstType(src.type)
  if (src.gstin && (type === 'Unregistered' || type === 'Consumer')) problems.push(`GSTIN ${src.gstin} is given but the registration type is ${src.type}`)
  if (!src.gstin && REGISTERED.has(type)) problems.push(`the registration type is ${src.type} but there is no GSTIN`)
  if (problems.length) return { gstin: '', type: '', problem: `Tally GST data does not agree: ${problems.join('; ')} — correct it in Tally and export again` }
  return { gstin: src.gstin, type, problem: '' }
}

function partyRecord(l: XmlNode): Map<string, string> {
  const gst = partyGst(l)
  const mail = latest(all(l, 'LEDMAILINGDETAILS.LIST'))
  const address = firstOf(
    all(l, 'ADDRESS.LIST', 'ADDRESS').map((a) => clean(a.text)).filter(Boolean).join(', '),
    mail ? all(mail, 'ADDRESS.LIST', 'ADDRESS').map((a) => clean(a.text)).filter(Boolean).join(', ') : '',
  )
  return new Map([
    ['Party Name', nameOf(l)],
    ['GSTIN', gst.gstin],
    ['GST Registration Type', gst.type],
    ['PAN', t(l, 'INCOMETAXNUMBER')],
    ['Contact Person', t(l, 'LEDGERCONTACT')],
    ['Phone', firstOf(t(l, 'LEDGERMOBILE'), t(l, 'LEDGERPHONE'))],
    ['Email', t(l, 'EMAIL')],
    ['Address', address],
    ['State', firstOf(t(l, 'LEDSTATENAME'), mail ? t(mail, 'STATE') : '')],
    ['Pincode', firstOf(t(l, 'PINCODE'), mail ? t(mail, 'PINCODE') : '')],
    ['Opening Balance', drCr(t(l, 'OPENINGBALANCE'))],
    ['Tally Parent Group', t(l, 'PARENT')],
    ['Tally GUID', t(l, 'GUID')],
    [IMPORT_CHECK_HEADER, gst.problem],
  ])
}

/** GST rate of a stock item: the IGST rate in its latest GST details (blank when Tally has none — never guessed). */
function itemGst(i: XmlNode): { hsn: string; rate: string } {
  const g = latest(all(i, 'GSTDETAILS.LIST'))
  const hsnList = latest(all(i, 'HSNDETAILS.LIST'))
  const hsn = firstOf(g ? t(g, 'HSNCODE') : '', hsnList ? t(hsnList, 'HSNCODE') : '', t(i, 'HSNCODE'))
  let rate = ''
  for (const r of g ? all(g, 'STATEWISEDETAILS.LIST', 'RATEDETAILS.LIST') : []) {
    const head = t(r, 'GSTRATEDUTYHEAD').toLowerCase()
    if (head === 'igst' || head === 'integrated tax') { rate = t(r, 'GSTRATE'); break }
  }
  return { hsn, rate: /^\d+(\.\d+)?$/.test(rate) ? String(Number(rate)) : '' }
}

const qtyNumber = (s: string) => parseQty(s)?.qty ?? ''
const rateNumber = (s: string) => { const r = parseRate(s); return r ? (r.paise / 100).toFixed(2) : '' }
const positiveValue = (s: string) => { const p = s ? amountToPaise(s) : null; return p === null ? '' : (Math.abs(p) / 100).toFixed(2) }
const noRoot = (group: string) => (group.toLowerCase() === 'primary' ? '' : group) // Tally's root group = no group

function itemRecord(i: XmlNode): Map<string, string> {
  const { hsn, rate } = itemGst(i)
  return new Map([
    ['Item Name', nameOf(i)],
    ['Unit', t(i, 'BASEUNITS')],
    ['HSN', hsn],
    ['GST Rate', rate],
    ['Stock Group', noRoot(t(i, 'PARENT'))],
    ['Tally Category', noRoot(t(i, 'CATEGORY'))],
    ['Opening Quantity', qtyNumber(t(i, 'OPENINGBALANCE'))],
    ['Opening Rate', rateNumber(t(i, 'OPENINGRATE'))],
    ['Opening Value', positiveValue(t(i, 'OPENINGVALUE'))],
    ['Tally GUID', t(i, 'GUID')],
  ])
}

function openingStockRecords(i: XmlNode): Map<string, string>[] {
  const batchWise = /^yes$/i.test(t(i, 'ISBATCHWISEON'))
  const row = (qty: string, rate: string, value: string, godown: string, batch: string) => new Map([
    ['Item Name', nameOf(i)], ['Opening Quantity', qtyNumber(qty)], ['Unit', t(i, 'BASEUNITS')], ['Opening Rate', rateNumber(rate)],
    ['Opening Value', positiveValue(value)], ['Godown', godown], ['Batch No', batchWise ? batch : ''], ['Tally GUID', t(i, 'GUID')],
  ])
  const nonZero = (q: string) => { const n = Number(parseQty(q)?.qty ?? 0); return Number.isFinite(n) && n !== 0 }
  const batches = all(i, 'BATCHALLOCATIONS.LIST').filter((b) => nonZero(t(b, 'OPENINGBALANCE')))
  if (batches.length) return batches.map((b) => row(t(b, 'OPENINGBALANCE'), t(b, 'OPENINGRATE') || t(i, 'OPENINGRATE'), t(b, 'OPENINGVALUE'), t(b, 'GODOWNNAME'), t(b, 'BATCHNAME')))
  return nonZero(t(i, 'OPENINGBALANCE')) ? [row(t(i, 'OPENINGBALANCE'), t(i, 'OPENINGRATE'), t(i, 'OPENINGVALUE'), '', '')] : []
}

// ---------------------------------------------------------------- vouchers (check only)

const VOUCHER_LIST_MAX = 200

export interface VoucherView {
  date: string | null
  type: string
  number: string | null
  party: string | null
  /** Tally's ACTION attribute in the file (Create / Cancel / …): reported only, never carried out. */
  action: string | null
  amountPaise: number
  cancelled: boolean
  optional: boolean
  balanced: boolean
  issues: string[]
  ledgerLines: { ledger: string; amountPaise: number; drCr: 'Dr' | 'Cr'; fromItem: boolean; bills: { name: string; type: string | null; amountPaise: number | null }[] }[]
  inventoryLines: { item: string; qty: string | null; unit: string | null; ratePaise: number | null; amountPaise: number | null; batches: { godown: string; batch: string; qty: string }[] }[]
}

export interface TallyVoucherCheck {
  count: number
  from: string | null
  to: string | null
  byType: { type: string; count: number; cancelled: number; optional: number; unbalanced: number; amountPaise: number }[]
  actions: Record<string, number>
  unbalanced: number
  withIssues: number
  ledgerLines: number
  inventoryLines: number
  billAllocations: number
  batchAllocations: number
  /** The first vouchers of the file in full (header, lines, allocations); all of them are counted above. */
  vouchers: VoucherView[]
  shown: number
}

const yesText = (n: XmlNode, tag: string) => t(n, tag)

function ledgerEntry(e: XmlNode): TallyLedgerEntry {
  return {
    ledgerName: t(e, 'LEDGERNAME'), amount: t(e, 'AMOUNT'), isDeemedPositive: yesText(e, 'ISDEEMEDPOSITIVE'), isPartyLedger: yesText(e, 'ISPARTYLEDGER'),
    bills: kids(e, 'BILLALLOCATIONS.LIST')
      .map((b) => ({ name: t(b, 'NAME'), billType: t(b, 'BILLTYPE'), amount: t(b, 'AMOUNT') }))
      .filter((b) => b.name || b.billType || b.amount),
  }
}
const hasContent = (e: XmlNode) => !!(t(e, 'LEDGERNAME') || t(e, 'STOCKITEMNAME') || t(e, 'AMOUNT'))

/** One VOUCHER element → the record the Layer 1 rules take (src/lib/tally/vouchers.ts). */
export function voucherRecord(v: XmlNode): TallyVoucherRecord {
  // Tally writes the accounting lines as LEDGERENTRIES.LIST or ALLLEDGERENTRIES.LIST: the one with content
  const ledgerList = [kids(v, 'ALLLEDGERENTRIES.LIST'), kids(v, 'LEDGERENTRIES.LIST')].find((l) => l.some(hasContent)) ?? []
  const invList = [kids(v, 'ALLINVENTORYENTRIES.LIST'), kids(v, 'INVENTORYENTRIES.LIST')].find((l) => l.some(hasContent)) ?? []
  return {
    guid: t(v, 'GUID'), masterId: t(v, 'MASTERID'), alterId: t(v, 'ALTERID'), date: t(v, 'DATE'), effectiveDate: t(v, 'EFFECTIVEDATE'),
    voucherType: firstOf(t(v, 'VOUCHERTYPENAME'), clean(v.attrs.VCHTYPE)), voucherNumber: t(v, 'VOUCHERNUMBER'), reference: t(v, 'REFERENCE'),
    referenceDate: t(v, 'REFERENCEDATE'), partyLedger: firstOf(t(v, 'PARTYLEDGERNAME'), t(v, 'PARTYNAME')), narration: t(v, 'NARRATION'),
    isCancelled: t(v, 'ISCANCELLED'), isOptional: t(v, 'ISOPTIONAL'), isInvoice: t(v, 'ISINVOICE'),
    extra: Object.fromEntries(Object.entries({
      action: clean(v.attrs.ACTION), placeOfSupply: t(v, 'PLACEOFSUPPLY'), partyGstin: t(v, 'PARTYGSTIN'), gstRegistrationType: t(v, 'GSTREGISTRATIONTYPE'),
    }).filter(([, x]) => x)),
    ledgerEntries: ledgerList.filter(hasContent).map(ledgerEntry),
    inventoryEntries: invList.filter(hasContent).map((e) => ({
      stockItemName: t(e, 'STOCKITEMNAME'), actualQty: t(e, 'ACTUALQTY'), billedQty: t(e, 'BILLEDQTY'), rate: t(e, 'RATE'), amount: t(e, 'AMOUNT'),
      isDeemedPositive: t(e, 'ISDEEMEDPOSITIVE'),
      batches: kids(e, 'BATCHALLOCATIONS.LIST')
        .map((b) => ({ godownName: t(b, 'GODOWNNAME'), batchName: t(b, 'BATCHNAME'), amount: t(b, 'AMOUNT'), actualQty: t(b, 'ACTUALQTY') }))
        .filter((b) => b.godownName || b.batchName || b.amount || b.actualQty),
      accountingAllocations: kids(e, 'ACCOUNTINGALLOCATIONS.LIST').filter(hasContent).map(ledgerEntry),
    })),
  }
}

function view(r: TallyVoucherRecord, n: NormalisedVoucher): VoucherView {
  const action = r.extra?.action || null
  return {
    date: n.header.date, type: n.header.voucherType, number: n.header.voucherNumber, party: n.header.partyLedger, action,
    amountPaise: n.header.sumPositivePaise, cancelled: n.header.isCancelled || /^cancel/i.test(action ?? ''), optional: n.header.isOptional,
    balanced: !n.issues.some((i) => i.code === 'not_balanced'), issues: n.issues.map((i) => i.message),
    ledgerLines: n.lines.map((l) => ({
      ledger: l.ledgerName, amountPaise: l.amountPaise, drCr: l.amountPaise < 0 ? 'Dr' : 'Cr', fromItem: l.source === 'inventory',
      bills: n.bills.filter((b) => b.lineSeq === l.seq).map((b) => ({ name: b.billName, type: b.billType, amountPaise: b.amountPaise })),
    })),
    inventoryLines: n.inventory.map((i) => ({
      item: i.stockItemName, qty: i.actualQty, unit: i.unit, ratePaise: i.ratePaise, amountPaise: i.amountPaise,
      batches: ((i.data.batches ?? []) as Record<string, string>[]).map((b) => ({ godown: b.godownName ?? '', batch: b.batchName ?? '', qty: b.actualQty ?? '' })),
    })),
  }
}

export function tallyVoucherCheck(nodes: XmlNode[]): TallyVoucherCheck {
  const check: TallyVoucherCheck = {
    count: 0, from: null, to: null, byType: [], actions: {}, unbalanced: 0, withIssues: 0, ledgerLines: 0, inventoryLines: 0,
    billAllocations: 0, batchAllocations: 0, vouchers: [], shown: 0,
  }
  const types = new Map<string, TallyVoucherCheck['byType'][number]>()
  for (const node of nodes) {
    const r = voucherRecord(node)
    const n = normaliseVoucher(r)
    const v = view(r, n)
    check.count++
    if (n.header.date) {
      if (!check.from || n.header.date < check.from) check.from = n.header.date
      if (!check.to || n.header.date > check.to) check.to = n.header.date
    }
    const key = v.type || '(no type)'
    const tp = types.get(key) ?? { type: key, count: 0, cancelled: 0, optional: 0, unbalanced: 0, amountPaise: 0 }
    tp.count++
    if (v.cancelled) tp.cancelled++
    if (v.optional) tp.optional++
    if (!v.balanced) { tp.unbalanced++; check.unbalanced++ }
    if (!v.cancelled) tp.amountPaise += v.amountPaise
    types.set(key, tp)
    if (v.issues.length) check.withIssues++
    if (v.action) check.actions[v.action] = (check.actions[v.action] ?? 0) + 1
    check.ledgerLines += n.lines.length
    check.inventoryLines += n.inventory.length
    check.billAllocations += n.bills.length
    check.batchAllocations += v.inventoryLines.reduce((s, i) => s + i.batches.length, 0)
    if (check.vouchers.length < VOUCHER_LIST_MAX) check.vouchers.push(v)
  }
  check.byType = [...types.values()].sort((a, b) => b.count - a.count)
  check.shown = check.vouchers.length
  return check
}
