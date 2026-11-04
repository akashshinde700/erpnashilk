import { Prisma, type TallySourceVoucher } from '@prisma/client'
import { db } from '@/lib/db'
import { ApiError } from '@/lib/erp-helpers'
import { contentHash, normaliseVoucher, planSlices, readComplete, voucherIdentity, type NormalisedVoucher, type ReadSlice, type TallyVoucherRecord, type VoucherIssue } from '@/lib/tally/vouchers'
import type { DateRange } from '@/lib/tally/period'

/**
 * Writing Tally vouchers into Layer 1 (design: docs/tally-vouchers-design.md). Only Tally tables are written here.
 *
 * Atomicity: vouchers are written in batches; each batch is ONE database transaction. A voucher's header, accounting
 * lines, inventory lines and bill allocations of a revision are written together, and every header change is a
 * conditional update on (id, revision): if anyone changed the voucher meanwhile, the update touches no row, the batch
 * throws and is rolled back whole, then retried. So a voucher can never be left with its header on one revision and
 * its lines on another; the current lines are always those with revision = header.revision.
 */

const BATCH = 50
const ATTEMPTS = 3

export interface StageScope { companyId: string; tallyCompany: string; jobId: string }
interface Prepared { rec: TallyVoucherRecord; v: NormalisedVoucher; hash: string; identity: string; source: string; naturalKey: string; issues: VoucherIssue[] }

class Conflict extends Error {}

const day = (s: string | null) => (s ? new Date(`${s}T00:00:00Z`) : null)
const big = (n: number | null) => (n === null ? null : BigInt(n))

/** Identities for one read. A key that two vouchers of the same read share is never merged: both are kept apart (#n). */
export function prepareVouchers(records: TallyVoucherRecord[]): Prepared[] {
  const seen = new Map<string, number>()
  return records.map((rec) => {
    const v = normaliseVoucher(rec)
    const hash = contentHash(v)
    const base = voucherIdentity(rec, hash)
    const n = (seen.get(base.identity) ?? 0) + 1
    seen.set(base.identity, n)
    if (n === 1) return { rec, v, hash, identity: base.identity, source: base.source, naturalKey: base.naturalKey, issues: [...base.issues, ...v.issues] }
    // the same key twice in one read: different vouchers (or one sent twice) — kept apart and flagged, never merged
    const again = base.source === 'content' ? voucherIdentity(rec, hash, n) : { ...base, identity: `${base.identity}#${n}`.slice(0, 100) }
    return {
      rec, v, hash, identity: again.identity, source: base.source, naturalKey: base.naturalKey,
      issues: [...base.issues, ...v.issues, { code: 'duplicate_key_in_read', message: `Another voucher of this read has the same ${base.source === 'guid' ? 'GUID' : base.source === 'masterid' ? 'MASTERID' : 'type, number and date'}; kept as a separate row.` }],
    }
  })
}

/**
 * Adoption: a row stored earlier under a weaker identity (no GUID) that this voucher, now with a GUID or MASTERID,
 * clearly is. Only when exactly ONE candidate qualifies; two or more → nothing is adopted (flagged instead).
 * Candidates never include a row that already has a GUID, a row with a different MASTERID, or a row this same read has
 * already seen (that row belongs to another voucher of the read).
 *
 *   GUID voucher:      rows with guid IS NULL and masterId = its MASTERID; if none: guid IS NULL, masterId IS NULL and
 *                      the same naturalKey (type + number + date)
 *   MASTERID voucher:  rows with guid IS NULL, masterId IS NULL and the same naturalKey
 */
async function adoptionCandidate(tx: Prisma.TransactionClient, scope: StageScope, p: Prepared, cutoff: Date) {
  if (p.source !== 'guid' && p.source !== 'masterid') return { row: null, ambiguous: false }
  // rows this read (or this staging run) already saw belong to other vouchers of it
  const base = { companyId: scope.companyId, tallyCompany: scope.tallyCompany, guid: null, lastSeenAt: { lt: cutoff } }
  const masterId = p.v.header.masterId
  if (p.source === 'guid' && masterId !== null) {
    const byMaster = await tx.tallySourceVoucher.findMany({ where: { ...base, masterId }, take: 2 })
    if (byMaster.length === 1) return { row: byMaster[0], ambiguous: false }
    if (byMaster.length > 1) return { row: null, ambiguous: true }
  }
  if (!p.v.header.voucherNumber) return { row: null, ambiguous: false } // without a number the natural key says too little
  const byNatural = await tx.tallySourceVoucher.findMany({ where: { ...base, masterId: null, naturalKey: p.naturalKey, identitySource: { in: ['natural', 'content'] } }, take: 2 })
  if (byNatural.length === 1) return { row: byNatural[0], ambiguous: false }
  return { row: null, ambiguous: byNatural.length > 1 }
}

function headerData(scope: StageScope, p: Prepared, at: Date) {
  const h = p.v.header
  return {
    guid: h.guid, masterId: h.masterId, alterId: h.alterId, voucherType: h.voucherType, voucherNumber: h.voucherNumber, date: day(h.date),
    effectiveDate: day(h.effectiveDate), reference: h.reference, referenceDate: day(h.referenceDate), partyLedger: h.partyLedger, narration: h.narration,
    isCancelled: h.isCancelled, isOptional: h.isOptional, isInvoice: h.isInvoice, sumPositivePaise: BigInt(h.sumPositivePaise), sumNegativePaise: BigInt(h.sumNegativePaise),
    contentHash: p.hash, data: h.data, issues: p.issues.length ? (p.issues as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
    jobId: scope.jobId, lastSeenAt: at, missingSince: null,
  }
}

/** Lines, inventory lines and bills of one revision. */
async function insertRevision(tx: Prisma.TransactionClient, companyId: string, tallyCompany: string, voucherId: string, revision: number, v: NormalisedVoucher) {
  if (v.lines.length) {
    await tx.tallySourceVoucherLine.createMany({ data: v.lines.map((l) => ({ companyId, voucherId, revision, seq: l.seq, source: l.source, inventorySeq: l.inventorySeq, ledgerName: l.ledgerName, amountPaise: BigInt(l.amountPaise), isDeemedPositive: l.isDeemedPositive, isPartyLedger: l.isPartyLedger, data: l.data })) })
  }
  if (v.inventory.length) {
    await tx.tallySourceInventoryLine.createMany({ data: v.inventory.map((i) => ({ companyId, voucherId, revision, seq: i.seq, stockItemName: i.stockItemName, actualQty: i.actualQty, billedQty: i.billedQty, unit: i.unit, ratePaise: big(i.ratePaise), rateUnit: i.rateUnit, amountPaise: big(i.amountPaise), isDeemedPositive: i.isDeemedPositive, godownName: i.godownName, data: i.data as Prisma.InputJsonValue })) })
  }
  if (v.bills.length) {
    await tx.tallySourceBillAllocation.createMany({ data: v.bills.map((b) => ({ companyId, tallyCompany, voucherId, revision, lineSeq: b.lineSeq, seq: b.seq, ledgerName: b.ledgerName, billName: b.billName, billType: b.billType, amountPaise: big(b.amountPaise), data: b.data })) })
  }
}

/** One voucher, inside the batch transaction. → what happened to it */
async function writeVoucher(tx: Prisma.TransactionClient, scope: StageScope, p: Prepared, at: Date, readStartedAt: Date | null): Promise<'created' | 'revised' | 'unchanged' | 'adopted+unchanged' | 'adopted+revised'> {
  const key = { companyId_tallyCompany_identity: { companyId: scope.companyId, tallyCompany: scope.tallyCompany, identity: p.identity } }
  let row: TallySourceVoucher | null = await tx.tallySourceVoucher.findUnique({ where: key })
  let adopted = false
  if (!row) {
    const cutoff = readStartedAt ?? at
    const c = await adoptionCandidate(tx, scope, p, cutoff)
    if (c.ambiguous) p.issues.push({ code: 'ambiguous_match', message: 'Several earlier vouchers could be this one; none was taken over, so it is stored as a new voucher.' })
    if (!c.row && !c.ambiguous && p.v.header.voucherNumber) {
      // e.g. a GUID-less voucher whose MASTERID changed: never taken over silently, but shown
      const similar = await tx.tallySourceVoucher.count({ where: { companyId: scope.companyId, tallyCompany: scope.tallyCompany, naturalKey: p.naturalKey, identity: { not: p.identity }, lastSeenAt: { lt: cutoff } } })
      if (similar) p.issues.push({ code: 'possible_earlier_copy', message: `${similar} earlier voucher(s) have the same type, number and date but could not be confirmed as this one; they are kept separately.` })
    }
    if (c.row) {
      const moved = await tx.tallySourceVoucher.updateMany({
        where: { id: c.row.id, identity: c.row.identity, revision: c.row.revision },
        data: { identity: p.identity, identitySource: p.source, data: { ...(c.row.data as object), adoptedFrom: c.row.identity } },
      })
      if (moved.count !== 1) throw new Conflict()
      row = { ...c.row, identity: p.identity }
      adopted = true
    }
  }
  if (!row) {
    const created = await tx.tallySourceVoucher.create({
      data: { companyId: scope.companyId, tallyCompany: scope.tallyCompany, identity: p.identity, identitySource: p.source, naturalKey: p.naturalKey, revision: 1, firstSeenAt: at, ...headerData(scope, p, at) },
    })
    await insertRevision(tx, scope.companyId, scope.tallyCompany, created.id, 1, p.v)
    return 'created'
  }
  if (row.contentHash === p.hash) {
    const r = await tx.tallySourceVoucher.updateMany({
      where: { id: row.id, revision: row.revision },
      data: { alterId: p.v.header.alterId, masterId: p.v.header.masterId, guid: p.v.header.guid, jobId: scope.jobId, lastSeenAt: at, missingSince: null },
    })
    if (r.count !== 1) throw new Conflict()
    return adopted ? 'adopted+unchanged' : 'unchanged'
  }
  // A real change: next revision. Header and lines move together or not at all (same transaction).
  const next = row.revision + 1
  const r = await tx.tallySourceVoucher.updateMany({ where: { id: row.id, revision: row.revision }, data: { revision: next, ...headerData(scope, p, at) } })
  if (r.count !== 1) throw new Conflict()
  const old = { voucherId: row.id, revision: row.revision }
  await tx.tallySourceVoucherLine.updateMany({ where: old, data: { supersededAt: at } })
  await tx.tallySourceInventoryLine.updateMany({ where: old, data: { supersededAt: at } })
  await tx.tallySourceBillAllocation.updateMany({ where: old, data: { supersededAt: at } })
  await insertRevision(tx, scope.companyId, scope.tallyCompany, row.id, next, p.v)
  return adopted ? 'adopted+revised' : 'revised'
}

const retryable = (e: unknown) => e instanceof Conflict || (e instanceof Prisma.PrismaClientKnownRequestError && (e.code === 'P2002' || e.code === 'P2034'))

/** Writes a read's vouchers. Each batch is all-or-nothing; a batch that meets a concurrent change is retried. */
export async function stageVouchers(scope: StageScope, records: TallyVoucherRecord[], opts: { at?: Date; readStartedAt?: Date | null } = {}) {
  const at = opts.at ?? new Date(Date.now())
  const prepared = prepareVouchers(records)
  const counts: Record<string, number> = { created: 0, revised: 0, unchanged: 0, 'adopted+unchanged': 0, 'adopted+revised': 0 }
  for (let i = 0; i < prepared.length; i += BATCH) {
    const part = prepared.slice(i, i + BATCH)
    for (let attempt = 1; ; attempt++) {
      try {
        // fresh copies: issues added during a failed attempt must not carry over
        const batch = part.map((p) => ({ ...p, issues: [...p.issues] }))
        const results = await db.$transaction(async (tx) => {
          const out: string[] = []
          for (const p of batch) out.push(await writeVoucher(tx, scope, p, at, opts.readStartedAt ?? null))
          return out
        })
        for (const r of results) counts[r]++
        break
      } catch (e) {
        if (attempt >= ATTEMPTS || !retryable(e)) throw e
      }
    }
  }
  return counts
}

// ---------------------------------------------------------------- reads and completion

/** One voucher read at a time per ManuFlow company (activeFor = companyId, unique), whatever the Tally company. */
export async function startVoucherRead(companyId: string, tallyCompany: string, period: DateRange, createdBy: string) {
  try {
    return await db.tallyVoucherRead.create({
      data: {
        companyId, tallyCompany, activeFor: companyId, periodFrom: day(period.from)!, periodTo: day(period.to)!, status: 'running',
        slices: planSlices(period) as unknown as Prisma.InputJsonValue, createdBy, startedAt: new Date(Date.now()),
      },
    })
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ApiError('Vouchers are already being read from Tally for this company', 409, 'VOUCHER_READ_RUNNING')
    throw e
  }
}

const periodOf = (r: { periodFrom: Date; periodTo: Date }) => ({ from: r.periodFrom.toISOString().slice(0, 10), to: r.periodTo.toISOString().slice(0, 10) })

/**
 * Changes one slice's state and, in the same transaction (the read row locked), finishes the read when it can:
 *  - any slice failed or cancelled → incomplete / cancelled, nothing marked;
 *  - every slice staged and the period covered exactly → complete: ONLY NOW vouchers of the period this read did not
 *    see get missingSince.
 */
async function updateSlice(readId: string, index: number, patch: Partial<ReadSlice>) {
  return db.$transaction(async (tx) => {
    // the read row is locked so two slices finishing at once cannot overwrite each other's state
    await tx.$queryRaw`SELECT id FROM TallyVoucherRead WHERE id = ${readId} FOR UPDATE`
    const read = await tx.tallyVoucherRead.findUnique({ where: { id: readId } })
    if (!read || read.status !== 'running') throw new ApiError('This voucher read is not running', 409, 'VOUCHER_READ_NOT_RUNNING')
    const slices = read.slices as unknown as ReadSlice[]
    if (!slices[index]) throw new ApiError('Unknown slice', 400)
    slices[index] = { ...slices[index], ...patch }
    const at = new Date(Date.now())
    const period = periodOf(read)
    let status = 'running'
    let markedMissing: number | null = null
    if (slices.some((s) => s.status === 'cancelled')) status = 'cancelled'
    else if (slices.some((s) => s.status === 'failed')) status = 'incomplete'
    else if (readComplete(period, slices)) {
      const r = await tx.tallySourceVoucher.updateMany({
        where: {
          companyId: read.companyId, tallyCompany: read.tallyCompany, date: { gte: read.periodFrom, lte: read.periodTo },
          lastSeenAt: { lt: read.startedAt }, missingSince: null,
        },
        data: { missingSince: at },
      })
      status = 'complete'
      markedMissing = r.count
    }
    return tx.tallyVoucherRead.update({
      where: { id: readId },
      data: {
        slices: slices as unknown as Prisma.InputJsonValue, status,
        ...(status === 'running' ? {} : { activeFor: null, finishedAt: at, markedMissing }),
      },
    })
  })
}

/** A slice's vouchers arrived: write them (all batches), then mark the slice staged (which may complete the read). */
export async function stageSlice(readId: string, index: number, jobId: string, records: TallyVoucherRecord[]) {
  const read = await db.tallyVoucherRead.findUnique({ where: { id: readId } })
  if (!read || read.status !== 'running') throw new ApiError('This voucher read is not running', 409, 'VOUCHER_READ_NOT_RUNNING')
  const counts = await stageVouchers({ companyId: read.companyId, tallyCompany: read.tallyCompany, jobId }, records, { readStartedAt: read.startedAt })
  const updated = await updateSlice(readId, index, { status: 'staged', jobId })
  return { counts, read: updated }
}

export const failSlice = (readId: string, index: number, jobId: string | null) => updateSlice(readId, index, { status: 'failed', jobId })
export const cancelSlice = (readId: string, index: number) => updateSlice(readId, index, { status: 'cancelled' })
