import { TRIO, expect, makeDoc, test } from './fixtures'

/** A grid of connected components, big enough to show up any per-frame waste. */
function bigDoc(n: number) {
  const side = Math.ceil(Math.sqrt(n))
  const types = ['ec2', 'rds', 's3', 'lambda', 'sqs', 'alb', 'dynamodb', 'elasticache']
  const nodes = Array.from({ length: n }, (_, i) => ({ id: 'n' + i, type: types[i % types.length], x: (i % side) * 4, y: Math.floor(i / side) * 4, name: 'c-' + i }))
  const doc = makeDoc(nodes, { id: 'big', name: 'Big' })
  for (let i = 0; i < n - 1; i++) if ((i + 1) % side) doc.edges.push({ id: 'e' + i, from: 'n' + i, to: 'n' + (i + 1), style: 'solid', arrow: 'end', width: 2 })
  for (let i = 0; i + side < n; i += 3) doc.edges.push({ id: 'v' + i, from: 'n' + i, to: 'n' + (i + side), style: 'dashed', arrow: 'end', width: 2 })
  return doc
}

test.describe('performance and stability', () => {
  test.describe.configure({ mode: 'serial' })

  test('a 300-component blueprint opens promptly and stays interactive', async ({ page, app }) => {
    test.slow()
    const doc = bigDoc(300)
    await app.seed(doc)
    const t0 = Date.now()
    await page.goto('/#/d/big')
    await expect(page.locator('.canvas-svg [data-kind="node"]')).toHaveCount(300)
    expect(Date.now() - t0, 'time to first full render').toBeLessThan(6000)
    await app.ready()

    // pan one step per frame and time the frames: this is the real cost of redrawing the scene
    const frame = await page.evaluate(() => new Promise<{ avg: number; worst: number }>((done) => {
      const el = document.querySelector('.canvas-svg')!
      const times: number[] = []
      let last = performance.now(), i = 0
      const tick = () => {
        const now = performance.now(); times.push(now - last); last = now
        if (++i > 60) { times.shift(); times.sort((x, y) => x - y); return done({ avg: times.reduce((x, y) => x + y, 0) / times.length, worst: times[Math.floor(times.length * 0.95)] }) }
        el.dispatchEvent(new WheelEvent('wheel', { deltaX: i % 2 ? 7 : -7, deltaY: 0.5, bubbles: true, cancelable: true }))
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    }))
    test.info().annotations.push({ type: 'frame time, 300 components', description: `${frame.avg.toFixed(1)} ms average, ${frame.worst.toFixed(0)} ms at the 95th percentile` })
    // headless Chrome draws without a GPU, so this is a floor for regressions rather than a claim about real hardware
    expect(frame.avg, 'average frame time while panning (ms)').toBeLessThan(90)

    // a real drag across the canvas pans it
    const box = (await page.locator('.canvas-svg').boundingBox())!
    const before = await page.locator('[data-kind="node"][data-id="n0"]').evaluate((el) => (el as unknown as SVGGElement).getScreenCTM()!.e)
    await page.keyboard.down('Space')
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2 + 60, { steps: 8 })
    await page.mouse.up()
    await page.keyboard.up('Space')
    const after = await page.locator('[data-kind="node"][data-id="n0"]').evaluate((el) => (el as unknown as SVGGElement).getScreenCTM()!.e)
    expect(after - before).toBeCloseTo(120, 0)

    // editing still works at this size
    await page.keyboard.press('Control+a')
    await expect(page.locator('.sel-bar')).toContainText('300 selected')
    await page.keyboard.press('ArrowRight')
    const saved = await app.settled()
    expect(saved.nodes[0].x).toBe(1)
    await app.tool('Tidy layout').click()
    await expect(app.toast('Layout tidied')).toBeVisible()
  })

  test('dragging one component does not redraw the others', async ({ page, app }) => {
    await app.open(TRIO())
    await page.evaluate(() => {
      const w = window as any
      w.__touched = 0
      const obs = new MutationObserver((list) => { w.__touched += list.length })
      for (const id of ['b', 'c']) obs.observe(document.querySelector(`[data-kind="node"][data-id="${id}"]`)!, { attributes: true, childList: true, subtree: true, characterData: true })
    })
    const from = await app.world(1, 1), d = await app.cells(3, 2)
    await app.drag(from, { x: from.x + d.x, y: from.y + d.y }, { steps: 12 })
    expect((await app.settled()).nodes[0]).toMatchObject({ x: 3, y: 2 })
    expect(await page.evaluate(() => (window as any).__touched), 'DOM changes on components that did not move').toBe(0)
  })

  test('panning and zooming do not touch the component drawings at all', async ({ page, app }) => {
    await app.open(TRIO())
    await page.evaluate(() => {
      const w = window as any
      w.__touched = 0
      const obs = new MutationObserver((list) => { w.__touched += list.length })
      for (const el of document.querySelectorAll('.canvas-svg [data-kind="node"]')) obs.observe(el, { attributes: true, childList: true, subtree: true })
    })
    const g = await app.world(4, 4)
    await app.drag(g, { x: g.x + 150, y: g.y + 60 }, { steps: 10 })
    await page.mouse.wheel(0, -240)
    await page.waitForTimeout(500)
    expect(await page.evaluate(() => (window as any).__touched)).toBe(0)
  })

  test('opening and closing blueprints and dialogs does not leak listeners or DOM', async ({ page, app }) => {
    test.setTimeout(180_000)
    await app.seed(TRIO())
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Performance.enable')
    const measure = async () => {
      await cdp.send('HeapProfiler.collectGarbage')
      await page.waitForTimeout(150)
      await cdp.send('HeapProfiler.collectGarbage')
      const { metrics } = await cdp.send('Performance.getMetrics')
      const m = Object.fromEntries(metrics.map((x) => [x.name, x.value]))
      return { listeners: m.JSEventListeners, nodes: m.Nodes, heap: m.JSHeapUsedSize }
    }
    const cycle = async () => {
      await page.goto('/#/d/e2edoc')
      await expect(page.locator('.canvas-svg [data-kind="node"]')).toHaveCount(3)
      for (const key of ['Control+e', 'Control+k', '?']) { await page.keyboard.press(key); await expect(page.getByRole('dialog')).toBeVisible(); await page.keyboard.press('Escape'); await expect(page.getByRole('dialog')).toHaveCount(0) }
      await page.mouse.click(700, 450, { button: 'right' })
      await page.keyboard.press('Escape')
      await page.goto('/#/')
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    }
    for (let i = 0; i < 3; i++) await cycle() // warm up caches and lazy chunks
    const before = await measure()
    for (let i = 0; i < 12; i++) await cycle()
    const after = await measure()
    expect(after.listeners - before.listeners, `event listeners ${before.listeners} → ${after.listeners}`).toBeLessThanOrEqual(8)
    expect(after.nodes / before.nodes, `DOM nodes ${before.nodes} → ${after.nodes}`).toBeLessThan(1.25)
    expect(after.heap / before.heap, `heap ${Math.round(before.heap / 1e6)}MB → ${Math.round(after.heap / 1e6)}MB`).toBeLessThan(1.6)
  })

  test('a long editing session keeps undo history bounded', async ({ page, app }) => {
    test.setTimeout(120_000)
    await app.open(TRIO())
    await app.pick('a')
    for (let i = 0; i < 150; i++) await page.keyboard.press(i % 2 ? 'ArrowLeft' : 'ArrowRight')
    let undone = 0
    while (await page.getByRole('button', { name: 'Undo' }).isEnabled() && undone < 200) { await app.mod('z'); undone++ }
    expect(undone).toBe(120)
  })

  test('first load is light: no failed requests and a small page', async ({ page }) => {
    const failed: string[] = []
    page.on('requestfailed', (r) => failed.push(r.url()))
    page.on('response', (r) => { if (r.status() >= 400) failed.push(r.status() + ' ' + r.url()) })
    await page.goto('/')
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    await page.waitForLoadState('networkidle')
    expect(failed).toEqual([])
    const nav = await page.evaluate(() => { const n = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming; return { dcl: n.domContentLoadedEventEnd, load: n.loadEventEnd } })
    expect(nav.load).toBeLessThan(8000)
    // nothing is requested from another origin: the app works offline once loaded
    const foreign = await page.evaluate(() => performance.getEntriesByType('resource').map((r) => r.name).filter((u) => !u.startsWith(location.origin) && !u.startsWith('data:')))
    expect(foreign).toEqual([])
  })

  test('keeps working offline once loaded', async ({ page, app, context }) => {
    await app.open(TRIO())
    await page.waitForLoadState('networkidle') // "once loaded" includes the parts fetched in the background
    await context.setOffline(true)
    await app.pick('a')
    await page.keyboard.press('ArrowRight')
    expect((await app.settled()).nodes[0].x).toBe(1)
    await page.getByRole('button', { name: 'Share' }).click()
    await expect(page.getByRole('dialog', { name: 'Share blueprint' }).locator('input')).toHaveValue(/#\/s\//)
    await page.keyboard.press('Escape')
    await page.keyboard.press('Control+e')
    await page.getByRole('dialog', { name: 'Export' }).getByRole('button', { name: /^SVG vector/ }).click()
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download' }).click()])
    expect(dl.suggestedFilename()).toBe('e2e-blueprint.svg')
    await context.setOffline(false)
  })
})
