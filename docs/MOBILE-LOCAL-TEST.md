# Local test checklist — mobile & PWA (2026-10-31)

Ye list **sirf wahi** cover karta hai jo sandbox/CI me verify nahi ho saka: real MySQL ke saath API suite,
asli phone/tablet par PWA install + offline, on-screen keyboard, aur print/export ke mobile paths.

Sab kuch `main` (commit `c6feba3` ya uske baad) par chalao. Production DB ko **kabhi** mat chhuo.

---

## 0. Ek baar setup

```bash
node -v && bun -v && mysql --version     # Node 22, bun, MySQL 8
npm install
npx prisma generate                       # local par real client banta hai
```

Test DB (naam `_test` par hi khatam hona chahiye):

```bash
mysql -u root -p -e "CREATE DATABASE IF NOT EXISTS manuflow_test CHARACTER SET utf8mb4;"
export TEST_DATABASE_URL='mysql://root:CHANGE_ME@127.0.0.1:3306/manuflow_test'
bun run test:db:prepare                   # guard pass hona chahiye
```

Dev DB (manual scenarios ke liye, alag database):

```bash
export DATABASE_URL='mysql://root:CHANGE_ME@127.0.0.1:3306/manuflow_dev'
npx prisma db push                        # sirf manuflow_dev par
bun prisma/seed.ts                        # demo tenant + admin
```

---

## 1. Gate: API suite real MySQL ke saath  ← sandbox me NOT RUN

| Command | Expected |
|---|---|
| `bun test` | **27 files pass** |
| `bun test tests/production-concurrency.test.ts` | 5 concurrency/idempotency cases pass |
| `bun test tests/production-concurrency.test.ts` (dobara) | dobara pass — flake ho to likho |

Kya dekhna hai (details `docs/LOCAL-TEST-PROMPT.md` me):
- do parallel production entries full qty ke liye → **sirf ek** succeed, FG stock `+10` (20 nahi), RM `-20` (-40 nahi), ek hi entry row, WO `COMPLETED`;
- paanch parallel entries → saved entries == produced stock == work-order counter;
- ledger balance stock ke saath match kare.

Agar guard `[test-db-guard] Refusing…` bole to **ruk jao** — workaround mat karo.

## 2. Gate: production build + poora Playwright  ← sandbox me sirf CI me chala

```bash
npm run build                             # sab pages generate hone chahiye
npx playwright test --reporter=list        # expected: 148 passed
```

Ab suite me 16 mobile tests hain (`e2e/specs/11-mobile.spec.ts`): 320/360/375/390/412 portrait,
667 landscape, 768/1024/1366, plus drawer, forms, create-flow, offline banner aur PWA prerequisites.
Ye locally bhi chalenge — agar koi flake kare to test ka naam note karo.

---

## 3. Asli phone par PWA — sabse zaroori

> **Service worker sirf production build me register hota hai.** `next dev` par install/offline test
> karne ka koi matlab nahi — wahan worker hi nahi lagta.

> **HTTPS ya localhost zaroori hai.** Service worker (`http://192.168.x.x:3000` jaise plain HTTP par)
> register nahi hoga, isliye install prompt bhi nahi aayega. Neeche do tareeke diye hain.

### 3a. Android (USB) — sabse simple

```bash
# phone: Developer options → USB debugging ON, laptop se kabel
adb devices                               # device dikhna chahiye
adb reverse tcp:3000 tcp:3000             # phone ka localhost → laptop ka 3000
npm run build && npx next start -p 3000 -H 0.0.0.0
```

Phone ke Chrome me `http://localhost:3000` kholo (`adbd` reverse ki wajah se ye **secure context** hai) →
service worker + install dono kaam karenge.

### 3b. Koi bhi device — HTTPS tunnel

```bash
npm run build && npx next start -p 3000 -H 0.0.0.0
cloudflared tunnel --url http://localhost:3000     # ya: ngrok http 3000
```

Jo `https://…` URL mile, wahi phone par kholo. (Sandbox ka preview URL bhi HTTPS hai, wahan bhi install test ho sakta hai.)

### Device test steps (Android Chrome)

| # | Step | Expected |
|---|---|---|
| 1 | Chrome me app kholo → 3-dot menu | **"Install app" / "Add to Home screen"** dikhe |
| 2 | Install karo → home screen icon se kholo | **Standalone** khule: koi URL bar / browser tabs nahi, status bar ke neeche se content |
| 3 | Login karo (seed admin) | Dashboard load ho, header notch ke neeche na chhupe |
| 4 | Drawer: hamburger tap → module chuno | Drawer khule, item tap pe band ho, page navigate ho, background scroll na ho |
| 5 | Sirf back-button / gesture se drawer band karo | Drawer band ho (browser back app chhodna nahi chahiye) |
| 6 | Deep link: kisi module ka URL refresh karo | Wahi module khule (login ke baad) |
| 7 | **Airplane mode** ON → app reload karo | `/offline` page: "You're offline…", koi blank screen nahi, koi fake data nahi |
| 8 | Airplane mode me koi form submit karo | **Error** aaye; "saved" jaisa kuch na dikhe, koi queue na bane |
| 9 | Network wapas ON → banner | Offline banner gayab, Retry/reload ke baad normal |
| 10 | Naya build deploy karo → app dobara kholo | Ek reload ke baad naya version (purana JS nahi atka) |

### iPhone (Safari)

| # | Step | Expected |
|---|---|---|
| 1 | HTTPS URL Safari me kholo → Share → **Add to Home Screen** | Icon add ho |
| 2 | Home screen se kholo | Standalone (Safari UI nahi) |
| 3 | Notch/status bar, bottom home-indicator | Header/footer ke buttons safe area ke andar |
| 4 | Kisi input pe tap karo (e.g. item name) | Page **zoom na ho** (16px inputs), keyboard khulne par Save button reachable |
| 5 | Airplane mode → app kholo | Offline page, crash nahi |

---

## 4. Screen-by-screen mobile checklist (devtools, 375×812 + 320×568)

Desktop Chrome → DevTools → device toolbar. Har screen par:

- [ ] **Horizontal scroll nahi** — page side me scroll na ho (tables ke andar scroll allowed hai)
- [ ] Kuch bhi clip/overlap nahi, header 56px se bada nahi
- [ ] Neeche faaltu blank space nahi, content keyboard ke peeche nahi
- [ ] Lists = **cards** (768px se neeche), 768px+ par table
- [ ] Card pe tap → record khule; card ke action buttons sirf apna kaam karein (record na khule)
- [ ] Search/filter/sort/pagination kaam kare
- [ ] Form: single column, labels readable, validation messages dikhein, Save/Cancel tap-friendly, **double-submit na ho**
- [ ] Dropdown/date picker: screen ke andar khule, clip na ho, band ho sake
- [ ] Modal: max height ke andar scroll ho, primary action dikhe, Escape/backdrop se band ho
- [ ] Offline: airplane mode → banner, wapas online → banner gayab

Screens jo zaroor dekho: Dashboard, Items, Parties, Sales Orders, Purchase Orders, Stock, Production/Job Cards,
GST Reports, Cash & Bank, Settings, Notifications.

## 5. Phone se business workflow + DB check

Synthetic data se (real party/customer data nahi):

| # | Kya karo | Verify |
|---|---|---|
| 1 | Party + Item banao | DB me rows banein; list me card turant dikhe |
| 2 | Inward (GRN) post karo | Stock qty badhe; batch/serial sahi; ledger row bane |
| 3 | Job card pe qty consume + produce | Remaining qty sahi; double entry na bane |
| 4 | Production status update | WO status/counter DB ke saath match kare |
| 5 | Certificate / QC record | Record save ho, list me dikhe |
| 6 | Invoice banao | Line totals + tax heads + grand total **paisa-exact**; print preview same numbers |
| 7 | Invoice se print / PDF | Print layout wahi (desktop jaisa), page break theek |
| 8 | Excel/CSV export | File download ho, phone ke viewer me khule |

DB check: agar app me "saved" dikha to row bhi honi chahiye; **kabhi bhi** app ka success message alone evidence na maano.

---

## 6. Jo jaankar bhi test nahi hua (aar ya paar)

| Item | Status |
|---|---|
| Real Android/iOS hardware | **NOT TESTED** — aapke yahan test hoga |
| Install prompt → standalone launch → splash icon | **NOT TESTED** |
| Offline deep-link refresh on device | **NOT TESTED** |
| On-screen keyboard ke saath dvh layout | **NOT TESTED** |
| Phone se print/PDF/Excel | **NOT TESTED** |
| `bun test` (real MySQL) | **NOT TESTED** (sandbox me MySQL nahi) |

## 7. Rules

1. Production DB / `prisma migrate reset` / `db push` production par **kabhi nahi**.
2. Test ke liye app ko weak mat karo (validation off, `--force`, test skip) — jo toota, wo bug report karo.
3. Har failure ke saath: screen, viewport (e.g. 375×812), steps, screenshot. Bina evidence "passed" mat likho.
4. PWA install/offline sirf **production build + HTTPS/localhost** par test hota hai — dev server par nahi.
5. Offline me koi transaction queue nahi hoti (design decision) — expect karna ki offline entry baad me sync hogi, galat hai.
