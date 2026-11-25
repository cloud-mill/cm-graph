import type { Page } from '@playwright/test'
import { type App, expect, makeDoc, rested, test } from './fixtures'

/**
 * The canvas is the user's. Whatever is on screen when the pointer is let go is what stays: nothing is
 * rounded to a grid, pushed off a neighbour, eased into place or re-planned afterwards, and nothing that was
 * not being moved changes at all. Each test photographs the geometry of the whole scene (where every component,
 * group and label is drawn, and the path of every line) at the last frame of a drag, and compares it with the
 * scene after release and after everything else a user does next.
 */
type Extra = Record<string, unknown>
const edge = (id: string, from: string, to: string, extra: Extra = {}) => ({ id, from, to, style: 'solid', arrow: 'end', width: 2, ...extra }) as any
/** a small but real diagram: four components, a line the router planned, one shaped by hand, one unrelated to `a`, a group and a label */
const diagram = (more: Extra = {}) => makeDoc(
  [{ id: 'a', type: 'ec2', x: 0, y: 0, name: 'web' }, { id: 'b', type: 'rds', x: 6, y: 0, name: 'db' }, { id: 'c', type: 's3', x: 0, y: 6, name: 'files' }, { id: 'd', type: 'sqs', x: 6, y: 5, name: 'jobs' }, { id: 'g', type: 'lambda', x: 12, y: 3, name: 'fn' }],
  {
    edges: [edge('auto', 'a', 'd'), edge('hand', 'a', 'b', { fromSide: 'e', toSide: 'w', fromAt: 0.4, toAt: 0.4, runs: [3.3, -1.2, 5.1] }), edge('other', 'c', 'g')],
    areas: [{ id: 'grp', x: 11, y: 2, w: 5, d: 5, name: 'Group', color: '#8F6FF2', kind: 'group' }],
    labels: [{ id: 'note', x: 3, y: 9, text: 'Note', size: 20, dir: 'x' }],
    ...more,
  },
)

/** Where everything is drawn, in screen pixels, and how every line runs: the scene exactly as the user sees it. */
const scene = (page: Page) => page.evaluate(() => {
  const r1 = (v: number) => Math.round(v * 10) / 10
  const out: Record<string, string> = {}
  for (const el of document.querySelectorAll<SVGGraphicsElement>('.canvas-surface [data-kind="node"], .canvas-surface [data-kind="label"]')) { const m = el.getScreenCTM()!; out[el.dataset.kind + ':' + el.dataset.id] = r1(m.e) + ',' + r1(m.f) }
  // the body is measured too, so a component that is drawn lifted or shifted within its own frame is caught
  for (const el of document.querySelectorAll<SVGGraphicsElement>('.canvas-surface [data-kind="node"] .nd-body')) { const b = el.getBoundingClientRect(); out['body:' + (el.closest('[data-kind]') as HTMLElement).dataset.id] = [b.x, b.y, b.width, b.height].map(r1).join(',') }
  document.querySelectorAll<SVGGraphicsElement>('.canvas-surface [data-kind="area"]').forEach((el, i) => { const b = el.getBoundingClientRect(); out['area:' + el.dataset.id + ':' + i] = [b.x, b.y, b.width, b.height].map(r1).join(',') })
  for (const el of document.querySelectorAll<SVGPathElement>('.canvas-surface .edge-hit')) out['line:' + el.dataset.id] = el.getAttribute('d')!
  return out
})
/** the parts of two scenes that differ, by name: empty when they are the same */
const changed = (a: Record<string, string>, b: Record<string, string>) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k]).sort()
/** the same, saying what each was and became: for the message when something that should not have moved did */
const diff = (a: Record<string, string>, b: Record<string, string>) => changed(a, b).map((k) => `${k}: ${a[k]} -> ${b[k]}`)
/** what the blueprint holds about where things are: the single source of the geometry, as saved */
const geometry = async (app: App) => {
  const d = (await app.settled()) as any
  return {
    nodes: d.nodes.map((n: any) => [n.id, n.x, n.y, n.scale ?? 1]),
    areas: d.areas.map((a: any) => [a.id, a.x, a.y, a.w, a.d]),
    labels: d.labels.map((l: any) => [l.id, l.x, l.y]),
    edges: d.edges.map((e: any) => [e.id, e.fromSide, e.toSide, e.fromAt, e.toAt, e.runs, e.plan?.pts]),
  }
}
const plan = async (page: Page) => { await page.keyboard.press('2'); await page.waitForTimeout(800); await rested(page) }
const open = async (page: Page, app: App, d = diagram()) => { await app.open(d); await plan(page) }
const middle = async (page: Page, id: string) => { const b = (await page.locator(`[data-kind="node"][data-id="${id}"] .nd-body`).boundingBox())!; return { x: b.x + b.width / 2, y: b.y + b.height / 2 } }
/** press, carry by (dx, dy) pixels, and stop with the button still down: returns the scene at that last frame */
const carry = async (page: Page, from: { x: number; y: number }, dx: number, dy: number, steps = 9) => {
  await page.mouse.move(from.x, from.y); await page.mouse.down()
  await page.mouse.move(from.x + dx, from.y + dy, { steps })
  await page.waitForTimeout(60)
  return scene(page)
}
/** let go, give anything that might run afterwards time to run, move the pointer away, and photograph the scene again */
const release = async (page: Page) => { await page.mouse.up(); await page.waitForTimeout(450); await page.mouse.move(4, 400); await page.waitForTimeout(250); return scene(page) }

test.describe('what is on screen when the pointer is let go is what stays', () => {
  test('a component dragged to arbitrary places, again and again, by a lot and by a few pixels: nothing moves after release, and nothing else moves at all', async ({ page, app }) => {
    await open(page, app)
    const start = await scene(page)
    // (a move of under four pixels is a click, not a drag: see the arrow keys for anything finer)
    for (const [dx, dy] of [[37, 23], [5, 0], [-18, 31], [0, 5], [64, -9], [-4, -3], [121, 77]]) {
      const before = await scene(page)
      const origin = before['node:a'].split(',').map(Number)
      const held = await carry(page, await middle(page, 'a'), dx, dy)
      // it went exactly as far as the pointer did
      const now = held['node:a'].split(',').map(Number)
      expect(Math.abs(now[0] - origin[0] - dx), `went ${dx}px along`).toBeLessThanOrEqual(0.6)
      expect(Math.abs(now[1] - origin[1] - dy), `went ${dy}px down`).toBeLessThanOrEqual(0.6)
      // while it was carried, only it and its own two lines changed
      expect(changed(before, held)).toEqual(['body:a', 'line:auto', 'line:hand', 'node:a'])
      // and letting go changed nothing whatever
      expect(changed(held, await release(page)), `after moving (${dx}, ${dy})`).toEqual([])
    }
    // everything that was not touched is exactly where it began
    expect(changed(start, await scene(page))).toEqual(['body:a', 'line:auto', 'line:hand', 'node:a'])
  })

  test('components can be put right up against each other, and on top of each other, and stay there', async ({ page, app }) => {
    // just three, with room all round, so the view has no cause to follow the pointer
    await open(page, app, makeDoc([{ id: 'a', type: 'ec2', x: 0, y: 0 }, { id: 'b', type: 'rds', x: 6, y: 0 }, { id: 'c', type: 's3', x: 0, y: 6 }]))
    const cell = (await app.cells(1, 0)).x, home = (await app.corner('a')).x
    // `a` carried until it stands a few pixels clear of `b`, then until it overlaps it, then right on top of it
    for (const cellsAlong of [3.95, 4.6, 6]) {
      const at = (await app.corner('a')).x
      const held = await carry(page, await middle(page, 'a'), home + cellsAlong * cell - at, 0)
      expect(changed(held, await release(page)), `${cellsAlong} cells along`).toEqual([])
    }
    const g = await geometry(app)
    expect(g.nodes[0][1]).toBeCloseTo(6, 1) // exactly on `b`
    expect(g.nodes[1]).toEqual(['b', 6, 0, 1]) // which was not pushed away
  })

  test('the arrow keys with Alt move a component a twentieth of a cell, for placing it finely', async ({ page, app }) => {
    await open(page, app)
    await app.pick('a')
    await page.keyboard.press('Alt+ArrowRight'); await page.keyboard.press('Alt+ArrowRight'); await page.keyboard.press('Alt+ArrowDown')
    const a = (await geometry(app)).nodes[0]
    expect(a[1]).toBeCloseTo(0.1, 5)
    expect(a[2]).toBeCloseTo(0.05, 5)
  })

  test('several components carried together keep their arrangement, and stay where they are let go', async ({ page, app }) => {
    await open(page, app)
    await app.pick('a')
    await app.pick('c', { shift: true })
    const m = await middle(page, 'd')
    await page.keyboard.down('Shift'); await page.mouse.click(m.x, m.y); await page.keyboard.up('Shift')
    const before = await scene(page)
    const held = await carry(page, await middle(page, 'a'), 43, -27)
    for (const id of ['a', 'c', 'd']) {
      const p = before['node:' + id].split(',').map(Number), q = held['node:' + id].split(',').map(Number)
      expect(Math.abs(q[0] - p[0] - 43)).toBeLessThanOrEqual(0.6)
      expect(Math.abs(q[1] - p[1] + 27)).toBeLessThanOrEqual(0.6)
    }
    expect(held['node:b']).toBe(before['node:b'])
    expect(diff(held, await release(page))).toEqual([])
    await app.mod('z')
    expect(changed(before, await scene(page))).toEqual([])
  })

  test('a group carried with what is inside it, a label, and a resized component and group all stay as they were let go', async ({ page, app }) => {
    await open(page, app)
    // the group, by its edge: the component inside goes with it
    const area = (await page.locator('[data-kind="area"][data-id="grp"]').first().boundingBox())!
    const before = await scene(page)
    let held = await carry(page, { x: area.x + 6, y: area.y + area.height / 2 }, 29, 17)
    expect(held['node:g']).not.toBe(before['node:g'])
    expect(diff(held, await release(page))).toEqual([])
    // the label
    const label = (await page.locator('[data-kind="label"][data-id="note"]').boundingBox())!
    held = await carry(page, { x: label.x + label.width / 2, y: label.y + label.height / 2 }, -33, 11)
    expect(diff(held, await release(page))).toEqual([])
    // a component's corner
    await app.pick('c')
    const corner = (await page.locator('[data-handle="n2"]').first().boundingBox())!
    held = await carry(page, { x: corner.x + corner.width / 2 + 2, y: corner.y + corner.height / 2 + 1 }, 21, 21)
    expect(diff(held, await release(page))).toEqual([])
    expect((await geometry(app)).nodes[2][3]).not.toBe(1)
    // the group's corner (picked by its name, and pulled by the corner that is in view)
    await page.locator('[data-kind="area"][data-id="grp"]').getByText('Group', { exact: false }).first().click()
    const rc = (await page.locator('[data-handle="r0"]').first().boundingBox())!
    held = await carry(page, { x: rc.x + rc.width / 2, y: rc.y + rc.height / 2 }, -19, 13)
    expect(diff(held, await release(page))).toEqual([])
  })

  test('a new component from the library is put exactly where its ghost was shown', async ({ page, app }) => {
    await open(page, app)
    const tile = await app.tile('Function: Lambda')
    await page.mouse.move(tile.x, tile.y); await page.mouse.down()
    await page.mouse.move(700, 500, { steps: 6 }); await page.mouse.move(733, 541, { steps: 4 })
    await page.waitForTimeout(80)
    const ghost = await page.locator('.ghost > g[transform]').evaluate((el) => { const m = (el as unknown as SVGGElement).getScreenCTM()!; return [m.e, m.f] })
    const count = await app.nodes().count()
    await page.mouse.up()
    await expect(app.nodes()).toHaveCount(count + 1)
    await page.waitForTimeout(500)
    const id = (await app.settled()).nodes.at(-1)!.id
    const made = await app.node(id).evaluate((el) => { const m = (el as unknown as SVGGElement).getScreenCTM()!; return [m.e, m.f] })
    expect(Math.hypot(made[0] - ghost[0], made[1] - ghost[1])).toBeLessThanOrEqual(0.6)
  })
})

test.describe('nothing that happens afterwards changes it', () => {
  test('zoom, pan, turn, select, deselect, an unrelated edit, reload, undo and redo: the geometry in the blueprint is the same after every one', async ({ page, app }) => {
    await open(page, app)
    // put things in deliberately awkward places first: two components carried off the grid (the diagram already has a line shaped by hand)
    await carry(page, await middle(page, 'a'), 37, 23); await release(page)
    await carry(page, await middle(page, 'd'), -11, 46); await release(page)
    const made = await geometry(app), drawn = await scene(page)
    const same = async (what: string) => expect(await geometry(app), what).toEqual(made)

    await page.mouse.move(700, 450); await page.mouse.wheel(0, -400); await page.waitForTimeout(500)
    await same('after zooming in')
    await page.mouse.wheel(0, 400); await page.waitForTimeout(500)
    await same('after zooming out')
    await page.keyboard.down('Space'); await app.drag({ x: 700, y: 700 }, { x: 640, y: 660 }); await page.keyboard.up('Space')
    await same('after panning')
    await page.keyboard.press('q'); await page.waitForTimeout(600); await page.keyboard.press('e'); await page.waitForTimeout(600)
    await same('after turning the view and back')
    await page.keyboard.press('3'); await page.waitForTimeout(700); await rested(page); await page.keyboard.press('2'); await page.waitForTimeout(800); await rested(page)
    await same('after the isometric view and back')
    const m = await middle(page, 'b'); await page.mouse.click(m.x, m.y); await page.keyboard.press('Escape')
    await same('after selecting and deselecting')
    // an unrelated edit: a rename
    await page.mouse.click(m.x, m.y)
    await page.locator('.title-input input, input.title-input').first().fill('renamed'); await page.keyboard.press('Enter'); await page.keyboard.press('Escape')
    await same('after renaming another component')

    await page.reload(); await app.ready(); await plan(page)
    await same('after a reload')
    // the view is not the blueprint's to keep, so after a reload it is the lines that are compared: each is drawn along the very same path
    expect(changed(drawn, await sceneOfLines(page, drawn)).filter((k) => k.startsWith('line:'))).toEqual([])

    // one step back and forward again: the same geometry, exactly
    await carry(page, await middle(page, 'c'), 25, -14); await release(page)
    const after = await geometry(app)
    await app.mod('z'); await same('after undo')
    await page.keyboard.press('Control+Shift+z'); expect(await geometry(app)).toEqual(after)
  })

  test('moving a component leaves every line that is not its own exactly as it was, even one it is dropped on top of', async ({ page, app }) => {
    await open(page, app)
    const before = await scene(page)
    // `b` is carried down across the planned line from `a` to `d` and the line from `c` to `g`, and left standing on them
    const held = await carry(page, await middle(page, 'b'), -40, 190, 20)
    expect(held['line:auto']).toBe(before['line:auto'])
    expect(held['line:other']).toBe(before['line:other'])
    const left = await release(page)
    expect(changed(held, left)).toEqual([])
    expect(left['line:auto']).toBe(before['line:auto'])
    expect(left['line:other']).toBe(before['line:other'])
    // only its own line (the hand-shaped one to `a`) followed it
    expect(changed(before, left)).toEqual(['body:b', 'line:hand', 'node:b'])
  })

  test('a new connection does not shift the lines already on that side', async ({ page, app }) => {
    await open(page, app)
    const before = await scene(page)
    // pull a connection from `a` to `c` by its door
    await app.pick('a')
    const door = (await page.locator('[data-handle="connect"]').nth(2).boundingBox())!, to = await middle(page, 'c')
    await app.drag({ x: door.x + door.width / 2, y: door.y + door.height / 2 }, to, { steps: 10 })
    expect((await app.settled()).edges).toHaveLength(4)
    const after = await scene(page)
    expect(changed(before, after).filter((k) => k.startsWith('line:') && Object.hasOwn(before, k))).toEqual([])
  })
})

test.describe('connection ends', () => {
  /** points along a drawn path, on screen */
  const along = (page: Page, sel: string) => page.locator(sel).first().evaluate((node) => {
    const el = node as SVGPathElement, m = el.getScreenCTM()!, n = el.getTotalLength(), out: number[][] = []
    for (let i = 0; i <= 400; i++) { const p = el.getPointAtLength((n * i) / 400); out.push([p.x * m.a + p.y * m.c + m.e, p.x * m.b + p.y * m.d + m.f]) }
    return out
  })

  test('an end dragged onto another component is connected along the very path it was shown taking', async ({ page, app }) => {
    await open(page, app)
    const before = await scene(page)
    // the planned line from `a` to `d`: its far end is taken to `c`
    const p = await page.locator('.edge-hit[data-id="auto"]').evaluate((node) => { const el = node as SVGPathElement, m = el.getScreenCTM()!, q = el.getPointAtLength(el.getTotalLength() / 2); return { x: q.x * m.a + q.y * m.c + m.e, y: q.x * m.b + q.y * m.d + m.f } })
    await page.mouse.click(p.x, p.y)
    const end = (await page.locator('circle.link-end[data-handle="eb"]').boundingBox())!, to = await middle(page, 'c')
    await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2); await page.mouse.down()
    await page.mouse.move(to.x, to.y, { steps: 12 }); await page.waitForTimeout(80)
    const shown = await along(page, '.wire path')
    await page.mouse.up(); await page.waitForTimeout(400)
    expect((await app.settled()).edges.find((e) => e.id === 'auto')).toMatchObject({ from: 'a', to: 'c' })
    const drawn = await along(page, '.edge-hit[data-id="auto"]')
    // every point of the line as shown lies on the line as made (the shown one stops short at its arrowhead, so it is measured point to path)
    const off = Math.max(...shown.map((q) => Math.min(...drawn.map((r) => Math.hypot(q[0] - r[0], q[1] - r[1])))))
    expect(off, 'the line as connected, against the line as shown while the end was held').toBeLessThanOrEqual(1.5)
    // and the other lines were not touched by it
    const after = await scene(page)
    expect(after['line:hand']).toBe(before['line:hand'])
    expect(after['line:other']).toBe(before['line:other'])
  })
})

test.describe('snapping is a tool the user turns on', () => {
  test('off, nothing is on the grid unless it was put there; on, a component keeps to whole cells while it is carried, so release still changes nothing', async ({ page, app }) => {
    await open(page, app)
    await expect(page.getByRole('button', { name: /Snap to grid: off/ })).toBeVisible()
    await carry(page, await middle(page, 'a'), 37, 23); await release(page)
    const free = (await geometry(app)).nodes[0]
    expect(Number.isInteger(free[1]) && Number.isInteger(free[2])).toBe(false)
    await page.getByRole('button', { name: /Snap to grid: off/ }).click()
    const held = await carry(page, await middle(page, 'a'), 51, 40)
    expect(diff(held, await release(page))).toEqual([])
    const snapped = (await geometry(app)).nodes[0]
    expect(Number.isInteger(snapped[1]) && Number.isInteger(snapped[2])).toBe(true)
    // and it is remembered across a reload
    await page.reload(); await app.ready()
    await expect(page.getByRole('button', { name: /Snap to grid: on/ })).toBeVisible()
  })
})

/** the scene again, but only the lines and components that were in `like` (a reload does not restore what was selected) */
async function sceneOfLines(page: Page, like: Record<string, string>) {
  const now = await scene(page)
  return Object.fromEntries(Object.keys(like).map((k) => [k, now[k]]))
}
