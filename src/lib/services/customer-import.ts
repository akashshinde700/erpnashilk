import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { ApiError } from '@/lib/erp-helpers'
import { gstinRequiredButMissing, partyData, partyCodeAllocator } from '@/lib/party'
import { createBothParty, createParty } from '@/lib/services/parties'
import { ImportDuplicateError, lockCompanyForImport } from '@/lib/import/lock'

/**
 * Bulk customer import, shared by POST /api/customers/import (CSV dialog) and the Import Center.
 * Each row goes through the same party validation as the customer form (partyData): GSTIN format,
 * state code / PAN / GST type derived from the GSTIN, phone / email / pincode checks.
 * Codes are auto-allocated in the C-0001 series when not provided. partyType BOTH also creates the
 * linked supplier (S-0001 series) and needs suppliers write access (canWriteSuppliers).
 *
 * dryRun: validate and detect duplicates exactly as an import would, without writing anything.
 * Otherwise every row is saved in its own transaction (a failure never leaves half a "Both" party).
 */

// confirm: waiting for the user to confirm importing it without a GSTIN (never imported without that answer);
// declined: the user chose not to import it without a GSTIN
export type ImportRowStatus = 'ready' | 'imported' | 'skipped' | 'error' | 'failed' | 'confirm' | 'declined'

export interface ImportRowResult {
  /** Row number as the user knows it (CSV line / spreadsheet row). */
  row: number
  status: ImportRowStatus
  message?: string
  warnings: string[]
  code?: string
  name?: string
  entityId?: string
  /** Data-type specific details shown in the preview / reconciliation (e.g. opening stock qty, rate). */
  extra?: Record<string, string | number | null>
}

export interface ImportSummary {
  imported: number
  skipped: number
  failed: number
  results: ImportRowResult[]
}

export interface ImportInputRow { row: number; data: Record<string, string> }

/**
 * Import from Tally only: a Regular / Composition / SEZ party for which Tally has no GSTIN is not refused but held
 * until the user answers for that record ('import' = import it with the GSTIN left empty, 'skip' = leave it out).
 * Keyed by the row number. A row without an answer is never imported (status 'confirm').
 */
export type GstinDecision = 'import' | 'skip'
export interface GstinConfirmation { decisions: Map<number, GstinDecision> }
export const GSTIN_MISSING_WARNING = 'GSTIN is not available for this party.'

/** Applies the user's answer to a GSTIN-less row; false = the row stops here (waiting for an answer, or declined). */
export function applyGstinDecision(res: ImportRowResult, confirm: GstinConfirmation): boolean {
  const answer = confirm.decisions.get(res.row)
  if (answer === 'import') {
    res.warnings.push(GSTIN_MISSING_WARNING)
    return true
  }
  if (answer === 'skip') {
    res.status = 'declined'
    res.message = 'Not imported: you chose not to import it without a GSTIN'
    return false
  }
  res.status = 'confirm'
  res.message = `${GSTIN_MISSING_WARNING} Confirm to import it without a GSTIN.`
  return false
}

// Columns read from each row (anything else is ignored — e.g. opening balances are not imported here).
export const CUSTOMER_IMPORT_FIELDS = ['name', 'code', 'gstin', 'gstType', 'pan', 'contactPerson', 'phone', 'email', 'addressLine', 'city', 'state', 'stateCode', 'pincode'] as const

const cell = (row: Record<string, string>, key: string) => {
  const v = row[key]
  return (v === undefined || v === null ? '' : String(v)).trim()
}

/** Row message safe to show the user: our own validation messages only, never database internals. */
export function rowMessage(e: unknown, fallback: string, logTag: string): string {
  if (e instanceof ApiError) return e.message
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return 'Duplicate code — skipped'
  console.error(`[${logTag}]`, e)
  return fallback
}

export async function importCustomers(companyId: string, rows: ImportInputRow[], opts: { canWriteSuppliers: boolean; dryRun?: boolean; gstinConfirm?: GstinConfirmation }): Promise<ImportSummary> {
  const [customers, suppliers, customerCodes, supplierCodes] = await Promise.all([
    db.customer.findMany({ where: { companyId }, select: { name: true } }),
    db.supplier.findMany({ where: { companyId }, select: { name: true } }),
    partyCodeAllocator(companyId, 'customer'),
    partyCodeAllocator(companyId, 'supplier'),
  ])
  const customerNames = new Set(customers.map((c) => c.name.trim().toLowerCase()))
  const supplierNames = new Set(suppliers.map((s) => s.name.trim().toLowerCase()))
  // Codes given explicitly in the file are reserved up front, so auto-numbered rows never take them
  for (const r of rows) {
    const c = cell(r.data, 'code').toUpperCase()
    if (c) { customerCodes.take(c); supplierCodes.take(c) }
  }
  const usedCodes = new Set<string>() // explicit codes already claimed by an earlier row of this file

  const results: ImportRowResult[] = []
  let imported = 0
  let skipped = 0
  let failed = 0

  for (const { row: rowNo, data: row } of rows) {
    const input: Record<string, string> = {}
    for (const f of CUSTOMER_IMPORT_FIELDS) input[f] = cell(row, f)
    const name = input.name
    const res: ImportRowResult = { row: rowNo, status: 'ready', warnings: [], name: name || undefined }
    results.push(res)
    const reject = (message: string, dup = false) => {
      res.status = dup ? 'skipped' : 'error'
      res.message = message
      if (dup) skipped++
    }

    if (!name) { reject('name is required'); continue }
    const partyType = (cell(row, 'partyType') || 'CUSTOMER').toUpperCase()
    if (partyType === 'SUPPLIER') { reject('Supplier-only rows are not imported here — add them under Suppliers'); continue }
    if (partyType !== 'CUSTOMER' && partyType !== 'BOTH') { reject(`Invalid partyType ${partyType} — must be CUSTOMER or BOTH`); continue }
    const both = partyType === 'BOTH'
    if (both && !opts.canWriteSuppliers) { reject('Your role is not allowed to create suppliers — BOTH row skipped'); continue }
    // Validate the profile before touching codes / names (same rules as the customer form). With gstinConfirm (Tally),
    // a missing GSTIN is decided below by the user; every other rule still applies here.
    const gstinMissing = !!opts.gstinConfirm && gstinRequiredButMissing(input)
    try {
      partyData(input, 'create', { gstinMayBeMissing: gstinMissing })
    } catch (e) {
      reject(rowMessage(e, 'Invalid row', 'customers/import'))
      continue
    }

    const lower = name.toLowerCase()
    if (customerNames.has(lower)) { reject(`Duplicate name ${name} — skipped`, true); continue }
    if (both && supplierNames.has(lower)) { reject(`A supplier named ${name} already exists — link it as Both from Parties instead — skipped`, true); continue }
    // Only a new, otherwise valid record is asked about; nothing is reserved for it until the user says yes
    if (gstinMissing && !applyGstinDecision(res, opts.gstinConfirm!)) continue
    let code = input.code.toUpperCase()
    if (code) {
      if (usedCodes.has(code) || customerCodes.exists(code) || (both && supplierCodes.exists(code))) {
        reject(`Duplicate code ${code} — skipped`, true)
        continue
      }
      usedCodes.add(code)
    } else {
      code = customerCodes.next()
    }
    // An explicit code is shared by both halves (as in the Both form); otherwise each side gets its own series
    const supplierCode = both ? (input.code ? code : supplierCodes.next()) : ''
    customerNames.add(lower)
    if (both) supplierNames.add(lower)
    res.code = code

    if (opts.dryRun) continue
    try {
      const created = await db.$transaction(async (tx) => {
        // Serialise with other imports of this company (any process) and re-check names created meanwhile
        await lockCompanyForImport(tx, companyId)
        if (await tx.customer.findFirst({ where: { companyId, name }, select: { id: true } })) throw new ImportDuplicateError(`Duplicate name ${name} — skipped`)
        if (both && await tx.supplier.findFirst({ where: { companyId, name }, select: { id: true } })) throw new ImportDuplicateError(`A supplier named ${name} already exists — skipped`)
        if (both) return (await createBothParty(tx, companyId, { ...input, code, supplierCode }, { gstinMayBeMissing: gstinMissing })).customer
        return createParty(tx, companyId, 'customer', { ...input, code, status: 'ACTIVE' }, { audit: false, gstinMayBeMissing: gstinMissing })
      })
      res.status = 'imported'
      res.entityId = created.id
      if (both) res.warnings.push(`Also created supplier ${supplierCode}`)
      imported++
    } catch (e) {
      if (e instanceof ImportDuplicateError) { res.status = 'skipped'; res.message = e.message; skipped++; continue }
      res.status = 'failed'
      res.message = rowMessage(e, 'Failed to create customer', 'customers/import')
      failed++
    }
  }
  return { imported, skipped, failed, results }
}

/** Legacy { imported, skipped, errors } shape of the CSV dialog endpoints. */
export function legacyResult(s: ImportSummary) {
  return {
    imported: s.imported,
    skipped: s.skipped,
    errors: s.results.filter((r) => r.message && r.status !== 'imported').map((r) => ({ row: r.row, message: r.message as string })),
  }
}
