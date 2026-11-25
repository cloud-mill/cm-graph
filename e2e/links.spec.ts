import type { Page } from '@playwright/test'
import { expect, makeDoc, rested, test } from './fixtures'

/**
 * Connections, driven with a real mouse: every check either reads the line as
 * it is drawn on screen or reads the blueprint as it was saved.
 */
const edgeOf = (extra: object = {}) => ({ id: 'e', from: 'a', to: 'b', style: 'solid', arrow: 'end', width: 2, ...extra })
const PAIR = (extra: object = {}, more: object[] = []) => makeDoc(
  [{ id: 'a', type: 'ec2', x: 0, y: 0, name: 'web' }, { id: 'b', type: 'rds', x: 8, y: 0, name: 'db' }, { id: 'c', type: 'sqs', x: 8, y: 6, name: 'jobs' }, ...(more as any[])],
  { edges: [edgeOf(extra) as any] },
)
/** points along a connection as drawn, in screen px */
const lineOf = (page: Page, id = 'e', n = 60) => page.evaluate(([id, n]) => {
  const el = document.querySelector(`.edge-hit[data-id="${id}"]`) as SVGPathElement, m = el.getScreenCTM()!, L = el.getTotalLength()
  return Array.from({ length: (n as number) + 1 }, (_, i) => { const p = el.getPointAtLength((L * i) / (n as number)); return { x: p.x * m.a + p.y * m.c + m.e, y: p.x * m.b + p.y * m.d + m.f } })
}, [id, n] as const)
const middle = async (page: Page, id = 'e') => { const pts = await lineOf(page, id, 2); return pts[1] }
const handle = (page: Page, name: string) => page.locator(`[data-handle="${name}"]`).last()
const centre = async (page: Page, name: string) => { const b = (await handle(page, name).boundingBox())!; return { x: b.x + b.width / 2, y: b.y + b.height / 2 } }
const plan = async (page: Page) => { await page.keyboard.press('2'); await page.waitForTimeout(800); await rested(page) }
const E = async (app: any) => (await app.settled()).edges.find((x: any) => x.id === 'e')
/** screen offset for a move of (dx, dy) cells, measured from this layout: b is 8 cells along x from a, c is 6 along y from b */
const cells = async (app: any, dx: number, dy: number) => {
  const [a, b, c] = await app.corners(['a', 'b', 'c'])
  return { x: ((b.x - a.x) / 8) * dx + ((c.x - b.x) / 6) * dy, y: ((b.y - a.y) / 8) * dx + ((c.y - b.y) / 6) * dy }
}
const box = async (app: any, id: string) => (await app.node(id).locator('.nd-body').boundingBox())!

test.describe('connections: routing', () => {
  test('a line goes round a component that is in its way, in right angles', async ({ page, app }) => {
    await app.open(PAIR({}, [{ id: 'wall', type: 's3', x: 4, y: 0, name: 'wall' }]))
    await plan(page)
    const wall = (await app.node('wall').locator('.nd-body').boundingBox())!
    const pts = await lineOf(page, 'e', 200)
    // no point of the line is inside the component it has to avoid
    const inside = pts.filter((p) => p.x > wall.x + 2 && p.x < wall.x + wall.width - 2 && p.y > wall.y + 2 && p.y < wall.y + wall.height - 2)
    expect(inside).toHaveLength(0)
    // and it starts at web and ends at db
    const a = await box(app, 'a'), b = await box(app, 'b')
    const touches = (p: { x: number; y: number }, r: { x: number; y: number; width: number; height: number }) => p.x > r.x - 30 && p.x < r.x + r.width + 30 && p.y > r.y - 30 && p.y < r.y + r.height + 30
    expect(touches(pts[0], a)).toBe(true)
    expect(touches(pts.at(-1)!, b)).toBe(true)
  })

  test('a line is planned once: a component dropped in its way does not re-route it, and moving one of its own ends does', async ({ page, app }) => {
    const doc = PAIR({ via: [[5, 4]] }, [{ id: 'd', type: 's3', x: 0, y: 6, name: 'files' }])
    doc.edges.push({ id: 'auto', from: 'a', to: 'c', style: 'solid', arrow: 'end', width: 2 } as any)
    await app.open(doc)
    await plan(page)
    const shaped0 = await page.locator('.edge-hit[data-id="e"]').getAttribute('d'), auto0 = await page.locator('.edge-hit[data-id="auto"]').getAttribute('d')
    // drag another component into the middle of things
    const d = await box(app, 'd'), by = await cells(app, 4, -3)
    await page.mouse.click(d.x + d.width / 2, d.y + d.height / 2)
    await app.drag({ x: d.x + d.width / 2, y: d.y + d.height / 2 }, { x: d.x + d.width / 2 + by.x, y: d.y + d.height / 2 + by.y })
    const moved = (await app.settled()).nodes.find((n: any) => n.id === 'd')!
    expect(moved.x).toBeCloseTo(4, 1); expect(moved.y).toBeCloseTo(3, 1)
    // neither line has anything to do with what moved, so neither changes: not the one the router planned, nor the one shaped by hand
    expect(await page.locator('.edge-hit[data-id="auto"]').getAttribute('d')).toBe(auto0)
    expect((await E(app)).via).toEqual([[5, 4]])
    expect(await page.locator('.edge-hit[data-id="e"]').getAttribute('d')).toBe(shaped0)
    // moving one of the planned line's own ends is what re-plans it
    const c = await box(app, 'c'), up = await cells(app, 0, -2)
    await app.drag({ x: c.x + c.width / 2, y: c.y + c.height / 2 }, { x: c.x + c.width / 2 + up.x, y: c.y + c.height / 2 + up.y })
    expect(await page.locator('.edge-hit[data-id="auto"]').getAttribute('d')).not.toBe(auto0)
    expect(await page.locator('.edge-hit[data-id="e"]').getAttribute('d')).toBe(shaped0)
  })

  test('two connections between the same pair are drawn apart', async ({ page, app }) => {
    await app.open(PAIR())
    await plan(page)
    await page.mouse.click(...Object.values(await middle(page)) as [number, number])
    await page.getByRole('button', { name: 'Second connection' }).click()
    const doc = await app.settled()
    expect(doc.edges).toHaveLength(2)
    const [p, q] = await Promise.all(doc.edges.map((e: any) => lineOf(page, e.id, 10)))
    // side by side all the way: never on top of each other
    for (let i = 0; i <= 10; i++) expect(Math.hypot(p[i].x - q[i].x, p[i].y - q[i].y)).toBeGreaterThan(4)
  })
})

test.describe('connections: shaping by hand', () => {
  test.beforeEach(async ({ page, app }) => { await app.open(PAIR()); await plan(page) })
  const select = async (page: Page) => { const m = await middle(page); await page.mouse.click(m.x + 60, m.y) }
  const pull = async (page: Page, app: any, name: string, dx: number, dy: number) => {
    const from = await centre(page, name), d = await cells(app, dx, dy)
    await page.mouse.move(from.x, from.y); await page.mouse.down(); await page.mouse.move(from.x + d.x, from.y + d.y, { steps: 8 }); await page.mouse.up()
  }

  test('selecting shows what it joins, the ends, a run to take hold of, and a bar clear of the line', async ({ page }) => {
    await select(page)
    await expect(page.locator('.insp-sub').first()).toHaveText('web connects to db')
    await expect(handle(page, 'ea')).toBeVisible()
    await expect(handle(page, 'eb')).toBeVisible()
    await expect(handle(page, 's0')).toHaveCount(1)
    // the bar never covers the line it is for
    const bar = (await page.locator('.edge-bar').boundingBox())!
    for (const p of await lineOf(page, 'e', 40)) expect(p.x > bar.x && p.x < bar.x + bar.width && p.y > bar.y && p.y < bar.y + bar.height).toBe(false)
  })

  test('pulling the line sideways takes it round; that survives undo, redo and a reload', async ({ page, app }) => {
    await select(page)
    await pull(page, app, 's0', 0, 4)
    const runs = (await E(app)).runs
    expect(runs).toEqual([2.5, 5, 7.5]) // out of web, along four cells below where it was, and in to db
    // the line as drawn really does run along y = 5
    const low = await centre(page, 's2'), pts = await lineOf(page, 'e', 200)
    expect(Math.min(...pts.map((p) => Math.hypot(p.x - low.x, p.y - low.y)))).toBeLessThan(3)
    await app.mod('z')
    expect((await E(app)).runs).toBeUndefined()
    await expect(handle(page, 'ea')).toBeVisible() // still selected: undo does not drop what is being edited
    await page.keyboard.press('ControlOrMeta+Shift+z')
    expect((await E(app)).runs).toEqual(runs)
    await page.reload(); await app.ready()
    expect(((await app.saved())!.edges[0] as any).runs).toEqual(runs)
  })

  test('one run moves on its own, and with snapping on, pulled back level with the ends the line is straight again', async ({ page, app }) => {
    await page.keyboard.press('s') // snapping is off until it is asked for
    await select(page)
    await pull(page, app, 's0', 0, 4)
    await pull(page, app, 's2', 0, -2)
    expect((await E(app)).runs).toEqual([2.5, 3, 7.5])
    // within a few pixels is enough: it is drawn onto the line the ends are on (they stopped at the corners of their sides, y = 1.85)
    await pull(page, app, 's2', 0, -1.13)
    expect((await E(app)).runs).toEqual([])
    await expect(page.locator('.run-hit')).toHaveCount(1)
    expect((await page.locator('.edge-hit[data-id="e"]').getAttribute('d'))!.includes('Q')).toBe(false)
  })

  test('dragging an end onto another component reconnects it there', async ({ page, app }) => {
    await select(page)
    const end = await centre(page, 'eb'), jobs = await box(app, 'c')
    await page.mouse.move(end.x, end.y); await page.mouse.down()
    await page.mouse.move(jobs.x + jobs.width / 2, jobs.y + jobs.height / 2, { steps: 10 })
    await expect(page.locator('.wire')).toBeVisible()
    await page.mouse.up()
    expect(await E(app)).toMatchObject({ from: 'a', to: 'c' })
    await expect(page.locator('.insp-sub').first()).toHaveText('web connects to jobs')
    await app.mod('z')
    expect(await E(app)).toMatchObject({ from: 'a', to: 'b' })
  })

  test('the handles stay on the line when the camera turns and tilts', async ({ page, app }) => {
    await select(page)
    await pull(page, app, 's0', 0, 4)
    for (const key of ['3', 'q', 'q', 'e']) {
      await page.keyboard.press(key); await page.waitForTimeout(700)
      const pts = await lineOf(page, 'e', 300)
      const near = (p: { x: number; y: number }) => Math.min(...pts.map((q) => Math.hypot(q.x - p.x, q.y - p.y)))
      expect(near(await centre(page, 'ea')), `start handle after "${key}"`).toBeLessThan(3)
      expect(near(await centre(page, 'eb')), `end handle after "${key}"`).toBeLessThan(3)
      expect(near(await centre(page, 's2')), `middle run after "${key}"`).toBeLessThan(3)
    }
  })

  test('"Route automatically" hands a shaped line back, as one undo step', async ({ page, app }) => {
    await select(page)
    await pull(page, app, 's0', 0, 4)
    expect((await E(app)).runs).toHaveLength(3)
    await page.locator('.panel.right').getByRole('button', { name: 'Route automatically' }).click()
    expect((await E(app)).runs).toBeUndefined()
    await app.mod('z')
    expect((await E(app)).runs).toHaveLength(3)
  })
})

test.describe('connections: meaning and flow', () => {
  test('relationship, protocol and port are written along the line and saved', async ({ page, app }) => {
    await app.open(PAIR()); await plan(page)
    const m = await middle(page); await page.mouse.click(m.x + 60, m.y)
    await page.getByRole('combobox', { name: 'Relationship' }).click()
    await page.getByRole('option', { name: 'Data' }).click()
    await page.getByLabel('Protocol', { exact: true }).fill('PostgreSQL')
    await page.getByLabel('Port', { exact: true }).fill('5432')
    await page.getByLabel('Port', { exact: true }).press('Enter')
    await expect(page.locator('.edge-caption')).toHaveText('POSTGRESQL 5432')
    await expect(page.locator('.insp-sub').first()).toHaveText('web reads and writes db over PostgreSQL 5432')
    expect(await E(app)).toMatchObject({ kind: 'data', protocol: 'PostgreSQL', port: '5432' })
    await page.getByLabel('Port', { exact: true }).fill('nonsense')
    await expect(page.getByText('The port is not a number, a range or a list of numbers.')).toBeVisible()
  })

  test('following the flow lights the paths through a component and steps the rest back', async ({ page, app }) => {
    const doc = makeDoc(
      [{ id: 'u', type: 'users', x: -8, y: 0, name: 'Clients' }, { id: 'a', type: 'ec2', x: 0, y: 0, name: 'web' }, { id: 'b', type: 'rds', x: 8, y: 0, name: 'db' }, { id: 'c', type: 's3', x: 0, y: 8, name: 'aside' }, { id: 'd', type: 'sqs', x: 8, y: 8, name: 'apart' }],
      { edges: [{ id: 'e1', from: 'u', to: 'a' }, { id: 'e2', from: 'a', to: 'b' }, { id: 'e3', from: 'c', to: 'd' }].map((e) => ({ ...e, style: 'solid', arrow: 'end', width: 2 })) as any },
    )
    await app.open(doc)
    await app.pick('b')
    await page.getByRole('button', { name: 'Follow the flow' }).click()
    await expect(page.locator('.trace-bar')).toContainText('Following db · 2 upstream, nothing downstream')
    await expect(page.locator('.nd.off')).toHaveCount(2)
    await expect(page.locator('.edge.on')).toHaveCount(2)
    await expect(page.locator('.edge.off')).toHaveCount(1)
    // stepped back, not hidden
    expect(Number(await app.node('c').evaluate((el) => getComputedStyle(el).opacity))).toBeGreaterThan(0.1)
    await page.keyboard.press('Escape')
    await expect(page.locator('.trace-bar')).toHaveCount(0)
    await expect(page.locator('.nd.off, .edge.off')).toHaveCount(0)
    // following a flow changes nothing in the blueprint
    await expect(page.locator('.save-state')).toContainText('Saved')
  })

  test('an older blueprint with plain connections opens and routes without complaint', async ({ page, app }) => {
    await app.open(PAIR())
    await expect(page.locator('.edge-hit')).toHaveCount(1)
    // nothing about the connection is changed by opening it; it only gains the path that was planned for it, so that it is planned once
    const { plan, ...rest } = (await app.saved())!.edges[0] as any
    expect(rest).toEqual({ id: 'e', from: 'a', to: 'b', style: 'solid', arrow: 'end', width: 2 })
    expect(plan.pts.length).toBeGreaterThanOrEqual(2)
  })
})
