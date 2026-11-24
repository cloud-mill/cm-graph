import type { Page } from '@playwright/test'
import { TRIO, expect, test as base } from './fixtures'
import { Fingers } from './touch'

/**
 * On a phone, at the camera's home angle and each device's pixel ratio, a curved connection's visible line lies on its
 * whole path, and tapping it lights up that very line. See `curves.spec.ts` for what a failure means.
 */
const test = base.extend<{ fingers: Fingers }>({
  fingers: async ({ page, browserName }, use) => { await use(new Fingers(page, browserName === 'chromium')) },
})
const curved = () => { const d = TRIO(); Object.assign(d.nodes[1], { y: 4 }); d.edges.push({ id: 'e', from: 'a', to: 'b', style: 'solid', arrow: 'end', width: 2, shape: 'curved', label: 'enqueue' } as any); return d }
const strays = (page: Page) => page.evaluate(() => {
  const pts = (el: SVGPathElement, n: number) => { const len = el.getTotalLength(); return Array.from({ length: n + 1 }, (_, i) => el.getPointAtLength((len * i) / n)) }
  const on = pts(document.querySelector('.edge-hit[data-id="e"]') as SVGPathElement, 4000)
  let worst = 0
  for (const p of pts(document.querySelector('.edge .edge-line') as SVGPathElement, 300)) worst = Math.max(worst, Math.min(...on.map((q) => Math.hypot(p.x - q.x, p.y - q.y))))
  return worst
})
const at = (page: Page, t: number) => page.evaluate((t) => {
  const el = document.querySelector('.edge-hit[data-id="e"]') as SVGPathElement, m = el.getScreenCTM()!, p = el.getPointAtLength(el.getTotalLength() * t)
  return { x: p.x * m.a + p.y * m.c + m.e, y: p.x * m.b + p.y * m.d + m.f }
}, t)

test.describe('phone: every layer of a curve lies on one path', () => {
  test.beforeEach(async ({ app }) => { await app.open(curved()) })

  test('the visible line lies on the whole path', async ({ page }) => {
    // in the path's own units, which are scene pixels: a fraction of one
    expect(await strays(page)).toBeLessThan(0.6)
  })

  test('tapped, its highlight is the line itself and the line has not changed', async ({ page, fingers }) => {
    const before = await page.locator('.edge .edge-line').getAttribute('d')
    await fingers.tap(await at(page, 0.3))
    await expect(page.locator('.edge-sel')).toHaveCount(1)
    const layers = await page.locator('.edge-sel > g > path').evaluateAll((els) => els.slice(0, 4).map((el) => el.getAttribute('d')))
    expect(layers).toEqual([before, before, before, before])
    expect(await page.locator('.edge .edge-line').getAttribute('d')).toBe(before)
  })
})
