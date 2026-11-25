/**
 * Speed and stability, in the `performance` project: run after every other project has finished, each group in
 * serial mode, because the timings mean nothing on a busy machine. The limits are floors for catching a regression in headless
 * Chrome, not claims about real hardware. A failure means something has started to cost far more per frame, to
 * redraw what did not change, or to leave listeners, DOM or memory behind.
 */
import { devices } from '@playwright/test'
import { TRIO, expect, makeDoc, rested, test } from './fixtures'

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

/** What a stretch of frames cost: how long each took, the longest stretch the page was blocked for, and the work done on the main thread per frame. */
interface Cost { avg: number; p95: number; long: number; work: number }
const say = (c: Cost) => `${c.avg.toFixed(1)} ms a frame on average, ${c.p95.toFixed(0)} ms at the 95th percentile, ${c.work.toFixed(1)} ms of main-thread work a frame, longest blocked stretch ${c.long.toFixed(0)} ms`

// The two gestures, as a trackpad sends them. A pan is wheel events with precise deltas and the legacy value at exactly
// minus three times the delta, which is how the app knows it is not a mouse wheel; it slides a few pixels each way.
// A pinch is wheel events with Ctrl held and a whole notch for the legacy value however small the delta, which is how
// Chrome reports one; it goes in for a quarter of a second and out for the next, 2% a frame.
const PAN = 'pan', PINCH = 'pinch'

/**
 * Send one wheel event a frame for `frames` frames, from inside the page so that nothing the test tool does lands in
 * the measurement, and say what the frames cost. The pointer is over the middle of the canvas, as a hand on a wheel is.
 */
async function gesture(page: import('@playwright/test').Page, frames: number, kind: 'pan' | 'pinch'): Promise<Cost> {
  const box = (await page.locator('.canvas-surface').boundingBox())!
  const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  await page.mouse.move(at.x, at.y)
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Performance.enable')
  const busy = async () => (await cdp.send('Performance.getMetrics')).metrics.find((m) => m.name === 'TaskDuration')!.value * 1000
  const before = await busy()
  const seen = await page.evaluate(([frames, kind, x, y]) => new Promise<{ times: number[]; long: number }>((done) => {
    const el = document.querySelector('.canvas-surface')!
    const make = (i: number): object => (kind === 'pan'
      ? { deltaX: i % 2 ? 9 : -9, deltaY: i % 4 < 2 ? 6 : -6, wheelDeltaX: i % 2 ? -27 : 27, wheelDeltaY: i % 4 < 2 ? -18 : 18 }
      : { ctrlKey: true, deltaY: Math.floor(i / 15) % 2 ? 2 : -2, wheelDeltaY: Math.floor(i / 15) % 2 ? -120 : 120 })
    const times: number[] = []
    let long = 0, last = performance.now(), i = 0
    const watch = new PerformanceObserver((l) => { for (const e of l.getEntries()) long = Math.max(long, e.duration) })
    watch.observe({ entryTypes: ['longtask'] })
    const tick = () => {
      const now = performance.now(); times.push(now - last); last = now
      if (++i > (frames as number)) { watch.disconnect(); return done({ times: times.slice(2), long }) }
      el.dispatchEvent(new WheelEvent('wheel', { clientX: x as number, clientY: y as number, bubbles: true, cancelable: true, ...make(i) }))
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }), [frames, kind, at.x, at.y] as const)
  const work = ((await busy()) - before) / frames
  await cdp.detach()
  const sorted = [...seen.times].sort((x, y) => x - y)
  return { avg: seen.times.reduce((x, y) => x + y, 0) / seen.times.length, p95: sorted[Math.floor(sorted.length * 0.95)], long: seen.long, work }
}

test.describe('performance and stability', () => {
  test.describe.configure({ mode: 'serial' })

  test('a 300-component blueprint opens promptly and stays interactive', async ({ page, app }) => {
    test.slow()
    const doc = bigDoc(300)
    await app.seed(doc)
    const t0 = Date.now()
    await page.goto('/#/d/big')
    await expect(page.locator('.canvas-surface [data-kind="node"]')).toHaveCount(300)
    expect(Date.now() - t0, 'time to first full render').toBeLessThan(6000)
    await app.ready()

    // pan one step per frame, as two fingers on a trackpad do, and time the frames
    const frame = await gesture(page, 60, PAN)
    test.info().annotations.push({ type: 'frame time, 300 components', description: say(frame) })
    // the view moves without anything being drawn again, so this costs what a small blueprint costs: the limit is two
    // frames at 60 a second, which leaves room for a machine that is doing other things
    expect(frame.avg, 'average frame time while panning (ms)').toBeLessThan(34)

    // a real drag across the canvas pans it
    const box = (await page.locator('.canvas-surface').boundingBox())!
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
      for (const el of document.querySelectorAll('.canvas-surface [data-kind="node"]')) obs.observe(el, { attributes: true, childList: true, subtree: true })
    })
    const g = await app.world(4, 4)
    await app.drag(g, { x: g.x + 150, y: g.y + 60 }, { steps: 10 })
    await page.mouse.wheel(0, -240)
    await page.waitForTimeout(500)
    expect(await page.evaluate(() => (window as any).__touched)).toBe(0)
  })

  test('moving the view draws nothing again: the scene is not touched while it pans or is pinched', async ({ page, app }) => {
    await app.open(bigDoc(300))
    // the pointer goes where the gesture will have it before anything is watched: what lights up under a pointer that
    // has just arrived is the pointer's doing, not the view's
    const box = (await page.locator('.canvas-surface').boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.waitForTimeout(300)
    // everything that happens to the drawing itself while the view moves; the layer it sits in is moved, which is not that
    await page.evaluate(() => {
      const w = window as any
      w.__touched = 0
      const obs = new MutationObserver((list) => { w.__touched += list.length })
      for (const el of document.querySelectorAll('.canvas-layer')) obs.observe(el, { attributes: true, childList: true, subtree: true, characterData: true })
      w.__stop = () => { obs.takeRecords().forEach(() => w.__touched++); obs.disconnect() }
    })
    await gesture(page, 40, PAN)
    expect(await page.evaluate(() => (window as any).__touched), 'changes to the drawing during a pan').toBe(0)
    // A pinch is another matter for the browser, which draws every shape again at each new scale (that is what keeps
    // it sharp: see sharp.spec.ts), but not for the app: the shapes are the same shapes, and it changes none of them.
    // All it does is put away what was answering the pointer (the doors of the component under it, the mark round
    // that), once, as the zoom begins: a handful of changes however long the pinch and however large the blueprint
    await gesture(page, 40, PINCH)
    const during = await page.evaluate(() => { (window as any).__stop(); return (window as any).__touched as number })
    expect(during, 'changes to the drawing during a pinch of 40 frames over 300 components').toBeLessThanOrEqual(8)
  })

  test('a notch of the wheel glides to its zoom: more than one frame to get there, there within a fifth of a second, then still', async ({ page, app }) => {
    // Timed by the clock, which is why it is here and not with the other wheel tests (zoom.spec.ts): the easing goes by
    // elapsed time and every frame of a zoom is drawn afresh, so on a machine busy with other tests a frame that comes
    // late puts the zoom's arrival a frame late with it
    await app.open(TRIO())
    await page.keyboard.press('2')
    await page.waitForTimeout(800)
    await rested(page)
    const scale = async () => { const c = await app.cells(1, 0); return Math.hypot(c.x, c.y) }
    const at = await app.world(3, 3), k0 = await scale()
    await page.mouse.move(at.x, at.y)
    await page.waitForTimeout(350)
    // every zoom value the page shows from the notch on, with the time it was shown
    await page.evaluate(() => {
      const w = window as any, g = document.querySelector('.canvas-layer.top > g') as SVGGElement, t0 = performance.now()
      w.__z = []
      const tick = () => { w.__z.push([performance.now() - t0, g.getScreenCTM()!.a]); if (!w.__zDone) requestAnimationFrame(tick) }
      requestAnimationFrame(tick)
    })
    await app.notches(-1)
    await page.waitForTimeout(1200)
    const seen: [number, number][] = await page.evaluate(() => { (window as any).__zDone = true; return (window as any).__z })
    const first = seen.find(([, a]) => a !== seen[0][1])!, last = seen[seen.length - 1][1]
    expect(last / seen[0][1]).toBeCloseTo(1.1, 3)
    // eased, not a jump: the first frame that moved had not gone the whole way
    expect(first[1] / seen[0][1]).toBeLessThan(1.09)
    // there to the eye (within half a percent) inside a fifth of a second of starting to move, and at rest for good
    // inside two fifths: nothing coasts on after the wheel has stopped
    const arrived = seen.find(([, a]) => Math.abs(a / last - 1) < 0.005)!
    test.info().annotations.push({ type: 'a notch of the wheel', description: `there ${(arrived[0] - first[0]).toFixed(0)} ms after it began to move` })
    expect(arrived[0] - first[0], 'time from the first frame that moved to arriving (ms)').toBeLessThan(200)
    expect(seen.filter(([t]) => t > first[0] + 400).every(([, a]) => a === last)).toBe(true)
    expect((await scale()) / k0).toBeCloseTo(1.1, 3)
  })

  test('a 1,000-component blueprint pans, zooms and is edited at the pace of a small one', async ({ page, app }) => {
    test.slow()
    await app.seed(bigDoc(1000))
    await page.goto('/#/d/big')
    await app.ready()
    // opened to fit, every component is in view at once, drawn plainly: far fewer shapes than components times their detail
    await expect(app.nodes()).toHaveCount(1000)
    expect(await page.locator('.canvas-surface .nd-label').count(), 'names drawn from this far out').toBe(0)
    const fit = { pan: await gesture(page, 45, PAN), zoom: await gesture(page, 45, PINCH) }
    test.info().annotations.push({ type: '1,000 components, all in view: pan', description: say(fit.pan) }, { type: '1,000 components, all in view: pinch', description: say(fit.zoom) })
    // at 100% only what is on the screen or within a few hundred pixels of it is drawn at all: the middle of the grid
    // is, its four corners are not
    await page.locator('.zoom-pct').click()
    await expect(page.locator('.zoom-pct .on')).toHaveText('100%')
    await page.waitForTimeout(500)
    const drawn = await app.nodes().count()
    expect(drawn, 'components drawn at 100%').toBeLessThan(800)
    expect(drawn).toBeGreaterThan(20)
    for (const corner of ['n0', 'n31', 'n992', 'n999']) await expect(page.locator(`[data-kind="node"][data-id="${corner}"]`), `the corner ${corner}, far off the screen`).toHaveCount(0)
    const near = { pan: await gesture(page, 45, PAN), zoom: await gesture(page, 45, PINCH) }
    test.info().annotations.push({ type: '1,000 components, at 100%: pan', description: say(near.pan) }, { type: '1,000 components, at 100%: pinch', description: say(near.zoom) })
    for (const [what, c] of [['pan, all in view', fit.pan], ['pinch, all in view', fit.zoom], ['pan at 100%', near.pan], ['pinch at 100%', near.zoom]] as const) {
      // Floors for catching a regression on a machine without a GPU, not claims about real hardware. Before the view was
      // moved on its own layer these were over a second a frame at this size
      expect(c.avg, `average frame time: ${what} (ms)`).toBeLessThan(50)
      expect(c.work, `main-thread work a frame: ${what} (ms)`).toBeLessThan(34)
    }
    // carrying one of them: the others are not redrawn, and each frame is a small one
    const body = (await page.locator('[data-kind="node"] .nd-body').nth(Math.floor(drawn / 2)).boundingBox())!
    const from = { x: body.x + body.width / 2, y: body.y + body.height * 0.6 }
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.evaluate(() => {
      const w = window as any
      w.__frames = []
      let last = performance.now()
      const tick = (t: number) => { if (!w.__frames) return; w.__frames.push(t - last); last = t; requestAnimationFrame(tick) }
      requestAnimationFrame(tick)
    })
    for (let i = 1; i <= 60; i++) { await page.mouse.move(from.x + (180 * i) / 60, from.y + (50 * i) / 60); await page.waitForTimeout(8) }
    const frames: number[] = await page.evaluate(() => { const w = window as any; const f = w.__frames.slice(2); w.__frames = null; return f })
    await page.mouse.up()
    const avg = frames.reduce((x, y) => x + y, 0) / frames.length
    test.info().annotations.push({ type: '1,000 components: carrying one', description: `${avg.toFixed(1)} ms a frame on average` })
    expect(avg, 'average frame time while carrying one of 1,000 (ms)').toBeLessThan(60)
    // the whole blueprint is still what is edited, in view or not
    await page.keyboard.press('Control+a')
    await expect(page.locator('.sel-bar')).toContainText('1000 selected')
    await page.keyboard.press('Escape')
  })

  test('an idle canvas does no work, and one with traffic on it does little', async ({ page, app }) => {
    test.slow()
    await app.open(TRIO())
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Performance.enable')
    const busy = async () => (await cdp.send('Performance.getMetrics')).metrics.find((m) => m.name === 'TaskDuration')!.value * 1000
    const over = async (ms: number) => { const a = await busy(); await page.waitForTimeout(ms); return (await busy()) - a }
    await page.mouse.move(5, 5)
    await page.waitForTimeout(600)
    // traffic is on by default, but nothing here is connected, so nothing moves: the page should be at rest
    const still = await over(1000)
    test.info().annotations.push({ type: 'main-thread work in an idle second', description: `${still.toFixed(0)} ms` })
    expect(still, 'main-thread work in a second with nothing happening (ms)').toBeLessThan(60)

    // With traffic moving along more than a hundred lines, a little: a step repaints the dots and works nothing out,
    // and with this much drawn there are twenty steps a second, not one on every frame
    await app.open(bigDoc(100))
    // from as far out as this opens, the dots would be too small to see and are not drawn: closer in, they are
    await page.locator('.zoom-pct').click()
    await expect(page.locator('.zoom-pct .on')).toHaveText('100%')
    await expect(page.locator('.canvas-wrap')).toHaveClass(/flow-20/)
    expect(await page.locator('.edge-flow').count()).toBeGreaterThan(100)
    await page.mouse.move(5, 5)
    await page.waitForTimeout(600)
    const moving = await over(1000)
    test.info().annotations.push({ type: 'main-thread work in a second of traffic on 100 components', description: `${moving.toFixed(0)} ms` })
    expect(moving, 'main-thread work in a second of traffic (ms)').toBeLessThan(250)
  })

  test('traffic left alone for two minutes stops, and starts again at a touch', async ({ page, app }) => {
    // the page's clock is ours to move on: two minutes go by in an instant
    await page.clock.install()
    const doc = TRIO()
    doc.edges.push({ id: 'ab', from: 'a', to: 'b', style: 'solid', arrow: 'end', width: 2 }, { id: 'ac', from: 'a', to: 'c', style: 'solid', arrow: 'end', width: 2 })
    await app.open(doc)
    const wrap = page.locator('.canvas-wrap'), dots = page.locator('.edge-flow').first()
    const state = () => dots.evaluate((el) => getComputedStyle(el).animationPlayState)
    await page.mouse.move(5, 5)
    expect(await state()).not.toContain('paused')
    await page.clock.fastForward(125_000)
    await expect(wrap).toHaveAttribute('data-asleep', '')
    expect(await state()).toBe('paused')
    // asleep, the page does as little as one with nothing on it
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Performance.enable')
    const busy = async () => (await cdp.send('Performance.getMetrics')).metrics.find((m) => m.name === 'TaskDuration')!.value * 1000
    const before = await busy()
    await page.waitForTimeout(1000)
    expect((await busy()) - before, 'main-thread work in a second asleep (ms)').toBeLessThan(60)
    // the first sign of life wakes it
    await page.mouse.move(300, 300)
    await expect(wrap).not.toHaveAttribute('data-asleep', '')
    expect(await state()).toBe('running')
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
      await expect(page.locator('.canvas-surface [data-kind="node"]')).toHaveCount(3)
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

  test('carrying a connected component across a large blueprint keeps pace with the pointer', async ({ page, app }) => {
    // 80 components and 107 connections; the one carried has three lines that re-route as it goes
    const types = ['ec2', 'rds', 's3', 'lambda', 'alb', 'sqs', 'dynamodb', 'elasticache']
    const nodes = Array.from({ length: 80 }, (_, i) => ({ id: `n${i % 10}_${Math.floor(i / 10)}`, type: types[(i % 10 + Math.floor(i / 10)) % types.length], x: (i % 10) * 5, y: Math.floor(i / 10) * 5 }))
    const doc = makeDoc(nodes)
    for (let j = 0; j < 8; j++) for (let i = 0; i < 10; i++) {
      if (i < 9) doc.edges.push({ id: `h${i}_${j}`, from: `n${i}_${j}`, to: `n${i + 1}_${j}`, style: 'solid', arrow: 'end', width: 2 })
      if (j < 7 && (i + j) % 2 === 0) doc.edges.push({ id: `v${i}_${j}`, from: `n${i}_${j}`, to: `n${i}_${j + 1}`, style: 'solid', arrow: 'end', width: 2 })
    }
    await app.open(doc)
    const b = (await page.locator('[data-kind="node"][data-id="n4_3"] .nd-body').boundingBox())!
    const from = { x: b.x + b.width / 2, y: b.y + b.height * 0.6 }
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.evaluate(() => {
      const w = window as any
      w.__frames = []; w.__long = 0
      let last = performance.now()
      const tick = (t: number) => { if (!w.__frames) return; w.__frames.push(t - last); last = t; requestAnimationFrame(tick) }
      requestAnimationFrame(tick)
      new PerformanceObserver((l) => { for (const e of l.getEntries()) w.__long = Math.max(w.__long, e.duration) }).observe({ entryTypes: ['longtask'] })
    })
    for (let i = 1; i <= 90; i++) { await page.mouse.move(from.x + (200 * i) / 90, from.y + (60 * i) / 90); await page.waitForTimeout(8) }
    const { frames, long } = await page.evaluate(() => { const w = window as any; const f = w.__frames.slice(2); w.__frames = null; return { frames: f as number[], long: w.__long as number } })
    await page.mouse.up()
    const avg = frames.reduce((x, y) => x + y, 0) / frames.length, p95 = [...frames].sort((x, y) => x - y)[Math.floor(frames.length * 0.95)]
    test.info().annotations.push({ type: 'frame time carrying one of 80 components', description: `${avg.toFixed(1)} ms average, ${p95.toFixed(0)} ms at the 95th percentile, longest task ${long.toFixed(0)} ms` })
    // a floor for regressions on a machine without a GPU, not a claim about real hardware: 60 frames a second is 16.7 ms
    expect(avg, 'average frame time while carrying (ms)').toBeLessThan(34)
    expect(long, 'longest single task while carrying (ms)').toBeLessThan(250)
    // and it was all one step, written at the end
    expect((await app.settled()).nodes.find((n) => n.id === 'n4_3')).not.toMatchObject({ x: 20, y: 15 })
    await app.mod('z')
    expect((await app.settled()).nodes.find((n) => n.id === 'n4_3')).toMatchObject({ x: 20, y: 15 })
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
    // Nothing on the page moves as it loads: the words are drawn once, in the font they are set in. That is the built
    // page's doing (it asks for the font before it is needed: see vite.config.ts), so it is the built page that is held to it.
    // The development server finds the font when the stylesheet is read, and its words are redrawn when it arrives
    const shift = await page.evaluate(() => new Promise<number>((done) => {
      let total = 0
      new PerformanceObserver((l) => { for (const e of l.getEntries() as any[]) if (!e.hadRecentInput) total += e.value }).observe({ type: 'layout-shift', buffered: true })
      setTimeout(() => done(total), 300)
    }))
    test.info().annotations.push({ type: 'cumulative layout shift while loading', description: shift.toFixed(3) })
    if (process.env.E2E_PROD) expect(shift, 'cumulative layout shift while loading').toBeLessThan(0.05)
  })

  test('each screen is fetched without the other, and the code is not a megabyte', async ({ page, app }) => {
    test.skip(!process.env.E2E_PROD, 'the development server serves modules one by one: only the built app is in files')
    await app.seed(TRIO())
    const scripts = () => page.evaluate(() => performance.getEntriesByType('resource').filter((r) => /\.js(\?|$)/.test(r.name)).map((r) => ({ name: r.name.split('/').pop()!, start: r.startTime, bytes: (r as PerformanceResourceTiming).decodedBodySize })))
    const shownAt = () => page.evaluate(() => performance.now())
    // the list of blueprints: its own code and the part every screen shares, asked for together, and not the editor's
    await page.goto('/')
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    let js = await scripts(), at = await shownAt()
    expect(js.filter((r) => r.start < at).map((r) => r.name.replace(/-[\w-]{8}\.js$/, '')).sort(), 'scripts fetched to show the list').toEqual(expect.arrayContaining(['Dashboard', 'index']))
    expect(js.some((r) => /^editing-/.test(r.name) && r.start < at), 'the editor was fetched before the list was shown').toBe(false)
    expect(js.filter((r) => r.start < at).reduce((n, r) => n + r.bytes, 0), 'bytes of script to show the list, before compression').toBeLessThan(560_000)
    // the editor, opened on its own address: the same, the other way round
    await page.goto('about:blank')
    await page.goto('/#/d/e2edoc')
    await app.ready()
    js = await scripts()
    const first = Math.min(...js.map((r) => r.start))
    // both asked for at once, by the page itself: the editor's code is not found only after the app's has run
    expect(js.filter((r) => /^(index|editing)-/.test(r.name)).every((r) => r.start - first < 100), 'the editor and the app were asked for together').toBe(true)
    expect(js.filter((r) => /^(index|editing)-/.test(r.name)).reduce((n, r) => n + r.bytes, 0), 'bytes of script to show the editor, before compression').toBeLessThan(720_000)
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

/**
 * Phone timings, measured one at a time on a quiet machine with the CPU slowed
 * four times over. Input is raw touch and the waits are plain sleeps, so nothing
 * the test tool does lands inside the measured window.
 */
test.describe('performance on a slow phone', () => {
  test.describe.configure({ mode: 'serial' })
  const { defaultBrowserType: _, ...pixel } = devices['Pixel 7']
  test.use(pixel)

  test('the component library opens, scrolls and searches without a stall', async ({ page, app }) => {
    await app.open(TRIO())
    const cdp = await page.context().newCDPSession(page)
    const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', pts: { x: number; y: number }[]) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((p, id) => ({ x: Math.round(p.x), y: Math.round(p.y), id })) })
    const add = (await page.locator('.dock').getByRole('button', { name: 'Add', exact: true }).boundingBox())!
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
    await page.evaluate(() => {
      const w = window as any; w.__long = []; w.__frames = []
      new PerformanceObserver((l) => l.getEntries().forEach((e) => w.__long.push(e.duration))).observe({ entryTypes: ['longtask'] })
      let last = performance.now(); const tick = (t: number) => { w.__frames.push(t - last); last = t; requestAnimationFrame(tick) }; requestAnimationFrame(tick)
    })
    const reset = () => page.evaluate(() => { const w = window as any; w.__long = []; w.__frames = [] })
    const worst = () => page.evaluate(() => { const w = window as any; return { task: Math.round(Math.max(0, ...w.__long)), frame: Math.round(Math.max(0, ...w.__frames)), slowFrames: w.__frames.filter((f: number) => f > 50).length } })
    const note = (what: string, v: { task: number; frame: number; slowFrames: number }) => test.info().annotations.push({ type: what + ' at 4x CPU slowdown', description: `longest blocked stretch ${v.task} ms, worst frame ${v.frame} ms, frames over 50 ms: ${v.slowFrames}` })

    await reset()
    await touch('touchStart', [{ x: add.x + add.width / 2, y: add.y + add.height / 2 }]); await touch('touchEnd', [])
    await page.waitForTimeout(1500)
    const open = await worst()
    note('opening the library', open)
    await expect(page.getByRole('dialog', { name: 'Library' })).toBeVisible()

    const list = page.locator('.palette-scroll'), box = (await list.boundingBox())!, x = box.x + box.width / 2
    await reset()
    for (let n = 0; n < 6; n++) {
      await touch('touchStart', [{ x, y: box.y + box.height - 24 }])
      for (let i = 1; i <= 5; i++) { await touch('touchMove', [{ x, y: box.y + box.height - 24 - ((box.height - 48) * i) / 5 }]); await page.waitForTimeout(12) }
      await touch('touchEnd', []); await page.waitForTimeout(300)
    }
    const scroll = await worst()
    note('flicking through the library', scroll)
    expect(await list.evaluate((e) => e.scrollTop)).toBeGreaterThan(600)

    const field = (await page.getByLabel('Search components').boundingBox())!
    await touch('touchStart', [{ x: field.x + field.width / 2, y: field.y + field.height / 2 }]); await touch('touchEnd', [])
    await page.waitForTimeout(700)
    await reset()
    await page.keyboard.type('queue', { delay: 60 })
    await page.waitForTimeout(500)
    const type = await worst()
    note('typing a search', type)
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })
    await expect(page.locator('.pal-item')).toHaveCount(3)

    // Measured alone, opening blocks for about 60 ms here; it was about 140 ms when every picture was drawn up
    // front (and 950 ms on the development build). The limit sits between normal run-to-run noise and that.
    // The development build runs React's slow checks, so its limit is looser.
    const limit = process.env.E2E_PROD ? 150 : 500
    expect(open.task, 'opening').toBeLessThan(limit)
    expect(scroll.task, 'scrolling').toBeLessThan(limit)
    expect(type.task, 'typing').toBeLessThan(limit)
  })
})
