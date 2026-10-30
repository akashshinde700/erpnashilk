# Mobile & PWA pass — 2026-10-30

Scope: make the existing ERP usable on a phone **without** forking it, without touching business
logic, print layouts, RBAC or the (emerald) brand. Desktop stays pixel-identical apart from the
fixes listed below.

## 1. Root causes found

| # | Root cause | Evidence |
|---|---|---|
| 1 | **No service worker and no registration** — a manifest alone is not installable and gives no offline page | `grep -r "serviceWorker\|register("` in `src/` returned nothing |
| 2 | **No `viewport-fit=cover` and no safe-area handling** — header/footer controls sat under the notch and the home indicator | `layout.tsx` viewport export had no `viewportFit`; no `env(safe-area-inset-*)` anywhere |
| 3 | **Shell heights were `100vh`** — on mobile the URL bar and the on-screen keyboard make `100vh` taller than the visible area | `min-h-screen` on the shell, `h-screen` on the rail, `100vh` on the public invoice page |
| 4 | **The mobile drawer was a hand-rolled overlay** — no focus trap, no Escape, no body scroll lock, no focus restore | `erp-app.tsx` overlay markup; `ui/sheet.tsx` existed but was unused |
| 5 | **Tables were always wide tables** — 36 `DataTable` usages, 28 with an actions column, all rendered as a horizontally scrolling grid on phones | `kit.tsx` `DataTable` had `hideOnMobile` but no mobile presentation |
| 6 | **Form controls were 12–14px and 36px tall** — iOS Safari zooms the page when a focused input is under 16px | `TextInput`/`NumberInput`/`DateInput` all `h-9` + `text-sm` |
| 7 | **No offline or connection status** — a dropped shop-floor Wi-Fi looked like the app had frozen | no online/offline listener in the shell |
| 8 | **Dashboard grid blowout** — a `1fr` track's automatic minimum is its widest child's min-content, so one nowrap amount inside a card widened the column to 348px on a 320px screen; Recharts also writes a measured pixel width onto its wrapper | found by the new viewport suite (320/360/375/390 all failed with 398px content) |

## 2. What changed

**Shell (`src/components/erp/erp-app.tsx`)**
- Drawer is a real modal surface: focus moves to the first control, Tab is trapped, Escape closes,
  the backdrop and a labelled close button dismiss it, focus returns to the hamburger, body scroll is
  locked while it is open, and selecting a module closes it (`goToModule`).
- Panel width `min(18rem, 85vw)`, safe-area padding, header `h-[calc(3.5rem+env(safe-area-inset-top))]`,
  footer `pb-safe`.
- Phone user menu carries the tenant switcher (the header picker is desktop-only) and the theme
  toggle (the header toggle starts at `sm`).
- Favorites pins and notification actions are visible without hover on touch screens.

**Tables (`src/components/erp/kit.tsx`)**
- `DataTable` renders **cards** below 768px: identifier first, then every non-`hideOnMobile` column as
  a label/value pair, row actions in the card header (click-isolated so an action never also opens the
  record), totals as a summary panel, and the same skeleton/empty/"no matches" states as the table.
  Cards are paginated 40 at a time on top of the module's own paging.
- `mobileView="scroll"` stays available per screen for numeric matrices where column alignment carries
  meaning (edge shadow via `scroll-shadow-x`).
- Desktop markup, sorting, filtering, saved views, export buttons and pagination are untouched.

**Forms and dialogs**
- 16px inputs and 44px control height below 768px (`globals.css`), larger checkboxes/radios,
  `max-h-[90dvh]` dialogs with a safe-area sticky footer, full-screen sheet behaviour on phones.

**PWA**
- `public/manifest.webmanifest`: `id`, `lang`, `dir`, `display_override`, `prefer_related_applications`,
  maskable icon, emerald `theme_color` (the repo's real brand — **not** violet).
- `public/sw.js`: cache-first only for content-hashed `/_next/static/**` and public icons/manifest;
  **`/api/**` is never intercepted or cached**; navigations are network-first and **not stored**
  (no stale-HTML window after a deploy, nothing that could be replayed); `/offline` fallback;
  `activate` deletes older `manuflow-*` caches; `SKIP_WAITING` message.
- `ServiceWorkerRegistrar` registers in production only and reloads once when a new worker takes
  control of an already-controlled page (never on the first install).
- `src/app/offline/page.tsx` — static fallback that says plainly that nothing is saved offline.
- `ConnectionStatus` banner: appears on disconnect, states that nothing is queued or saved, offers
  Retry. **No offline queue / replay of stock movements or invoices** — that needs an idempotent
  server-side sync design, which is out of scope by decision.

**Layout safety**
- `h-screen-safe` / `min-h-screen-safe` (100dvh with a 100vh fallback) on the shell, login, platform
  admin and the public invoice page.
- `grid-safe-1..6` = `repeat(N, minmax(0, 1fr))` for the dashboard grids, so one wide child cannot
  widen a track; `.recharts-wrapper` is capped at its card width.

## 3. Verification

| Check | Result |
|---|---|
| `next build --webpack` | **PASS** — 89/89 pages (sandbox build used offline stubs for Google Fonts and the Prisma client; CI builds with the real client) |
| `eslint src e2e playwright.config.ts` | **PASS** — 0 errors, 2 pre-existing `no-location-assign` warnings |
| `tsc --noEmit` | No errors in the changed files. The sandbox cannot run `prisma generate` (no engine download), so data-layer files type-check only in CI. |
| `e2e/specs/11-mobile.spec.ts` (CI, real Chromium) | **PASS** — 320×568, 360×800, 375×812, 390×844, 412×915, 667×375 (landscape), 768×1024, 1024×768, 1366×768 |
| Full Playwright suite (CI) | **PASS** — 148 tests (132 existing + 16 mobile) |
| PWA assets served by the standalone build | **PASS** — `/offline` 200, `/sw.js` 200 `application/javascript`, `/manifest.webmanifest` 200 `application/manifest+json`, `viewport-fit=cover` + manifest link in the HTML |
| Manifest shape + worker registration in a production build | **PASS** — asserted in the browser (name, short_name, start_url, scope, display, colours, 192/512/maskable icons, `navigator.serviceWorker.getRegistration('/')`) |
| Offline banner on disconnect / clears on reconnect | **PASS** — asserted with `context.setOffline(true/false)` |
| Real Android / iOS hardware | **NOT TESTED** |
| Install prompt (A2HS) end-to-end, standalone launch, splash/icons | **NOT TESTED** — prerequisites verified only |
| Offline navigation to a deep link on a device | **NOT TESTED** — the fallback page is served by the worker, but only a device can confirm the full flow |
| Print / PDF / Excel export from a phone | **NOT TESTED** — desktop paths are unchanged and covered by the existing suite |
| On-screen-keyboard layout (dvh behaviour with the keyboard open) | **NOT TESTED** on hardware; `dvh` heights and full-screen phone dialogs are in place |

Sandbox limits: Chromium cannot be downloaded in this environment (`cdn.playwright.dev` is blocked),
so every browser assertion above ran in GitHub Actions, not locally; and no real device was available.

## 4. Deliberate decisions

- **No bottom navigation.** The drawer plus the command palette cover every module; a bottom bar would
  duplicate the sidebar and eat 56px of a 568px-tall screen.
- **No offline queue.** Buffering stock movements, production entries or invoices and replaying them
  later is a data-integrity problem, not a UI problem. The UI says so instead of pretending.
- **No API caching.** `/api/**` responses are tenant and financial data; they are excluded from the
  worker entirely and keep `Cache-Control: no-store`.
- **Emerald, not violet.** The task brief mentioned a violet brand; this repository's identity is
  emerald `#047857` (tokens, manifest, theme-color). The mobile work keeps it and this is flagged.

## 5. Deployment and rollback

Deployment is the normal `main` build; no schema, env or infrastructure changes were made.

Rollback: `git revert` the merge commit and redeploy. Because the service worker caches only
content-hashed build assets and never caches HTML or API responses, a revert takes effect on the next
load; users with an installed worker pick up the new build through `SKIP_WAITING` + the single
reload in `ServiceWorkerRegistrar`. If the worker itself misbehaves, ship `public/sw.js` with an
`activate`-time `caches.delete()` for its own cache and `self.registration.unregister()`.
