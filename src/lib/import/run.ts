import { applyMapping, type MappingOptions } from '@/lib/import/apply-mapping'
import type { ImportDataType } from '@/lib/import/fields'
import type { TableRow } from '@/lib/import/parse-file'
import { importCustomers, type ImportSummary } from '@/lib/services/customer-import'
import { importItems } from '@/lib/services/item-import'
import { importSuppliers } from '@/lib/services/supplier-import'
import { importOpeningStock, type StockReconciliation } from '@/lib/services/opening-stock-import'
import { previewOpeningBalances, type OpeningBalanceTotals } from '@/lib/services/opening-balance-preview'

/**
 * Import Center pipeline shared by preview and commit: mapping checks (apply-mapping.ts), then
 * the same bulk import service the CSV dialogs use — with dryRun for the preview, so what the
 * preview reports is exactly what the commit would do with unchanged data.
 */

export type RunRowStatus = 'ready' | 'duplicate' | 'error' | 'imported' | 'failed'

export interface RunRow {
  line: number
  status: RunRowStatus
  messages: string[]
  warnings: string[]
  values: Record<string, string>
  code?: string
  extra?: Record<string, string | number | null>
}

export interface RunResult {
  headers: string[]
  notes: string[]
  rows: RunRow[]
  counts: { total: number; ready: number; imported: number; duplicates: number; errors: number; failed: number; withWarnings: number }
  /** Opening stock: source vs posted, read back from the stock ledger after the import. */
  reconciliation?: StockReconciliation
  /** Opening balances: Dr / Cr / net totals of the matched rows, to compare with the source report. */
  balanceTotals?: OpeningBalanceTotals
}

const STATUS: Record<ImportSummary['results'][number]['status'], RunRowStatus> = {
  ready: 'ready', imported: 'imported', skipped: 'duplicate', error: 'error', failed: 'failed',
}

export async function runImport(input: {
  companyId: string
  dataType: ImportDataType
  canWriteSuppliers: boolean
  table: TableRow[]
  headerRow: number
  mapping: unknown
  options?: MappingOptions
  dryRun: boolean
  /** Opening figures: the company's go-live date (checked by the route). */
  goLive?: Date
  /** Opening stock: reference stamped on every ledger row of this import. */
  importRef?: string
}): Promise<RunResult> {
  const mapped = applyMapping(input.dataType, input.table, input.headerRow, input.mapping, input.options)
  const { companyId, dryRun } = input
  const rowsIn = mapped.serviceRows
  let reconciliation: StockReconciliation | undefined
  let balanceTotals: OpeningBalanceTotals | undefined
  let summary: ImportSummary
  switch (input.dataType.key) {
    case 'customers':
      summary = await importCustomers(companyId, rowsIn, { canWriteSuppliers: input.canWriteSuppliers, dryRun })
      break
    case 'suppliers':
      summary = await importSuppliers(companyId, rowsIn, { dryRun })
      break
    case 'items':
      summary = await importItems(companyId, rowsIn, { dryRun, autoCode: true })
      break
    case 'opening-stock': {
      if (!input.goLive || (!dryRun && !input.importRef)) throw new Error('opening stock needs the go-live date and an import reference')
      const r = await importOpeningStock(companyId, rowsIn, { dryRun, goLive: input.goLive, defaultWarehouseId: input.options?.defaultWarehouseId || null, importRef: input.importRef ?? 'preview' })
      summary = r
      reconciliation = r.reconciliation
      break
    }
    case 'opening-balances': {
      if (!dryRun) throw new Error('opening balances are preview-only')
      if (!input.goLive) throw new Error('opening balances need the go-live date')
      const r = await previewOpeningBalances(companyId, rowsIn, { partyKind: input.options?.partyKind === 'supplier' ? 'supplier' : 'customer', goLive: input.goLive })
      summary = r
      balanceTotals = r.totals
      break
    }
    default:
      throw new Error(`no import for ${input.dataType.key}`)
  }
  const byRow = new Map(summary.results.map((r) => [r.row, r]))

  const rows: RunRow[] = mapped.rows.map((m) => {
    if (m.errors.length) return { line: m.line, status: 'error', messages: m.errors, warnings: m.warnings, values: m.values }
    const s = byRow.get(m.line)
    if (!s) return { line: m.line, status: 'error', messages: ['Row was not processed'], warnings: m.warnings, values: m.values }
    return {
      line: m.line, status: STATUS[s.status], messages: s.message ? [s.message] : [],
      warnings: [...m.warnings, ...s.warnings], values: m.values, code: s.code, extra: s.extra,
    }
  })
  const count = (st: RunRowStatus) => rows.filter((r) => r.status === st).length
  return {
    headers: mapped.headers,
    notes: mapped.notes,
    rows,
    counts: {
      total: rows.length, ready: count('ready'), imported: count('imported'), duplicates: count('duplicate'),
      errors: count('error'), failed: count('failed'), withWarnings: rows.filter((r) => r.warnings.length).length,
    },
    reconciliation,
    balanceTotals,
  }
}
