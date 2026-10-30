import { db } from '@/lib/db'
import { companyRequired, handleError, ok, ApiError, requireRead } from '@/lib/erp-helpers'
import { buildEInvoiceJson, einvoiceFileName, validateForIrp } from '@/lib/einvoice'

/**
 * GET /api/sales-invoices/[id]/einvoice
 *
 * The NIC "Invoice Bulk Upload" JSON (schema v1.1) for one invoice, ready to be
 * uploaded at https://einvoice1.gst.gov.in/Invoice/BulkUpload.
 *
 * Ported from the Sheetaldies ERP (`/invoices/:id/einvoice-json` and
 * `/einvoice-check`). Two knobs:
 *
 *   ?check=1   — do not build the file: return { ready, problems } so the screen
 *                can warn before the portal's error report does.
 *   ?preview=1 — return the JSON in the API envelope (for tests), no download.
 *
 * A download always succeeds even when `problems` is non-empty — the portal is the
 * final authority — but the problems ride along in `X-EInvoice-Warnings` so the UI
 * can show them.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireRead(req, ['sales-invoices', 'receivables', 'gst-report'])
    const { id } = await params
    const companyId = await companyRequired(req)
    const { searchParams } = new URL(req.url)
    const check = searchParams.get('check') === '1'
    const preview = searchParams.get('preview') === '1'

    const invoice = await db.salesInvoice.findFirst({
      where: { id, companyId },
      include: {
        customer: { select: { name: true, gstin: true, addressLine: true, addressLine2: true, city: true, state: true, stateCode: true, pincode: true, phone: true, email: true } },
        items: true,
      },
    })
    if (!invoice) throw new ApiError('Invoice not found', 404)

    const company = await db.company.findUnique({
      where: { id: companyId },
      select: { name: true, gstin: true, addressLine: true, city: true, state: true, stateCode: true, pincode: true, phone: true, email: true },
    })
    if (!company) throw new ApiError('Company not found', 404)

    // HSN lives on the item master (the invoice line only stores an override)
    const itemIds = Array.from(new Set(invoice.items.map((i) => i.itemId)))
    type ItemMaster = { id: string; name: string; hsn: string | null; uom: string }
    const masters: ItemMaster[] = itemIds.length
      ? await db.item.findMany({ where: { companyId, id: { in: itemIds } }, select: { id: true, name: true, hsn: true, uom: true } })
      : []
    const byId = new Map(masters.map((m) => [m.id, m]))

    const payload = {
      ...invoice,
      items: invoice.items.map((line) => {
        const master = byId.get(line.itemId)
        return {
          ...line,
          hsn: line.hsn || master?.hsn || '',
          uom: master?.uom || 'NOS',
          itemName: master?.name || '',
          amount: line.lineTotal,
        }
      }),
    }

    const problems = validateForIrp(payload as any, company as any)

    if (check) return ok({ ready: problems.length === 0, problems })

    const json = buildEInvoiceJson(payload as any, company as any)
    if (preview) return ok({ json, problems })

    const headers: Record<string, string> = {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${einvoiceFileName(invoice.number)}"`,
      'Access-Control-Expose-Headers': 'X-EInvoice-Warnings',
    }
    // encodeURIComponent keeps the header ASCII-only (portal-ready JSON is UTF-8)
    if (problems.length) headers['X-EInvoice-Warnings'] = encodeURIComponent(JSON.stringify(problems))

    return new Response(JSON.stringify(json, null, 2), { headers })
  } catch (e) {
    return handleError(e)
  }
}
