import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import {
  ok, handleError, companyRequired, computeGst, isInterState, logAudit, ApiError, r2, requireWrite,
} from '@/lib/erp-helpers'

// prisma 6.x generated delegates are not structurally assignable to the shared helpers' minimal
// tx types — intersect once and cast the transaction client at the boundary.
type HelperTx = Prisma.TransactionClient & Parameters<typeof logAudit>[0]

async function attachItemInfo<T extends { items: { itemId: string }[] }>(companyId: string, docs: T[]) {
  const ids = Array.from(new Set(docs.flatMap((d) => d.items.map((i) => i.itemId))))
  const items = ids.length
    ? await db.item.findMany({ where: { companyId, id: { in: ids } }, select: { id: true, code: true, name: true, uom: true, hsn: true } })
    : []
  const map = new Map(items.map((i) => [i.id, i]))
  return docs.map((d) => ({ ...d, items: d.items.map((i) => ({ ...i, item: map.get(i.itemId) || null })) }))
}

function toDate(v: unknown): Date | null {
  if (!v) return null
  const d = new Date(String(v))
  return Number.isNaN(d.getTime()) ? null : d
}

interface PoLineInput { itemId?: string; qty?: number | string; rate?: number | string; gstRate?: number | string }

function validateLines(lines: PoLineInput[]) {
  if (!lines.length) throw new ApiError('At least one item line is required', 400)
  for (const l of lines) {
    if (!l.itemId) throw new ApiError('itemId is required on every line', 400)
    if (!(Number(l.qty) > 0)) throw new ApiError('Line qty must be greater than 0', 400)
    if (!(Number(l.rate) >= 0)) throw new ApiError('Line rate must be 0 or more', 400)
  }
}

const PO_SELECT = {
  id: true, code: true, name: true, gstin: true, state: true, stateCode: true,
  contactPerson: true, phone: true, email: true, addressLine: true, city: true, paymentTermsDays: true,
} as const

async function findPo(id: string, companyId: string) {
  const po = await db.purchaseOrder.findFirst({
    where: { id, companyId },
    include: {
      supplier: { select: PO_SELECT },
      items: true,
      grns: { select: { id: true, number: true, date: true, status: true } },
      invoices: { select: { id: true, number: true, date: true, status: true, grandTotal: true } },
    },
  })
  if (!po) throw new ApiError('Purchase order not found', 404)
  return po
}

// ============================== GET /api/purchase-orders/[id] ==============================
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const companyId = await companyRequired(req)
    const po = await findPo(id, companyId)
    // Purchaser (our company) block for the PO print — PurchaseOrder has no company
    // relation in the schema, so fetch + attach via JS (mirrors sales-invoices detail).
    const company = await db.company.findUnique({
      where: { id: companyId },
      select: { name: true, gstin: true, pan: true, addressLine: true, city: true, state: true, stateCode: true, phone: true, email: true },
    })
    const [row] = await attachItemInfo(companyId, [{ ...po, company }])
    return ok(row)
  } catch (e) {
    return handleError(e)
  }
}

// ============================== PATCH /api/purchase-orders/[id] ==============================
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireWrite(req, 'purchase-orders')
    const { id } = await params
    const body = await req.json()
    const companyId = await companyRequired(req, body.companyId)
    const po = await findPo(id, companyId)

    // --- Workflow actions ---
    if (body.action) {
      const action = String(body.action)

      if (action === 'submit') {
        if (po.status !== 'DRAFT') throw new ApiError(`Cannot submit: PO is ${po.status}`, 400)
        const updated = await db.$transaction(async (txRaw) => {
        const tx = txRaw as HelperTx
          const u = await tx.purchaseOrder.update({
            where: { id: po.id }, data: { status: 'PENDING_APPROVAL' }, include: { items: true },
          })
          await logAudit(tx, {
            companyId, userName: body.userName, action: 'UPDATE', entity: 'PurchaseOrder',
            entityId: po.id, details: `${po.number} submitted for approval`,
          })
          return u
        })
        return ok(updated, 'PO submitted for approval')
      }

      if (action === 'approve') {
        if (po.status !== 'PENDING_APPROVAL') throw new ApiError(`Cannot approve: PO is ${po.status}`, 400)
        const updated = await db.$transaction(async (txRaw) => {
        const tx = txRaw as HelperTx
          const u = await tx.purchaseOrder.update({
            where: { id: po.id },
            data: { status: 'APPROVED', approvedBy: body.userName || 'system', approvedAt: new Date() },
            include: { items: true },
          })
          await logAudit(tx, {
            companyId, userName: body.userName, action: 'APPROVE', entity: 'PurchaseOrder',
            entityId: po.id, details: `${po.number} approved by ${body.userName || 'system'}`,
          })
          return u
        })
        return ok(updated, 'Purchase order approved')
      }

      if (action === 'reject') {
        if (po.status !== 'PENDING_APPROVAL') throw new ApiError(`Cannot reject: PO is ${po.status}`, 400)
        const note = `Rejected by ${body.userName || 'system'}${body.notes ? `: ${body.notes}` : ''}`
        const updated = await db.$transaction(async (txRaw) => {
        const tx = txRaw as HelperTx
          const u = await tx.purchaseOrder.update({
            where: { id: po.id },
            data: { status: 'CANCELLED', notes: po.notes ? `${po.notes} | ${note}` : note },
            include: { items: true },
          })
          await logAudit(tx, {
            companyId, userName: body.userName, action: 'REJECT', entity: 'PurchaseOrder',
            entityId: po.id, details: `${po.number} rejected → CANCELLED${body.notes ? ` (${body.notes})` : ''}`,
          })
          return u
        })
        return ok(updated, 'Purchase order rejected')
      }

      if (action === 'cancel') {
        if (po.status === 'CANCELLED') throw new ApiError('Purchase order is already cancelled', 400)
        if (['RECEIVED', 'PARTIALLY_RECEIVED', 'INVOICED'].includes(po.status) || po.items.some((i) => i.receivedQty > 0)) {
          throw new ApiError('Cannot cancel: goods already received or invoiced against this PO', 400)
        }
        const updated = await db.$transaction(async (txRaw) => {
        const tx = txRaw as HelperTx
          const u = await tx.purchaseOrder.update({
            where: { id: po.id }, data: { status: 'CANCELLED' }, include: { items: true },
          })
          await logAudit(tx, {
            companyId, userName: body.userName, action: 'CANCEL', entity: 'PurchaseOrder',
            entityId: po.id, details: `${po.number} cancelled`,
          })
          return u
        })
        return ok(updated, 'Purchase order cancelled')
      }

      throw new ApiError(`Unknown action '${action}' (use submit | approve | reject | cancel)`, 400)
    }

    // --- Edit lines (DRAFT only) ---
    if (po.status !== 'DRAFT') throw new ApiError('Only DRAFT purchase orders can be edited', 400)
    const lines: PoLineInput[] | null = Array.isArray(body.items) ? body.items : null
    if (lines) validateLines(lines)
    const itemIds = lines ? Array.from(new Set(lines.map((l) => l.itemId as string))) : []
    if (itemIds.length) {
      const count = await db.item.count({ where: { companyId, id: { in: itemIds } } })
      if (count !== itemIds.length) throw new ApiError('One or more itemId values are invalid for this company', 400)
    }

    let supplier = po.supplier
    if (body.supplierId && body.supplierId !== po.supplierId) {
      const s = await db.supplier.findFirst({ where: { id: body.supplierId, companyId } })
      if (!s) throw new ApiError('Supplier not found', 404)
      supplier = s
    }
    const company = await db.company.findUnique({ where: { id: companyId } })
    if (!company) throw new ApiError('Company not found', 404)

    const interState = isInterState(company.state, supplier.state)
    const data: Prisma.PurchaseOrderUpdateInput = { supplier: { connect: { id: supplier.id } } }
    if (body.orderDate) data.orderDate = toDate(body.orderDate) || po.orderDate
    if (body.expectedDate !== undefined) data.expectedDate = toDate(body.expectedDate)
    if (body.notes !== undefined) data.notes = body.notes || null

    if (lines) {
      const taxLines = lines.map((l) => ({ qty: r2(Number(l.qty)), rate: r2(Number(l.rate)), gstRate: Number(l.gstRate ?? 18) }))
      const totals = computeGst(taxLines, interState)
      data.subtotal = totals.subtotal
      data.discountTotal = totals.discountTotal
      data.cgst = totals.cgst
      data.sgst = totals.sgst
      data.igst = totals.igst
      data.grandTotal = totals.grandTotal
    }

    const updated = await db.$transaction(async (txRaw) => {
        const tx = txRaw as HelperTx
      if (lines) {
        const taxLines = lines.map((l) => ({ qty: r2(Number(l.qty)), rate: r2(Number(l.rate)), gstRate: Number(l.gstRate ?? 18) }))
        const totals = computeGst(taxLines, interState)
        await tx.purchaseOrderItem.deleteMany({ where: { poId: po.id } })
        await tx.purchaseOrderItem.createMany({
          data: totals.computed.map((c, idx) => ({
            poId: po.id,
            itemId: lines[idx].itemId as string,
            qty: c.qty,
            rate: c.rate,
            gstRate: c.gstRate,
            lineTotal: r2(c.taxable),
          })),
        })
      }
      const u = await tx.purchaseOrder.update({ where: { id: po.id }, data, include: { items: true } })
      await logAudit(tx, {
        companyId, userName: body.userName, action: 'UPDATE', entity: 'PurchaseOrder',
        entityId: po.id, details: `Updated ${po.number}`,
      })
      return u
    })
    return ok(updated, 'Purchase order updated')
  } catch (e) {
    return handleError(e)
  }
}

// ============================== DELETE /api/purchase-orders/[id] ==============================
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireWrite(req, 'purchase-orders')
    const { id } = await params
    const body = await req.json().catch(() => ({}) as { companyId?: string; userName?: string })
    const companyId = await companyRequired(req, body.companyId)
    const po = await db.purchaseOrder.findFirst({ where: { id, companyId }, include: { items: true } })
    if (!po) throw new ApiError('Purchase order not found', 404)
    if (po.status !== 'DRAFT') throw new ApiError('Only DRAFT purchase orders can be deleted', 400)

    await db.$transaction(async (txRaw) => {
        const tx = txRaw as HelperTx
      await tx.purchaseOrderItem.deleteMany({ where: { poId: po.id } })
      await tx.purchaseOrder.delete({ where: { id: po.id } })
      await logAudit(tx, {
        companyId, userName: body.userName, action: 'DELETE', entity: 'PurchaseOrder',
        entityId: po.id, details: `Deleted ${po.number}`,
      })
    })
    return ok({ id: po.id }, 'Purchase order deleted')
  } catch (e) {
    return handleError(e)
  }
}
