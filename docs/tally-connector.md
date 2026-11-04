# Direct import from Tally — connector design

Status: **proof of concept, off by default, not tested against a real TallyPrime.**

## Automated read-only connector and manual Tally imports

These are two separate routes, and only the second can write to Tally.

| | Automated connector | Manual Tally import |
|---|---|---|
| Direction | TallyPrime → ManuFlow only | ManuFlow → TallyPrime |
| Started by | A ManuFlow user, through the connector on the office PC | A person, outside ManuFlow, on their own PC |
| Reads from Tally | Companies, customers, suppliers, stock items | No |
| Writes to Tally | **Never** | **Yes** |
| Voucher sync | None, past or future | One invoice file at a time |

The connector does not sync automatically: each read is started by a user in the Import Center. Vouchers are not read.

### Manual write exception: `Tally-Import.bat`

`public/downloads/tally/Tally-Import.bat` **writes data into TallyPrime**. It posts an XML file to Tally's port and can
create or alter vouchers and masters in the open company. It is kept deliberately as a manual write exception.

* **It requires explicit human approval before each run.** Whoever runs it must check the file and the Tally company
  first. The approval is a procedure: the script itself does not ask for confirmation, and when double-clicked it
  picks the newest `*_tally.xml` in Downloads.
* ManuFlow only offers it as a download. The server never runs it and never contacts Tally to import anything.
* The XML, JSON and Excel downloads do not contact Tally. The XML and masters files change Tally only when a person
  imports them, by this script or from Tally's own import screen.
* **Mark as sent to Tally** only updates the invoice in ManuFlow. It is a person's note: nothing checks Tally.
* Purchase bills have no route to Tally.

`tests/tally-read-only.test.ts` fails if this exception grows: another script in `public/`, a connector or server path
to it, or this warning being removed.

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

1. **Connect Tally** (automatic connection: see "Automatic connection" below)
   * A progress bar (Connector → TallyPrime → Companies) and the state in words: Detecting connector, Device
     authorization required, Connecting to Tally, Tally not reachable, Connector offline, Authentication failed,
     Connector update required, Connected, Fetching companies, Companies available, Retry available.
   * Offers Connect Tally (first time), New code / Pair again (only while pairing or after "Authentication failed"),
     Pair another computer (secondary) and Disconnect, and shows the last check-in, the last successful Tally contact
     and the device (computer name, platform, connector version, Tally address).
   * "Next" works only when the connector is online **and** TallyPrime answers.
   * Whenever the connector is connected the dialog moves on to step 2 by itself, also when the connection is made
     while step 1 is open (not after the user went back to step 1).
   * On the later steps the connection is checked every 10 s, and a warning is shown when it drops.
2. **Choose company** — job `list-companies`, started by the dialog itself (with `reuse: true`: a list read in the
   last 20 s is reused); Tally's real list (only companies open in TallyPrime), with GUIDs, repeats removed; search
   when more than 6, 50 at a time, Refresh (always a new read) keeps a still-valid choice. Empty list → "No company is
   open in TallyPrime". Two open companies with the same name (different or missing GUIDs) are shown and cannot be chosen
   (Tally's requests select a company by name). A failed read is retried by itself when the connection comes back, or
   with "Try again". Nothing is read from a company until it is chosen.
3. **Select data** — Customers, Suppliers, Stock items, each selectable or all with "Select all", plus the item type.
   Tally does not have an item type, so it is required and never guessed. Other parts of this step:
   * **Change company** goes back to step 2.
   * The **period** (current financial year, last financial year, all data, custom range) is shown but disabled:
     it applies to vouchers, which are not built yet.
   * **29 other kinds of data** (ledgers, groups, vouchers, stock, balances…) are listed as disabled
     "not available yet" items.
4. **Review & import** — reads the chosen data (jobs `export-customers` / `export-suppliers` / `export-items`), runs
   the normal Import Center **preview** on it in 500-row batches, sorted into new, already in ManuFlow and need
   attention. Nothing is saved yet. Then:
   * **Import data** asks for an explicit confirmation first.
   * It imports batch by batch. Progress shows the percentage (never 100 % before the end), processed / remaining /
     imported / skipped / not imported, and the elapsed time, all from the server's batch results.
   * "Stop after this part" and **Continue import** let a stopped or failed import go on; finished parts are skipped
     as duplicates.
   * A list and CSV show the rows not imported, and each batch gets one Import History entry. Running it again skips what was
   imported (the services' duplicate rules), so a retry / double click creates no duplicates.

Records go through `src/lib/tally/to-import.ts` → `runImport()` (the same validation and import services as an
uploaded file). Tally's GUID is not stored (no column); opening balances and opening stock are not imported.

### Flow

```
Connector (before pairing, optional) ── check --server ─► POST /api/tally-connector/ping → { service, minVersion, latestVersion }
Admin in ManuFlow ──"Connect Tally"──► POST /api/import-center/tally/connector  → code ABCDE-FGHJK (10 min, once)
Connector (office PC) ── pair --code ─► POST /api/tally-connector/pair { code, version, platform, deviceId, deviceName }
                                                                                 → token (once, stored hashed, bound to deviceId)
Connector every 5–30 s: POST <tally 127.0.0.1:9000> fixed health request (read-only)
                       POST /api/tally-connector/heartbeat (Bearer token) { version, platform, deviceId, deviceName,
                                                                            tally: { status, latencyMs, endpoint } }
                                       ← { nextHeartbeatSec, minVersion, latestVersion, job?: { id, type: one of the fixed names, company? }, newToken? }
When a job comes: POST <tally> the connector's own fixed Export XML for that name → POST /api/tally-connector/result
                  { jobId, ok, records | error code }
Browser: POST/GET/DELETE /api/import-center/tally/jobs (queue / poll / cancel) → POST /api/import-center/tally/import
         { jobId, dataType, mode: preview | commit, batch } (Tally data stays on the server)
Admin ──"Disconnect"──► DELETE /api/import-center/tally/connector → token revoked → next heartbeat 401
                                                                    CONNECTOR_REVOKED → connector deletes its settings and stops
```

| Piece | File |
|---|---|
| Server logic (codes, tokens, rotation, heartbeat, status, rate limits, cleanup) | `src/lib/tally/connector.ts` |
| Jobs and their records | `src/lib/tally/jobs.ts` |
| Tables | `TallyPairingCode`, `TallyConnector`, `TallyJob`, `TallyJobChunk`, `TallyRateLimit` in `prisma/schema.prisma` |
| Admin routes (GET status, POST code, DELETE disconnect) | `src/app/api/import-center/tally/connector/route.ts` |
| Connector routes (no session; public in `src/middleware.ts`) | `src/app/api/tally-connector/{pair,heartbeat,result,ping}/route.ts` |
| Connector program | `connector/tally/manuflow-tally-connector.mjs` |
| Windows install / removal | `connector/tally/windows/{install,uninstall}-connector.ps1`, guide `docs/tally-connector-windows.md` |
| UI | `src/components/erp/import-center/tally-connector-panel.tsx`, `tally-import.tsx`; states: `src/lib/tally/flow.ts` |
| Tests | `tests/tally-connector.test.ts`, `tally-import.test.ts`, `tally-read-only.test.ts`, `tally-persistence.test.ts`, `tally-autoconnect.test.ts` |

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
  control characters removed; malformed data fails the job. The records are saved in chunks of 500 together with the
  job's "done" status (one transaction); a result for a job that is no longer running for that connector is dropped.
  Exports need the same write right as the import (customers / suppliers / items).
- **Pairing code:** 10 characters (31-symbol alphabet, ~49 bits), 10 minutes, single use, SHA-256 hash only, one open
  code per company, shown once, never returned by the status endpoint. Wrong codes: 10 per IP per 15 min, then 429.
  Codes: 10 per company per hour. Both limits are rows in `TallyRateLimit` (the IP is stored only as a SHA-256 hash),
  so they hold across restarts and server processes.
- **Connector token:** `mftc_<24 hex id>_<32 random bytes>`; only its SHA-256 is kept, compared in constant time;
  returned once. Pairing again revokes the previous connector; Disconnect revokes at once. `CONNECTOR_REVOKED` is only
  sent to a request that proved it holds the token (anyone else gets `CONNECTOR_UNAUTHORIZED`).
- **Token rotation (two-step) and recovery:**
  * 7 days after pairing, or after the last rotation, the heartbeat reply carries `newToken` once. The connector saves
    it by writing a temporary file and renaming it (mode 0600).
  * The server keeps the previous secret's hash as the connector's way back. The first request with the new token
    clears it, which is normally the next heartbeat, seconds later.
  * If the reply was lost, or the connector was offline, the connector comes back with the previous token. It is
    accepted and the connector gets a fresh token, but only until **30 days after the rotation**
    (`TOKEN_RECOVERY_MS`). That limit is set once when the token is rotated and is never extended.
  * After that limit the answer is `401 CONNECTOR_TOKEN_EXPIRED`, sent only to a request that proves it holds the
    token. The connector keeps the token, tells the user to pair again, and retries slowly.
  * No secret is usable for more than 37 days: 7 days until rotation plus 30 days of recovery. A revoked connector
    cannot use the way back.
  * `tests/tally-persistence.test.ts` covers a lost reply, a 20-day outage, the 30-day limit, revocation and the
    connector's behaviour.
- **What the 30-day recovery window means for security** (approved 2026-11-03):
  * **The exposure.** Someone who copied a connector's token before a rotation, and who uses it while the real
    connector is offline, can keep using that copy for up to 30 days after the rotation. Each use hands them a fresh
    token. That is no worse than a token that was never rotated, and it is capped: no secret works more than 37 days
    after it was issued.
  * **The real connector's next contact ends it.** When the real connector comes back with its new token, the
    previous secret is cleared and the copy stops working. If both sides use the same old token, each use replaces the
    other's new token. The connector then shows as flapping or failing in ManuFlow (last check-in, device and version
    are shown), which is the signal to act.
  * **Revocation is immediate and always wins.** **Disconnect** in ManuFlow ends every token of that connector at once:
    current, previous and recovery. The revocation check runs before the recovery path, so a revoked connector can
    never recover. This is tested.
  * **Nothing is weakened for guessing.** The recovery path needs the exact 32-byte secret, compared by hash in
    constant time. A wrong or forged token gets the same `CONNECTOR_UNAUTHORIZED` as an unknown one.
  * **What to do if a token may have leaked:** click Disconnect, then pair again with a new code.
- **Device binding (0.3.0):** the connector makes a random 128-bit device id once (kept in its settings, never derived
  from the hardware) and sends it with the pairing and every heartbeat. The token works only with that id; another id
  or none gets `401 CONNECTOR_DEVICE_MISMATCH`, and the company's admins see "Authentication failed: different
  computer". A connector paired before 0.3.0 is bound to the first id it reports. The id is not a secret: it protects
  against a token leaked on its own (logs, screenshots), not against a copy of the whole settings file. It never
  touches another company's connectors: a device id claimed by a pairing in company B changes nothing in company A.
- **Recorded authentication failures:** `authFailure` / `authFailedAt` are written only for requests that proved the
  token (expired token, device mismatch), never for unknown or forged tokens, and are cleared by the next good
  heartbeat.
- **Versions:** `CONNECTOR_MIN_VERSION` / `CONNECTOR_LATEST_VERSION` in `connector.ts`. A connector below the minimum
  keeps its heartbeat (so its state is visible) but gets no job, and job creation answers `409 CONNECTOR_OUTDATED`.
  Only a well-formed `x.y.z` version is judged.
- **One running copy:** `run` holds `<settings>.lock` (touched every heartbeat; a lock whose process is gone or that is
  older than 10 minutes is taken over). A second copy exits with code 3.
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

### Automatic connection (Phases H–N)

**First time on a computer** an administrator creates a one-time code and the connector is paired with it (on Windows by
`install-connector.ps1`, which also makes it start with Windows). That pairing is the device authorisation; there is no
second registration flow and no network discovery. **Afterwards everything is automatic:** the connector keeps its token
and device id, checks in every 5–30 s (every 5 s while someone has the Tally screen open), retries with waits of 15 s
doubling to 5 minutes, takes over a stale lock after a crash, renews its token, and picks up a changed Tally address
(`set-tally`) without a restart. The Import from Tally dialog "detects" the connector by asking the server for the
company's connector status, moves on to the company list by itself, fetches it, and shows the companies.

| Server state (`ConnectorStatus.state`) | Screen state (`src/lib/tally/flow.ts`) | When |
|---|---|---|
| — (status not loaded yet) | Detecting connector | dialog just opened |
| `unavailable` | Connector not available | `TALLY_CONNECTOR_POC` off |
| `not_paired`, `pairing` | Device authorization required | no active connector / a code is open |
| `auth_failed` | Authentication failed | last refused request (proved token) is newer than the last check-in: `token_expired` or `device_mismatch` |
| `connecting` | Connecting to Tally | paired, no check-in yet |
| `reconnecting`, `offline` | Connector offline | silent > 90 s (retrying) / > 6 min |
| `outdated` | Connector update required | reported version < `CONNECTOR_MIN_VERSION` |
| `tally_error` | Tally not reachable | connector online, its last Tally check failed |
| `connected` | Connected → Fetching companies → Companies available / No company open in Tally / Retry available | the company list read |

API additions: `POST /api/tally-connector/ping` (public, no data); `deviceId` / `deviceName` on pair and heartbeat;
`minVersion` / `latestVersion` in the heartbeat reply; `reuse: true` on `POST /api/import-center/tally/jobs` for
`list-companies`; error codes `CONNECTOR_DEVICE_MISMATCH`, `CONNECTOR_OUTDATED`, `TALLY_COMPANY_AMBIGUOUS`. Job creation
is serialised per connector (row lock), so simultaneous requests from several tabs give one job.

**Not verified yet:** the Windows scripts (not run on Windows), the automatic flow against a real TallyPrime and a real
server, and whether TallyPrime returns `GUID` for the `Company` collection (the reader treats it as optional; without
it, two same-name companies are both shown as ambiguous and cannot be chosen).

### Storage (survives restarts)

| Table | Holds | Kept |
|---|---|---|
| `TallyPairingCode` | SHA-256 of each code, company, expiry, `usedAt` (single use: `UPDATE … WHERE usedAt IS NULL`) | until 24 h after expiry |
| `TallyConnector` | connector id, company, `activeFor` (unique → one active connector per company), current and previous secret hashes, last check-in | always (revoked ones as history) |
| `TallyJob` | named job, status, attempt, lease, error, record count | 30 days |
| `TallyJobChunk` | the records a job read, ≤ 500 per row, in order | 24 h |
| `TallyRateLimit` | fixed-window counters (wrong codes per IP hash, codes per company) | 2 h after the last hit |

* **Restarts:** nothing lives in process memory any more, so a server restart, deploy or PM2 restart keeps the pairing.
  The connector keeps its token through network errors, timeouts, 5xx and odd replies (it retries after 15 s, 30 s, …
  up to 5 min) and reconnects by itself. Only `CONNECTOR_REVOKED` makes it delete the token.
* **Jobs across processes:** a job is handed out with `UPDATE … WHERE status = 'queued'` (one winner). A job taken but
  not answered within 3 minutes (crash, restart, Tally hung) is queued once more, then failed with `timeout`.
* **Cleanup** (`cleanupTallyTables()`, at most every 10 minutes per process, on code creation and heartbeats) deletes
  expired rows of these five tables only. `tests/tally-persistence.test.ts` checks that every delete in the connector
  code targets a Tally table, that the only raw SQL is the rate-limit upsert, and that the rest of the database is
  unchanged by a whole connector lifecycle.

* **Connection states shown in ManuFlow:**

  | State | Meaning |
  |---|---|
  | Connected | Checked in within 90 s and Tally answers. |
  | Connector online · Tally not reachable | Checked in, but TallyPrime does not answer. |
  | Reconnecting… | Silent for 90 s to 6 min. The connector retries at least every 5 minutes after an interruption. |
  | Connector offline | Silent for longer than 6 minutes. |
  | Not connected / Waiting for pairing | No connector is paired yet, or a pairing code is waiting to be used. |

* **Starting with the computer:** `docs/tally-connector-startup.md` covers a systemd user service and Windows Task
  Scheduler. These are templates only; nothing is installed automatically.
* **Checking against a real TallyPrime:** `docs/tally-real-validation-plan.md` is the plan; it has not been run.

### Masters source copy and Tally GUIDs (Phase E)

**What has been checked against a real TallyPrime.** One TallyPrime company was captured on 2026-11-03: its company
list, customers, suppliers and stock items (1, 1 and 3 records). Anonymised copies of those replies are the fixtures in
`tests/fixtures/tally/real-20261103/`. They are **not committed yet**: they wait for review. What they confirmed:

* **Reply layout:** `ENVELOPE/HEADER(VERSION, STATUS)/BODY/{DESC, DATA/COLLECTION}`, in UTF-8. Records are direct
  children of `COLLECTION`.
* **`BODY/DESC/CMPINFO` uses the same tag names as real records** (`LEDGER`, `STOCKITEM`, …) for its counts. The
  readers now read **only `BODY/DATA/COLLECTION`**.
* **Built-in names arrive with a hidden control character**, for example `&#4; Primary`. The readers drop it. Tally's
  root stock group `Primary` means "no group", so items under it get no category in ManuFlow.
* **Field paths match the readers:** GST registration type, state, unit and GST rate were read from the places the
  readers use. GSTIN, address, pincode and HSN were empty in that company, so reading filled-in values of those is
  still unverified.

**Five more fixed, read-only master requests** (`export-groups`, `export-ledgers`, `export-stockgroups`,
`export-units`, `export-godowns`), and `ALTERID` on every master. **None of these has been run against a real
TallyPrime yet.**

**Layer 1 (`TallySourceMaster`, `src/lib/tally/layer1.ts`):**
* Every finished master export is copied here, one row per Tally GUID per Tally company. Customers and suppliers are
  stored as ledgers.
* Reading again updates the row: name, parent and ALTERID, with the fields read merged into `data`.
* After a **full** read of a kind, rows that read no longer contains get `missingSince`; a later read clears it.
  Customers and suppliers are only part of the ledgers, so they never mark anything missing.
* Problems are kept with the record in `issues`: no GUID (the record is then keyed by name), an ALTERID that is not a
  number, or an opening balance that is not a plain signed amount. `Dr` / `Cr` text is not guessed at.
* Opening balances are also kept in paise, with the sign exactly as Tally wrote it.
* **Rows are never deleted,** automatically or otherwise.
* Nothing in Layer 1 reads or writes a business table.
* A staging failure does not undo the read. Reading again stages it again, because staging is idempotent.

**Tally GUIDs (`TallyMasterLink`, `src/lib/tally/links.ts`):**
* When customers, suppliers or items are imported, each new ManuFlow record is linked to its Tally GUID. The
  Customer, Supplier and Item tables are only read: to find the new record by its code, and to check that a linked
  record still exists.
* A record whose GUID is already linked to an existing record is shown as a duplicate ("same Tally GUID") and not
  imported again, even if it was renamed in Tally.
* Links are history and are never deleted. A link whose record no longer exists is ignored.
* Neither `TallySourceMaster` nor `TallyMasterLink` is part of company backups (`src/lib/backup-plan.ts`).

**Not built yet:**
* The new master kinds are not offered in the UI, and nothing imports groups, ledgers, units or godowns into ManuFlow
  modules.
* There is no screen for Layer 1.
* Opening balances are stored but not used.

### Periods (Phase D): `src/lib/tally/period.ts`

| Choice | Covers |
|---|---|
| Current financial year | The year containing today (India time), starting no earlier than the books |
| Last financial year | The year before it. Refused when the books begin after it ended. |
| All data | From the start of the books (Tally's `BOOKSFROM`) to the end of the current financial year: every year, not just the current one. Refused (never guessed) when Tally does not report `BOOKSFROM`. |
| Custom range | Any valid range up to the end of the current financial year. A start before the books moves to the start of the books, and the period says so. |

* **Where the dates come from:** the financial year start comes from Tally's `STARTINGFROM`. When Tally does not report
  it, 1 April is assumed, and the period says so. Both dates come from Tally's own latest company list, held on the
  server, never from the browser.
* **Splitting:** a period is split into its financial years and calendar months, so vouchers can later be read one
  month at a time.
* **Endpoint:** `GET /api/import-center/tally/period` returns what each choice covers for a Tally company, and checks
  a custom range.
* **In the UI:** the "Select data" step shows those dates. **The choices stay disabled**, because only vouchers carry
  dates and vouchers cannot be read yet. Masters are always read as they are in Tally today.
* **Not built:** jobs do not carry a period yet. That needs two date columns on `TallyJob`, which is a schema change
  for Phase F.

### Read-only: nothing writes to Tally

The connector is strictly **TallyPrime → ManuFlow**. The earlier push of sales invoices and purchase bills was removed:
there is no push endpoint, job type, menu item or switch, and `TALLY_CONNECTOR_PUSH` does nothing.

* Every request from the connector goes through `postToTally()`, which refuses anything but a single
  `TALLYREQUEST=Export` envelope with no voucher, `ACTION` attribute or DTD (`isExportRequest()`).
* A job with any other name is refused without contacting Tally; XML sent along with a job is ignored.
* `tests/tally-read-only.test.ts` proves this against a hostile server and fails if a write path comes back.
* A connector copy from before this change still contains the old push code. Replace any such copy.

The manual downloads are a separate route, described at the top of this document.

### Known limitations of the proof of concept

1. **Production still runs the in-memory version** until this is deployed (separate approval): the five tables must be
   created there first (additive `CREATE TABLE` only). Until then a production restart still drops the pairing.
2. **A connector offline for more than 30 days right after a lost rotation reply** must be paired again
   (`CONNECTOR_TOKEN_EXPIRED`). Any shorter outage recovers by itself.
3. **IP for rate limiting** comes from `X-Forwarded-For` — correct only behind the CloudPanel proxy that sets it.
4. **Token at rest on the PC** is protected by file permissions only; Windows DPAPI / macOS Keychain would be better.
5. **No signed installer / download.** Customers would need Node.js and the `.mjs` file; an installer (signed
   Windows build, run as a service) is still to do.
6. **Masters only.** Vouchers etc. need accounting decisions and a schema change (Tally GUID per record) first.
7. **Unverified against real TallyPrime:** the company-list / ledger / stock-item export XML, and the reply fields
   read (`PARTYGSTIN` vs `LEDGSTREGDETAILS.LIST`, `LEDMAILINGDETAILS.LIST`, `GSTDETAILS.LIST/RATEDETAILS.LIST`, …).
   Capture real replies from at least two TallyPrime releases before relying on it.

### Production would additionally need

- The five Tally tables (see "Storage" above) created on the production database before the code is deployed.
- A database lock instead of the per-process import lock, if more than one app process runs.
- Optionally a `tallyGuid` column on customers / suppliers / items for stable re-import matching.

## Next steps

1. Install TallyPrime (education / trial mode is enough) and capture real replies: company list,
   List of Accounts / ledgers with groups, stock items with units and GST details — across at least
   two TallyPrime releases. Store them as anonymised test fixtures.
2. Write and test the Tally XML → row mappers against those fixtures (Sundry Debtors → customers,
   Sundry Creditors → suppliers, stock items → items; units mapped to ManuFlow UOMs explicitly).
3. Deploy the database-backed store (Phase B, built locally): create the five tables on production first, never with
   data-loss flags.
4. Build and sign the connector app; document firewall settings (port 9000 reachable from
   127.0.0.1 only).
5. Reading vouchers from Tally needs the accounting decisions listed in the Smart Import audit (no general ledger,
   document numbering, bill-wise outstanding, go-live date).
