# Direct import from Tally — connector design

Status: **diagnostics only.** ManuFlow can check whether a configured TallyPrime XML server answers
(`GET /api/import-center/tally/status`). It does not list Tally companies or import data from Tally
yet. The Import Center shows "Not connected" until that check really succeeds.

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

## Proposed connector (next phase)

A small program installed on the Tally PC (Windows service / tray app):

1. **Outbound only.** The connector polls ManuFlow over HTTPS (`/api/tally-connector/...`, to be
   built); ManuFlow never connects inbound to the customer network. No port forwarding.
2. **Pairing.** A tenant admin creates a connector token in ManuFlow (per company, shown once, stored
   hashed, revocable, expiring). The token only authorises the connector endpoints for that company.
3. **Allow-listed requests.** ManuFlow can only ask for named jobs (e.g. "list companies",
   "export ledgers of company X", "export stock items"). The connector builds the Tally XML itself;
   ManuFlow never sends raw XML or URLs to execute.
4. **Local Tally access.** The connector talks to `http://127.0.0.1:9000` only (configurable port),
   with timeouts and size limits, and parses replies without DTD / external entities.
5. **Upload into the existing pipeline.** Exported rows are posted to ManuFlow and go through the same
   mapping → preview → explicit confirmation → import flow as file uploads (`src/lib/import/run.ts`,
   the shared customer / item import services). No direct database writes.
6. **Audit.** Pairing, each job and each import are written to the audit log.

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
5. Only after masters work: evaluate vouchers (sales / purchase / receipts / journals) — blocked on
   the accounting decisions listed in the Smart Import audit (no general ledger, document numbering,
   bill-wise outstanding, go-live date).
