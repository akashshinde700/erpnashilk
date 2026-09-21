import { db } from '@/lib/db'
import { ApiError, companyRequired, handleError, logAudit, ok, r2 } from '@/lib/erp-helpers'

type Params = { params: Promise<{ id: string }> }

// PATCH /api/expenses/[id] { companyId, ...editable fields, userName? }
export async function PATCH(req: Request, { params }: Params) {
  try {
    const { id } = await params
    const body = await req.json().catch(() => ({}))
    const companyId = await companyRequired(req, body?.companyId)

    const existing = await db.expense.findFirst({ where: { id, companyId } })
    if (!existing) throw new ApiError('Expense not found', 404)

    const data: Record<string, unknown> = {}
    if ('date' in body) {
      const d = new Date(body.date)
      if (Number.isNaN(d.getTime())) throw new ApiError('Invalid date', 400)
      data.date = d
    }
    if ('category' in body && body.category) data.category = String(body.category)
    if ('description' in body) {
      const s = String(body.description || '').trim()
      if (!s) throw new ApiError('description cannot be empty', 400)
      data.description = s
    }
    if ('amount' in body) {
      const a = Number(body.amount)
      if (!Number.isFinite(a) || a <= 0) throw new ApiError('amount must be greater than 0', 400)
      data.amount = r2(a)
    }
    if ('paymentMode' in body && body.paymentMode) data.paymentMode = String(body.paymentMode)
    if ('paidTo' in body) data.paidTo = body.paidTo ? String(body.paidTo).trim() : null
    if ('gstAmount' in body) data.gstAmount = r2(Number(body.gstAmount) || 0)

    const expense = await db.$transaction(async (tx) => {
      const updated = await tx.expense.update({ where: { id: existing.id }, data })
      await logAudit(tx as never, {
        companyId,
        userName: body?.userName,
        action: 'UPDATE',
        entity: 'EXPENSE',
        entityId: id,
        details: `Expense ${updated.number} updated`,
      })
      return updated
    })
    return ok(expense, 'Expense updated')
  } catch (e) {
    return handleError(e)
  }
}

// DELETE /api/expenses/[id]?companyId= (companyId may also arrive in a JSON body)
export async function DELETE(req: Request, { params }: Params) {
  try {
    const { id } = await params
    const body = await req.json().catch(() => ({}))
    const companyId = await companyRequired(req, body?.companyId)

    const existing = await db.expense.findFirst({ where: { id, companyId } })
    if (!existing) throw new ApiError('Expense not found', 404)

    await db.$transaction(async (tx) => {
      await tx.expense.delete({ where: { id: existing.id } })
      await logAudit(tx as never, {
        companyId,
        userName: body?.userName,
        action: 'DELETE',
        entity: 'EXPENSE',
        entityId: id,
        details: `Expense ${existing.number} deleted`,
      })
    })
    return ok({ id }, 'Expense deleted')
  } catch (e) {
    return handleError(e)
  }
}
