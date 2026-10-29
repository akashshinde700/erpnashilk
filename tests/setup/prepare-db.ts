/**
 * `bun run test:db:prepare` — create / sync the schema in the TEST database only.
 *
 * Runs `prisma db push` with DATABASE_URL replaced by the guarded TEST_DATABASE_URL, then
 * creates the marker table the test run requires. A database that already holds tables but
 * no marker is refused: it is not ours, and db push could change or drop its data.
 */
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { PrismaClient } from '@prisma/client'
import { TEST_MARKER_TABLE, checkTestDatabaseUrl } from './test-db-guard'

const target = checkTestDatabaseUrl(process.env)
const client = new PrismaClient({ datasourceUrl: target.url })

async function main() {
  const [row] = await client.$queryRawUnsafe<{ db: string }[]>('SELECT DATABASE() AS db')
  if (row?.db !== target.database) throw new Error(`Connected to "${row?.db}", expected "${target.database}"`)
  const tables = await client.$queryRawUnsafe<{ name: string }[]>(
    'SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE()',
  )
  const marked = tables.some((t) => t.name === TEST_MARKER_TABLE)
  if (tables.length > 0 && !marked) {
    throw new Error(`${target.database} already has ${tables.length} table(s) but no ${TEST_MARKER_TABLE} marker — refusing to touch it`)
  }
  // The marker is not a Prisma model, so db push would want to drop it (a "data loss" warning). The
  // database has just been verified as ours, so take the marker out for the push and always put it back.
  if (marked) await client.$executeRawUnsafe(`DROP TABLE \`${TEST_MARKER_TABLE}\``)
  await client.$disconnect()

  let pushed = false
  try {
    console.log(`[test-db] prisma db push → ${target.host}:${target.port}/${target.database}`)
    const root = path.resolve(import.meta.dir, '../..')
    // No --accept-data-loss: a change that would drop data fails here — recreate the test database instead.
    const res = spawnSync(path.join(root, 'node_modules/.bin/prisma'), ['db', 'push', '--skip-generate'], {
      cwd: root,
      stdio: 'inherit',
      env: { ...process.env, DATABASE_URL: target.url },
    })
    pushed = res.status === 0
    if (!pushed) throw new Error(`prisma db push failed (exit ${res.status})`)
  } finally {
    const c2 = new PrismaClient({ datasourceUrl: target.url })
    await c2.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS \`${TEST_MARKER_TABLE}\` (id INT PRIMARY KEY, createdAt DATETIME NOT NULL)`)
    await c2.$executeRawUnsafe(`INSERT IGNORE INTO \`${TEST_MARKER_TABLE}\` (id, createdAt) VALUES (1, NOW())`)
    await c2.$disconnect()
  }
  if (pushed) console.log('[test-db] ready')
}

main().catch(async (e) => {
  console.error(`[test-db] ${e instanceof Error ? e.message : e}`)
  await client.$disconnect().catch(() => {})
  process.exit(1)
})
