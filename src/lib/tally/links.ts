import { db } from '@/lib/db'
import type { TallyImportKind } from '@/lib/tally/to-import'

/**
 * Tally GUID → the ManuFlow record a Tally master was imported into (TallyMasterLink).
 *
 * Keeps Tally's identity without changing the Customer, Supplier or Item tables: those are only READ here (to check that
 * a linked record still exists, and to find a newly imported record by its code). Links are history and are never
 * deleted; a link whose record no longer exists is ignored.
 */

const LINK_KIND: Record<TallyImportKind, string> = { customers: 'customer', suppliers: 'supplier', items: 'item' }

/** The records of a kind that exist, among these ids (read only). */
async function existing(kind: TallyImportKind, companyId: string, ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set()
  const where = { companyId, id: { in: ids } }
  const rows = kind === 'customers' ? await db.customer.findMany({ where, select: { id: true } })
    : kind === 'suppliers' ? await db.supplier.findMany({ where, select: { id: true } })
      : await db.item.findMany({ where, select: { id: true } })
  return new Set(rows.map((r) => r.id))
}

/** GUIDs among these that were imported before into a ManuFlow record that still exists. */
export async function linkedGuids(companyId: string, tallyCompany: string, kind: TallyImportKind, guids: string[]): Promise<Set<string>> {
  if (!guids.length) return new Set()
  const links = await db.tallyMasterLink.findMany({ where: { companyId, tallyCompany, kind: LINK_KIND[kind], guid: { in: guids } } })
  const alive = await existing(kind, companyId, links.map((l) => l.manuflowId))
  return new Set(links.filter((l) => alive.has(l.manuflowId)).map((l) => l.guid))
}

/** Links newly imported records (found by the code the import gave them) to their Tally GUIDs. → links written */
export async function linkImported(companyId: string, tallyCompany: string, kind: TallyImportKind, imported: { guid: string; code: string }[]) {
  if (!imported.length) return 0
  const where = { companyId, code: { in: imported.map((i) => i.code) } }
  const rows = kind === 'customers' ? await db.customer.findMany({ where, select: { id: true, code: true } })
    : kind === 'suppliers' ? await db.supplier.findMany({ where, select: { id: true, code: true } })
      : await db.item.findMany({ where, select: { id: true, code: true } })
  const idByCode = new Map(rows.map((r) => [r.code, r.id]))
  const at = new Date(Date.now())
  const data = imported.filter((i) => idByCode.has(i.code)).map((i) => ({
    companyId, tallyCompany, kind: LINK_KIND[kind], guid: i.guid, manuflowId: idByCode.get(i.code)!, createdAt: at,
  }))
  // A GUID already linked keeps its first link (history)
  const r = await db.tallyMasterLink.createMany({ data, skipDuplicates: true })
  return r.count
}
