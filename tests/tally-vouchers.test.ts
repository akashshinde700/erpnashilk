import { describe, expect, test } from 'bun:test'
import {
  contentHash, coversExactly, normaliseVoucher, parseQty, parseRate, planSlices, readComplete, splitSlice, voucherIdentity,
  type ReadSlice, type TallyVoucherRecord,
} from '@/lib/tally/vouchers'
import * as connector from '../connector/tally/manuflow-tally-connector.mjs'

// Phase F design, the parts that need no database: voucher identity, revisions (content hash), line numbering,
// read completeness, and the proposed (unused) voucher Export request. Database-level tests (atomic revision writes,
// concurrency, missing marks) are listed in docs/tally-vouchers-design.md and run once the tables exist.

const sale = (over: Partial<TallyVoucherRecord> = {}): TallyVoucherRecord => ({
  guid: 'aaaa-1', masterId: '101', alterId: '7', date: '20260415', voucherType: 'Sales', voucherNumber: 'S-12', partyLedger: 'Party A',
  isCancelled: 'No', isOptional: 'No', isInvoice: 'Yes',
  ledgerEntries: [{ ledgerName: 'Party A', amount: '-1180.00', isDeemedPositive: 'Yes', isPartyLedger: 'Yes', bills: [{ name: 'S-12', billType: 'New Ref', amount: '-1180.00' }] },
    { ledgerName: 'Output IGST', amount: '180.00', isDeemedPositive: 'No' }],
  inventoryEntries: [{ stockItemName: 'Bolt', actualQty: '10 Nos', billedQty: '10 Nos', rate: '100.00/Nos', amount: '1000.00', isDeemedPositive: 'No',
    batches: [{ godownName: 'Main Location', actualQty: '10 Nos' }], accountingAllocations: [{ ledgerName: 'Sales', amount: '1000.00', isDeemedPositive: 'No' }] }],
  ...over,
})
const hashOf = (r: TallyVoucherRecord) => contentHash(normaliseVoucher(r))
const idOf = (r: TallyVoucherRecord, n = 1) => voucherIdentity(r, hashOf(r), n)

describe('voucher identity (no duplicate rows across retries or changed content)', () => {
  test('GUID first, then MASTERID, then type + number + date; each survives a change of amounts', () => {
    const changed = (r: TallyVoucherRecord) => ({ ...r, ledgerEntries: [{ ledgerName: 'Party A', amount: '-999.00' }] })
    for (const [r, source, prefix] of [
      [sale(), 'guid', 'g:aaaa-1'], [sale({ guid: '' }), 'masterid', 'm:101'], [sale({ guid: '', masterId: '' }), 'natural', 'n:'],
    ] as const) {
      const a = idOf(r)
      expect([a.source, a.identity.startsWith(prefix), a.stable]).toEqual([source, true, true])
      expect(idOf(changed(r)).identity).toBe(a.identity) // same voucher, new content → same row (a new revision)
      expect(hashOf(changed(r))).not.toBe(hashOf(r))
    }
    expect(idOf(sale({ guid: '' })).issues.map((i) => i.code)).toEqual(['no_guid'])
  })

  test('a retry of the same read gives the same identity and content hash', () => {
    expect(idOf(sale())).toEqual(idOf(sale()))
    expect(hashOf(sale())).toBe(hashOf(structuredClone(sale())))
  })

  test('the natural key is the same whatever the identity source, so a later read with a GUID can adopt the row', () => {
    expect(idOf(sale({ guid: '', masterId: '' })).naturalKey).toBe(idOf(sale()).naturalKey)
    expect(idOf(sale({ voucherNumber: 'S-13' })).naturalKey).not.toBe(idOf(sale()).naturalKey)
  })

  test('nothing stable: flagged; identical vouchers in one read stay apart by occurrence, never merged silently', () => {
    const bare = sale({ guid: '', masterId: '', voucherNumber: '' })
    const a = idOf(bare)
    expect([a.source, a.stable, a.issues.map((i) => i.code)]).toEqual(['content', false, ['no_guid', 'no_stable_identity']])
    expect(idOf(bare, 2).identity).not.toBe(a.identity)
    expect(idOf(bare).identity).toBe(a.identity) // a retry finds the same row
  })
})

describe('revisions and line identity', () => {
  test('ALTERID, MASTERID or a GUID appearing alone do not make a new revision', () => {
    expect(hashOf(sale({ alterId: '99', masterId: '555' }))).toBe(hashOf(sale()))
    expect(hashOf(sale({ guid: '' }))).toBe(hashOf(sale()))
  })

  test('reordered lines are a new revision: lines are numbered per revision and never matched across revisions', () => {
    const r = sale()
    const reordered = { ...r, ledgerEntries: [...r.ledgerEntries!].reverse() }
    expect(hashOf(reordered)).not.toBe(hashOf(r))
    const a = normaliseVoucher(r).lines.map((l) => [l.seq, l.ledgerName])
    const b = normaliseVoucher(reordered).lines.map((l) => [l.seq, l.ledgerName])
    expect(a).toEqual([[1, 'Party A'], [2, 'Output IGST'], [3, 'Sales']])
    expect(b).toEqual([[1, 'Output IGST'], [2, 'Party A'], [3, 'Sales']]) // seq 1 is a different line now: only valid within its revision
  })

  test('normalised: accounting allocations under inventory lines, bills on their line, paise with Tally’s sign, raw text kept', () => {
    const v = normaliseVoucher(sale())
    expect(v.lines.map((l) => [l.source, l.inventorySeq, l.ledgerName, l.amountPaise, l.isDeemedPositive])).toEqual([
      ['ledger', null, 'Party A', -118000, true], ['ledger', null, 'Output IGST', 18000, false], ['inventory', 1, 'Sales', 100000, false],
    ])
    expect(v.bills).toEqual([{ lineSeq: 1, seq: 1, ledgerName: 'Party A', billName: 'S-12', billType: 'New Ref', amountPaise: -118000, data: {} }])
    expect(v.inventory[0]).toMatchObject({ stockItemName: 'Bolt', actualQty: '10', unit: 'Nos', ratePaise: 10000, rateUnit: 'Nos', amountPaise: 100000, godownName: 'Main Location' })
    expect(v.inventory[0].data).toMatchObject({ qtyText: '10 Nos', rateText: '100.00/Nos' })
    expect([v.header.sumPositivePaise, v.header.sumNegativePaise, v.header.date, v.header.isInvoice]).toEqual([118000, -118000, '2026-04-15', true])
    expect(v.issues).toEqual([])
  })

  test('problems are recorded, never guessed: unbalanced, unreadable amount or quantity, Dr / Cr text, bad date', () => {
    const v = normaliseVoucher(sale({
      date: '2026-04-15', ledgerEntries: [{ ledgerName: 'Party A', amount: '1180.00 Dr' }, { ledgerName: '', amount: '5' }],
      inventoryEntries: [{ stockItemName: 'Bolt', actualQty: 'lots', rate: 'cheap' }],
    }))
    expect(v.issues.map((i) => i.code).sort()).toEqual(['bad_amount', 'bad_date', 'bad_quantity', 'bad_rate', 'no_ledger', 'not_balanced'])
    expect([parseQty('2.5 Kg'), parseQty('-3 Nos'), parseQty('7'), parseQty('x')]).toEqual([{ qty: '2.5', unit: 'Kg' }, { qty: '-3', unit: 'Nos' }, { qty: '7', unit: null }, null])
    expect([parseRate('1,250.50/Nos'), parseRate('12'), parseRate('a/b')]).toEqual([{ paise: 125050, unit: 'Nos' }, { paise: 1200, unit: null }, null])
  })
})

describe('complete reads (only then may unseen vouchers be marked missing)', () => {
  const period = { from: '2026-04-01', to: '2026-06-30' }
  const set = (slices: ReadSlice[], ...statuses: ReadSlice['status'][]) => slices.map((s, i) => ({ ...s, status: statuses[i] ?? s.status }))

  test('one slice per month; complete only when every slice is read AND staged', () => {
    const slices = planSlices(period)
    expect(slices.map((s) => [s.from, s.to])).toEqual([['2026-04-01', '2026-04-30'], ['2026-05-01', '2026-05-31'], ['2026-06-01', '2026-06-30']])
    expect(readComplete(period, set(slices, 'staged', 'staged', 'staged'))).toBe(true)
    for (const bad of ['pending', 'reading', 'read', 'failed', 'cancelled'] as const) {
      expect([bad, readComplete(period, set(slices, 'staged', bad, 'staged'))]).toEqual([bad, false])
    }
  })

  test('a month too large is split into days without a gap or overlap; a gap or overlap is never complete', () => {
    const split = splitSlice(planSlices(period), 1)
    expect(split.length).toBe(2 + 31)
    expect(coversExactly(period, split)).toBe(true)
    expect(readComplete(period, split.map((s) => ({ ...s, status: 'staged' })))).toBe(true)
    const gap = split.filter((s) => s.from !== '2026-05-10')
    expect(readComplete(period, gap.map((s) => ({ ...s, status: 'staged' })))).toBe(false)
    const overlap = [...split, { from: '2026-05-10', to: '2026-05-11', status: 'staged' as const, jobId: null, attempts: 0 }]
    expect(coversExactly(period, overlap)).toBe(false)
  })
})

describe('the proposed voucher Export request (prepared, not used)', () => {
  test('a single plain Export, read-only filter, escaped company, strict dates; not a job the server can ask for', () => {
    const xml = connector.voucherRequest('A & B <Ltd>', '20260401', '20260430')
    expect(connector.isExportRequest(xml)).toBe(true)
    expect(xml).toContain('<SVCURRENTCOMPANY>A &amp; B &lt;Ltd&gt;</SVCURRENTCOMPANY>')
    expect(xml).toContain('<SVFROMDATE TYPE="Date">20260401</SVFROMDATE><SVTODATE TYPE="Date">20260430</SVTODATE>')
    expect(xml).toContain('ISMODIFY="No"')
    expect(xml).not.toMatch(/Import|ACTION=|<IMPORTDATA|<TALLYMESSAGE|\bAlter\b|\bDelete\b|\bCreate\b/i)
    expect(() => connector.parseXml(xml)).not.toThrow() // well-formed (the filter's >= and <= are escaped)
    for (const [f, t] of [['2026-04-01', '20260430'], ['20260401</SVFROMDATE><X>', '20260430'], ['20260501', '20260430'], ['', '']]) {
      expect(() => connector.voucherRequest('Co', f, t)).toThrow()
    }
    expect(Object.keys(connector.JOBS)).not.toContain('export-vouchers')
  })
})
