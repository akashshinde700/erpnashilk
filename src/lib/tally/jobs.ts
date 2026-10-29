import { randomBytes } from 'node:crypto'
import { ApiError } from '@/lib/erp-helpers'
import {
  ONLINE_WINDOW_MS, connectorStore, type ConnectorRecord, type ConnectorStore, type TallyJobRecord, type TallyJobType,
} from '@/lib/tally/connector'

/**
 * Named, read-only jobs for the Tally connector (proof of concept, in memory — see connector.ts).
 *
 * The browser asks for a job by name; the server checks that the company's connector is online and reaching Tally,
 * and that an export names a Tally company from Tally's own latest company list. The connector picks the job up with
 * its next heartbeat, builds the fixed Export XML itself and posts back normalised records (validated here: known
 * fields only, size-capped). Records stay in memory for 30 minutes and are only read by the import route.
 */

export const JOB_TYPES: TallyJobType[] = ['list-companies', 'export-customers', 'export-suppliers', 'export-items']
export const EXPORT_JOB: Record<'customers' | 'suppliers' | 'items', TallyJobType> = {
  customers: 'export-customers', suppliers: 'export-suppliers', items: 'export-items',
}
export const MAX_RECORDS = 20_000
const MAX_OPEN_JOBS = 6

const FIELDS: Record<TallyJobType, Record<string, number>> = {
  'list-companies': { name: 200, booksFrom: 10, startingFrom: 10 },
  'export-customers': partyFields(),
  'export-suppliers': partyFields(),
  'export-items': { guid: 100, name: 200, parent: 200, unit: 50, hsn: 20, gstRate: 10 },
}
function partyFields() {
  return {
    guid: 100, name: 200, parent: 200, gstin: 20, gstType: 40, pan: 20, phone: 50, email: 200,
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
  status: TallyJobRecord['status']
  tallyCompany: string | null
  count: number | null
  message: string | null
  createdAt: string
  /** list-companies only: the companies Tally returned (real data, never a sample). */
  companies?: { name: string; booksFrom: string | null; startingFrom: string | null }[]
}

export function jobView(j: TallyJobRecord): JobView {
  const v: JobView = {
    id: j.id, type: j.type, status: j.status, tallyCompany: j.tallyCompany,
    count: j.records ? j.records.length : null,
    message: j.status === 'failed' ? (JOB_ERRORS[j.error ?? ''] ?? JOB_ERRORS.tally_error) : j.status === 'cancelled' ? JOB_ERRORS.cancelled : null,
    createdAt: new Date(j.createdAt).toISOString(),
  }
  if (j.type === 'list-companies' && j.status === 'done') {
    v.companies = (j.records ?? []).map((r) => ({ name: r.name, booksFrom: r.booksFrom || null, startingFrom: r.startingFrom || null }))
  }
  return v
}

async function readyConnector(companyId: string, store: ConnectorStore): Promise<ConnectorRecord> {
  const c = await store.activeConnector(companyId)
  if (!c) throw new ApiError('Tally is not connected — connect it first', 409, 'TALLY_NOT_CONNECTED')
  if (!c.lastSeenAt || Date.now() - c.lastSeenAt > ONLINE_WINDOW_MS) throw new ApiError('The Tally connector is offline — start it on your office computer', 409, 'CONNECTOR_OFFLINE')
  if (c.lastTallyStatus !== 'connected') throw new ApiError('The connector is online but cannot reach TallyPrime — open TallyPrime and try again', 409, 'TALLY_UNREACHABLE')
  return c
}

/** The Tally company names in the company's latest finished company list. */
export async function knownTallyCompanies(companyId: string, store = connectorStore()): Promise<string[]> {
  const lists = (await store.jobsOf(companyId)).filter((j) => j.type === 'list-companies' && j.status === 'done').sort((a, b) => b.createdAt - a.createdAt)
  return (lists[0]?.records ?? []).map((r) => r.name)
}

export async function createJob(companyId: string, createdBy: string, type: unknown, tallyCompany: unknown, store = connectorStore()): Promise<JobView> {
  if (!JOB_TYPES.includes(type as TallyJobType)) throw new ApiError('Unknown Tally request', 400)
  const t = type as TallyJobType
  let company: string | null = null
  if (t !== 'list-companies') {
    if (typeof tallyCompany !== 'string' || !tallyCompany.trim()) throw new ApiError('Choose the Tally company first', 400)
    if (!(await knownTallyCompanies(companyId, store)).includes(tallyCompany)) {
      throw new ApiError('That company is not in the latest list from Tally — refresh the company list and choose again', 400, 'TALLY_COMPANY_UNKNOWN')
    }
    company = tallyCompany
  }
  const c = await readyConnector(companyId, store)
  const open = (await store.jobsOf(companyId)).filter((j) => j.status === 'queued' || j.status === 'running')
  // The same request already waiting → reuse it (double clicks, two tabs)
  const same = open.find((j) => j.type === t && j.tallyCompany === company && j.connectorId === c.id)
  if (same) return jobView(same)
  if (open.length >= MAX_OPEN_JOBS) throw new ApiError('Several Tally requests are still running — wait for them to finish', 429, 'RATE_LIMITED')
  const job: TallyJobRecord = {
    id: randomBytes(12).toString('hex'), companyId, connectorId: c.id, type: t, tallyCompany: company, status: 'queued',
    createdBy, createdAt: Date.now(), startedAt: null, finishedAt: null, error: null, records: null,
  }
  await store.putJob(job)
  return jobView(job)
}

export async function getJobFor(companyId: string, id: unknown, store = connectorStore()): Promise<TallyJobRecord> {
  const j = typeof id === 'string' ? await store.getJob(id) : null
  if (!j || j.companyId !== companyId || Date.now() - j.createdAt > 30 * 60 * 1000) throw new ApiError('This Tally request was not found — start again', 404)
  return j
}

export async function cancelJob(companyId: string, id: unknown, store = connectorStore()) {
  const j = await getJobFor(companyId, id, store)
  if (j.status === 'queued' || j.status === 'running') await store.updateJob(j.id, { status: 'cancelled', finishedAt: Date.now() })
  return jobView((await store.getJob(j.id))!)
}

const ERROR_CODES = new Set(Object.keys(JOB_ERRORS).filter((k) => k !== 'cancelled'))
const clean = (s: string) => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim()

/** Connector posts a job's outcome. Only its own running job; records checked field by field. */
export async function recordJobResult(c: ConnectorRecord, body: Record<string, unknown>, store = connectorStore()) {
  const j = typeof body.jobId === 'string' ? await store.getJob(body.jobId) : null
  if (!j || j.connectorId !== c.id || j.companyId !== c.companyId) throw new ApiError('Unknown job', 404)
  if (j.status !== 'running') return { accepted: false } // cancelled or timed out meanwhile — result dropped
  if (body.ok !== true) {
    const code = typeof body.error === 'string' && ERROR_CODES.has(body.error) ? body.error : 'tally_error'
    await store.updateJob(j.id, { status: 'failed', error: code, finishedAt: Date.now() })
    return { accepted: true }
  }
  if (!Array.isArray(body.records)) throw new ApiError('records must be a list', 400)
  if (body.records.length > MAX_RECORDS) {
    await store.updateJob(j.id, { status: 'failed', error: 'too_large', finishedAt: Date.now() })
    return { accepted: true }
  }
  let records: Record<string, string>[]
  try {
    records = checkRecords(j.type, body.records)
  } catch (e) {
    await store.updateJob(j.id, { status: 'failed', error: 'bad_response', finishedAt: Date.now() })
    throw e
  }
  await store.updateJob(j.id, { status: 'done', records, finishedAt: Date.now() })
  return { accepted: true }
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
