/**
 * The camera and the view settings on a desktop: 3D and plan views, turning, orbiting, zooming, fitting, the
 * minimap, and the toggles that change what the canvas shows. A failure means the view no longer goes where it
 * is sent, or that looking around has started to change the blueprint (it must stay "Saved" throughout).
 */
import { TRIO, expect, test } from './fixtures'

test.describe('camera and view', () => {
  test.beforeEach(async ({ app }) => { await app.open(TRIO()) })
  const pct = (page: import('@playwright/test').Page) => page.locator('.zoom-pct')
  const zoom = async (page: import('@playwright/test').Page) => parseInt(await pct(page).innerText(), 10)

  test('switches between the 3D home view and the 2D plan', async ({ page, app }) => {
    expect(await app.hud('AZ')).toBe('045°')
    expect(await app.hud('EL')).toBe('35°')
    await page.getByRole('radio', { name: '2D' }).click()
    await expect.poll(() => app.hud('EL')).toBe('90°')
    await expect(page.getByRole('radio', { name: '2D' })).toHaveAttribute('aria-checked', 'true')
    // in plan view x runs straight across the screen
    const a = await app.corner('a'), b = await app.corner('b')
    expect(Math.abs(a.y - b.y)).toBeLessThan(1)
    expect(b.x).toBeGreaterThan(a.x)
    await page.keyboard.press('3')
    await expect.poll(() => app.hud('EL')).toBe('35°')
    await expect.poll(() => app.hud('AZ')).toBe('045°')
    // the camera is a view setting: it never marks the blueprint as changed
    await expect(page.locator('.save-state')).toHaveText('Saved')
  })

  test('turns in 45° steps with Q and E and the cube buttons', async ({ page, app }) => {
    await page.keyboard.press('q')
    await expect.poll(() => app.hud('AZ')).toBe('090°')
    await page.keyboard.press('e')
    await expect.poll(() => app.hud('AZ')).toBe('045°')
    await page.getByRole('button', { name: 'Turn right' }).click()
    await expect.poll(() => app.hud('AZ')).toBe('000°')
    await page.getByRole('button', { name: 'Turn right' }).click()
    await expect.poll(() => app.hud('AZ')).toBe('315°')
    await page.getByRole('button', { name: 'Home view' }).click()
    await expect.poll(() => app.hud('AZ')).toBe('045°')
  })

  test('editing still lands on the right cell after the view is turned', async ({ page, app }) => {
    await page.keyboard.press('q')
    await expect.poll(() => app.hud('AZ')).toBe('090°')
    const from = await app.world(1, 1), d = await app.cells(-2, 3)
    await app.drag(from, { x: from.x + d.x, y: from.y + d.y })
    expect((await app.settled()).nodes[0]).toMatchObject({ x: -2, y: 3 })
    // arrow keys follow the screen, not the grid
    await page.keyboard.press('ArrowRight')
    const n = (await app.settled()).nodes[0]
    const before = { x: -2, y: 3 }
    expect(Math.abs(n.x - before.x) + Math.abs(n.y - before.y)).toBe(1)
    const moved = await app.node('a').evaluate((el) => (el as unknown as SVGGElement).getScreenCTM()!.e)
    await page.keyboard.press('ArrowLeft')
    await app.settled()
    const back = await app.node('a').evaluate((el) => (el as unknown as SVGGElement).getScreenCTM()!.e)
    expect(moved).toBeGreaterThan(back)
  })

  test('right-drag orbits, a plain right-click opens the menu instead', async ({ page, app }) => {
    const g = await app.world(4, 4)
    await app.drag(g, { x: g.x + 140, y: g.y + 40 }, { button: 'right' })
    expect(await app.hud('AZ')).not.toBe('045°')
    expect(await app.hud('EL')).not.toBe('35°')
    await expect(page.locator('.ctx-menu')).toHaveCount(0)
    await page.mouse.click(g.x, g.y, { button: 'right' })
    await expect(page.locator('.ctx-menu')).toBeVisible()
  })

  test('orbit tool drags the view and never moves components; elevation stays in range', async ({ page, app }) => {
    await page.keyboard.press('o')
    await expect(page.locator('.hint-pill')).toContainText('Drag to orbit')
    const on = await app.world(1, 1)
    await app.drag(on, { x: on.x + 30, y: on.y + 900 })
    expect(await app.hud('EL')).toBe('90°')
    await app.drag({ x: on.x, y: 500 }, { x: on.x, y: -900 })
    expect(await app.hud('EL')).toBe('12°')
    await page.keyboard.press('o')
    await expect(app.tool('Select')).toHaveAttribute('aria-pressed', 'true')
    expect((await app.saved())!.nodes[0]).toMatchObject({ x: 0, y: 0 })
  })

  test('the view cube snaps to standard views', async ({ page, app }) => {
    await page.locator('.viewcube [data-face="top"]').click()
    await expect.poll(() => app.hud('EL')).toBe('90°')
    await page.keyboard.press('3')
    await expect.poll(() => app.hud('EL')).toBe('35°')
    await page.locator('.viewcube [data-face="y"]').click()
    await expect.poll(() => app.hud('AZ')).toBe('000°')
    await expect.poll(() => app.hud('EL')).toBe('22°')
  })

  test('zooms with the buttons, the keyboard and the wheel, within limits', async ({ page, app }) => {
    const start = await zoom(page)
    await page.getByRole('button', { name: 'Zoom in' }).click()
    await expect.poll(() => zoom(page)).toBeGreaterThan(start)
    await pct(page).click()
    await expect(pct(page)).toHaveText(/^100%/)
    await page.keyboard.press('-')
    await expect.poll(() => zoom(page)).toBe(77)
    await page.keyboard.press('f')
    await expect.poll(() => zoom(page)).toBe(start)

    // the wheel zooms about the cursor: the point under it stays put
    const at = await app.world(1, 1)
    await page.mouse.move(at.x, at.y)
    await app.notches(-3)
    await expect.poll(() => zoom(page)).toBeGreaterThan(start + 20)
    await page.waitForTimeout(400)
    const after = await app.world(1, 1)
    expect(Math.abs(after.x - at.x)).toBeLessThan(2)
    expect(Math.abs(after.y - at.y)).toBeLessThan(2)

    // the limits: the keyboard takes it most of the way, the wheel to the stop
    for (let i = 0; i < 6; i++) { await page.keyboard.press('+'); await page.waitForTimeout(220) }
    await app.notches(-6)
    await expect.poll(() => zoom(page)).toBe(400)
    for (let i = 0; i < 13; i++) { await page.keyboard.press('-'); await page.waitForTimeout(220) }
    await app.notches(6)
    await expect.poll(() => zoom(page)).toBe(15)
  })

  test('fit frames the selection, then everything', async ({ page, app }) => {
    const all = await zoom(page)
    await app.pick('b')
    await app.selBar().getByRole('button', { name: 'Focus' }).click()
    await expect.poll(() => zoom(page)).toBeGreaterThan(all)
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Fit', exact: true }).click()
    await expect.poll(() => zoom(page)).toBe(all)
    // everything is inside the visible canvas again
    const box = (await page.locator('.canvas-svg').boundingBox())!
    for (const id of ['a', 'b', 'c']) {
      const b = (await app.node(id).boundingBox())!
      expect(b.x).toBeGreaterThan(box.x)
      expect(b.x + b.width).toBeLessThan(box.x + box.width)
      expect(b.y).toBeGreaterThan(box.y)
      expect(b.y + b.height).toBeLessThan(box.y + box.height)
    }
  })

  test('the minimap moves the view, and the cursor read-out follows the pointer', async ({ page, app }) => {
    const p = await app.world(7, 1)
    await page.mouse.move(p.x - 5, p.y)
    await page.mouse.move(p.x, p.y)
    await expect(page.locator('.hud-cell.wide')).toHaveText(/X \+007\s+Y \+001/)
    const q = await app.world(-3, -2)
    await page.mouse.move(q.x, q.y)
    await expect(page.locator('.hud-cell.wide')).toHaveText(/X -003\s+Y -002/)

    const before = await app.corner('a')
    const map = (await page.locator('.minimap').boundingBox())!
    await page.mouse.click(map.x + map.width * 0.2, map.y + map.height * 0.8)
    const after = await app.corner('a')
    expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeGreaterThan(40)
  })

  test('grid, names and traffic toggles change the canvas', async ({ page, app }) => {
    await page.keyboard.press('g')
    await expect(page.locator('.canvas-svg rect[fill="url(#grid)"]')).toHaveCount(0)
    await page.keyboard.press('g')
    await expect(page.locator('.canvas-svg rect[fill="url(#grid)"]')).toHaveCount(1)
    await expect(page.locator('.canvas-svg .nd-label')).toHaveCount(3)
    await page.keyboard.press('l')
    await expect(page.locator('.canvas-svg .nd-label')).toHaveCount(0)
    await app.tool('Component names').click()
    await expect(page.locator('.canvas-svg .nd-label')).toHaveCount(3)

    await page.keyboard.press('c')
    await app.drag(await app.world(1, 1), await app.world(7, 1))
    await expect(page.locator('.canvas-svg .edge-flow')).toHaveCount(1)
    await app.tool('Traffic animation').click()
    await expect(page.locator('.canvas-svg .edge-flow')).toHaveCount(0)
    await page.reload()
    await app.ready()
    await expect(page.locator('.canvas-svg .edge')).toHaveCount(1)
  })

  test('panels hide and show with their keys and buttons', async ({ page }) => {
    await expect(page.locator('.panel.palette')).toBeVisible()
    await page.keyboard.press('[')
    await expect(page.locator('.panel.palette')).toHaveCount(0)
    await page.keyboard.press(']')
    await expect(page.locator('.panel.right')).toHaveCount(0)
    await page.keyboard.press('\\')
    await expect(page.locator('.panel.palette')).toBeVisible()
    await expect(page.locator('.panel.right')).toBeVisible()
    await page.getByRole('button', { name: 'Inspector' }).click()
    await expect(page.locator('.panel.right')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Inspector' })).toHaveAttribute('aria-pressed', 'false')
  })
})
