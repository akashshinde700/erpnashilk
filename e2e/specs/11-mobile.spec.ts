import { test, expect, loginFast, openModule, openCreate } from '../support/fixtures'
import type { Locator, Page } from '@playwright/test'

/**
 * Mobile / responsive regression suite.
 *
 * Every check below is a property the *user* notices on a phone, not an implementation detail:
 *  - the page never scrolls sideways,
 *  - the content column is reachable (drawer instead of the desktop rail),
 *  - records are readable (cards below 768px, the table at 768px and up),
 *  - dialogs fit the viewport and their actions stay on screen,
 *  - inputs are at least 16px so iOS Safari does not zoom on focus.
 *
 * The suite runs the real production build against the in-browser API double, so it is fast and has
 * no database dependency. Real-device testing is still listed as NOT TESTED in the release notes.
 */

type ViewportSpec = { width: number; height: number; label: string }

const PHONES: ViewportSpec[] = [
  { width: 320, height: 568, label: '320x568 (iPhone SE / smallest supported)' },
  { width: 360, height: 800, label: '360x800 (Galaxy A-series)' },
  { width: 375, height: 812, label: '375x812 (iPhone X/11 Pro)' },
  { width: 390, height: 844, label: '390x844 (iPhone 12-15)' },
  { width: 412, height: 915, label: '412x915 (Pixel 7)' },
]

const TABLETS: ViewportSpec[] = [{ width: 768, height: 1024, label: '768x1024 (iPad portrait)' }]

const LANDSCAPE_PHONES: ViewportSpec[] = [
  { width: 667, height: 375, label: '667x375 (phone landscape)' },
]

const LARGER: ViewportSpec[] = [
  { width: 1024, height: 768, label: '1024x768 (iPad landscape / small laptop)' },
  { width: 1366, height: 768, label: '1366x768 (laptop)' },
]

/** Horizontal overflow of the document — the single most visible mobile layout bug. */
async function horizontalOverflow(page: Page) {
  return page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
    bodyScrollWidth: document.body.scrollWidth,
  }))
}

/**
 * Elements whose box sticks out of the viewport. Named in the failure message so a red build says
 * *which* component overflows instead of only how many pixels it overflowed by.
 */
async function overflowingElements(page: Page) {
  return page.evaluate(() => {
    const vw = document.documentElement.clientWidth
    const found: string[] = []
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
      const r = el.getBoundingClientRect()
      if (r.width < 1 || r.height < 1) continue
      const style = getComputedStyle(el)
      // Teleported overlays (menus, popovers, the Radix focus guard) are not page overflow.
      if (style.position === 'fixed' && (r.right > vw + 1 || r.left < -1)) continue
      if (r.right <= vw + 1 && r.left >= -1) continue
      const cls = typeof el.className === 'string' ? el.className : ''
      const parent = el.parentElement
      const pr = parent?.getBoundingClientRect()
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40)
      found.push(
        `<${el.tagName.toLowerCase()} class="${cls.slice(0, 110)}"> left=${Math.round(r.left)} right=${Math.round(r.right)} width=${Math.round(r.width)}`
          + ` | parent ${parent ? `<${parent.tagName.toLowerCase()} class="${(typeof parent.className === 'string' ? parent.className : '').slice(0, 60)}"> width=${pr ? Math.round(pr.width) : '?'}` : 'none'}`
          + ` | text="${text}"`,
      )
      if (found.length >= 8) break
    }
    return found
  })
}

async function expectNoHorizontalScroll(page: Page, where: string) {
  const m = await horizontalOverflow(page)
  const offenders = m.scrollWidth > m.innerWidth + 1 ? await overflowingElements(page) : []
  expect(
    m.scrollWidth,
    `${where}: document scrolls sideways (${m.scrollWidth}px content in a ${m.innerWidth}px viewport)`
      + (offenders.length ? `\nWidest offenders:\n${offenders.join('\n')}` : ''),
  ).toBeLessThanOrEqual(m.innerWidth + 1)
}

/** Records area: cards on phones, table at 768px and up — never both, never neither. */
async function expectRecordsPresentation(page: Page, isPhone: boolean) {
  const main = page.locator('main')
  if (isPhone) {
    await expect(main.locator('li[data-row-id]').first(), 'phone record cards').toBeVisible()
    await expect(main.locator('table'), 'the wide table must not render on a phone').toHaveCount(0)
  } else {
    await expect(main.locator('table').first(), 'table on tablet/desktop').toBeVisible()
    await expect(main.locator('li[data-row-id]'), 'card list must not render at >=768px').toHaveCount(0)
  }
}

function describeViewport(vp: ViewportSpec) {
  test.describe(`Viewport ${vp.label}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } })

    test('shell, navigation and records fit the screen', async ({ page, store, pageErrors }) => {
      await loginFast(page, store)
      await expect(page).toHaveTitle(/Dashboard · ManuFlow ERP/)

      // Header is compact — a phone must not lose a third of the screen to chrome.
      const headerBox = await page.locator('header').first().boundingBox()
      expect(headerBox, 'header bounding box').not.toBeNull()
      expect(headerBox!.height).toBeLessThanOrEqual(60)

      await expectNoHorizontalScroll(page, 'dashboard')

      const hamburger = page.getByRole('button', { name: 'Open navigation' })
      // The rail (desktop) and the drawer (mobile) each render a nav with the same name, so both
      // are scoped to their container — an unscoped lookup matches two elements.
      const rail = page.locator('aside').getByRole('navigation', { name: 'ERP modules' })
      if (vp.width < 1024) {
        // Phones and the 768px tablet use the drawer; the desktop rail is not on screen.
        await expect(hamburger).toBeVisible()
        await expect(rail).toBeHidden()
        await hamburger.click()
        const panel = page.getByRole('dialog', { name: 'Navigation' })
        await expect(panel).toBeVisible()
        await expect(panel.getByRole('navigation', { name: 'ERP modules' })).toBeVisible()
        // Background must not scroll behind the open drawer.
        expect(await page.evaluate(() => document.body.style.overflow)).toBe('hidden')
        // Focus starts inside the panel, and Escape returns it to the hamburger.
        const focusedInsidePanel = await page.evaluate(() => {
          const dialog = document.querySelector('[role="dialog"][aria-label="Navigation"]')
          return dialog ? dialog.contains(document.activeElement) : false
        })
        expect(focusedInsidePanel, 'drawer moves focus into the panel').toBe(true)
        await page.keyboard.press('Escape')
        await expect(panel).toBeHidden()
        expect(await page.evaluate(() => document.body.style.overflow)).not.toBe('hidden')
        await expect(hamburger).toBeFocused()
      } else {
        await expect(rail).toBeVisible()
        await expect(hamburger).toBeHidden()
      }

      // Records: the same module, presented for the screen width.
      await openModule(page, 'Items')
      await expect(page.getByText('EN8 Round Bar 40mm')).toBeVisible()
      await expectNoHorizontalScroll(page, 'items list')
      await expectRecordsPresentation(page, vp.width < 768)

      // Search still filters in the mobile presentation.
      const search = page.locator('main').getByPlaceholder(/^Search/).first()
      await search.fill('Bearing')
      await expect(page.getByText('Ball Bearing 6204')).toBeVisible()
      await expect(page.getByText('EN8 Round Bar 40mm')).toBeHidden()
      await expectNoHorizontalScroll(page, 'items list filtered')

      expect(pageErrors, `uncaught page errors at ${vp.label}`).toEqual([])
    })
  })
}

for (const vp of [...PHONES, ...LANDSCAPE_PHONES, ...TABLETS, ...LARGER]) describeViewport(vp)

test.describe('Phone drawer behaviour', () => {
  test.use({ viewport: { width: 375, height: 812 } })

  test('choosing a module closes the drawer and navigates', async ({ page, store }) => {
    await loginFast(page, store)
    await page.getByRole('button', { name: 'Open navigation' }).click()
    const drawer = page.getByRole('dialog', { name: 'Navigation' })
    await expect(drawer).toBeVisible()

    await drawer.getByRole('button', { name: /^Masters/ }).click()
    await drawer.getByRole('button', { name: 'Items', exact: true }).click()

    await expect(drawer).toBeHidden()
    await expect(page).toHaveTitle(/Items · ManuFlow ERP/)
    // The page must be scrollable again after the drawer closes.
    expect(await page.evaluate(() => document.body.style.overflow)).not.toBe('hidden')
  })

  test('tapping the backdrop and the close button both dismiss the drawer', async ({ page, store }) => {
    await loginFast(page, store)
    const openBtn = page.getByRole('button', { name: 'Open navigation' })
    const drawer = page.getByRole('dialog', { name: 'Navigation' })

    await openBtn.click()
    await expect(drawer).toBeVisible()
    await page.mouse.click(370, 400) // outside the 85vw panel
    await expect(drawer).toBeHidden()

    await openBtn.click()
    await expect(drawer).toBeVisible()
    await drawer.getByRole('button', { name: 'Close navigation' }).click()
    await expect(drawer).toBeHidden()
    await expect(openBtn).toBeFocused()
  })
})

function describeForm(vp: ViewportSpec) {
  test.describe(`Phone form at ${vp.label}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } })

    test('create dialog fits and stays usable', async ({ page, store }) => {
      await loginFast(page, store)
      await openModule(page, 'Items')
      const dialog = await openCreate(page, 'Item')

      const box = await dialog.boundingBox()
      expect(box, 'dialog bounding box').not.toBeNull()
      expect(box!.width).toBeLessThanOrEqual(vp.width)
      expect(box!.height).toBeLessThanOrEqual(vp.height + 1)
      expect(box!.x).toBeGreaterThanOrEqual(-1)
      expect(box!.y).toBeGreaterThanOrEqual(-1)

      // The primary actions are reachable without hunting for them.
      await expect(dialog.getByRole('button', { name: 'Create' })).toBeInViewport()
      await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeInViewport()

      // 16px inputs: below that, iOS Safari zooms on focus and the layout jumps.
      const nameInput: Locator = dialog.getByPlaceholder('Hex Bolt M8')
      const fontSize = await nameInput.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))
      expect(fontSize, 'input font-size on phones').toBeGreaterThanOrEqual(16)

      await expectNoHorizontalScroll(page, 'items page with dialog open')

      // Still closable from the phone keyboard / Escape after typing.
      await nameInput.fill('Angle Bracket 40x40')
      await page.keyboard.press('Escape')
      await expect(dialog).toBeHidden()
      await expect(page).toHaveTitle(/Items · ManuFlow ERP/)
    })
  })
}

for (const vp of [PHONES[0], PHONES[2]]) describeForm(vp)

test.describe('Phone write flow', () => {
  test.use({ viewport: { width: 375, height: 812 } })

  test('a record created on the phone shows up in the card list', async ({ page, store }) => {
    await loginFast(page, store)
    await openModule(page, 'Items')
    const dialog = await openCreate(page, 'Item')

    await dialog.getByPlaceholder('Hex Bolt M8').fill('Mobile Bracket 30x30')
    await dialog.getByPlaceholder('Auto (RM-001…)').fill('RM-MOB')
    await dialog.getByRole('button', { name: 'Create' }).click()
    await expect(dialog).toBeHidden()

    // The new record is in the list the phone actually renders (cards, not a table).
    const card = page.locator('main li[data-row-id]').filter({ hasText: 'Mobile Bracket 30x30' }).first()
    await expect(card).toBeVisible()
    await expect(page.locator('main table')).toHaveCount(0)

    const created = (store.collections.items as { name: string }[]).find((i) => i.name === 'Mobile Bracket 30x30')
    expect(created, 'the API double received the create call').toBeTruthy()
  })
})

test.describe('Offline handling', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('the connection banner appears on disconnect and clears on reconnect', async ({ page, store, context }) => {
    await loginFast(page, store)
    await expect(page.getByText("You're offline.")).toHaveCount(0)

    await context.setOffline(true)
    await expect(page.getByText("You're offline.")).toBeVisible()
    // The copy must not promise that work is saved while offline.
    await expect(page.getByText(/Nothing is saved until you reconnect/)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible()

    await context.setOffline(false)
    await expect(page.getByText("You're offline.")).toBeHidden()
  })
})

test.describe('PWA prerequisites', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('manifest is installable-shaped and the service worker registers', async ({ page, store }) => {
    await loginFast(page, store)

    const res = await page.request.get('/manifest.webmanifest')
    expect(res.status()).toBe(200)
    const manifest = await res.json()
    expect(manifest.name).toBeTruthy()
    expect(manifest.short_name).toBeTruthy()
    expect(manifest.start_url).toBeTruthy()
    expect(manifest.scope).toBe('/')
    expect(manifest.display).toBe('standalone')
    expect(manifest.theme_color).toMatch(/^#[0-9a-f]{6}$/i)
    expect(manifest.background_color).toMatch(/^#[0-9a-f]{6}$/i)
    expect(manifest.icons.some((i: { sizes: string }) => i.sizes === '192x192')).toBe(true)
    expect(manifest.icons.some((i: { sizes: string }) => i.sizes === '512x512')).toBe(true)
    expect(manifest.icons.some((i: { purpose?: string }) => i.purpose === 'maskable')).toBe(true)

    // The suite runs a production build, so the registrar must install the worker at the root scope.
    const scope = await page.waitForFunction(
      async () => {
        if (!('serviceWorker' in navigator)) return false
        const reg = await navigator.serviceWorker.getRegistration('/')
        return reg ? reg.scope : false
      },
      null,
      { timeout: 20_000 },
    ).then((handle) => handle.jsonValue())
    expect(scope).toBe(`${new URL(page.url()).origin}/`)

    // The static offline fallback really exists and is prerendered.
    const offline = await page.request.get('/offline')
    expect(offline.status()).toBe(200)
    expect(await offline.text()).toContain('offline')
  })
})
