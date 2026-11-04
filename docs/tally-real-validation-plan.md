# Checking the connector against a real TallyPrime

Status: **the tools are built and tested against a mock Tally only. Nothing has been run against a real TallyPrime.**
The gates marked ⛔ each need the data owner's separate, explicit approval, given for that exact run.

## Why

The connector's read requests, and the reply fields it reads, have only been tested against replies we wrote ourselves.
Only the connectivity check has run against a real TallyPrime (`10.248.233.150:9000`, from the Linux connector laptop,
2026-11-03). Until real replies are captured and compared with Tally's own screens, imported masters cannot be called
correct, and vouchers cannot be designed.

## The tools

| Tool | What it does | What it never does |
|---|---|---|
| `connector/tally/manuflow-tally-connector.mjs capture` | Sends the connector's existing fixed Export requests through the same read-only guard as the jobs. Saves Tally's raw replies byte for byte, plus `manifest.json`: time, connector version, Tally address, company, and per file the size, record count or error. | Contact ManuFlow, read the saved token or settings, write inside a Git working tree, or reuse a folder that is not empty. |
| `scripts/tally-fixtures/anonymise.mjs` | Replaces identifying values with consistent fakes, then checks the result before writing anything. | Write or print an original value, or the original → fake map. |

Tests: `tests/tally-capture.test.ts` (mock Tally, made-up data).

## Exact export requests

These are the same four fixed requests the connector already uses (`JOBS` in the connector). Each is
`TALLYREQUEST=Export`, `TYPE=Collection`, with an inline read-only collection (`ISMODIFY="No"`).

| File | Collection | Type | Filter | Fields |
|---|---|---|---|---|
| `list-companies.xml` | `ManuFlowCompanies` | Company | none | NAME, STARTINGFROM, BOOKSFROM |
| `export-customers.xml` | `ManuFlowDebtors` | Ledger | child of `$$GroupSundryDebtors` | NAME, GUID, PARENT, PARTYGSTIN, GSTREGISTRATIONTYPE, INCOMETAXNUMBER, LEDSTATENAME, PINCODE, ADDRESS, LEDGERPHONE, LEDGERMOBILE, EMAIL, LEDGERCONTACT, LEDGSTREGDETAILS, LEDMAILINGDETAILS |
| `export-suppliers.xml` | `ManuFlowCreditors` | Ledger | child of `$$GroupSundryCreditors` | same as customers |
| `export-items.xml` | `ManuFlowStockItems` | StockItem | none | NAME, GUID, PARENT, BASEUNITS, HSNCODE, GSTDETAILS, HSNDETAILS |

The company requests carry `SVCURRENTCOMPANY` = the chosen company name, XML-escaped. No voucher, balance or
date-filtered request exists yet. Those will get their own reviewed requests and their own approval.

## Procedure

Run on the connector laptop, as its normal user, from the repository folder. The `--tally` address is always typed
explicitly.

### Step 0: before (no Tally contact)

```bash
node connector/tally/manuflow-tally-connector.mjs check --tally http://10.248.233.150:9000   # health request only
mkdir -p -m 700 ~/manuflow-tally-captures                                                    # outside Git
```

Also write down the TallyPrime release (Help → About in TallyPrime) for the folder names below.

### Step 1 ⛔: company selection (reads the company list only)

```bash
node connector/tally/manuflow-tally-connector.mjs capture \
  --tally http://10.248.233.150:9000 \
  --out ~/manuflow-tally-captures/$(date +%Y%m%d)-<release>-companies
```

It prints the companies open in TallyPrime, numbered, and saves only `list-companies.xml` and `manifest.json`. The data
owner chooses **one** company and confirms its exact name in writing. A trial or education copy is preferred.

### Step 2 ⛔: capture that company's masters

```bash
node connector/tally/manuflow-tally-connector.mjs capture \
  --tally http://10.248.233.150:9000 \
  --company "<exact name from step 1>" \
  --out ~/manuflow-tally-captures/$(date +%Y%m%d)-<release>-masters
sha256sum ~/manuflow-tally-captures/*-masters/*.xml > ~/manuflow-tally-captures/$(date +%Y%m%d)-masters.sha256
```

The company must be in Tally's own list, or the command stops before any company export. The output folder must be
new, and must be outside any Git working tree.

### Step 3: compare with Tally's own screens (no Tally writes; viewing reports only)

* **Counts:** the number of records in `manifest.json` equals Tally's count for Sundry Debtors and Sundry Creditors
  (List of Accounts) and for stock items (List of Stock Items).
* **Spot checks:** for 10 random records of each kind, compare name, GSTIN, GST registration type, PAN, state, pincode
  and address. For stock items, compare unit, HSN and GST rate. A field Tally leaves empty must stay empty.
* **Record the result** next to the capture (counts, any mismatches). Every difference from the mock replies becomes a
  reader fix with a test. The read-only guard is never changed for this.

### Step 4: anonymise (on the laptop, output still outside Git)

```bash
node scripts/tally-fixtures/anonymise.mjs \
  ~/manuflow-tally-captures/<date>-<release>-masters \
  ~/manuflow-tally-captures/<date>-<release>-anonymised
```

**Replaced, with consistent fakes:**

| Data | Replacement |
|---|---|
| Names: company, ledgers, items, groups the company created, categories | `Name 0001`, … |
| Contact person | `Person 0001` |
| Address | `Address line 0001` |
| E-mail | `contact0001@example.test` |
| Phone | `90000…` |
| Pincode | First 2 digits kept |
| GSTIN | State code kept; the rest fake |
| PAN | Fake |
| Narration, bank name and branch | `Text 0001` |
| Account number, IFSC | Fake |
| GUIDs | The UUID part is replaced; the object number is kept |

The same value gets the same fake in every file, so a party that is both a customer and a supplier still matches.
Fakes are numbered, never hashed from the original, because a hashed GSTIN could be reversed by trying every
possibility.

**Kept:** tags, nesting and attributes other than `NAME`; Tally's predefined group names (Sundry Debtors, …); units;
HSN codes; GST rates; dates; and the encoding (UTF-8 or UTF-16, with or without a byte-order mark).

**Checked before anything is written:**
* every original value is gone,
* every GSTIN, PAN, e-mail and 10-digit phone number left is a generated fake,
* the tag sequence of each file is identical to the raw reply.

On any problem it writes nothing and reports only the kind of problem, never the value.

### Step 5: review the fixtures (before any commit)

1. Read the anonymiser's report: files, encodings, structure identical, counts replaced by kind, leak check passed.
2. The data owner opens each anonymised file and confirms nothing identifies the business. Watch especially for free
   text in tags the anonymiser does not know, such as custom UDF fields.
3. Search for the company's real name and two or three real party names in the anonymised folder; there must be no
   hits:

   ```bash
   grep -ril "<real name>" ~/manuflow-tally-captures/<date>-<release>-anonymised
   ```
4. Run the fixture tests against them locally, from a copy outside Git.

### Step 6 ⛔: commit the fixtures

Only after the review in Step 5. Copy the anonymised files to `tests/fixtures/tally/<release>/` and add fixture tests,
then commit with the owner's approval. Before committing, check that no raw capture is in Git:
`git ls-files | grep -i capture`, plus the grep for real names.

### Step 7 ⛔: delete the raw captures

When the fixtures are accepted, delete the raw folders (`~/manuflow-tally-captures/*-companies`, `*-masters`). This
needs the owner's explicit approval at that time.

## Acceptance

For each TallyPrime release tried:

* Record counts read through the connector equal Tally's own lists for the same company.
* The spot checks match field by field. Nothing is guessed for an empty field.
* Fixture tests pass, including UTF-16 if that is what Tally sent.
* The read-only tests still pass.
* No raw capture is in Git.

## Later (separate design and approval)

* **Phase E master readers** (groups, ledgers, stock groups, units, godowns): new fixed Export requests, captured and
  checked the same way.
* **Vouchers:** fixed Export requests for one voucher type and one month, then reconciliation against the Day Book
  and the Trial Balance, in paise.

## Phase G: one month of vouchers (prepared, not run)

Status: **the tools are ready and tested against a mock Tally. Nothing has been sent to the real TallyPrime.**

| Tool | Where |
|---|---|
| Voucher reader | `readVoucher()` / `readVouchers()` in the connector |
| Capture command, voucher mode | `--vouchers-from` / `--vouchers-to` |
| Anonymiser, voucher fields | `scripts/tally-fixtures/anonymise.mjs` |

Tests: `tests/tally-voucher-capture.test.ts`.

**Request:** `voucherRequest(company, from, to)` sends one fixed `TALLYREQUEST=Export` of a `Voucher` collection
(`ISMODIFY="No"`). It sets `SVFROMDATE` / `SVTODATE` and uses a read-only date filter formula. It passes the unchanged
Export-only guard. For ABC Private Limited and October 2026, the request is 951 bytes.

**Command** ⛔ needs approval for the exact company and dates:

```bash
node connector/tally/manuflow-tally-connector.mjs capture --tally http://10.248.233.150:9000 \
  --company "ABC Private Limited" --vouchers-from 20261001 --vouchers-to 20261031 \
  --out ~/manuflow-tally-captures/$(date +%Y%m%d-%H%M%S)-vouchers-202610
```

* **What it reads:** the company list first, to confirm the company is open, then the single voucher request. Nothing
  else.
* **What it saves:** the raw reply byte for byte, plus `manifest.json` with the voucher count per voucher type. Folder
  mode 700, files 600, outside Git. It refuses a folder inside Git or one that is not empty, and never contacts
  ManuFlow.
* **Limits:** at most 64 MB and 120 s per reply. If either is exceeded, the capture fails and **nothing is retried
  automatically.**
* **If too large:** the agreed fallback is to split the same month into single days, with one approval covering those
  days. The day ranges are made by `splitSlice`.

**Expected reply:** `ENVELOPE/HEADER(STATUS)/BODY/{DESC/CMPINFO, DATA/COLLECTION/VOUCHER…}`, the same layout as the
master replies. Each `VOUCHER` is expected to carry the fetched fields:
* GUID, MASTERID, ALTERID, DATE, EFFECTIVEDATE, VOUCHERTYPENAME, VOUCHERNUMBER, REFERENCE / REFERENCEDATE,
  PARTYLEDGERNAME, NARRATION, ISCANCELLED, ISOPTIONAL, ISINVOICE, PLACEOFSUPPLY, PARTYGSTIN, GSTREGISTRATIONTYPE;
* ledger entries, with their bill allocations;
* inventory entries, with their batch and accounting allocations.

Whether they really are present, and filled, is exactly what this capture checks.

**Validation after the capture.** Nothing is staged into `manuflow_local`. Fixtures are staged only in the test
database.

1. **The request worked:** the reply has `STATUS 1` and every voucher's DATE is within the month. If any is outside,
   the date filter does not work as assumed.
2. **Counts:** vouchers per type compared with TallyPrime's Day Book for the month, which you read on the Tally PC.
3. **Fields:** for each voucher type present, which fields exist, which have values, and their exact text formats
   (amounts, quantities, rates, dates, bill fields).
4. **Signs:** the amount sign compared with `ISDEEMEDPOSITIVE`. Each voucher's total compared with the Day Book, and
   the month's ledger movements with the Trial Balance. **No sign meaning is assumed until this matches.**
5. **Problems:** unbalanced vouchers, cancelled and optional vouchers, and foreign-currency amounts, listed with their
   reasons.
6. **Anonymise:** names, GUIDs, voucher keys, GSTIN / PAN / contacts, addresses and narration are replaced. Voucher
   numbers, references and bill names share one mapping, so bills still match invoices. **Amounts, quantities, rates
   and dates are kept**, because reconciliation fixtures need them; this needs your confirmation. Then the leak check
   and structure check run, you review the result, and only then may fixtures be committed, after your approval.
