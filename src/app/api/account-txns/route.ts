import { db } from '@/lib/db'
import { ApiError, companyRequired, handleError, logAudit, nextDocNumber, ok, requireWrite } from '@/lib/erp-helpers'
import { CATEGORY_LABEL, CbTx, MODULE_KEY, activeAccount, money, optStr, parseDate } from '../accounts/_shared'

const IN_CATEGORIES = ['CAPITAL', 'OTHER_INCOME', 'OTHER']
const OUT_CATEGORIES = ['DRAWINGS', 'OTHER_EXPENSE', 'OTHER']

// GET /api/account-txns?companyId=&type=ADJUST_IN,ADJUST_OUT&accountId=&from=&to=
// → { items: (AccountTxn & { fromAccountName, toAccountName, loanName })[], total } (date desc)
export async function GET(req: Request) {
  try {
    const companyId = await companyRequired(req)
    const { searchParams } = new URL(req.url)
    const types = (searchParams.get('type') || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
    const accountId = (searchParams.get('accountId') || '').trim()
    const from = parseDate(searchParams.get('from'), 'from')
    const to = parseDate(searchParams.get('to'), 'to', true)

    const date: { gte?: Date; lte?: Date } = {}
    if (from) date.gte = from
    if (to) date.lte = to
    const rows = await db.accountTxn.findMany({
      where: {
        companyId,
        ...(types.length ? { type: { in: types } } : {}),
        ...(accountId ? { OR: [{ fromAccountId: accountId }, { toAccountId: accountId }] } : {}),
        ...(from || to ? { date } : {}),
      },
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
    })
    const [accounts, loans] = await Promise.all([
      db.moneyAccount.findMany({ where: { companyId }, select: { id: true, name: true } }),
      db.loan.findMany({ where: { companyId }, select: { id: true, name: true } }),
    ])
    const accountName = new Map(accounts.map((a) => [a.id, a.name]))
    const loanName = new Map(loans.map((l) => [l.id, l.name]))
    const items = rows.map((r) => ({
      ...r,
      fromAccountName: r.fromAccountId ? accountName.get(r.fromAccountId) ?? null : null,
      toAccountName: r.toAccountId ? accountName.get(r.toAccountId) ?? null : null,
      loanName: r.loanId ? loanName.get(r.loanId) ?? null : null,
      categoryLabel: r.category ? CATEGORY_LABEL[r.category] ?? r.category : null,
    }))
    return ok({ items, total: items.length })
  } catch (e) {
    return handleError(e)
  }
}

// POST /api/account-txns
//   ADJUST_IN  { toAccountId, amount, category: CAPITAL|OTHER_INCOME|OTHER }     — add cash/bank
//   ADJUST_OUT { fromAccountId, amount, category: DRAWINGS|OTHER_EXPENSE|OTHER } — reduce cash/bank
//   CONTRA     { fromAccountId, toAccountId, amount }                             — deposit / withdrawal / bank → bank
//   + date?, reference?, notes?
// Loan receipts / EMIs are created through /api/loans.
export async function POST(req: Request) {
  try {
    requireWrite(req, MODULE_KEY)
    const body = await req.json().catch(() => ({}) as Record<string, unknown>)
    const companyId = await companyRequired(req, body?.companyId)

    const type = String(body?.type || '').toUpperCase()
    if (!['ADJUST_IN', 'ADJUST_OUT', 'CONTRA'].includes(type)) {
      throw new ApiError('type must be ADJUST_IN, ADJUST_OUT or CONTRA (loans are recorded under Loans)', 400)
    }
    const amount = money(body?.amount, 'amount')
    const date = parseDate(body?.date, 'date') ?? new Date()
    let category: string | null = null
    if (type === 'ADJUST_IN') {
      category = String(body?.category || 'OTHER').toUpperCase()
      if (!IN_CATEGORIES.includes(category)) throw new ApiError(`category must be one of ${IN_CATEGORIES.join(', ')}`, 400)
    } else if (type === 'ADJUST_OUT') {
      category = String(body?.category || 'OTHER').toUpperCase()
      if (!OUT_CATEGORIES.includes(category)) throw new ApiError(`category must be one of ${OUT_CATEGORIES.join(', ')}`, 400)
    }

    const txn = await db.$transaction(async (txRaw) => {
      const tx = txRaw as CbTx
      const fromAcc = type === 'ADJUST_OUT' || type === 'CONTRA' ? await activeAccount(tx, companyId, body?.fromAccountId, 'From account') : null
      const toAcc = type === 'ADJUST_IN' || type === 'CONTRA' ? await activeAccount(tx, companyId, body?.toAccountId, 'To account') : null
      if (fromAcc && toAcc && fromAcc.id === toAcc.id) throw new ApiError('From and To accounts must be different', 400)

      const number = await nextDocNumber(tx, companyId, 'ATX', date)
      const created = await tx.accountTxn.create({
        data: {
          companyId, number, date, type,
          fromAccountId: fromAcc?.id ?? null,
          toAccountId: toAcc?.id ?? null,
          amount, category,
          reference: optStr(body?.reference),
          notes: optStr(body?.notes),
        },
      })
      const what = type === 'CONTRA'
        ? `Transfer ₹${amount.toFixed(2)} ${fromAcc!.name} → ${toAcc!.name}`
        : `${type === 'ADJUST_IN' ? 'Added' : 'Reduced'} ₹${amount.toFixed(2)} ${type === 'ADJUST_IN' ? 'to' : 'from'} ${(toAcc || fromAcc)!.name} (${CATEGORY_LABEL[category || 'OTHER'] || category})`
      await logAudit(tx, { companyId, userName: body?.userName, action: 'CREATE', entity: 'AccountTxn', entityId: created.id, details: `${number} • ${what}` })
      return created
    })
    return ok(txn, type === 'CONTRA' ? 'Transfer recorded' : 'Entry recorded')
  } catch (e) {
    return handleError(e)
  }
}
