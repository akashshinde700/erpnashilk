import type { Prisma } from '@prisma/client'
import { ApiError, logAudit } from '@/lib/erp-helpers'
import { nextPartyCode, partyData, PROFILE_KEYS } from '@/lib/party'

/**
 * Party (Customer / Supplier / "Both") creation, shared by the API routes and the CSV import.
 * Every function runs inside the caller's transaction and is scoped to `companyId`.
 * Field validation and normalisation stay in partyData() (src/lib/party.ts).
 */

type Tx = Prisma.TransactionClient
type Body = Record<string, unknown>
export type PartyKind = 'customer' | 'supplier'

const ENTITY: Record<PartyKind, string> = { customer: 'Customer', supplier: 'Supplier' }

export interface CreateOptions {
  /** Write the per-record CREATE audit row (default true; bulk imports write one summary instead). */
  audit?: boolean
  userName?: string
}

/** Party name: required, trimmed. */
export function partyName(body: Body): string {
  const name = String(body.name || '').trim()
  if (!name) throw new ApiError('Party name is required', 400)
  return name
}

/** Create one customer or supplier. Blank code → next free C-0001 / S-0001 style code. */
export async function createParty(tx: Tx, companyId: string, kind: PartyKind, body: Body, opts: CreateOptions = {}) {
  const name = partyName(body)
  const profile = partyData(body, 'create')
  const code = String(body.code || '').trim() || (await nextPartyCode(companyId, kind))
  const data = { companyId, code, name, ...profile, status: (body.status as string) || 'ACTIVE' }
  const created = kind === 'customer'
    ? await tx.customer.create({ data: data as Prisma.CustomerUncheckedCreateInput })
    : await tx.supplier.create({ data: data as Prisma.SupplierUncheckedCreateInput })
  if (opts.audit !== false) {
    await logAudit(tx as never, {
      companyId, userName: opts.userName, action: 'CREATE', entity: ENTITY[kind], entityId: created.id, details: `${code} — ${name}`,
    })
  }
  return created
}

/**
 * "Both" party: a linked Customer + Supplier with one shared profile. Opening balance and credit
 * limit are per side: `openingBalance` / `creditLimit` for the customer, `openingBalanceSupplier` /
 * `creditLimitSupplier` for the supplier. `supplierCode` overrides the supplier's code when the
 * caller allocates codes itself (imports); otherwise both sides use `code` or their own next code.
 */
export async function createBothParty(tx: Tx, companyId: string, body: Body) {
  const name = partyName(body)
  const shared = partyData(body, 'create')
  const code = String(body.code || '').trim()
  const supplierCode = String(body.supplierCode || '').trim()
  const supplier = await tx.supplier.create({
    data: {
      ...shared, companyId, name,
      code: supplierCode || code || (await nextPartyCode(companyId, 'supplier')),
      openingBalance: partyData({ openingBalance: body.openingBalanceSupplier }, 'update').openingBalance ?? 0,
      creditLimit: partyData({ creditLimit: body.creditLimitSupplier }, 'update').creditLimit ?? 0,
    } as never,
  })
  const customer = await tx.customer.create({
    data: { ...shared, companyId, name, code: code || (await nextPartyCode(companyId, 'customer')), supplierId: supplier.id } as never,
  })
  return { customer, supplier }
}

/** Turn an existing customer or supplier into "Both" by creating its counterpart from its profile. */
export async function linkPartyCounterpart(tx: Tx, companyId: string, from: { kind?: unknown; id?: unknown }) {
  const kind = from.kind === 'supplier' ? 'supplier' : 'customer'
  const id = String(from.id || '')
  if (kind === 'customer') {
    const c = await tx.customer.findFirst({ where: { id, companyId } })
    if (!c) throw new ApiError('Customer not found', 404)
    if (c.supplierId) throw new ApiError('This party is already a supplier too', 409)
    const profile = Object.fromEntries(PROFILE_KEYS.map((k) => [k, c[k]]))
    const supplier = await tx.supplier.create({
      data: { ...profile, companyId, name: c.name, code: await nextPartyCode(companyId, 'supplier') } as never,
    })
    const customer = await tx.customer.update({ where: { id: c.id }, data: { supplierId: supplier.id } })
    return { customer, supplier }
  }
  const s = await tx.supplier.findFirst({ where: { id, companyId }, include: { customer: { select: { id: true } } } })
  if (!s) throw new ApiError('Supplier not found', 404)
  if (s.customer) throw new ApiError('This party is already a customer too', 409)
  const profile = Object.fromEntries(PROFILE_KEYS.map((k) => [k, s[k]]))
  const customer = await tx.customer.create({
    data: { ...profile, companyId, name: s.name, code: await nextPartyCode(companyId, 'customer'), supplierId: s.id } as never,
  })
  return { customer, supplier: s }
}
