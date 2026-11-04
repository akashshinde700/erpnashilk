import { randomBytes } from 'node:crypto'
import { Prisma, type TallyJob } from '@prisma/client'
import { db } from '@/lib/db'
import type { TallyJobType } from '@/lib/tally/connector'

/**
 * Layer 1: a faithful copy of Tally's masters (TallySourceMaster), kept apart from ManuFlow's business tables.
 *
 * Every finished master export of a Tally company is saved here, one row per Tally GUID per company:
 *  - re-reading updates the row (name, parent, ALTERID; the fields read are merged into `data`), so it is idempotent;
 *  - after a FULL read of a kind (all groups, all ledgers, all stock items, …) the rows of that kind it did not contain
 *    get `missingSince`; a later read that has them again clears it. Customers / suppliers are only part of the ledgers,
 *    so they never mark anything missing;
 *  - a record with a problem is kept, with the problem in `issues` (no GUID → keyed by name instead, ALTERID or opening
 *    balance not a number);
 *  - nothing is ever deleted here, automatically or otherwise (permanent deletion would be a separate, previewed action).
 *
 * Nothing in this file reads or writes Customer, Supplier, Item or any other business table.
 */

export const MASTER_KINDS = ['group', 'ledger', 'stockgroup', 'stockitem', 'unit', 'godown'] as const
export type MasterKind = (typeof MASTER_KINDS)[number]

/** Which kind a job reads, and whether it reads all of that kind (only then can absence mean "missing"). */
export const LAYER1_SOURCE: Partial<Record<TallyJobType, { kind: MasterKind; full: boolean }>> = {
  'export-customers': { kind: 'ledger', full: false },
  'export-suppliers': { kind: 'ledger', full: false },
  'export-ledgers': { kind: 'ledger', full: true },
  'export-groups': { kind: 'group', full: true },
  'export-items': { kind: 'stockitem', full: true },
  'export-stockgroups': { kind: 'stockgroup', full: true },
  'export-units': { kind: 'unit', full: true },
  'export-godowns': { kind: 'godown', full: true },
}

export interface MasterIssue { code: 'no_guid' | 'bad_alter_id' | 'bad_opening_balance'; message: string }

const BATCH = 200
const TOP_LEVEL = new Set(['guid', 'name', 'parent', 'alterId'])

/**
 * A signed Tally amount ("1234.50", "-1,234.50") → paise, or null when it is not one. The sign is kept exactly as Tally
 * wrote it (its debit / credit meaning is not interpreted here); "Dr" / "Cr" text is not guessed at and gives null.
 */
export function amountToPaise(s: string): number | null {
  const m = /^\s*(-)?\s*([\d,]+)(?:\.(\d{1,2}))?\s*$/.exec(s)
  if (!m) return null
  const rupees = Number(m[2].replaceAll(',', ''))
  const paise = rupees * 100 + Number((m[3] ?? '').padEnd(2, '0') || 0)
  return m[1] ? -paise : paise
}

/** One record as it is stored: identity columns, the rest of the fields in `data`, problems in `issues`. */
export function sourceRow(r: Record<string, string>) {
  const issues: MasterIssue[] = []
  let guid = r.guid?.trim() ?? ''
  if (!guid) {
    guid = `name:${r.name}`.slice(0, 100)
    issues.push({ code: 'no_guid', message: 'Tally sent no GUID for this record; it is matched by its name instead.' })
  }
  let alterId: number | null = null
  if (r.alterId?.trim()) {
    alterId = /^\d{1,9}$/.test(r.alterId.trim()) ? Number(r.alterId.trim()) : null
    if (alterId === null) issues.push({ code: 'bad_alter_id', message: 'The ALTERID Tally sent is not a whole number.' })
  }
  const data: Record<string, string | number> = {}
  for (const [k, v] of Object.entries(r)) if (!TOP_LEVEL.has(k) && v) data[k] = v
  if (r.openingBalance) {
    const p = amountToPaise(r.openingBalance)
    if (p === null) issues.push({ code: 'bad_opening_balance', message: 'The opening balance Tally sent is not an amount ManuFlow understands.' })
    else data.openingBalancePaise = p
  }
  return { guid, name: r.name, parent: r.parent || null, alterId, data, issues: issues.length ? issues : null }
}

/**
 * Saves the records of a finished export job into Layer 1. Returns how many rows were written and how many of that
 * kind are now marked missing. Jobs that are not master exports, or have no Tally company, are skipped.
 */
export async function stageMasters(job: Pick<TallyJob, 'id' | 'companyId' | 'tallyCompany' | 'type'>, records: Record<string, string>[], at = new Date(Date.now())) {
  const source = LAYER1_SOURCE[job.type as TallyJobType]
  if (!source || !job.tallyCompany) return { staged: 0, markedMissing: 0 }
  const rows = records.map(sourceRow)
  for (let i = 0; i < rows.length; i += BATCH) {
    const values = rows.slice(i, i + BATCH).map((r) => Prisma.sql`(
      ${randomBytes(12).toString('hex')}, ${job.companyId}, ${job.tallyCompany}, ${source.kind}, ${r.guid}, ${r.name}, ${r.parent}, ${r.alterId},
      ${JSON.stringify(r.data)}, ${r.issues ? JSON.stringify(r.issues) : null}, ${job.id}, ${at}, ${at}, NULL)`)
    await db.$executeRaw`INSERT INTO TallySourceMaster
      (id, companyId, tallyCompany, kind, guid, name, parent, alterId, data, issues, jobId, firstSeenAt, lastSeenAt, missingSince)
      VALUES ${Prisma.join(values)}
      ON DUPLICATE KEY UPDATE name = VALUES(name), parent = VALUES(parent), alterId = VALUES(alterId),
        data = JSON_MERGE_PATCH(data, VALUES(data)), issues = VALUES(issues), jobId = VALUES(jobId),
        lastSeenAt = VALUES(lastSeenAt), missingSince = NULL`
  }
  let markedMissing = 0
  if (source.full) {
    const r = await db.tallySourceMaster.updateMany({
      where: { companyId: job.companyId, tallyCompany: job.tallyCompany, kind: source.kind, lastSeenAt: { lt: at }, missingSince: null },
      data: { missingSince: at },
    })
    markedMissing = r.count
  }
  return { staged: rows.length, markedMissing }
}
