import type { Page } from '@playwright/test'
import { TRIO, expect, test as base } from './fixtures'
import { Fingers } from './touch'

/** Straightening and shaping connections with fingers, through the browser's own touch input. */
const test = base.extend<{ fingers: Fingers }>({
  fingers: async ({ page, browserName }, use) => { await use(new Fingers(page, browserName === 'chromium')) },
})
const dock = (page: Page) => page.locator('.dock')
const linked = (extra: object = {}, move: object = {}) => { const d = TRIO(); Object.assign(d.nodes[1], move); d.edges.push({ id: 'e', from: 'a', to: 'b', style: 'solid', arrow: 'end', width: 2, ...extra } as any); return d }
const at = (page: Page, t = 0.5) => page.evaluate((t) => {
  const el = document.querySelector('.edge-hit[data-id="e"]') as SVGPathElement, m = el.getScreenCTM()!, p = el.getPointAtLength(el.getTotalLength() * t)
  return { x: p.x * m.a + p.y * m.c + m.e, y: p.x * m.b + p.y * m.d + m.f }
}, t)
const turns = async (page: Page) => ((await page.locator('.edge-hit[data-id="e"]').getAttribute('d'))!.match(/Q/g) ?? []).length
const E = async (app: any) => (await app.settled()).edges[0]

test.describe('phone: straight lines', () => {
  test('a line bent out of shape is straightened with one tap in the dock', async ({ page, app, fingers }) => {
    await app.open(linked({ fromSide: 'e', toSide: 'w', fromAt: 0, toAt: 0, runs: [2.5, 4, 5.5] }))
    expect(await turns(page)).toBe(4)
    await fingers.tap(await at(page, 0.5))
    await dock(page).getByRole('button', { name: 'Straighten' }).tap()
    expect(await turns(page)).toBe(0)
    expect((await E(app)).runs).toEqual([])
  })

  test('when the two are out of line the dock offers to line them up, and does', async ({ page, app, fingers }) => {
    await app.open(linked({}, { y: 3 }))
    expect(await turns(page)).toBe(2)
    await fingers.tap(await at(page, 0.5))
    await dock(page).getByRole('button', { name: 'Line up' }).tap()
    expect(await turns(page)).toBe(0)
    expect((await app.settled()).nodes[1]).toMatchObject({ x: 6, y: 0 })
  })

  test('every run of the selected line is a finger-wide target, and a finger moves one without moving the view', async ({ page, app, fingers }) => {
    await app.open(linked({}, { y: 3 }))
    await fingers.tap(await at(page, 0.5))
    const hit = page.locator('.run-hit[data-handle="s1"] line').first()
    // the invisible stroke a finger lands on, as wide on screen as a fingertip
    expect(await hit.evaluate((el) => parseFloat(getComputedStyle(el).strokeWidth) * (el as SVGGraphicsElement).getScreenCTM()!.a)).toBeGreaterThanOrEqual(28)
    const before = await page.locator('[data-kind="node"][data-id="a"]').evaluate((el) => { const m = (el as unknown as SVGGElement).getScreenCTM()!; return [m.e, m.f] })
    const from = await at(page, 0.5), b = (await hit.boundingBox())!
    // push the middle run a short way across the screen, at right angles to itself
    const across = b.width > b.height ? { x: 0, y: 40 } : { x: 40, y: 0 }
    await fingers.drag(from, { x: from.x + across.x, y: from.y + across.y }, { steps: 10 })
    const e = await E(app)
    expect(e.runs).toHaveLength(1)
    expect(e.runs[0]).not.toBe(4)
    expect(await page.locator('[data-kind="node"][data-id="a"]').evaluate((el) => { const m = (el as unknown as SVGGElement).getScreenCTM()!; return [m.e, m.f] })).toEqual(before)
  })

  test('the shape of a line is changed from its sheet', async ({ page, app, fingers }) => {
    await app.open(linked({}, { y: 3 }))
    await fingers.tap(await at(page, 0.5))
    await dock(page).getByRole('button', { name: 'Edit' }).tap()
    const sheet = page.getByRole('dialog', { name: 'Inspector' })
    await sheet.getByRole('radio', { name: 'Direct' }).tap()
    expect((await E(app)).shape).toBe('direct')
    expect(await page.locator('.edge-hit[data-id="e"]').getAttribute('d')).toMatch(/^M[-\d. ]+L[-\d. ]+$/)
    await sheet.getByRole('radio', { name: 'Curved' }).tap()
    expect(await page.locator('.edge-hit[data-id="e"]').getAttribute('d')).toContain('C')
  })
})
