# Direct import from Tally — connector design

Status: **diagnostics only.** ManuFlow can check whether a configured TallyPrime XML server answers
(`GET /api/import-center/tally/status`, self-hosted installs) and — as a proof of concept that is off by default —
whether a paired ManuFlow Tally Connector can reach Tally (see below). It does not list Tally companies or import data
from Tally yet. The Import Center shows "Not connected" until a check really succeeds.

## How TallyPrime exposes data

From Tally's own documentation (help.tallysolutions.com — "XML integration", "TallyPrime as server",
"Pre-requisites for integrations"):

- TallyPrime acts as an HTTP server when **Exchange → Data Synchronization → "TallyPrime act as"** is
  *Server* or *Both* (also under F1 Help → Settings → Advanced Configuration). Default port **9000**.
- At least one company must be loaded in Tally.
- Requests are HTTP `POST` with an XML body (`text/xml`): an `<ENVELOPE>` with `<HEADER>`
  (`VERSION`, `TALLYREQUEST` e.g. `Export`, `TYPE` e.g. `Data` / `Collection`, `ID` = report or
  collection name) and `<BODY><DESC><STATICVARIABLES>…</STATICVARIABLES></DESC></BODY>`
  (e.g. `SVCURRENTCOMPANY`, `SVEXPORTFORMAT`).
- Replies are XML envelopes; `<STATUS>1</STATUS>` = success, `0` = failure.
- The documentation shows **no authentication** on this interface and does not say which network
  interfaces it listens on. Treat the port as unauthenticated: anyone who can reach it can read the
  loaded company's books.

Not verified (and therefore not used yet): the exact text Tally returns for a plain `GET`, the request
that lists loaded companies, and the export layouts of ledgers / stock items / vouchers across
TallyPrime versions. These must be checked against a real TallyPrime installation before any import
is built on them.

## Why a connector is needed

ManuFlow is deployed on a cloud server (CloudPanel, see `deploy.py`). TallyPrime runs on the
customer's PC inside their office network. The ManuFlow server cannot open a connection to
`localhost:9000` on someone else's PC, and it must not try: "localhost" on the server is the server.
The browser cannot do it either (Tally sends no CORS headers; browsers block public pages from
calling private-network addresses).

## What is implemented now

- `src/lib/tally/client.ts` — `checkTally()`: POSTs one small Export envelope (a report id that does
  not exist, so Tally replies with a short STATUS envelope instead of exporting books), 4 s timeout,
  256 KB reply cap, redirects not followed, replies with a DTD / entity declaration refused. "Connected"
  only when the HTTP 200 reply is a closed `<ENVELOPE>` / `<RESPONSE>` document.
- `GET /api/import-center/tally/status` — needs Import Center access. The Tally address comes **only**
  from the server setting `TALLY_HTTP_URL` (e.g. `http://192.168.1.20:9000`, http/https, no
  credentials / path). Never from the request — otherwise users could make the server probe internal
  addresses (SSRF). Unset → `not_configured` with the connector explanation.
- Tested against a mock HTTP server (connected, HTML reply, HTTP 500, redirect, oversize reply,
  DTD payload, timeout, closed port) — **not against a real TallyPrime**, which is not available here.

`TALLY_HTTP_URL` is only meaningful when ManuFlow runs on the same machine or network as Tally
(self-hosted). On the cloud deployment it stays unset.

## ManuFlow Tally Connector — proof of concept (built, OFF by default)

Status: **local proof of concept.** Pairing, heartbeat, status, disconnect / reconnect, the Tally company list and
importing **customers (Sundry Debtors), suppliers (Sundry Creditors) and stock items** work end to end against a
**mock** Tally server and in the browser. **Not tested against a real TallyPrime** — the export requests and the Tally
field names are unverified. Vouchers, orders, other ledgers, opening balances / stock and date ranges are not built.
Disabled unless the server has `TALLY_CONNECTOR_POC=1`; without it every connector endpoint answers 503 and the
Import Center shows "Connector not available".

### Where TallyPrime runs (affects where the connector runs)

- TallyPrime is supported **only on 64-bit Windows** (Windows 7 / Server 2008 R2 or later, incl. Windows 11) per
  Tally's "Recommended system configuration" page; Tally's FAQ says it cannot be installed on a Mac. No Linux build
  is documented. Wine / VMs / remote-desktop hosting are not assumed to work.
- The connector itself is a plain Node.js (18+) script with no packages, so it can run on Windows, macOS or Linux —
  but it must be able to reach Tally's port: normally on the Tally PC itself (`http://127.0.0.1:9000`), otherwise on
  another computer in the same office network (`http://192.168.x.x:9000`, with Windows Firewall allowing only that
  computer). Only the Windows-on-same-PC case is the expected setup; none has been tried with real Tally.

### Import from Tally (UI: `tally-import.tsx`, opened by the Tally card)

1. **Connect Tally** — connector status (Connected / Not connected / Waiting for pairing / Connector offline /
   Tally not reachable), Connect / Reconnect / Disconnect, last check-in and last successful Tally contact. "Next"
   only when the connector is online **and** TallyPrime answers.
2. **Choose company** — job `list-companies`; Tally's real list (only companies open in TallyPrime), search when
   more than 6, 50 at a time, Refresh keeps a still-valid choice. Empty list → "No company is open in TallyPrime".
3. **Select data** — Customers, Suppliers, Stock items (+ the item type, which Tally does not have — required, not
   guessed). Vouchers, orders, other masters and the date range are listed as not available.
4. **Review & import** — reads the chosen data (jobs `export-customers` / `export-suppliers` / `export-items`), runs
   the normal Import Center **preview** on it in 500-row batches (new / already in ManuFlow / need attention), then
   one **Import data** button imports batch by batch with progress (never 100 % before the end), "Stop after this
   part", a list + CSV of rows not imported, and one Import History entry per batch. Running it again skips what was
   imported (the services' duplicate rules), so a retry / double click creates no duplicates.

Records go through `src/lib/tally/to-import.ts` → `runImport()` (the same validation and import services as an
uploaded file). Tally's GUID is not stored (no column); opening balances and opening stock are not imported.

### Flow

```
Admin in ManuFlow ──"Connect Tally"──► POST /api/import-center/tally/connector  → code ABCDE-FGHJK (10 min, once)
Connector (office PC) ── pair --code ─► POST /api/tally-connector/pair          → token (once, stored hashed)
Connector every 5–30 s: POST <tally 127.0.0.1:9000> fixed health request (read-only)
                       POST /api/tally-connector/heartbeat (Bearer token) { tally: { status, latencyMs, endpoint } }
                                       ← { nextHeartbeatSec, job?: { id, type: one of 4 names, company? } }
When a job comes: POST <tally> the connector's own fixed Export XML for that name → POST /api/tally-connector/result
                  { jobId, ok, records | error code }
Browser: POST/GET/DELETE /api/import-center/tally/jobs (queue / poll / cancel) → POST /api/import-center/tally/import
         { jobId, dataType, mode: preview | commit, batch } (Tally data stays on the server)
Admin ──"Disconnect"──► DELETE /api/import-center/tally/connector → token revoked → next heartbeat 401 → connector
                                                                    deletes its settings and stops
```

| Piece | File |
|---|---|
| Server logic (codes, tokens, heartbeat, status, rate limits, store) | `src/lib/tally/connector.ts` |
| Admin routes (GET status, POST code, DELETE disconnect) | `src/app/api/import-center/tally/connector/route.ts` |
| Connector routes (no session; public in `src/middleware.ts`) | `src/app/api/tally-connector/{pair,heartbeat}/route.ts` |
| Connector program | `connector/tally/manuflow-tally-connector.mjs` |
| UI | `src/components/erp/import-center/tally-connector-panel.tsx` (wizard step 2, "Connect to Tally directly") |
| Tests | `tests/tally-connector.test.ts` |

### Security design

- **Tally's port never faces the internet.** The connector only makes outbound HTTPS calls; no port forwarding,
  tunnel or VPN.
- **No SSRF.** ManuFlow never makes a request to a Tally address and never sends the connector a URL, XML or
  command; a heartbeat reply carries at most one job **name** from a fixed list of four, plus a Tally company name
  that must appear in Tally's own latest company list. The connector refuses unknown names. The Tally address is set on the connector's computer
  and must be `localhost` / `127.x` / `[::1]` or a private IPv4 (10/8, 172.16/12, 192.168/16) — never a host name
  (DNS) or a public address.
- **Read-only towards Tally.** Every request is `TALLYREQUEST=Export` (the health check plus four collection exports
  built by the connector; the company name is XML-escaped). Tests assert no Import / Alter / Delete and check every
  request the mock Tally received. Replies: ≤ 64 MB, 120 s, no DTD / entities, UTF-8 or UTF-16.
- **Job results:** only the connector's own *running* job (cancelled / timed-out jobs drop late results); ≤ 8 MB
  (below the middleware's body limit), ≤ 20 000 records, only the known fields of that job type, length-capped,
  control characters removed; malformed data fails the job. Jobs and their records are kept 30 minutes, per company.
  Exports need the same write right as the import (customers / suppliers / items).
- **Pairing code:** 10 characters (31-symbol alphabet, ~49 bits), 10 minutes, single use, SHA-256 hash only, one open
  code per company, shown once, never returned by the status endpoint. Wrong codes: 10 per IP per 15 min, then 429.
  Codes: 10 per company per hour.
- **Connector token:** `mftc_<24 hex id>_<32 random bytes>`; only its SHA-256 is kept, compared in constant time;
  returned once. Pairing again revokes the previous connector; Disconnect revokes at once.
- **Authorization / tenants:** status needs Import Center access; creating codes and disconnecting need Tenant Admin /
  Management / Super Admin. A token is bound to the company of its code; the company comes from the token, never
  from the request. Pairing / disconnect are written to the audit log (never the code or token).
- **Input limits:** connector requests ≤ 4 KB; heartbeat status must be one of five values; endpoint kept only if it
  is a loopback / private `host:port`; one heartbeat per 5 s per connector. Messages shown in the UI are written by
  the server, not taken from the connector.
- **Connector settings:** `%APPDATA%\ManuFlowTallyConnector\connector.json` (Windows),
  `~/Library/Application Support/ManuFlowTallyConnector/` (macOS), `$XDG_CONFIG_HOME/manuflow-tally-connector/`
  (Linux); file mode 0600, folder 0700 (on Windows the user-profile ACL applies instead). The token is never printed.
  Redirects from ManuFlow are refused, so the token cannot be forwarded elsewhere.

### Push to Tally — sales vouchers (built, OFF by default)

The one direction that **writes**: **Sales → Sales Invoices → invoice menu → “Push to Tally (connector)”**
sends that invoice to TallyPrime through the paired connector instead of downloading a file.

```
Invoice menu ──POST /api/import-center/tally/push { invoiceId }──►  server builds ONE Import envelope
                                                                   (buildTallyVoucher → voucherToXml,
                                                                    the same builder as the XML download)
                                                                    and queues it as job type push-voucher
Connector heartbeat ──► { job: { id, type: 'push-voucher', xml } }  ← the envelope, unchanged
Connector ──POST <tally 127.0.0.1:9000> the envelope──────────────►  TallyPrime creates the voucher
Connector ──POST /api/tally-connector/result { jobId, ok, records: [{ name, status }] }
Browser ──GET /api/import-center/tally/jobs?id=…──► done → toast; the invoice is marked “sent to Tally”
```

What is deliberately narrow:

* **One invoice, one envelope, one voucher.** `checkPushXml()` (server, `src/lib/tally/push-xml.ts`) and
  `pushProblem()` (connector, `manuflow-tally-connector.mjs`) both require exactly one
  `<VOUCHER … ACTION="Create">` inside an `<ENVELOPE>` with `TALLYREQUEST=Import Data`, no DTD and no
  entity declaration, ≤ 256 KB. Two vouchers, an Update/Delete action or an Export request are refused
  **on both sides**, so a server bug cannot become an arbitrary write in Tally.
* **The connector never builds an Import request.** It posts the document it was handed, byte for byte
  (asserted in `tests/tally-connector.test.ts`), and it only does so for a job that carries `xml`.
* **The browser never supplies XML** — no endpoint accepts it. The payload is built from the invoice.
* **Nothing to duplicate:** the voucher carries `REMOTEID="MANUFLOW-INV-<id>"`. If Tally answers
  “already exists / duplicate”, the job is **done** with `result.status = 'exists'` and the UI says
  “was already in TallyPrime” instead of failing.
* **Off unless asked for:** the route answers 503 with `TALLY_PUSH_DISABLED` unless the server runs with
  `TALLY_CONNECTOR_PUSH=1` **and** the connector feature switch `TALLY_CONNECTOR_POC=1` is on.
  Cancelled invoices are refused; a second click while a push is still running returns the waiting job.
* **Same permissions as raising the invoice:** `requireWrite('sales-invoices')` + `requireWrite('import-center')`.
  The connector token still binds the company; the company is never taken from the request.

Not verified (as everywhere else in this connector): the Import envelope against a **real** TallyPrime.
The voucher only imports cleanly when the ledgers it names already exist in that Tally company — the
**All Masters** file (or an existing chart of accounts) is a precondition, and a missing ledger shows up
as `voucher_rejected` with a message that says so.

### Known limitations of the proof of concept

1. **In-memory storage.** Codes and connectors live in the server process: lost on restart, not shared between PM2
   instances. Production needs two tables (schema change, not made):

   ```prisma
   model TallyConnectorPairing {
     id        String   @id @default(cuid())
     companyId String
     codeHash  String   @unique
     createdBy String
     expiresAt DateTime
     createdAt DateTime @default(now())
     @@index([companyId])
   }
   model TallyConnector {
     id                 String    @id
     companyId          String
     secretHash         String
     pairedBy           String
     pairedAt           DateTime  @default(now())
     revokedAt          DateTime?
     lastSeenAt         DateTime?
     lastTallyStatus    String?
     lastTallyCheckAt   DateTime?
     lastTallySuccessAt DateTime?
     lastLatencyMs      Int?
     tallyEndpoint      String?
     version            String?
     platform           String?
     @@index([companyId, revokedAt])
   }
   ```
   Single use must then be one conditional `DELETE … WHERE codeHash = ?` (affected rows = 1).
2. **Rate limits are per process** (like the login throttle) and reset on restart.
3. **IP for rate limiting** comes from `X-Forwarded-For` — correct only behind the CloudPanel proxy that sets it.
4. **Token at rest on the PC** is protected by file permissions only; Windows DPAPI / macOS Keychain would be better.
5. **No signed installer / download.** Customers would need Node.js and the `.mjs` file; an installer (signed
   Windows build, run as a service) is still to do.
6. **Masters only.** Vouchers etc. need accounting decisions and a schema change (Tally GUID per record) first.
7. **Unverified against real TallyPrime:** the company-list / ledger / stock-item export XML, and the reply fields
   read (`PARTYGSTIN` vs `LEDGSTREGDETAILS.LIST`, `LEDMAILINGDETAILS.LIST`, `GSTDETAILS.LIST/RATEDETAILS.LIST`, …).
   Capture real replies from at least two TallyPrime releases before relying on it.

### Production would additionally need

- Tables for pairing codes, connectors **and jobs** (proposal above; jobs: id, companyId, connectorId, type,
  tallyCompany, status, error, timestamps, and the records in a JSON / separate rows table with a 30-minute expiry).
- A database lock instead of the per-process import lock, if more than one app process runs.
- Optionally a `tallyGuid` column on customers / suppliers / items for stable re-import matching.

## Next steps

1. Install TallyPrime (education / trial mode is enough) and capture real replies: company list,
   List of Accounts / ledgers with groups, stock items with units and GST details — across at least
   two TallyPrime releases. Store them as anonymised test fixtures.
2. Write and test the Tally XML → row mappers against those fixtures (Sundry Debtors → customers,
   Sundry Creditors → suppliers, stock items → items; units mapped to ManuFlow UOMs explicitly).
3. Build the connector endpoints + token model (needs a schema change — plan it with the deploy
   process, `prisma db push` on deploy, no data-loss flags).
4. Build and sign the connector app; document firewall settings (port 9000 reachable from
   127.0.0.1 only).
5. Vouchers: **sales invoices and purchase bills can already be pushed** (see above; bills go out as
   Purchase vouchers with the input-tax ledgers). Receipts and journals still need the accounting
   decisions listed in the Smart Import audit (no general ledger, document numbering, bill-wise
   outstanding, go-live date).
6. Once a real TallyPrime is available: capture the exact reply of an Import (`<STATUS>1</STATUS>`,
   line errors for a duplicate remote id) and replace the pattern matching in `pushVoucher()`.
7. Persist push results (a `tallyPushedAt` / `tallyRemoteId` on the invoice would let the list show it).
   Today the result lives in the 30-minute in-memory job and the “sent to Tally” flag on the invoice.
