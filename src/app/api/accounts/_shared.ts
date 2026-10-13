import { Prisma } from '@prisma/client'
import { ApiError, logAudit, nextDocNumber } from '@/lib/erp-helpers'

// Shared helpers for the Cash & Bank APIs (accounts, account-txns, loans).

/** Transaction client usable with nextDocNumber / logAudit and the accounts helpers. */
export type CbTx = Prisma.TransactionClient & Parameters<typeof nextDocNumber>[0] & Parameters<typeof logAudit>[0]

export const MODULE_KEY = 'cash-bank'

/** 'YYYY-MM-DD' → UTC midnight (end of day with endOfDay); full ISO strings parsed as-is. null for empty. */
export function parseDate(v: unknown, field: string, endOfDay = false): Date | null {
  if (v === undefined || v === null || v === '') return null
  const s = String(v).trim()
  if (!s) return null
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z` : s)
  if (Number.isNaN(d.getTime())) throw new ApiError(`${field} must be a valid date`, 400)
  return d
}

export const optStr = (v: unknown): string | null => (v === undefined || v === null ? null : String(v).trim() || null)

export function money(v: unknown, field: string, { allowZero = false } = {}): number {
  const n = Number(v ?? 0)
  if (!Number.isFinite(n) || n < 0 || (!allowZero && n === 0)) throw new ApiError(`${field} must be greater than ${allowZero ? 'or equal to ' : ''}0`, 400)
  return Math.round(n * 100) / 100
}

/** Loads an active account of the tenant or throws. */
export async function activeAccount(tx: Prisma.TransactionClient, companyId: string, id: unknown, label: string) {
  if (!id) throw new ApiError(`${label} is required`, 400)
  const a = await tx.moneyAccount.findFirst({ where: { id: String(id), companyId } })
  if (!a) throw new ApiError(`${label} not found`, 404)
  if (!a.active) throw new ApiError(`${label} (${a.name}) is inactive`, 400)
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
