# Release checklist — backup, restore and go-live

Run through this list **on staging first**, in this order, before a production release.
Nothing here deletes production data; the restore drill is done on a copy.

---

## 1. Back up (two independent copies)

| Copy | How | What it protects |
|---|---|---|
| Database dump | managed-DB snapshot, or `mysqldump --single-transaction --routines --triggers "$DATABASE_URL" \| gzip > manuflow-$(date +%F).sql.gz` | everything, including tables the app does not export |
| Tenant JSON | `node scripts/daily-backup.mjs` (cron) → `~/backups/manuflow/<date>/<companyId>.json.gz`, 14-day retention (`BACKUP_KEEP_DAYS`) | per-company data in the app's own shape, restorable from the UI |

Also confirm the app-level download works: **Settings → Data & Backup → Download backup** (admin only, `passwordHash`
is stripped, `meta.version` = 1).

**Check the backup is not empty** — a 0-byte or 200-byte file is a failed backup, not a small one:

```bash
ls -lh ~/backups/manuflow/$(date +%F)/*.json.gz
zcat ~/backups/manuflow/$(date +%F)/<companyId>.json.gz | head -c 400   # meta + counts visible
```

## 2. Restore drill (staging, never production)

1. Point staging at a **separate** database and run `npm run db:push`.
2. Open **Settings → Data & Backup → Restore**, pick the `.json.gz`, and type the company name to confirm.
   The UI takes a fresh backup of the current staging data **before** it replaces anything — wait for that download.
3. Compare counts: `meta.counts` in the file vs the row counts after restore (Customers, Items, Sales Invoices,
   Stock Ledger rows). They must match exactly.
4. Spot-check financially: open three invoices and a stock-ledger page; the totals and quantities must equal what was in
   production. Check **GST Reports → GSTR-1/GSTR-2** totals against the production screenshots.
5. Try the failure path too: restore a file for the **wrong** company → must be refused; type the wrong name → must be
   refused; kill the process mid-restore → nothing half-written (the replace runs in one transaction).

Record the drill: date, file used, counts compared, who ran it.

**Recovery targets to agree before go-live:** RPO ≤ 24 h (nightly JSON + DB snapshot) unless the managed DB offers
point-in-time recovery, in which case RPO = the PITR window; RTO = time to `db:push` + restore (measure it in the drill).

## 3. Before the release

- [ ] `npm run db:push` runs clean (it drops the removed `Lead` / `LeadActivity` tables — that is expected, **take a dump first**)
- [ ] `npx next build` succeeds; `npx playwright test` green (128 tests at the time of writing)
- [ ] `bun test` green against the guarded test database (needs `TEST_DATABASE_URL`; includes the concurrency suite)
- [ ] `.env` reviewed: `DATABASE_URL`, session secret, `TALLY_CONNECTOR_POC` / `TALLY_CONNECTOR_PUSH` (both **off** unless
      the customer really wants voucher push), Tally ledger name overrides if the customer's Tally uses different names
- [ ] Nightly backup job is actually installed on the server (`crontab -l`), and someone owns the backup folder
- [ ] Smoke test after deploy: log in, create + print one invoice, receive one GRN, post one production entry, open
      Dashboard / GST reports

## 4. Rollback

1. Stop the app.
2. Restore the DB dump/snapshot taken in step 1 (this is why step 1 exists).
3. Deploy the previous build (`git checkout <previous-release-tag> && npm ci && npx next build`).
4. Start the app and run the smoke test again.

A schema change that cannot be rolled back (for example a `Decimal` money migration) must ship as its own release with
its own dump, so application rollback never has to reverse a migration.
