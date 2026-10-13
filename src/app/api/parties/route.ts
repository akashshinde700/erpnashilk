import { db } from '@/lib/db'
import { ApiError, companyRequired, handleError, logAudit, ok, requireWrite } from '@/lib/erp-helpers'
import { nextPartyCode, partyData, PROFILE_KEYS } from '@/lib/party'

// POST /api/parties — "Both" parties (a business that is customer AND supplier).
//   { ...party fields, openingBalanceSupplier?, creditLimitSupplier? }
//       → creates a linked Customer + Supplier in one transaction
//   { linkFrom: { kind: 'customer' | 'supplier', id } }
//       → turns an existing customer/supplier into "Both" by creating its linked counterpart
// Returns { customer, supplier }.
export async function POST(req: Request) {
  try {
    requireWrite(req, 'customers')
    requireWrite(req, 'suppliers')
    const body = await req.json().catch(() => ({}))
    const companyId = await companyRequired(req, body.companyId)

    const result = await db.$transaction(async (tx) => {
      if (body.linkFrom) {
        const kind = body.linkFrom.kind === 'supplier' ? 'supplier' : 'customer'
        const id = String(body.linkFrom.id || '')
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

      const name = String(body.name || '').trim()
      if (!name) throw new ApiError('Party name is required', 400)
      const shared = partyData(body, 'create')
      const code = String(body.code || '').trim()
      const supplier = await tx.supplier.create({
        data: {
          ...shared, companyId, name,
          code: code || (await nextPartyCode(companyId, 'supplier')),
          openingBalance: partyData({ openingBalance: body.openingBalanceSupplier }, 'update').openingBalance ?? 0,
          creditLimit: partyData({ creditLimit: body.creditLimitSupplier }, 'update').creditLimit ?? 0,
        } as never,
      })
      const customer = await tx.customer.create({
        data: { ...shared, companyId, name, code: code || (await nextPartyCode(companyId, 'customer')), supplierId: supplier.id } as never,
      })
      return { customer, supplier }
    })

    await logAudit(db as never, {
      companyId, action: 'CREATE', entity: 'Party', entityId: result.customer.id,
      details: `${result.customer.name} — customer ${result.customer.code} + supplier ${result.supplier.code}`,
    })
    return ok(result, 'Party saved as customer and supplier')
  } catch (e) {
    return handleError(e)
  }
}
