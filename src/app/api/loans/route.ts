import { db } from '@/lib/db'
import { ApiError, companyRequired, handleError, logAudit, nextDocNumber, ok, r2, requireWrite } from '@/lib/erp-helpers'
import { CbTx, MODULE_KEY, activeAccount, money, optStr, parseDate } from '../accounts/_shared'

// GET /api/loans?companyId=&status=OPEN|CLOSED
// → { items: (Loan & { principalPaid, interestPaid, outstanding, emiCount, lastEmiDate, receivedAccountName })[], total, outstanding }
export async function GET(req: Request) {
  try {
    const companyId = await companyRequired(req)
    const { searchParams } = new URL(req.url)
    const status = (searchParams.get('status') || '').trim().toUpperCase()
    const loans = await db.loan.findMany({
      where: { companyId, ...(status ? { status } : {}) },
      orderBy: [{ status: 'desc' }, { startDate: 'desc' }],
    })
    const ids = loans.map((l) => l.id)
    const [emis, accounts] = await Promise.all([
      ids.length
        ? db.accountTxn.findMany({ where: { companyId, type: 'LOAN_EMI', loanId: { in: ids } }, select: { loanId: true, principal: true, interest: true, date: true } })
        : Promise.resolve([] as { loanId: string | null; principal: number | null; interest: number | null; date: Date }[]),
      db.moneyAccount.findMany({ where: { companyId }, select: { id: true, name: true } }),
    ])
    const accountName = new Map(accounts.map((a) => [a.id, a.name]))
    const agg = new Map<string, { principalPaid: number; interestPaid: number; emiCount: number; lastEmiDate: Date | null }>()
    for (const e of emis) {
      if (!e.loanId) continue
      const a = agg.get(e.loanId) ?? { principalPaid: 0, interestPaid: 0, emiCount: 0, lastEmiDate: null }
      a.principalPaid += e.principal || 0
      a.interestPaid += e.interest || 0
      a.emiCount += 1
      if (!a.lastEmiDate || e.date > a.lastEmiDate) a.lastEmiDate = e.date
      agg.set(e.loanId, a)
    }
    const items = loans.map((l) => {
      const a = agg.get(l.id) ?? { principalPaid: 0, interestPaid: 0, emiCount: 0, lastEmiDate: null }
      return {
        ...l,
        principalPaid: r2(a.principalPaid),
        interestPaid: r2(a.interestPaid),
        outstanding: r2(Math.max(0, l.principal - a.principalPaid)),
        emiCount: a.emiCount,
        lastEmiDate: a.lastEmiDate,
        receivedAccountName: l.receivedAccountId ? accountName.get(l.receivedAccountId) ?? null : null,
      }
    })
    const outstanding = r2(items.filter((l) => l.status === 'OPEN').reduce((s, l) => s + l.outstanding, 0))
    return ok({ items, total: items.length, outstanding })
  } catch (e) {
    return handleError(e)
  }
}

// POST /api/loans { companyId, name, lender?, loanAccountNo?, principal, interestRate?, processingFee?, startDate?,
//   termMonths?, emiAmount?, receivedAccountId, notes? }
// Creates the Loan and a LOAN_IN entry crediting (principal − processing fee) to the received account.
// The processing fee stays on the Loan (it's reported as a finance expense in P&L).
export async function POST(req: Request) {
  try {
    requireWrite(req, MODULE_KEY)
    const body = await req.json().catch(() => ({}) as Record<string, unknown>)
    const companyId = await companyRequired(req, body?.companyId)

    const name = String(body?.name || '').trim()
    if (!name) throw new ApiError('Loan name is required', 400)
    const principal = money(body?.principal, 'principal')
    const processingFee = money(body?.processingFee, 'processingFee', { allowZero: true })
    if (processingFee >= principal) throw new ApiError('Processing fee must be less than the loan amount', 400)
    const interestRate = Number(body?.interestRate ?? 0)
    if (!Number.isFinite(interestRate) || interestRate < 0 || interestRate > 100) throw new ApiError('interestRate must be between 0 and 100 (% per year)', 400)
    const termMonths = body?.termMonths === undefined || body?.termMonths === null || body?.termMonths === '' ? null : Math.round(Number(body.termMonths))
    if (termMonths !== null && (!Number.isFinite(termMonths) || termMonths <= 0)) throw new ApiError('termMonths must be a positive number', 400)
    const emiAmount = body?.emiAmount ? money(body.emiAmount, 'emiAmount', { allowZero: true }) : null
    const startDate = parseDate(body?.startDate, 'startDate') ?? new Date()

    const loan = await db.$transaction(async (txRaw) => {
      const tx = txRaw as CbTx
      const acc = await activeAccount(tx, companyId, body?.receivedAccountId, 'Received in account')
      const created = await tx.loan.create({
        data: {
          companyId, name,
          lender: optStr(body?.lender),
          loanAccountNo: optStr(body?.loanAccountNo),
          principal, interestRate: r2(interestRate), processingFee, startDate, termMonths, emiAmount,
          receivedAccountId: acc.id,
          notes: optStr(body?.notes),
        },
      })
      const number = await nextDocNumber(tx, companyId, 'ATX', startDate)
      await tx.accountTxn.create({
        data: {
          companyId, number, date: startDate, type: 'LOAN_IN', toAccountId: acc.id,
          amount: r2(principal - processingFee), category: 'LOAN', loanId: created.id,
          reference: optStr(body?.loanAccountNo),
          notes: processingFee > 0 ? `Loan ₹${principal.toFixed(2)} less processing fee ₹${processingFee.toFixed(2)}` : null,
        },
      })
      await logAudit(tx, {
        companyId, userName: body?.userName, action: 'CREATE', entity: 'Loan', entityId: created.id,
        details: `Loan "${name}" ₹${principal.toFixed(2)} received in ${acc.name}${processingFee > 0 ? ` (processing fee ₹${processingFee.toFixed(2)})` : ''}`,
      })
      return created
    })
    return ok(loan, 'Loan recorded')
  } catch (e) {
    return handleError(e)
  }
}
