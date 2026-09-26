import { db } from '@/lib/db'
import { ok, fail, handleError, companyRequired, nextDocNumber, computeGst, isInterState, postStock, logAudit, notify, ApiError, r2, requireWrite } from '@/lib/erp-helpers'

// SalesInvoiceItem carries only itemId (no Prisma relation to Item) — attach master info via JS mapping
async function withItemInfo<T extends { items: { itemId: string }[] }>(companyId: string, docs: T[]) {
  const ids = Array.from(new Set(docs.flatMap((d) => d.items.map((i) => i.itemId))))
  const masters = ids.length
    ? await db.item.findMany({ where: { companyId, id: { in: ids } }, select: { id: true, code: true, name: true, uom: true, hsn: true } })
    : []
  const map = new Map(masters.map((m) => [m.id, m]))
  return docs.map((d) => ({ ...d, items: d.items.map((i) => ({ ...i, item: map.get(i.itemId) || null })) }))
}

// Mock e-invoice gateway helpers
function randomHex(byteCount: number): string {
  const buf = new Uint8Array(byteCount)
  crypto.getRandomValues(buf)
  return Array.from(buf).map((b) => b.toString(16).padStart(2, '0')).join('')
}
function generateIrn(): string {
  return 'IRN' + randomHex(20) // IRN + 40 hex chars
}
function generateEwayBillNo(): string {
  const buf = new Uint32Array(1)
  crypto.getRandomValues(buf)
  return String(100000000000 + (buf[0] % 900000000000)) // 12-digit number
}

// GET /api/sales-invoices/[id]?companyId=  — full detail incl customer + hsn (used for GST invoice print)
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const companyId = await companyRequired(req)
    const invoice = await db.salesInvoice.findFirst({
      where: { id, companyId },
      include: {
        customer: true,
        salesOrder: { select: { id: true, number: true, orderDate: true } },
        items: true,
      },
    })
    if (!invoice) throw new ApiError('Invoice not found', 404)
    const company = await db.company.findUnique({
      where: { id: companyId },
      select: { name: true, gstin: true, pan: true, addressLine: true, city: true, state: true, stateCode: true, phone: true, email: true, logoText: true, bankAccountName: true, bankAccountNumber: true, bankIfsc: true, bankUpiId: true },
    })
    const [row] = await withItemInfo(companyId, [{ ...invoice, company }])
    return ok(row)
  } catch (e) {
    return handleError(e)
  }
}

// PATCH /api/sales-invoices/[id]
//  - { action: 'cancel' }          : → CANCELLED (blocked if paidAmount > 0)
//  - { action: 'generate-irn' }    : mock E-Invoice/EWB gateway → sets irn + ewayBillNo
//  - { irn?, ewayBillNo? }         : direct set (e.g. from real gateway response)
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireWrite(req, 'sales-invoices')
    const { id } = await params
    const body = await req.json().catch(() => ({}) as any)
    const companyId = await companyRequired(req, body.companyId)

    const current = await db.salesInvoice.findFirst({ where: { id, companyId } })
    if (!current) throw new ApiError('Invoice not found', 404)
    if (current.status === 'CANCELLED') throw new ApiError('Invoice is cancelled', 400)

    // ---- Cancel ----
    if (body.action === 'cancel') {
      if (current.paidAmount > 0.005) throw new ApiError('Cannot cancel invoice with payments recorded', 400)
      const updated = await db.$transaction(async (tx) => {
        const t = tx as any
        // Atomic claim: only while still unpaid, so a payment landing concurrently can't be lost
        const claim = await tx.salesInvoice.updateMany({
          where: { id, status: { in: ['UNPAID', 'PARTIALLY_PAID', 'PAID'] }, paidAmount: { lte: 0.005 } },
          data: { status: 'CANCELLED' },
        })
        if (claim.count !== 1) throw new ApiError('This invoice was just changed (payment or cancel) — refresh and try again', 409)

        // Roll back SO invoicedQty (POST increments it; it does not change SO status)
        if (current.salesOrderId) {
          const invItems = await tx.salesInvoiceItem.findMany({ where: { invoiceId: id } })
          const soItems = await tx.salesOrderItem.findMany({ where: { salesOrderId: current.salesOrderId } })
          const byItem = new Map<string, number>()
          for (const l of invItems) byItem.set(l.itemId, r2((byItem.get(l.itemId) || 0) + l.qty))
          // Reverse SO line order — mirrors the forward allocation in POST
          for (const si of [...soItems].reverse()) {
            const want = byItem.get(si.itemId)
            if (!want) continue
            const back = Math.min(want, Math.max(0, r2(si.invoicedQty)))
            if (back > 0) {
              await tx.salesOrderItem.update({ where: { id: si.id }, data: { invoicedQty: { decrement: back } } })
              byItem.set(si.itemId, r2(want - back))
            }
          }
        }

        const u = await tx.salesInvoice.findUniqueOrThrow({ where: { id } })
        await logAudit(t, {
          companyId, userName: body.userName, action: 'CANCEL', entity: 'SalesInvoice', entityId: id,
          details: `Cancelled tax invoice ${current.number}`,
        })
        return u
      })
      return ok(updated, 'Invoice cancelled')
    }

    // ---- Generate IRN (mock integration) ----
    if (body.action === 'generate-irn') {
      if (current.irn) throw new ApiError('IRN already generated for this invoice', 400)
      const irn = generateIrn()
      const ewayBillNo = generateEwayBillNo()
      const updated = await db.$transaction(async (tx) => {
        const t = tx as any
        // Only while no IRN is set and the invoice is live
        const set = await tx.salesInvoice.updateMany({
          where: { id, status: { not: 'CANCELLED' }, OR: [{ irn: null }, { irn: '' }] },
          data: { irn, ewayBillNo },
        })
        if (set.count !== 1) throw new ApiError('This invoice was just changed by someone else — refresh and try again', 409)
        const u = await tx.salesInvoice.findUniqueOrThrow({ where: { id } })
        await logAudit(t, {
          companyId, userName: body.userName, action: 'POST', entity: 'SalesInvoice', entityId: id,
          details: `E-Invoice generated (mock gateway) for ${current.number} • IRN ${irn} • EWB ${ewayBillNo}`,
        })
        return u
      })
      return ok(updated, 'IRN + E-Way Bill generated')
    }

    // ---- Direct set of gateway fields (only fills empty fields; never overwrites) ----
    if (body.irn !== undefined || body.ewayBillNo !== undefined) {
      const irn = typeof body.irn === 'string' ? body.irn.trim() : ''
      const ewb = typeof body.ewayBillNo === 'string' ? body.ewayBillNo.trim() : ''
      if (body.irn !== undefined && !irn) throw new ApiError('irn must be a non-empty string', 400)
      if (body.ewayBillNo !== undefined && !ewb) throw new ApiError('ewayBillNo must be a non-empty string', 400)
      if (irn && current.irn) throw new ApiError('IRN is already set on this invoice and cannot be changed', 400)
      if (ewb && current.ewayBillNo) throw new ApiError('E-Way Bill no. is already set on this invoice and cannot be changed', 400)
      const data: any = {}
      const where: any = { id, status: { not: 'CANCELLED' }, AND: [] as any[] }
      if (irn) { data.irn = irn; where.AND.push({ OR: [{ irn: null }, { irn: '' }] }) }
      if (ewb) { data.ewayBillNo = ewb; where.AND.push({ OR: [{ ewayBillNo: null }, { ewayBillNo: '' }] }) }
      const updated = await db.$transaction(async (tx) => {
        const t = tx as any
        const set = await tx.salesInvoice.updateMany({ where, data })
        if (set.count !== 1) throw new ApiError('This invoice was just changed by someone else — refresh and try again', 409)
        const u = await tx.salesInvoice.findUniqueOrThrow({ where: { id } })
        await logAudit(t, {
          companyId, userName: body.userName, action: 'UPDATE', entity: 'SalesInvoice', entityId: id,
          details: `Updated e-invoice refs on ${current.number}`,
        })
        return u
      })
      return ok(updated, 'Invoice updated')
    }

    throw new ApiError('Nothing to update — use action=cancel | generate-irn, or send irn/ewayBillNo', 400)
  } catch (e) {
    return handleError(e)
  }
}

// NOTE: no DELETE — tax invoices are cancelled, never deleted.
