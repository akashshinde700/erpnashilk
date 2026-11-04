import { randomBytes } from 'node:crypto'
import type { TallyConnector, TallyJob } from '@prisma/client'
import { db } from '@/lib/db'
import { ApiError } from '@/lib/erp-helpers'
import { stageMasters } from '@/lib/tally/layer1'
import {
  CONNECTOR_MIN_VERSION, ONLINE_WINDOW_MS, OPEN_JOB_STATUSES, RETENTION, TALLY_JOB_TYPES, connectorOutdated, type TallyJobStatus, type TallyJobType,
} from '@/lib/tally/connector'

/**
 * Named, read-only jobs for the Tally connector (TallyJob / TallyJobChunk tables — see connector.ts).
 *
 * The browser asks for a job by name; the server checks that the company's connector is online and reaching Tally,
 * and that an export names a Tally company from Tally's own latest company list. The connector picks the job up with
 * its next heartbeat (claimed with a conditional update), builds the fixed Export XML itself and posts back normalised
 * records (validated here: known fields only, size-capped). The records are saved in chunks of 500 together with the
 * "done" status, kept 24 hours, and read by the import route; master exports are also copied into Layer 1
 * (TallySourceMaster, src/lib/tally/layer1.ts), which is kept.
 *
 * Company discovery: the Tally screen asks for the company list by itself once the connector is connected (and may
 * reuse a list read seconds ago, so several tabs or a reopened dialog do not queue new reads). The list is de-duplicated;
 * two open companies with the same name (different or missing GUIDs) are both shown, marked ambiguous, and cannot be chosen,
 * because Tally's export requests select a company by name. Nothing is read from a company until one is chosen.
 */

export const JOB_TYPES: TallyJobType[] = [...TALLY_JOB_TYPES]
export const EXPORT_JOB: Record<'customers' | 'suppliers' | 'items', TallyJobType> = {
  customers: 'export-customers', suppliers: 'export-suppliers', items: 'export-items',
}
export const MAX_RECORDS = 20_000
export const MAX_OPEN_JOBS = 6
/** A company list read this recently is reused when the screen asks for one by itself (not on an explicit refresh). */
export const LIST_REUSE_MS = 20_000
export const CHUNK_RECORDS = 500

const FIELDS: Record<TallyJobType, Record<string, number>> = {
  'list-companies': { name: 200, guid: 100, booksFrom: 10, startingFrom: 10 },
  'export-customers': partyFields(),
  'export-suppliers': partyFields(),
  'export-items': { guid: 100, name: 200, parent: 200, alterId: 20, unit: 50, hsn: 20, gstRate: 10 },
  'export-groups': { ...masterFields(), isRevenue: 5, affectsGrossProfit: 5, isDeemedPositive: 5, isSubLedger: 5, isBillWiseOn: 5 },
  'export-ledgers': { ...masterFields(), openingBalance: 40, isBillWiseOn: 5, isCostCentresOn: 5, currency: 20, gstin: 20, state: 100 },
  'export-stockgroups': masterFields(),
  'export-units': {
    guid: 100, name: 50, alterId: 20, formalName: 100, isSimple: 5, decimals: 5, baseUnits: 50, additionalUnits: 50, conversion: 40, gstUqc: 20,
  },
  'export-godowns': masterFields(),
}
function masterFields() {
  return { guid: 100, name: 200, parent: 200, alterId: 20 }
}
function partyFields() {
  return {
    guid: 100, name: 200, parent: 200, alterId: 20, gstin: 20, gstType: 40, pan: 20, phone: 50, email: 200,
    address: 1000, state: 100, pincode: 12, contactPerson: 200,
  }
}

/** Connector error codes → what the user can do about it (server-written; connector text is never shown). */
export const JOB_ERRORS: Record<string, string> = {
  tally_unreachable: 'The connector could not reach TallyPrime. Check that TallyPrime is open and running as a server, then try again.',
  timeout: 'TallyPrime took too long to answer. Close any open dialog in Tally, or try again with a smaller company.',
  company_not_found: 'TallyPrime did not find that company. Open (load) it in TallyPrime, refresh the company list and choose it again.',
  bad_response: 'TallyPrime answered in a way ManuFlow does not understand. This TallyPrime version may not be supported yet.',
  too_large: 'This company has too much data to read in one go.',
  tally_error: 'TallyPrime reported an error for this request. Check that the company is open in TallyPrime and try again.',
  cancelled: 'Cancelled.',
}

export interface JobView {
  id: string
  type: TallyJobType
  status: TallyJobStatus
  tallyCompany: string | null
  count: number | null
  message: string | null
  createdAt: string
  /** list-companies only: the companies Tally returned (real data, never a sample). */
  companies?: TallyCompany[]
}

export interface TallyCompany {
  name: string
  guid: string | null
  booksFrom: string | null
  startingFrom: string | null
  /** Another open company has the same name: it cannot be chosen (Tally is asked for a company by name). */
  ambiguous: boolean
}

/**
 * Tally's company list without repeats of one company (same name and GUID). Same-name entries that cannot be told
 * apart as one company (different GUIDs, or no GUID) are kept and marked ambiguous: Tally does not list a company twice.
 */
export function companyList(records: Record<string, string>[]): TallyCompany[] {
  const seen = new Map<string, TallyCompany>()
  const list: TallyCompany[] = []
  for (const r of records) {
    const c = { name: r.name, guid: r.guid || null, booksFrom: r.booksFrom || null, startingFrom: r.startingFrom || null, ambiguous: false }
    if (c.guid) {
      const key = `${c.name}\u0000${c.guid}`
      if (seen.has(key)) continue
      seen.set(key, c)
    }
    list.push(c)
  }
  const names = new Map<string, number>()
  for (const c of list) names.set(c.name, (names.get(c.name) ?? 0) + 1)
  for (const c of list) c.ambiguous = names.get(c.name)! > 1
  return list
}

const now = () => new Date(Date.now())

export async function jobView(j: TallyJob): Promise<JobView> {
  const v: JobView = {
    id: j.id, type: j.type as TallyJobType, status: j.status as TallyJobStatus, tallyCompany: j.tallyCompany,
    count: j.status === 'done' ? j.recordCount : null,
    message: j.status === 'failed' ? (JOB_ERRORS[j.error ?? ''] ?? JOB_ERRORS.tally_error) : j.status === 'cancelled' ? JOB_ERRORS.cancelled : null,
    createdAt: j.createdAt.toISOString(),
  }
  if (j.type === 'list-companies' && j.status === 'done') {
    v.companies = companyList(await jobRecords(j))
  }
  return v
}

/** The records a finished job read from Tally, in order. */
export async function jobRecords(j: TallyJob): Promise<Record<string, string>[]> {
  const chunks = await db.tallyJobChunk.findMany({ where: { jobId: j.id, companyId: j.companyId }, orderBy: { seq: 'asc' } })
  return chunks.flatMap((c) => c.records as Record<string, string>[])
}

async function readyConnector(companyId: string): Promise<TallyConnector> {
  const c = await db.tallyConnector.findUnique({ where: { activeFor: companyId } })
  if (!c) throw new ApiError('Tally is not connected — connect it first', 409, 'TALLY_NOT_CONNECTED')
  if (!c.lastSeenAt || Date.now() - c.lastSeenAt.getTime() > ONLINE_WINDOW_MS) throw new ApiError('The Tally connector is offline — start it on your office computer', 409, 'CONNECTOR_OFFLINE')
  if (connectorOutdated(c)) throw new ApiError(`The Tally connector on that computer is too old — install version ${CONNECTOR_MIN_VERSION} or newer`, 409, 'CONNECTOR_OUTDATED')
  if (c.lastTallyStatus !== 'connected') throw new ApiError('The connector is online but cannot reach TallyPrime — open TallyPrime and try again', 409, 'TALLY_UNREACHABLE')
  return c
}

/** The companies in the company's latest finished company list (while its records are kept). */
export async function knownTallyCompanyList(companyId: string): Promise<TallyCompany[]> {
  const last = await db.tallyJob.findFirst({
    where: { companyId, type: 'list-companies', status: 'done', createdAt: { gt: new Date(Date.now() - RETENTION.chunksMs) } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  })
  return last ? companyList(await jobRecords(last)) : []
}

/** The Tally company names in the company's latest finished company list (while its records are kept). */
export async function knownTallyCompanies(companyId: string): Promise<string[]> {
  return (await knownTallyCompanyList(companyId)).map((c) => c.name)
}

/** Financial-year facts of a Tally company from the latest company list, or null if it is not in that list. */
export async function tallyCompanyDates(companyId: string, name: unknown): Promise<{ booksFrom: string | null; startingFrom: string | null } | null> {
  if (typeof name !== 'string' || !name) return null
  const last = await db.tallyJob.findFirst({
    where: { companyId, type: 'list-companies', status: 'done', createdAt: { gt: new Date(Date.now() - RETENTION.chunksMs) } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  })
  const r = last ? (await jobRecords(last)).find((x) => x.name === name) : undefined
  return r ? { booksFrom: r.booksFrom || null, startingFrom: r.startingFrom || null } : null
}

export async function createJob(
  companyId: string, createdBy: string, type: unknown, tallyCompany: unknown, opts: { reuseRecentList?: boolean } = {},
): Promise<JobView> {
  if (!JOB_TYPES.includes(type as TallyJobType)) throw new ApiError('Unknown Tally request', 400)
  const t = type as TallyJobType
  let company: string | null = null
  if (t !== 'list-companies') {
    if (typeof tallyCompany !== 'string' || !tallyCompany.trim()) throw new ApiError('Choose the Tally company first', 400)
    const known = (await knownTallyCompanyList(companyId)).filter((k) => k.name === tallyCompany)
    if (!known.length) {
      throw new ApiError('That company is not in the latest list from Tally — refresh the company list and choose again', 400, 'TALLY_COMPANY_UNKNOWN')
    }
    if (known.some((k) => k.ambiguous)) {
      throw new ApiError('Two companies with this name are open in TallyPrime — close one of them, refresh the list and choose again', 400, 'TALLY_COMPANY_AMBIGUOUS')
    }
    company = tallyCompany
  }
  const c = await readyConnector(companyId)
  if (t === 'list-companies' && opts.reuseRecentList) {
    // Asked for by the screen itself: a list this connector read seconds ago is the answer (no second read of Tally)
    const recent = await db.tallyJob.findFirst({
      where: { companyId, connectorId: c.id, type: t, status: 'done', finishedAt: { gt: new Date(Date.now() - LIST_REUSE_MS) } },
      orderBy: [{ finishedAt: 'desc' }, { id: 'desc' }],
    })
    if (recent) return jobView(recent)
  }
  // One request at a time per connector (row lock), so two tabs asking at the same moment get one job, not two
  const job = await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM TallyConnector WHERE id = ${c.id} FOR UPDATE`
    const open = await tx.tallyJob.findMany({ where: { companyId, status: { in: OPEN_JOB_STATUSES } } })
    // The same request already waiting → reuse it (double clicks, two tabs)
    const same = open.find((j) => j.type === t && j.tallyCompany === company && j.connectorId === c.id)
    if (same) return same
    if (open.length >= MAX_OPEN_JOBS) throw new ApiError('Several Tally requests are still running — wait for them to finish', 429, 'RATE_LIMITED')
    return tx.tallyJob.create({
      data: { id: randomBytes(12).toString('hex'), companyId, connectorId: c.id, type: t, tallyCompany: company, status: 'queued', createdBy, createdAt: now() },
    })
  })
  return jobView(job)
}

export async function getJobFor(companyId: string, id: unknown): Promise<TallyJob> {
  const j = typeof id === 'string' ? await db.tallyJob.findFirst({ where: { id, companyId } }) : null
  if (!j || Date.now() - j.createdAt.getTime() > RETENTION.chunksMs) throw new ApiError('This Tally request was not found — start again', 404)
  return j
}

export async function cancelJob(companyId: string, id: unknown) {
  const j = await getJobFor(companyId, id)
  await db.tallyJob.updateMany({ where: { id: j.id, companyId, status: { in: OPEN_JOB_STATUSES } }, data: { status: 'cancelled', finishedAt: now(), leaseUntil: null } })
  return jobView((await db.tallyJob.findUnique({ where: { id: j.id } }))!)
}

const ERROR_CODES = new Set(Object.keys(JOB_ERRORS).filter((k) => k !== 'cancelled'))
const clean = (s: string) => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim()

/** Connector posts a job's outcome. Only its own running job; records checked field by field. */
export async function recordJobResult(c: TallyConnector, body: Record<string, unknown>) {
  const j = typeof body.jobId === 'string' ? await db.tallyJob.findUnique({ where: { id: body.jobId } }) : null
  if (!j || j.connectorId !== c.id || j.companyId !== c.companyId) throw new ApiError('Unknown job', 404)
  if (j.status !== 'running') return { accepted: false } // cancelled, re-queued or timed out meanwhile — result dropped
  // Only while the job is still running for this connector (a cancel or a re-queue in between wins)
  const finish = (data: { status: TallyJobStatus; error?: string; recordCount?: number }, tx: Pick<typeof db, 'tallyJob'> = db) =>
    tx.tallyJob.updateMany({ where: { id: j.id, connectorId: c.id, status: 'running' }, data: { ...data, finishedAt: now(), leaseUntil: null } })

  if (body.ok !== true) {
    const code = typeof body.error === 'string' && ERROR_CODES.has(body.error) ? body.error : 'tally_error'
    return { accepted: (await finish({ status: 'failed', error: code })).count === 1 }
  }
  if (!Array.isArray(body.records)) throw new ApiError('records must be a list', 400)
  if (body.records.length > MAX_RECORDS) return { accepted: (await finish({ status: 'failed', error: 'too_large' })).count === 1 }
  let records: Record<string, string>[]
  try {
    records = checkRecords(j.type as TallyJobType, body.records)
  } catch (e) {
    await finish({ status: 'failed', error: 'bad_response' })
    throw e
  }
  // The records and the "done" status are written together
  const accepted = await db.$transaction(async (tx) => {
    if ((await finish({ status: 'done', recordCount: records.length }, tx)).count !== 1) return false
    const at = now()
    for (let seq = 0; seq * CHUNK_RECORDS < records.length; seq++) {
      await tx.tallyJobChunk.create({
        data: { jobId: j.id, companyId: j.companyId, seq, records: records.slice(seq * CHUNK_RECORDS, (seq + 1) * CHUNK_RECORDS), createdAt: at },
      })
    }
    return true
  })
  if (!accepted) return { accepted }
  // Layer 1 copy of the masters (never ManuFlow's business tables). A failure here does not undo the read: the records
  // stay available, and reading again stages them again (idempotent).
  try {
    const { staged, markedMissing } = await stageMasters(j, records)
    return { accepted, staged, markedMissing }
  } catch (e) {
    // Only the error code: database messages can contain the data itself
    console.error('[tally] staging the source copy failed', { jobId: j.id, error: (e as { code?: string })?.code ?? (e instanceof Error ? e.name : 'unknown') })
    return { accepted, staged: null }
  }
}

function checkRecords(type: TallyJobType, list: unknown[]): Record<string, string>[] {
  const allowed = FIELDS[type]
  const records: Record<string, string>[] = []
  for (const raw of list) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ApiError('Malformed record', 400)
    const r: Record<string, string> = {}
    for (const [k, max] of Object.entries(allowed)) {
      const v = (raw as Record<string, unknown>)[k]
      if (v === undefined || v === null) continue
      if (typeof v !== 'string') throw new ApiError(`Field ${k} must be text`, 400)
      const s = clean(v)
      if (s.length > max) throw new ApiError(`Field ${k} is too long`, 400)
      if (s) r[k] = s
    }
    if (!r.name) continue // nameless entries cannot be imported or shown
    records.push(r)
  }
  return records
}
