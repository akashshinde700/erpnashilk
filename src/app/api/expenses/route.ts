import { db } from '@/lib/db'
import { ApiError, companyRequired, handleError, logAudit, nextDocNumber, ok, r2, requireWrite } from '@/lib/erp-helpers'
import { accountForMode } from '@/lib/accounts'

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

const EXPENSE_TYPES = ['DIRECT', 'INDIRECT']
function expenseType(v: unknown): string {
  const s = String(v || 'INDIRECT').trim().toUpperCase()
  if (!EXPENSE_TYPES.includes(s)) throw new ApiError('expenseType must be DIRECT or INDIRECT', 400)
  return s
}

// GET /api/expenses?companyId=&q=&category=&expenseType=&accountId= → { items (+ accountName), total } (date desc)
export async function GET(req: Request) {
  try {
    const companyId = await companyRequired(req)
    const { searchParams } = new URL(req.url)
    const q = (searchParams.get('q') || '').trim()
    const category = (searchParams.get('category') || '').trim()
    const type = (searchParams.get('expenseType') || '').trim().toUpperCase()
    const accountId = (searchParams.get('accountId') || '').trim()
    const rows = await db.expense.findMany({
      where: {
        companyId,
        ...(category ? { category } : {}),
        ...(type ? { expenseType: type } : {}),
        ...(accountId ? { accountId } : {}),
        ...(q
          ? {
              OR: [
                { number: { contains: q } },
                { description: { contains: q } },
                { paidTo: { contains: q } },
              ],
            }
          : {}),
      },
      orderBy: { date: 'desc' },
    })
    const accounts = await db.moneyAccount.findMany({ where: { companyId }, select: { id: true, name: true } })
    const accountName = new Map(accounts.map((a) => [a.id, a.name]))
    const items = rows.map((r) => ({ ...r, accountName: r.accountId ? accountName.get(r.accountId) ?? null : null }))
    return ok({ items, total: items.length })
  } catch (e) {
    return handleError(e)
  }
}

// POST /api/expenses { companyId, date, category, description, amount>0, paymentMode, paidTo?, gstAmount?,
//   vendorGstin?, billNo?, billDate?, itcEligible?, status? (DRAFT|POSTED|CANCELLED, default POSTED),
//   accountId? (default by payment mode), expenseType? (DIRECT|INDIRECT, default INDIRECT), userName? }
export async function POST(req: Request) {
  try {
    requireWrite(req, 'expenses')
    const body = await req.json().catch(() => ({}))
    const companyId = await companyRequired(req, body?.companyId)

    const description = String(body?.description || '').trim()
    if (!description) throw new ApiError('description is required', 400)
    const amount = Number(body?.amount)
    if (!Number.isFinite(amount) || amount <= 0) throw new ApiError('amount must be greater than 0', 400)
    const date = body?.date ? new Date(body.date) : new Date()
    if (Number.isNaN(date.getTime())) throw new ApiError('Invalid date', 400)
    const vendorGstin = optGstin(body?.vendorGstin)
    const billDate = optDate(body?.billDate, 'billDate')
    const status = body?.status ? expenseStatus(body.status) : 'POSTED'
    const type = expenseType(body?.expenseType)
    const paymentMode = body?.paymentMode ? String(body.paymentMode) : 'CASH'

    const expense = await db.$transaction(async (tx) => {
      const t = tx as unknown as Parameters<typeof nextDocNumber>[0] & Parameters<typeof logAudit>[0]
      const number = await nextDocNumber(t, companyId, 'EXP', date)
      if (body?.accountId) {
        const acc = await tx.moneyAccount.findFirst({ where: { id: String(body.accountId), companyId } })
        if (!acc) throw new ApiError('Account not found', 404)
        if (!acc.active) throw new ApiError(`Account ${acc.name} is inactive`, 400)
      }
      const accountId = await accountForMode(tx, companyId, paymentMode, body?.accountId ? String(body.accountId) : null)
      const created = await tx.expense.create({
        data: {
          companyId,
          number,
          date,
          category: body?.category ? String(body.category) : 'OTHER',
          description,
          amount: r2(amount),
          paymentMode,
          accountId,
          expenseType: type,
          paidTo: body?.paidTo ? String(body.paidTo).trim() : null,
          gstAmount: r2(Number(body?.gstAmount) || 0),
          status,
          vendorGstin,
          billNo: optStr(body?.billNo),
          billDate,
          itcEligible: body?.itcEligible === true || body?.itcEligible === 'true',
        },
      })
      await logAudit(t, {
        companyId,
        userName: body?.userName,
        action: 'CREATE',
        entity: 'EXPENSE',
        entityId: created.id,
        details: `Expense ${created.number} of ₹${r2(amount)} ${status === 'POSTED' ? 'posted' : `saved as ${status}`} (${created.category})`,
      })
      return created
    })
    return ok(expense, 'Expense recorded')
  } catch (e) {
    return handleError(e)
  }
}
