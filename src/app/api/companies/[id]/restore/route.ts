import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { ApiError, companyRequired, handleError, logAudit, ok, sessionUser } from '@/lib/erp-helpers'
import { BACKUP_VERSION, backupPlan } from '@/lib/backup-plan'

type Ctx = { params: Promise<{ id: string }> }

// Company columns that belong to the platform subscription, never taken from a backup
const COMPANY_KEEP = new Set(['id', 'isPlatform', 'slug', 'planId', 'status', 'billingCycle', 'paidUntil', 'trialEndsAt', 'maxUsers', 'maxWarehouses', 'maxItems', 'createdAt', 'updatedAt'])

const delegate = (tx: Prisma.TransactionClient, model: string) =>
  (tx as unknown as Record<string, { createMany: (a: { data: object[] }) => Promise<unknown>; deleteMany: (a: object) => Promise<unknown> }>)[model.charAt(0).toLowerCase() + model.slice(1)]

/** Scalar column names of a model (unknown keys in an older/newer backup are dropped). */
function scalarFields(model: string): Set<string> {
  const m = Prisma.dmmf.datamodel.models.find((x) => x.name === model)
  if (!m) throw new ApiError(`Unknown table ${model}`, 500)
  return new Set(m.fields.filter((f) => f.kind === 'scalar' || f.kind === 'enum').map((f) => f.name))
}

// POST /api/companies/[id]/restore { confirmName, backup } — replace this company's data with a backup
// of the SAME company (downloaded from Settings → Data & Backup). Admins only. All-or-nothing.
export async function POST(req: Request, { params }: Ctx) {
  try {
    const me = await sessionUser(req)
    if (!['TENANT_ADMIN', 'MANAGEMENT', 'SUPER_ADMIN'].includes(me.role)) throw new ApiError('Only administrators can restore a backup', 403)
    const { id } = await params
    const companyId = await companyRequired(req, id)
    const company = await db.company.findUnique({ where: { id: companyId } })
    if (!company) throw new ApiError('Company not found', 404)

    const body = await req.json().catch(() => null) as { confirmName?: string; backup?: { meta?: { companyId?: string; version?: number }; data?: Record<string, unknown> } } | null
    if (!body?.backup?.data || !body.backup.meta) throw new ApiError('This is not a ManuFlow backup file', 400)
    if (String(body.confirmName || '').trim() !== company.name) throw new ApiError('Type the company name exactly to confirm', 400)
    const { meta, data } = body.backup
    if (meta.version !== 1 && meta.version !== BACKUP_VERSION) throw new ApiError(`Unsupported backup version ${meta.version}`, 400)
    if (meta.companyId !== companyId) throw new ApiError('This backup belongs to a different company — it can only be restored into the company it was taken from', 400)

    // Version-1 files predate returns, Cash & Bank, batches and serials. A table the file does not
    // carry is left exactly as it is (neither emptied nor filled) rather than wiped.
    const tables = backupPlan().filter((t) => t.restore)
    const skipped = tables.filter((t) => data[t.key] === undefined).map((t) => t.key)
    const present = tables.filter((t) => data[t.key] !== undefined)
    if (meta.version === BACKUP_VERSION && skipped.length) throw new ApiError(`Backup is incomplete: missing ${skipped.join(', ')}`, 400)
    // Deleting a header cascades to its lines, so lines missing from the file would be lost for good
    const orphanedLines = tables.filter((t) => t.parent && skipped.includes(t.key) && !skipped.includes(t.parent.key))
    if (orphanedLines.length) throw new ApiError(`Backup is incomplete: missing ${orphanedLines.map((t) => t.key).join(', ')}`, 400)

    // Validate + clean every table before touching anything
    const rowsByKey = new Map<string, Record<string, unknown>[]>()
    const idsByKey = new Map<string, Set<string>>()
    for (const t of present) {
      const raw = data[t.key]
      if (!Array.isArray(raw)) throw new ApiError(`Backup table ${t.key} is malformed`, 400)
      const allowed = scalarFields(t.model)
      const rows = (raw as Record<string, unknown>[]).map((r) => {
        const clean: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(r ?? {})) if (allowed.has(k)) clean[k] = v
        if (allowed.has('companyId')) clean.companyId = companyId // never write into another tenant
        return clean
      })
      if (t.parent) {
        const parents = idsByKey.get(t.parent.key)
        if (!parents) throw new ApiError(`Backup is inconsistent: ${t.key} without ${t.parent.key}`, 400)
        const fk = t.parent.fk
        if (rows.some((r) => !parents.has(String(r[fk])))) throw new ApiError(`Backup is inconsistent: ${t.key} refers to missing ${t.parent.key}`, 400)
      }
      rowsByKey.set(t.key, rows)
      idsByKey.set(t.key, new Set(rows.map((r) => String(r.id))))
    }

    const total = [...rowsByKey.values()].reduce((s, r) => s + r.length, 0)
    await db.$transaction(async (tx) => {
      // Remove current data, children before parents (document lines cascade with their headers)
      for (const t of [...present].reverse()) {
        if (!t.parent) await delegate(tx, t.model).deleteMany({ where: { companyId } })
      }
      // Company profile from the backup (subscription fields stay)
      const backupCompany = (data.company ?? {}) as Record<string, unknown>
      const companyFields = scalarFields('Company')
      const profile = Object.fromEntries(Object.entries(backupCompany).filter(([k]) => companyFields.has(k) && !COMPANY_KEEP.has(k)))
      if (Object.keys(profile).length) await tx.company.update({ where: { id: companyId }, data: profile })
      // Re-insert in dependency order
      for (const t of present) {
        const rows = rowsByKey.get(t.key) ?? []
        for (let i = 0; i < rows.length; i += 500) await delegate(tx, t.model).createMany({ data: rows.slice(i, i + 500) })
      }
    }, { timeout: 300000, maxWait: 20000 })

    await logAudit(db as never, {
      companyId, userName: me.name, action: 'CONFIG', entity: 'COMPANY', entityId: companyId,
      details: `Data restored from backup taken ${String((meta as { exportedAt?: string }).exportedAt || '').slice(0, 19).replace('T', ' ')} (${total} records${skipped.length ? `; not in file: ${skipped.join(', ')}` : ''})`,
    })
    const note = skipped.length ? ` — this older backup has no ${skipped.join(', ')}; those were left as they are` : ''
    return ok({ restored: total, skipped }, `Backup restored — ${total} records${note}`)
  } catch (e) {
    return handleError(e)
  }
}
