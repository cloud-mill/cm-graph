import type { Page } from '@playwright/test'
import { type App, expect, makeDoc, rested, test } from './fixtures'

/**
 * A connection in the hand does what the hand does. It goes exactly as far as the pointer goes, stays where it
 * is put when it is let go, and is not re-planned afterwards by anything else that happens in the diagram.
 * Every check is made with a real mouse, against the line as drawn on screen or the blueprint as saved.
 */
type Extra = Record<string, unknown>
const edge = (id: string, from: string, to: string, extra: Extra = {}) => ({ id, from, to, style: 'solid', arrow: 'end', width: 2, ...extra }) as any
/**
 * `a`, `b` and `c` where the screen measurements expect them, and `d` four cells below `b`'s row: the line `e` from `a` to `d`
 * is a Z that leaves `a` at y = 1, goes down at x = 4 and arrives at y = 5.
 */
const doc = (edges: any[] = [edge('e', 'a', 'd')], d: Extra = {}, more: any[] = []) => makeDoc(
  [{ id: 'a', type: 'ec2', x: 0, y: 0, name: 'web' }, { id: 'b', type: 'rds', x: 6, y: 0, name: 'db' }, { id: 'c', type: 's3', x: 0, y: 6, name: 'files' }, { id: 'd', type: 'sqs', x: 6, y: 4, name: 'jobs', ...d }, ...more],
  { edges },
)
const path = (page: Page, id = 'e') => page.locator(`.edge-hit[data-id="${id}"]`).getAttribute('d').then((d) => d!)
const turns = async (page: Page, id = 'e') => ((await path(page, id)).match(/Q/g) ?? []).length
/** the point a fraction `t` of the way along a line, on screen */
const at = (page: Page, t = 0.5, id = 'e') => page.evaluate(([id, t]) => {
  const el = document.querySelector(`.edge-hit[data-id="${id}"]`) as SVGPathElement, m = el.getScreenCTM()!, p = el.getPointAtLength(el.getTotalLength() * (t as number))
  return { x: p.x * m.a + p.y * m.c + m.e, y: p.x * m.b + p.y * m.d + m.f }
}, [id, t] as const)
/** how far a point on screen is from the nearest part of a line, in pixels */
const gap = (page: Page, p: { x: number; y: number }, id = 'e') => page.evaluate(([id, p]) => {
  const el = document.querySelector(`.edge-hit[data-id="${id}"]`) as SVGPathElement, m = el.getScreenCTM()!, n = el.getTotalLength()
  let least = Infinity
  for (let i = 0; i <= 2000; i++) { const q = el.getPointAtLength((n * i) / 2000); least = Math.min(least, Math.hypot(q.x * m.a + q.y * m.c + m.e - (p as any).x, q.x * m.b + q.y * m.d + m.f - (p as any).y)) }
  return least
}, [id, p] as const)
const centre = async (page: Page, handle: string) => { const b = (await page.locator(`[data-handle="${handle}"]`).first().boundingBox())!; return { x: b.x + b.width / 2, y: b.y + b.height / 2 } }
const select = async (page: Page, t = 0.5, id = 'e') => { const p = await at(page, t, id); await page.mouse.click(p.x, p.y); await expect(page.locator('.edge-bar')).toBeVisible() }
const saved = async (app: App, id = 'e') => (await app.settled()).edges.find((e) => e.id === id) as any
const bar = (page: Page, name: string) => page.locator('.edge-bar').getByRole('button', { name, exact: true })
const plan = async (page: Page) => { await page.keyboard.press('2'); await page.waitForTimeout(800); await rested(page) }
const open = async (page: Page, app: App, d = doc()) => { await app.open(d); await plan(page) }

test.describe('the line goes where the pointer goes', () => {
  test('a pixel at a time, a run is never more than a pixel from the pointer, and it does not jump as it is picked up', async ({ page, app }) => {
    await open(page, app)
    await select(page)
    const m = await at(page)
    // caught five pixels to one side of the line, as a hand does
    await page.mouse.move(m.x + 5, m.y); await page.mouse.down()
    let worst = 0
    for (let i = 1; i <= 90; i++) {
      await page.mouse.move(m.x + 5 + i, m.y)
      if (i < 5) continue // a press only becomes a drag once it has moved a little
      worst = Math.max(worst, Math.abs((await at(page)).x - (m.x + i)))
    }
    expect(worst).toBeLessThanOrEqual(1)
    const held = await path(page)
    await page.mouse.up()
    // and what was on screen as it was let go is what stays
    expect(await path(page)).toBe(held)
    expect((await at(page)).x).toBeCloseTo(m.x + 90, 0)
  })

  test('with snapping on it settles on things only from a few pixels away, and never trails the pointer by more than that', async ({ page, app }) => {
    await open(page, app)
    await page.getByRole('button', { name: /Snap to grid: off/ }).click()
    await select(page)
    const m = await at(page), cell = (await app.cells(1, 0)).x
    await page.mouse.move(m.x, m.y); await page.mouse.down()
    let worst = 0
    const seen = new Set<number>()
    for (let i = 5; i <= cell; i++) { await page.mouse.move(m.x + i, m.y); const x = (await at(page)).x; seen.add(Math.round(x)); worst = Math.max(worst, Math.abs(x - (m.x + i))) }
    await page.mouse.up()
    expect(worst).toBeLessThanOrEqual(4)
    // it used to hop from one half cell to the next: now it stops nearly everywhere along the way
    expect(seen.size).toBeGreaterThan(cell * 0.7)
  })

  test('dragged fast or slowly it ends in the same place', async ({ page, app }) => {
    await open(page, app)
    await select(page)
    const m = await at(page), to = { x: m.x - 77, y: m.y + 40 }
    await page.mouse.move(m.x, m.y); await page.mouse.down(); await page.mouse.move(to.x, to.y, { steps: 1 }); await page.mouse.up()
    const fast = (await saved(app)).runs
    await app.mod('z')
    expect((await saved(app)).runs).toBeUndefined()
    const again = await at(page)
    await page.mouse.move(again.x, again.y); await page.mouse.down(); await page.mouse.move(to.x, to.y, { steps: 80 }); await page.mouse.up()
    expect((await saved(app)).runs).toEqual(fast)
  })

  test('in the isometric view, zoomed and turned, the run still passes under the pointer', async ({ page, app }) => {
    await app.open(doc())
    await page.keyboard.press('q'); await page.waitForTimeout(700) // turn the view an eighth of the way round
    await page.mouse.move(700, 450); await page.mouse.wheel(0, -300); await page.waitForTimeout(600)
    await select(page)
    const m = await at(page), to = { x: m.x + 63, y: m.y - 18 }
    await page.mouse.move(m.x, m.y); await page.mouse.down(); await page.mouse.move(to.x, to.y, { steps: 15 })
    expect(await gap(page, to)).toBeLessThanOrEqual(1.5)
    // zooming with the wheel while it is held: at the next move it is under the pointer again
    await page.mouse.wheel(0, 200); await page.waitForTimeout(500)
    await page.mouse.move(to.x + 9, to.y + 4, { steps: 3 })
    expect(await gap(page, { x: to.x + 9, y: to.y + 4 })).toBeLessThanOrEqual(1.5)
    await page.mouse.up()
    expect((await saved(app)).runs).toHaveLength(1)
  })
})

test.describe('it stays where it was put', () => {
  test('letting go, deselecting, picking it again and reloading all leave the line exactly as it was', async ({ page, app }) => {
    await open(page, app)
    await select(page)
    const m = await at(page)
    await page.mouse.move(m.x, m.y); await page.mouse.down(); await page.mouse.move(m.x + 47, m.y, { steps: 9 })
    const held = await path(page)
    await page.mouse.up()
    expect(await path(page)).toBe(held)
    await page.keyboard.press('Escape')
    expect(await path(page)).toBe(held)
    await select(page)
    expect(await path(page)).toBe(held)
    const was = await saved(app)
    await page.reload(); await app.ready(); await plan(page)
    expect(await path(page)).toBe(held)
    expect(await saved(app)).toEqual(was)
  })

  test('taking a line in hand does not move the line beside it on the same side', async ({ page, app }) => {
    // two lines leave the east side of `a`, spread apart: shaping one used to let the other slide to the middle
    await open(page, app, doc([edge('e', 'a', 'd'), edge('f', 'a', 'b')]))
    const beside = await path(page, 'f')
    await select(page)
    const m = await at(page)
    await page.mouse.move(m.x, m.y); await page.mouse.down(); await page.mouse.move(m.x + 30, m.y, { steps: 6 })
    expect(await path(page, 'f')).toBe(beside)
    await page.mouse.up()
    expect(await path(page, 'f')).toBe(beside)
    expect((await saved(app)).runs).toHaveLength(1)
  })

  test('nothing that happens afterwards re-plans it: a component dropped on it, another line added, or its own component moved', async ({ page, app }) => {
    await open(page, app, doc([edge('e', 'a', 'd')], {}, [{ id: 'x', type: 'lambda', x: 10, y: 8, name: 'fn' }]))
    await select(page)
    const m = await at(page)
    await page.mouse.move(m.x, m.y); await page.mouse.down(); await page.mouse.move(m.x - 40, m.y, { steps: 8 }); await page.mouse.up()
    const mine = await path(page), runs = (await saved(app)).runs
    await page.keyboard.press('Escape')
    // a component dragged to stand right on the line: an automatic line would go round it
    const x = await app.world(11, 9), on = await at(page)
    await app.drag(x, { x: on.x + 10, y: on.y }, { steps: 10 })
    expect((await app.settled()).nodes.find((n) => n.id === 'x')).not.toMatchObject({ x: 10, y: 8 })
    expect(await path(page)).toBe(mine)
    await app.mod('z')
    // its own component moved two cells along: the run in the middle is still where it was put, and the line still arrives
    const d = await app.world(7, 5), by = await app.cells(2, 0)
    await app.drag(d, { x: d.x + by.x, y: d.y + by.y }, { steps: 10 })
    expect((await app.settled()).nodes.find((n) => n.id === 'd')).toMatchObject({ x: 8, y: 4 })
    expect((await saved(app)).runs).toEqual(runs)
    expect(await turns(page)).toBe(2)
    // one undo puts the component back, and the line is as it was to the pixel
    await app.mod('z')
    expect(await path(page)).toBe(mine)
  })

  test('undo and redo step through each reshaping exactly', async ({ page, app }) => {
    await open(page, app)
    const start = await path(page)
    await select(page)
    const m = await at(page)
    await page.mouse.move(m.x, m.y); await page.mouse.down(); await page.mouse.move(m.x + 33, m.y, { steps: 5 }); await page.mouse.up()
    const one = await path(page)
    const n = await at(page)
    await page.mouse.move(n.x, n.y); await page.mouse.down(); await page.mouse.move(n.x - 71, n.y, { steps: 5 }); await page.mouse.up()
    const two = await path(page)
    await app.mod('z'); expect(await path(page)).toBe(one)
    await app.mod('z'); expect(await path(page)).toBe(start)
    await page.keyboard.press('Control+Shift+z'); expect(await path(page)).toBe(one)
    await page.keyboard.press('Control+Shift+z'); expect(await path(page)).toBe(two)
  })
})

test.describe('whose line it is', () => {
  test('the bar and the inspector say so, and hand it over either way without the line moving', async ({ page, app }) => {
    await open(page, app)
    await select(page)
    const planned = await path(page)
    await expect(bar(page, 'Route automatically')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByRole('radio', { name: 'Automatic' })).toBeChecked()
    await bar(page, 'Keep this path').click()
    expect(await path(page)).toBe(planned)
    expect(await saved(app)).toMatchObject({ runs: [4], fromSide: 'e', toSide: 'w' })
    await expect(bar(page, 'Keep this path')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByRole('radio', { name: 'Manual' })).toBeChecked()
    // kept, it no longer follows its component about: the router would have moved the run in the middle to x = 5
    await page.keyboard.press('Escape')
    const d = await app.world(7, 5), by = await app.cells(2, 0)
    await app.drag(d, { x: d.x + by.x, y: d.y + by.y }, { steps: 10 })
    expect((await saved(app)).runs).toEqual([4])
    // handed back, the router plans it afresh
    await select(page, 0.3)
    await page.getByRole('radio', { name: 'Automatic' }).click()
    expect((await saved(app)).runs).toBeUndefined()
    await expect(bar(page, 'Route automatically')).toHaveAttribute('aria-pressed', 'true')
    expect((await at(page)).x).toBeCloseTo((await app.world(5, 0)).x, 0)
  })

  test('dragging a line the router planned makes it the user\'s in the same gesture, and it stays theirs', async ({ page, app }) => {
    await open(page, app)
    const m = await at(page)
    // not even selected first
    await page.mouse.move(m.x, m.y); await page.mouse.down(); await page.mouse.move(m.x + 25, m.y, { steps: 5 }); await page.mouse.up()
    await expect(bar(page, 'Keep this path')).toHaveAttribute('aria-pressed', 'true')
    expect((await saved(app)).runs).toHaveLength(1)
    expect(await app.toast(/./).count()).toBe(0)
  })
})

test.describe('bends', () => {
  test('one is added where the menu is opened, a turn is moved by hand, and double-click takes it out again', async ({ page, app }) => {
    await open(page, app)
    await select(page)
    const m = await at(page)
    await page.mouse.click(m.x, m.y, { button: 'right' })
    await page.getByRole('button', { name: 'Add a bend here' }).click()
    expect(await turns(page)).toBe(4)
    expect((await saved(app)).runs).toHaveLength(3)
    // the turn where the step begins: both runs that meet at it follow it
    const before = (await saved(app)).runs
    const c = await centre(page, 'c2'), by = await app.cells(-1, -0.5)
    await app.drag(c, { x: c.x + by.x, y: c.y + by.y }, { steps: 8 })
    const after = (await saved(app)).runs
    expect(after[0]).toBeCloseTo(before[0] - 1, 1)
    expect(after[1]).toBeCloseTo(before[1] - 0.5, 1)
    expect(after[2]).toBe(before[2])
    // double-click on a turn of the step takes the step out
    const t = await centre(page, 'c3')
    await page.mouse.dblclick(t.x, t.y)
    expect(await turns(page)).toBe(2)
    await app.mod('z')
    expect(await turns(page)).toBe(4)
  })
})

test.describe('snapping helps and gives way', () => {
  test('snapping is off until it is asked for: a run stays where it is put. Turned on, it settles where the line would be straight; Ctrl flips it for one drag, and Alt holds it off', async ({ page, app }) => {
    // `d` one cell below `a`'s row: the two ends can meet on y = 1.85
    await open(page, app, doc([edge('e', 'a', 'd', { fromSide: 'e', toSide: 'w', fromAt: 0, toAt: 0, runs: [4] })], { y: 1 }))
    expect(await turns(page)).toBe(2)
    await select(page, 0.1)
    const pull = async (key?: 'Alt' | 'Control') => {
      const s = await centre(page, 's0'), down = (await app.cells(0, 0.85)).y - 4
      if (key) await page.keyboard.down(key)
      await app.drag(s, { x: s.x, y: s.y + down }, { steps: 8 })
      if (key) await page.keyboard.up(key)
    }
    // off: four pixels short of where the two ends could meet is where it stays, since the far end would have to move for it
    await pull()
    expect(await turns(page)).toBe(2)
    expect((await saved(app)).runs).toEqual([4])
    await app.mod('z')
    // Ctrl turns it on for the one drag
    await pull('Control')
    expect(await turns(page)).toBe(0)
    await app.mod('z')
    // turned on from the toolbar, it settles; and then Ctrl or Alt is what holds it off
    await page.getByRole('button', { name: /Snap to grid: off/ }).click()
    await expect(page.getByRole('button', { name: /Snap to grid: on/ })).toBeVisible()
    await pull()
    expect(await turns(page)).toBe(0)
    expect((await saved(app)).runs).toEqual([])
    await app.mod('z')
    await pull('Control')
    expect(await turns(page)).toBe(2)
    await app.mod('z')
    await pull('Alt')
    expect(await turns(page)).toBe(2)
  })

  test('an end run pulled past the corner of its component follows the pointer round it, without sticking first', async ({ page, app }) => {
    await open(page, app)
    await select(page, 0.1)
    const s = await centre(page, 's0'), cell = (await app.cells(0, 1)).y
    await page.mouse.move(s.x, s.y); await page.mouse.down()
    // the side ends 0.85 of a cell below the middle: just past it the run is already going round, still under the pointer
    for (const dy of [0.5, 0.9, 1.0, 1.3, 2]) {
      const p = { x: s.x, y: s.y + dy * cell }
      await page.mouse.move(p.x, p.y, { steps: 4 })
      expect(await gap(page, p), `under the pointer ${dy} cells down`).toBeLessThanOrEqual(1.5)
    }
    await page.mouse.up()
    expect((await saved(app)).runs).toHaveLength(3)
  })
})
