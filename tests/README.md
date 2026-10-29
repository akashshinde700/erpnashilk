# Automated tests

API-level tests run with `bun test` against a **dedicated, test-only MySQL database**. Route handlers
are called directly with the identity headers middleware.ts would set, so authentication (user,
role and password version re-checked against the database), permissions and tenant isolation are
exercised for real. All data is synthetic and is wiped before every test.

## Safety guard

`tests/setup/test-db-guard.ts` refuses to run unless **all** of these hold:

1. `TEST_DATABASE_URL` is set — `DATABASE_URL` is never used as a fallback
2. it is a `mysql://` URL
3. the database name ends in `_test` or starts with `test_`
4. the host is loopback (`localhost`, `127.0.0.1`, `::1`), unless `TEST_DATABASE_ALLOW_REMOTE=1`
5. it is not the same host/port/database as `DATABASE_URL`
6. the connected database contains the `_manuflow_test_marker` table, which only
   `bun run test:db:prepare` creates — and that script refuses a database that already has tables
   but no marker

The preload (`tests/setup/preload.ts`) creates the shared Prisma client bound explicitly to the
verified URL, so app code under test cannot connect anywhere else. Each reset re-checks the live
connection before deleting rows.

## Setup

```bash
# 1. An empty MySQL 8 database + user that exist only for tests, e.g.
#    CREATE DATABASE manuflow_test CHARACTER SET utf8mb4;
#    CREATE USER 'manuflow_test'@'127.0.0.1' IDENTIFIED BY '…';
#    GRANT ALL ON manuflow_test.* TO 'manuflow_test'@'127.0.0.1';

# 2. Point the tests at it (shell, or a gitignored .env.test file — bun loads it for `bun test`)
export TEST_DATABASE_URL='mysql://manuflow_test:…@127.0.0.1:3306/manuflow_test'

# 3. Create / sync the schema in the test database and write the marker
bun run test:db:prepare

# 4. Run
bun test            # all tests
bun run test:types  # type-check tests/ (bun-types) together with src/
```

Re-run `test:db:prepare` after changing `prisma/schema.prisma`. It runs `prisma db push` **without**
`--accept-data-loss`; the marker table (not a Prisma model) is taken out for the push and always restored.

## Layout

| File | Covers |
|---|---|
| `guard.test.ts` | the database guard rules |
| `parties.test.ts` | customer / supplier / "Both" creation through the routes, auth, tenant isolation |
| `customers-import.test.ts` | customers CSV import (shared party validation, codes, BOTH rows, duplicates, limits) |
| `items.test.ts` | item creation through the route, opening stock, batches / serials, plan limit |
| `items-import.test.ts` | items CSV import (HSN / GST / purchase price / category, duplicates, opening stock, no partial items) |
| `opening-stock.test.ts` | opening-stock warehouse / item tenant checks |
| `import-fields.test.ts` | Import Center column aliases, header-row detection, CSV delimiters |
| `import-parse.test.ts` | file parsing: encodings, .xlsx, refused formats, zip bombs, size / cell limits |
| `import-center.test.ts` | Import Center API end to end: upload → preview (no writes) → confirm → commit → history; tampering, limits, permissions, company isolation, failures |
| `tally.test.ts` | Tally connectivity check against a mock HTTP server (connected / unreachable / timeout / malformed / oversize) and the status route |
| `navigation.test.ts` | Utilities group and Import Center registration / role access |
| `supplier-import.test.ts` | supplier import: aliases, party validation, "Both" / duplicate rules, authorization, company isolation, partial failure |
| `opening-figures.test.ts` | go-live date (set / validate / lock), opening stock (ledger, balances, batches, P&L effect, reconciliation, duplicates, ordering, isolation, failure), opening balances (check-only: Dr / Cr, matching, totals, commit refused) |
| `helpers/` | request builder, seed data, database reset |

The "no partial item" and Import Center failure tests temporarily add a CHECK constraint (to
`StockLedger` / `Customer` / `Supplier`) in the test database to force a failure, and drop it again in `finally`.
