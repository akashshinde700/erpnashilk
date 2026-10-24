/**
 * Safety guard for the automated tests: they only ever run against a database that can be
 * positively identified as a test database. Every rule must pass, otherwise the run stops
 * before Prisma connects:
 *
 *   1. TEST_DATABASE_URL is set explicitly (DATABASE_URL is never used as a fallback)
 *   2. it is a mysql:// URL
 *   3. the database name ends in `_test` or starts with `test_`
 *   4. the host is loopback (localhost / 127.0.0.1 / ::1), unless TEST_DATABASE_ALLOW_REMOTE=1
 *   5. it does not point at the same host/port/database as DATABASE_URL
 *
 * After connecting, assertTestMarker() additionally requires the marker table that only
 * `bun run test:db:prepare` creates (it refuses to prepare a non-empty, unmarked database).
 */

export const TEST_MARKER_TABLE = '_manuflow_test_marker'

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])
const TEST_DB_NAME = /(^test_[A-Za-z0-9_]+$)|(^[A-Za-z0-9_]+_test$)/

export interface TestDbTarget { url: string; host: string; port: string; database: string }

function parse(url: string): { protocol: string; host: string; port: string; database: string } | null {
  try {
    const u = new URL(url)
    return { protocol: u.protocol, host: u.hostname.toLowerCase(), port: u.port || '3306', database: decodeURIComponent(u.pathname.replace(/^\//, '')) }
  } catch {
    return null
  }
}

/** Validate the configured test database; throws with the reason when any rule fails. */
export function checkTestDatabaseUrl(env: Record<string, string | undefined>): TestDbTarget {
  const url = (env.TEST_DATABASE_URL || '').trim()
  const refuse = (why: string): never => {
    throw new Error(`[test-db-guard] Refusing to run tests: ${why}. See tests/README.md.`)
  }
  if (!url) refuse('TEST_DATABASE_URL is not set')
  const t = parse(url)
  if (!t) refuse('TEST_DATABASE_URL is not a valid URL')
  if (t!.protocol !== 'mysql:') refuse(`TEST_DATABASE_URL must be a mysql:// URL (got ${t!.protocol})`)
  if (!TEST_DB_NAME.test(t!.database)) refuse(`database name "${t!.database}" must end in "_test" or start with "test_"`)
  if (!LOOPBACK.has(t!.host) && env.TEST_DATABASE_ALLOW_REMOTE !== '1') {
    refuse(`host "${t!.host}" is not loopback (set TEST_DATABASE_ALLOW_REMOTE=1 only for a dedicated remote test server)`)
  }
  const app = env.DATABASE_URL ? parse(env.DATABASE_URL) : null
  if (app && app.protocol === 'mysql:' && app.host === t!.host && app.port === t!.port && app.database === t!.database) {
    refuse('TEST_DATABASE_URL points at the same database as DATABASE_URL')
  }
  return { url, host: t!.host, port: t!.port, database: t!.database }
}

const VERIFIED = Symbol.for('manuflow.testDbTarget')

/** Remember the target the preload verified against the ORIGINAL environment (before it rewrote DATABASE_URL). */
export function rememberVerifiedTarget(t: TestDbTarget) {
  (globalThis as Record<symbol, unknown>)[VERIFIED] = Object.freeze({ ...t })
}

export function verifiedTarget(): TestDbTarget {
  const t = (globalThis as Record<symbol, unknown>)[VERIFIED] as TestDbTarget | undefined
  if (!t) throw new Error('[test-db-guard] no verified test database — tests must run through the bun test preload')
  return t
}

type RawClient ={ $queryRawUnsafe: <T = unknown>(q: string, ...v: unknown[]) => Promise<T> }

/** Connected-database checks: the session is on the expected schema and it carries the marker table. */
export async function assertTestMarker(client: RawClient, target: TestDbTarget) {
  const [row] = await client.$queryRawUnsafe<{ db: string }[]>('SELECT DATABASE() AS db')
  if (row?.db !== target.database) {
    throw new Error(`[test-db-guard] Connected to "${row?.db}", expected "${target.database}"`)
  }
  const marker = await client.$queryRawUnsafe<{ n: bigint | number }[]>(
    'SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?',
    TEST_MARKER_TABLE,
  )
  if (!Number(marker[0]?.n)) {
    throw new Error(`[test-db-guard] ${target.database} has no ${TEST_MARKER_TABLE} table — run \`bun run test:db:prepare\` first`)
  }
}
