import { beforeEach, describe, expect, test } from 'bun:test'
import { db } from '@/lib/db'
import { cancelSlice, failSlice, stageSlice, stageVouchers, startVoucherRead } from '@/lib/tally/voucher-stage'
import { contentHash, normaliseVoucher, type TallyVoucherRecord } from '@/lib/tally/vouchers'
import * as connector from '../connector/tally/manuflow-tally-connector.mjs'
import { resetDb } from './helpers/db'
import { seedTenant } from './helpers/seed'

// Phase F staging against the test database: identity and adoption, atomic revisions (forced failure, concurrency),
// read completion. Records are made up in Tally's shape; no Tally is contacted.

const TC = 'Name 0006'
const v = (over: Partial<TallyVoucherRecord> = {}): TallyVoucherRecord => ({
  guid: 'g-1', masterId: '101', alterId: '5', date: '20260415', voucherType: 'Sales', voucherNumber: 'S-1', partyLedger: 'Party A', isInvoice: 'Yes',
  ledgerEntries: [{ ledgerName: 'Party A', amount: '-1180.00', isDeemedPositive: 'Yes', bills: [{ name: 'S-1', billType: 'New Ref', amount: '-1180.00' }] }, { ledgerName: 'Output IGST', amount: '180.00' }],
  inventoryEntries: [{ stockItemName: 'Bolt', actualQty: '10 Nos', rate: '100.00/Nos', amount: '1000.00', accountingAllocations: [{ ledgerName: 'Sales', amount: '1000.00' }] }],
  ...over,
})
const changed = (r: TallyVoucherRecord): TallyVoucherRecord => ({ ...r, ledgerEntries: [{ ...r.ledgerEntries![0], amount: '-2360.00', bills: [{ name: 'S-1', billType: 'New Ref', amount: '-2360.00' }] }, { ledgerName: 'Output IGST', amount: '360.00' }],
  inventoryEntries: [{ ...r.inventoryEntries![0], actualQty: '20 Nos', amount: '2000.00', accountingAllocations: [{ ledgerName: 'Sales', amount: '2000.00' }] }] })

let companyId = ''
const scope = (jobId = 'job-1') => ({ companyId, tallyCompany: TC, jobId })
const vouchers = (cid = companyId) => db.tallySourceVoucher.findMany({ where: { companyId: cid }, orderBy: [{ voucherNumber: 'asc' }, { identity: 'asc' }] })
const past = (days: number) => new Date(Date.now() - days * 86_400_000)

/** Header and lines agree: lines exist only up to the header's revision, older ones superseded, current ones match its content. */
async function consistent(voucherId: string, records: TallyVoucherRecord[]) {
  const h = await db.tallySourceVoucher.findUniqueOrThrow({ where: { id: voucherId } })
  const lines = await db.tallySourceVoucherLine.findMany({ where: { voucherId } })
  const inv = await db.tallySourceInventoryLine.findMany({ where: { voucherId } })
  const bills = await db.tallySourceBillAllocation.findMany({ where: { voucherId } })
  for (const set of [lines, inv, bills]) {
    expect(set.every((l) => l.revision <= h.revision)).toBe(true)
    expect(set.filter((l) => l.revision < h.revision).every((l) => l.supersededAt !== null)).toBe(true)
    expect(set.filter((l) => l.revision === h.revision).every((l) => l.supersededAt === null)).toBe(true)
  }
  const current = records.map(normaliseVoucher).find((n) => contentHash(n) === h.contentHash)!
  expect(current).toBeDefined()
  expect(lines.filter((l) => l.revision === h.revision).map((l) => [l.seq, l.ledgerName, Number(l.amountPaise)]).sort())
    .toEqual(current.lines.map((l) => [l.seq, l.ledgerName, l.amountPaise]).sort())
  expect(inv.filter((l) => l.revision === h.revision).length).toBe(current.inventory.length)
  expect(bills.filter((l) => l.revision === h.revision).length).toBe(current.bills.length)
  return h
}

beforeEach(async () => {
  await resetDb()
  companyId = (await seedTenant()).company.id
})

// ---------------------------------------------------------------- identity

describe('identity and adoption', () => {
  test('two distinct vouchers with the same type, number and date are two rows, also after a retry', async () => {
    const a = v({ guid: '', masterId: '', partyLedger: 'Party A' })
    const b = v({ guid: '', masterId: '', partyLedger: 'Party B', ledgerEntries: [{ ledgerName: 'Party B', amount: '-50.00' }, { ledgerName: 'Sales', amount: '50.00' }], inventoryEntries: [] })
    await stageVouchers(scope(), [a, b])
    await stageVouchers(scope('job-2'), [a, b]) // retry
    const rows = await vouchers()
    expect(rows.length).toBe(2)
    expect(rows.map((r) => r.partyLedger).sort()).toEqual(['Party A', 'Party B'])
    expect((rows.find((r) => r.identity.endsWith('#2'))!.issues as { code: string }[]).map((i) => i.code)).toContain('duplicate_key_in_read')
    // with GUIDs the same type / number / date is simply two vouchers, nothing flagged
    await resetDb(); companyId = (await seedTenant()).company.id
    await stageVouchers(scope(), [v({ guid: 'g-a' }), v({ guid: 'g-b', masterId: '102' })])
    expect((await vouchers()).map((r) => [r.identity, r.issues])).toEqual([['g:g-a', null], ['g:g-b', null]])
  })

  test('missing GUID, and missing GUID and MASTERID: retries hit the same row; a change is a new revision of it', async () => {
    for (const base of [v({ guid: '' }), v({ guid: '', masterId: '' })]) {
      await resetDb(); companyId = (await seedTenant()).company.id
      await stageVouchers(scope('j1'), [base])
      await stageVouchers(scope('j2'), [base])
      await stageVouchers(scope('j3'), [changed(base)])
      const rows = await vouchers()
      expect(rows.length).toBe(1)
      expect([rows[0].identitySource, rows[0].revision]).toEqual([base.masterId ? 'masterid' : 'natural', 2])
      await consistent(rows[0].id, [base, changed(base)])
    }
  })

  test('a voucher that gains a GUID later is taken over, not duplicated (from MASTERID and from type + number + date)', async () => {
    await stageVouchers(scope(), [v({ guid: '' })], { at: past(3) })
    await stageVouchers(scope(), [v({ guid: '', masterId: '', voucherNumber: 'S-2' })], { at: past(3) })
    await stageVouchers(scope('j2'), [v(), v({ guid: 'g-2', masterId: '', voucherNumber: 'S-2' })])
    const rows = await vouchers()
    expect(rows.map((r) => [r.voucherNumber, r.identity, r.identitySource, r.guid, r.revision])).toEqual([
      ['S-1', 'g:g-1', 'guid', 'g-1', 1], ['S-2', 'g:g-2', 'guid', 'g-2', 1],
    ])
    expect((rows[0].data as { adoptedFrom: string }).adoptedFrom).toBe('m:101')
    expect((rows[1].data as { adoptedFrom: string }).adoptedFrom).toMatch(/^n:/)
  })

  test('a GUID-less voucher whose MASTERID changed is not taken over silently: kept apart and flagged', async () => {
    await stageVouchers(scope(), [v({ guid: '', masterId: '101' })], { at: past(3) })
    await stageVouchers(scope('j2'), [v({ guid: '', masterId: '202' })])
    const rows = await vouchers()
    expect(rows.map((r) => r.identity).sort()).toEqual(['m:101', 'm:202'])
    expect((rows.find((r) => r.identity === 'm:202')!.issues as { code: string }[]).map((i) => i.code)).toContain('possible_earlier_copy')
  })

  test('ambiguous: two earlier candidates → neither is adopted; a candidate that already has another GUID is never adopted', async () => {
    const a = v({ guid: '', masterId: '', partyLedger: 'Party A' })
    const b = v({ guid: '', masterId: '', partyLedger: 'Party B' })
    await stageVouchers(scope(), [a, b], { at: past(3) })
    await stageVouchers(scope('j2'), [v({ guid: 'g-new', masterId: '' })])
    let rows = await vouchers()
    expect(rows.length).toBe(3)
    expect((rows.find((r) => r.identity === 'g:g-new')!.issues as { code: string }[]).map((i) => i.code)).toContain('ambiguous_match')
    await resetDb(); companyId = (await seedTenant()).company.id
    await stageVouchers(scope(), [v({ guid: 'g-old' })], { at: past(3) })
    await stageVouchers(scope('j2'), [v({ guid: 'g-other' })]) // same MASTERID and number, but a different GUID
    rows = await vouchers()
    expect(rows.map((r) => r.identity).sort()).toEqual(['g:g-old', 'g:g-other'])
  })
})

// ---------------------------------------------------------------- atomic revisions

describe('atomic revisions', () => {
  test('a forced failure mid-write leaves the voucher entirely on its previous revision (whole batch rolled back)', async () => {
    const other = v({ guid: 'g-9', masterId: '109', voucherNumber: 'S-9' })
    await stageVouchers(scope(), [v(), other])
    const before = await vouchers()
    // the new revision's bill allocation is written last: make that insert fail
    await db.$executeRawUnsafe("ALTER TABLE TallySourceBillAllocation ADD CONSTRAINT test_fail_bill CHECK (billName <> 'FAIL_HERE')")
    try {
      const bad = changed(v())
      bad.ledgerEntries![0].bills = [{ name: 'FAIL_HERE', amount: '-2360.00' }]
      await expect(stageVouchers(scope('j2'), [changed(other), bad])).rejects.toThrow()
    } finally {
      await db.$executeRawUnsafe('ALTER TABLE TallySourceBillAllocation DROP CHECK test_fail_bill')
    }
    const after = await vouchers()
    expect(after.map((r) => [r.identity, r.revision, r.contentHash, r.jobId])).toEqual(before.map((r) => [r.identity, r.revision, r.contentHash, r.jobId]))
    for (const r of after) await consistent(r.id, [v(), other])
    expect(await db.tallySourceVoucherLine.count({ where: { revision: 2 } })).toBe(0)
    expect(await db.tallySourceVoucherLine.count({ where: { supersededAt: { not: null } } })).toBe(0)
  })

  test('concurrent staging: the same read three times at once → one voucher, one revision, no doubled lines', async () => {
    await Promise.all([1, 2, 3].map((n) => stageVouchers(scope(`j${n}`), [v()])))
    const rows = await vouchers()
    expect(rows.length).toBe(1)
    expect(rows[0].revision).toBe(1)
    await consistent(rows[0].id, [v()])
    expect(await db.tallySourceVoucherLine.count()).toBe(3)
  })

  test('concurrent different versions: whichever wins, header and lines agree and history is kept', async () => {
    await stageVouchers(scope(), [v()])
    const third = changed(changed(v()))
    third.narration = 'third'
    await Promise.all([stageVouchers(scope('a'), [changed(v())]), stageVouchers(scope('b'), [third])])
    const [row] = await vouchers()
    expect(row.revision).toBeGreaterThanOrEqual(2)
    await consistent(row.id, [v(), changed(v()), third])
  })
})

// ---------------------------------------------------------------- reads

const period = { from: '2026-04-01', to: '2026-06-30' }
const inMonth = (m: string, n: string, extra: Partial<TallyVoucherRecord> = {}) => v({ guid: `g-${m}-${n}`, masterId: '', voucherNumber: `${m}-${n}`, date: `2026${m}10`, ...extra })

describe('read completion', () => {
  test('one read at a time per ManuFlow company; another company may read the same Tally company meanwhile', async () => {
    const r = await startVoucherRead(companyId, TC, period, 'u')
    expect(r.activeFor).toBe(companyId)
    await expect(startVoucherRead(companyId, 'Another Tally Co', period, 'u')).rejects.toThrow(/already being read/)
    const other = (await seedTenant()).company.id
    expect((await startVoucherRead(other, TC, period, 'u')).status).toBe('running')
    await failSlice(r.id, 0, null) // finished (incomplete) → the company may start again
    expect((await startVoucherRead(companyId, TC, period, 'u')).status).toBe('running')
  })

  test('missingSince only once every slice is staged; nothing outside the period; seen again → cleared', async () => {
    // earlier state: April and May vouchers that Tally no longer has, and one outside the period
    await stageVouchers(scope('old'), [inMonth('04', 'gone'), inMonth('05', 'gone'), inMonth('07', 'outside'), inMonth('04', 'kept')], { at: past(10) })
    const read = await startVoucherRead(companyId, TC, period, 'u')
    const missing = async () => (await vouchers()).filter((x) => x.missingSince).map((x) => x.voucherNumber).sort()
    await stageSlice(read.id, 0, 'jA', [inMonth('04', 'kept'), inMonth('04', 'new')])
    expect(await missing()).toEqual([])
    await stageSlice(read.id, 1, 'jM', [inMonth('05', 'new')])
    expect(await missing()).toEqual([]) // June not staged yet
    const done = await stageSlice(read.id, 2, 'jJ', [])
    expect([done.read.status, done.read.markedMissing, done.read.activeFor]).toEqual(['complete', 2, null])
    expect(await missing()).toEqual(['04-gone', '05-gone'])
    // a later read that sees one of them again clears its mark
    await stageVouchers(scope('later'), [inMonth('04', 'gone')])
    expect(await missing()).toEqual(['05-gone'])
  })

  test('a failed or cancelled slice ends the read without marking anything', async () => {
    await stageVouchers(scope('old'), [inMonth('04', 'gone')], { at: past(10) })
    const a = await startVoucherRead(companyId, TC, period, 'u')
    await stageSlice(a.id, 0, 'j1', [])
    await stageSlice(a.id, 1, 'j2', [])
    const failed = await failSlice(a.id, 2, 'j3')
    expect([failed.status, failed.markedMissing, failed.activeFor]).toEqual(['incomplete', null, null])
    const b = await startVoucherRead(companyId, TC, period, 'u')
    await stageSlice(b.id, 0, 'j4', [])
    const cancelled = await cancelSlice(b.id, 1)
    expect(cancelled.status).toBe('cancelled')
    expect((await vouchers()).every((x) => x.missingSince === null)).toBe(true)
    await expect(stageSlice(b.id, 2, 'j5', [])).rejects.toThrow(/not running/) // nothing more can be added
  })

  test('two ManuFlow companies reading the same Tally company never touch each other’s vouchers', async () => {
    const other = (await seedTenant()).company.id
    for (const cid of [companyId, other]) await stageVouchers({ companyId: cid, tallyCompany: TC, jobId: 'old' }, [inMonth('04', 'gone')], { at: past(10) })
    const read = await startVoucherRead(companyId, TC, period, 'u')
    for (const i of [0, 1, 2]) await stageSlice(read.id, i, `j${i}`, [])
    expect((await vouchers(companyId))[0].missingSince).not.toBeNull()
    expect((await vouchers(other))[0].missingSince).toBeNull()
  })
})

// ---------------------------------------------------------------- safety

describe('safety', () => {
  test('staging and reads write nothing but Tally tables', async () => {
    const tables = await db.$queryRawUnsafe<{ name: string }[]>("SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE' AND table_name NOT LIKE 'Tally%'")
    const count = async () => Object.fromEntries(await Promise.all(tables.map(async ({ name }) => [name, Number((await db.$queryRawUnsafe<{ n: bigint }[]>(`SELECT COUNT(*) AS n FROM \`${name}\``))[0].n)])))
    const before = await count()
    await stageVouchers(scope(), [v(), changed(v())])
    const read = await startVoucherRead(companyId, TC, period, 'u')
    for (const i of [0, 1, 2]) await stageSlice(read.id, i, `j${i}`, [])
    expect(await count()).toEqual(before)
  })

  test('every voucher request for a year of slices, for any company name, is a single Export that passes the unchanged guard', () => {
    for (const company of ['Name 0006', 'A & B <Ltd>', 'x</SVCURRENTCOMPANY><VOUCHER ACTION="Create">', "O'Brien \"Q\""]) {
      for (let m = 1; m <= 12; m++) {
        const mm = String(m).padStart(2, '0')
        const xml = connector.voucherRequest(company, `2026${mm}01`, `2026${mm}28`)
        expect(connector.isExportRequest(xml)).toBe(true)
        expect(xml.match(/<TALLYREQUEST>[^<]*<\/TALLYREQUEST>/g)).toEqual(['<TALLYREQUEST>Export</TALLYREQUEST>'])
      }
    }
  })
})
