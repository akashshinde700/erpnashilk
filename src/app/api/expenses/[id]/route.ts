import { db } from '@/lib/db'
import { requireSecurityPin } from '@/lib/security-pin'
import { ApiError, companyRequired, handleError, logAudit, ok, r2, requireWrite } from '@/lib/erp-helpers'
import { accountTypeForMode, assertOnOrAfterOpening, ensureCashFor, postingAccount } from '@/lib/accounts'
import { businessDate, istDay } from '@/lib/business-date'
import { CASH_TX, assertCashNotNegative, negativeCashOverride } from '@/lib/cash-guard'

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
    const override = negativeCashOverride(req, body)

    const data: Record<string, unknown> = {}
    if ('date' in body) {
      if (!body.date) throw new ApiError('date cannot be empty', 400)
      data.date = businessDate(body.date)
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
    // Account: a chosen one must exist, be active and match the payment mode (cash ↔ bank, CB-R5). An expense whose
    // mode and account are both unchanged keeps its account (also an older one saved before the rule, or since
    // deactivated). '' / null → default for the mode; a mode change alone moves the expense to the new mode's
    // default account when the current account is of the other kind.
    const mode = (data.paymentMode as string | undefined) ?? existing.paymentMode
    const modeUnchanged = mode === existing.paymentMode
    const current = existing.accountId ? await db.moneyAccount.findFirst({ where: { id: existing.accountId, companyId } }) : null
    let account = current
    // An older expense saved without an account stays without one while its mode is unchanged (legacy rows are
    // attributed by the reporting rule; assigning one now could fail or move money between accounts)
    const keepLegacyNone = 'accountId' in body && !body.accountId && !existing.accountId && modeUnchanged
    if ('accountId' in body && !keepLegacyNone) {
      await ensureCashFor(companyId, mode, body.accountId ? String(body.accountId) : null)
      account = await postingAccount(db, companyId, mode, body.accountId ? String(body.accountId) : null, {
        keepInactiveId: existing.accountId, keepExistingId: modeUnchanged ? existing.accountId : null,
      })
    } else if (!modeUnchanged && (!current || current.type !== accountTypeForMode(mode))) {
      await ensureCashFor(companyId, mode)
      account = await postingAccount(db, companyId, mode)
    }
    if (account && account.id !== existing.accountId) data.accountId = account.id

    const date = (data.date as Date | undefined) ?? existing.date
    const status = (data.status as string | undefined) ?? existing.status
    const moneyTouched = 'date' in data || 'accountId' in data || 'amount' in data || 'status' in data
    if (account && status !== 'CANCELLED' && moneyTouched) assertOnOrAfterOpening(account, date, 'This expense')

    const changes: string[] = []
    if ('amount' in data && data.amount !== existing.amount) changes.push(`amount ₹${existing.amount.toFixed(2)} → ₹${(data.amount as number).toFixed(2)}`)
    if ('date' in data && istDay(date) !== istDay(existing.date)) changes.push(`date ${istDay(existing.date)} → ${istDay(date)}`)
    if ('paymentMode' in data && mode !== existing.paymentMode) changes.push(`mode ${existing.paymentMode} → ${mode}`)
    if ('accountId' in data) changes.push(`account ${current?.name ?? 'default'} → ${account?.name}`)
    if ('status' in data && status !== existing.status) changes.push(`status ${existing.status} → ${status}`)

    // Phase 5: the edit can take more money out of the (new) account, or take it out earlier
    const wasPosted = existing.status === 'POSTED'
    const takesMore = status === 'POSTED' && (!wasPosted || (data.accountId !== undefined && data.accountId !== existing.accountId)
      || mode !== existing.paymentMode || ((data.amount as number | undefined) ?? existing.amount) > existing.amount + 0.005
      || istDay(date) < istDay(existing.date))

    const expense = await db.$transaction(async (tx) => {
      const updated = await tx.expense.update({ where: { id: existing.id }, data })
      await logAudit(tx as never, {
        companyId,
        userName: body?.userName,
        action: 'UPDATE',
        entity: 'EXPENSE',
        entityId: id,
        details: `Expense ${updated.number} updated${changes.length ? `: ${changes.join('; ')}` : ''}`,
      })
      if (takesMore) {
        await assertCashNotNegative(tx, { companyId, accounts: [{ accountId: updated.accountId, mode: updated.paymentMode }], from: date, override, what: `Expense ${updated.number}`, entity: 'EXPENSE', entityId: id, userName: body?.userName })
      }
      return updated
    }, CASH_TX)
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
