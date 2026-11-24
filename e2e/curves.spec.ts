import type { Page } from '@playwright/test'
import { type App, expect, makeDoc, test } from './fixtures'

/**
 * Every layer of a connection lies on one path. The visible line, the dark channel under it, the area that takes a
 * click and the highlight when it is selected are all drawn from the same geometry, so none can stray from another:
 * not on a curve, not round a tight bend, not at any zoom, and not because the line was hovered or selected.
 * A failure here means a layer is being shortened or recomputed on its own again (the old fault was shortening a
 * curve for its arrowhead by moving its end point, which redrew the whole sweep).
 */
const edge = (id: string, from: string, to: string, extra: Record<string, unknown> = {}) => ({ id, from, to, style: 'solid', arrow: 'end', width: 2, ...extra }) as any
const doc = () => makeDoc(
  [{ id: 'a', type: 'ec2', x: 0, y: 0, name: 'web' }, { id: 'b', type: 'rds', x: 6, y: 0, name: 'db' }, { id: 'c', type: 's3', x: 0, y: 6, name: 'files' }, { id: 'd', type: 'sqs', x: 7, y: 6, name: 'jobs' }],
  { edges: [
    edge('curve', 'a', 'd', { shape: 'curved', label: 'enqueue' }),
    // a hand-shaped line with a short run between two bends, where a corner is tightest
    edge('bends', 'c', 'b', { fromSide: 'e', toSide: 's', fromAt: 0, toAt: 0, runs: [3, 4.6, 7] }),
    edge('both', 'b', 'd', { shape: 'curved', arrow: 'both', fromSide: 'e', toSide: 'e' }),
  ] },
)
/** how far, in screen pixels, the path matched by `sel` strays at its worst from the path matched by `onto` */
const strays = (page: Page, sel: string, onto: string) => page.evaluate(([sel, onto]) => {
  const pts = (el: SVGPathElement, n: number) => {
    const m = el.getScreenCTM()!, len = el.getTotalLength(), out: [number, number][] = []
    for (let i = 0; i <= n; i++) { const p = el.getPointAtLength((len * i) / n); out.push([p.x * m.a + p.y * m.c + m.e, p.x * m.b + p.y * m.d + m.f]) }
    return out
  }
  const a = document.querySelector(sel) as SVGPathElement | null, b = document.querySelector(onto) as SVGPathElement | null
  if (!a || !b) return Infinity
  const on = pts(b, 4000)
  let worst = 0
  for (const p of pts(a, 300)) { let least = Infinity; for (const q of on) least = Math.min(least, Math.hypot(p[0] - q[0], p[1] - q[1])); worst = Math.max(worst, least) }
  return worst
}, [sel, onto] as const)
const line = (id: string) => `.edge:has(.edge-hit[data-id="${id}"]) .edge-line`
const hit = (id: string) => `.edge-hit[data-id="${id}"]`
const d = (page: Page, sel: string) => page.locator(sel).first().getAttribute('d')
const middle = (page: Page, id: string, t = 0.5) => page.evaluate(([id, t]) => {
  const el = document.querySelector(`.edge-hit[data-id="${id}"]`) as SVGPathElement, m = el.getScreenCTM()!, p = el.getPointAtLength(el.getTotalLength() * (t as number))
  return { x: p.x * m.a + p.y * m.c + m.e, y: p.x * m.b + p.y * m.d + m.f }
}, [id, t] as const)
const open = async (page: Page, app: App, plan = true) => {
  await app.open(doc())
  if (plan) { await page.keyboard.press('2'); await page.waitForTimeout(800) }
}

test.describe('every layer of a connection lies on one path', () => {
  for (const id of ['curve', 'bends', 'both']) {
    test(`${id}: the visible line lies on the whole path, to within a fraction of a pixel`, async ({ page, app }) => {
      await open(page, app)
      expect(await strays(page, line(id), hit(id))).toBeLessThan(0.6)
      // and from the camera's home angle too
      await page.keyboard.press('3'); await page.waitForTimeout(800)
      expect(await strays(page, line(id), hit(id))).toBeLessThan(0.6)
    })

    test(`${id}: selected, its highlight is the line itself, and selecting it does not change the line`, async ({ page, app }) => {
      await open(page, app)
      const before = await d(page, line(id)), whole = await d(page, hit(id))
      const p = await middle(page, id, 0.3)
      await page.mouse.click(p.x, p.y)
      await expect(page.locator('.edge-sel')).toHaveCount(1)
      const layers = await page.locator('.edge-sel > g > path').evaluateAll((els) => els.slice(0, 4).map((el) => el.getAttribute('d')))
      // three layers of halo and the line of the highlight itself
      expect(layers).toEqual([before, before, before, before])
      expect(await d(page, line(id))).toBe(before)
      expect(await d(page, hit(id))).toBe(whole)
      expect(await strays(page, '.edge-sel > g > path', hit(id))).toBeLessThan(0.6)
      // the arrowheads of the highlight are the line's own
      const heads = (root: string) => page.locator(root + ' polygon').evaluateAll((els) => els.map((el) => el.getAttribute('points')))
      const own = await heads(`.edge:has(.edge-hit[data-id="${id}"])`)
      expect((await heads('.edge-sel')).slice(0, own.length)).toEqual(own)
    })
  }

  test('zoomed in and zoomed out, the layers still coincide', async ({ page, app }) => {
    await open(page, app)
    const p = await middle(page, 'curve')
    await page.mouse.click(p.x, p.y)
    for (const wheel of [-4, 8]) {
      await page.mouse.move(p.x, p.y); await app.notches(wheel); await page.waitForTimeout(600)
      expect(await strays(page, line('curve'), hit('curve'))).toBeLessThan(0.6)
      // the highlight is the same path data as the line: zoom is a transform on both, not a new drawing
      expect(await d(page, '.edge-sel > g > path')).toBe(await d(page, line('curve')))
    }
  })

  test('hovering a line changes its colour and nothing else', async ({ page, app }) => {
    await open(page, app)
    const before = await d(page, line('curve')), p = await middle(page, 'curve', 0.3)
    await page.mouse.move(p.x, p.y)
    await page.waitForTimeout(250)
    expect(await d(page, line('curve'))).toBe(before)
  })

  test('an arrowhead on a curve lies along the curve where it arrives', async ({ page, app }) => {
    await open(page, app)
    // the middle of the head's base is on the path, not beside it
    const off = await page.evaluate(() => {
      const g = document.querySelector('.edge:has(.edge-hit[data-id="curve"])')!, path = g.querySelector('.edge-hit') as SVGPathElement
      const pts = (g.querySelector('polygon') as SVGPolygonElement).points, base = { x: (pts[1].x + pts[2].x) / 2, y: (pts[1].y + pts[2].y) / 2 }
      const len = path.getTotalLength()
      let least = Infinity
      for (let i = 0; i <= 4000; i++) { const q = path.getPointAtLength((len * i) / 4000); least = Math.min(least, Math.hypot(q.x - base.x, q.y - base.y)) }
      return least
    })
    expect(off).toBeLessThan(0.3)
  })

  test('a caption on a curve sits on the curve', async ({ page, app }) => {
    await open(page, app)
    const off = await page.evaluate(() => {
      const g = document.querySelector('.edge:has(.edge-hit[data-id="curve"])')!, path = g.querySelector('.edge-hit') as SVGPathElement, m = path.getScreenCTM()!
      const box = g.querySelector('text')!.getBoundingClientRect(), c = { x: box.left + box.width / 2, y: box.top + box.height / 2 }
      const len = path.getTotalLength()
      let least = Infinity
      for (let i = 0; i <= 4000; i++) { const q = path.getPointAtLength((len * i) / 4000); least = Math.min(least, Math.hypot(q.x * m.a + q.y * m.c + m.e - c.x, q.x * m.b + q.y * m.d + m.f - c.y)) }
      return least
    })
    expect(off).toBeLessThan(3)
  })

  test('while a component is carried, the line and its highlight move as one', async ({ page, app }) => {
    await open(page, app)
    const p = await middle(page, 'curve', 0.3)
    await page.mouse.click(p.x, p.y)
    // carry the far end's component with the line still selected (Shift keeps the selection)
    const from = await app.world(8, 7), by = await app.cells(1.3, -0.7)
    await page.keyboard.down('Shift')
    await page.mouse.move(from.x, from.y); await page.mouse.down()
    await page.mouse.move(from.x + by.x / 2, from.y + by.y / 2, { steps: 5 }); await page.mouse.move(from.x + by.x, from.y + by.y, { steps: 5 })
    if (await page.locator('.edge-sel').count()) expect(await d(page, '.edge-sel > g > path')).toBe(await d(page, line('curve')))
    expect(await strays(page, line('curve'), hit('curve'))).toBeLessThan(0.6)
    await page.mouse.up()
    await page.keyboard.up('Shift')
    expect(await strays(page, line('curve'), hit('curve'))).toBeLessThan(0.6)
  })
})
