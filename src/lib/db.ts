import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'production' ? ['error'] : ['query'],
    // Document posting loops over lines (stock + ledger rows) and waits on row locks under
    // concurrency; the 5s Prisma default is too tight for large documents.
    transactionOptions: { maxWait: 10000, timeout: 30000 },
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db