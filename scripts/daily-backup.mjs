#!/usr/bin/env node
// Daily tenant backup — run from the app directory (where .env lives), e.g. by cron:
//   30 2 * * * cd /path/to/app && node scripts/daily-backup.mjs >> ~/logs/backup.log 2>&1
//
// For every customer company (isPlatform = false) writes the same JSON as
// GET /api/companies/[id]/backup (meta.version 1, users without passwordHash), gzipped, to
//   ~/backups/manuflow/<YYYY-MM-DD>/<companyId>.json.gz
// then deletes dated folders older than BACKUP_KEEP_DAYS (default 14).
// Env: DATABASE_URL (read from ./.env when not set), BACKUP_DIR, BACKUP_KEEP_DAYS.
// Exits non-zero when any company fails.

import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
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

if (!process.env.DATABASE_URL) {
  loadEnvFile(join(process.cwd(), '.env'))
  if (!process.env.DATABASE_URL) loadEnvFile(resolve(dirname(fileURLToPath(import.meta.url)), '..', '.env'))
}
if (!process.env.DATABASE_URL) {
  console.error(`[backup ${new Date().toISOString()}] FAILED: DATABASE_URL is not set and no .env was found`)
  process.exit(1)
}

const { PrismaClient } = await import('@prisma/client')
const db = new PrismaClient({ log: ['error'] })

const BASE = process.env.BACKUP_DIR || join(homedir(), 'backups', 'manuflow')
const KEEP_DAYS = Math.max(1, parseInt(process.env.BACKUP_KEEP_DAYS || '14', 10) || 14)

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** Same snapshot as src/app/api/companies/[id]/backup/route.ts (keep the two in sync). */
async function snapshot(id) {
  const company = await db.company.findUnique({ where: { id } })
  if (!company) throw new Error(`company ${id} not found`)
  const w = { companyId: id }
  const o = { orderBy: { id: 'asc' } }
  const [
    users, items, customers, suppliers, warehouses, machines, plants, boms,
    enquiries, quotations, salesOrders, deliveries, salesInvoices, payments,
    purchaseRequisitions, purchaseOrders, grns, purchaseInvoices,
    workOrders, materialIssues, productionEntries, qcInspections,
    stockBalances, stockLedger, expenses,
    notifications, auditLogs, numberSeqs,
    bomItems, enquiryItems, quotationItems, salesOrderItems, deliveryChallanItems,
    salesInvoiceItems, purchaseRequisitionItems, purchaseOrderItems, grnItems,
    purchaseInvoiceItems, materialIssueItems,
  ] = await Promise.all([
    db.user.findMany({ where: w, ...o, omit: { passwordHash: true } }),
    db.item.findMany({ where: w, ...o }),
    db.customer.findMany({ where: w, ...o }),
    db.supplier.findMany({ where: w, ...o }),
    db.warehouse.findMany({ where: w, ...o }),
    db.machine.findMany({ where: w, ...o }),
    db.plant.findMany({ where: w, ...o }),
    db.bom.findMany({ where: w, ...o }),
    db.enquiry.findMany({ where: w, ...o }),
    db.quotation.findMany({ where: w, ...o }),
    db.salesOrder.findMany({ where: w, ...o }),
    db.deliveryChallan.findMany({ where: w, ...o }),
    db.salesInvoice.findMany({ where: w, ...o }),
    db.payment.findMany({ where: w, ...o }),
    db.purchaseRequisition.findMany({ where: w, ...o }),
    db.purchaseOrder.findMany({ where: w, ...o }),
    db.grn.findMany({ where: w, ...o }),
    db.purchaseInvoice.findMany({ where: w, ...o }),
    db.workOrder.findMany({ where: w, ...o }),
    db.materialIssue.findMany({ where: w, ...o }),
    db.productionEntry.findMany({ where: w, ...o }),
    db.qcInspection.findMany({ where: w, ...o }),
    db.stockBalance.findMany({ where: w, ...o }),
    db.stockLedger.findMany({ where: w, ...o }),
    db.expense.findMany({ where: w, ...o }),
    db.notification.findMany({ where: w, ...o }),
    db.auditLog.findMany({ where: w, ...o }),
    db.numberSeq.findMany({ where: w, ...o }),
    db.bomItem.findMany({ where: { bom: { companyId: id } }, ...o }),
    db.enquiryItem.findMany({ where: { enquiry: { companyId: id } }, ...o }),
    db.quotationItem.findMany({ where: { quotation: { companyId: id } }, ...o }),
    db.salesOrderItem.findMany({ where: { salesOrder: { companyId: id } }, ...o }),
    db.deliveryChallanItem.findMany({ where: { challan: { companyId: id } }, ...o }),
    db.salesInvoiceItem.findMany({ where: { invoice: { companyId: id } }, ...o }),
    db.purchaseRequisitionItem.findMany({ where: { pr: { companyId: id } }, ...o }),
    db.purchaseOrderItem.findMany({ where: { po: { companyId: id } }, ...o }),
    db.grnItem.findMany({ where: { grn: { companyId: id } }, ...o }),
    db.purchaseInvoiceItem.findMany({ where: { invoice: { companyId: id } }, ...o }),
    db.materialIssueItem.findMany({ where: { issue: { companyId: id } }, ...o }),
  ])

  const data = {
    company,
    users, items, customers, suppliers, warehouses, machines, plants, boms,
    enquiries, quotations, salesOrders, deliveries, salesInvoices, payments,
    purchaseRequisitions, purchaseOrders, grns, purchaseInvoices,
    workOrders, materialIssues, productionEntries, qcInspections,
    stockBalances, stockLedger, expenses,
    notifications, auditLogs, numberSeqs,
    bomItems, enquiryItems, quotationItems, salesOrderItems, deliveryChallanItems,
    salesInvoiceItems, purchaseRequisitionItems, purchaseOrderItems, grnItems,
    purchaseInvoiceItems, materialIssueItems,
  }
  const counts = {}
  for (const [k, v] of Object.entries(data)) counts[k] = Array.isArray(v) ? v.length : v ? 1 : 0
  return {
    meta: { exportedAt: new Date().toISOString(), companyId: id, companyName: company.name, version: 1, counts },
    data,
  }
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

async function main() {
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
      const gz = await gzipAsync(Buffer.from(JSON.stringify(await snapshot(c.id))))
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

let success = false
try {
  success = await main()
} catch (e) {
  console.error(`[backup ${new Date().toISOString()}] FAILED:`, e instanceof Error ? e.message : e)
} finally {
  await db.$disconnect().catch(() => {})
}
process.exit(success ? 0 : 1)
