import { companyRequired, handleError, ok, requireWrite } from '@/lib/erp-helpers'
import { assertConnectorEnabled, markWatching } from '@/lib/tally/connector'
import { queueVoucherPush } from '@/lib/tally/push'

// POST /api/import-center/tally/push { companyId, invoiceId } → JobView (queued)
//
// Sends one sales invoice to TallyPrime through the paired connector. The server builds the Import
// envelope from the invoice (the same builder the XML download uses) — the browser never supplies
// XML, and the connector only posts what it is given. Poll GET /api/import-center/tally/jobs?id=…
// for the outcome. Needs the same write right as raising an invoice.
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
    const actor = requireWrite(req, 'sales-invoices')
    requireWrite(req, 'import-center')
    const companyId = await companyRequired(req, typeof body.companyId === 'string' ? body.companyId : undefined)
    assertConnectorEnabled()
    markWatching(companyId)
    const job = await queueVoucherPush(companyId, actor.userId, body.invoiceId)
    return ok(job, job.voucherNumber ? `Sending ${job.voucherNumber} to Tally` : 'This invoice is already on its way to Tally')
  } catch (e) {
    return handleError(e)
  }
}
