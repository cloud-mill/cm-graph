import { TRIO, expect, test } from './fixtures'

test.describe('canvas editing', () => {
  test.beforeEach(async ({ app }) => { await app.open(TRIO()) })

  test('selects with a click, adds with shift, clears on empty ground and with Escape', async ({ page, app }) => {
    await app.pick('a')
    await expect(app.selBar()).toContainText('web-1')
    await expect(page.locator('.title-input')).toHaveValue('web-1')
    await app.pick('b', { shift: true })
    await expect(app.selBar()).toContainText('2 selected')
    await app.pick('b', { shift: true })
    await expect(app.selBar()).toContainText('web-1')
    await app.click(await app.world(4, 4))
    await expect(app.selBar()).toHaveCount(0)
    await app.pick('c')
    await page.keyboard.press('Escape')
    await expect(app.selBar()).toHaveCount(0)
  })

  test('drags a component by whole cells, saves it, and undoes it in one step', async ({ app }) => {
    const from = await app.world(1, 1), d = await app.cells(2, 1)
    await app.drag(from, { x: from.x + d.x, y: from.y + d.y })
    let doc = await app.settled()
    expect(doc.nodes.find((n) => n.id === 'a')).toMatchObject({ x: 2, y: 1 })
    expect(doc.nodes.find((n) => n.id === 'b')).toMatchObject({ x: 6, y: 0 })
    await app.mod('z')
    doc = await app.settled()
    expect(doc.nodes.find((n) => n.id === 'a')).toMatchObject({ x: 0, y: 0 })
    await app.mod('Shift+z')
    doc = await app.settled()
    expect(doc.nodes.find((n) => n.id === 'a')).toMatchObject({ x: 2, y: 1 })
  })

  test('moves a multi-selection together', async ({ app }) => {
    await app.pick('a')
    await app.pick('b', { shift: true })
    const from = await app.world(1, 1), d = await app.cells(0, -3)
    await app.drag(from, { x: from.x + d.x, y: from.y + d.y })
    const doc = await app.settled()
    expect(doc.nodes.map((n) => [n.id, n.x, n.y])).toEqual([['a', 0, -3], ['b', 6, -3], ['c', 0, 6]])
  })

  test('alt-drag leaves the original in place and moves a renumbered copy', async ({ page, app }) => {
    const from = await app.world(1, 1), d = await app.cells(3, 3)
    await page.keyboard.down('Alt')
    await app.drag(from, { x: from.x + d.x, y: from.y + d.y })
    await page.keyboard.up('Alt')
    const doc = await app.settled()
    expect(doc.nodes).toHaveLength(4)
    expect(doc.nodes.find((n) => n.id === 'a')).toMatchObject({ x: 0, y: 0, name: 'web-1' })
    expect(doc.nodes[3]).toMatchObject({ x: 3, y: 3, name: 'web-2', type: 'ec2' })
  })

  test('nudges with the arrow keys, four cells with shift', async ({ page, app }) => {
    await app.pick('c')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('Shift+ArrowDown')
    const doc = await app.settled()
    expect(doc.nodes.find((n) => n.id === 'c')).toMatchObject({ x: 1, y: 10 })
  })

  test('deletes with the keyboard and removes attached connections', async ({ page, app }) => {
    await app.pick('a')
    const handle = await page.locator('.connect-handle').boundingBox()
    await app.drag({ x: handle!.x + handle!.width / 2, y: handle!.y + handle!.height / 2 }, await app.world(7, 1))
    await expect(app.edges()).toHaveCount(1)
    await app.pick('a')
    await page.keyboard.press('Delete')
    await expect(app.nodes()).toHaveCount(2)
    await expect(app.edges()).toHaveCount(0)
    expect(await app.hud('N')).toBe('02')
    const doc = await app.settled()
    expect(doc.edges).toEqual([])
  })

  test('connects from the handle, selects the new connection, and refuses a duplicate', async ({ page, app }) => {
    await app.pick('a')
    const h = await page.locator('.connect-handle').boundingBox()
    const start = { x: h!.x + h!.width / 2, y: h!.y + h!.height / 2 }
    await app.drag(start, await app.world(7, 1))
    await expect(app.edges()).toHaveCount(1)
    await expect(page.locator('.title-static')).toHaveText('Connection')
    await expect(page.locator('.insp-sub')).toHaveText('web-1 → orders-db')
    // the reverse direction counts as the same connection
    await app.pick('b')
    const h2 = await page.locator('.connect-handle').boundingBox()
    await app.drag({ x: h2!.x + h2!.width / 2, y: h2!.y + h2!.height / 2 }, await app.world(1, 1))
    await expect(app.toast('already connected')).toBeVisible()
    await expect(app.edges()).toHaveCount(1)
    const doc = await app.settled()
    expect(doc.edges).toMatchObject([{ from: 'a', to: 'b', style: 'solid', arrow: 'end' }])
  })

  test('connects with the connect tool and returns to select with Escape', async ({ page, app }) => {
    await page.keyboard.press('c')
    await expect(app.tool('Connect')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('.hint-pill')).toHaveText('Drag from one component to another')
    await app.drag(await app.world(1, 1), await app.world(1, 7))
    await expect(app.edges()).toHaveCount(1)
    // dropping on empty ground makes nothing
    await app.drag(await app.world(7, 1), await app.world(4, 4))
    await expect(app.edges()).toHaveCount(1)
    await page.keyboard.press('Escape')
    await expect(app.tool('Select')).toHaveAttribute('aria-pressed', 'true')
  })

  test('draws an area on the grid, then resizes it from a corner', async ({ page, app }) => {
    await app.tool('Area').click()
    await app.drag(await app.world(-1, -1), await app.world(3, 4))
    let doc = await app.settled()
    expect(doc.areas).toMatchObject([{ x: -1, y: -1, w: 4, d: 5, name: 'VPC', kind: 'vpc' }])
    await expect(app.tool('Select')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('.title-input')).toHaveValue('VPC')

    const h = await page.locator('[data-handle="r2"]').boundingBox()
    const from = { x: h!.x + h!.width / 2, y: h!.y + h!.height / 2 }, d = await app.cells(2, 1)
    await app.drag(from, { x: from.x + d.x, y: from.y + d.y })
    doc = await app.settled()
    expect(doc.areas[0]).toMatchObject({ x: -1, y: -1, w: 6, d: 6 })
    // dragging a corner past the opposite one stops at one cell
    const h0 = await page.locator('[data-handle="r0"]').boundingBox()
    const f0 = { x: h0!.x + h0!.width / 2, y: h0!.y + h0!.height / 2 }, far = await app.cells(20, 20)
    await app.drag(f0, { x: f0.x + far.x, y: f0.y + far.y })
    doc = await app.settled()
    expect(doc.areas[0]).toMatchObject({ x: 4, y: 4, w: 1, d: 1 })
  })

  test('a second area is a subnet, and a too-small drag makes nothing', async ({ page, app }) => {
    await page.keyboard.press('a')
    await app.drag(await app.world(-2, -2), await app.world(9, 9))
    await page.keyboard.press('a')
    await app.drag(await app.world(-1, -1), await app.world(3, 3))
    await page.keyboard.press('a')
    const p = await app.world(4, 4)
    await app.drag(p, { x: p.x + 3, y: p.y + 2 })
    const doc = await app.settled()
    expect(doc.areas.map((a) => [a.kind, a.name])).toEqual([['vpc', 'VPC'], ['subnet', 'Subnet 1']])
  })

  test('moving an area carries what is inside it', async ({ page, app }) => {
    await page.keyboard.press('a')
    await app.drag(await app.world(-1, -1), await app.world(3, 3))
    // grab the area by its border
    const edge = await app.world(-1, 1), d = await app.cells(0, -4)
    await app.drag(edge, { x: edge.x + d.x, y: edge.y + d.y })
    const doc = await app.settled()
    expect(doc.areas[0]).toMatchObject({ x: -1, y: -5 })
    expect(doc.nodes.find((n) => n.id === 'a')).toMatchObject({ x: 0, y: -4 })
    expect(doc.nodes.find((n) => n.id === 'b')).toMatchObject({ x: 6, y: 0 })
  })

  test('drops a label with the text tool and types into it straight away', async ({ page, app }) => {
    await page.keyboard.press('t')
    await expect(page.locator('.hint-pill')).toHaveText('Click to drop a label')
    await app.click(await app.world(4, 4))
    await page.keyboard.type('Edge tier')
    await expect(page.locator('.right textarea')).toHaveValue('Edge tier')
    await expect(page.locator('.canvas-svg [data-kind="label"]')).toHaveText('Edge tier')
    const doc = await app.settled()
    expect(doc.labels).toMatchObject([{ x: 4, y: 4, text: 'Edge tier', size: 20, dir: 'x' }])
    // typing a tool letter in the field did not switch tools
    await expect(app.tool('Select')).toHaveAttribute('aria-pressed', 'true')
  })

  test('resizes a component from a corner, clamped between 50% and 300%', async ({ page, app }) => {
    await app.pick('a')
    const grab = async (corner: number, dx: number, dy: number) => {
      const h = await page.locator(`[data-handle="n${corner}"]`).boundingBox()
      const from = { x: h!.x + h!.width / 2, y: h!.y + h!.height / 2 }, d = await app.cells(dx, dy)
      await app.drag(from, { x: from.x + d.x, y: from.y + d.y })
    }
    await grab(2, 2, 2)
    let doc = await app.settled()
    expect(doc.nodes.find((n) => n.id === 'a')).toMatchObject({ x: 0, y: 0, scale: 2 })
    await expect(page.getByRole('combobox', { name: 'Scale' })).toHaveText('200%')
    await grab(2, 30, 30)
    doc = await app.settled()
    expect(doc.nodes.find((n) => n.id === 'a')!.scale).toBe(3)
    await grab(2, -30, -30)
    doc = await app.settled()
    expect(doc.nodes.find((n) => n.id === 'a')).toMatchObject({ x: 0, y: 0, scale: 0.5 })
    // the near corner resizes towards the far one, which stays pinned
    await grab(0, -1, -1)
    doc = await app.settled()
    const a = doc.nodes.find((n) => n.id === 'a')!
    expect([a.x, a.y, a.scale]).toEqual([-1, -1, 1])
  })

  test('resize handles show an arrow that matches the way the corner moves', async ({ page, app }) => {
    await app.pick('a')
    const cursors = await page.locator('[data-handle^="n"]').evaluateAll((els) => els.map((e) => getComputedStyle(e).cursor))
    // home view: the footprint is a diamond, so corners sit top, right, bottom and left
    expect(cursors).toEqual(['ns-resize', 'ew-resize', 'ns-resize', 'ew-resize'])
    await page.keyboard.press('2')
    await expect.poll(() => app.hud('EL')).toBe('90°')
    const flat = await page.locator('[data-handle^="n"]').evaluateAll((els) => els.map((e) => getComputedStyle(e).cursor))
    expect(flat).toEqual(['nwse-resize', 'nesw-resize', 'nwse-resize', 'nesw-resize'])
  })

  test('duplicates, copies and pastes with renumbered names', async ({ page, app }) => {
    await app.pick('a')
    await app.mod('d')
    await expect(app.nodes()).toHaveCount(4)
    await app.mod('c')
    await expect(app.toast('Copied 1 item(s)')).toBeVisible()
    await app.mod('v')
    await app.mod('v')
    const doc = await app.settled()
    expect(doc.nodes.map((n) => n.name)).toEqual(['web-1', 'orders-db', 'assets', 'web-2', 'web-3', 'web-4'])
    // each paste lands clear of the last
    const spots = doc.nodes.slice(3).map((n) => n.x + ',' + n.y)
    expect(new Set(spots).size).toBe(3)
    await expect(page.locator('.title-input')).toHaveValue('web-4')
  })

  test('cut removes the selection and paste brings it back', async ({ app }) => {
    await app.pick('c')
    await app.mod('x')
    await expect(app.nodes()).toHaveCount(2)
    await app.mod('v')
    await expect(app.nodes()).toHaveCount(3)
  })

  test('selects everything, and a shift-drag selects a region', async ({ page, app }) => {
    await app.mod('a')
    await expect(app.selBar()).toContainText('3 selected')
    await page.keyboard.press('Escape')
    // a box around the two components on the x axis only
    const a = await app.world(1, 1), b = await app.world(7, 1)
    await page.keyboard.down('Shift')
    await app.drag({ x: Math.min(a.x, b.x) - 60, y: Math.min(a.y, b.y) - 150 }, { x: Math.max(a.x, b.x) + 90, y: Math.max(a.y, b.y) + 40 })
    await page.keyboard.up('Shift')
    await expect(app.selBar()).toContainText('2 selected')
  })

  test('wraps a selection in a group from the selection bar', async ({ app }) => {
    await app.mod('a')
    await app.selBar().getByRole('button', { name: 'Group' }).click()
    const doc = await app.settled()
    expect(doc.areas).toMatchObject([{ kind: 'group', name: 'Group', x: -1, y: -1.5, w: 10, d: 10.5 }])
  })

  test('context menu acts on what was right-clicked', async ({ page, app }) => {
    await app.pick('b', { button: 'right' })
    const menu = page.locator('.ctx-menu')
    await expect(menu.getByRole('button')).toHaveText([/Duplicate/, /Copy/, /Wrap in group/, /Zoom to selection/, /Edit properties/, /Delete/])
    await menu.getByRole('button', { name: /Duplicate/ }).click()
    await expect(menu).toHaveCount(0)
    await expect(app.nodes()).toHaveCount(4)

    await app.click(await app.world(4, 4), { button: 'right' })
    await expect(menu.getByRole('button')).toHaveText([/Paste/, /Add label here/, /Select all/, /Zoom to fit/, /Tidy layout/])
    await menu.getByRole('button', { name: /Add label here/ }).click()
    await expect(page.locator('.canvas-svg [data-kind="label"]')).toHaveCount(1)

    await app.click(await app.world(4, -3), { button: 'right' })
    await expect(menu).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
  })

  test('double-click and Enter both jump to renaming', async ({ page, app }) => {
    const p = await app.world(7, 1)
    await page.mouse.dblclick(p.x, p.y)
    await expect(page.locator('.title-input')).toBeFocused()
    await page.keyboard.type('billing-db')
    await page.keyboard.press('Enter')
    await expect(page.locator('.title-input')).not.toBeFocused()
    await app.pick('c')
    await page.keyboard.press('Enter')
    await page.keyboard.type('cdn-origin')
    await expect(page.locator('.title-input')).toHaveValue('cdn-origin')
    const doc = await app.settled()
    expect(doc.nodes.map((n) => n.name)).toEqual(['web-1', 'billing-db', 'cdn-origin'])
  })

  test('pans by dragging the ground or holding space, without changing the blueprint', async ({ page, app }) => {
    const before = await app.corner('a')
    const g = await app.world(4, 4)
    await app.drag(g, { x: g.x + 120, y: g.y - 60 })
    let after = await app.corner('a')
    expect(after.x - before.x).toBeCloseTo(120, 0)
    expect(after.y - before.y).toBeCloseTo(-60, 0)
    // space turns a drag on a component into a pan
    await page.keyboard.down('Space')
    const on = await app.world(1, 1)
    await app.drag(on, { x: on.x - 50, y: on.y })
    await page.keyboard.up('Space')
    after = await app.corner('a')
    expect(after.x - before.x).toBeCloseTo(70, 0)
    const doc = await app.saved()
    expect(doc!.nodes.find((n) => n.id === 'a')).toMatchObject({ x: 0, y: 0 })
    await expect(page.locator('.save-state')).toHaveText('Saved')
  })

  test('tidy layout rearranges everything and one undo puts it back', async ({ page, app }) => {
    await app.pick('a')
    const h = await page.locator('.connect-handle').boundingBox()
    await app.drag({ x: h!.x + h!.width / 2, y: h!.y + h!.height / 2 }, await app.world(7, 1))
    await app.tool('Tidy layout').click()
    await expect(app.toast('Layout tidied')).toBeVisible()
    let doc = await app.settled()
    const spots = doc.nodes.map((n) => n.x + ',' + n.y)
    expect(new Set(spots).size).toBe(3)
    expect(spots).not.toEqual(['0,0', '6,0', '0,6'])
    await app.mod('z')
    doc = await app.settled()
    expect(doc.nodes.map((n) => n.x + ',' + n.y)).toEqual(['0,0', '6,0', '0,6'])
  })
})

test.describe('library', () => {
  test('adds a component by double-click and by dragging it onto the canvas', async ({ page, app }) => {
    await app.open(TRIO())
    await page.locator('.pal-item[title="Virtual machine: EC2"]').dblclick()
    await expect(app.nodes()).toHaveCount(4)
    await expect(page.locator('.title-input')).toHaveValue('ec2-1')

    const tile = await app.tile('Function: Lambda')
    const drop = await app.world(4, 4)
    await page.mouse.move(tile.x, tile.y)
    await page.mouse.down()
    await page.mouse.move(drop.x, drop.y, { steps: 8 })
    await expect(page.locator('.canvas-svg .ghost')).toBeVisible()
    await expect(page.locator('.hint-pill')).toContainText('Release on the canvas to place')
    await page.mouse.up()
    await expect(app.nodes()).toHaveCount(5)
    const doc = await app.settled()
    expect(doc.nodes[4]).toMatchObject({ type: 'lambda', x: 3, y: 3, name: 'lambda-1' })
    await expect(page.locator('.canvas-svg .ghost')).toHaveCount(0)
  })

  test('holding shift keeps placing, Escape stops, and releasing over a panel places nothing', async ({ page, app }) => {
    await app.open(TRIO())
    const tile = await app.tile('Queue: SQS')
    await page.mouse.move(tile.x, tile.y)
    await page.mouse.down()
    await page.mouse.up() // released over the library: nothing placed, still armed
    await expect(app.nodes()).toHaveCount(3)
    await page.keyboard.down('Shift')
    for (const [x, y] of [[4, 4], [4, -3]]) { const p = await app.world(x, y); await page.mouse.move(p.x, p.y, { steps: 4 }); await page.mouse.down(); await page.mouse.up() }
    await page.keyboard.up('Shift')
    await expect(app.nodes()).toHaveCount(5)
    await page.keyboard.press('Escape')
    const p = await app.world(-3, 4)
    await page.mouse.move(p.x, p.y); await page.mouse.down(); await page.mouse.up()
    await expect(app.nodes()).toHaveCount(5)
  })

  test('switches cloud, remembers it, searches across clouds and filters by category', async ({ page, app }) => {
    await app.newBlueprint()
    const count = page.locator('.palette .panel-head .label.dim')
    await expect(count).toHaveText('65 / 169')
    await page.getByRole('radio', { name: 'GCP' }).click()
    await expect(count).toHaveText('59 / 169')
    await expect(page.locator('.pal-item[title="Virtual machine: Compute Engine"]')).toBeVisible()
    await page.reload()
    await expect(page.getByRole('radio', { name: 'GCP' })).toHaveAttribute('aria-checked', 'true')

    await page.keyboard.press('/')
    await expect(page.getByPlaceholder('Search components')).toBeFocused()
    await page.keyboard.type('kubernetes')
    await expect(page.locator('.pal-item')).toHaveCount(3)
    await expect(page.locator('.pal-item .pal-aws').first()).toContainText('GCP')
    await page.keyboard.type('zzzz')
    await expect(page.getByText('Nothing matches')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByPlaceholder('Search components')).toHaveValue('')

    await page.getByRole('combobox', { name: 'Category' }).click()
    await page.getByRole('option', { name: 'Database' }).click()
    await expect(page.locator('.palette-scroll section')).toHaveCount(1)
    await expect(page.locator('.palette-scroll h4')).toContainText('Database')
  })

  test('summons components from the command palette onto an empty plane', async ({ page, app }) => {
    await app.newBlueprint()
    await app.mod('k')
    await page.keyboard.type('dynamodb')
    await page.keyboard.press('Enter')
    await expect(app.nodes()).toHaveCount(1)
    await expect(page.getByText('An empty plane.')).toHaveCount(0)
    await app.mod('k')
    await page.keyboard.type('lambda')
    await page.keyboard.press('Enter')
    const doc = await app.settled()
    expect(doc.nodes).toHaveLength(2)
    // the second one does not land on top of the first
    expect(Math.abs(doc.nodes[0].x - doc.nodes[1].x) >= 2 || Math.abs(doc.nodes[0].y - doc.nodes[1].y) >= 2).toBe(true)
  })
})
