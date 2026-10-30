# Testing ManuFlow ERP

Two layers of tests live in this repo:

| Layer | Command | What it covers |
| --- | --- | --- |
| API suite (bun) | `npm test` | Route handlers against a real MySQL database via Prisma |
| End-to-end (Playwright) | `npm run test:e2e` | The real production UI in Chromium: login, shell, all 31 modules, CRUD dialogs, GST reports, admin screens |

## Running the E2E suite

```bash
npm install
npx playwright install --with-deps chromium   # first run only
npm run test:e2e                              # boots `next dev` on :3000 by default
```

Useful switches:

| Variable / flag | Effect |
| --- | --- |
| `E2E_PORT` | Port the app is served on (default `3000`). |
| `E2E_BASE_URL` | Full base URL, e.g. `http://localhost:3100`. |
| `E2E_SKIP_WEBSERVER=1` | Do not start a server — the suite talks to whatever is already running. |
| `E2E_WEB_COMMAND` | Override the `webServer.command` (CI uses `npm run start:e2e`, i.e. `next start`). |
| `PLAYWRIGHT_CHROMIUM_EXECUTABLE` | Point at a pre-installed Chromium instead of Playwright's download. |
| `npx playwright test e2e/specs/04-sales.spec.ts` | Run a single spec. |
| `npx playwright test --ui` / `npm run test:e2e:report` | Interactive mode / open the last HTML report. |

Artifacts land in `test-results/` (traces, screenshots, `results.json`) and
`playwright-report/` (HTML report). Both are git-ignored.

### Why the suite does not need a database

`e2e/support/mock-api.ts` installs a stateful route interception layer for every
`/api/**` call, seeded from `e2e/support/store.ts`. The browser therefore runs the
real application code (routing, forms, validation, tables, GST maths in the
components) while persistence stays in memory. That keeps the suite hermetic and
fast, and lets it run in CI in seconds without a MySQL service.

Pass `E2E_LIVE_API=1` (see `npm run test:e2e:live`) to skip the interception layer
and drive a real database — useful when validating Prisma schema changes.

## Suite layout

```
e2e/
  support/
    store.ts       deterministic fixtures (companies, parties, documents, GST data)
    mock-api.ts    stateful fake API: routing, search, CRUD, error codes
    fixtures.ts    test fixtures + helpers (login, openModule, openTab, openCreate)
    modules.ts     the module registry mirror used by the smoke tests
  specs/
    01-auth.spec.ts                 login, validation, session, logout
    02-navigation.spec.ts          shell, command palette, every screen renders
    03-masters.spec.ts             items, parties, warehouses, machines, BOM, users
    04-sales.spec.ts               enquiries → quotes → orders → challans → invoices
    05-purchase.spec.ts            requisitions → POs → GRN → bills → returns
    06-inventory-manufacturing.spec.ts  stock, transfers, production, MRP, QC
    07-finance-gst.spec.ts         outstanding, cash & bank, expenses, GST reports
    08-admin.spec.ts               settings, notifications, audit log, import, search
    09-gst-billing.spec.ts         document type, currency + exchange rate, reverse charge,
                                   HSN → GST rate suggestion in the line editor
    10-tally-einvoice.spec.ts      Tally XML/JSON/Excel downloads, push to Tally through the
                                   connector, sent-to-Tally mark, e-Invoice JSON for the portal
  unit/
    tally-export.spec.ts           pure builders: Tally voucher balance + XML shape,
                                   ledger-name precedence, IRP validation, GST split
    gst-reports.spec.ts            currency → INR conversion (fxToInr/toInrAmount/sumInr)
                                   and the reverse-charge GSTR-1 rchrg flag
    tally-push.spec.ts             the push envelope: one create-voucher, no DTD, size cap,
                                   and the TALLY_CONNECTOR_PUSH switch
    billing-totals.spec.ts         paisa-exact bill maths: line column ↔ bill taxable, tax heads ↔
                                   Σ line tax, grand total ↔ printed components, discount cap,
                                   round-off to the rupee, 400 deterministic random bills
```

`npx playwright test` runs two projects: `chromium` (the UI suite, `e2e/specs`) and
`unit` (pure functions, `e2e/unit`, no browser and no API). Run one with
`--project=unit` / `--project=chromium`.

## Conventions

* Log in with the seeded admin (`owner@nashilk.test` / `Secret@123`) through the
  real form; `loginFast` reuses the session cookie when a spec does not test auth.
* Navigate through the app the way a user does — command palette (`openModule`) or
  sidebar (`openModuleFromSidebar`) — and assert on the document title, which the
  shell keeps in sync with the active module.
* Prefer role-based locators (`getByRole('button', { name: 'Save' })`). Radix
  selects and the cmdk palette are addressed by `role="option"` /
  `data-value` attributes.
* Data-driven helpers (`store`) are per-test: creating a record in one test never
  leaks into another.
* **Billing maths is verified twice.** `unit/billing-totals.spec.ts` proves the rounding rules on the
  pure functions; the invoice specs (`04`, `05`, `07`) prove the same numbers survive the dialog →
  API → saved document → print → report round trip. Change `computeBillTotals()`/`computeGst()` only
  with both green.

## CI

`.github/workflows/e2e.yml` runs the whole suite on every push and pull request:
install → `prisma generate` → build → `next start` → Playwright, uploading the HTML
report and traces as artifacts.
