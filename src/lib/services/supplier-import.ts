import { db } from '@/lib/db'
import { partyData, partyCodeAllocator } from '@/lib/party'
import { createParty } from '@/lib/services/parties'
import { ImportDuplicateError, lockCompanyForImport } from '@/lib/import/lock'
import { rowMessage, type ImportInputRow, type ImportRowResult, type ImportSummary } from '@/lib/services/customer-import'

/**
 * Bulk supplier import (Import Center). Same party validation as the supplier form (partyData):
 * GSTIN format, PAN / state code / GST type derived from the GSTIN, phone / email / pincode / IFSC /
 * bank account checks. Codes are auto-allocated in the S-0001 series when not provided.
 *
 * Duplicates (skipped, never created twice):
 *  - a supplier with the same name — including the supplier half of a "Both" party
 *  - the same code as an existing supplier or an earlier row
 * Warnings (created, but flagged):
 *  - a customer-only party with the same name (link the two as "Both" from Parties — not done here,
 *    because linking shares one profile and would overwrite the customer's details)
 *  - a GSTIN already used by another supplier (branches of one business share a GSTIN)
 *
 * dryRun: validate + detect duplicates only. Otherwise one transaction per row.
 */

// Columns read from each row (opening balances / credit limits are not imported here).
export const SUPPLIER_IMPORT_FIELDS = [
  'name', 'code', 'gstin', 'gstType', 'pan', 'contactPerson', 'phone', 'email', 'addressLine', 'city', 'state', 'stateCode',
  'pincode', 'bankName', 'bankAccountNo', 'bankIfsc', 'bankBranch', 'paymentTermsDays',
] as const

const cell = (row: Record<string, string>, key: string) => {
  const v = row[key]
  return (v === undefined || v === null ? '' : String(v)).trim()
}

export async function importSuppliers(companyId: string, rows: ImportInputRow[], opts: { dryRun?: boolean } = {}): Promise<ImportSummary> {
  const [suppliers, customers, codes] = await Promise.all([
    db.supplier.findMany({ where: { companyId }, select: { code: true, name: true, gstin: true, customer: { select: { code: true } } } }),
    db.customer.findMany({ where: { companyId, supplierId: null }, select: { code: true, name: true } }),
    partyCodeAllocator(companyId, 'supplier'),
  ])
  const supplierByName = new Map<string, { code: string; bothWith: string | null }>()
  for (const s of suppliers) supplierByName.set(s.name.trim().toLowerCase(), { code: s.code, bothWith: s.customer?.code ?? null })
  const customerOnly = new Map(customers.map((c) => [c.name.trim().toLowerCase(), c.code]))
  const gstinOwner = new Map<string, string>()
  for (const s of suppliers) if (s.gstin) gstinOwner.set(s.gstin.toUpperCase(), `${s.code} ${s.name}`)
  // Codes given explicitly in the file are reserved up front, so auto-numbered rows never take them
  for (const r of rows) {
    const c = cell(r.data, 'code').toUpperCase()
    if (c) codes.take(c)
  }
  const usedCodes = new Set<string>()
  const seenNames = new Set<string>()

  const results: ImportRowResult[] = []
  let imported = 0
  let skipped = 0
  let failed = 0

  for (const { row: rowNo, data: row } of rows) {
    const input: Record<string, string> = {}
    for (const f of SUPPLIER_IMPORT_FIELDS) input[f] = cell(row, f)
    const name = input.name
    const res: ImportRowResult = { row: rowNo, status: 'ready', warnings: [], name: name || undefined }
    results.push(res)
    const reject = (message: string, dup = false) => {
      res.status = dup ? 'skipped' : 'error'
      res.message = message
      if (dup) skipped++
    }

    if (!name) { reject('name is required'); continue }
    let profile: Record<string, string | number | null>
    try {
      profile = partyData(input, 'create')
    } catch (e) {
      reject(rowMessage(e, 'Invalid row', 'suppliers/import'))
      continue
    }

    const lower = name.toLowerCase()
    const existing = supplierByName.get(lower)
    if (existing) {
      reject(existing.bothWith
        ? `${name} already exists as supplier ${existing.code} (a "Both" party with customer ${existing.bothWith}) — skipped`
        : `Duplicate name ${name} (supplier ${existing.code}) — skipped`, true)
      continue
    }
    if (seenNames.has(lower)) { reject(`Duplicate name ${name} earlier in this file — skipped`, true); continue }
    let code = input.code.toUpperCase()
    if (code) {
      if (usedCodes.has(code) || codes.exists(code)) { reject(`Duplicate code ${code} — skipped`, true); continue }
      usedCodes.add(code)
    } else {
      code = codes.next()
    }
    seenNames.add(lower)
    res.code = code
    const asCustomer = customerOnly.get(lower)
    if (asCustomer) res.warnings.push(`A customer named ${name} exists (${asCustomer}) — to treat them as one "Both" party, link them from Parties`)
    const gstin = typeof profile.gstin === 'string' ? profile.gstin : ''
    if (gstin) {
      const owner = gstinOwner.get(gstin)
      if (owner) res.warnings.push(`GSTIN ${gstin} is also on supplier ${owner}`)
      else gstinOwner.set(gstin, `${code} ${name}`)
    }

    if (opts.dryRun) continue
    try {
      const created = await db.$transaction(async (tx) => {
        // Serialise with other imports of this company (any process) and re-check names created meanwhile
        await lockCompanyForImport(tx, companyId)
        if (await tx.supplier.findFirst({ where: { companyId, name }, select: { id: true } })) throw new ImportDuplicateError(`Duplicate name ${name} — skipped`)
        return createParty(tx, companyId, 'supplier', { ...input, code, status: 'ACTIVE' }, { audit: false })
      })
      res.status = 'imported'
      res.entityId = created.id
      imported++
    } catch (e) {
      if (e instanceof ImportDuplicateError) { res.status = 'skipped'; res.message = e.message; skipped++; continue }
      res.status = 'failed'
      res.message = rowMessage(e, 'Failed to create supplier', 'suppliers/import')
      failed++
    }
  }
  return { imported, skipped, failed, results }
}
