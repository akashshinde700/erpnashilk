import { db } from '@/lib/db'
import { TEST_MARKER_TABLE, assertTestMarker, verifiedTarget } from '../setup/test-db-guard'

/** Empty every table of the (guarded) test database except the marker. */
export async function resetDb() {
  // Re-check the live connection on every reset: deletes must never reach anything but the test database.
  await assertTestMarker(db, verifiedTarget())
  const tables = await db.$queryRawUnsafe<{ name: string }[]>(
    'SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = \'BASE TABLE\'',
  )
  await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 0')
    for (const { name } of tables) {
      if (name === TEST_MARKER_TABLE) continue
      await tx.$executeRawUnsafe(`DELETE FROM \`${name.replaceAll('`', '')}\``)
    }
    await tx.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 1')
  })
}
