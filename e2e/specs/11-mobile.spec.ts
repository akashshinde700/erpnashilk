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

async function expectNoHorizontalScroll(page: Page, where: string) {
  const m = await horizontalOverflow(page)
  expect(
    m.scrollWidth,
    `${where}: document scrolls sideways (${m.scrollWidth}px content in a ${m.innerWidth}px viewport)`,
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
      const rail = page.getByRole('navigation', { name: 'ERP modules' })
      if (vp.width < 1024) {
        // Phones and the 768px tablet use the drawer; the desktop rail is not on screen.
        await expect(hamburger).toBeVisible()
        await expect(rail).toBeHidden()
        await hamburger.click()
        await expect(rail).toBeVisible()
        const panel = page.getByRole('dialog', { name: 'Navigation' })
        await expect(panel).toBeVisible()
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

for (const vp of [...PHONES, ...TABLETS, ...LARGER]) describeViewport(vp)

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
