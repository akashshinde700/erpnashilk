import { db } from '@/lib/db'
import { ApiError, companyRequired, handleError, logAudit, nextDocNumber, ok, r2, requireWrite } from '@/lib/erp-helpers'
import { CbTx, MODULE_KEY, activeAccount, money, optStr, parseDate } from '../../../accounts/_shared'

type Params = { params: Promise<{ id: string }> }

// POST /api/loans/[id]/emi { companyId, date?, principal, interest, fromAccountId, reference?, notes? }
// → LOAN_EMI entry (amount = principal + interest). Principal can't exceed the outstanding; the loan closes at 0.
export async function POST(req: Request, { params }: Params) {
  try {
    requireWrite(req, MODULE_KEY)
    const { id } = await params
    const body = await req.json().catch(() => ({}) as Record<string, unknown>)
    const companyId = await companyRequired(req, body?.companyId)

    const principal = money(body?.principal, 'principal', { allowZero: true })
    const interest = money(body?.interest, 'interest', { allowZero: true })
    const amount = r2(principal + interest)
    if (!(amount > 0)) throw new ApiError('Enter the principal and/or interest paid', 400)
    const date = parseDate(body?.date, 'date') ?? new Date()

    const result = await db.$transaction(async (txRaw) => {
      const tx = txRaw as CbTx
      const loan = await tx.loan.findFirst({ where: { id, companyId } })
      if (!loan) throw new ApiError('Loan not found', 404)
      if (loan.status === 'CLOSED') throw new ApiError('This loan is closed', 400)
      // Touch the loan row first: locks it so concurrent EMIs can't both pass the outstanding check
      await tx.loan.update({ where: { id: loan.id }, data: { updatedAt: new Date() } })
      const acc = await activeAccount(tx, companyId, body?.fromAccountId, 'Paid from account')

      const paid = await tx.accountTxn.aggregate({ where: { companyId, loanId: loan.id, type: 'LOAN_EMI' }, _sum: { principal: true } })
      const outstanding = r2(loan.principal - (paid._sum.principal || 0))
      if (principal > outstanding + 0.01) throw new ApiError(`Principal exceeds the outstanding loan (₹${outstanding.toFixed(2)})`, 400)

      const number = await nextDocNumber(tx, companyId, 'ATX', date)
      const txn = await tx.accountTxn.create({
        data: {
          companyId, number, date, type: 'LOAN_EMI', fromAccountId: acc.id, amount, principal, interest,
          category: 'LOAN', loanId: loan.id, reference: optStr(body?.reference), notes: optStr(body?.notes),
        },
      })
      const after = r2(outstanding - principal)
      const closed = after <= 0.01
      if (closed) await tx.loan.update({ where: { id: loan.id }, data: { status: 'CLOSED' } })
      await logAudit(tx, {
        companyId, userName: body?.userName, action: 'CREATE', entity: 'Loan', entityId: loan.id,
        details: `${number} • EMI ₹${amount.toFixed(2)} (principal ₹${principal.toFixed(2)}, interest ₹${interest.toFixed(2)}) for "${loan.name}" from ${acc.name}${closed ? ' — loan closed' : ''}`,
      })
      return { ...txn, outstandingAfter: Math.max(0, after), loanClosed: closed }
    })
    return ok(result, result.loanClosed ? 'EMI recorded — loan fully repaid' : 'EMI recorded')
  } catch (e) {
    return handleError(e)
  }
}
