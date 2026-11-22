import type { Page } from '@playwright/test'
import { type App, expect, makeDoc, test } from './fixtures'

/**
 * A run of a connection brought all but level with the next one along is level: the turn between them is gone and
 * no hair of a kink is left where a hand stopped a pixel or two short. That is the whole of the help. It works from
 * the same few pixels on screen at any zoom, never moves anything that was not in the hand, changes nothing after
 * the pointer is let go, and is held off with Alt. A step that was made on purpose stays as it was made.
 * Every check is made with a real mouse against the line as drawn and the blueprint as saved.
 */
type Extra = Record<string, unknown>
const TRACK = { fromSide: 'e', toSide: 'w', fromAt: 0, toAt: 0 }
const edge = (extra: Extra = {}) => ({ id: 'e', from: 'a', to: 'd', style: 'solid', arrow: 'end', width: 2, ...TRACK, ...extra }) as any
/** `e` leaves `a` at y = 1, goes down at x = 3 to y = 3, along to x = 5, down again and arrives at `d` at y = 5 */
const doc = (runs = [3, 3, 5], more: any[] = []) => makeDoc(
  [{ id: 'a', type: 'ec2', x: 0, y: 0, name: 'web' }, { id: 'b', type: 'rds', x: 6, y: 0, name: 'db' }, { id: 'c', type: 's3', x: 0, y: 6, name: 'files' }, { id: 'd', type: 'sqs', x: 6, y: 4, name: 'jobs' }],
  { edges: [edge({ runs }), ...more] },
)
const path = (page: Page, id = 'e') => page.locator(`.edge-hit[data-id="${id}"]`).getAttribute('d').then((d) => d!)
const turns = async (page: Page) => ((await path(page)).match(/Q/g) ?? []).length
const at = (page: Page, t = 0.5) => page.evaluate((t) => {
  const el = document.querySelector('.edge-hit[data-id="e"]') as SVGPathElement, m = el.getScreenCTM()!, p = el.getPointAtLength(el.getTotalLength() * t)
  return { x: p.x * m.a + p.y * m.c + m.e, y: p.x * m.b + p.y * m.d + m.f }
}, t)
const saved = async (app: App) => (await app.settled()).edges.find((e) => e.id === 'e') as any
const open = async (page: Page, app: App, d = doc()) => {
  await app.open(d); await page.keyboard.press('2'); await page.waitForTimeout(800)
  const p = await at(page); await page.mouse.click(p.x, p.y); await expect(page.locator('.edge-bar')).toBeVisible()
}
/**
 * Take the run in the middle of the line (at y = 3) and carry it up towards the first run (at y = 1), stopping `short`
 * pixels before it is level. Returns the line as it was drawn in the hand, just before it was let go.
 */
const lift = async (page: Page, app: App, short: number, o: { alt?: boolean; from?: number; then?: number; t?: number } = {}) => {
  const p = await at(page, o.t), up = await app.cells(0, -(o.from ?? 2)), one = await app.cells(0, 1), n = Math.hypot(one.x, one.y)
  const end = (px: number) => ({ x: p.x + up.x + (one.x / n) * px, y: p.y + up.y + (one.y / n) * px })
  if (o.alt) await page.keyboard.down('Alt')
  await page.mouse.move(p.x, p.y); await page.mouse.down()
  const to = end(short)
  await page.mouse.move((p.x + to.x) / 2, (p.y + to.y) / 2, { steps: 6 }); await page.mouse.move(to.x, to.y, { steps: 6 })
  if (o.then !== undefined) { const q = end(o.then); await page.mouse.move(q.x, q.y, { steps: 4 }) }
  const held = await path(page)
  await page.mouse.up()
  if (o.alt) await page.keyboard.up('Alt')
  return held
}

test.describe('a run let go a hair short of level is level', () => {
  test('three pixels short: the turn is gone, nothing else moved, and what was in the hand is what stays', async ({ page, app }) => {
    await open(page, app)
    expect(await turns(page)).toBe(4)
    const held = await lift(page, app, 3)
    expect(await path(page)).toBe(held)
    expect(await turns(page)).toBe(2)
    // one run left, where the last one always was; both ends where they were on their components
    expect(await saved(app)).toMatchObject({ ...TRACK, runs: [5] })
    // one step back puts the whole of it back
    await app.mod('z')
    expect((await saved(app)).runs).toEqual([3, 3, 5])
  })

  test('a step made on purpose is kept as made: ten pixels is not a slip', async ({ page, app }) => {
    await open(page, app)
    const held = await lift(page, app, 10)
    expect(await path(page)).toBe(held)
    expect(await turns(page)).toBe(4)
    const e = await saved(app)
    expect(e.runs).toHaveLength(3)
    expect(e.runs[1]).toBeGreaterThan(1.05)
    expect(e.runs[1]).toBeLessThan(1.5)
    expect([e.runs[0], e.runs[2], e.fromAt, e.toAt]).toEqual([3, 5, 0, 0])
  })

  test('Alt holds it off: even a hair of a step can be kept', async ({ page, app }) => {
    await open(page, app)
    const held = await lift(page, app, 3, { alt: true })
    expect(await path(page)).toBe(held)
    expect(await turns(page)).toBe(4)
    const v = (await saved(app)).runs[1]
    expect(v).toBeGreaterThan(1)
    expect(v).toBeLessThan(1.2)
  })

  test('once level it stays level while the pointer wanders a pixel or two, and comes away when pulled clear', async ({ page, app }) => {
    await open(page, app)
    // brought to within two pixels, then drifting out to five: still level
    await lift(page, app, 2, { then: 5 })
    expect((await saved(app)).runs).toEqual([5])
    await app.mod('z')
    // five pixels without ever having been level is not close enough
    await lift(page, app, 5)
    expect((await saved(app)).runs).toHaveLength(3)
    await app.mod('z')
    // and pulled well clear after being level, it follows the pointer again
    await lift(page, app, 2, { then: 14 })
    expect((await saved(app)).runs).toHaveLength(3)
  })

  for (const [name, wheel] of [['zoomed in', -260], ['zoomed out', 320]] as const) {
    test(`${name}, it is the same few pixels on screen`, async ({ page, app }) => {
      await open(page, app)
      const p = await at(page), before = await app.cells(1, 0)
      await page.mouse.move(p.x, p.y); await page.mouse.wheel(0, wheel); await page.waitForTimeout(500)
      const after = await app.cells(1, 0)
      expect(Math.abs(Math.hypot(after.x, after.y) / Math.hypot(before.x, before.y) - 1)).toBeGreaterThan(0.15)
      await lift(page, app, 3)
      expect((await saved(app)).runs).toEqual([5])
      await app.mod('z')
      await lift(page, app, 10)
      expect((await saved(app)).runs).toHaveLength(3)
    })
  }

  test('a kink already in a line comes out with the smallest pull towards level', async ({ page, app }) => {
    // the middle run stands two pixels' worth off the first: the kink in the screenshot
    await open(page, app, doc([3, 1.06, 5]))
    expect(await turns(page)).toBe(4)
    const held = await lift(page, app, -3, { from: 0.06, t: 2.06 / 8 })
    expect(await path(page)).toBe(held)
    expect(await turns(page)).toBe(2)
    expect(await saved(app)).toMatchObject({ ...TRACK, runs: [5] })
  })

  test('the straightened line is the same line after a reload', async ({ page, app }) => {
    await open(page, app)
    await lift(page, app, 3)
    const e = await saved(app), drawn = await path(page)
    await page.reload(); await app.ready(); await page.keyboard.press('2'); await page.waitForTimeout(800)
    expect(await saved(app)).toEqual(e)
    expect(await path(page)).toBe(drawn)
  })

  test('no other line is touched by it', async ({ page, app }) => {
    const other = { id: 'f', from: 'c', to: 'a', style: 'solid', arrow: 'end', width: 2 }
    await open(page, app, doc([3, 3, 5], [other]))
    const was = await path(page, 'f')
    await lift(page, app, 3)
    expect((await saved(app)).runs).toEqual([5])
    expect(await path(page, 'f')).toBe(was)
  })
})

test.describe('cleaning up kinks that are already there', () => {
  test('the line\'s menu offers it only when there is one, takes it out, and leaves the rest of the line as it was', async ({ page, app }) => {
    await open(page, app, doc([3, 1.06, 5]))
    const m = await at(page, 0.9)
    await page.mouse.click(m.x, m.y, { button: 'right' })
    await page.locator('.ctx-menu').getByRole('button', { name: 'Clean up small kinks' }).click()
    expect(await turns(page)).toBe(2)
    expect(await saved(app)).toMatchObject({ ...TRACK, runs: [5] })
    const q = await at(page, 0.9)
    await page.mouse.click(q.x, q.y, { button: 'right' })
    await expect(page.locator('.ctx-menu')).toBeVisible()
    await expect(page.locator('.ctx-menu').getByRole('button', { name: 'Clean up small kinks' })).toHaveCount(0)
  })

  test('a step that was made on purpose is not offered for cleaning, and the command leaves it alone', async ({ page, app }) => {
    await open(page, app, doc([3, 1.5, 5]))
    const m = await at(page, 0.9)
    await page.mouse.click(m.x, m.y, { button: 'right' })
    await expect(page.locator('.ctx-menu')).toBeVisible()
    await expect(page.locator('.ctx-menu').getByRole('button', { name: 'Clean up small kinks' })).toHaveCount(0)
    await page.keyboard.press('Escape')
    await app.mod('k')
    await page.keyboard.type('kinks')
    await page.keyboard.press('Enter')
    await expect(page.getByText('No small kinks to take out')).toBeVisible()
    expect((await saved(app)).runs).toEqual([3, 1.5, 5])
  })
})
