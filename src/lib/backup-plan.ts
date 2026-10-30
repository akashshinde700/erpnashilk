import { Prisma } from '@prisma/client'

/**
 * Which tables a tenant backup holds, derived from the Prisma schema instead of a hand-kept list — a
 * list fell behind once already (returns, Cash & Bank, batches and serials were silently left out).
 *
 *  - every model with a `companyId` column is a tenant table;
 *  - a model without one that hangs off a tenant table through a required relation is a line table
 *    (document lines), read and restored through its parent;
 *  - tables come out in foreign-key order (parents first), which is the insert order for a restore.
 *
 * scripts/daily-backup.mjs runs the same algorithm on its own (cron copies that file alone);
 * tests/backup-plan.test.ts keeps the two identical.
 */

export const BACKUP_VERSION = 2

/** Tenant tables that are never part of a backup. */
export const NOT_BACKED_UP = new Set(['IdempotencyKey'])
/** Backed up for the record but never restored: sign-ins and who may open which firm stay as they are. */
export const NOT_RESTORED = new Set(['User', 'UserCompanyAccess'])
/** Models outside any tenant. */
export const PLATFORM_MODELS = new Set(['Company', 'Plan'])

/** Backup keys that predate the derived names (version-1 files use them). */
const KEY_OVERRIDES: Record<string, string> = { DeliveryChallan: 'deliveries', StockLedger: 'stockLedger' }

export interface BackupTable {
  key: string
  model: string
  /** Prisma client delegate name, e.g. `salesInvoiceItem`. */
  delegate: string
  /** Line tables: foreign key, relation field and the parent's backup key. */
  parent?: { fk: string; relation: string; key: string }
  restore: boolean
}

interface DmmfField { name: string; kind: string; type: string; isRequired: boolean; relationFromFields?: readonly string[] | null }
interface DmmfModel { name: string; fields: readonly DmmfField[] }

export function backupKey(model: string): string {
  if (KEY_OVERRIDES[model]) return KEY_OVERRIDES[model]
  const base = model.charAt(0).toLowerCase() + model.slice(1)
  if (/[^aeiou]y$/.test(base)) return base.slice(0, -1) + 'ies'
  if (/(s|x|z|ch|sh)$/.test(base)) return base + 'es'
  return base + 's'
}

export function backupPlan(models: readonly DmmfModel[] = Prisma.dmmf.datamodel.models as unknown as DmmfModel[]): BackupTable[] {
  const hasCompany = (m: DmmfModel) => m.fields.some((f) => f.name === 'companyId' && f.kind === 'scalar')
  const tenant = new Set(models.filter((m) => hasCompany(m) && !NOT_BACKED_UP.has(m.name) && !PLATFORM_MODELS.has(m.name)).map((m) => m.name))
  const relations = (m: DmmfModel) => m.fields.filter((f) => f.kind === 'object' && (f.relationFromFields?.length ?? 0) > 0)

  const tables = new Map<string, Omit<BackupTable, 'key'> & { deps: Set<string> }>()
  for (const m of models) {
    if (tenant.has(m.name)) {
      tables.set(m.name, { model: m.name, delegate: m.name.charAt(0).toLowerCase() + m.name.slice(1), restore: !NOT_RESTORED.has(m.name), deps: new Set() })
      continue
    }
    if (hasCompany(m) || PLATFORM_MODELS.has(m.name)) continue
    const owner = relations(m).find((f) => f.isRequired && tenant.has(f.type) && f.relationFromFields!.length === 1)
    if (!owner) continue
    tables.set(m.name, {
      model: m.name, delegate: m.name.charAt(0).toLowerCase() + m.name.slice(1), restore: !NOT_RESTORED.has(owner.type),
      parent: { fk: owner.relationFromFields![0], relation: owner.name, key: backupKey(owner.type) }, deps: new Set(),
    })
  }
  for (const m of models) {
    const t = tables.get(m.name)
    if (!t) continue
    for (const f of relations(m)) if (f.type !== m.name && tables.has(f.type)) t.deps.add(f.type)
  }

  // Kahn's algorithm, keeping schema order among tables that are ready together
  const order: BackupTable[] = []
  const done = new Set<string>()
  while (done.size < tables.size) {
    const ready = [...tables.values()].filter((t) => !done.has(t.model) && [...t.deps].every((d) => done.has(d)))
    if (!ready.length) throw new Error(`Backup plan: circular foreign keys between ${[...tables.keys()].filter((k) => !done.has(k)).join(', ')}`)
    for (const t of ready) {
      done.add(t.model)
      order.push({ key: backupKey(t.model), model: t.model, delegate: t.delegate, restore: t.restore, ...(t.parent ? { parent: t.parent } : {}) })
    }
  }
  return order
}

type FindMany = (args: object) => Promise<unknown[]>

/** Full tenant snapshot in the backup file format (`meta` + `data`); password hashes are never included. */
export async function tenantSnapshot(client: unknown, companyId: string) {
  const c = client as Record<string, { findMany: FindMany }> & { company: { findUnique: (a: object) => Promise<{ name: string } | null> } }
  const company = await c.company.findUnique({ where: { id: companyId } })
  if (!company) throw new Error(`company ${companyId} not found`)
  const plan = backupPlan()
  const rows = await Promise.all(plan.map((t) => c[t.delegate].findMany({
    where: t.parent ? { [t.parent.relation]: { companyId } } : { companyId },
    orderBy: { id: 'asc' },
    ...(t.model === 'User' ? { omit: { passwordHash: true } } : {}),
  })))
  const data: Record<string, unknown> = { company }
  const counts: Record<string, number> = { company: 1 }
  plan.forEach((t, i) => { data[t.key] = rows[i]; counts[t.key] = rows[i].length })
  return {
    meta: { exportedAt: new Date().toISOString(), companyId, companyName: company.name, version: BACKUP_VERSION, counts },
    data,
  }
}
