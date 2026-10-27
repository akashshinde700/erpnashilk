import { db } from '@/lib/db'
import { ApiError, companyRequired, handleError, logAudit, ok, requireWrite, requireRead } from '@/lib/erp-helpers'
import { accountBalances } from '@/lib/accounts'
import { canAccessModule } from '@/lib/erp-constants'
import { istDay, optBusinessDate } from '@/lib/business-date'
import { CbTx, MODULE_KEY, optStr } from './_shared'

const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/

// GET /api/accounts?companyId=&active=1 → { items: (MoneyAccount & { balance, inflow, outflow })[], total }
// Phase 5 read permission: the full list (balances, opening figures, bank details) needs Cash & Bank. Roles that record
// money elsewhere (payments, expenses, invoices / bills "received / paid now", return refunds) get the account picker
// only: id, name, type, active, isDefault — no balances.
const PICKER_MODULES = ['payments', 'expenses', 'sales-invoices', 'purchase-invoices', 'sales-returns', 'purchase-returns']
export async function GET(req: Request) {
  try {
    const actor = requireRead(req, ['cash-bank', ...PICKER_MODULES]) // Phase 5: financial read permission
    const companyId = await companyRequired(req)
    const { searchParams } = new URL(req.url)
    const onlyActive = searchParams.get('active') === '1'
    const accounts = await db.moneyAccount.findMany({
      where: { companyId, ...(onlyActive ? { active: true } : {}) },
      orderBy: [{ type: 'asc' }, { isDefault: 'desc' }, { name: 'asc' }],
    })
    if (!canAccessModule(actor.role, 'cash-bank')) {
      const items = accounts.map((a) => ({ id: a.id, name: a.name, type: a.type, active: a.active, isDefault: a.isDefault, createdAt: a.createdAt }))
      return ok({ items, total: items.length })
    }
    const balances = await accountBalances(companyId)
    const map = new Map(balances.map((b) => [b.id, b]))
    const items = accounts.map((a) => {
      const b = map.get(a.id)
      return { ...a, balance: b?.balance ?? a.openingBalance, inflow: b?.inflow ?? 0, outflow: b?.outflow ?? 0 }
    })
    return ok({ items, total: items.length })
  } catch (e) {
    return handleError(e)
  }
}

// POST /api/accounts { companyId, type: CASH|BANK, name, bankName?, accountNo?, ifsc?, branch?, upiId?, holderName?,
//   openingBalance?, openingDate?, printOnInvoice?, isDefault? }
export async function POST(req: Request) {
  try {
    requireWrite(req, MODULE_KEY)
    const body = await req.json().catch(() => ({}) as Record<string, unknown>)
    const companyId = await companyRequired(req, body?.companyId)

    const type = String(body?.type || '').toUpperCase()
    if (!['CASH', 'BANK'].includes(type)) throw new ApiError('type must be CASH or BANK', 400)
    const name = String(body?.name || '').trim()
    if (!name) throw new ApiError('Account name is required', 400)
    const ifsc = optStr(body?.ifsc)?.toUpperCase() ?? null
    if (ifsc && !IFSC_RE.test(ifsc)) throw new ApiError('IFSC must be 11 characters, e.g. SBIN0001234', 400)
    const openingBalance = Number(body?.openingBalance ?? 0)
    if (!Number.isFinite(openingBalance)) throw new ApiError('openingBalance must be a number', 400)
    const openingDate = optBusinessDate(body?.openingDate, 'Opening date')
    if (Math.abs(openingBalance) >= 0.005 && !openingDate) throw new ApiError('Opening date is required when there is an opening balance', 400)
    const isDefault = body?.isDefault === true

    const account = await db.$transaction(async (txRaw) => {
      const tx = txRaw as CbTx
      const dup = await tx.moneyAccount.findFirst({ where: { companyId, name } })
      if (dup) throw new ApiError(`An account named "${name}" already exists`, 409)
      if (isDefault) await tx.moneyAccount.updateMany({ where: { companyId, type, isDefault: true }, data: { isDefault: false } })
      const created = await tx.moneyAccount.create({
        data: {
          companyId, type, name,
          bankName: type === 'BANK' ? optStr(body?.bankName) : null,
          accountNo: type === 'BANK' ? optStr(body?.accountNo) : null,
          ifsc: type === 'BANK' ? ifsc : null,
          branch: type === 'BANK' ? optStr(body?.branch) : null,
          upiId: type === 'BANK' ? optStr(body?.upiId) : null,
          holderName: type === 'BANK' ? optStr(body?.holderName) : null,
          openingBalance: Math.round(openingBalance * 100) / 100,
          openingDate,
          printOnInvoice: type === 'BANK' && body?.printOnInvoice === true,
          isDefault,
        },
      })
      await logAudit(tx, {
        companyId, userName: body?.userName, action: 'CREATE', entity: 'MoneyAccount', entityId: created.id,
        details: `${type === 'BANK' ? 'Bank' : 'Cash'} account "${name}" added (opening ₹${created.openingBalance.toFixed(2)}${openingDate ? ` as of ${istDay(openingDate)}` : ''})`,
      })
      return created
    })
    return ok(account, 'Account added')
  } catch (e) {
    return handleError(e)
  }
}
