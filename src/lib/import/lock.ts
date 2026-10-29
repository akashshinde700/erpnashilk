import type { Prisma } from '@prisma/client'

/**
 * Cross-process guard for imports. The duplicate checks of the import services run on a snapshot
 * taken when the import starts; names are not unique in the database, so two imports running at the
 * same time in different server processes could both create the same party / item.
 *
 * Every row's write transaction therefore first locks the company row (InnoDB row lock, held until
 * the transaction ends) and then re-checks for a duplicate created meanwhile. Writes of imports of one
 * company are serialised across processes; other companies are not affected.
 */
export async function lockCompanyForImport(tx: Prisma.TransactionClient, companyId: string) {
  await tx.$queryRaw`SELECT id FROM Company WHERE id = ${companyId} FOR UPDATE`
}

/** A duplicate that appeared after the import started (found by the in-transaction re-check). */
export class ImportDuplicateError extends Error {}
