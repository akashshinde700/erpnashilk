import { db } from '@/lib/db'
import { companyRequired, handleError, logAudit, ok, requireWrite } from '@/lib/erp-helpers'
import { createBothParty, linkPartyCounterpart } from '@/lib/services/parties'

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

    // supplierCode is for callers that allocate codes themselves (CSV import), not this endpoint
    const input: Record<string, unknown> = { ...body }
    delete input.supplierCode
    const result = await db.$transaction((tx) =>
      body.linkFrom ? linkPartyCounterpart(tx, companyId, body.linkFrom) : createBothParty(tx, companyId, input))

    await logAudit(db as never, {
      companyId, action: 'CREATE', entity: 'Party', entityId: result.customer.id,
      details: `${result.customer.name} — customer ${result.customer.code} + supplier ${result.supplier.code}`,
    })
    return ok(result, 'Party saved as customer and supplier')
  } catch (e) {
    return handleError(e)
  }
}
