import { randomBytes } from 'node:crypto'
import { ApiError } from '@/lib/erp-helpers'
import {
  ONLINE_WINDOW_MS, connectorStore, type ConnectorRecord, type ConnectorStore, type TallyJobRecord,
} from '@/lib/tally/connector'
import { buildTallyVoucher, ledgerNames, voucherToXml } from '@/lib/tally/voucher'
import { loadTallyInvoice } from '@/lib/tally/load-invoice'
import { MAX_OPEN_JOBS, jobView, type JobView } from '@/lib/tally/jobs'
import { MAX_PUSH_XML_BYTES, PUSH_FLAG, checkPushXml, pushEnabled } from '@/lib/tally/push-xml'

export { MAX_PUSH_XML_BYTES, PUSH_FLAG, checkPushXml, pushEnabled }

/** Throws unless the deployment opted in (`TALLY_CONNECTOR_PUSH=1`). */
export function assertPushEnabled(env: NodeJS.ProcessEnv = process.env) {
  if (!pushEnabled(env)) {
    throw new ApiError('Push to Tally is not switched on for this server (set TALLY_CONNECTOR_PUSH=1)', 503, 'TALLY_PUSH_DISABLED')
  }
}

/**
 * Push one sales invoice into TallyPrime through the paired connector.
 *
 * This is the mirror image of the file download: the same voucher builder
 * (`buildTallyVoucher` → `voucherToXml`) produces one Tally Import envelope, the server keeps it in
 * the job queue, and the connector posts that exact document to Tally (it never builds an Import
 * request of its own, and the browser never sees or supplies XML).
 *
 * Off by default: the connector is a proof of concept and this direction *writes* into the
 * customer's books, so a deployment has to opt in with `TALLY_CONNECTOR_PUSH=1` (and, for the
 * connector itself, `TALLY_CONNECTOR_POC=1`).
 */

/** The XML the connector will post for this invoice, plus the voucher it came from. */
export async function buildPushPayload(invoiceId: string, companyId: string) {
  const { invoice, company } = await loadTallyInvoice(invoiceId, companyId)
  if (invoice.status === 'CANCELLED') throw new ApiError('A cancelled invoice cannot be pushed to Tally', 400)
  const voucher = buildTallyVoucher(invoice as never, company as never, ledgerNames(company as never))
  const xml = voucherToXml(voucher, company.tallyCompanyName || null)
  const problem = checkPushXml(xml)
  if (problem) throw new ApiError(`Could not prepare the Tally voucher (${problem})`, 500, 'TALLY_PUSH_BUILD_FAILED')
  return { voucher, xml }
}

/** The company's connector must exist, be alive and be reaching Tally right now. */
async function readyConnector(companyId: string, store: ConnectorStore): Promise<ConnectorRecord> {
  const c = await store.activeConnector(companyId)
  if (!c) throw new ApiError('Tally is not connected — connect it first', 409, 'TALLY_NOT_CONNECTED')
  if (!c.lastSeenAt || Date.now() - c.lastSeenAt > ONLINE_WINDOW_MS) {
    throw new ApiError('The Tally connector is offline — start it on your office computer', 409, 'CONNECTOR_OFFLINE')
  }
  if (c.lastTallyStatus !== 'connected') {
    throw new ApiError('The connector is online but cannot reach TallyPrime — open TallyPrime and try again', 409, 'TALLY_UNREACHABLE')
  }
  return c
}

/**
 * Queue the invoice for the connector. Pushing the same invoice twice while a job is still
 * waiting returns the waiting job instead of creating a second voucher in Tally.
 */
export async function queueVoucherPush(
  companyId: string,
  createdBy: string,
  invoiceId: unknown,
  store: ConnectorStore = connectorStore(),
): Promise<JobView & { voucherNumber: string }> {
  assertPushEnabled()
  const id = typeof invoiceId === 'string' ? invoiceId.trim() : ''
  if (!id) throw new ApiError('invoiceId is required', 400)
  const c = await readyConnector(companyId, store)

  const open = (await store.jobsOf(companyId)).filter((j) => j.status === 'queued' || j.status === 'running')
  const same = open.find((j) => j.type === 'push-voucher' && j.targetId === id && j.connectorId === c.id)
  if (same) return { ...jobView(same), voucherNumber: '' }
  if (open.length >= MAX_OPEN_JOBS) throw new ApiError('Several Tally requests are still running — wait for them to finish', 429, 'RATE_LIMITED')

  const { voucher, xml } = await buildPushPayload(id, companyId)
  const job: TallyJobRecord = {
    id: randomBytes(12).toString('hex'),
    companyId,
    connectorId: c.id,
    type: 'push-voucher',
    tallyCompany: null,
    status: 'queued',
    createdBy,
    createdAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    error: null,
    records: null,
    payload: xml,
    targetId: id,
  }
  await store.putJob(job)
  return { ...jobView(job), voucherNumber: voucher.voucherNumber }
}
