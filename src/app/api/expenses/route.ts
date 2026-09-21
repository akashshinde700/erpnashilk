import { db } from '@/lib/db'
import { ApiError, companyRequired, handleError, logAudit, nextDocNumber, ok, r2 } from '@/lib/erp-helpers'

// GET /api/expenses?companyId=&q=&category= → { items, total } (date desc)
export async function GET(req: Request) {
  try {
    const companyId = await companyRequired(req)
    const { searchParams } = new URL(req.url)
    const q = (searchParams.get('q') || '').trim()
    const category = (searchParams.get('category') || '').trim()
    const items = await db.expense.findMany({
      where: {
        companyId,
        ...(category ? { category } : {}),
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
    return ok({ items, total: items.length })
  } catch (e) {
    return handleError(e)
  }
}

// POST /api/expenses { companyId, date, category, description, amount>0, paymentMode, paidTo?, gstAmount?, userName? }
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}))
    const companyId = await companyRequired(req, body?.companyId)

    const description = String(body?.description || '').trim()
    if (!description) throw new ApiError('description is required', 400)
    const amount = Number(body?.amount)
    if (!Number.isFinite(amount) || amount <= 0) throw new ApiError('amount must be greater than 0', 400)
    const date = body?.date ? new Date(body.date) : new Date()
    if (Number.isNaN(date.getTime())) throw new ApiError('Invalid date', 400)

    const expense = await db.$transaction(async (tx) => {
      const t = tx as unknown as Parameters<typeof nextDocNumber>[0] & Parameters<typeof logAudit>[0]
      const number = await nextDocNumber(t, companyId, 'EXP', date)
      const created = await tx.expense.create({
        data: {
          companyId,
          number,
          date,
          category: body?.category ? String(body.category) : 'OTHER',
          description,
          amount: r2(amount),
          paymentMode: body?.paymentMode ? String(body.paymentMode) : 'CASH',
          paidTo: body?.paidTo ? String(body.paidTo).trim() : null,
          gstAmount: r2(Number(body?.gstAmount) || 0),
          status: 'POSTED',
        },
      })
      await logAudit(t, {
        companyId,
        userName: body?.userName,
        action: 'CREATE',
        entity: 'EXPENSE',
        entityId: created.id,
        details: `Expense ${created.number} of ₹${r2(amount)} posted (${created.category})`,
      })
      return created
    })
    return ok(expense, 'Expense recorded')
  } catch (e) {
    return handleError(e)
  }
}
