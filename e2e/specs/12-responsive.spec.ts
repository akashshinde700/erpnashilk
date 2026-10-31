import { test, expect, loginFast, openModule, openTab, openCreate } from '../support/fixtures'
import { SCREENS } from '../support/modules'
import type { Page } from '@playwright/test'

/**
 * Responsive sweep at normal browser zoom: every screen at the widths real laptops, tablets and phones have.
 * Nobody should have to zoom out to reach a feature, so these are the properties checked:
 *  - the page itself never scrolls sideways (only wide data tables may),
 *  - no button is cut off by an overflow-hidden box where it cannot be scrolled to,
 *  - pinned row actions are on screen without scrolling the table,
 *  - the Tally / e-Invoice menu opens inside the viewport with all eight options,
 *  - dialogs fit the viewport.
 */
const VIEWPORTS = [
  { width: 1920, height: 1080 }, { width: 1440, height: 900 }, { width: 1366, height: 768 }, { width: 1280, height: 720 },
  // 1366px laptop at 125% display scaling or browser zoom: this is the width the page actually gets
  { width: 1093, height: 614 },
  { width: 1024, height: 768 }, { width: 768, height: 1024 }, { width: 390, height: 844 },
]

const TALLY_OPTIONS = [
  'Tally XML (import file)', 'Push to Tally (connector)', 'Tally JSON', 'Tally Excel', 'Tally importer (.bat)',
  'Tally masters (XML)', 'Mark as sent to Tally', 'e-Invoice JSON (GST portal)',
]

/** What is wrong with the screen on show, in words a failure message can use. */
function layoutProblems(page: Page) {
  return page.evaluate(() => {
    const problems: string[] = []
    const vw = document.documentElement.clientWidth
    const overflow = document.documentElement.scrollWidth - vw
    if (overflow > 0) problems.push(`page scrolls sideways by ${overflow}px`)
    /** 'scrolls' = inside a box that scrolls sideways, so it can be reached; 'clipped' = cut off for good. */
    const reach = (el: Element) => {
      const r = el.getBoundingClientRect()
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const o = getComputedStyle(p).overflowX
        if (o === 'auto' || o === 'scroll') return 'scrolls'
        if (o === 'hidden' || o === 'clip') {
          const b = p.getBoundingClientRect()
          if (r.right > b.right + 1 || r.left < b.left - 1) return 'clipped'
        }
      }
      return 'page'
    }
    for (const b of Array.from(document.querySelectorAll<HTMLElement>('main button, header button'))) {
      const r = b.getBoundingClientRect()
      if (r.width < 1 || r.height < 1) continue
      const name = (b.getAttribute('aria-label') || b.title || b.textContent || '').trim().slice(0, 30)
      const where = reach(b)
      if (where === 'clipped') problems.push(`button "${name}" is cut off`)
      else if (where === 'page' && (r.right > vw + 1 || r.left < -1)) problems.push(`button "${name}" is off screen`)
    }
    // Pinned row actions: visible without scrolling the table
    for (const cell of Array.from(document.querySelectorAll<HTMLElement>('main td.md\\:sticky'))) {
      if (getComputedStyle(cell).position !== 'sticky') continue
      const box = cell.closest('[data-slot=table-container]')!.getBoundingClientRect()
      const r = cell.getBoundingClientRect()
      if (r.right > Math.min(box.right, vw) + 1) problems.push(`row actions hidden by ${Math.round(r.right - box.right)}px`)
      // The pinned column must leave room to read the record next to it
      if (r.width > box.width * 0.6) problems.push(`row actions take ${Math.round((r.width / box.width) * 100)}% of the table`)
      break
    }
    return [...new Set(problems)].slice(0, 6)
  })
}

for (const vp of VIEWPORTS) {
  test.describe(`${vp.width}px`, () => {
    test.use({ viewport: vp })

    test('every screen fits', async ({ page, store }) => {
      test.setTimeout(600_000)
      await loginFast(page, store)
      const failures: string[] = []
      for (const screen of SCREENS) {
        for (const tab of screen.tabs ?? [null]) {
          await openModule(page, screen.label)
          if (tab) await openTab(page, tab.label)
          await page.waitForTimeout(300)
          for (const p of await layoutProblems(page)) failures.push(`${tab ? `${screen.label} / ${tab.label}` : screen.label}: ${p}`)
        }
      }
      expect(failures).toEqual([])
    })

    test('the shell stays usable', async ({ page, store }) => {
      await loginFast(page, store)
      const header = page.locator('header')
      await expect(header).toBeInViewport({ ratio: 1 })
      for (const button of await header.getByRole('button').all()) {
        if (await button.isVisible()) await expect(button).toBeInViewport({ ratio: 1 })
      }
      const nav = page.getByRole('navigation', { name: 'ERP modules' })
      if (vp.width < 1024) {
        await page.getByRole('button', { name: 'Open navigation' }).click()
        await expect(nav).toBeInViewport()
      } else {
        await expect(nav).toBeInViewport()
        const rail = await page.locator('aside').first().boundingBox()
        // Small laptops get the icon rail by default, so the data keeps the room
        if (vp.width < 1280) expect(rail!.width).toBeLessThan(80)
        else expect(rail!.width).toBeGreaterThan(200)
      }
    })

    test('the Tally / e-Invoice menu works without zooming out', async ({ page, store }) => {
      await loginFast(page, store)
      await openModule(page, 'Sales Invoices')
      // An unpaid invoice has the longest row of actions
      const trigger = page.getByTitle('Tally / e-Invoice export').first()
      await expect(trigger).toBeInViewport({ ratio: 1 })
      for (const title of ['Print tax invoice', 'Print thermal receipt', 'Send on WhatsApp', 'Email invoice']) {
        await expect(page.getByTitle(title).first()).toBeInViewport({ ratio: 1 })
      }
      await trigger.click()
      const menu = page.getByRole('menu')
      await expect(menu).toBeInViewport({ ratio: 1 })
      for (const option of TALLY_OPTIONS) {
        const item = menu.getByRole('menuitem', { name: option, exact: true })
        // A short window makes the menu scroll inside itself; it never runs off the screen
        await item.scrollIntoViewIfNeeded()
        await expect(item).toBeInViewport({ ratio: 1 })
        await item.click({ trial: true })
      }
    })

    test('forms open inside the viewport', async ({ page, store }) => {
      await loginFast(page, store)
      for (const [module, button] of [['Sales Invoices', /Invoice$/], ['Items', /^(Add )?Item$/], ['Purchase Orders', /Purchase Order|^PO$|Order$/]] as const) {
        await openModule(page, module)
        const dialog = await openCreate(page, button)
        await expect(dialog).toBeInViewport()
        const box = await dialog.evaluate((d) => {
          const r = d.getBoundingClientRect()
          return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, sideways: d.scrollWidth - d.clientWidth, vw: innerWidth, vh: innerHeight }
        })
        expect(box.left).toBeGreaterThanOrEqual(0)
        expect(box.right).toBeLessThanOrEqual(box.vw)
        expect(box.top).toBeGreaterThanOrEqual(0)
        expect(box.bottom).toBeLessThanOrEqual(box.vh)
        expect(box.sideways).toBeLessThanOrEqual(1)
        await page.keyboard.press('Escape')
        await expect(dialog).toBeHidden()
      }
    })
  })
}
