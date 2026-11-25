import type { Page } from '@playwright/test'
import { TRIO, cornersOf, expect, test as base } from './fixtures'
import { Fingers } from './touch'

/** A connection under a finger goes where the finger goes and stays there, through the browser's own touch input. */
const test = base.extend<{ fingers: Fingers }>({
  fingers: async ({ page, browserName }, use) => { await use(new Fingers(page, browserName === 'chromium')) },
})
/** `b` three cells below `a`'s row, so the line between them is a Z with a run in the middle to take hold of */
const bent = (extra: object = {}) => { const d = TRIO(); Object.assign(d.nodes[1], { y: 3 }); d.edges.push({ id: 'e', from: 'a', to: 'b', style: 'solid', arrow: 'end', width: 2, ...extra } as any); return d }
const path = (page: Page) => page.locator('.edge-hit[data-id="e"]').getAttribute('d').then((d) => d!)
const turns = async (page: Page) => ((await path(page)).match(/Q/g) ?? []).length
const at = (page: Page, t = 0.5) => page.evaluate((t) => {
  const el = document.querySelector('.edge-hit[data-id="e"]') as SVGPathElement, m = el.getScreenCTM()!, p = el.getPointAtLength(el.getTotalLength() * t)
  return { x: p.x * m.a + p.y * m.c + m.e, y: p.x * m.b + p.y * m.d + m.f }
}, t)
const gap = (page: Page, p: { x: number; y: number }) => page.evaluate((p) => {
  const el = document.querySelector('.edge-hit[data-id="e"]') as SVGPathElement, m = el.getScreenCTM()!, n = el.getTotalLength()
  let least = Infinity
  for (let i = 0; i <= 2000; i++) { const q = el.getPointAtLength((n * i) / 2000); least = Math.min(least, Math.hypot(q.x * m.a + q.y * m.c + m.e - p.x, q.x * m.b + q.y * m.d + m.f - p.y)) }
  return least
}, p)
const corner = (page: Page, id = 'a') => page.locator(`[data-kind="node"][data-id="${id}"]`).evaluate((el) => { const m = (el as unknown as SVGGElement).getScreenCTM()!; return [m.e, m.f] })
/** the screen offset for a move of (dx, dy) cells on the ground, measured from where the components stand (`c` is six cells along y from `a`, `b` six along x and three along y) */
const cells = async (page: Page, dx: number, dy: number) => {
  // the three read together, from one drawing of the page (see `cornersOf`)
  const [a, b, c] = (await cornersOf(page, ['a', 'b', 'c'])).map((p) => [p.x, p.y])
  const uy = [(c[0] - a[0]) / 6, (c[1] - a[1]) / 6], ux = [(b[0] - a[0] - 3 * uy[0]) / 6, (b[1] - a[1] - 3 * uy[1]) / 6]
  return { x: ux[0] * dx + uy[0] * dy, y: ux[1] * dx + uy[1] * dy }
}
const E = async (app: any) => (await app.settled()).edges[0]
/** the run in the middle of the line goes down the y axis, so it is moved by going along x: a little under a cell, which leaves it clear of both components */
const across = (page: Page) => cells(page, 0.8, 0)

test.describe('phone: a line under the finger', () => {
  test.beforeEach(async ({ app }) => { await app.open(bent()) })

  test('goes where the finger goes, stays there when it is lifted, and the view does not move', async ({ page, fingers }) => {
    await fingers.tap(await at(page))
    const view = await corner(page), from = await at(page), d = await across(page)
    const to = { x: from.x + d.x, y: from.y + d.y }
    await fingers.drag(from, to, { steps: 14 })
    // under the finger, to within a few pixels (snapping is off by default, so nothing draws it to a half cell)
    expect(await gap(page, to)).toBeLessThanOrEqual(6)
    expect(await corner(page)).toEqual(view)
    const left = await path(page)
    // tapping empty ground puts it down for good: it is the same line
    const vp = page.viewportSize()!
    await fingers.tap({ x: vp.width * 0.12, y: vp.height * 0.38 })
    await expect(page.locator('.edge-sel')).toHaveCount(0)
    expect(await path(page)).toBe(left)
  })

  test('it is the user\'s from then on, across a reload', async ({ page, app, fingers }) => {
    await fingers.tap(await at(page))
    const from = await at(page), d = await across(page)
    await fingers.drag(from, { x: from.x + d.x, y: from.y + d.y }, { steps: 10 })
    const e = await E(app), left = await path(page)
    expect(e.runs).toHaveLength(1)
    await page.reload(); await app.ready()
    expect(await E(app)).toEqual(e)
    expect(await path(page)).toBe(left)
  })

  test('a turn has a finger-sized target and moves both runs that meet at it', async ({ page, app, fingers }) => {
    await fingers.tap(await at(page))
    const big = page.locator('circle[data-handle="c1"][fill="transparent"]').first()
    expect(await big.evaluate((el) => el.getBoundingClientRect().width)).toBeGreaterThanOrEqual(32)
    const b = (await big.boundingBox())!, c = { x: b.x + b.width / 2, y: b.y + b.height / 2 }
    const by = await cells(page, 0.7, 0.7)
    await fingers.drag(c, { x: c.x + by.x, y: c.y + by.y }, { steps: 12 })
    const e = await E(app)
    expect(e.runs).toHaveLength(1)
    // the run going down went 0.7 of a cell along, and the end at the first component as far down its side
    expect(Math.abs(e.runs[0] - 4.7)).toBeLessThan(0.3)
    expect(Math.abs(e.fromAt - 0.7)).toBeLessThan(0.3)
    expect(await turns(page)).toBe(2)
  })

  test('press and hold on the line offers to put a bend in it, and one step back takes it out', async ({ page, app, fingers }) => {
    await fingers.tap(await at(page))
    const m = await at(page)
    await fingers.drag(m, m, { hold: 600 })
    await page.getByRole('button', { name: 'Add a bend here' }).tap()
    expect(await turns(page)).toBe(4)
    expect((await E(app)).runs).toHaveLength(3)
    await page.getByRole('button', { name: 'Undo' }).tap()
    expect(await turns(page)).toBe(2)
  })
})
