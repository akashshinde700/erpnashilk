import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import {
  ok, handleError, companyRequired, nextDocNumber, computeGst, isInterState, logAudit, ApiError, r2, requireWrite,
} from '@/lib/erp-helpers'

// prisma 6.x generated delegates are not structurally assignable to the shared helpers' minimal
// tx types — intersect once and cast the transaction client at the boundary.
type HelperTx = Prisma.TransactionClient & Parameters<typeof nextDocNumber>[0] & Parameters<typeof logAudit>[0]

// Line items carry only itemId (no Item relation in schema) — attach {code,name,uom} for the UI.
async function attachItemInfo<T extends { items: { itemId: string }[] }>(companyId: string, docs: T[]) {
  const ids = Array.from(new Set(docs.flatMap((d) => d.items.map((i) => i.itemId))))
  const items = ids.length
    ? await db.item.findMany({ where: { companyId, id: { in: ids } }, select: { id: true, code: true, name: true, uom: true } })
    : []
  const map = new Map(items.map((i) => [i.id, i]))
  return docs.map((d) => ({ ...d, items: d.items.map((i) => ({ ...i, item: map.get(i.itemId) || null })) }))
}

function toDate(v: unknown): Date | null {
  if (!v) return null
  const d = new Date(String(v))
  return Number.isNaN(d.getTime()) ? null : d
}

interface PinvLineInput { itemId?: string; qty?: number | string; rate?: number | string; gstRate?: number | string }

// ============================== GET /api/purchase-invoices ==============================
export async function GET(req: Request) {
  try {
    const companyId = await companyRequired(req)
    const { searchParams } = new URL(req.url)
    const status = searchParams.get('status') || ''
    const q = searchParams.get('q') || ''
    const where: Prisma.PurchaseInvoiceWhereInput = { companyId }
    if (status) where.status = status
    if (q) {
      where.OR = [
        { number: { contains: q } },
        { supplierInvNo: { contains: q } },
        { supplier: { is: { name: { contains: q } } } },
        { po: { is: { number: { contains: q } } } },
      ]
    }
    const rows = await db.purchaseInvoice.findMany({
      where,
      orderBy: { date: 'desc' },
      include: {
        supplier: { select: { id: true, code: true, name: true } },
        po: { select: { id: true, number: true } },
        items: true,
      },
    })
    return ok({ items: await attachItemInfo(companyId, rows), total: rows.length })
  } catch (e) {
    return handleError(e)
  }
}

// ============================== POST /api/purchase-invoices ==============================
export async function POST(req: Request) {
  try {
    requireWrite(req, 'purchase-invoices')
    const body = await req.json()
    const companyId = await companyRequired(req, body.companyId)
    const date = toDate(body.date) || new Date()

    const pinv = await db.$transaction(async (txRaw) => {
      const tx = txRaw as HelperTx
      // Resolve PO first (its items seed the invoice lines when no explicit lines are sent)
      let po: {
        id: string; number: string; supplierId: string; status: string
        items: { itemId: string; qty: number; rate: number; gstRate: number }[]
      } | null = null
      if (body.poId) {
        po = await tx.purchaseOrder.findFirst({ where: { id: body.poId, companyId }, include: { items: true } })
        if (!po) throw new ApiError('Purchase order not found', 404)
      }

      let lines: PinvLineInput[] = Array.isArray(body.lines) && body.lines.length ? body.lines : []
      if (body.poId && !lines.length && po) {
        // Full item qty invoiced per PO line
        lines = po.items.map((p) => ({ itemId: p.itemId, qty: p.qty, rate: p.rate, gstRate: p.gstRate }))
      }
      if (!lines.length) throw new ApiError('At least one invoice line is required', 400)
      for (const l of lines) {
        if (!l.itemId) throw new ApiError('itemId is required on every line', 400)
        if (!(Number(l.qty) > 0)) throw new ApiError('Line qty must be greater than 0', 400)
        if (!(Number(l.rate) >= 0)) throw new ApiError('Line rate must be 0 or more', 400)
      }
      const ids = Array.from(new Set(lines.map((l) => l.itemId as string)))
      const itemCount = await tx.item.count({ where: { companyId, id: { in: ids } } })
      if (itemCount !== ids.length) throw new ApiError('One or more itemId values are invalid for this company', 400)

      const supplierId = body.supplierId || (po ? po.supplierId : null)
      if (!supplierId) throw new ApiError('supplierId is required', 400)
      const supplier = await tx.supplier.findFirst({ where: { id: supplierId, companyId } })
      if (!supplier) throw new ApiError('Supplier not found', 404)
      const company = await tx.company.findUnique({ where: { id: companyId } })
      if (!company) throw new ApiError('Company not found', 404)

      const interState = isInterState(company.state, supplier.state)
      const taxLines = lines.map((l) => ({ qty: r2(Number(l.qty)), rate: r2(Number(l.rate)), gstRate: Number(l.gstRate ?? 18) }))
      const totals = computeGst(taxLines, interState)
      const number = await nextDocNumber(tx, companyId, 'PINV', date)

      const created = await tx.purchaseInvoice.create({
        data: {
          companyId,
          number,
          poId: po ? po.id : null,
          supplierId: supplier.id,
          date,
          supplierInvNo: body.supplierInvNo || null,
          isInterState: interState,
          subtotal: totals.subtotal,
          discountTotal: totals.discountTotal,
          cgst: totals.cgst,
          sgst: totals.sgst,
          igst: totals.igst,
          grandTotal: totals.grandTotal,
          status: 'UNPAID',
          notes: body.notes || null,
          items: {
            create: totals.computed.map((c, idx) => ({
              itemId: lines[idx].itemId as string,
              qty: c.qty,
              rate: c.rate,
              gstRate: c.gstRate,
              lineTotal: r2(c.taxable),
            })),
          },
        },
        include: { items: true },
      })

      // PO → INVOICED only when fully received already; otherwise leave PO status untouched
      if (po && po.status === 'RECEIVED') {
        await tx.purchaseOrder.update({ where: { id: po.id }, data: { status: 'INVOICED' } })
      }

      await logAudit(tx, {
        companyId, userName: body.userName, action: 'CREATE', entity: 'PurchaseInvoice',
        entityId: created.id,
        details: `Created ${number} for ${supplier.name}${po ? ` (PO ${po.number})` : ''} — grand total ${totals.grandTotal}`,
      })
      return created
    })
    const [row] = await attachItemInfo(companyId, [pinv])
    return ok(row, 'Purchase invoice created')
  } catch (e) {
    return handleError(e)
  }
}
