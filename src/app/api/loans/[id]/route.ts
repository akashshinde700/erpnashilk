import { db } from '@/lib/db'
import { requireSecurityPin } from '@/lib/security-pin'
import { ApiError, companyRequired, handleError, logAudit, ok, r2, requireWrite } from '@/lib/erp-helpers'
import { CbTx, MODULE_KEY, activeAccount, money, optStr, parseDate } from '../../accounts/_shared'

type Params = { params: Promise<{ id: string }> }

async function principalPaid(tx: CbTx, companyId: string, loanId: string) {
  const s = await tx.accountTxn.aggregate({ where: { companyId, loanId, type: 'LOAN_EMI' }, _sum: { principal: true } })
  return r2(s._sum.principal || 0)
}

// GET /api/loans/[id]?companyId= → loan + its entries (LOAN_IN / LOAN_EMI)
export async function GET(req: Request, { params }: Params) {
  try {
    const { id } = await params
    const companyId = await companyRequired(req)
    const loan = await db.loan.findFirst({ where: { id, companyId } })
    if (!loan) throw new ApiError('Loan not found', 404)
    const entries = await db.accountTxn.findMany({ where: { companyId, loanId: id }, orderBy: [{ date: 'asc' }, { createdAt: 'asc' }] })
    const paid = r2(entries.filter((e) => e.type === 'LOAN_EMI').reduce((s, e) => s + (e.principal || 0), 0))
    const interest = r2(entries.filter((e) => e.type === 'LOAN_EMI').reduce((s, e) => s + (e.interest || 0), 0))
    return ok({ ...loan, entries, principalPaid: paid, interestPaid: interest, outstanding: r2(Math.max(0, loan.principal - paid)) })
  } catch (e) {
    return handleError(e)
  }
}

// PATCH /api/loans/[id] { companyId, action: 'close' | 'reopen' } or edit fields
//   { name?, lender?, loanAccountNo?, interestRate?, termMonths?, emiAmount?, notes?, principal?, processingFee?, startDate?, receivedAccountId? }
// Editing principal / fee / start date / account rewrites the LOAN_IN entry.
export async function PATCH(req: Request, { params }: Params) {
  try {
    requireWrite(req, MODULE_KEY)
    const { id } = await params
    const body = await req.json().catch(() => ({}) as Record<string, unknown>)
    const companyId = await companyRequired(req, body?.companyId)

    const loan = await db.loan.findFirst({ where: { id, companyId } })
    if (!loan) throw new ApiError('Loan not found', 404)
    const action = String(body?.action || '').toLowerCase()

    const updated = await db.$transaction(async (txRaw) => {
      const tx = txRaw as CbTx
      if (action === 'close' || action === 'reopen') {
        const status = action === 'close' ? 'CLOSED' : 'OPEN'
        const u = await tx.loan.update({ where: { id: loan.id }, data: { status } })
        const outstanding = r2(loan.principal - (await principalPaid(tx, companyId, loan.id)))
        await logAudit(tx, {
          companyId, userName: body?.userName, action: 'UPDATE', entity: 'Loan', entityId: id,
          details: `Loan "${loan.name}" ${action === 'close' ? `closed${outstanding > 0.01 ? ` with ₹${outstanding.toFixed(2)} principal unpaid` : ''}` : 'reopened'}`,
        })
        return u
      }
      if (action) throw new ApiError("action must be 'close' or 'reopen'", 400)

      const data: Record<string, unknown> = {}
      if ('name' in body) {
        const name = String(body.name || '').trim()
        if (!name) throw new ApiError('Loan name cannot be empty', 400)
        data.name = name
      }
      if ('lender' in body) data.lender = optStr(body.lender)
      if ('loanAccountNo' in body) data.loanAccountNo = optStr(body.loanAccountNo)
      if ('notes' in body) data.notes = optStr(body.notes)
      if ('interestRate' in body) {
        const r = Number(body.interestRate ?? 0)
        if (!Number.isFinite(r) || r < 0 || r > 100) throw new ApiError('interestRate must be between 0 and 100', 400)
        data.interestRate = r2(r)
      }
      if ('termMonths' in body) {
        const t = body.termMonths === null || body.termMonths === '' ? null : Math.round(Number(body.termMonths))
        if (t !== null && (!Number.isFinite(t) || t <= 0)) throw new ApiError('termMonths must be a positive number', 400)
        data.termMonths = t
      }
      if ('emiAmount' in body) data.emiAmount = body.emiAmount ? money(body.emiAmount, 'emiAmount', { allowZero: true }) : null

      const principal = 'principal' in body ? money(body.principal, 'principal') : loan.principal
      const processingFee = 'processingFee' in body ? money(body.processingFee, 'processingFee', { allowZero: true }) : loan.processingFee
      const startDate = 'startDate' in body ? (parseDate(body.startDate, 'startDate') ?? loan.startDate) : loan.startDate
      const receivedAccountId = 'receivedAccountId' in body && body.receivedAccountId
        ? (await activeAccount(tx, companyId, body.receivedAccountId, 'Received in account')).id
        : loan.receivedAccountId
      const moneyChanged = principal !== loan.principal || processingFee !== loan.processingFee
        || startDate.getTime() !== loan.startDate.getTime() || receivedAccountId !== loan.receivedAccountId
      if (moneyChanged) {
        if (processingFee >= principal) throw new ApiError('Processing fee must be less than the loan amount', 400)
        const paid = await principalPaid(tx, companyId, loan.id)
        if (principal + 0.01 < paid) throw new ApiError(`Principal cannot be less than the principal already repaid (₹${paid.toFixed(2)})`, 400)
        Object.assign(data, { principal, processingFee, startDate, receivedAccountId })
        await tx.accountTxn.updateMany({
          where: { companyId, loanId: loan.id, type: 'LOAN_IN' },
          data: { amount: r2(principal - processingFee), date: startDate, toAccountId: receivedAccountId },
        })
        data.status = principal - paid <= 0.01 ? 'CLOSED' : loan.status
      }
      const u = await tx.loan.update({ where: { id: loan.id }, data })
      await logAudit(tx, { companyId, userName: body?.userName, action: 'UPDATE', entity: 'Loan', entityId: id, details: `Loan "${u.name}" updated` })
      return u
    })
    return ok(updated, action === 'close' ? 'Loan closed' : action === 'reopen' ? 'Loan reopened' : 'Loan updated')
  } catch (e) {
    return handleError(e)
  }
}

// DELETE /api/loans/[id]?companyId= — removes the loan with its receipt and EMI entries
export async function DELETE(req: Request, { params }: Params) {
  try {
    requireWrite(req, MODULE_KEY)
    const { id } = await params
    const body = await req.json().catch(() => ({}) as Record<string, unknown>)
    const companyId = await companyRequired(req, body?.companyId)
    await requireSecurityPin(req, companyId)

    const loan = await db.loan.findFirst({ where: { id, companyId } })
    if (!loan) throw new ApiError('Loan not found', 404)
    await db.$transaction(async (txRaw) => {
      const tx = txRaw as CbTx
      const entries = await tx.accountTxn.deleteMany({ where: { companyId, loanId: loan.id } })
      await tx.loan.delete({ where: { id: loan.id } })
      await logAudit(tx, {
        companyId, userName: body?.userName, action: 'DELETE', entity: 'Loan', entityId: id,
        details: `Loan "${loan.name}" deleted with ${entries.count} entr${entries.count === 1 ? 'y' : 'ies'}`,
      })
    })
    return ok({ id }, 'Loan deleted')
  } catch (e) {
    return handleError(e)
  }
}
