import { companyRequired, handleError, ok, requireWrite } from '@/lib/erp-helpers'
import { assertConnectorEnabled, markWatching } from '@/lib/tally/connector'
import { queueBillPush, queueVoucherPush } from '@/lib/tally/push'

// POST /api/import-center/tally/push { companyId, invoiceId } or { companyId, billId } → JobView (queued)
//
// Sends one sales invoice **or** one purchase bill to TallyPrime through the paired connector. The
// server builds the Import envelope from the document (the same builders the XML download uses) —
// the browser never supplies XML, and the connector only posts what it is given. Poll
// GET /api/import-center/tally/jobs?id=… for the outcome.
//
// Permissions follow the document: pushing a bill needs the purchase-invoice right, pushing an
// invoice the sales-invoice right, and both need the Import Center right. Needs TALLY_CONNECTOR_PUSH=1.
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
    const billId = typeof body.billId === 'string' ? body.billId.trim() : ''
    const actor = requireWrite(req, billId ? 'purchase-invoices' : 'sales-invoices')
    requireWrite(req, 'import-center')
    const companyId = await companyRequired(req, typeof body.companyId === 'string' ? body.companyId : undefined)
    assertConnectorEnabled()
    markWatching(companyId)
    if (billId) {
      const job = await queueBillPush(companyId, actor.userId, billId)
      return ok(job, job.voucherNumber ? `Sending bill ${job.voucherNumber} to Tally` : 'This bill is already on its way to Tally')
    }
    const job = await queueVoucherPush(companyId, actor.userId, body.invoiceId)
    return ok(job, job.voucherNumber ? `Sending ${job.voucherNumber} to Tally` : 'This invoice is already on its way to Tally')
  } catch (e) {
    return handleError(e)
  }
}
