# ManuFlow UI/UX System — 2026-10-30

Reference for the visual language shipped in this pass. Everything below is implemented; this file
explains *why*, so future screens extend the system instead of re-inventing it.

Method: the UI/UX review rules from `nextlevelbuilder/ui-ux-pro-max-skill` were applied as a checklist
(accessibility → touch/interaction → performance → style/layout → typography & colour → animation →
forms → navigation → charts), then judged against this product's reality: dense numeric tables, keyboard-
heavy power users, Indian GST documents, and a shop-floor context where the app must read at 100 % zoom
on a 1366-wide laptop.

## 1. Tokens are the contract

`src/app/globals.css` is the single source of truth. Screens use semantic utilities
(`bg-card`, `text-muted-foreground`, `bg-success-soft`, `ring-warning-border`, …) and **never** raw palette
classes. Before this pass there were 342 hardcoded `emerald-*`, 239 `red-*` and 223 `amber-*` utilities —
which meant dark mode was tuned by hand per screen and drifted. There are now zero.

| Group | Tokens |
| --- | --- |
| Surfaces | `--background` `--card` `--popover` `--muted` `--accent` |
| Brand | `--primary` (emerald 700 light / emerald 400 dark), `--ring`, `--brand-accent` (amber, attention only) |
| Meaning | `--success` `--warning` `--info` `--destructive` + matching `-soft` / `-border` pairs |
| Data viz | `--chart-1…5` (emerald, amber, sky, violet, rose) |
| Elevation | `--shadow-1` (cards), `--shadow-2` (popovers, drawers) |
| Motion | `--dur-fast/base/slow`, `--ease-out` |
| Radii | `--radius` 0.75 rem + sm/md/lg/xl/2xl derivations |

Brand stays emerald because the login panel, app icons, PWA manifest and print headings already use it —
swapping in the review tool's generic blue would have meant re-shooting every asset for no functional gain.

### Contrast (measured, not eyeballed)

Computed from the oklch values with the WCAG relative-luminance formula:

| Pair | Light | Dark |
| --- | --- | --- |
| body text on canvas | 17.0:1 | 18.4:1 |
| muted text on card | 7.6:1 | 6.8:1 |
| primary button label | 5.1:1 | 8.7:1 |
| success / warning / info pill text | 5.1 / 4.9 / 5.5 | 10.0 / 10.4 / 8.3 |
| danger pill text | 4.6:1 | 5.6:1 |
| focus ring vs card | 3.7:1 | 9.0:1 |

All pass AA (4.5:1 text, 3:1 non-text). Two adjustments came out of the measurement: `--destructive` was
darkened from red-600 to 4.6:1 as pill text, and solid amber buttons got dedicated foreground tokens
(`--warning-foreground`, `--brand-accent-foreground`) instead of white, which only reached 3.2:1.

## 2. What changed, screen by screen

**App shell** — sidebar uses `bg-sidebar` with a `--primary` active row and muted icons that tint on hover;
the header is a translucent blur over `bg-card/85`; the content column widens to 1600 px so dense tables
breathe; loading states are a brand mark + progress, not a bare spinner; the mobile drawer is a labelled
`aria-modal` dialog.

**Kit (`src/components/erp/kit.tsx`)**
- `DataTable`: sticky uppercase column heads, `role="region"` + `aria-busy` while loading, rows become
  keyboard-activatable when clickable (Enter/Space), empty state distinguishes *no records* from *no
  matches* and offers a way out, search box gets a label, a `type="search"` semantic and one clear button.
- `StatCard`: number-first hierarchy with tabular figures, ascending/descending delta chip, hover lift.
- `StatusBadge`: tone → token mapping in one place, so every status pill in the product matches.
- `FormDialog`: optional form-level `error` rendered as a focusable `role="alert"`, plus a sticky bordered
  footer so Save/Cancel stay reachable in long forms.
- `Field`: `hint` / `error` wired through `aria-describedby` + `aria-invalid`.

**Dashboard** — KPI tiles and quick actions lift on hover and expose a real focus ring; charts read their
colours and grid from CSS variables (`var(--border)`, `--brand-accent`) so they flip with the theme;
empty chart states explain what will appear and link to the module that fills them; the stale-data banner
says what happened instead of just printing the error.

**Login** — brand panel with a masked grid + emerald/amber radial wash, mobile lockup, focused error alert,
and copy that explains how access is granted rather than leaving a dead end.

**Primitives** — `Button`, `Select`, `Checkbox`, `Switch`, `Tabs`, `Table`, `Input`, `Badge` now carry the
pointer cursor (Tailwind v4 no longer sets it on `<button>`), one shared focus treatment, token elevation and
token colours.

## 3. Interaction rules

1. **Every operable control is keyboard-reachable** and shows the same 2 px `--ring` focus outline.
   A skip link to `#erp-main` is the first tab stop.
2. **Hover = 150 ms colour/shadow change**, never a layout shift; tiles lift 1–2 px.
3. **`prefers-reduced-motion` is honoured globally** — all animation/transition durations collapse.
4. **Numbers are tabular** (`font-variant-numeric`) anywhere columns can align: tables, totals, KPI tiles.
5. **Empty ≠ error ≠ loading.** Each has its own treatment and, where useful, its own next action.
6. **No emoji as UI icons.** Import Center cards and dialogs use lucide icons.
7. **Toasts sit bottom-right** so they never cover page headers or primary actions.

## 4. Command palette

Module labels are short (`Outstanding`), but people search with the words they know (`receivables`, `dues`,
`ageing`). Each module now carries an alias list used as cmdk `keywords`, plus a ranking filter so an
alias-only hit can never outrank a real label hit — typing `GST` and pressing Enter still lands on
GST Reports rather than a screen that merely mentions GST.

## 5. Deliberately unchanged

- Every workflow, print format and API contract — this pass is presentation only.
- Business logic, validation rules and data shapes.
- `next/font` (Geist) locally, no CDN font swap: the review tool's suggested Fira pairing would add a
  render-blocking third-party request for no measurable gain here.

## 6. Verification

- `npx eslint src e2e` → 0 errors / 8 pre-existing warnings.
- `npx tsc --noEmit` → no new errors in `src/components` or `src/app`.
- `next build --webpack` → 88/88 pages.
- `npx playwright test` → **132 / 132 passed** (128 UI + 4 print-document).
- Visual pass at 1440×900 and 820×1000, light and dark: dashboard, items, stock, receivables, GST, the
  create dialog (including validation), the command palette, and the mobile navigation drawer.
