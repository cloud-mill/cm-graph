import type { Page } from '@playwright/test'
import { TRIO, expect, test as base } from './fixtures'
import { Fingers } from './touch'

/** Connections edited with fingers, through the browser's own touch input. */
const test = base.extend<{ fingers: Fingers }>({
  fingers: async ({ page, browserName }, use) => { await use(new Fingers(page, browserName === 'chromium')) },
})
const dock = (page: Page) => page.locator('.dock')
const linked = () => { const d = TRIO(); d.edges.push({ id: 'e', from: 'a', to: 'b', style: 'solid', arrow: 'end', width: 2 }); return d }
const middle = (page: Page) => page.evaluate(() => {
  const el = document.querySelector('.edge-hit[data-id="e"]') as SVGPathElement, m = el.getScreenCTM()!, p = el.getPointAtLength(el.getTotalLength() / 2)
  return { x: p.x * m.a + p.y * m.c + m.e, y: p.x * m.b + p.y * m.d + m.f }
})
const centre = async (page: Page, name: string) => { const b = (await page.locator(`[data-handle="${name}"]`).last().boundingBox())!; return { x: b.x + b.width / 2, y: b.y + b.height / 2 } }
const E = async (app: any) => (await app.settled()).edges[0]

test.describe('phone: connections', () => {
  test.beforeEach(async ({ app }) => { await app.open(linked()) })

  test('a tap near a line selects it: the target is finger-sized, and the dock says what it joins', async ({ page, fingers }) => {
    const m = await middle(page)
    await fingers.tap({ x: m.x, y: m.y + 11 }) // a thumb is not a cursor: 11 px off the line still counts
    await expect(dock(page).locator('.dock-name b')).toHaveText('Connection')
    await expect(dock(page).locator('.dock-name i')).toHaveText('web-1 connects to orders-db')
    // by name, since a phone held sideways shows these as icons only
    expect(await dock(page).locator('.dock-btn').evaluateAll((els) => els.map((el) => el.getAttribute('aria-label')))).toEqual(['Edit', 'Follow', 'Bend', 'Reverse', 'Delete'])
    // every handle has an invisible target a finger can land on
    const r = await page.locator('circle[data-handle="ea"][fill="transparent"]').evaluate((el) => el.getBoundingClientRect().width)
    expect(r).toBeGreaterThanOrEqual(32)
  })

  test('Bend puts a waypoint on the line and a finger drags it, without moving the view', async ({ page, app, fingers }) => {
    await fingers.tap(await middle(page))
    await dock(page).getByRole('button', { name: 'Bend' }).tap()
    expect((await E(app)).via).toHaveLength(1)
    const before = await app.corner('a'), w = await centre(page, 'w0'), d = await app.cells(0, 3)
    await fingers.drag(w, { x: w.x + d.x, y: w.y + d.y })
    const via = (await E(app)).via
    expect(via).toHaveLength(1)
    expect(via[0][1]).toBe(4) // three cells from the line it started on
    expect(await app.corner('a')).toEqual(before) // the canvas did not pan under the finger
    // one step back takes the drag away, another the waypoint
    await page.getByRole('button', { name: 'Undo' }).tap()
    expect((await E(app)).via[0][1]).toBe(1)
    await page.getByRole('button', { name: 'Undo' }).tap()
    expect((await E(app)).via).toBeUndefined()
  })

  test('a finger drags an end onto another component to reconnect it', async ({ page, app, fingers }) => {
    await fingers.tap(await middle(page))
    const end = await centre(page, 'eb'), c = (await app.node('c').locator('.nd-body').boundingBox())!
    await fingers.drag(end, { x: c.x + c.width / 2, y: c.y + c.height * 0.6 }, { steps: 14 })
    expect(await E(app)).toMatchObject({ from: 'a', to: 'c' })
    await expect(dock(page).locator('.dock-name i')).toHaveText('web-1 connects to assets')
  })

  test('Follow lights the flow, the banner stays clear of the corner controls, and Back steps out of it', async ({ page, fingers }) => {
    await fingers.tap(await middle(page))
    await dock(page).getByRole('button', { name: 'Follow' }).tap()
    const bar = page.locator('.trace-bar')
    await expect(bar).toContainText('Following web-1 connects to orders-db')
    await expect(page.locator('.nd.off')).toHaveCount(1) // the third component steps back
    const b = (await bar.boundingBox())!, vp = page.viewportSize()!
    expect(b.x).toBeGreaterThanOrEqual(0); expect(b.x + b.width).toBeLessThanOrEqual(vp.width)
    for (const sel of ['.hud-cell.cost', '.viewcube svg']) {
      const o = await page.locator(sel).first().boundingBox()
      if (o) expect(b.x + b.width <= o.x || o.x + o.width <= b.x || b.y + b.height <= o.y || o.y + o.height <= b.y, `banner clear of ${sel}`).toBe(true)
    }
    await page.goBack()
    await expect(bar).toHaveCount(0)
    await expect(page.locator('.canvas-svg')).toBeVisible()
    await expect(page.locator('.nd.off')).toHaveCount(0)
  })

  test('the inspector sheet says what the connection is and takes a protocol and port', async ({ page, app, fingers }) => {
    await fingers.tap(await middle(page))
    await dock(page).getByRole('button', { name: 'Edit' }).tap()
    const sheet = page.getByRole('dialog', { name: 'Inspector' })
    await expect(sheet.locator('.insp-sub').first()).toHaveText('web-1 connects to orders-db')
    await sheet.getByRole('combobox', { name: 'Relationship' }).tap()
    await page.getByRole('option', { name: 'Data' }).tap()
    await sheet.getByLabel('Port', { exact: true }).fill('5432')
    await page.keyboard.press('Enter')
    expect(await E(app)).toMatchObject({ kind: 'data', port: '5432' })
    await expect(page.locator('.edge text')).toHaveText('5432')
    // nothing in the sheet spills sideways
    expect(await sheet.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0)
  })

  test('pinching and panning with a line selected still move the camera, not the line', async ({ page, app, fingers, browserName }) => {
    test.skip(browserName !== 'chromium', 'needs real multi-touch')
    await fingers.tap(await middle(page))
    const before = JSON.stringify(await E(app))
    const vp = page.viewportSize()!
    await fingers.pinch({ x: vp.width / 2, y: vp.height * 0.3 }, 80, 160)
    await fingers.drag({ x: 30, y: vp.height * 0.25 }, { x: 90, y: vp.height * 0.3 })
    expect(JSON.stringify(await E(app))).toBe(before)
    await expect(dock(page).locator('.dock-name b')).toHaveText('Connection')
  })
})
