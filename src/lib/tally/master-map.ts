import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { ApiError, assertLimit, logAudit } from '@/lib/erp-helpers'
import { ledgerClassifier } from '@/lib/tally/master-classify'

/**
 * Linking a Tally master to a ManuFlow record — only by an explicit user action, never automatically.
 *
 *  - Godown → warehouse: an existing warehouse of the company, or a new one created here with the same rules as
 *    POST /api/warehouses (plan limit, unique code, audit entry).
 *  - Bank / cash ledger → cash & bank account: an existing account of the matching type. Only ledgers whose Tally group
 *    says for certain that they are a bank account / bank OD / cash-in-hand can be linked; accounts are not created here
 *    (an account's opening balance belongs to the go-live opening figures, not to a master link).
 *
 * Stored in TallyMasterLink (kinds 'warehouse' / 'moneyaccount'; no schema change). A link is one-to-one per Tally
 * company: one godown ↔ one warehouse, one ledger ↔ one account. Each change is written together with an audit entry.
 * Nothing here writes to Tally, and nothing reads or changes stock, balances or documents.
 */

export type MapKind = 'godown' | 'ledger'
const LINK_KIND: Record<MapKind, 'warehouse' | 'moneyaccount'> = { godown: 'warehouse', ledger: 'moneyaccount' }
type Tx = Prisma.TransactionClient

async function sourceMaster(tx: Tx, companyId: string, tallyCompany: string, kind: MapKind, guid: unknown) {
  if (typeof guid !== 'string' || !guid) throw new ApiError('guid is required', 400)
  if (!tallyCompany) throw new ApiError('Choose the Tally company first', 400)
  // Locks the master's row: two changes to the same master wait for each other
  const rows = await tx.$queryRaw<{ id: string; name: string; parent: string | null; missingSince: Date | null }[]>`
    SELECT id, name, parent, missingSince FROM TallySourceMaster
    WHERE companyId = ${companyId} AND tallyCompany = ${tallyCompany} AND kind = ${kind} AND guid = ${guid} FOR UPDATE`
  const m = rows[0]
  if (!m) throw new ApiError(`This ${kind === 'godown' ? 'godown' : 'ledger'} has not been read from Tally — read it again`, 404)
  if (m.missingSince) throw new ApiError(`This ${kind === 'godown' ? 'godown' : 'ledger'} is no longer in Tally, so it cannot be linked`, 409)
  return m
}

/** The other master already linked to this ManuFlow record (one-to-one), if any. */
async function takenBy(tx: Tx, companyId: string, tallyCompany: string, kind: MapKind, manuflowId: string, guid: string) {
  const other = await tx.tallyMasterLink.findFirst({ where: { companyId, tallyCompany, kind: LINK_KIND[kind], manuflowId, guid: { not: guid } } })
  if (!other) return null
  const m = await tx.tallySourceMaster.findFirst({ where: { companyId, tallyCompany, kind, guid: other.guid }, select: { name: true } })
  return m?.name ?? 'another Tally master'
}

async function writeLink(tx: Tx, a: { companyId: string; tallyCompany: string; kind: MapKind; guid: string; manuflowId: string; masterName: string; targetLabel: string }) {
  const where = { companyId_tallyCompany_kind_guid: { companyId: a.companyId, tallyCompany: a.tallyCompany, kind: LINK_KIND[a.kind], guid: a.guid } }
  const before = await tx.tallyMasterLink.findUnique({ where })
  if (before?.manuflowId === a.manuflowId) return { link: before, changed: false }
  const other = await takenBy(tx, a.companyId, a.tallyCompany, a.kind, a.manuflowId, a.guid)
  if (other) throw new ApiError(`${a.targetLabel} is already linked to “${other}” in Tally — unlink it there first`, 409)
  const link = before
    ? await tx.tallyMasterLink.update({ where, data: { manuflowId: a.manuflowId, createdAt: new Date(Date.now()) } })
    : await tx.tallyMasterLink.create({ data: { companyId: a.companyId, tallyCompany: a.tallyCompany, kind: LINK_KIND[a.kind], guid: a.guid, manuflowId: a.manuflowId, createdAt: new Date(Date.now()) } })
  await logAudit(tx as never, {
    companyId: a.companyId, action: before ? 'TALLY_RELINK' : 'TALLY_LINK', entity: 'TallyMasterLink', entityId: link.id,
    details: `Tally “${a.tallyCompany}” ${a.kind} “${a.masterName}” → ${a.targetLabel}${before ? ` (was ${before.manuflowId})` : ''}`.slice(0, 1000),
  })
  return { link, changed: true }
}

/** Code for a warehouse created from a godown: the name's letters and digits, made unique in the company. */
export function warehouseCode(name: string, taken: Set<string>): string {
  const base = (name.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '') || 'GODOWN').slice(0, 16)
  let code = base
  for (let n = 2; taken.has(code.toUpperCase()); n++) code = `${base}-${n}`
  return code
}

const WAREHOUSE_TYPES = ['RM', 'FG', 'GENERAL', 'SCRAP']

/** Godown → existing warehouse ({ warehouseId }) or a new warehouse ({ create: { type? } }). */
export async function linkGodown(companyId: string, tallyCompany: string, guid: unknown, target: { warehouseId?: unknown; create?: { type?: unknown } }) {
  const creating = !!target.create
  if (!creating && typeof target.warehouseId !== 'string') throw new ApiError('Choose a warehouse, or create one', 400)
  const type = creating ? String(target.create?.type ?? 'GENERAL') : 'GENERAL'
  if (!WAREHOUSE_TYPES.includes(type)) throw new ApiError('type must be one of RM, FG, GENERAL, SCRAP', 400)
  if (creating) await assertLimit(companyId, 'warehouses')
  try {
    return await db.$transaction(async (tx) => {
      const m = await sourceMaster(tx, companyId, tallyCompany, 'godown', guid)
      let w: { id: string; code: string; name: string }
      if (creating) {
        const codes = new Set((await tx.warehouse.findMany({ where: { companyId }, select: { code: true } })).map((x) => x.code.toUpperCase()))
        const name = m.name.slice(0, 190)
        w = await tx.warehouse.create({ data: { companyId, code: warehouseCode(name, codes), name, type, location: null } })
        await logAudit(tx as never, { companyId, action: 'CREATE', entity: 'Warehouse', entityId: w.id, details: `${w.code} — ${w.name} (${type}), from Tally godown` })
      } else {
        const found = await tx.$queryRaw<{ id: string; code: string; name: string }[]>`
          SELECT id, code, name FROM Warehouse WHERE id = ${target.warehouseId as string} AND companyId = ${companyId} FOR UPDATE`
        if (!found[0]) throw new ApiError('Warehouse not found', 404)
        w = found[0]
      }
      const r = await writeLink(tx, { companyId, tallyCompany, kind: 'godown', guid: guid as string, manuflowId: w.id, masterName: m.name, targetLabel: `Warehouse ${w.code} — ${w.name}` })
      return { linked: { kind: 'warehouse', id: w.id, label: `Warehouse ${w.code} — ${w.name}` }, created: creating, changed: r.changed }
    })
  } catch (e) {
    if ((e as { code?: string })?.code === 'P2002') throw new ApiError('This was changed at the same moment by someone else — refresh and try again', 409)
    throw e
  }
}

/** Bank / cash ledger → an existing cash & bank account of the matching type. */
export async function linkLedger(companyId: string, tallyCompany: string, guid: unknown, target: { moneyAccountId?: unknown }) {
  if (typeof target.moneyAccountId !== 'string') throw new ApiError('Choose a cash or bank account', 400)
  try {
    return await db.$transaction(async (tx) => {
      const m = await sourceMaster(tx, companyId, tallyCompany, 'ledger', guid)
      const groups = await tx.tallySourceMaster.findMany({ where: { companyId, tallyCompany, kind: 'group' }, select: { name: true, parent: true, data: true } })
      const c = ledgerClassifier(groups.map((g) => ({ name: g.name, parent: g.parent, reservedName: (g.data as Record<string, unknown> | null)?.reservedName as string | undefined })))(m.parent)
      if (c.confidence !== 'exact' || (c.category !== 'bank' && c.category !== 'cash')) {
        throw new ApiError('Only ledgers under Tally’s Bank Accounts, Bank OD A/c or Cash-in-Hand groups can be linked to a cash or bank account', 400)
      }
      const found = await tx.$queryRaw<{ id: string; type: string; name: string }[]>`
        SELECT id, type, name FROM MoneyAccount WHERE id = ${target.moneyAccountId as string} AND companyId = ${companyId} FOR UPDATE`
      const a = found[0]
      if (!a) throw new ApiError('Cash or bank account not found', 404)
      const want = c.category === 'cash' ? 'CASH' : 'BANK'
      if (a.type !== want) throw new ApiError(`“${m.name}” is a ${c.category} ledger in Tally — choose a ${c.category} account`, 400)
      const label = `${a.type === 'CASH' ? 'Cash' : 'Bank'} account — ${a.name}`
      const r = await writeLink(tx, { companyId, tallyCompany, kind: 'ledger', guid: guid as string, manuflowId: a.id, masterName: m.name, targetLabel: label })
      return { linked: { kind: 'moneyaccount', id: a.id, label }, created: false, changed: r.changed }
    })
  } catch (e) {
    if ((e as { code?: string })?.code === 'P2002') throw new ApiError('This was changed at the same moment by someone else — refresh and try again', 409)
    throw e
  }
}

/** Removes a godown → warehouse or ledger → account link (customer / supplier links made by imports stay). */
export async function unlinkMaster(companyId: string, tallyCompany: string, kind: MapKind, guid: unknown) {
  if (typeof guid !== 'string' || !guid) throw new ApiError('guid is required', 400)
  return db.$transaction(async (tx) => {
    const where = { companyId_tallyCompany_kind_guid: { companyId, tallyCompany, kind: LINK_KIND[kind], guid } }
    const link = await tx.tallyMasterLink.findUnique({ where })
    if (!link) return { changed: false }
    await tx.tallyMasterLink.delete({ where })
    const m = await tx.tallySourceMaster.findFirst({ where: { companyId, tallyCompany, kind, guid }, select: { name: true } })
    await logAudit(tx as never, {
      companyId, action: 'TALLY_UNLINK', entity: 'TallyMasterLink', entityId: link.id,
      details: `Tally “${tallyCompany}” ${kind} “${m?.name ?? guid}” unlinked from ${link.manuflowId}`.slice(0, 1000),
    })
    return { changed: true }
  })
}
