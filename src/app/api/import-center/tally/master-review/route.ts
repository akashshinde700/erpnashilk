import { ApiError, companyRequired, handleError, ok, requireWrite } from '@/lib/erp-helpers'
import { assertConnectorEnabled } from '@/lib/tally/connector'
import { linkGodown, linkLedger, unlinkMaster, type MapKind } from '@/lib/tally/master-map'
import { REVIEW_KINDS, kindReview, reviewSummary, type ReviewFilter, type ReviewKind } from '@/lib/tally/master-review'

const FILTERS: ReviewFilter[] = ['all', 'review', 'issues', 'missing', 'linked', 'unlinked']

// GET /api/import-center/tally/master-review?tallyCompany=&kind=&filter=&q=&page=
//   without kind → { summary: KindSummary[] } for the six reference masters
//   with kind    → { summary, matching, page, pageSize, rows } (one page of that kind's review)
// Read only: the copy of Tally's masters kept in ManuFlow (Layer 1), the suggested ledger meaning and existing links.
export async function GET(req: Request) {
  try {
    requireWrite(req, 'import-center')
    const companyId = await companyRequired(req)
    assertConnectorEnabled()
    const sp = new URL(req.url).searchParams
    const tallyCompany = (sp.get('tallyCompany') ?? '').trim()
    if (!tallyCompany) throw new ApiError('Choose the Tally company first', 400)
    const kind = sp.get('kind')
    if (!kind) return ok({ summary: await reviewSummary(companyId, tallyCompany) })
    if (!REVIEW_KINDS.includes(kind as ReviewKind)) throw new ApiError('Unknown kind of Tally master', 400)
    const filter = (FILTERS.includes(sp.get('filter') as ReviewFilter) ? sp.get('filter') : 'all') as ReviewFilter
    const page = Math.max(0, Math.min(10_000, Number.parseInt(sp.get('page') ?? '0', 10) || 0))
    const q = (sp.get('q') ?? '').slice(0, 100)
    return ok(await kindReview(companyId, tallyCompany, kind as ReviewKind, { page, filter, q }))
  } catch (e) {
    return handleError(e)
  }
}

// POST /api/import-center/tally/master-review
//   { tallyCompany, kind: 'godown', guid, warehouseId }            link a godown to an existing warehouse
//   { tallyCompany, kind: 'godown', guid, create: { type? } }      create a warehouse for it and link it
//   { tallyCompany, kind: 'ledger', guid, moneyAccountId }         link a bank / cash ledger to a cash & bank account
//   { tallyCompany, kind, guid, unlink: true }                     remove that link
// Needs Import Center access plus the right to change warehouses (godowns) or Cash & Bank (ledgers). Nothing is written
// to Tally; no stock, balance or document changes.
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
    requireWrite(req, 'import-center')
    const kind = body.kind as MapKind
    if (kind !== 'godown' && kind !== 'ledger') throw new ApiError('Only godowns and bank / cash ledgers can be linked', 400)
    requireWrite(req, kind === 'godown' ? 'warehouses' : 'cash-bank')
    const companyId = await companyRequired(req, typeof body.companyId === 'string' ? body.companyId : undefined)
    assertConnectorEnabled()
    const tallyCompany = typeof body.tallyCompany === 'string' ? body.tallyCompany.trim() : ''
    if (body.unlink === true) return ok(await unlinkMaster(companyId, tallyCompany, kind, body.guid), 'Link removed')
    if (kind === 'godown') {
      const create = body.create && typeof body.create === 'object' ? body.create as { type?: unknown } : undefined
      const r = await linkGodown(companyId, tallyCompany, body.guid, { warehouseId: body.warehouseId, create })
      return ok(r, r.created ? 'Warehouse created and linked' : 'Godown linked')
    }
    return ok(await linkLedger(companyId, tallyCompany, body.guid, { moneyAccountId: body.moneyAccountId }), 'Ledger linked')
  } catch (e) {
    return handleError(e)
  }
}
