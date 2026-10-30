#!/usr/bin/env node
// Daily tenant backup — run from the app directory (where .env lives), e.g. by cron:
//   30 2 * * * cd /path/to/app && node scripts/daily-backup.mjs >> ~/logs/backup.log 2>&1
//
// For every customer company (isPlatform = false) writes the same JSON as
// GET /api/companies/[id]/backup (meta.version 2, users without passwordHash), gzipped, to
//   ~/backups/manuflow/<YYYY-MM-DD>/<companyId>.json.gz
// then deletes dated folders older than BACKUP_KEEP_DAYS (default 14).
// Env: DATABASE_URL (read from ./.env when not set), BACKUP_DIR, BACKUP_KEEP_DAYS.
// Exits non-zero when any company fails.

import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { gzip } from 'node:zlib'

const gzipAsync = promisify(gzip)

/** Minimal KEY=VALUE .env reader (no dotenv dependency); never overrides real env vars. */
function loadEnvFile(file) {
  if (!existsSync(file)) return
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!m) continue
    let v = m[2].trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    else v = v.replace(/\s+#.*$/, '')
    if (process.env[m[1]] === undefined) process.env[m[1]] = v
  }
}

const BASE = process.env.BACKUP_DIR || join(homedir(), 'backups', 'manuflow')
const KEEP_DAYS = Math.max(1, parseInt(process.env.BACKUP_KEEP_DAYS || '14', 10) || 14)

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

// ---- backup plan: the same algorithm as src/lib/backup-plan.ts (tests/backup-plan.test.ts keeps them equal) ----
export const BACKUP_VERSION = 2
const NOT_BACKED_UP = new Set(['IdempotencyKey'])
const NOT_RESTORED = new Set(['User', 'UserCompanyAccess'])
const PLATFORM_MODELS = new Set(['Company', 'Plan'])
const KEY_OVERRIDES = { DeliveryChallan: 'deliveries', StockLedger: 'stockLedger' }

export function backupKey(model) {
  if (KEY_OVERRIDES[model]) return KEY_OVERRIDES[model]
  const base = model.charAt(0).toLowerCase() + model.slice(1)
  if (/[^aeiou]y$/.test(base)) return base.slice(0, -1) + 'ies'
  if (/(s|x|z|ch|sh)$/.test(base)) return base + 'es'
  return base + 's'
}

export function backupPlan(models) {
  const hasCompany = (m) => m.fields.some((f) => f.name === 'companyId' && f.kind === 'scalar')
  const tenant = new Set(models.filter((m) => hasCompany(m) && !NOT_BACKED_UP.has(m.name) && !PLATFORM_MODELS.has(m.name)).map((m) => m.name))
  const relations = (m) => m.fields.filter((f) => f.kind === 'object' && (f.relationFromFields?.length ?? 0) > 0)
  const lc = (n) => n.charAt(0).toLowerCase() + n.slice(1)
  const tables = new Map()
  for (const m of models) {
    if (tenant.has(m.name)) {
      tables.set(m.name, { model: m.name, delegate: lc(m.name), restore: !NOT_RESTORED.has(m.name), deps: new Set() })
      continue
    }
    if (hasCompany(m) || PLATFORM_MODELS.has(m.name)) continue
    const owner = relations(m).find((f) => f.isRequired && tenant.has(f.type) && f.relationFromFields.length === 1)
    if (!owner) continue
    tables.set(m.name, {
      model: m.name, delegate: lc(m.name), restore: !NOT_RESTORED.has(owner.type),
      parent: { fk: owner.relationFromFields[0], relation: owner.name, key: backupKey(owner.type) }, deps: new Set(),
    })
  }
  for (const m of models) {
    const t = tables.get(m.name)
    if (!t) continue
    for (const f of relations(m)) if (f.type !== m.name && tables.has(f.type)) t.deps.add(f.type)
  }
  const order = []
  const done = new Set()
  while (done.size < tables.size) {
    const ready = [...tables.values()].filter((t) => !done.has(t.model) && [...t.deps].every((d) => done.has(d)))
    if (!ready.length) throw new Error('Backup plan: circular foreign keys')
    for (const t of ready) {
      done.add(t.model)
      const out = { key: backupKey(t.model), model: t.model, delegate: t.delegate }
      if (t.parent) out.parent = t.parent
      out.restore = t.restore
      order.push(out)
    }
  }
  return order
}

/** Same snapshot as GET /api/companies/[id]/backup (src/lib/backup-plan.ts → tenantSnapshot). */
async function snapshot(db, plan, id) {
  const company = await db.company.findUnique({ where: { id } })
  if (!company) throw new Error(`company ${id} not found`)
  const rows = await Promise.all(plan.map((t) => db[t.delegate].findMany({
    where: t.parent ? { [t.parent.relation]: { companyId: id } } : { companyId: id },
    orderBy: { id: 'asc' },
    ...(t.model === 'User' ? { omit: { passwordHash: true } } : {}),
  })))
  const data = { company }
  const counts = { company: 1 }
  plan.forEach((t, i) => { data[t.key] = rows[i]; counts[t.key] = rows[i].length })
  return { meta: { exportedAt: new Date().toISOString(), companyId: id, companyName: company.name, version: BACKUP_VERSION, counts }, data }
}

/** Remove dated backup folders older than KEEP_DAYS; returns how many were removed. */
async function prune(now) {
  const cutoff = new Date(now)
  cutoff.setHours(0, 0, 0, 0)
  cutoff.setDate(cutoff.getDate() - KEEP_DAYS)
  let removed = 0
  for (const e of await readdir(BASE, { withFileTypes: true })) {
    if (!e.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(e.name)) continue
    const [y, m, d] = e.name.split('-').map(Number)
    if (new Date(y, m - 1, d) < cutoff) {
      await rm(join(BASE, e.name), { recursive: true, force: true })
      removed++
    }
  }
  return removed
}

async function main(db, plan) {
  const started = Date.now()
  const now = new Date()
  const dir = join(BASE, ymd(now))
  await mkdir(dir, { recursive: true, mode: 0o700 })

  const companies = await db.company.findMany({ where: { isPlatform: false }, select: { id: true, name: true }, orderBy: { createdAt: 'asc' } })
  let ok = 0
  let bytes = 0
  const failed = []
  for (const c of companies) {
    try {
      const gz = await gzipAsync(Buffer.from(JSON.stringify(await snapshot(db, plan, c.id))))
      const file = join(dir, `${c.id}.json.gz`)
      await writeFile(`${file}.tmp`, gz, { mode: 0o600 })
      await rename(`${file}.tmp`, file)
      bytes += gz.length
      ok++
    } catch (e) {
      failed.push(c.id)
      console.error(`[backup] ${c.id} (${c.name}) failed:`, e instanceof Error ? e.message : e)
    }
  }
  const pruned = await prune(now)
  const secs = ((Date.now() - started) / 1000).toFixed(1)
  console.log(
    `[backup ${now.toISOString()}] ${ok}/${companies.length} companies -> ${dir} (${(bytes / 1048576).toFixed(2)} MB gz, ${secs}s); ` +
    `pruned ${pruned} folder(s) older than ${KEEP_DAYS} days${failed.length ? `; FAILED: ${failed.join(',')}` : ''}`,
  )
  return failed.length === 0
}

// Run only when executed directly (tests import backupPlan from this file)
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.env.DATABASE_URL) {
    loadEnvFile(join(process.cwd(), '.env'))
    if (!process.env.DATABASE_URL) loadEnvFile(resolve(dirname(fileURLToPath(import.meta.url)), '..', '.env'))
  }
  if (!process.env.DATABASE_URL) {
    console.error(`[backup ${new Date().toISOString()}] FAILED: DATABASE_URL is not set and no .env was found`)
    process.exit(1)
  }
  const { PrismaClient, Prisma } = await import('@prisma/client')
  const db = new PrismaClient({ log: ['error'] })
  let success = false
  try {
    success = await main(db, backupPlan(Prisma.dmmf.datamodel.models))
  } catch (e) {
    console.error(`[backup ${new Date().toISOString()}] FAILED:`, e instanceof Error ? e.message : e)
  } finally {
    await db.$disconnect().catch(() => {})
  }
  process.exit(success ? 0 : 1)
}
