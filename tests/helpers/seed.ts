import { db } from '@/lib/db'

// Synthetic test data only.

let seq = 0
const next = () => ++seq

export async function seedCompany(overrides: Record<string, unknown> = {}) {
  const n = next()
  return db.company.create({
    data: { name: `Test Works ${n}`, state: 'Maharashtra', stateCode: '27', ...overrides } as never,
  })
}

export async function seedUser(companyId: string, role = 'TENANT_ADMIN') {
  const n = next()
  return db.user.create({ data: { companyId, name: `Tester ${n}`, email: `tester${n}@example.test`, role } })
}

export async function seedWarehouse(companyId: string, code = 'MAIN', type = 'GENERAL') {
  return db.warehouse.create({ data: { companyId, code, name: `${code} store`, type } })
}

/** Company + admin user + one warehouse. */
export async function seedTenant(role = 'TENANT_ADMIN') {
  const company = await seedCompany()
  const user = await seedUser(company.id, role)
  const warehouse = await seedWarehouse(company.id)
  return { company, user, warehouse }
}
