import type { Page } from '@playwright/test'
import { type App, expect, makeDoc, rested, test } from './fixtures'

/**
 * Straight lines. A connection that could be one straight run is one, without being asked;
 * one that is not can be made so in a single action; and a line the user has shaped or
 * straightened stays as they left it. Every check reads the line as drawn on screen, or the
 * blueprint as saved.
 */
type Extra = Record<string, unknown>
const edge = (id: string, from: string, to: string, extra: Extra = {}) => ({ id, from, to, style: 'solid', arrow: 'end', width: 2, ...extra }) as any
/** `a` at the origin, `b` six cells along x and `c` six along y, as the screen measurements expect, plus whatever else */
const doc = (edges: any[], more: any[] = [], move: Record<string, Extra> = {}) => makeDoc(
  [{ id: 'a', type: 'ec2', x: 0, y: 0, name: 'web', ...move.a }, { id: 'b', type: 'rds', x: 6, y: 0, name: 'db', ...move.b }, { id: 'c', type: 's3', x: 0, y: 6, name: 'files', ...move.c }, ...more],
  { edges },
)
const path = (page: Page, id: string) => page.locator(`.edge-hit[data-id="${id}"]`).getAttribute('d').then((d) => d!)
/** how many times a line turns, read off the path it is drawn with (each corner is one rounded join) */
const turns = async (page: Page, id: string) => ((await path(page, id)).match(/Q/g) ?? []).length
const at = (page: Page, id: string, t = 0.5) => page.evaluate(([id, t]) => {
  const el = document.querySelector(`.edge-hit[data-id="${id}"]`) as SVGPathElement, m = el.getScreenCTM()!, p = el.getPointAtLength(el.getTotalLength() * (t as number))
  return { x: p.x * m.a + p.y * m.c + m.e, y: p.x * m.b + p.y * m.d + m.f }
}, [id, t] as const)
const select = async (page: Page, id: string, t = 0.5) => { const p = await at(page, id, t); await page.mouse.click(p.x, p.y); await expect(page.locator('.edge-bar')).toBeVisible() }
const saved = async (app: App, id: string) => (await app.settled()).edges.find((e) => e.id === id) as any
const bar = (page: Page, name: string) => page.locator('.edge-bar').getByRole('button', { name, exact: true })
const centre = async (page: Page, sel: string) => { const b = (await page.locator(sel).last().boundingBox())!; return { x: b.x + b.width / 2, y: b.y + b.height / 2 } }
const plan = async (page: Page) => { await page.keyboard.press('2'); await page.waitForTimeout(800); await rested(page) }
const open = async (page: Page, app: App, d: ReturnType<typeof doc>) => { await app.open(d); await plan(page) }

test.describe('straight without being asked', () => {
  test('components level with each other are joined straight even when other lines share the side', async ({ page, app }) => {
    // web feeds db (level with it) and a queue below: the two lines fan out along web's side, which used to put a kink in the first
    await open(page, app, doc([edge('ab', 'a', 'b'), edge('aq', 'a', 'q'), edge('cb', 'c', 'b')], [{ id: 'q', type: 'sqs', x: 6, y: 5, name: 'jobs' }]))
    expect(await turns(page, 'ab')).toBe(0)
    expect(await turns(page, 'aq')).toBe(2)
  })

  test('one above the other, and of different sizes, they are joined straight too', async ({ page, app }) => {
    await open(page, app, doc([edge('ac', 'a', 'c'), edge('ab', 'a', 'b')], [], { a: { scale: 1.5 }, c: { y: 7 } }))
    expect(await turns(page, 'ac')).toBe(0)
    expect(await turns(page, 'ab')).toBe(0)
  })
})

test.describe('straight in one action', () => {
  test('a line with turns it has no need of becomes one straight run, and one undo gives the turns back', async ({ page, app }) => {
    await open(page, app, doc([edge('e', 'a', 'b', { fromSide: 'e', toSide: 'w', fromAt: 0, toAt: 0, runs: [2.5, 4, 4, -2, 5.5] })]))
    expect(await turns(page, 'e')).toBe(6)
    await select(page, 'e', 0.05)
    await bar(page, 'Straighten').click()
    expect(await turns(page, 'e')).toBe(0)
    expect(await saved(app, 'e')).toMatchObject({ runs: [], fromSide: 'e', toSide: 'w' })
    await app.mod('z')
    expect(await turns(page, 'e')).toBe(6)
  })

  test('a curved line becomes a straight one, or a direct one, in a click', async ({ page, app }) => {
    await open(page, app, doc([edge('e', 'a', 'b', { shape: 'curved' })], [], { b: { y: 1 } }))
    expect(await path(page, 'e')).toContain('C')
    await select(page, 'e')
    await bar(page, 'Straighten').click()
    expect(await path(page, 'e')).not.toContain('C')
    expect(await turns(page, 'e')).toBe(0)
    expect((await saved(app, 'e')).shape).toBeUndefined()
    await bar(page, 'Curved').click()
    expect(await path(page, 'e')).toContain('C')
    await bar(page, 'Direct').click()
    expect(await path(page, 'e')).toMatch(/^M[-\d. ]+L[-\d. ]+$/)
    expect((await saved(app, 'e')).shape).toBe('direct')
  })

  test('where the two are out of line, the action lines them up, says what it moved, and undoes in one step', async ({ page, app }) => {
    await open(page, app, doc([edge('e', 'c', 'q')], [{ id: 'q', type: 'sqs', x: 7, y: 9, name: 'jobs' }]))
    expect(await turns(page, 'e')).toBe(2)
    await select(page, 'e', 0.1)
    await expect(bar(page, 'Straighten')).toHaveCount(0)
    await bar(page, 'Line up').click()
    await expect(app.toast('Moved jobs into line')).toBeVisible()
    expect(await turns(page, 'e')).toBe(0)
    expect((await app.settled()).nodes.find((n) => n.id === 'q')).toMatchObject({ x: 7, y: 6 })
    await app.mod('z')
    expect((await app.settled()).nodes.find((n) => n.id === 'q')).toMatchObject({ x: 7, y: 9 })
    expect(await turns(page, 'e')).toBe(2)
  })

  test('a direct line joins any two components with one stroke, however they stand', async ({ page, app }) => {
    await open(page, app, doc([edge('e', 'a', 'q')], [{ id: 'q', type: 'sqs', x: 7, y: 4, name: 'jobs' }]))
    await select(page, 'e', 0.1)
    await bar(page, 'Direct').click()
    expect(await path(page, 'e')).toMatch(/^M[-\d. ]+L[-\d. ]+$/)
    await bar(page, 'Right-angled').click()
    expect(await turns(page, 'e')).toBe(2)
  })

  test('from the menu and from the panel as well', async ({ page, app }) => {
    await open(page, app, doc([edge('e', 'a', 'b', { fromSide: 'e', toSide: 'w', fromAt: 0, toAt: 0, runs: [2.5, 4, 5.5] })]))
    const p = await at(page, 'e', 0.5)
    await page.mouse.click(p.x, p.y, { button: 'right' })
    await page.locator('.ctx-menu').getByRole('button', { name: 'Straighten' }).click()
    expect(await turns(page, 'e')).toBe(0)
    await app.mod('z')
    expect(await turns(page, 'e')).toBe(4)
    await page.locator('.panel.right').getByRole('button', { name: 'Straighten' }).click()
    expect(await turns(page, 'e')).toBe(0)
    await expect(page.locator('.panel.right')).toContainText('kept straight')
  })
})

test.describe('shaping by hand', () => {
  test('a line can be taken hold of anywhere along it, without selecting it first', async ({ page, app }) => {
    await open(page, app, doc([edge('e', 'a', 'q')], [{ id: 'q', type: 'sqs', x: 7, y: 4, name: 'jobs' }]))
    // the middle run of the Z, at x = 4.5
    const mid = await at(page, 'e', 0.5), d = await app.cells(-1.5, 0)
    await app.drag(mid, { x: mid.x + d.x, y: mid.y + d.y })
    expect(await saved(app, 'e')).toMatchObject({ runs: [3], fromSide: 'e', toSide: 'w' })
    await expect(page.locator('.edge-bar')).toBeVisible()
  })

  test('pulling the first run level with the last takes the turns out, with only a nudge needed at the end', async ({ page, app }) => {
    // db one cell lower than web, and a Z laid between them by hand
    await open(page, app, doc([edge('e', 'a', 'b', { fromSide: 'e', toSide: 'w', fromAt: 0, toAt: 0, runs: [4] })], [], { b: { y: 1 } }))
    expect(await turns(page, 'e')).toBe(2)
    await select(page, 'e', 0.5)
    const from = await centre(page, '[data-handle="s0"]'), d = await app.cells(0, 0.85)
    await page.mouse.move(from.x, from.y); await page.mouse.down(); await page.mouse.move(from.x + d.x, from.y + d.y, { steps: 8 })
    // it is straight in the hand before it is let go
    expect(await turns(page, 'e')).toBe(0)
    await page.mouse.up()
    expect((await saved(app, 'e')).runs).toEqual([])
    expect(await turns(page, 'e')).toBe(0)
  })

  test('an end is moved to another side of its component by dropping it on that side\'s door', async ({ page, app }) => {
    await open(page, app, doc([edge('e', 'a', 'b')]))
    await select(page, 'e')
    const end = await centre(page, '[data-handle="eb"]'), door = await app.world(7, -0.42)
    await page.mouse.move(end.x, end.y); await page.mouse.down(); await page.mouse.move(door.x, door.y, { steps: 12 })
    await expect(page.locator('.door.aimed')).toHaveAttribute('data-side', 'n')
    await page.mouse.up()
    expect(await saved(app, 'e')).toMatchObject({ to: 'b', toSide: 'n' })
    // it arrives from above now: the last stretch of the line runs down the screen into db
    const [p, q] = [await at(page, 'e', 0.97), await at(page, 'e', 1)]
    expect(Math.abs(q.x - p.x)).toBeLessThan(1)
    expect(q.y).toBeGreaterThan(p.y)
  })
})

test.describe('what was shaped stays shaped', () => {
  test('a straightened line stays straight when a component is nudged, and bends only when it has to', async ({ page, app }) => {
    await open(page, app, doc([edge('e', 'c', 'q', { fromSide: 'e', toSide: 'w', fromAt: 0, toAt: 0, runs: [] })], [{ id: 'q', type: 'sqs', x: 7, y: 6, name: 'jobs' }]))
    const q = (await app.node('q').locator('.nd-body').boundingBox())!, from = { x: q.x + q.width / 2, y: q.y + q.height / 2 }
    const one = await app.cells(0, 1)
    await app.drag(from, { x: from.x + one.x, y: from.y + one.y })
    expect((await app.settled()).nodes.find((n) => n.id === 'q')).toMatchObject({ x: 7, y: 7 })
    expect(await turns(page, 'e')).toBe(0) // both ends slid along their sides
    const far = await app.cells(0, 4)
    await app.drag({ x: from.x + one.x, y: from.y + one.y }, { x: from.x + one.x + far.x, y: from.y + one.y + far.y })
    expect(await turns(page, 'e')).toBeGreaterThan(0) // right out of line: no straight run exists
    await app.mod('z')
    expect(await turns(page, 'e')).toBe(0)
  })

  test('a shaped line keeps its runs where they were put when the component at one end moves', async ({ page, app }) => {
    await open(page, app, doc([edge('e', 'a', 'q', { fromSide: 'e', toSide: 'w', fromAt: 0, toAt: 0, runs: [3, 9, 6] })], [{ id: 'q', type: 'sqs', x: 9, y: 4, name: 'jobs' }]))
    const low = await at(page, 'e', 0.5)
    const q = (await app.node('q').locator('.nd-body').boundingBox())!, from = { x: q.x + q.width / 2, y: q.y + q.height / 2 }, d = await app.cells(0, -2)
    await app.drag(from, { x: from.x + d.x, y: from.y + d.y })
    expect((await app.settled()).nodes.find((n) => n.id === 'q')).toMatchObject({ x: 9, y: 2 })
    expect((await saved(app, 'e')).runs).toEqual([3, 9, 6])
    // the long run along y = 9 has not moved on screen
    const pts = await page.evaluate(() => { const el = document.querySelector('.edge-hit[data-id="e"]') as SVGPathElement, m = el.getScreenCTM()!, L = el.getTotalLength(); return Array.from({ length: 201 }, (_, i) => { const p = el.getPointAtLength((L * i) / 200); return { x: p.x * m.a + p.y * m.c + m.e, y: p.x * m.b + p.y * m.d + m.f } }) })
    expect(Math.min(...pts.map((p) => Math.hypot(p.x - low.x, p.y - low.y)))).toBeLessThan(3)
  })

  test('in a crowded diagram, straightening one line changes that line and no other', async ({ page, app }) => {
    const grid = Array.from({ length: 9 }, (_, i) => ({ id: 'g' + i, type: ['ec2', 'rds', 's3'][i % 3], x: 12 + (i % 3) * 5, y: Math.floor(i / 3) * 5, name: 'g' + i }))
    const links = [edge('ab', 'a', 'b'), edge('ac', 'a', 'c'), edge('cb', 'c', 'b'), ...grid.slice(0, 8).map((g, i) => edge('l' + i, g.id, grid[i + 1].id)), edge('x', 'g0', 'g4'), edge('y', 'g2', 'g6'), edge('z', 'b', 'g3'),
      edge('bent', 'g3', 'g5', { fromSide: 'e', toSide: 'w', fromAt: 0, toAt: 0, runs: [14.5, 8, 21.5] })]
    await open(page, app, doc(links, grid))
    await page.keyboard.press('f'); await page.waitForTimeout(600)
    const others = links.map((l) => l.id).filter((id) => id !== 'bent')
    const before = await Promise.all(others.map((id) => path(page, id)))
    expect(await turns(page, 'bent')).toBe(4)
    await select(page, 'bent', 0.5)
    // g4 stands between g3 and g5: straight means under it, and the bar says so before it is pressed
    await expect(bar(page, 'Straighten')).toHaveAttribute('data-tip', /passing under/)
    await bar(page, 'Straighten').click()
    expect(await turns(page, 'bent')).toBe(0)
    await app.settled()
    expect(await Promise.all(others.map((id) => path(page, id)))).toEqual(before)
  })

  test('a straightened line and a shaped one are both exactly as they were after saving and reloading', async ({ page, app }) => {
    await open(page, app, doc([edge('s', 'a', 'b', { via: [[4, 3]] }), edge('t', 'a', 'c')]))
    await select(page, 's', 0.1)
    await bar(page, 'Straighten').click()
    const run = await at(page, 't', 0.5), d = await app.cells(2.5, 0)
    await select(page, 't')
    await app.drag(run, { x: run.x + d.x, y: run.y + d.y })
    const s = await saved(app, 's'), t = await saved(app, 't')
    expect(s.runs).toEqual([])
    expect(t.runs).toHaveLength(3)
    const drawn = [await path(page, 's'), await path(page, 't')]
    await page.reload(); await app.ready(); await plan(page)
    expect([await path(page, 's'), await path(page, 't')]).toEqual(drawn)
    expect(await app.saved()).toMatchObject({ edges: [{ id: 's', runs: [] }, { id: 't', runs: t.runs }] })
  })
})
