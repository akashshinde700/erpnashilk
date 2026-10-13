import { db } from '@/lib/db'
import { requireSecurityPin } from '@/lib/security-pin'
import { ApiError, companyRequired, handleError, logAudit, ok, r2, requireWrite } from '@/lib/erp-helpers'
import { accountForMode } from '@/lib/accounts'

type Params = { params: Promise<{ id: string }> }

const EXPENSE_STATUSES = ['DRAFT', 'POSTED', 'CANCELLED']
const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/

function optGstin(v: unknown): string | null {
  if (v === undefined || v === null) return null
  const s = String(v).trim().toUpperCase()
  if (!s) return null
  if (!GSTIN_RE.test(s)) throw new ApiError('vendorGstin is not a valid 15-character GSTIN', 400)
  return s
}

function optDate(v: unknown, field: string): Date | null {
  if (v === undefined || v === null || v === '') return null
  const s = String(v).trim()
  if (!s) return null
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00.000Z` : s)
  if (Number.isNaN(d.getTime())) throw new ApiError(`${field} must be a valid date`, 400)
  return d
}

function expenseStatus(v: unknown): string {
  const s = String(v).trim().toUpperCase()
  if (!EXPENSE_STATUSES.includes(s)) throw new ApiError('status must be one of DRAFT, POSTED, CANCELLED', 400)
  return s
}

const optStr = (v: unknown): string | null => (v === undefined || v === null ? null : String(v).trim() || null)

// PATCH /api/expenses/[id] { companyId, ...editable fields, userName? }
export async function PATCH(req: Request, { params }: Params) {
  try {
    requireWrite(req, 'expenses')
    const { id } = await params
    const body = await req.json().catch(() => ({}))
    const companyId = await companyRequired(req, body?.companyId)
    await requireSecurityPin(req, companyId)

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
    if ('vendorGstin' in body) data.vendorGstin = optGstin(body.vendorGstin)
    if ('billNo' in body) data.billNo = optStr(body.billNo)
    if ('billDate' in body) data.billDate = optDate(body.billDate, 'billDate')
    if ('itcEligible' in body) data.itcEligible = body.itcEligible === true || body.itcEligible === 'true'
    if ('status' in body && body.status) data.status = expenseStatus(body.status)
    if ('expenseType' in body && body.expenseType) {
      const t = String(body.expenseType).trim().toUpperCase()
      if (!['DIRECT', 'INDIRECT'].includes(t)) throw new ApiError('expenseType must be DIRECT or INDIRECT', 400)
      data.expenseType = t
    }
    if ('accountId' in body) {
      if (body.accountId) {
        const acc = await db.moneyAccount.findFirst({ where: { id: String(body.accountId), companyId } })
        if (!acc) throw new ApiError('Account not found', 404)
        if (!acc.active && acc.id !== existing.accountId) throw new ApiError(`Account ${acc.name} is inactive`, 400)
        data.accountId = acc.id
      } else {
        // '' / null → default account for the (new) payment mode
        data.accountId = await accountForMode(db, companyId, (data.paymentMode as string | undefined) ?? existing.paymentMode)
      }
    }

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
    requireWrite(req, 'expenses')
    const { id } = await params
    const body = await req.json().catch(() => ({}))
    const companyId = await companyRequired(req, body?.companyId)
    await requireSecurityPin(req, companyId)

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
