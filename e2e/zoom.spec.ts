import type { Page } from '@playwright/test'
import { type App, TRIO, expect, test } from './fixtures'

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
  document.querySelector('.canvas-svg')!.dispatchEvent(new WheelEvent('wheel', { clientX: p.x, clientY: p.y, deltaX: dx as number, deltaY: dy as number, wheelDeltaY: -3 * (dy as number), ctrlKey: ctrl as boolean, bubbles: true, cancelable: true } as WheelEventInit))
}, [at, dx, dy, ctrl] as const)
const still = (page: Page) => page.waitForTimeout(350)
const open = async (page: Page, app: App) => { await app.open(TRIO()); await page.keyboard.press('2'); await page.waitForTimeout(800) }

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

  test('it takes more than one frame to get there, has arrived within a fifth of a second, and then holds still', async ({ page, app }) => {
    await open(page, app)
    const at = await app.world(3, 3), k0 = await scale(app)
    await page.mouse.move(at.x, at.y)
    await still(page)
    // every zoom value the page shows from the notch on, with the time it was shown
    await page.evaluate(() => {
      const w = window as any, g = document.querySelector('.canvas-svg > g') as SVGGElement, t0 = performance.now()
      w.__z = []
      const tick = () => { w.__z.push([performance.now() - t0, g.getScreenCTM()!.a]); if (!w.__zDone) requestAnimationFrame(tick) }
      requestAnimationFrame(tick)
    })
    await app.notches(-1)
    await page.waitForTimeout(1200)
    const seen: [number, number][] = await page.evaluate(() => { (window as any).__zDone = true; return (window as any).__z })
    const first = seen.find(([, a]) => a !== seen[0][1])!, last = seen[seen.length - 1][1]
    expect(last / seen[0][1]).toBeCloseTo(1.1, 3)
    // eased, not a jump: the first frame that moved had not gone the whole way
    expect(first[1] / seen[0][1]).toBeLessThan(1.09)
    // there to the eye (within half a percent) inside a fifth of a second of starting to move, and at rest for good
    // inside two fifths: nothing coasts on after the wheel has stopped
    const arrived = seen.find(([, a]) => Math.abs(a / last - 1) < 0.005)!
    expect(arrived[0] - first[0]).toBeLessThan(200)
    expect(seen.filter(([t]) => t > first[0] + 400).every(([, a]) => a === last)).toBe(true)
    expect((await scale(app)) / k0).toBeCloseTo(1.1, 3)
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
    await app.notches(-5); await still(page)
    expect(await scale(app)).toBeCloseTo(top, 6)
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
