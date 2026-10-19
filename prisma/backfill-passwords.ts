/**
 * One-off backfill: give every user without a passwordHash the demo password.
 * Run: bun prisma/backfill-passwords.ts
 */
import { PrismaClient } from '@prisma/client'
import { hashPassword, DEMO_PASSWORD } from '../src/lib/password'

const db = new PrismaClient()

async function main() {
  const users = await db.user.findMany({ where: { passwordHash: null }, select: { id: true, email: true } })
  for (const u of users) {
    await db.user.update({ where: { id: u.id }, data: { passwordHash: hashPassword(DEMO_PASSWORD) } })
  }
  console.log(`Backfilled ${users.length} users with demo password (${DEMO_PASSWORD})`)
}

main().finally(() => db.$disconnect())
