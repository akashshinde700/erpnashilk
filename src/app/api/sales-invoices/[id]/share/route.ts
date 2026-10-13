import { randomBytes } from 'crypto'
import { db } from '@/lib/db'
import { ok, handleError, companyRequired, logAudit, ApiError, requireWrite } from '@/lib/erp-helpers'

// POST /api/sales-invoices/[id]/share  { companyId }
//  → { token, path } — creates the public share token (or returns the existing one).
//    The link /share/invoice/<token> needs no login; the token is the secret.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireWrite(req, 'sales-invoices')
    const { id } = await params
    const body = await req.json().catch(() => ({}) as any)
    const companyId = await companyRequired(req, body.companyId)

    const current = await db.salesInvoice.findFirst({ where: { id, companyId }, select: { id: true, number: true, status: true, shareToken: true } })
    if (!current) throw new ApiError('Invoice not found', 404)
    if (current.status === 'CANCELLED') throw new ApiError('A cancelled invoice cannot be shared', 400)
    if (current.shareToken) return ok({ token: current.shareToken, path: `/share/invoice/${current.shareToken}` })

    const token = randomBytes(18).toString('base64url')
    const saved = await db.$transaction(async (tx) => {
      const t = tx as any
      // Only set when still empty, so two concurrent clicks end up with one token
      await tx.salesInvoice.updateMany({ where: { id, companyId, shareToken: null }, data: { shareToken: token } })
      const u = await tx.salesInvoice.findUniqueOrThrow({ where: { id }, select: { shareToken: true } })
      await logAudit(t, {
        companyId, userName: body.userName, action: 'UPDATE', entity: 'SalesInvoice', entityId: id,
        details: `Share link created for ${current.number}`,
      })
      return u.shareToken as string
    })
    return ok({ token: saved, path: `/share/invoice/${saved}` }, 'Share link ready')
  } catch (e) {
    return handleError(e)
  }
}

// DELETE /api/sales-invoices/[id]/share?companyId=  — revoke the public link (old links stop working)
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireWrite(req, 'sales-invoices')
    const { id } = await params
    const body = await req.json().catch(() => ({}) as any)
    const companyId = await companyRequired(req, body?.companyId)

    const current = await db.salesInvoice.findFirst({ where: { id, companyId }, select: { id: true, number: true } })
    if (!current) throw new ApiError('Invoice not found', 404)

    await db.$transaction(async (tx) => {
      const t = tx as any
      await tx.salesInvoice.updateMany({ where: { id, companyId }, data: { shareToken: null } })
      await logAudit(t, {
        companyId, userName: body?.userName, action: 'UPDATE', entity: 'SalesInvoice', entityId: id,
        details: `Share link revoked for ${current.number}`,
      })
    })
    return ok({ id }, 'Share link revoked')
  } catch (e) {
    return handleError(e)
  }
}
