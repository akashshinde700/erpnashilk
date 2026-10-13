import { db } from '@/lib/db'
import { ApiError, handleError, logAudit, ok, requireWrite, sessionUser } from '@/lib/erp-helpers'

type Ctx = { params: Promise<{ id: string }> }

// DELETE /api/firms/[id] — remove this login's access to a linked firm.
// Never deletes the firm or its data, and never the user's home company.
export async function DELETE(req: Request, { params }: Ctx) {
  try {
    requireWrite(req, 'companies')
    const me = await sessionUser(req)
    if (me.role !== 'TENANT_ADMIN') throw new ApiError('Only a tenant administrator can remove a firm', 403)
    const { id } = await params
    if (id === me.companyId) throw new ApiError('Your home company cannot be removed', 400)

    const removed = await db.$transaction(async (tx) => {
      const r = await tx.userCompanyAccess.deleteMany({ where: { userId: me.id, companyId: id } })
      if (r.count === 0) throw new ApiError('Firm not found', 404)
      await logAudit(tx as never, {
        companyId: id, userName: me.name, action: 'CONFIG', entity: 'COMPANY', entityId: id,
        details: `Access removed for ${me.name} (${me.email}); firm data kept`,
      })
      return r.count
    })
    return ok({ id, removed }, 'Firm removed from your list (data kept)')
  } catch (e) {
    return handleError(e)
  }
}
