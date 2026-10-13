import { db } from '@/lib/db'
import { ApiError, companyRequired, handleError, logAudit, ok, requireWrite } from '@/lib/erp-helpers'
import { CbTx, MODULE_KEY, parseDate } from '../../_shared'

type Params = { params: Promise<{ id: string }> }

// PATCH /api/accounts/[id]/reconcile { companyId, kind: 'payment'|'expense'|'txn', id, clearedDate: 'YYYY-MM-DD' | null }
// Bank reconciliation: marks the entry as cleared in the bank statement (null = un-clear).
export async function PATCH(req: Request, { params }: Params) {
  try {
    requireWrite(req, MODULE_KEY)
    const { id: accountId } = await params
    const body = await req.json().catch(() => ({}) as Record<string, unknown>)
    const companyId = await companyRequired(req, body?.companyId)

    const account = await db.moneyAccount.findFirst({ where: { id: accountId, companyId } })
    if (!account) throw new ApiError('Account not found', 404)
    const kind = String(body?.kind || '')
    if (!['payment', 'expense', 'txn'].includes(kind)) throw new ApiError("kind must be 'payment', 'expense' or 'txn'", 400)
    const entryId = String(body?.id || '')
    if (!entryId) throw new ApiError('id is required', 400)
    const clearedDate = parseDate(body?.clearedDate, 'clearedDate')

    const result = await db.$transaction(async (txRaw) => {
      const tx = txRaw as CbTx
      let number = ''
      if (kind === 'payment') {
        const p = await tx.payment.findFirst({ where: { id: entryId, companyId } })
        if (!p) throw new ApiError('Payment not found', 404)
        if (p.accountId && p.accountId !== accountId) throw new ApiError('This payment belongs to another account', 400)
        await tx.payment.update({ where: { id: p.id }, data: { clearedDate } })
        number = p.number
      } else if (kind === 'expense') {
        const e = await tx.expense.findFirst({ where: { id: entryId, companyId } })
        if (!e) throw new ApiError('Expense not found', 404)
        if (e.accountId && e.accountId !== accountId) throw new ApiError('This expense belongs to another account', 400)
        await tx.expense.update({ where: { id: e.id }, data: { clearedDate } })
        number = e.number
      } else {
        const t = await tx.accountTxn.findFirst({ where: { id: entryId, companyId, OR: [{ fromAccountId: accountId }, { toAccountId: accountId }] } })
        if (!t) throw new ApiError('Entry not found for this account', 404)
        await tx.accountTxn.update({ where: { id: t.id }, data: { clearedDate } })
        number = t.number
      }
      await logAudit(tx, {
        companyId, userName: body?.userName, action: 'UPDATE', entity: 'MoneyAccount', entityId: accountId,
        details: `${number} ${clearedDate ? `cleared on ${clearedDate.toISOString().slice(0, 10)}` : 'marked uncleared'} in ${account.name}`,
      })
      return { kind, id: entryId, clearedDate }
    })
    return ok(result, clearedDate ? 'Marked cleared' : 'Marked uncleared')
  } catch (e) {
    return handleError(e)
  }
}
