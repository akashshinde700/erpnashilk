import { db } from '@/lib/db'
import { ApiError, companyRequired, handleError, logAudit, ok, requireWrite } from '@/lib/erp-helpers'
import { accountBalances } from '@/lib/accounts'
import { CbTx, MODULE_KEY, optStr, parseDate } from './_shared'

const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/

// GET /api/accounts?companyId=&active=1 → { items: (MoneyAccount & { balance, inflow, outflow })[], total }
export async function GET(req: Request) {
  try {
    const companyId = await companyRequired(req)
    const { searchParams } = new URL(req.url)
    const onlyActive = searchParams.get('active') === '1'
    // accountBalances creates the default "Cash in Hand" account on first use
    const balances = await accountBalances(companyId)
    const accounts = await db.moneyAccount.findMany({
      where: { companyId, ...(onlyActive ? { active: true } : {}) },
      orderBy: [{ type: 'asc' }, { isDefault: 'desc' }, { name: 'asc' }],
    })
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
    const openingDate = parseDate(body?.openingDate, 'openingDate')
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
        details: `${type === 'BANK' ? 'Bank' : 'Cash'} account "${name}" added (opening ₹${created.openingBalance.toFixed(2)})`,
      })
      return created
    })
    return ok(account, 'Account added')
  } catch (e) {
    return handleError(e)
  }
}
