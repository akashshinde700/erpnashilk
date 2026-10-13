import { db } from '@/lib/db'
import { requireSecurityPin } from '@/lib/security-pin'
import { ApiError, companyRequired, handleError, logAudit, ok, requireWrite } from '@/lib/erp-helpers'
import { CbTx, MODULE_KEY } from '../../accounts/_shared'

type Params = { params: Promise<{ id: string }> }

// DELETE /api/account-txns/[id]?companyId= — adjustments and contra entries only (loan rows go with the loan)
export async function DELETE(req: Request, { params }: Params) {
  try {
    requireWrite(req, MODULE_KEY)
    const { id } = await params
    const body = await req.json().catch(() => ({}) as Record<string, unknown>)
    const companyId = await companyRequired(req, body?.companyId)
    await requireSecurityPin(req, companyId)

    const existing = await db.accountTxn.findFirst({ where: { id, companyId } })
    if (!existing) throw new ApiError('Entry not found', 404)
    if (existing.loanId || existing.type === 'LOAN_IN' || existing.type === 'LOAN_EMI') {
      throw new ApiError('Loan entries are managed from the Loans tab', 400)
    }

    await db.$transaction(async (txRaw) => {
      const tx = txRaw as CbTx
      const del = await tx.accountTxn.deleteMany({ where: { id, companyId } })
      if (del.count !== 1) throw new ApiError('This entry was just changed by someone else — refresh and try again', 409)
      await logAudit(tx, {
        companyId, userName: body?.userName, action: 'DELETE', entity: 'AccountTxn', entityId: id,
        details: `${existing.number} (${existing.type}) of ₹${existing.amount.toFixed(2)} deleted`,
      })
    })
    return ok({ id }, 'Entry deleted')
  } catch (e) {
    return handleError(e)
  }
}
