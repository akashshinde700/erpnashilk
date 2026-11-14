import { db } from '@/lib/db'
import { ApiError } from '@/lib/erp-helpers'
import {
  REVIEW_KINDS, REVIEW_PAGE, ledgerClassifier, unitNeedsReview, type KindSummary, type ReviewFilter, type ReviewKind, type ReviewRow,
} from '@/lib/tally/master-classify'

export { REVIEW_KINDS, ledgerClassifier, type KindSummary, type ReviewFilter, type ReviewKind, type ReviewRow }

/**
 * Review of the masters read from Tally (Layer 1, TallySourceMaster) — read only.
 *
 * Six reference masters are reviewed here: ledger groups, ledgers, stock groups, units, godowns and cost centres. They
 * are NOT imported into ManuFlow's business tables: ManuFlow has no ledger, group, unit, stock-group or cost-centre
 * master (units and stock groups are text on the item; godowns correspond to warehouses). What this adds:
 *  - a SUGGESTED meaning for every ledger, worked out from Tally's own predefined groups (ledgerClassifier, master-classify.ts). A suggestion
 *    is never stored as a mapping; ambiguous ones are marked "needs review";
 *  - the ManuFlow record a godown / bank or cash ledger is linked to (TallyMasterLink, set only by an explicit user
 *    action — master-map.ts), and for customer / supplier ledgers the link the Tally import made;
 *  - for units and stock groups, how many ManuFlow items already use that unit / category text.
 */

// ---------------------------------------------------------------- review query

const key = (s: string | null | undefined) => (s ?? '').trim().toLowerCase()

const LINK_KINDS: Partial<Record<ReviewKind, string[]>> = { godown: ['warehouse'], ledger: ['customer', 'supplier', 'moneyaccount'] }

type SourceRow = { guid: string; name: string; parent: string | null; alterId: number | null; data: unknown; issues: unknown; missingSince: Date | null; lastSeenAt: Date }

async function rowsOf(companyId: string, tallyCompany: string, kind: ReviewKind): Promise<SourceRow[]> {
  return db.tallySourceMaster.findMany({
    where: { companyId, tallyCompany, kind },
    select: { guid: true, name: true, parent: true, alterId: true, data: true, issues: true, missingSince: true, lastSeenAt: true },
    orderBy: { name: 'asc' },
  })
}

/** Labels of the ManuFlow records links point to (company-scoped; a link whose record is gone is dropped). */
async function linkTargets(companyId: string, links: { guid: string; kind: string; manuflowId: string }[]) {
  const ids = (k: string) => links.filter((l) => l.kind === k).map((l) => l.manuflowId)
  const where = (k: string) => ({ companyId, id: { in: ids(k) } })
  const [customers, suppliers, accounts, warehouses] = await Promise.all([
    ids('customer').length ? db.customer.findMany({ where: where('customer'), select: { id: true, code: true, name: true } }) : [],
    ids('supplier').length ? db.supplier.findMany({ where: where('supplier'), select: { id: true, code: true, name: true } }) : [],
    ids('moneyaccount').length ? db.moneyAccount.findMany({ where: where('moneyaccount'), select: { id: true, type: true, name: true } }) : [],
    ids('warehouse').length ? db.warehouse.findMany({ where: where('warehouse'), select: { id: true, code: true, name: true } }) : [],
  ])
  const label = new Map<string, string>()
  for (const c of customers) label.set(`customer:${c.id}`, `Customer ${c.code} — ${c.name}`)
  for (const s of suppliers) label.set(`supplier:${s.id}`, `Supplier ${s.code} — ${s.name}`)
  for (const a of accounts) label.set(`moneyaccount:${a.id}`, `${a.type === 'CASH' ? 'Cash' : 'Bank'} account — ${a.name}`)
  for (const w of warehouses) label.set(`warehouse:${w.id}`, `Warehouse ${w.code} — ${w.name}`)
  const byGuid = new Map<string, { kind: string; id: string; label: string }>()
  for (const l of links) {
    const text = label.get(`${l.kind}:${l.manuflowId}`)
    // customer / supplier first (made by an import), then the others; one per GUID is shown
    if (text && !byGuid.has(l.guid)) byGuid.set(l.guid, { kind: l.kind, id: l.manuflowId, label: text })
  }
  return byGuid
}

async function groupClassifier(companyId: string, tallyCompany: string) {
  const groups = await db.tallySourceMaster.findMany({ where: { companyId, tallyCompany, kind: 'group' }, select: { name: true, parent: true, data: true } })
  return ledgerClassifier(groups.map((g) => ({ name: g.name, parent: g.parent, reservedName: (g.data as Record<string, unknown> | null)?.reservedName as string | undefined })))
}

/** Counts of every reviewed kind for one Tally company (what has been read so far). */
export async function reviewSummary(companyId: string, tallyCompany: string): Promise<KindSummary[]> {
  const out: KindSummary[] = []
  for (const kind of REVIEW_KINDS) out.push((await kindReview(companyId, tallyCompany, kind, { page: 0, filter: 'all', q: '' })).summary)
  return out
}

/** One kind: its summary, and one page of its rows (filtered, searched). */
export async function kindReview(companyId: string, tallyCompany: string, kind: ReviewKind, opts: { page: number; filter: ReviewFilter; q: string }) {
  if (!REVIEW_KINDS.includes(kind)) throw new ApiError('Unknown kind of Tally master', 400)
  const source = await rowsOf(companyId, tallyCompany, kind)
  const classify = kind === 'ledger' ? await groupClassifier(companyId, tallyCompany) : null
  const linkKinds = LINK_KINDS[kind]
  const links = linkKinds && source.length
    ? await db.tallyMasterLink.findMany({ where: { companyId, tallyCompany, kind: { in: linkKinds } }, select: { guid: true, kind: true, manuflowId: true }, orderBy: { createdAt: 'asc' } })
    : []
  // Only links of masters of this kind (customer/supplier links are made from ledgers; warehouse links from godowns)
  const guids = new Set(source.map((s) => s.guid))
  const linked = await linkTargets(companyId, links.filter((l) => guids.has(l.guid)))

  // units / stock groups: how many ManuFlow items already use the text (case-insensitive, like the database)
  let itemCount: Map<string, number> | null = null
  if (kind === 'unit' || kind === 'stockgroup') {
    const by = kind === 'unit' ? 'uom' : 'category'
    const groups = await db.item.groupBy({ by: [by], where: { companyId }, _count: { _all: true } }) as unknown as ({ _count: { _all: number } } & Record<string, string | null>)[]
    itemCount = new Map()
    for (const g of groups) {
      const k = key(g[by])
      if (k) itemCount.set(k, (itemCount.get(k) ?? 0) + g._count._all)
    }
  }
  let warehouses: Map<string, { id: string; label: string }> | null = null
  if (kind === 'godown') {
    const list = await db.warehouse.findMany({ where: { companyId }, select: { id: true, code: true, name: true } })
    warehouses = new Map(list.map((w) => [key(w.name), { id: w.id, label: `Warehouse ${w.code} — ${w.name}` }]))
  }
  const linkedTargets = new Set([...linked.values()].map((l) => l.id))

  const rows: ReviewRow[] = source.map((s) => {
    const data = (s.data ?? {}) as Record<string, unknown>
    const issues = (Array.isArray(s.issues) ? s.issues : []) as ReviewRow['issues']
    const row: ReviewRow = {
      guid: s.guid, name: s.name, parent: s.parent, alterId: s.alterId, data, issues,
      missingSince: s.missingSince?.toISOString() ?? null, lastSeenAt: s.lastSeenAt.toISOString(), needsReview: false,
    }
    if (classify) {
      row.classification = classify(s.parent)
      row.link = linked.get(s.guid) ?? null
      row.needsReview = row.classification.confidence === 'review'
    }
    if (kind === 'godown') {
      row.link = linked.get(s.guid) ?? null
      const same = warehouses!.get(key(s.name))
      row.suggestion = !row.link && same && !linkedTargets.has(same.id) ? same : null
      row.needsReview = !row.link
    }
    if (itemCount) row.itemsUsing = itemCount.get(key(s.name)) ?? 0
    if (kind === 'unit') row.needsReview = unitNeedsReview(data)
    if (issues.length) row.needsReview = true
    return row
  })

  const summary: KindSummary = {
    kind, total: rows.length, withIssues: rows.filter((r) => r.issues.length).length, missing: rows.filter((r) => r.missingSince).length,
    needsReview: rows.filter((r) => r.needsReview && !r.missingSince).length, linked: rows.filter((r) => r.link).length,
    lastReadAt: rows.reduce<string | null>((m, r) => (!m || r.lastSeenAt > m ? r.lastSeenAt : m), null),
  }
  const q = opts.q.trim().toLowerCase()
  const shown = rows.filter((r) => {
    if (q && !r.name.toLowerCase().includes(q) && !(r.parent ?? '').toLowerCase().includes(q)) return false
    switch (opts.filter) {
      case 'review': return r.needsReview && !r.missingSince
      case 'issues': return r.issues.length > 0
      case 'missing': return !!r.missingSince
      case 'linked': return !!r.link
      case 'unlinked': return !r.link
      default: return true
    }
  })
  const page = Math.max(0, Math.min(opts.page, Math.max(0, Math.ceil(shown.length / REVIEW_PAGE) - 1)))
  return { summary, matching: shown.length, page, pageSize: REVIEW_PAGE, rows: shown.slice(page * REVIEW_PAGE, (page + 1) * REVIEW_PAGE) }
}
