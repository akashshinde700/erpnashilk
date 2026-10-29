import { db } from '@/lib/db'
import { ApiError, companyRequired, handleError, logAudit, ok, requireWrite, requireRead } from '@/lib/erp-helpers'
import { accountBalances, entriesBefore } from '@/lib/accounts'
import { istDay, optBusinessDate } from '@/lib/business-date'
import { CASH_TX, assertCashNotNegative, negativeCashOverride } from '@/lib/cash-guard'
import { CbTx, MODULE_KEY, optStr } from '../_shared'

type Params = { params: Promise<{ id: string }> }

const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/

// GET /api/accounts/[id]?companyId= → account with balance
export async function GET(req: Request, { params }: Params) {
  try {
    requireRead(req, 'cash-bank') // Phase 5: financial read permission
    const { id } = await params
    const companyId = await companyRequired(req)
    const account = await db.moneyAccount.findFirst({ where: { id, companyId } })
    if (!account) throw new ApiError('Account not found', 404)
    const b = (await accountBalances(companyId)).find((x) => x.id === id)
    return ok({ ...account, balance: b?.balance ?? account.openingBalance, inflow: b?.inflow ?? 0, outflow: b?.outflow ?? 0 })
  } catch (e) {
    return handleError(e)
  }
}

// PATCH /api/accounts/[id] { companyId, name?, bankName?, accountNo?, ifsc?, branch?, upiId?, holderName?,
//   openingBalance?, openingDate?, printOnInvoice?, isDefault?, active? } — the type can't be changed
export async function PATCH(req: Request, { params }: Params) {
  try {
    requireWrite(req, MODULE_KEY)
    const { id } = await params
    const body = await req.json().catch(() => ({}) as Record<string, unknown>)
    const companyId = await companyRequired(req, body?.companyId)

    const existing = await db.moneyAccount.findFirst({ where: { id, companyId } })
    if (!existing) throw new ApiError('Account not found', 404)
    if ('type' in body && body.type && String(body.type).toUpperCase() !== existing.type) {
      throw new ApiError('The account type cannot be changed — add a new account instead', 400)
    }

    const data: Record<string, unknown> = {}
    if ('name' in body) {
      const name = String(body.name || '').trim()
      if (!name) throw new ApiError('Account name cannot be empty', 400)
      data.name = name
    }
    const isBank = existing.type === 'BANK'
    for (const k of ['bankName', 'accountNo', 'branch', 'upiId', 'holderName'] as const) {
      if (k in body && isBank) data[k] = optStr(body[k])
    }
    if ('ifsc' in body && isBank) {
      const ifsc = optStr(body.ifsc)?.toUpperCase() ?? null
      if (ifsc && !IFSC_RE.test(ifsc)) throw new ApiError('IFSC must be 11 characters, e.g. SBIN0001234', 400)
      data.ifsc = ifsc
    }
    if ('openingBalance' in body) {
      const n = Number(body.openingBalance ?? 0)
      if (!Number.isFinite(n)) throw new ApiError('openingBalance must be a number', 400)
      data.openingBalance = Math.round(n * 100) / 100
    }
    if ('openingDate' in body) data.openingDate = optBusinessDate(body.openingDate, 'Opening date')
    // Opening figures: a non-zero opening balance needs its date (checked when either is being set)
    const newOpening = 'openingBalance' in data ? (data.openingBalance as number) : existing.openingBalance
    const newOpeningDate = 'openingDate' in data ? (data.openingDate as Date | null) : existing.openingDate
    const openingTouched = 'openingBalance' in data || 'openingDate' in data
    if (openingTouched && Math.abs(newOpening) >= 0.005 && !newOpeningDate) {
      throw new ApiError('Opening date is required when there is an opening balance', 400)
    }
    const override = negativeCashOverride(req, body as { allowNegativeCash?: unknown })
    if ('printOnInvoice' in body) data.printOnInvoice = isBank && body.printOnInvoice === true
    if ('isDefault' in body) data.isDefault = body.isDefault === true
    if ('active' in body) {
      data.active = body.active !== false
      if (data.active === false) data.isDefault = false
    }

    const account = await db.$transaction(async (txRaw) => {
      const tx = txRaw as CbTx
      if (typeof data.name === 'string' && data.name !== existing.name) {
        const dup = await tx.moneyAccount.findFirst({ where: { companyId, name: data.name, id: { not: id } } })
        if (dup) throw new ApiError(`An account named "${data.name}" already exists`, 409)
      }
      if (data.active === false && existing.type === 'CASH') {
        const others = await tx.moneyAccount.count({ where: { companyId, type: 'CASH', active: true, id: { not: id } } })
        if (!others) throw new ApiError('This is the only cash account — it cannot be deactivated', 400)
      }
      if (data.isDefault === true) {
        await tx.moneyAccount.updateMany({ where: { companyId, type: existing.type, isDefault: true, id: { not: id } }, data: { isDefault: false } })
      }
      // Moving the opening date later would leave entries before it — they belong after the opening balance
      if (newOpeningDate && (!existing.openingDate || istDay(newOpeningDate) > istDay(existing.openingDate))) {
        const n = await entriesBefore(tx, companyId, id, newOpeningDate)
        if (n) throw new ApiError(`${n} entr${n === 1 ? 'y is' : 'ies are'} dated before ${istDay(newOpeningDate)} in this account — the opening date cannot be after them`, 400)
      }
      const updated = await tx.moneyAccount.update({ where: { id: existing.id }, data })
      // Audit: old → new opening figures (who and when are on the audit row itself)
      const changes: string[] = []
      if ('openingBalance' in data && newOpening !== existing.openingBalance) changes.push(`opening balance ₹${existing.openingBalance.toFixed(2)} → ₹${newOpening.toFixed(2)}`)
      const dayOf = (d: Date | null) => (d ? istDay(d) : 'none')
      if ('openingDate' in data && dayOf(newOpeningDate) !== dayOf(existing.openingDate)) changes.push(`opening date ${dayOf(existing.openingDate)} → ${dayOf(newOpeningDate)}`)
      if (typeof data.name === 'string' && data.name !== existing.name) changes.push(`name "${existing.name}" → "${data.name}"`)
      await logAudit(tx, {
        companyId, userName: body?.userName, action: 'UPDATE', entity: 'MoneyAccount', entityId: id,
        details: `Account "${updated.name}" updated${data.active === false ? ' (deactivated)' : ''}${changes.length ? `: ${changes.join('; ')}` : ''}`,
      })
      // Phase 5: a lower opening balance lowers every later day of a cash account
      if (newOpening < existing.openingBalance - 0.005) {
        await assertCashNotNegative(txRaw, { companyId, accounts: [{ accountId: id }], from: newOpeningDate, override, what: 'The new opening balance', entity: 'MoneyAccount', entityId: id, userName: body?.userName as string | undefined })
      }
      return updated
    }, CASH_TX)
    return ok(account, 'Account updated')
  } catch (e) {
    return handleError(e)
  }
}

// DELETE /api/accounts/[id]?companyId= — only when nothing references it and it isn't the last cash account
export async function DELETE(req: Request, { params }: Params) {
  try {
    requireWrite(req, MODULE_KEY)
    const { id } = await params
    const body = await req.json().catch(() => ({}) as Record<string, unknown>)
    const companyId = await companyRequired(req, body?.companyId)

    const existing = await db.moneyAccount.findFirst({ where: { id, companyId } })
    if (!existing) throw new ApiError('Account not found', 404)

    await db.$transaction(async (txRaw) => {
      const tx = txRaw as CbTx
      if (existing.type === 'CASH') {
        const others = await tx.moneyAccount.count({ where: { companyId, type: 'CASH', id: { not: id } } })
        if (!others) throw new ApiError('The last cash account cannot be deleted', 400)
      }
      const [payments, expenses, txns, loans, sales, purchases] = await Promise.all([
        tx.payment.count({ where: { companyId, accountId: id } }),
        tx.expense.count({ where: { companyId, accountId: id } }),
        tx.accountTxn.count({ where: { companyId, OR: [{ fromAccountId: id }, { toAccountId: id }] } }),
        tx.loan.count({ where: { companyId, receivedAccountId: id } }),
        tx.salesInvoice.count({ where: { companyId, accountId: id } }),
        tx.purchaseInvoice.count({ where: { companyId, accountId: id } }),
      ])
      const refs = payments + expenses + txns + loans + sales + purchases
      if (refs > 0) {
        throw new ApiError(`"${existing.name}" has ${refs} linked entr${refs === 1 ? 'y' : 'ies'} — deactivate it instead of deleting`, 400)
      }
      await tx.moneyAccount.delete({ where: { id: existing.id } })
      await logAudit(tx, {
        companyId, userName: body?.userName, action: 'DELETE', entity: 'MoneyAccount', entityId: id,
        details: `Account "${existing.name}" deleted`,
      })
    })
    return ok({ id }, 'Account deleted')
  } catch (e) {
    return handleError(e)
  }
}
