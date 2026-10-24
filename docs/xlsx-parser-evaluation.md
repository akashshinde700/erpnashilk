# XLSX parser evaluation (Smart Import, Phase 0)

Status: **decided in Phase 1 — SheetJS `xlsx` 0.20.3 from the SheetJS CDN, installed.** (Phase 0 evaluation below.)

## Decision (Phase 1, 2026-10-24)

- `package.json`: `"xlsx": "https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz"`, pinned in `bun.lock` with
  its sha512 integrity. Tarball checked before installing: version 0.20.3, Apache-2.0, **no dependencies, no
  install scripts**; sha256 `8dc73fc3b00203e72d176e85b50938627c7b086e607c682e8d3c22c02bb99fe8`.
- Replaces npm `xlsx@0.18.5`, removing its two **high** advisories (prototype pollution GHSA-4r6h-8v6p-xvw6,
  ReDoS GHSA-5pgg-2g8v-p4x9). The existing export helper (`downloadXlsx` in kit.tsx) uses the same API.
- Not ExcelJS: no release since Oct 2023, 193-package tree with deprecated parts, no `.xls`.
- `bun install --frozen-lockfile` now passes (the lockfile previously missed `qrcode` / `@types/qrcode`).
- Hardening around the parser (`src/lib/import/parse-file.ts`): server-side only; 2 MB upload cap; the ZIP
  is walked and every entry inflated with a 40 MB total cap **before** SheetJS reads it (zip bombs, including
  lying sizes); `sheetRows` cap; formulas / HTML / styles / VBA off; `.xls` (OLE) refused for now — SheetJS
  could read it, but it is not tested here yet.
- Trade-offs to keep in mind: the CDN is outside the npm registry, so `npm audit` / Dependabot do not track
  it — check https://cdn.sheetjs.com and its advisories when upgrading. The deploy server runs `npm install`,
  so it needs outbound HTTPS to `cdn.sheetjs.com` (or vendor the tarball and add its folder to `deploy.py`).

Evaluated: 2026-10-24. Sources: npm registry metadata (`npm view`), `npm audit` on a lockfile-only
resolution of each package in an isolated directory (GitHub Advisory Database), GitHub / GitLab
public APIs for repository activity, the SheetJS CDN for its current version.

## What Smart Import needs from the parser

- Read **untrusted uploads on the server** (`.xlsx`; `.xls` is likely for Tally/Vyapar exports — not yet verified with real samples).
- Bounded memory/time: reject huge sheets, zip bombs, and pathological cell content before parsing the whole file.
- Cell values as plain strings/numbers/dates; formulas never evaluated; prototype-safe objects.
- Keep working with the existing **export** helper (`src/components/erp/kit.tsx`, currently `xlsx@0.18.5`).

## Candidates

| | ExcelJS 4.4.0 | SheetJS `xlsx` 0.18.5 (current dep) | SheetJS `xlsx` 0.20.3 (CDN) | read-excel-file 9.3.12 |
|---|---|---|---|---|
| Last release | 2023-10-19 (3 years ago) | 2022 (last on npm) | current CDN release | 2026-10-07 |
| Repo activity | last commit on default branch 2024-01-12; 819 open issues; not archived | npm line frozen | maintained (CDN distribution only) | active (GitLab, last activity 2026-10-20); single maintainer, ~80 stars |
| License | MIT | Apache-2.0 | Apache-2.0 | MIT |
| Transitive packages | 193 | 9 | (self-contained) | 7 |
| Unpacked size | 21.8 MB | — | — | 2.7 MB |
| `npm audit` | 2 moderate: `uuid` < 11.1.1 missing buffer bounds check ([GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq)), reported against exceljs via uuid@8.3.2 | **2 high**: prototype pollution ([GHSA-4r6h-8v6p-xvw6](https://github.com/advisories/GHSA-4r6h-8v6p-xvw6), fixed 0.19.3), ReDoS ([GHSA-5pgg-2g8v-p4x9](https://github.com/advisories/GHSA-5pgg-2g8v-p4x9), fixed 0.20.2) | both fixed (≥ 0.20.2) — not in the npm registry, so `npm audit` cannot see it | 0 |
| Deprecated deps | fstream 1.0.12, glob 7.2.3, inflight 1.0.6, rimraf 2.7.1, uuid 8.3.2, lodash.isequal | — | — | — |
| Formats | xlsx, csv | xlsx, xls, ods, csv… | xlsx, **xls**, ods, csv… | xlsx only |
| Install source | npm | npm | tarball URL from cdn.sheetjs.com (pin + integrity in bun.lock) | npm |

### ExcelJS — findings

- **Maintenance is the main problem.** No release for three years and no commits since January 2024, with 800+ open issues. Fixes for future advisories in its tree (zip handling via `unzipper`/`jszip`, temp files via `tmp`, XML via `saxes`) would depend on transitive version ranges, not on an active upstream.
- Current advisory exposure is low in practice. The `uuid` issue only triggers when a caller passes its own output buffer, which the parser path does not do. But it is still an open item an audit will flag.
- It brings a large, partly deprecated dependency tree (193 packages, `fstream`/`rimraf@2`/`glob@7`/`inflight`), and it is .xlsx-only. A Tally/Vyapar `.xls` export could not be read.
- It is compatible with Node 20 / Bun 1.4 and Next 16 server routes (CommonJS, Node streams). There is no technical blocker, only the risk profile.

### SheetJS 0.20.3 (CDN) — findings

- It is the same library the app already uses for export, so it fixes the two **high** advisories in the current dependency and adds parsing with one dependency instead of two.
- It reads legacy `.xls`, which may matter for real Tally/Vyapar exports (to be confirmed with samples).
- **Trade-off:** it is distributed only from `cdn.sheetjs.com`, not the npm registry. The dependency is a pinned tarball URL (with bun.lock integrity), and `npm audit` will not track it, so advisories must be watched manually. Some corporate networks or CI setups block non-registry tarballs.
- Parse options needed for safety: `cellFormula: false`, `cellHTML: false`, `sheetRows` cap, read from a `Buffer` with an upload-size cap, and plain-object rows checked for `__proto__`/`constructor` keys.

### read-excel-file — findings

- Small, current, and no advisories. But it is .xlsx-only, has a single maintainer and low adoption, so the "bus factor" is a risk of its own.

## Recommendation

1. **Do not adopt ExcelJS** for Smart Import parsing. It is unmaintained (last release Oct 2023) and has a large deprecated dependency tree. The current advisory is moderate, but the maintenance trend is the deciding factor.
2. **Preferred: move `xlsx` from npm 0.18.5 to the SheetJS 0.20.3 CDN tarball**, pinned. This removes the two high advisories in the existing dependency and serves both export and import, including `.xls`. Accept manual advisory tracking.
3. **Fallback if non-registry tarballs are not acceptable:** `read-excel-file` for `.xlsx` parsing. Keep `xlsx` only for export until it can be replaced. `.xls` uploads would then be rejected with a "save as .xlsx" message.
4. **Whichever is chosen:** parse only on the server, enforce size/row/cell limits before and during parsing, never evaluate formulas, and treat the parser as replaceable behind `src/lib/import/parse/xlsx.ts` (Phase 1).

Before installing anything: re-run `npm audit` / check the SheetJS changelog on the day of the change, and verify `kit.tsx` export (`aoa_to_sheet`, `book_new`, `book_append_sheet`, `writeFile`) still behaves the same with the chosen version.
