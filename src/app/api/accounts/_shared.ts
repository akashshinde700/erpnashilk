import { Prisma } from '@prisma/client'
import { ApiError, logAudit, nextDocNumber } from '@/lib/erp-helpers'
import { endOfDayStr } from '@/lib/accounting'
import { assertOnOrAfterOpening } from '@/lib/accounts'

// Shared helpers for the Cash & Bank APIs (accounts, account-txns, loans).

/** Transaction client usable with nextDocNumber / logAudit and the accounts helpers. */
export type CbTx = Prisma.TransactionClient & Parameters<typeof nextDocNumber>[0] & Parameters<typeof logAudit>[0]

export const MODULE_KEY = 'cash-bank'

/**
 * Filter bound (from / to of a list or statement): 'YYYY-MM-DD' → UTC midnight, or with endOfDay the same end of
 * day the reports use (endOfDayStr); full ISO strings parsed as-is. null for empty.
 * Dates that are stored (entry dates, opening dates) go through businessDate() instead.
 */
export function parseDate(v: unknown, field: string, endOfDay = false): Date | null {
  if (v === undefined || v === null || v === '') return null
  const s = String(v).trim()
  if (!s) return null
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(s)
  const d = dateOnly && endOfDay ? endOfDayStr(s, field) : new Date(dateOnly ? `${s}T00:00:00.000Z` : s)
  if (Number.isNaN(d.getTime())) throw new ApiError(`${field} must be a valid date`, 400)
  return d
}

export const optStr = (v: unknown): string | null => (v === undefined || v === null ? null : String(v).trim() || null)

export function money(v: unknown, field: string, { allowZero = false } = {}): number {
  const n = Number(v ?? 0)
  if (!Number.isFinite(n) || n < 0 || (!allowZero && n === 0)) throw new ApiError(`${field} must be greater than ${allowZero ? 'or equal to ' : ''}0`, 400)
  return Math.round(n * 100) / 100
}

/** Loads an active account of the tenant or throws; with `onDate`, also refuses a date before its opening date. */
export async function activeAccount(tx: Prisma.TransactionClient, companyId: string, id: unknown, label: string, onDate?: Date) {
  if (!id) throw new ApiError(`${label} is required`, 400)
  const a = await tx.moneyAccount.findFirst({ where: { id: String(id), companyId } })
  if (!a) throw new ApiError(`${label} not found`, 404)
  if (!a.active) throw new ApiError(`${label} (${a.name}) is inactive`, 400)
  if (onDate) assertOnOrAfterOpening(a, onDate)
  return a
}

export const TXN_TYPE_LABEL: Record<string, string> = {
  ADJUST_IN: 'Add money',
  ADJUST_OUT: 'Reduce money',
  CONTRA: 'Contra transfer',
  LOAN_IN: 'Loan received',
  LOAN_EMI: 'Loan EMI',
}

export const CATEGORY_LABEL: Record<string, string> = {
  CAPITAL: 'Owner capital',
  DRAWINGS: 'Drawings',
  OTHER_INCOME: 'Other income',
  OTHER_EXPENSE: 'Other expense',
  OTHER: 'Other',
  LOAN: 'Loan',
}
