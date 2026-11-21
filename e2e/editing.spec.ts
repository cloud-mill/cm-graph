import type { Page } from '@playwright/test'
import { type App, TRIO, expect, makeDoc, test } from './fixtures'

/**
 * Direct manipulation, with a real mouse in a real browser: what is in the hand
 * follows the pointer, connections are pulled from a component's doors and
 * catch what they are near, and nothing is written until it is let go.
 */
const centre = async (page: Page, sel: string) => { const b = (await page.locator(sel).boundingBox())!; return { x: b.x + b.width / 2, y: b.y + b.height / 2 } }
const door = async (page: Page, app: App, id: 'a' | 'b' | 'c', side: string) => {
  // doors show when the pointer is over the component: no click, no tool
  const at = { a: [1, 1], b: [7, 1], c: [1, 7] }[id]
  const p = await app.world(at[0], at[1])
  await page.mouse.move(p.x, p.y)
  await expect(page.locator(`.door[data-id="${id}"]`)).toHaveCount(4)
  return centre(page, `.door[data-id="${id}"][data-side="${side}"]`)
}
const quick = (page: Page) => page.getByRole('dialog', { name: 'Add and connect a component' })

test.describe('connecting', () => {
  test.beforeEach(async ({ app }) => { await app.open(TRIO()) })

  test('doors appear under the pointer, and one pull from a door to somewhere near another component connects them', async ({ page, app }) => {
    await expect(page.locator('.door')).toHaveCount(0)
    const from = await door(page, app, 'a', 'e')
    expect((await app.settled()).edges).toHaveLength(0)
    // let go most of a cell short of `b`: near is enough
    const near = await app.world(5.3, 1.2)
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move((from.x + near.x) / 2, (from.y + near.y) / 2, { steps: 6 })
    // out in the open it is a loose end following the pointer
    await expect(page.locator('.wire:not(.caught)')).toHaveCount(1)
    await page.mouse.move(near.x, near.y, { steps: 6 })
    // within reach it has caught `b`, and shows the line as it will be drawn
    await expect(page.locator('.wire.caught')).toHaveCount(1)
    await expect(page.locator('.wire-target')).toHaveCount(1)
    await page.mouse.up()
    const doc = await app.settled()
    expect(doc.edges).toHaveLength(1)
    expect(doc.edges[0]).toMatchObject({ from: 'a', to: 'b' })
    expect((doc.edges[0] as any).toSide).toBeUndefined()
    // the new line is what is selected, ready to be described
    await expect(page.locator('.handle.link-end')).toHaveCount(2)
    await expect(page.locator('.wire')).toHaveCount(0)
  })

  test('aiming at one door in particular makes the line arrive there', async ({ page, app }) => {
    const from = await door(page, app, 'a', 'e')
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    const body = await app.world(7, 1)
    await page.mouse.move(body.x, body.y, { steps: 8 })
    // the target's own doors are offered while the line is over it
    await expect(page.locator('.door[data-id="b"]')).toHaveCount(4)
    const north = await centre(page, '.door[data-id="b"][data-side="n"]')
    await page.mouse.move(north.x, north.y, { steps: 5 })
    await expect(page.locator('.door.aimed')).toHaveAttribute('data-side', 'n')
    await page.mouse.up()
    expect((await app.settled()).edges[0]).toMatchObject({ from: 'a', to: 'b', toSide: 'n' })
  })

  test('let go on open ground: pick what goes there and it arrives connected, as one step', async ({ page, app }) => {
    const from = await door(page, app, 'c', 's')
    const open = await app.world(5, 10)
    await app.drag(from, open)
    await expect(quick(page)).toBeVisible()
    // the loose end waits where it was let go
    await expect(page.locator('.wire')).toHaveCount(1)
    await expect(quick(page).getByRole('combobox')).toBeFocused()
    await page.keyboard.type('queue')
    await expect(quick(page).getByRole('option').first()).toContainText('Queue')
    await page.keyboard.press('Enter')
    await expect(quick(page)).toHaveCount(0)
    let doc = await app.settled()
    expect(doc.nodes).toHaveLength(4)
    const made = doc.nodes[3]
    expect(made).toMatchObject({ type: 'sqs', x: 4, y: 9 })
    expect(doc.edges).toHaveLength(1)
    expect(doc.edges[0]).toMatchObject({ from: 'c', to: made.id })
    // one undo takes both away
    await app.mod('z')
    doc = await app.settled()
    expect([doc.nodes.length, doc.edges.length]).toEqual([3, 0])
  })

  test('a second line between the same two is not made: the one that is there is shown instead', async ({ page, app }) => {
    await app.drag(await door(page, app, 'a', 'e'), await app.world(7, 1))
    await page.keyboard.press('Escape')
    const from = await door(page, app, 'b', 'w')
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    const back = await app.world(1, 1)
    await page.mouse.move(back.x, back.y, { steps: 8 })
    // said while it is still in the hand, not after
    await expect(page.locator('.wire-target.bad')).toHaveCount(1)
    await expect(page.locator('.wire.caught')).toHaveCount(0)
    await page.mouse.up()
    await expect(app.toast('already connected')).toBeVisible()
    expect((await app.settled()).edges).toHaveLength(1)
    await expect(page.locator('.handle.link-end')).toHaveCount(2)
  })

  test('Escape drops a line that is being pulled', async ({ page, app }) => {
    const from = await door(page, app, 'a', 'e')
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    const over = await app.world(7, 1)
    await page.mouse.move(over.x, over.y, { steps: 6 })
    await expect(page.locator('.wire')).toHaveCount(1)
    await page.keyboard.press('Escape')
    await expect(page.locator('.wire')).toHaveCount(0)
    await page.mouse.up()
    expect((await app.settled()).edges).toHaveLength(0)
  })
})

test.describe('carrying', () => {
  const linked = () => { const d = TRIO(); d.edges.push({ id: 'e', from: 'a', to: 'b', style: 'solid', arrow: 'end', width: 2 }); return d }
  const lineOf = (page: Page) => page.locator('.edge-hit[data-id="e"]').getAttribute('d')

  test('a component follows the pointer between cells, its line follows it, and nothing is written until it is let go', async ({ page, app }) => {
    await app.open(linked())
    const from = await app.world(1, 1), cell = await app.cells(1, 0)
    const home = await app.corner('a'), line = await lineOf(page)
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    // 1.4 cells along x: between the first cell and the second
    await page.mouse.move(from.x + cell.x * 1.4, from.y + cell.y * 1.4, { steps: 10 })
    const held = await app.corner('a')
    const along = ((held.x - home.x) * cell.x + (held.y - home.y) * cell.y) / (cell.x ** 2 + cell.y ** 2)
    expect(along).toBeGreaterThan(1.05)
    expect(along).toBeLessThan(1.45)
    // where it will come to rest is marked, and the line already runs to where it is
    await expect(page.locator('.landing')).toHaveCount(1)
    expect(await lineOf(page)).not.toBe(line)
    // the blueprint has not changed: nothing to save, nothing to undo
    await expect(page.locator('.save-state')).toHaveText('Saved')
    expect((await app.saved())!.nodes[0]).toMatchObject({ x: 0, y: 0 })
    await page.mouse.up()
    await expect(page.locator('.canvas-wrap.settle')).toHaveCount(0)
    expect((await app.settled()).nodes[0]).toMatchObject({ x: 1, y: 0 })
    const rest = await app.corner('a')
    expect(Math.hypot(rest.x - home.x - cell.x, rest.y - home.y - cell.y)).toBeLessThan(0.6)
    // and it was one step
    await app.mod('z')
    expect((await app.settled()).nodes[0]).toMatchObject({ x: 0, y: 0 })
  })

  test('Escape while carrying puts it back exactly, with nothing in the history', async ({ page, app }) => {
    await app.open(linked())
    const from = await app.world(1, 1), by = await app.cells(2.6, 1.7), home = await app.corner('a')
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(from.x + by.x, from.y + by.y, { steps: 8 })
    await expect(page.locator('.landing')).toHaveCount(1)
    await page.keyboard.press('Escape')
    await expect(page.locator('.landing')).toHaveCount(0)
    expect(await app.corner('a')).toEqual(home)
    await page.mouse.up()
    expect(await app.corner('a')).toEqual(home)
    await expect(page.getByRole('button', { name: 'Undo' })).toBeDisabled()
  })

  test('a component cannot be put down on top of another: it lands in the nearest free cell', async ({ app }) => {
    await app.open(TRIO())
    // straight onto `b`
    await app.drag(await app.world(1, 1), await app.world(7, 1))
    const doc = await app.settled()
    const [a, b] = doc.nodes
    expect(a.x + 2 <= b.x || b.x + 2 <= a.x || a.y + 2 <= b.y || b.y + 2 <= a.y).toBe(true)
    expect(Math.abs(a.x - b.x) + Math.abs(a.y - b.y)).toBeLessThanOrEqual(3)
  })

  test('shift keeps a move to one axis', async ({ page, app }) => {
    await app.open(TRIO())
    const from = await app.world(1, 1), by = await app.cells(4, 1.4)
    await page.keyboard.down('Shift')
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(from.x + by.x, from.y + by.y, { steps: 8 })
    await page.mouse.up()
    await page.keyboard.up('Shift')
    // shift-press took `a` out of the (empty) selection toggle and into it; the move went along x only
    expect((await app.settled()).nodes[0]).toMatchObject({ x: 4, y: 0 })
  })

  test('carried to the edge of the canvas, the view moves on so it can go further', async ({ page, app }) => {
    await app.open(TRIO())
    const from = await app.world(7, 1), still = await app.corner('c')
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    // the right-hand edge of the clear ground, just short of the inspector
    await page.mouse.move(1080, from.y, { steps: 10 })
    await expect.poll(async () => (await app.corner('c')).x, { timeout: 4000 }).toBeLessThan(still.x - 60)
    await page.mouse.up()
    // further along x than the canvas originally showed
    expect((await app.settled()).nodes[1].x).toBeGreaterThan(6)
  })

  test('equal gaps are marked while a component is carried into line with its neighbours', async ({ page, app }) => {
    // a row of two, four cells apart; a third is carried to the same distance beyond them
    await app.open(makeDoc([{ id: 'a', type: 'ec2', x: 0, y: 0 }, { id: 'b', type: 'rds', x: 6, y: 0 }, { id: 'c', type: 's3', x: 0, y: 6 }, { id: 'd', type: 'sqs', x: 13, y: 4 }]))
    const from = await app.world(14, 5), to = await app.world(13, 1)
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(to.x, to.y, { steps: 10 })
    await expect(page.locator('.guide')).not.toHaveCount(0)
    await expect(page.locator('.gap')).toHaveCount(2)
    await page.mouse.up()
    expect((await app.settled()).nodes[3]).toMatchObject({ x: 12, y: 0 })
  })
})

test.describe('placing and arranging', () => {
  test('a component dropped on a connection goes into the middle of it', async ({ page, app }) => {
    const d = TRIO(); d.edges.push({ id: 'e', from: 'a', to: 'b', style: 'solid', arrow: 'end', width: 2, label: 'orders' })
    await app.open(d)
    const tile = await app.tile('Function: Lambda'), on = await app.world(4, 1)
    await page.mouse.move(tile.x, tile.y)
    await page.mouse.down()
    await page.mouse.move(on.x, on.y, { steps: 12 })
    // the line it is over says so before anything is let go
    await expect(page.locator('.splice')).toHaveCount(1)
    await page.mouse.up()
    let doc = await app.settled()
    expect(doc.nodes).toHaveLength(4)
    const id = doc.nodes[3].id
    expect(doc.edges.map((e) => [e.from, e.to])).toEqual([['a', id], [id, 'b']])
    expect(doc.edges[0].label).toBe('orders')
    await app.mod('z')
    doc = await app.settled()
    expect(doc.nodes).toHaveLength(3)
    expect(doc.edges.map((e) => [e.from, e.to])).toEqual([['a', 'b']])
  })

  test('a box lights up what it has caught; the group lines up and spaces out evenly without touching', async ({ page, app }) => {
    await app.open(makeDoc([{ id: 'a', type: 'ec2', x: 0, y: 0 }, { id: 'b', type: 'rds', x: 6, y: 0 }, { id: 'c', type: 's3', x: 0, y: 6 }, { id: 'd', type: 'sqs', x: 3, y: 1 }]))
    const p = await app.world(-2, -2), q = await app.world(9.5, 4)
    await page.keyboard.down('Shift')
    await page.mouse.move(p.x, (p.y + q.y) / 2 - 200)
    await page.mouse.down()
    await page.mouse.move(q.x + 40, (p.y + q.y) / 2 + 120, { steps: 10 })
    await expect(page.locator('.picking')).toHaveCount(3)
    await page.mouse.up()
    await page.keyboard.up('Shift')
    await expect(page.locator('.sel-mark')).toHaveCount(3)
    await app.selBar().getByRole('button', { name: 'Line up' }).click()
    let n = (await app.settled()).nodes
    expect([n[0].y, n[1].y, n[3].y]).toEqual([0, 0, 0])
    await app.selBar().getByRole('button', { name: 'Space evenly' }).click()
    n = (await app.settled()).nodes
    expect([n[0].x, n[3].x, n[1].x]).toEqual([0, 3, 6])
    // each is one undo step
    await app.mod('z'); await app.mod('z')
    expect((await app.settled()).nodes[3]).toMatchObject({ x: 3, y: 1 })
  })
})
