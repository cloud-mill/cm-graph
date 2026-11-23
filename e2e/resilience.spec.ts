/**
 * Keeping work safe when things go wrong: autosave across reloads and navigation, unknown addresses, storage that
 * is corrupted, damaged or full, a second tab, hurried input, and the crash screen. A failure means work can be
 * lost, or one bad blueprint can take the whole app down.
 */
import { TRIO, expect, makeDoc, test } from './fixtures'

test.describe('persistence and failure handling', () => {
  test('saves automatically and survives an immediate reload', async ({ page, app }) => {
    await app.open(TRIO())
    await app.pick('a')
    await page.keyboard.press('ArrowRight')
    await expect(page.locator('.save-state')).toHaveText('Saving')
    await page.reload() // before the autosave timer fires
    await app.ready()
    expect((await app.saved())!.nodes[0]).toMatchObject({ x: 1, y: 0 })
    await expect(page.locator('.save-state')).toHaveText('Saved')
  })

  test('leaving for the dashboard straight after an edit keeps the edit', async ({ page, app }) => {
    await app.open(TRIO())
    await page.getByLabel('Blueprint name').fill('Renamed in a hurry')
    await page.getByRole('button', { name: 'All blueprints' }).click()
    await expect(page.getByRole('button', { name: 'Open Renamed in a hurry' })).toBeVisible()
  })

  test('browser back and forward move between dashboard and editor', async ({ page, app }) => {
    await app.seed(TRIO())
    await page.reload()
    await page.getByRole('button', { name: 'Open E2E blueprint' }).click()
    await app.ready()
    await page.goBack()
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    await page.goForward()
    await app.ready()
    await expect(app.nodes()).toHaveCount(3)
  })

  test('undo history does not leak from one blueprint into the next', async ({ page, app }) => {
    await app.seed(TRIO(), makeDoc([{ id: 'z', type: 'lambda', x: 0, y: 0 }], { id: 'other', name: 'Other' }))
    await page.goto('/#/d/e2edoc')
    await app.ready()
    await app.pick('a')
    await page.keyboard.press('Delete')
    await expect(app.nodes()).toHaveCount(2)
    await app.settled()
    await page.goto('/#/d/other')
    await app.ready()
    await expect(app.nodes()).toHaveCount(1)
    await expect(page.getByRole('button', { name: 'Undo' })).toBeDisabled()
    await app.mod('z')
    await expect(app.nodes()).toHaveCount(1)
    expect((await app.saved('other'))!.nodes).toHaveLength(1)
    expect((await app.saved('e2edoc'))!.nodes).toHaveLength(2)
  })

  test('an unknown blueprint address returns to the dashboard', async ({ page }) => {
    await page.goto('/#/d/does-not-exist')
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Infrastructure')
    await expect(page).toHaveURL(/#\/$/)
  })

  test('an unknown address of any other shape shows the dashboard', async ({ page }) => {
    await page.goto('/#/totally/unknown')
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  })

  test('corrupted storage does not take the app down', async ({ page, app }) => {
    await app.seed(TRIO())
    await page.evaluate(() => {
      localStorage.setItem('stratum:doc:broken', '{"id":"broken","name":')
      const idx = JSON.parse(localStorage.getItem('stratum:index')!)
      idx.push({ id: 'broken', name: 'Broken', updatedAt: Date.now(), nodes: 1 }, { id: 'gone', name: 'Gone', updatedAt: Date.now(), nodes: 2 })
      localStorage.setItem('stratum:index', JSON.stringify(idx))
      localStorage.setItem('stratum:pref:theme', '{{{')
    })
    await page.reload()
    await expect(page.locator('.card.doc')).toHaveCount(1) // the readable one
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await page.goto('/#/d/broken')
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()

    await page.evaluate(() => localStorage.setItem('stratum:index', 'not json'))
    await page.reload()
    await expect(page.getByText('Nothing drafted yet')).toBeVisible()
    await page.getByRole('button', { name: 'New blueprint' }).click()
    await app.ready()
  })

  test('a stored blueprint with a damaged structure opens safely', async ({ page, app }) => {
    await app.seed({ id: 'odd', name: 'Odd', region: 'nowhere-9', nodes: [{ id: 'a', type: 'mystery-box', x: 0, y: 0, props: {} }, { id: 'b', type: 'ec2' } as any],
      edges: [{ id: 'e', from: 'a', to: 'missing', style: 'solid', arrow: 'end', width: 2 }], areas: undefined as any, labels: undefined as any, createdAt: 0, updatedAt: 0 })
    await page.goto('/#/d/odd')
    await app.ready()
    await expect(app.nodes()).toHaveCount(2)
    await expect(app.edges()).toHaveCount(0)
    expect(await page.locator('.panel.right').innerText()).not.toMatch(/NaN|undefined/)
    await app.tab('Budget').click()
    await app.tab('Advisor').click()
    await page.keyboard.press('Control+e')
    await expect(page.getByRole('dialog', { name: 'Export' })).toBeVisible()
  })

  test('when browser storage is full the app says so and keeps working', async ({ page, app }) => {
    await app.open(TRIO())
    await page.evaluate(() => { Storage.prototype.setItem = () => { throw new DOMException('full', 'QuotaExceededError') } })
    await app.pick('a')
    await page.keyboard.press('ArrowRight')
    await expect(page.locator('.save-state')).toHaveText('Not saved')
    await expect(app.toast(/storage is full/i)).toBeVisible()
    // still editable, and the warning is not repeated for every edit
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    await page.waitForTimeout(700)
    await expect(app.toast(/storage is full/i)).toHaveCount(1)
    await expect(app.selBar()).toBeVisible()
  })

  test('two tabs: a blueprint made in one appears in the other after a refresh', async ({ page, app, context }) => {
    await page.goto('/')
    const other = await context.newPage()
    await other.goto('/')
    await other.getByRole('button', { name: 'New blueprint' }).click()
    await expect(other.locator('.canvas-svg')).toBeVisible()
    await page.reload()
    await expect(page.locator('.card.doc')).toHaveCount(1)
    await other.close()
    void app
  })

  test('rapid mixed input leaves a consistent blueprint', async ({ page, app }) => {
    await app.open(TRIO())
    await app.pick('a')
    for (let i = 0; i < 12; i++) { await app.mod('d'); await page.keyboard.press('ArrowRight') }
    for (let i = 0; i < 30; i++) await app.mod('z')
    for (let i = 0; i < 7; i++) await app.mod('Shift+z')
    await app.mod('a')
    await page.keyboard.press('Delete')
    await app.mod('z')
    const doc = await app.settled()
    const ids = doc.nodes.map((n) => n.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const e of doc.edges) expect(ids.includes(e.from) && ids.includes(e.to)).toBe(true)
    await expect(app.nodes()).toHaveCount(doc.nodes.length)
    expect(doc.nodes.length).toBeGreaterThanOrEqual(3)
  })

  test('a pointer released outside the window does not leave a drag stuck', async ({ page, app }) => {
    await app.open(TRIO())
    const from = await app.world(1, 1)
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(from.x + 80, from.y + 40, { steps: 5 })
    await page.mouse.move(-50, -50, { steps: 3 })
    await page.mouse.up()
    // the next plain move must not keep dragging
    const here = await app.corner('a')
    await page.mouse.move(700, 500, { steps: 4 })
    const there = await app.corner('a')
    expect(there).toEqual(here)
  })
})

test.describe('crash screen', () => {
  test('a drawing error shows a way out instead of a blank page', async ({ page, app, problems }) => {
    // make the canvas fail on demand, the way an unexpected browser error would
    await page.addInitScript(() => {
      const Real = window.ResizeObserver
      window.ResizeObserver = class extends Real {
        constructor(cb: ResizeObserverCallback) { if (sessionStorage.getItem('boom')) throw new Error('simulated drawing failure'); super(cb) }
      }
    })
    await app.seed(TRIO())
    await page.evaluate(() => sessionStorage.setItem('boom', '1'))
    await page.goto('/#/d/e2edoc')
    await expect(page.getByText('Something broke while drawing this screen.')).toBeVisible()
    await expect(page.getByText('Your blueprints are saved in this browser and are not affected.')).toBeVisible()
    await expect(page.locator('.crash code')).toHaveText('simulated drawing failure')
    // the blueprint itself is untouched
    expect((await app.saved('e2edoc'))!.nodes).toHaveLength(3)

    await page.getByRole('button', { name: 'Back to all blueprints' }).click()
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Infrastructure')
    await expect(page.locator('.card.doc')).toHaveCount(1)

    await page.goto('/#/d/e2edoc')
    await expect(page.getByText('Something broke while drawing this screen.')).toBeVisible()
    await page.evaluate(() => sessionStorage.removeItem('boom'))
    await page.getByRole('button', { name: 'Reload' }).click()
    await app.ready()
    await expect(app.nodes()).toHaveCount(3)
    problems.length = 0 // the simulated failure is expected to be logged
  })
})
