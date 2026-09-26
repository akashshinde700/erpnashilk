/**
 * ManuFlow ERP — create/update the platform SUPER_ADMIN.
 * Run: ADMIN_EMAIL=... ADMIN_PASSWORD=... node prisma/create-platform-admin.mjs
 * Idempotent: reuses the platform company and resets the admin's password + role.
 */
import { PrismaClient } from '@prisma/client'
import { randomBytes, scryptSync } from 'node:crypto'

const email = (process.env.ADMIN_EMAIL || '').trim()
const password = process.env.ADMIN_PASSWORD || ''
const companyName = process.env.PLATFORM_COMPANY || 'AetherDev Solutions'
if (!email || !password) {
  console.error('ADMIN_EMAIL and ADMIN_PASSWORD are required')
  process.exit(1)
}

// Same "salt:hash" scrypt format as src/lib/password.ts
const salt = randomBytes(16).toString('hex')
const passwordHash = `${salt}:${scryptSync(password, salt, 32).toString('hex')}`

const db = new PrismaClient({ log: ['error'] })
try {
  let company = await db.company.findFirst({ where: { name: companyName } })
  if (!company) company = await db.company.create({ data: { name: companyName, email, logoText: 'AD' } })

  const user = await db.user.upsert({
    where: { companyId_email: { companyId: company.id, email } },
    update: { passwordHash, role: 'SUPER_ADMIN', active: true },
    create: { companyId: company.id, name: 'Platform Admin', email, role: 'SUPER_ADMIN', passwordHash },
  })
  console.log(`SUPER_ADMIN ready: ${user.email} (company: ${company.name})`)
} finally {
  await db.$disconnect()
}
