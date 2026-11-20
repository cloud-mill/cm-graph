import type { Page } from '@playwright/test'
import { TRIO, expect, test as base } from './fixtures'
import { Fingers } from './touch'

/**
 * Back, Forward and reload here are the browser's own (the same history
 * traversal a phone's Back button or edge swipe performs), never a call to
 * something's close function. Each test then reads what is actually on screen
 * and where the address bar is.
 */
const test = base.extend<{ fingers: Fingers }>({
  fingers: async ({ page, browserName }, use) => { await use(new Fingers(page, browserName === 'chromium')) },
})

const dock = (page: Page) => page.locator('.dock')
const route = (page: Page) => page.evaluate(() => location.hash)
const inEditor = async (page: Page) => { await expect(page.locator('.canvas-svg')).toBeVisible(); expect(await route(page)).toBe('#/d/e2edoc') }
const onDashboard = async (page: Page) => { await expect(page.getByRole('button', { name: 'New blueprint' })).toBeVisible(); await expect(page.locator('.canvas-svg')).toHaveCount(0) }
const layers = (page: Page) => page.locator('.sheet, .modal, .cmdk, .ctx-menu, .select-list, .gestures, .dock.prompt')
const back = async (page: Page) => { await page.goBack(); await page.waitForTimeout(250) }
const menu = async (page: Page, q?: string) => { await dock(page).getByRole('button', { name: 'Menu' }).tap(); if (q) { await page.getByLabel('Search commands').fill(q); await page.keyboard.press('Enter') } }

/** dashboard first, then into the blueprint from its card: the history a real visit has */
const visit = async (page: Page, app: { seed: (d: ReturnType<typeof TRIO>) => Promise<void>; ready: () => Promise<void> }) => {
  await app.seed(TRIO())
  await page.goto('/')
  await page.getByRole('button', { name: 'Open E2E blueprint' }).tap()
  await app.ready()
}

test.describe('phone: Back closes what is open before it leaves the page', () => {
  test.beforeEach(async ({ page, app }) => { await visit(page, app) })

  const openers: [string, (page: Page, f: Fingers, app: any) => Promise<void>, string][] = [
    ['the library sheet', async (page) => { await dock(page).getByRole('button', { name: 'Add', exact: true }).tap() }, '.sheet'],
    ['the inspector sheet', async (page, f, app) => { await f.tap(await app.world(1, 1)); await dock(page).getByRole('button', { name: 'Edit' }).tap() }, '.sheet'],
    ['the menu', async (page) => { await menu(page) }, '.cmdk'],
    ['the export dialog', async (page) => { await menu(page, 'export') }, '.modal'],
    ['the import dialog', async (page) => { await menu(page, 'import from') }, '.modal'],
    ['the share dialog', async (page) => { await page.getByRole('button', { name: 'Share' }).tap() }, '.modal'],
    ['version history', async (page) => { await menu(page, 'version history') }, '.modal'],
    ['the gesture guide', async (page) => { await menu(page, 'touch gestures') }, '.gestures'],
    ['the press-and-hold menu', async (page, f, app) => { await f.press(await app.world(4, 4), 560) }, '.ctx-menu'],
    ['a tool waiting for a tap', async (page) => { await dock(page).getByRole('button', { name: 'Connect' }).tap() }, '.dock.prompt'],
  ]
  for (const [name, open, sel] of openers) {
    test(`${name}: Back closes it and stays; Back again goes to the dashboard`, async ({ page, app, fingers }) => {
      const corner = await app.corner('a')
      await open(page, fingers, app)
      await expect(page.locator(sel)).toBeVisible()
      await back(page)
      await expect(page.locator(sel)).toHaveCount(0)
      await inEditor(page)
      await expect(layers(page)).toHaveCount(0)
      // the blueprint and the view are as they were
      expect((await app.settled()).nodes).toHaveLength(3)
      await expect.poll(async () => { const c = await app.corner('a'); return Math.hypot(c.x - corner.x, c.y - corner.y) }).toBeLessThan(1)
      // with nothing open, Back is the browser's ordinary Back
      await back(page)
      await onDashboard(page)
    })
  }

  test('layers come off one at a time, newest first', async ({ page, app, fingers }) => {
    await fingers.tap(await app.world(7, 1))
    await dock(page).getByRole('button', { name: 'Edit' }).tap()
    const sheet = page.getByRole('dialog', { name: 'Inspector' })
    await expect(sheet).toBeVisible()
    await sheet.locator('.select').first().tap()
    await expect(page.locator('.select-list')).toBeVisible()
    await back(page)
    await expect(page.locator('.select-list')).toHaveCount(0)
    await expect(sheet).toBeVisible()
    await back(page)
    await expect(sheet).toHaveCount(0)
    await inEditor(page)
    // the component is still selected: Back took the sheet, not the selection
    await expect(dock(page).locator('.dock-name b')).toBeVisible()
    await back(page)
    await onDashboard(page)
  })

  test('multi-select and a tool in use are each one Back away from ordinary editing', async ({ page, app, fingers }) => {
    await fingers.tap(await app.world(1, 1))
    await dock(page).getByRole('button', { name: 'More' }).tap()
    await expect(dock(page).getByRole('button', { name: 'Done' })).toBeVisible()
    await back(page)
    await expect(dock(page).getByRole('button', { name: 'More' })).toBeVisible()
    await dock(page).getByRole('button', { name: 'Connect' }).tap()
    await expect(page.locator('.dock.prompt')).toBeVisible()
    await back(page)
    await expect(page.locator('.dock.prompt')).toHaveCount(0)
    await inEditor(page)
    expect((await app.settled()).edges).toHaveLength(0)
  })

  test('closing from the screen leaves no dead entries behind: history does not grow, and one Back still leaves', async ({ page }) => {
    const length = () => page.evaluate(() => history.length)
    const before = await length()
    for (let i = 0; i < 6; i++) {
      await dock(page).getByRole('button', { name: 'Add', exact: true }).tap()
      await page.getByRole('button', { name: 'Close library' }).tap()
      await menu(page)
      await page.keyboard.press('Escape')
    }
    await page.waitForTimeout(300)
    expect(await length()).toBeLessThanOrEqual(before + 1)
    await expect(layers(page)).toHaveCount(0)
    await back(page)
    await onDashboard(page)
  })

  test('switching from one layer straight to another still costs one Back each way out', async ({ page, app, fingers }) => {
    // menu -> export: the dialog replaces the menu
    await menu(page, 'export')
    await expect(page.getByRole('dialog', { name: 'Export' })).toBeVisible()
    await back(page)
    await expect(layers(page)).toHaveCount(0)
    await inEditor(page)
    // inspector -> library by the add-another button
    await fingers.tap(await app.world(1, 1))
    await dock(page).getByRole('button', { name: 'Edit' }).tap()
    await expect(page.getByRole('dialog', { name: 'Inspector' })).toBeVisible()
    await page.getByRole('button', { name: 'Close inspector' }).tap()
    await page.getByRole('button', { name: 'Add another component' }).tap()
    await expect(page.getByRole('dialog', { name: 'Library' })).toBeVisible()
    await back(page)
    await expect(page.locator('.sheet')).toHaveCount(0)
    await inEditor(page)
    await back(page)
    await onDashboard(page)
  })

  test('Forward after a Back-dismissal neither reopens anything nor strands the user', async ({ page }) => {
    await dock(page).getByRole('button', { name: 'Add', exact: true }).tap()
    await expect(page.locator('.sheet')).toBeVisible()
    await back(page)
    await expect(page.locator('.sheet')).toHaveCount(0)
    await page.goForward().catch(() => {})
    await page.waitForTimeout(400)
    await inEditor(page)
    await expect(layers(page)).toHaveCount(0)
    // still exactly one Back from the dashboard
    await back(page)
    await onDashboard(page)
    // and Forward from the dashboard returns to the blueprint, as a browser should
    await page.goForward()
    await inEditor(page)
  })

  test('reloading with something open comes back clean, and Back still works normally', async ({ page, app }) => {
    await menu(page, 'export')
    await expect(page.getByRole('dialog', { name: 'Export' })).toBeVisible()
    await page.reload()
    await app.ready()
    await page.waitForTimeout(300)
    await expect(layers(page)).toHaveCount(0)
    await inEditor(page)
    // a layer opened after the reload behaves like any other
    await dock(page).getByRole('button', { name: 'Add', exact: true }).tap()
    await expect(page.locator('.sheet')).toBeVisible()
    await back(page)
    await expect(page.locator('.sheet')).toHaveCount(0)
    await inEditor(page)
    await back(page)
    await onDashboard(page)
  })

  test('unsaved typing survives a Back that closes the sheet it was typed in', async ({ page, app, fingers }) => {
    await fingers.tap(await app.world(1, 1))
    await dock(page).getByRole('button', { name: 'Edit' }).tap()
    const name = page.getByRole('dialog', { name: 'Inspector' }).locator('.title-input')
    await name.tap()
    await name.fill('checkout-api')
    // no Enter, no blur: straight to Back
    await back(page)
    await expect(page.locator('.sheet')).toHaveCount(0)
    await inEditor(page)
    expect((await app.settled()).nodes[0].name).toBe('checkout-api')
    await expect(dock(page).locator('.dock-name b')).toHaveText('checkout-api')
  })

  test('work done before leaving with Back is there on return', async ({ page, app, fingers }) => {
    await dock(page).getByRole('button', { name: 'Add', exact: true }).tap()
    await page.getByTitle('Function: Lambda').tap()
    await expect(page.locator('.sheet')).toHaveCount(0)
    await back(page) // nothing open: leaves
    await onDashboard(page)
    await page.goForward()
    await app.ready()
    expect((await app.saved())!.nodes.map((n) => n.type)).toContain('lambda')
    await expect(page.locator('[data-kind="node"]')).toHaveCount(4)
    void fingers
  })

  test('rapid Back presses peel layers and then leave, without skipping or looping', async ({ page, app, fingers }) => {
    await fingers.tap(await app.world(1, 1))
    await dock(page).getByRole('button', { name: 'Edit' }).tap()
    await page.getByRole('dialog', { name: 'Inspector' }).locator('.select').first().tap()
    await expect(page.locator('.select-list')).toBeVisible()
    // two layers: two presses in quick succession must end in the editor with nothing open, not on the dashboard
    await page.evaluate(() => { history.back() })
    await page.waitForTimeout(60)
    await page.evaluate(() => { history.back() })
    await page.waitForTimeout(500)
    await expect(layers(page)).toHaveCount(0)
    await inEditor(page)
  })
})

test.describe('phone: pages and history', () => {
  test('a blueprint opened by its address: Back closes a layer, and the page itself is never trapped', async ({ page, app }) => {
    await app.seed(TRIO())
    await page.goto('about:blank')
    await page.goto('/#/d/e2edoc') // straight to the blueprint, no dashboard before it
    await app.ready()
    await dock(page).getByRole('button', { name: 'Add', exact: true }).tap()
    await expect(page.locator('.sheet')).toBeVisible()
    await back(page)
    await expect(page.locator('.sheet')).toHaveCount(0)
    await inEditor(page)
    // the next Back leaves the site altogether: nothing artificial is in the way
    await page.goBack()
    expect(page.url()).toBe('about:blank')
  })

  test('the arrow to the dashboard is a step back, so the dashboard is not left with the blueprint behind it', async ({ page, app }) => {
    await page.goto('about:blank')
    await visit(page, app)
    await page.getByRole('button', { name: 'All blueprints' }).tap()
    await onDashboard(page)
    // Back from here leaves the app instead of bouncing into the blueprint just left
    await page.goBack()
    expect(page.url()).toBe('about:blank')
  })

  test('leaving for the dashboard from the menu takes the menu with it', async ({ page, app }) => {
    await page.goto('about:blank')
    await visit(page, app)
    await menu(page, 'back to all')
    await onDashboard(page)
    await expect(layers(page)).toHaveCount(0)
    await page.goBack()
    expect(page.url()).toBe('about:blank')
  })

  test('a blueprint opened by address, then the arrow: the dashboard is a new page and Back returns to the blueprint', async ({ page, app }) => {
    await app.open(TRIO())
    await page.getByRole('button', { name: 'All blueprints' }).tap()
    await onDashboard(page)
    await back(page)
    await inEditor(page)
  })

  test('an address for a blueprint that is gone lands on the dashboard without a Back loop', async ({ page, app }) => {
    await app.seed(TRIO())
    await page.goto('about:blank')
    await page.goto('/')
    await onDashboard(page)
    await page.goto('/#/d/no-such-blueprint')
    await onDashboard(page)
    expect(await route(page)).toBe('#/')
    await back(page)
    // back on the dashboard entry before it, not bounced forward again
    await onDashboard(page)
    await page.waitForTimeout(400)
    await page.goBack()
    expect(page.url()).toBe('about:blank')
  })

  test('a dialog on the dashboard closes with Back and the dashboard stays', async ({ page, app }) => {
    await app.seed(TRIO())
    await page.goto('about:blank')
    await page.goto('/')
    await page.getByRole('button', { name: /Import/ }).first().tap()
    const dialog = page.getByRole('dialog', { name: 'Import' })
    await expect(dialog).toBeVisible()
    await back(page)
    await expect(dialog).toHaveCount(0)
    await onDashboard(page)
    await page.goBack()
    expect(page.url()).toBe('about:blank')
  })
})
