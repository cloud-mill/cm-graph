import type { Page } from '@playwright/test'
import { type App, TRIO, expect, rested, test } from './fixtures'

/**
 * Wheel zoom is small, proportional and anchored. One notch of a mouse wheel is one tenth, at every zoom level; the
 * ground under the pointer stays under the pointer; the zoom has arrived within a fraction of a second and then holds
 * still; a notch back returns exactly; a trackpad pans and its pinch zooms in proportion to the fingers.
 * A failure means the wheel has become jumpy again (a notch counting for too much, or easing that trails the hand),
 * or that a device is being taken for the wrong kind.
 */
/** the zoom, measured: how many screen pixels one cell along x covers, which the toolbar's percentage only rounds */
const scale = async (app: App) => { const c = await app.cells(1, 0); return Math.hypot(c.x, c.y) }
/** a wheel event as a trackpad sends it: small precise deltas, with the legacy value at exactly three times the delta */
const pad = (page: Page, at: { x: number; y: number }, dx: number, dy: number, ctrl = false) => page.evaluate(([at, dx, dy, ctrl]) => {
  const p = at as { x: number; y: number }
  document.querySelector('.canvas-surface')!.dispatchEvent(new WheelEvent('wheel', { clientX: p.x, clientY: p.y, deltaX: dx as number, deltaY: dy as number, wheelDeltaY: -3 * (dy as number), ctrlKey: ctrl as boolean, bubbles: true, cancelable: true } as WheelEventInit))
}, [at, dx, dy, ctrl] as const)
const still = (page: Page) => page.waitForTimeout(350)
const open = async (page: Page, app: App) => { await app.open(TRIO()); await page.keyboard.press('2'); await page.waitForTimeout(800); await rested(page) }

test.describe('zooming with the wheel', () => {
  test('one notch is a tenth, in and out, and a notch back returns exactly to where it was', async ({ page, app }) => {
    await open(page, app)
    const at = await app.world(3, 3), k0 = await scale(app)
    await page.mouse.move(at.x, at.y)
    await app.notches(-1); await still(page)
    expect((await scale(app)) / k0).toBeCloseTo(1.1, 3)
    await app.notches(1); await still(page)
    expect((await scale(app)) / k0).toBeCloseTo(1, 4)
    await app.notches(1); await still(page)
    expect((await scale(app)) / k0).toBeCloseTo(1 / 1.1, 3)
  })

  test('a notch is the same proportion at every zoom level', async ({ page, app }) => {
    await open(page, app)
    const at = await app.world(3, 3)
    await page.mouse.move(at.x, at.y)
    for (const first of [6, -14]) {
      await app.notches(first); await still(page)
      const k = await scale(app)
      await app.notches(-1); await still(page)
      expect((await scale(app)) / k).toBeCloseTo(1.1, 3)
    }
  })

  test('the ground under the pointer stays under the pointer, through many notches and back', async ({ page, app }) => {
    await open(page, app)
    // the pointer rests on the corner of a component: that corner must not move on screen
    const at = await app.corner('b')
    await page.mouse.move(at.x, at.y)
    for (const n of [-1, -5, 9, -3]) {
      await app.notches(n); await still(page)
      const now = await app.corner('b')
      expect(Math.hypot(now.x - at.x, now.y - at.y)).toBeLessThan(0.75)
    }
    // and mid-flight too: no drifting while it eases
    await app.notches(-4)
    for (let i = 0; i < 6; i++) { await page.waitForTimeout(20); const now = await app.corner('b'); expect(Math.hypot(now.x - at.x, now.y - at.y)).toBeLessThan(0.75) }
  })

  test('several notches add up to exactly that many steps, and reversing mid-way lands on the sum', async ({ page, app }) => {
    await open(page, app)
    const at = await app.world(3, 3), k0 = await scale(app)
    await page.mouse.move(at.x, at.y)
    await app.notches(-5); await still(page)
    expect((await scale(app)) / k0).toBeCloseTo(1.1 ** 5, 2)
    // four more in and three back out, without waiting between them
    await app.notches(-4); await app.notches(3); await still(page)
    expect((await scale(app)) / k0).toBeCloseTo(1.1 ** 6, 2)
  })

  test('it stops at the limits and comes straight back from them', async ({ page, app }) => {
    await open(page, app)
    const at = await app.world(3, 3)
    await page.mouse.move(at.x, at.y)
    const pct = () => page.locator('.zoom-pct').innerText().then((t) => parseInt(t, 10))
    // the keyboard takes it most of the way (each press is a bigger step), the wheel the rest
    // (each press is let finish: a press made while the last is still easing starts from wherever that has got to)
    for (let i = 0; i < 6; i++) { await page.keyboard.press('+'); await page.waitForTimeout(220) }
    await app.notches(-6)
    await expect.poll(pct).toBe(400)
    const top = await scale(app)
    // further notches at the limit are not stored up: one notch back is one notch
    // (to a thousandth of a pixel: the first figure may be read while the picture is still stretched to this zoom, the second once it has been drawn at it)
    await app.notches(-5); await still(page)
    expect(await scale(app)).toBeCloseTo(top, 3)
    await app.notches(1); await still(page)
    expect((await scale(app)) / top).toBeCloseTo(1 / 1.1, 3)
    for (let i = 0; i < 13; i++) { await page.keyboard.press('-'); await page.waitForTimeout(220) }
    await app.notches(6)
    await expect.poll(pct).toBe(15)
    const bottom = await scale(app)
    await app.notches(4); await still(page)
    await app.notches(-1); await still(page)
    expect((await scale(app)) / bottom).toBeCloseTo(1.1, 3)
  })

  test('two fingers sliding on a trackpad pan and never zoom, however fast the swipe', async ({ page, app }) => {
    await open(page, app)
    const at = await app.world(3, 3), k0 = await scale(app), was = await app.corner('a')
    for (const dy of [3, 18, 40, 80, 120]) await pad(page, at, 0, dy)
    await pad(page, at, 25, 0)
    await still(page)
    expect((await scale(app)) / k0).toBeCloseTo(1, 6)
    const now = await app.corner('a')
    expect(now.x - was.x).toBeCloseTo(-25, 0)
    expect(now.y - was.y).toBeCloseTo(-261, 0)
  })

  test('a pinch on a trackpad zooms at once, in proportion, about the fingers', async ({ page, app }) => {
    await open(page, app)
    const at = await app.corner('b'), k0 = await scale(app)
    for (let i = 0; i < 10; i++) await pad(page, at, 0, -2, true)
    // no easing to wait for: it is there in the same frame
    await page.waitForTimeout(30)
    expect((await scale(app)) / k0).toBeCloseTo(Math.exp(0.2), 3)
    const now = await app.corner('b')
    expect(Math.hypot(now.x - at.x, now.y - at.y)).toBeLessThan(0.75)
    for (let i = 0; i < 10; i++) await pad(page, at, 0, 2, true)
    await page.waitForTimeout(30)
    expect((await scale(app)) / k0).toBeCloseTo(1, 4)
  })

  test('a pinch as Chrome itself delivers one zooms by what the fingers did, no more', async ({ page, app }) => {
    // Not an event made in the page: the browser's own input pipeline, which turns a pinch on a trackpad into wheel
    // events with Ctrl held, each claiming a whole notch in its legacy value however small the movement. Read as
    // notches, fingers moved apart by a third sent the view to more than twice its size
    await open(page, app)
    const at = await app.corner('b'), k0 = await scale(app)
    const cdp = await page.context().newCDPSession(page)
    const fingers = (by: number) => cdp.send('Input.synthesizePinchGesture', { x: Math.round(at.x), y: Math.round(at.y), scaleFactor: by, relativeSpeed: 400, gestureSourceType: 'mouse' })
    await fingers(1.3); await still(page)
    expect((await scale(app)) / k0).toBeCloseTo(1.3, 2)
    // about the fingers: the corner between them has not moved
    const now = await app.corner('b')
    expect(Math.hypot(now.x - Math.round(at.x), now.y - Math.round(at.y))).toBeLessThan(1.5)
    await fingers(1 / 1.3); await still(page)
    expect((await scale(app)) / k0).toBeCloseTo(1, 2)
    await fingers(2); await still(page)
    expect((await scale(app)) / k0).toBeCloseTo(2, 2)
    await fingers(0.25); await still(page)
    expect((await scale(app)) / k0).toBeCloseTo(0.5, 2)
  })

  test('the band that takes a click on a line is the same width on the screen at every zoom', async ({ page, app }) => {
    const doc = TRIO()
    doc.edges.push({ id: 'e', from: 'a', to: 'b', style: 'solid', arrow: 'end', width: 2 })
    await app.open(doc)
    await rested(page)
    // across the line at its middle, half a pixel at a time each way, for as long as the line is what is under the point
    const band = () => page.evaluate(() => {
      const el = document.querySelector('.edge-hit[data-id="e"]') as SVGPathElement, m = el.getScreenCTM()!, half = el.getTotalLength() / 2
      const on = (p: DOMPoint) => [p.x * m.a + p.y * m.c + m.e, p.x * m.b + p.y * m.d + m.f]
      const [x, y] = on(el.getPointAtLength(half)), [x1, y1] = on(el.getPointAtLength(half + 1)), along = Math.hypot(x1 - x, y1 - y)
      const nx = -(y1 - y) / along, ny = (x1 - x) / along
      const hit = (d: number) => document.elementFromPoint(x + nx * d, y + ny * d) === el
      let a = 0, b = 0
      while (a < 80 && hit(a + 0.5)) a += 0.5
      while (b < 80 && hit(-(b + 0.5))) b += 0.5
      return a + b
    })
    const at = await page.evaluate(() => { const el = document.querySelector('.edge-hit[data-id="e"]') as SVGPathElement, m = el.getScreenCTM()!, p = el.getPointAtLength(el.getTotalLength() / 2); return { x: p.x * m.a + p.y * m.c + m.e, y: p.x * m.b + p.y * m.d + m.f } })
    await page.mouse.move(at.x, at.y)
    const widths: string[] = []
    for (const n of [0, -6, -6, 9, 9, 6]) {
      await app.notches(n)
      await still(page)
      await rested(page)
      const w = await band(), k = await page.evaluate(() => (document.querySelector('.canvas-layer.top > g') as SVGGElement).getScreenCTM()!.a)
      widths.push(`${(k * 100).toFixed(0)}%: ${w} px`)
      // sixteen pixels, give or take the half pixel either side that the measuring steps in
      expect(w, `the band at ${(k * 100).toFixed(0)}%`).toBeGreaterThanOrEqual(14.5)
      expect(w, `the band at ${(k * 100).toFixed(0)}%`).toBeLessThanOrEqual(17.5)
    }
    test.info().annotations.push({ type: 'width of the band that selects a line', description: widths.join(', ') })
  })

  test('zooming does not disturb a selection, and a drag straight after a zoom carries exactly as far as the pointer', async ({ page, app }) => {
    await open(page, app)
    await app.pick('a')
    const at = await app.world(1, 1)
    await page.mouse.move(at.x, at.y)
    await app.notches(-2)
    // without waiting for the zoom to settle: press and carry
    const from = await app.world(1, 1)
    await page.mouse.move(from.x, from.y); await page.mouse.down()
    await page.mouse.move(from.x + 40, from.y + 25, { steps: 6 })
    const mid = await app.corner('a')
    await page.mouse.up()
    await still(page)
    const end = await app.corner('a')
    expect(Math.hypot(end.x - mid.x, end.y - mid.y)).toBeLessThan(0.75)
    expect((await app.settled()).nodes.find((n) => n.id === 'a')!.x).not.toBe(0)
  })
})
