import type { Page } from '@playwright/test'
import { TRIO, expect, test as base } from './fixtures'
import { Fingers } from './touch'

/** Building with fingers: pulling connections from a component's doors and carrying components, through the browser's own touch input. */
const test = base.extend<{ fingers: Fingers }>({
  fingers: async ({ page, browserName }, use) => { await use(new Fingers(page, browserName === 'chromium')) },
})
const dock = (page: Page) => page.locator('.dock')
const centre = async (page: Page, sel: string) => { const b = (await page.locator(sel).boundingBox())!; return { x: b.x + b.width / 2, y: b.y + b.height / 2 } }

test.describe('phone: direct editing', () => {
  test.beforeEach(async ({ app, browserName }) => { test.skip(browserName !== 'chromium', 'needs real touch input'); await app.open(TRIO()) })

  test('a tap shows a component\'s doors, each big enough for a fingertip', async ({ page, app, fingers }) => {
    await expect(page.locator('.door')).toHaveCount(0)
    await fingers.tap(await app.world(1, 1))
    await expect(page.locator('.door[data-id="a"]')).toHaveCount(4)
    const size = await page.locator('.door[data-id="a"][data-side="e"] circle').first().evaluate((el) => el.getBoundingClientRect().width)
    expect(size).toBeGreaterThanOrEqual(40)
  })

  test('one finger pulls a connection from a door to near another component, and the view stays put', async ({ page, app, fingers }) => {
    await fingers.tap(await app.world(1, 1))
    const from = await centre(page, '.door[data-id="a"][data-side="e"]'), still = await app.corner('c')
    // lifted a little short of `b`, as a thumb would
    await fingers.drag(from, await app.world(5.2, 1.3), { steps: 10 })
    const doc = await app.settled()
    expect(doc.edges).toHaveLength(1)
    expect(doc.edges[0]).toMatchObject({ from: 'a', to: 'b' })
    // it was a connection, not a pan
    expect(await app.corner('c')).toEqual(still)
    await expect(dock(page).locator('.dock-name b')).toHaveText('Connection')
  })

  test('pulled to open ground, it offers what to put there; a tap adds it connected', async ({ page, app, fingers }) => {
    await fingers.tap(await app.world(1, 7))
    const from = await centre(page, '.door[data-id="c"][data-side="e"]')
    await fingers.drag(from, await app.world(5, 7), { steps: 10 })
    const quick = page.getByRole('dialog', { name: 'Add and connect a component' })
    await expect(quick).toBeVisible()
    // no keyboard is thrown up over the canvas: the usual choices are there to tap
    await expect(quick.getByRole('combobox')).not.toBeFocused()
    const row = quick.getByRole('option').nth(1)
    expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(40)
    await row.tap()
    await expect(quick).toHaveCount(0)
    const doc = await app.settled()
    expect(doc.nodes).toHaveLength(4)
    expect(doc.edges).toHaveLength(1)
    expect(doc.edges[0]).toMatchObject({ from: 'c', to: doc.nodes[3].id })
  })

  test('press and hold picks a component up; it follows the finger between cells and lands on the grid', async ({ page, app, fingers }) => {
    const from = await app.world(7, 1), by = await app.cells(0, 3.4), home = await app.corner('b'), cell = await app.cells(0, 1)
    // hold, then carry 3.4 cells and stop there without lifting
    await fingers.down(from)
    await page.waitForTimeout(520)
    for (let i = 1; i <= 10; i++) { await fingers.move({ x: from.x + (by.x * i) / 10, y: from.y + (by.y * i) / 10 }); await page.waitForTimeout(12) }
    const held = await app.corner('b')
    const along = ((held.x - home.x) * cell.x + (held.y - home.y) * cell.y) / (cell.x ** 2 + cell.y ** 2)
    expect(along).toBeGreaterThan(3.05)
    expect(along).toBeLessThan(3.45)
    await expect(page.locator('.landing')).toHaveCount(1)
    await fingers.lift()
    expect((await app.settled()).nodes[1]).toMatchObject({ x: 6, y: 3 })
  })
})
