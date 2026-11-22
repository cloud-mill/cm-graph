import AxeBuilder from '@axe-core/playwright'
import { TRIO, expect, makeDoc, test as base } from './fixtures'
import { Fingers } from './touch'

const test = base.extend<{ fingers: Fingers }>({
  fingers: async ({ page, browserName }, use) => { await use(new Fingers(page, browserName === 'chromium')) },
})

const HOLD = 560
const dock = (page: import('@playwright/test').Page) => page.locator('.dock')
const landscape = () => test.info().project.name === 'landscape'

/** a finger is reported in whole pixels, so what it carries ends within a fraction of a cell of where it was aimed, not on it */
const near = (n: { x: number; y: number } | undefined, x: number, y: number, within = 0.15) => { expect(Math.abs(n!.x - x), `x ${n!.x} near ${x}`).toBeLessThan(within); expect(Math.abs(n!.y - y), `y ${n!.y} near ${y}`).toBeLessThan(within) }

test.describe('phone: layout', () => {
  test('the editor is a phone app, not a shrunken desktop', async ({ page, app }) => {
    await app.open(TRIO())
    await expect(page.locator('html')).toHaveAttribute('data-phone', '')
    await expect(dock(page).getByRole('button', { name: 'Add', exact: true })).toBeVisible()
    await expect(page.locator('.toolbar, .panel.palette, .panel.right, .zoom, .cmdk-trigger')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Undo' })).toBeVisible()
    // nothing scrolls or spills
    const doc = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, sh: document.documentElement.scrollHeight, ch: document.documentElement.clientHeight }))
    expect(doc.sw).toBeLessThanOrEqual(doc.cw)
    expect(doc.sh).toBeLessThanOrEqual(doc.ch)
    // every control is big enough for a thumb
    const small = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.topbar button, .dock button, .fab')].filter((el) => el.offsetParent).map((el) => ({ n: el.getAttribute('aria-label') ?? el.innerText, r: el.getBoundingClientRect() })).filter((x) => x.r.width < 40 || x.r.height < 34).map((x) => `${x.n} ${Math.round(x.r.width)}×${Math.round(x.r.height)}`))
    expect(small).toEqual([])
    // the whole diagram is framed in the part of the canvas that is not under a bar
    const vp = page.viewportSize()!
    const top = (await page.locator('.topbar').boundingBox())!, bar = (await dock(page).locator('.dock-row').boundingBox())!
    for (const id of ['a', 'b', 'c']) {
      const b = (await app.node(id).locator('.nd-body').boundingBox())!
      expect(b.x).toBeGreaterThanOrEqual(0); expect(b.x + b.width).toBeLessThanOrEqual(vp.width)
      expect(b.y).toBeGreaterThanOrEqual(top.y + top.height); expect(b.y + b.height).toBeLessThanOrEqual(bar.y)
    }
  })

  test('the dashboard reads as one column with a flickable row of templates', async ({ page, app }) => {
    await app.seed(TRIO())
    await page.reload()
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0)
    await expect(page.getByRole('button', { name: 'Import from Terraform' })).toBeVisible()
    const row = page.locator('#templates .grid.wide')
    await row.scrollIntoViewIfNeeded()
    const before = await row.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth }))
    expect(before.sw).toBeGreaterThan(before.cw * 2) // the row scrolls, the page does not
    await row.evaluate((el) => el.scrollBy({ left: el.clientWidth }))
    await expect(page.getByRole('button', { name: 'Start from the Serverless API template' })).toBeInViewport()
    // a stored blueprint's own actions are there without hovering
    await page.locator('#blueprints').scrollIntoViewIfNeeded()
    await expect(page.locator('.card.doc').getByRole('button', { name: 'Duplicate' })).toBeVisible()
    await page.locator('.card.doc').getByRole('button', { name: 'Open E2E blueprint' }).tap()
    await app.ready()
  })

  test('passes automated accessibility checks, sheets included', async ({ page, app, fingers }) => {
    await app.open(TRIO())
    const audit = async () => (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id + ': ' + v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | '))
    expect(await audit()).toEqual([])
    await fingers.tap(await app.world(1, 1))
    expect(await audit()).toEqual([])
    await dock(page).getByRole('button', { name: 'Edit' }).tap()
    await expect(page.getByRole('dialog', { name: 'Inspector' })).toBeVisible()
    expect(await audit()).toEqual([])
  })
})

test.describe('phone: canvas gestures', () => {
  test.beforeEach(async ({ app }) => { await app.open(TRIO()) })

  test('a tap selects, a tap on the ground lets go', async ({ page, app, fingers }) => {
    await fingers.tap(await app.world(1, 1))
    await expect(dock(page).locator('.dock-name b')).toHaveText('web-1')
    await expect(dock(page).locator('.dock-info em')).toContainText('/mo')
    await fingers.tap(await app.world(7, 1))
    await expect(dock(page).locator('.dock-name b')).toHaveText('orders-db')
    await fingers.tap(await app.world(4, 4))
    await expect(dock(page).getByRole('button', { name: 'Add', exact: true })).toBeVisible()
  })

  test('dragging across a component pans the view and moves nothing', async ({ app, fingers }) => {
    const before = await app.corner('a'), from = await app.world(1, 1)
    await fingers.drag(from, { x: from.x + 70, y: from.y - 50 })
    const after = await app.corner('a')
    expect(after.x - before.x).toBeCloseTo(70, 0)
    expect(after.y - before.y).toBeCloseTo(-50, 0)
    expect((await app.saved())!.nodes[0]).toMatchObject({ x: 0, y: 0 })
  })

  test('a selected component is dragged as far as the finger goes, with one undo', async ({ page, app, fingers }) => {
    await fingers.tap(await app.world(1, 1))
    const from = await app.world(1, 1), d = await app.cells(2, -1)
    await fingers.drag(from, { x: from.x + d.x, y: from.y + d.y })
    const put = (await app.settled()).nodes[0]
    near(put, 2, -1)
    await page.getByRole('button', { name: 'Undo' }).tap()
    expect((await app.settled()).nodes[0]).toMatchObject({ x: 0, y: 0 })
    await page.getByRole('button', { name: 'Redo' }).tap()
    // back exactly where it was put, not merely near it
    expect((await app.settled()).nodes[0]).toMatchObject({ x: put.x, y: put.y })
  })

  test('press and hold picks a component up and carries it in one motion', async ({ page, app, fingers }) => {
    const from = await app.world(7, 1), d = await app.cells(0, 3)
    await fingers.drag(from, { x: from.x + d.x, y: from.y + d.y }, { hold: HOLD })
    near((await app.settled()).nodes[1], 6, 3)
    await expect(dock(page).locator('.dock-name b')).toHaveText('orders-db')
  })

  test('with snapping on, alignment guides appear while a component lines up with another', async ({ page, app, fingers }) => {
    // on whole cells a finger can bring two components exactly level; without snapping it would have to be right to the pixel
    await page.keyboard.press('s')
    await fingers.tap(await app.world(1, 7))
    const from = await app.world(1, 7), d = await app.cells(6, 0)
    // carry c six cells along, to sit in line with b, and look before letting go
    await (fingers as any).send('touchStart', [from])
    for (let i = 1; i <= 12; i++) { await fingers.move({ x: from.x + (d.x * i) / 12, y: from.y + (d.y * i) / 12 }); await page.waitForTimeout(12) }
    await expect(page.locator('.canvas-svg .guide')).toHaveCount(1)
    await fingers.lift()
    await expect(page.locator('.canvas-svg .guide')).toHaveCount(0)
    expect((await app.settled()).nodes[2]).toMatchObject({ x: 6, y: 6 })
  })

  test('press and hold on bare ground opens the menu', async ({ page, app, fingers }) => {
    await fingers.press(await app.world(4, 4), HOLD)
    const menu = page.locator('.ctx-menu')
    await expect(menu).toBeVisible()
    const box = (await menu.boundingBox())!, vp = page.viewportSize()!
    expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(vp.width)
    expect(box.y + box.height).toBeLessThanOrEqual(vp.height)
    await menu.getByRole('button', { name: 'Select all' }).tap()
    await expect(dock(page).locator('.dock-name b')).toHaveText('3 selected')
  })

  test('pinching zooms about the fingers and never zooms or scrolls the page', async ({ page, app, fingers }) => {
    const a0 = await app.world(0, 0), b0 = await app.world(6, 0)
    const size0 = Math.hypot(b0.x - a0.x, b0.y - a0.y)
    const at = await app.world(3, 3)
    await fingers.pinch(at, 80, 200)
    const a1 = await app.world(0, 0), b1 = await app.world(6, 0)
    expect(Math.hypot(b1.x - a1.x, b1.y - a1.y) / size0).toBeCloseTo(2.5, 1)
    // the ground point that was between the fingers is still between them
    const still = await app.world(3, 3)
    expect(Math.abs(still.x - at.x)).toBeLessThan(2)
    expect(Math.abs(still.y - at.y)).toBeLessThan(2)
    const pg = await page.evaluate(() => ({ scale: window.visualViewport?.scale ?? 1, x: window.scrollX, y: window.scrollY }))
    expect(pg).toEqual({ scale: 1, x: 0, y: 0 })
    // and back out, clamped at the limits rather than flipping or vanishing
    await fingers.pinch(at, 220, 20)
    await fingers.pinch(at, 220, 20)
    await fingers.pinch(at, 220, 20)
    const a2 = await app.world(0, 0), b2 = await app.world(6, 0)
    expect(Math.hypot(b2.x - a2.x, b2.y - a2.y)).toBeGreaterThan(20)
    expect((await app.saved())!.nodes.map((n) => [n.x, n.y])).toEqual([[0, 0], [6, 0], [0, 6]])
  })

  test('two fingers moving together pan, and a finger left down afterwards carries on panning', async ({ page, app, fingers }) => {
    const before = await app.corner('a'), at = await app.world(3, 3)
    await fingers.pinch(at, 120, 120, { shift: { x: 60, y: 40 } })
    const after = await app.corner('a')
    expect(after.x - before.x).toBeCloseTo(60, 0)
    expect(after.y - before.y).toBeCloseTo(40, 0)
    // lifting one finger of the two: sent as pointer events, the only way to lift exactly one
    const moved = await page.evaluate(async ([x, y]) => {
      const svg = document.querySelector('.canvas-svg')!
      const ev = (type: string, id: number, cx: number, cy: number) => svg.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', clientX: cx, clientY: cy, bubbles: true, cancelable: true, button: 0, buttons: type === 'pointerup' ? 0 : 1 }))
      const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
      const corner = () => { const r = document.querySelector('[data-id="a"] .nd-body')!.getBoundingClientRect(); return [r.x, r.y] }
      ev('pointerdown', 31, x - 60, y); ev('pointerdown', 32, x + 60, y)
      ev('pointermove', 31, x - 40, y + 30); ev('pointermove', 32, x + 80, y + 30)
      await frame()
      const both = corner()
      ev('pointerup', 32, x + 80, y + 30)
      await frame()
      const one = corner()
      ev('pointermove', 31, x + 10, y + 60)
      await frame()
      const panned = corner()
      ev('pointerup', 31, x + 10, y + 60)
      return { jump: [one[0] - both[0], one[1] - both[1]], pan: [panned[0] - one[0], panned[1] - one[1]] }
    }, [at.x, at.y])
    expect(moved.jump[0]).toBeCloseTo(0, 0); expect(moved.jump[1]).toBeCloseTo(0, 0)
    expect(moved.pan[0]).toBeCloseTo(50, 0); expect(moved.pan[1]).toBeCloseTo(30, 0)
    // nothing was selected or moved by any of it
    await expect(dock(page).getByRole('button', { name: 'Add', exact: true })).toBeVisible()
    expect((await app.settled()).nodes.map((n) => [n.x, n.y])).toEqual([[0, 0], [6, 0], [0, 6]])
  })

  /** which way the line from a to b points on screen, in degrees, clockwise positive */
  const bearing = async (app: any) => { const a = await app.corner('a'), b = await app.corner('b'); return (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI }
  const turned = (from: number, to: number) => ((to - from + 540) % 360) - 180

  test('a twist turns the scene the way the fingers turn, about the point between them, and it stays put', async ({ page, app, fingers }) => {
    for (const dir of [1, -1]) {
      const before = await bearing(app), at = await app.world(3, 3)
      await fingers.pinch(at, 170, 170, { twist: dir * 60, steps: 24 })
      const after = await bearing(app)
      // clockwise fingers, clockwise scene, by most of the twist (a little is spent making sure it is meant)
      expect(turned(before, after) * dir).toBeGreaterThan(30)
      expect(turned(before, after) * dir).toBeLessThan(75)
      // the ground between the fingers did not slide away
      const still = await app.world(3, 3)
      expect(Math.hypot(still.x - at.x, still.y - at.y)).toBeLessThan(3)
      // and nothing snaps or drifts once the fingers are off
      await page.waitForTimeout(450)
      expect(await bearing(app)).toBeCloseTo(after, 1)
    }
    // the blueprint itself is untouched: turning is a view change
    await expect(page.locator('.save-dot')).toHaveAttribute('aria-label', 'Saved')
    // editing still lands on the right cells from the new angle
    await fingers.tap(await app.world(1, 1))
    const from = await app.world(1, 1), d = await app.cells(1, 2)
    await fingers.drag(from, { x: from.x + d.x, y: from.y + d.y })
    near((await app.settled()).nodes[0], 1, 2)
  })

  test('an ordinary pinch never turns the view, however the fingers wobble', async ({ app, fingers }) => {
    const before = await bearing(app)
    await fingers.pinch(await app.world(3, 3), 90, 220, { twist: 6 })
    await fingers.pinch(await app.world(3, 3), 220, 100, { twist: -6 })
    expect(await bearing(app)).toBeCloseTo(before, 3)
  })

  test('two fingers sliding up and down tilt the view, and the reset button brings it home', async ({ page, app, fingers }) => {
    const vp = page.viewportSize()!
    const at = { x: vp.width / 2, y: vp.height * 0.55 }
    const depth = async () => { const a = await app.corner('a'), c = await app.corner('c'), b = await app.corner('b'); return Math.abs(c.y - a.y) / Math.hypot(b.x - a.x, b.y - a.y) }
    const home = await depth(), bear = await bearing(app)
    await expect(page.getByRole('button', { name: 'Reset view' })).toHaveCount(0)
    // up: the camera drops towards the horizon and the ground flattens
    await fingers.pinch(at, 110, 110, { shift: { x: 0, y: -70 }, steps: 14 })
    const low = await depth()
    expect(low).toBeLessThan(home * 0.75)
    // down, a long way: straight overhead, where the grid is square
    await fingers.pinch(at, 110, 110, { shift: { x: 0, y: Math.min(300, vp.height * 0.4) }, steps: 20 })
    await fingers.pinch(at, 110, 110, { shift: { x: 0, y: Math.min(300, vp.height * 0.4) }, steps: 20 })
    await expect(page.getByRole('button', { name: 'Switch to 3D view' })).toBeVisible()
    // one tap undoes all of it, even landing the instant the fingers leave the glass
    await page.getByRole('button', { name: 'Reset view' }).tap()
    await expect.poll(depth).toBeCloseTo(home, 2)
    await expect.poll(() => bearing(app)).toBeCloseTo(bear, 1)
    await expect(page.getByRole('button', { name: 'Reset view' })).toHaveCount(0)
    expect((await app.settled()).nodes.map((n) => [n.x, n.y])).toEqual([[0, 0], [6, 0], [0, 6]])
  })

  test('double tap zooms in, double tap and slide zooms by thumb, two fingers tapped zoom out', async ({ page, app, fingers }) => {
    const size = async () => { const a = await app.corner('a'), b = await app.corner('b'); return Math.hypot(b.x - a.x, b.y - a.y) }
    const settle = async () => { let last = -1; await expect.poll(async () => { const s = await size(); const same = Math.abs(s - last) < 0.01; last = s; return same }, { intervals: [120] }).toBe(true); return last }
    const s0 = await settle(), at = await app.world(3, 3)
    await fingers.doubleTap(at)
    const s1 = await settle()
    expect(s1 / s0).toBeCloseTo(2, 1)
    const still = await app.world(3, 3)
    expect(Math.hypot(still.x - at.x, still.y - at.y)).toBeLessThan(3)
    await fingers.twoTap({ x: at.x - 50, y: at.y }, { x: at.x + 50, y: at.y })
    const s2 = await settle()
    expect(s2 / s1).toBeCloseTo(0.5, 1)
    await fingers.doubleTap(await app.world(3, 3), -60)
    const s3 = await settle()
    expect(s3).toBeLessThan(s2 * 0.75)
    // none of that selected or changed anything
    await expect(dock(page).getByRole('button', { name: 'Add', exact: true })).toBeVisible()
    expect((await app.settled()).nodes.map((n) => [n.x, n.y])).toEqual([[0, 0], [6, 0], [0, 6]])
  })

  test('a button tapped while the view is still coasting always answers', async ({ page, fingers }) => {
    // browsers swallow the tap that follows a flick; the dock must not lose it
    const vp = page.viewportSize()!
    const from = { x: vp.width * 0.3, y: vp.height * 0.45 }
    for (let i = 0; i < 3; i++) {
      await fingers.drag(from, { x: from.x + (i % 2 ? -1 : 1) * vp.width * 0.4, y: from.y }, { steps: 4, flick: true })
      await page.waitForTimeout(150)
      const add = (await dock(page).getByRole('button', { name: 'Add', exact: true }).boundingBox())!
      await fingers.press({ x: add.x + add.width / 2, y: add.y + add.height / 2 }, 50)
      const sheet = page.getByRole('dialog', { name: 'Library' })
      await expect(sheet).toBeVisible()
      await page.waitForTimeout(350)
      // and exactly once: the sheet is still open, not toggled twice
      await expect(sheet).toBeVisible()
      await sheet.getByRole('button', { name: 'Close' }).tap()
      await expect(sheet).toHaveCount(0)
    }
  })

  test('a flick coasts and a touch stops it; a lost diagram is one tap away', async ({ page, app, fingers }) => {
    const vp = page.viewportSize()!
    const from = { x: vp.width * 0.3, y: vp.height * 0.45 }
    // a flick is about timing, and a busy machine can stretch a synthetic one into a slow drag: allow another go
    await expect(async () => {
      const a0 = await app.corner('a')
      await fingers.drag(from, { x: from.x + 150, y: from.y }, { steps: 5, flick: true })
      const a1 = await app.corner('a')
      await page.waitForTimeout(700)
      const a2 = await app.corner('a')
      expect(a1.x - a0.x).toBeGreaterThan(140)
      expect(a2.x).toBeGreaterThan(a1.x + 20) // it kept going after the finger left
      await fingers.drag({ x: from.x + 150, y: from.y }, from) // back where it started, at rest
    }).toPass({ intervals: [300], timeout: 20000 })
    await page.waitForTimeout(1200)
    const a3 = await app.corner('a')
    await page.waitForTimeout(200)
    expect((await app.corner('a')).x).toBe(a3.x) // and it has come to rest
    // throw the diagram right off the screen
    for (let i = 0; i < 4; i++) await fingers.drag(from, { x: from.x + vp.width * 0.6, y: from.y }, { steps: 4, flick: true })
    const back = page.getByRole('button', { name: 'Back to diagram' })
    await expect(back).toBeVisible()
    await back.tap()
    await expect(back).toHaveCount(0)
    await expect.poll(async () => { const b = (await app.node('a').locator('.nd-body').boundingBox())!; return b.x >= 0 && b.x + b.width <= vp.width }).toBe(true)
  })

  test('a second finger turns a move in progress into a pinch without losing the component', async ({ app, fingers }) => {
    await fingers.tap(await app.world(1, 1))
    const from = await app.world(1, 1)
    await (fingers as any).send('touchStart', [from])
    await fingers.move({ x: from.x + 30, y: from.y + 10 })
    await (fingers as any).send('touchStart', [{ x: from.x + 30, y: from.y + 10 }, { x: from.x + 140, y: from.y + 90 }])
    await (fingers as any).send('touchMove', [{ x: from.x + 10, y: from.y }, { x: from.x + 170, y: from.y + 110 }])
    await fingers.lift()
    const doc = await app.settled()
    expect(doc.nodes).toHaveLength(3)
    // it was left where the first finger had carried it when the second came down
    expect(doc.nodes[0].x !== 0 || doc.nodes[0].y !== 0).toBe(true)
    expect(Number.isFinite(doc.nodes[0].x) && Number.isFinite(doc.nodes[0].y)).toBe(true)
  })
})

test.describe('phone: building a diagram', () => {
  test('adds components from the library sheet with a tap', async ({ page, app }) => {
    await app.newBlueprint()
    await expect(page.getByText('Tap Add below to place your first component.')).toBeVisible()
    await dock(page).getByRole('button', { name: 'Add', exact: true }).tap()
    const sheet = page.getByRole('dialog', { name: 'Library' })
    await expect(sheet).toBeVisible()
    await sheet.locator('.pal-item[title="Virtual machine: EC2"]').tap()
    await expect(sheet).toHaveCount(0)
    await expect(app.nodes()).toHaveCount(1)
    await expect(dock(page).locator('.dock-name b')).toHaveText('ec2-1')
    // scrolling the list is scrolling, not adding
    await page.getByRole('button', { name: 'Deselect' }).tap()
    await dock(page).getByRole('button', { name: 'Add', exact: true }).tap()
    await sheet.locator('.palette-scroll').evaluate((el) => el.scrollBy(0, 600))
    await expect(app.nodes()).toHaveCount(1)
    await sheet.getByLabel('Search components').fill('queue')
    await sheet.locator('.pal-item').first().tap()
    await expect(app.nodes()).toHaveCount(2)
    const doc = await app.settled()
    expect(Math.abs(doc.nodes[0].x - doc.nodes[1].x) >= 2 || Math.abs(doc.nodes[0].y - doc.nodes[1].y) >= 2).toBe(true)
    // both sit in the visible canvas
    const vp = page.viewportSize()!
    for (const n of await app.nodes().all()) { const b = (await n.boundingBox())!; expect(b.x).toBeGreaterThan(-1); expect(b.x + b.width).toBeLessThan(vp.width + 1) }
  })

  test('connects two components with two taps from the selection', async ({ page, app, fingers }) => {
    await app.open(TRIO())
    await fingers.tap(await app.world(1, 1))
    await dock(page).getByRole('button', { name: 'Connect' }).tap()
    await expect(dock(page).getByRole('status')).toHaveText('Now tap what web-1 connects to')
    await expect(page.locator('.canvas-svg .link-from')).toHaveCount(1)
    await fingers.tap(await app.world(7, 1))
    await expect(app.edges()).toHaveCount(1)
    await expect(dock(page).locator('.dock-name b')).toHaveText('Connection')
    expect((await app.settled()).edges).toMatchObject([{ from: 'a', to: 'b' }])
    await dock(page).getByRole('button', { name: 'Reverse' }).tap()
    expect((await app.settled()).edges).toMatchObject([{ from: 'b', to: 'a' }])
  })

  test('the connect tool: first tap, second tap, or cancel', async ({ page, app, fingers }) => {
    await app.open(TRIO())
    await dock(page).getByRole('button', { name: 'Connect' }).tap()
    await expect(dock(page).getByRole('status')).toHaveText('Tap a component, then the one it talks to')
    await fingers.tap(await app.world(1, 7))
    await expect(dock(page).getByRole('status')).toHaveText('Now tap what assets connects to')
    await fingers.tap(await app.world(1, 1))
    await expect(app.edges()).toHaveCount(1)
    await dock(page).getByRole('button', { name: 'Connect' }).isVisible()
    // the same pair again is refused, politely
    await page.getByRole('button', { name: 'Deselect' }).tap()
    await dock(page).getByRole('button', { name: 'Connect' }).tap()
    await fingers.tap(await app.world(1, 1))
    await fingers.tap(await app.world(1, 7))
    await expect(app.toast('already connected')).toBeVisible()
    await expect(app.edges()).toHaveCount(1)
    // the tool has let go, and the line that already joins them is the one in hand
    await expect(dock(page).getByText('Connection', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Deselect' }).tap()
    await expect(dock(page).getByRole('button', { name: 'Add', exact: true })).toBeVisible()
    await dock(page).getByRole('button', { name: 'Area' }).tap()
    await dock(page).getByRole('button', { name: 'Cancel' }).tap()
    await expect(dock(page).getByRole('button', { name: 'Add', exact: true })).toBeVisible()
  })

  test('edits a component in the inspector sheet while the canvas stays live', async ({ page, app, fingers }) => {
    await app.open(TRIO())
    await fingers.tap(await app.world(1, 1))
    const price = await dock(page).locator('.dock-info em').innerText()
    await dock(page).getByRole('button', { name: 'Edit' }).tap()
    const sheet = page.getByRole('dialog', { name: 'Inspector' })
    await expect(sheet).toBeVisible()
    // the component being edited is still in view above the sheet
    const top = (await sheet.boundingBox())!
    if (!landscape()) { const n = (await app.node('a').locator('.nd-body').boundingBox())!; expect(n.y + n.height).toBeLessThanOrEqual(top.y + 2) }
    await sheet.getByLabel('Instances').fill('5')
    await sheet.getByRole('combobox', { name: 'Family' }).tap()
    await page.getByRole('option', { name: 'c5', exact: true }).tap()
    expect((await app.settled()).nodes[0].props).toMatchObject({ count: 5, family: 'c5' })
    await sheet.getByRole('tab', { name: /Budget/ }).tap()
    await expect(sheet.locator('.budget-center .big')).toBeVisible()
    await sheet.getByRole('tab', { name: /Advisor/ }).tap()
    await expect(sheet.locator('.score')).toBeVisible()
    await sheet.getByRole('button', { name: 'Close inspector' }).tap()
    await expect(sheet).toHaveCount(0)
    expect(await dock(page).locator('.dock-info em').innerText()).not.toBe(price)
  })

  test('a sheet can be pulled taller and flicked away from its handle', async ({ page, app, fingers }) => {
    test.skip(landscape(), 'sideways, sheets dock to the edge and close with their button')
    await app.open(TRIO())
    await page.locator('.hud-cell.cost').tap()
    const sheet = page.getByRole('dialog', { name: 'Inspector' })
    await expect(sheet.getByRole('tab', { selected: true })).toHaveText('Budget')
    // a sheet is only taken hold of once it has stopped moving
    const rest = async () => {
      let last = -1
      await expect.poll(async () => { const y = Math.round((await sheet.boundingBox())!.y); const same = y === last; last = y; return same }, { intervals: [150] }).toBe(true)
      return (await sheet.boundingBox())!
    }
    const h0 = await rest()
    const grip = { x: h0.x + h0.width / 2, y: h0.y + 10 }
    await fingers.drag(grip, { x: grip.x, y: grip.y - 180 })
    await expect.poll(async () => (await sheet.boundingBox())!.height).toBeGreaterThan(h0.height + 80)
    const h1 = await rest()
    // a pull steps it back down, a second sends it away
    await fingers.drag({ x: grip.x, y: h1.y + 10 }, { x: grip.x, y: h1.y + 170 }, { steps: 14 })
    await expect.poll(async () => Math.round((await sheet.boundingBox())!.height)).toBe(Math.round(h0.height))
    const h2 = await rest()
    await fingers.drag({ x: grip.x, y: h2.y + 10 }, { x: grip.x, y: h2.y + 200 }, { steps: 14 })
    await expect(sheet).toHaveCount(0)
    await expect(dock(page).getByRole('button', { name: 'Add', exact: true })).toBeVisible()
  })

  test('selects several, groups them, and deletes with an undo', async ({ page, app, fingers }) => {
    await app.open(TRIO())
    await fingers.tap(await app.world(1, 1))
    await dock(page).getByRole('button', { name: 'More' }).tap()
    await fingers.tap(await app.world(7, 1))
    await fingers.tap(await app.world(1, 7))
    await expect(dock(page).locator('.dock-name b')).toHaveText('3 selected')
    await fingers.tap(await app.world(1, 7)) // tapping one again takes it back out
    await expect(dock(page).locator('.dock-name b')).toHaveText('2 selected')
    await dock(page).getByRole('button', { name: 'Group' }).tap()
    expect((await app.settled()).areas).toMatchObject([{ kind: 'group' }])
    await fingers.tap(await app.world(4, 4))
    await fingers.tap(await app.world(1, 7))
    await dock(page).getByRole('button', { name: 'Delete' }).tap()
    await expect(app.nodes()).toHaveCount(2)
    await page.getByRole('button', { name: 'Undo' }).tap()
    await expect(app.nodes()).toHaveCount(3)
  })

  test('draws an area and drops a label with a finger', async ({ page, app, fingers }) => {
    await app.open(TRIO())
    await dock(page).getByRole('button', { name: 'Area' }).tap()
    await fingers.drag(await app.world(-1, -1), await app.world(3, 3))
    const [area] = (await app.settled()).areas
    expect(area.kind).toBe('vpc')
    near(area, -1, -1)
    near({ x: area.w, y: area.d }, 4, 4, 0.3)
    await expect(dock(page).locator('.dock-name b')).toHaveText('VPC')
    await page.getByRole('button', { name: 'Deselect' }).tap()
    await dock(page).getByRole('button', { name: 'Text' }).tap()
    await fingers.tap(await app.world(4, 5))
    await expect(page.locator('.canvas-svg [data-kind="label"]')).toHaveCount(1)
    await expect(dock(page).locator('.dock-name b')).toHaveText('Label')
  })

  test('everything else is one tap away in the menu: export, share, tidy', async ({ page, app }) => {
    await app.open(TRIO())
    await dock(page).getByRole('button', { name: 'Menu' }).tap()
    const menu = page.getByRole('dialog', { name: 'Command palette' })
    await menu.getByLabel('Search commands').fill('export')
    await menu.locator('.cmdk-item').first().tap()
    const dialog = page.getByRole('dialog', { name: 'Export' })
    await expect(dialog).toBeVisible()
    const vp = page.viewportSize()!
    // once it has finished rising, it sits wholly on screen
    await expect.poll(async () => { const b = (await dialog.boundingBox())!; return b.x >= 0 && b.x + b.width <= vp.width + 1 && b.y >= 0 && b.y + b.height <= vp.height + 1 }).toBe(true)
    // nothing inside it is cut off sideways
    const cut = await dialog.evaluate((el) => [...el.querySelectorAll<HTMLElement>('button, .row, .export-preview')].filter((x) => x.offsetParent && (x.getBoundingClientRect().right > innerWidth + 1 || x.getBoundingClientRect().left < -1)).map((x) => x.className + ':' + x.innerText.slice(0, 20)))
    expect(cut).toEqual([])
    await dialog.getByRole('button', { name: /^Terraform/ }).tap()
    const [dl] = await Promise.all([page.waitForEvent('download'), dialog.getByRole('button', { name: 'Download' }).tap()])
    expect(dl.suggestedFilename()).toBe('main.tf')

    await page.getByRole('button', { name: 'Share' }).tap()
    await expect(page.getByRole('dialog', { name: 'Share blueprint' }).getByLabel('Share link')).toHaveValue(/#\/s\//)
    await page.getByRole('dialog', { name: 'Share blueprint' }).getByRole('button', { name: 'Close' }).tap()
  })

  test('view controls: plan view, fit, and the cost pill', async ({ page, app }) => {
    await app.open(TRIO())
    await page.getByRole('button', { name: 'Switch to plan view' }).tap()
    await expect(page.getByRole('button', { name: 'Switch to 3D view' })).toBeVisible()
    await expect.poll(async () => { const a = await app.corner('a'), b = await app.corner('b'); return Math.abs(a.y - b.y) < 1.5 }).toBe(true)
    await page.getByRole('button', { name: 'Fit to screen' }).tap()
    await expect(page.locator('.hud-cell.cost')).toContainText('$')
  })
})

test.describe('phone: resilience', () => {
  test('turning the phone keeps the diagram framed and the controls reachable', async ({ page, app }) => {
    await app.open(TRIO())
    const vp = page.viewportSize()!
    await page.setViewportSize({ width: vp.height, height: vp.width })
    await expect(dock(page)).toBeVisible()
    await page.getByRole('button', { name: 'Fit to screen' }).tap()
    await expect.poll(async () => {
      const now = page.viewportSize()!
      for (const id of ['a', 'b', 'c']) { const b = (await app.node(id).locator('.nd-body').boundingBox())!; if (b.x < 0 || b.x + b.width > now.width || b.y < 0 || b.y + b.height > now.height) return false }
      return true
    }).toBe(true)
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0)
    await dock(page).getByRole('button', { name: 'Add', exact: true }).tap()
    await expect.poll(async () => { const b = (await page.getByRole('dialog', { name: 'Library' }).boundingBox())!; return b.x >= 0 && b.x + b.width <= vp.height + 1 && b.y + b.height <= vp.width + 1 }).toBe(true)
    await page.setViewportSize(vp)
    await expect(page.getByRole('dialog', { name: 'Library' })).toBeVisible()
  })

  test('the on-screen keyboard lifts the sheet instead of covering the field', async ({ page, app, fingers }) => {
    test.skip(landscape(), 'portrait behaviour')
    await app.open(TRIO())
    await fingers.tap(await app.world(1, 1))
    await dock(page).getByRole('button', { name: 'Edit' }).tap()
    const sheet = page.getByRole('dialog', { name: 'Inspector' })
    await sheet.getByLabel('Component name').tap()
    // there is no real keyboard in a test browser, so report one the way a phone does
    const vp = page.viewportSize()!
    await page.evaluate((h) => {
      Object.defineProperty(window.visualViewport, 'height', { configurable: true, get: () => h })
      window.visualViewport!.dispatchEvent(new Event('resize'))
    }, vp.height - 300)
    await expect(page.locator('html')).toHaveAttribute('data-kb', '')
    await expect.poll(async () => { const b = (await sheet.boundingBox())!; return Math.round(b.y + b.height) }).toBeLessThanOrEqual(vp.height - 299)
    const field = (await sheet.getByLabel('Component name').boundingBox())!
    expect(field.y + field.height).toBeLessThan(vp.height - 300)
    await page.keyboard.type('!')
    await expect(sheet.getByLabel('Component name')).toHaveValue('web-1!')
  })

  test('a large blueprint stays responsive under a slow phone CPU', async ({ page, app, fingers, browserName }) => {
    test.skip(browserName !== 'chromium', 'CPU throttling needs Chrome')
    test.slow()
    const n = 150, side = 13, types = ['ec2', 'rds', 's3', 'lambda', 'sqs', 'alb']
    const doc = makeDoc(Array.from({ length: n }, (_, i) => ({ id: i < 3 ? 'abc'[i] : 'n' + i, type: types[i % 6], x: (i % side) * 4, y: Math.floor(i / side) * 4 })), { id: 'big', name: 'Big' })
    // keep a, b, c where the helpers expect them
    doc.nodes[0] = { ...doc.nodes[0], x: 0, y: 0 }; doc.nodes[1] = { ...doc.nodes[1], x: 6, y: 0 }; doc.nodes[2] = { ...doc.nodes[2], x: 0, y: 6 }
    for (let i = 3; i < n - 1; i++) if ((i + 1) % side) doc.edges.push({ id: 'e' + i, from: doc.nodes[i].id, to: doc.nodes[i + 1].id, style: 'solid', arrow: 'end', width: 2 })
    await app.open(doc)
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
    await page.evaluate(() => { const w = window as any; w.__f = 0; const t = () => { w.__f++; requestAnimationFrame(t) }; requestAnimationFrame(t) })
    const vp = page.viewportSize()!
    const t0 = Date.now()
    await fingers.pinch({ x: vp.width / 2, y: vp.height / 2 }, 100, 260, { steps: 24 })
    const dt = Date.now() - t0, frames = await page.evaluate(() => (window as any).__f)
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })
    test.info().annotations.push({ type: 'pinch on 150 components at 4x CPU slowdown', description: `${Math.round(frames / (dt / 1000))} frames per second` })
    expect(frames / (dt / 1000)).toBeGreaterThan(8)
    await page.getByRole('button', { name: 'Fit to screen' }).tap()
    await page.waitForTimeout(700)
    // one from the middle of the grid, clear of the corner controls
    const mid = (await app.node('n80').locator('.nd-body').boundingBox())!
    await fingers.tap({ x: mid.x + mid.width / 2, y: mid.y + mid.height * 0.7 })
    await expect(dock(page).locator('.dock-name b')).toBeVisible()
  })
})

/**
 * The library is driven here the way a thumb drives it: every scroll is a finger
 * dragged across the glass through the browser's own touch pipeline, and every
 * check reads where the list actually ended up. An earlier version of these tests
 * tapped tiles without ever scrolling, and missed that the list could not scroll.
 */
test.describe('phone: adding components', () => {
  test.beforeEach(async ({ app }) => { await app.open(TRIO()) })
  const openLibrary = async (page: import('@playwright/test').Page) => {
    await dock(page).getByRole('button', { name: 'Add', exact: true }).tap()
    const sheet = page.getByRole('dialog', { name: 'Library' })
    await expect(sheet).toBeVisible()
    await page.waitForTimeout(450) // risen and settled
    return sheet
  }
  const listOf = (page: import('@playwright/test').Page) => page.locator('.palette-scroll')
  const top = (page: import('@playwright/test').Page) => listOf(page).evaluate((e) => Math.round(e.scrollTop))

  test('the whole catalogue scrolls under a finger that lands on a tile, and scrolling never adds anything', async ({ page, app, fingers, browserName }) => {
    test.skip(browserName !== 'chromium', 'needs real touch scrolling')
    const sheet = await openLibrary(page)
    const box = (await listOf(page).boundingBox())!, tile = (await page.locator('.pal-item').nth(1).boundingBox())!
    const x = tile.x + tile.width / 2, from = { x, y: box.y + box.height - 24 }, to = { x, y: box.y + 24 }
    expect(await top(page)).toBe(0)
    // a slow drag moves the list as far as the finger went (less the few px a browser waits to be sure)
    await fingers.drag(from, to, { steps: 12 })
    const moved = await top(page), travel = from.y - to.y
    expect(moved).toBeGreaterThan(travel - 40)
    expect(moved).toBeLessThanOrEqual(travel)
    // flicks carry it to the very end: the last component in the catalogue can be reached
    const max = await listOf(page).evaluate((e) => e.scrollHeight - e.clientHeight)
    await expect(async () => {
      await fingers.drag(from, to, { steps: 4, flick: true })
      await page.waitForTimeout(250)
      expect(await top(page)).toBeGreaterThanOrEqual(max - 2)
    }).toPass({ intervals: [50], timeout: 30000 })
    const last = page.locator('.pal-item').last()
    await expect(last).toBeInViewport()
    await expect(last.locator('svg')).toBeVisible() // and its picture has been drawn by the time it is seen
    // and back up
    await expect(async () => { await fingers.drag(to, from, { steps: 4, flick: true }); await page.waitForTimeout(250); expect(await top(page)).toBe(0) }).toPass({ intervals: [50], timeout: 30000 })
    // none of that touched the blueprint, the canvas behind, or the sheet itself
    await expect(sheet).toBeVisible()
    expect((await app.settled()).nodes).toHaveLength(3)
    expect(await page.evaluate(() => ({ x: scrollX, y: scrollY, scale: visualViewport?.scale ?? 1 }))).toEqual({ x: 0, y: 0, scale: 1 })
  })

  test('a tap on a tile far down the list adds it where it can be seen, selected, and puts the sheet away', async ({ page, app, fingers, browserName }) => {
    test.skip(browserName !== 'chromium', 'needs real touch scrolling')
    const sheet = await openLibrary(page)
    const box = (await listOf(page).boundingBox())!
    for (let i = 0; i < 3; i++) await fingers.drag({ x: box.x + box.width / 2, y: box.y + box.height - 24 }, { x: box.x + box.width / 2, y: box.y + 24 }, { steps: 6 })
    expect(await top(page)).toBeGreaterThan(100)
    // whichever tile now has its middle clear of the sticky heading and the sheet's edge
    const pick = await page.evaluate(([y0, y1]) => { const t = [...document.querySelectorAll('.pal-item')].find((e) => { const r = e.getBoundingClientRect(), c = r.top + r.height / 2; return c > y0 + 44 && c < y1 - 12 })!; const r = t.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, title: t.getAttribute('title')! } }, [box.y, box.y + box.height])
    await fingers.tap(pick)
    await expect(sheet).toHaveCount(0)
    const doc = await app.settled()
    expect(doc.nodes).toHaveLength(4)
    await expect(dock(page).locator('.dock-name b')).toBeVisible()
    // on screen, between the bars, not under a sheet that has gone
    const vp = page.viewportSize()!, body = (await app.node(doc.nodes[3].id).locator('.nd-body').boundingBox())!
    expect(body.x).toBeGreaterThanOrEqual(0); expect(body.x + body.width).toBeLessThanOrEqual(vp.width)
    expect(body.y).toBeGreaterThan((await page.locator('.topbar').boundingBox())!.height); expect(body.y + body.height).toBeLessThan(vp.height)
    // and the next one is a single tap away, without deselecting first
    await page.getByRole('button', { name: 'Add another component' }).tap()
    await expect(sheet).toBeVisible()
  })

  test('category chips flick sideways and filter; search looks across every cloud and clears in one tap', async ({ page, fingers, browserName }) => {
    const sheet = await openLibrary(page)
    const chips = sheet.getByRole('radiogroup', { name: 'Category' })
    if (browserName === 'chromium') {
      const cb = (await chips.boundingBox())!
      await fingers.drag({ x: cb.x + cb.width - 30, y: cb.y + cb.height / 2 }, { x: cb.x + 30, y: cb.y + cb.height / 2 })
      expect(await chips.evaluate((e) => e.scrollLeft)).toBeGreaterThan(80)
      await expect(sheet).toBeVisible() // a sideways flick is not a pull on the sheet
    }
    const all = await page.locator('.pal-item').count()
    await chips.getByRole('radio', { name: 'Security' }).tap()
    await expect(page.locator('.palette h4')).toHaveCount(1)
    expect(await page.locator('.pal-item').count()).toBeLessThan(all)
    expect(await top(page)).toBe(0)
    const field = sheet.getByLabel('Search components')
    await field.tap()
    await page.keyboard.type('queue')
    await expect(page.locator('.pal-item')).toHaveCount(3)
    await expect(page.locator('.pal-aws').first()).toContainText('·') // tagged with the cloud each belongs to
    await sheet.getByRole('button', { name: 'Clear search' }).tap()
    await expect(field).toHaveValue('')
    await expect(page.locator('.palette h4')).toHaveCount(1)
    // every control here is a thumb-sized target
    const small = await sheet.evaluate((el) => [...el.querySelectorAll<HTMLElement>('button, input')].filter((e) => e.offsetParent && !e.closest('.palette-foot')).map((e) => ({ n: e.getAttribute('aria-label') ?? e.innerText.split('\n')[0], r: e.getBoundingClientRect() })).filter((x) => x.r.height < 28 || x.r.width < 28).map((x) => `${x.n} ${Math.round(x.r.width)}×${Math.round(x.r.height)}`))
    expect(small).toEqual([])
  })

  test('switching cloud in the header swaps the list, and the choice sticks', async ({ page }) => {
    const sheet = await openLibrary(page)
    await expect(page.getByTitle('Virtual machine: EC2')).toBeVisible()
    await sheet.getByRole('radio', { name: 'Azure' }).tap()
    await expect(page.getByTitle('Virtual machine: EC2')).toHaveCount(0)
    await expect(sheet.getByRole('radio', { name: 'Azure' })).toHaveAttribute('aria-checked', 'true')
    await sheet.getByRole('button', { name: 'Close library' }).tap()
    await openLibrary(page)
    await expect(sheet.getByRole('radio', { name: 'Azure' })).toHaveAttribute('aria-checked', 'true')
  })

  test('opening and closing over and over leaves nothing behind', async ({ page, app }) => {
    for (let i = 0; i < 8; i++) {
      await dock(page).getByRole('button', { name: 'Add', exact: true }).tap()
      await page.getByRole('dialog', { name: 'Library' }).getByRole('button', { name: 'Close library' }).tap()
    }
    await expect(page.locator('.sheet')).toHaveCount(0)
    await expect(dock(page).getByRole('button', { name: 'Add', exact: true })).toBeVisible()
    expect((await app.settled()).nodes).toHaveLength(3)
  })
})

/** Anything that overflows has to move under a finger. This walks every sheet and dialog and drags inside each one. */
test.describe('phone: everything that overflows scrolls by finger', () => {
  test('sheets, menu and dialogs', async ({ page, app, fingers, browserName }) => {
    test.skip(browserName !== 'chromium', 'needs real touch scrolling')
    test.slow()
    await app.open(TRIO())
    const check = async (surface: string, root: string) => {
      await page.waitForTimeout(500)
      const found = await page.evaluate((sel) => {
        const root = document.querySelector(sel); if (!root) return []
        return [root, ...root.querySelectorAll('*')].flatMap((e, i) => {
          const cs = getComputedStyle(e), r = e.getBoundingClientRect()
          const v = e.scrollHeight - e.clientHeight > 24 && /auto|scroll/.test(cs.overflowY), h = !v && e.scrollWidth - e.clientWidth > 24 && /auto|scroll/.test(cs.overflowX)
          if ((!v && !h) || r.width < 40 || r.height < 30) return []
          e.setAttribute('data-scrolls', String(i)); e.scrollTo(0, 0)
          const y0 = Math.max(0, r.y), y1 = Math.min(innerHeight, r.bottom)
          return [{ id: String(i), cls: e.className.toString().split(' ')[0], v, x: r.x, y: y0, w: r.width, h: y1 - y0 }]
        })
      }, root)
      for (const s of found) {
        const at = (id: string) => page.evaluate((i) => { const e = document.querySelector(`[data-scrolls="${i}"]`); return e ? [e.scrollLeft, e.scrollTop] : null }, id)
        const from = s.v ? { x: s.x + s.w / 2, y: s.y + s.h * 0.8 } : { x: s.x + s.w * 0.8, y: s.y + s.h / 2 }
        const to = s.v ? { x: s.x + s.w / 2, y: s.y + s.h * 0.2 } : { x: s.x + s.w * 0.2, y: s.y + s.h / 2 }
        await fingers.drag(from, to)
        const p = await at(s.id)
        expect(p, `${surface}: ${s.cls} is still there after a drag inside it`).not.toBeNull()
        expect(s.v ? p![1] : p![0], `${surface}: ${s.cls} moves under a finger`).toBeGreaterThan(15)
      }
      return found.map((f) => f.cls)
    }
    const menu = async (q: string) => { await dock(page).getByRole('button', { name: 'Menu' }).tap(); await page.getByLabel('Search commands').fill(q); await page.keyboard.press('Enter') }
    const seen: string[] = []
    await dock(page).getByRole('button', { name: 'Add', exact: true }).tap()
    seen.push(...await check('library', '.sheet'))
    await page.getByRole('button', { name: 'Close library' }).tap()
    await page.waitForTimeout(600) // the view glides back to where it was before the sheet
    await fingers.tap(await app.world(1, 1))
    await dock(page).getByRole('button', { name: 'Edit' }).tap()
    seen.push(...await check('inspector', '.sheet'))
    await page.getByRole('tab', { name: /Budget/ }).tap(); seen.push(...await check('budget', '.sheet'))
    await page.getByRole('tab', { name: /Advisor/ }).tap(); seen.push(...await check('advisor', '.sheet'))
    await page.getByRole('button', { name: 'Close inspector' }).tap()
    await dock(page).getByRole('button', { name: 'Deselect' }).tap()
    await dock(page).getByRole('button', { name: 'Menu' }).tap(); seen.push(...await check('menu', '[role="dialog"]')); await page.keyboard.press('Escape')
    for (const q of ['export', 'import from']) { await menu(q); seen.push(...await check(q, '.modal')); await page.keyboard.press('Escape'); await page.waitForTimeout(300) }
    // the walk really did find the surfaces it is meant to guard
    expect(seen).toEqual(expect.arrayContaining(['palette-scroll', 'pal-chips', 'right-scroll']))
  })
})

test.describe('phone: sheets and the view', () => {
  test.beforeEach(async ({ app }) => { await app.open(TRIO()) })

  test('a sheet keeps what is being edited in clear view, never zooms, and gives the view back when it goes', async ({ page, app, fingers }) => {
    const span = async () => { const a = await app.corner('a'), b = await app.corner('b'); return Math.hypot(b.x - a.x, b.y - a.y) }
    const rest = async () => { let last = { x: -1, y: -1 }; await expect.poll(async () => { const c = await app.corner('a'); const same = Math.abs(c.x - last.x) < 0.5 && Math.abs(c.y - last.y) < 0.5; last = c; return same }, { intervals: [150] }).toBe(true); return last }
    const before = await rest(), zoom = await span()
    await fingers.tap(await app.world(1, 7)) // c, the lowest of the three
    await dock(page).getByRole('button', { name: 'Edit' }).tap()
    const sheet = page.getByRole('dialog', { name: 'Inspector' })
    await expect(sheet).toBeVisible()
    await rest()
    // the component is clear of the top bar and of the sheet, wherever the sheet sits
    const body = (await app.node('c').locator('.nd-body').boundingBox())!, top = (await page.locator('.topbar').boundingBox())!, sh = (await sheet.boundingBox())!, vp = page.viewportSize()!
    const side = sh.width < vp.width * 0.7
    expect(body.y).toBeGreaterThanOrEqual(top.y + top.height)
    expect(body.x).toBeGreaterThanOrEqual(0)
    if (side) expect(body.x + body.width).toBeLessThanOrEqual(sh.x)
    else expect(body.y + body.height).toBeLessThanOrEqual(sh.y)
    expect(await span()).toBeCloseTo(zoom, 0)
    await sheet.getByRole('button', { name: 'Close' }).tap()
    await expect(sheet).toHaveCount(0)
    const after = await rest()
    expect(after.x).toBeCloseTo(before.x, 0); expect(after.y).toBeCloseTo(before.y, 0)
    expect(await span()).toBeCloseTo(zoom, 0)
  })

  test('a view the user moved while the sheet was up is left where they put it', async ({ page, app, fingers }) => {
    await dock(page).getByRole('button', { name: 'Add', exact: true }).tap()
    const sheet = page.getByRole('dialog', { name: 'Library' })
    await expect(sheet).toBeVisible()
    await page.waitForTimeout(700)
    const top = (await page.locator('.topbar').boundingBox())!
    // clear of the cost pill and the cube in the corners
    const from = { x: page.viewportSize()!.width * 0.4, y: top.y + top.height + 70 }
    const start = await app.corner('a')
    await fingers.drag(from, { x: from.x + 50, y: from.y + 20 })
    const mine = await app.corner('a')
    expect(mine.x - start.x).toBeCloseTo(50, 0)
    await sheet.getByRole('button', { name: 'Close' }).tap()
    await expect(sheet).toHaveCount(0)
    await page.waitForTimeout(600)
    const after = await app.corner('a')
    expect(after.x).toBeCloseTo(mine.x, 0); expect(after.y).toBeCloseTo(mine.y, 0)
  })
})

test.describe('phone: first visit', () => {
  test.use({ firstVisit: true })
  test('the gestures are drawn once, stay out of the way, and can be found again', async ({ page, app }) => {
    await app.open(TRIO())
    const guide = page.getByRole('dialog', { name: 'Getting around' })
    await expect(guide).toBeVisible()
    for (const name of ['Move', 'Zoom', 'Turn', 'Tilt']) await expect(guide.getByText(name, { exact: true })).toBeVisible()
    const box = (await guide.boundingBox())!, vp = page.viewportSize()!
    expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(vp.width)
    expect(box.y).toBeGreaterThanOrEqual(0); expect(box.y + box.height).toBeLessThanOrEqual(vp.height)
    await guide.getByRole('button', { name: 'Got it' }).tap()
    await expect(guide).toHaveCount(0)
    await page.reload()
    await app.ready()
    await page.waitForTimeout(1800)
    await expect(guide).toHaveCount(0)
    await dock(page).getByRole('button', { name: 'Menu' }).tap()
    await page.getByLabel('Search commands').fill('gestures')
    await page.keyboard.press('Enter')
    await expect(guide).toBeVisible()
  })
})
