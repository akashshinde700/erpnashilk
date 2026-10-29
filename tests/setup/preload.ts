/**
 * bun test preload (bunfig.toml). Runs before any test file imports app code.
 *
 * The guard validates TEST_DATABASE_URL; then the shared Prisma client that src/lib/db.ts
 * reuses (globalThis.prisma) is created here, bound explicitly to that URL — app code under
 * test can never fall back to DATABASE_URL. Finally the connected database must carry the
 * marker table written by `bun run test:db:prepare`.
 */
import { PrismaClient } from '@prisma/client'
import { assertTestMarker, checkTestDatabaseUrl, rememberVerifiedTarget } from './test-db-guard'

const target = checkTestDatabaseUrl(process.env)
rememberVerifiedTarget(target)
process.env.DATABASE_URL = target.url

const g = globalThis as unknown as { prisma?: PrismaClient }
if (g.prisma) throw new Error('[test-db-guard] a Prisma client already exists before the test preload ran')
// Same transaction limits as src/lib/db.ts; query logging off to keep test output readable.
g.prisma = new PrismaClient({
  datasourceUrl: target.url,
  log: ['warn', 'error'],
  transactionOptions: { maxWait: 10000, timeout: 30000 },
})

await assertTestMarker(g.prisma, target)
