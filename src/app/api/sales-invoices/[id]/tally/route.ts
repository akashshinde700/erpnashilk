import * as XLSX from 'xlsx'
import { db } from '@/lib/db'
import { logAudit, companyRequired, handleError, ok, ApiError, requireRead, requireWrite } from '@/lib/erp-helpers'
import { buildTallyVoucher, ledgerNames, voucherFileName, voucherRows, voucherToXml } from '@/lib/tally/voucher'
import { loadTallyInvoice } from '@/lib/tally/load-invoice'

/**
 * GET /api/sales-invoices/[id]/tally?format=xml|json|excel
 *
 * Exports one sales invoice as a TallyPrime import voucher. Ported from the
 * Sheetaldies ERP (`/invoices/:id/tally-xml`, `/tally-json`, `/tally-excel`).
 *
 * `format=xml` (default) and `format=json` download a file; `format=excel` builds a
 * check-sheet with one row per item / ledger line. `?preview=1` returns the voucher
 * model as JSON in the usual API envelope instead of a download (used by the UI to
 * show the warnings before saving the file).
 *
 * The ledger names come from the company settings, then TALLY_LEDGER_* env vars,
 * then the standard defaults — Tally never creates a master on import, so a name
 * that does not exist in that Tally company fails the whole voucher.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireRead(req, ['sales-invoices', 'receivables', 'gst-report'])
    const { id } = await params
    const companyId = await companyRequired(req)
    const { searchParams } = new URL(req.url)
    const format = (searchParams.get('format') || 'xml').toLowerCase()
    const preview = searchParams.get('preview') === '1'

    const { invoice, company } = await loadTallyInvoice(id, companyId)
    const voucher = buildTallyVoucher(invoice as any, company as any, ledgerNames(company as any))

    if (preview) return ok({ voucher, ledgerNames: ledgerNames(company as any) })

    // Remember that the import file went out — the invoice screen shows it.
    if (!invoice.tallySentAt) {
      await db.salesInvoice.update({ where: { id: invoice.id }, data: { tallyXmlDownloadedAt: new Date() } })
    }

    if (format === 'json') {
      return new Response(JSON.stringify(voucher, null, 2), {
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition': `attachment; filename="${voucherFileName(voucher.voucherNumber, 'json')}"`,
        },
      })
    }

    if (format === 'excel') {
      const wb = XLSX.utils.book_new()
      const ws = XLSX.utils.aoa_to_sheet(voucherRows(voucher))
      XLSX.utils.book_append_sheet(wb, ws, 'Voucher')
      const summary = [
        ['Invoice No', voucher.voucherNumber],
        ['Date', voucher.dateISO],
        ['Party', voucher.party],
        ['Party GSTIN', voucher.partyGstin],
        ['Company', voucher.company || ''],
        ['Sales Ledger', voucher.items[0]?.salesLedger || ''],
        ['Taxable Value', voucher.subtotal],
        ...voucher.entries.filter((e) => !e.isParty).map((e) => [e.ledger, e.amount] as (string | number)[]),
        ['Grand Total', voucher.grandTotal],
      ]
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(summary), 'Summary')
      const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer
      return new Response(new Uint8Array(buf), {
        headers: {
          'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'Content-Disposition': `attachment; filename="${voucherFileName(voucher.voucherNumber, 'xlsx')}"`,
        },
      })
    }

    if (format !== 'xml') throw new ApiError('format must be xml, json or excel', 400)
    return new Response(voucherToXml(voucher, company.tallyCompanyName), {
      headers: {
        'Content-Type': 'application/xml; charset=utf-8',
        'Content-Disposition': `attachment; filename="${voucherFileName(voucher.voucherNumber, 'xml')}"`,
      },
    })
  } catch (e) {
    return handleError(e)
  }
}

/**
 * POST /api/sales-invoices/[id]/tally
 *   { action: 'mark-sent' }  — record that the voucher was imported into Tally
 *   { action: 'unmark' }     — undo that (before the books are closed)
 *
 * Deliberately no "push to a URL" here: a request-supplied URL would let any user
 * make the server call an internal address (SSRF). Installs that run ManuFlow on
 * the same network as Tally use the connector's TALLY_HTTP_URL setting instead.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireWrite(req, 'sales-invoices')
    const { id } = await params
    const body = await req.json().catch(() => ({}) as Record<string, unknown>)
    const companyId = await companyRequired(req, (body as any).companyId)
    const action = String((body as any).action || 'mark-sent')

    const invoice = await db.salesInvoice.findFirst({ where: { id, companyId }, select: { id: true, number: true, status: true, tallySentAt: true } })
    if (!invoice) throw new ApiError('Invoice not found', 404)
    if (invoice.status === 'CANCELLED') throw new ApiError('Invoice is cancelled', 400)

    if (action === 'unmark') {
      const updated = await db.$transaction(async (tx) => {
        const u = await tx.salesInvoice.update({ where: { id }, data: { tallySentAt: null } })
        await logAudit(tx as any, {
          companyId, action: 'UPDATE', entity: 'SalesInvoice', entityId: id,
          details: `Cleared the "sent to Tally" mark on ${invoice.number}`,
        })
        return u
      })
      return ok(updated, 'Tally mark cleared')
    }

    if (action !== 'mark-sent') throw new ApiError('action must be mark-sent or unmark', 400)

    const updated = await db.$transaction(async (tx) => {
      const u = await tx.salesInvoice.update({ where: { id }, data: { tallySentAt: new Date() } })
      await logAudit(tx as any, {
        companyId, action: 'UPDATE', entity: 'SalesInvoice', entityId: id,
        details: `Marked ${invoice.number} as imported into Tally`,
      })
      return u
    })
    return ok(updated, 'Marked as sent to Tally')
  } catch (e) {
    return handleError(e)
  }
}
