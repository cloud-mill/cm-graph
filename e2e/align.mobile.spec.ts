import type { Page } from '@playwright/test'
import { TRIO, cornersOf, expect, test as base } from './fixtures'
import { Fingers } from './touch'

/**
 * Under a finger, a run brought all but level with the next one along is level, and a step made on purpose stays
 * as made. Through the browser's own touch input, on each phone profile.
 */
const test = base.extend<{ fingers: Fingers }>({
  fingers: async ({ page, browserName }, use) => { await use(new Fingers(page, browserName === 'chromium')) },
})
/** `b` three cells below `a`'s row. The line leaves `a` at y = 1, steps down at x = 2.4 to y = 2.5, runs along to x = 5.6 (a long run, so a finger on its middle is clear of the turns at its ends) and steps down again to arrive at y = 4 */
const stepped = () => { const d = TRIO(); Object.assign(d.nodes[1], { y: 3 }); d.edges.push({ id: 'e', from: 'a', to: 'b', style: 'solid', arrow: 'end', width: 2, fromSide: 'e', toSide: 'w', fromAt: 0, toAt: 0, runs: [2.4, 2.5, 5.6] } as any); return d }
const path = (page: Page) => page.locator('.edge-hit[data-id="e"]').getAttribute('d').then((d) => d!)
const at = (page: Page, t = 0.5) => page.evaluate((t) => {
  const el = document.querySelector('.edge-hit[data-id="e"]') as SVGPathElement, m = el.getScreenCTM()!, p = el.getPointAtLength(el.getTotalLength() * t)
  return { x: p.x * m.a + p.y * m.c + m.e, y: p.x * m.b + p.y * m.d + m.f }
}, t)
const cells = async (page: Page, dx: number, dy: number) => {
  // the three read together, from one drawing of the page (see `cornersOf`)
  const [a, b, c] = (await cornersOf(page, ['a', 'b', 'c'])).map((p) => [p.x, p.y])
  const uy = [(c[0] - a[0]) / 6, (c[1] - a[1]) / 6], ux = [(b[0] - a[0] - 3 * uy[0]) / 6, (b[1] - a[1] - 3 * uy[1]) / 6]
  return { x: ux[0] * dx + uy[0] * dy, y: ux[1] * dx + uy[1] * dy }
}
const E = async (app: any) => (await app.settled()).edges[0]
/** carry the run in the middle (at y = 2.5) up towards the first (at y = 1), lifting the finger `short` pixels before it is level */
const lift = async (page: Page, fingers: Fingers, short: number) => {
  // picked first: on a small screen the view may make room for the line's bar, so where it is on screen is read afterwards
  await fingers.tap(await at(page))
  await page.waitForTimeout(400)
  const p = await at(page), up = await cells(page, 0, -1.5), one = await cells(page, 0, 1), n = Math.hypot(one.x, one.y)
  await fingers.drag(p, { x: p.x + up.x + (one.x / n) * short, y: p.y + up.y + (one.y / n) * short }, { steps: 14 })
}

test.describe('phone: a run lifted a hair short of level is level', () => {
  test.beforeEach(async ({ app }) => { await app.open(stepped()) })

  test('five pixels short under a finger: the turn is gone, the ends have not moved, and it is the same after a reload', async ({ page, app, fingers }) => {
    await lift(page, fingers, 5)
    const e = await E(app), drawn = await path(page)
    expect(e).toMatchObject({ fromAt: 0, toAt: 0, runs: [5.6] })
    await page.reload(); await app.ready()
    expect(await E(app)).toEqual(e)
    expect(await path(page)).toBe(drawn)
  })

  test('a step made on purpose stays as made: sixteen pixels is not a slip', async ({ page, app, fingers }) => {
    await lift(page, fingers, 16)
    const e = await E(app)
    expect(e.runs).toHaveLength(3)
    expect([e.runs[0], e.runs[2], e.fromAt, e.toAt]).toEqual([2.4, 5.6, 0, 0])
    expect(e.runs[1]).toBeGreaterThan(1.05)
  })
})
