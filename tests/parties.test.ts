import { beforeEach, describe, expect, test } from 'bun:test'
import { db } from '@/lib/db'
import { POST as createCustomer } from '@/app/api/customers/route'
import { POST as createSupplier } from '@/app/api/suppliers/route'
import { POST as createBoth } from '@/app/api/parties/route'
import { apiRequest, call } from './helpers/api'
import { resetDb } from './helpers/db'
import { seedTenant, seedUser } from './helpers/seed'

beforeEach(resetDb)

describe('POST /api/customers', () => {
  test('creates a customer with the next C- code and GST fields derived from the GSTIN', async () => {
    const { company, user } = await seedTenant()
    const r = await call(createCustomer(apiRequest('/api/customers', { user, body: { companyId: company.id, name: 'Precision Tools', gstin: '27abcde1234f1z5', phone: '+91 98765 43210' } })))
    expect(r.status).toBe(200)
    expect(r.json.data).toMatchObject({
      code: 'C-0001', name: 'Precision Tools', gstin: '27ABCDE1234F1Z5', pan: 'ABCDE1234F', stateCode: '27',
      gstType: 'REGULAR', phone: '9876543210', status: 'ACTIVE', openingBalance: 0, companyId: company.id,
    })
    const audit = await db.auditLog.findMany({ where: { companyId: company.id, entity: 'Customer' } })
    expect(audit).toHaveLength(1)
    expect(audit[0].action).toBe('CREATE')

    const r2 = await call(createCustomer(apiRequest('/api/customers', { user, body: { companyId: company.id, name: 'Second' } })))
    expect(r2.json.data.code).toBe('C-0002')
    expect(r2.json.data.gstType).toBe('UNREGISTERED')
  })

  test('rejects an invalid GSTIN and a missing name without creating anything', async () => {
    const { company, user } = await seedTenant()
    const bad = await call(createCustomer(apiRequest('/api/customers', { user, body: { companyId: company.id, name: 'X', gstin: '27ABCDE1234' } })))
    expect(bad.status).toBe(400)
    const noName = await call(createCustomer(apiRequest('/api/customers', { user, body: { companyId: company.id, name: '  ' } })))
    expect(noName.status).toBe(400)
    expect(await db.customer.count()).toBe(0)
  })

  test('a duplicate code is a 409', async () => {
    const { company, user } = await seedTenant()
    await call(createCustomer(apiRequest('/api/customers', { user, body: { companyId: company.id, name: 'A', code: 'K1' } })))
    const dup = await call(createCustomer(apiRequest('/api/customers', { user, body: { companyId: company.id, name: 'B', code: 'K1' } })))
    expect(dup.status).toBe(409)
  })

  test('roles without customers write access get 403; anonymous gets 401', async () => {
    const { company } = await seedTenant()
    const viewer = await seedUser(company.id, 'VIEWER')
    expect((await call(createCustomer(apiRequest('/api/customers', { user: viewer, body: { companyId: company.id, name: 'A' } })))).status).toBe(403)
    expect((await call(createCustomer(apiRequest('/api/customers', { body: { companyId: company.id, name: 'A' } })))).status).toBe(401)
  })

  test('a user cannot create a customer in another company', async () => {
    const a = await seedTenant()
    const b = await seedTenant()
    const r = await call(createCustomer(apiRequest('/api/customers', { user: b.user, body: { companyId: a.company.id, name: 'Intruder' } })))
    expect(r.status).toBe(403)
    expect(await db.customer.count({ where: { companyId: a.company.id } })).toBe(0)
  })

  test('a spoofed role header that does not match the database is rejected', async () => {
    const { company } = await seedTenant()
    const viewer = await seedUser(company.id, 'VIEWER')
    const r = await call(createCustomer(apiRequest('/api/customers', { user: { ...viewer, role: 'TENANT_ADMIN' }, body: { companyId: company.id, name: 'A' } })))
    expect(r.status).toBe(401)
  })
})

describe('POST /api/suppliers', () => {
  test('creates a supplier with the next S- code', async () => {
    const { company, user } = await seedTenant()
    const r = await call(createSupplier(apiRequest('/api/suppliers', { user, body: { companyId: company.id, name: 'Steel Mart', openingBalance: '1500.555' } })))
    expect(r.status).toBe(200)
    expect(r.json.data).toMatchObject({ code: 'S-0001', name: 'Steel Mart', openingBalance: 1500.56, gstType: 'UNREGISTERED' })
  })

  test('SALES_MANAGER (customers only) cannot create suppliers', async () => {
    const { company } = await seedTenant()
    const sm = await seedUser(company.id, 'SALES_MANAGER')
    expect((await call(createSupplier(apiRequest('/api/suppliers', { user: sm, body: { companyId: company.id, name: 'A' } })))).status).toBe(403)
  })
})

describe('POST /api/parties ("Both")', () => {
  test('creates a linked customer + supplier sharing one profile', async () => {
    const { company, user } = await seedTenant()
    const r = await call(createBoth(apiRequest('/api/parties', {
      user, body: { companyId: company.id, name: 'Twin Traders', gstin: '24ABCDE1234F1Z5', openingBalance: 100, openingBalanceSupplier: 40, creditLimitSupplier: 900 },
    })))
    expect(r.status).toBe(200)
    const { customer, supplier } = r.json.data
    expect(customer).toMatchObject({ code: 'C-0001', supplierId: supplier.id, openingBalance: 100, stateCode: '24', gstType: 'REGULAR' })
    expect(supplier).toMatchObject({ code: 'S-0001', openingBalance: 40, creditLimit: 900, stateCode: '24', gstType: 'REGULAR' })
  })

  test('linkFrom turns an existing customer into Both by copying its profile', async () => {
    const { company, user } = await seedTenant()
    const c = await call(createCustomer(apiRequest('/api/customers', { user, body: { companyId: company.id, name: 'Solo', city: 'Pune', openingBalance: 75 } })))
    const r = await call(createBoth(apiRequest('/api/parties', { user, body: { companyId: company.id, linkFrom: { kind: 'customer', id: c.json.data.id } } })))
    expect(r.status).toBe(200)
    expect(r.json.data.supplier).toMatchObject({ name: 'Solo', city: 'Pune', code: 'S-0001', openingBalance: 0 })
    expect(r.json.data.customer.supplierId).toBe(r.json.data.supplier.id)
    const again = await call(createBoth(apiRequest('/api/parties', { user, body: { companyId: company.id, linkFrom: { kind: 'customer', id: c.json.data.id } } })))
    expect(again.status).toBe(409)
  })

  test('linkFrom cannot reach a party of another company', async () => {
    const a = await seedTenant()
    const b = await seedTenant()
    const c = await call(createCustomer(apiRequest('/api/customers', { user: a.user, body: { companyId: a.company.id, name: 'Theirs' } })))
    const r = await call(createBoth(apiRequest('/api/parties', { user: b.user, body: { companyId: b.company.id, linkFrom: { kind: 'customer', id: c.json.data.id } } })))
    expect(r.status).toBe(404)
  })

  test('needs both customers and suppliers write access', async () => {
    const { company } = await seedTenant()
    const sm = await seedUser(company.id, 'SALES_MANAGER')
    expect((await call(createBoth(apiRequest('/api/parties', { user: sm, body: { companyId: company.id, name: 'A' } })))).status).toBe(403)
  })
})
