#!/usr/bin/env node
// Benchmarks the built app in headless Chrome and prints what each kind of interaction costs, for blueprints of
// several sizes. It is for measuring before and after a change by hand; the limits that guard against regressions are
// in e2e/performance.spec.ts, which runs with the tests.
//
//   node scripts/bench.mjs                              build, serve on port 5197, measure, stop
//   node scripts/bench.mjs --url http://localhost:5198  measure a server that is already running
//   --sizes 30,300,1000,2000   how many components each blueprint has (the default)
//   --gpu                      draw with the graphics card (headless Chrome draws in software otherwise)
//   --cpu 4                    slow the processor this many times, as a phone would be
//   --phone                    a phone's screen and touch (Pixel 7) in place of a 1440 by 900 window
//   --dpr 2                    device pixels to a CSS pixel in that window: 2 is a high-density laptop screen
//   --frames 60                frames per measurement (fewer by default for the largest sizes)
//   --only pan,zoom,drag       measure only these (open, pan, zoom, pan100, zoom100, drag, orbit, edit)
//   --json out.json            write every figure to a file as well
//
// What is measured. A frame's time is the gap between two animation frames while the gesture runs, with one input event
// sent a frame from inside the page, so nothing the test tool does is in it: 16.7 ms is a display's full 60 a second.
// `work` is main-thread time per frame, which is what a slower processor multiplies. An edit's time runs from the key
// going down to the end of the frame that shows what it did, as the page's own clock has it. The figure in brackets
// after it is the browser's (Event Timing, which is what Interaction to Next Paint is made of): from the key to that
// frame reaching the screen, in steps of 8 ms, and 0 when it was under 16. Run it on a quiet machine, and compare runs
// made the same way: the numbers are for telling one build from another on one machine, not for describing a user's.
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { chromium, devices } from '@playwright/test'

const flag = (name) => process.argv.includes('--' + name)
const arg = (name, fallback) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : fallback }
const SIZES = arg('sizes', '30,300,1000,2000').split(',').map(Number)
const ONLY = arg('only', '').split(',').filter(Boolean)
const CPU = Number(arg('cpu', '1')), FRAMES = Number(arg('frames', '0')), DPR = Number(arg('dpr', '1'))
const want = (name) => !ONLY.length || ONLY.includes(name)

/** A grid of connected components with areas round blocks of them and a few labels: every kind of thing, in proportion. */
function blueprint(n) {
  const types = ['ec2', 'rds', 's3', 'lambda', 'sqs', 'alb', 'dynamodb', 'elasticache', 'ecs', 'cloudfront', 'apigw', 'sns']
  const side = Math.ceil(Math.sqrt(n))
  const nodes = Array.from({ length: n }, (_, i) => ({ id: 'n' + i, type: types[i % types.length], x: (i % side) * 4, y: Math.floor(i / side) * 4, name: 'c-' + i, props: {} }))
  const edges = []
  for (let i = 0; i < n - 1; i++) if ((i + 1) % side) edges.push({ id: 'e' + i, from: 'n' + i, to: 'n' + (i + 1), style: 'solid', arrow: 'end', width: 2 })
  for (let i = 0; i + side < n; i += 3) edges.push({ id: 'v' + i, from: 'n' + i, to: 'n' + (i + side), style: i % 2 ? 'dashed' : 'solid', arrow: 'end', width: 2, ...(i % 12 === 0 ? { label: 'https' } : {}) })
  const areas = []
  for (let by = 0; by * 5 < side; by += 2) for (let bx = 0; bx * 5 < side; bx += 2) areas.push({ id: `a${bx}_${by}`, x: bx * 20 - 0.8, y: by * 20 - 0.8, w: 19.6, d: 19.6, name: `subnet ${bx}.${by}`, color: ['#3DB87F', '#4F7FF2', '#E8A33D', '#E85C9C'][(bx + by) % 4], kind: 'subnet' })
  const labels = Array.from({ length: Math.max(1, Math.floor(n / 100)) }, (_, i) => ({ id: 'l' + i, x: (i % 5) * 20, y: -2.5 - Math.floor(i / 5) * 2, text: 'Region ' + i, size: 20, dir: 'x' }))
  return { id: 'bench' + n, name: 'Bench ' + n, region: 'us-east-1', nodes, edges, areas, labels, createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000 }
}

const summary = (times) => {
  const s = [...times].sort((a, b) => a - b)
  return { avg: times.reduce((a, b) => a + b, 0) / times.length, p95: s[Math.floor(s.length * 0.95)], worst: s[s.length - 1] }
}

/** Build the app and serve it, unless a server was named. Returns its address and how to stop it. */
async function server() {
  if (arg('url')) return { url: arg('url'), stop() {} }
  // Vite is run directly, not through npx: stopping npx leaves the server it started running, and the port taken
  const vite = (...args) => spawn(process.execPath, ['node_modules/vite/bin/vite.js', ...args], { stdio: 'ignore' })
  await new Promise((done, fail) => vite('build').on('exit', (code) => (code ? fail(new Error('the build failed')) : done())))
  const child = vite('preview', '--port', '5197', '--strictPort')
  const url = 'http://localhost:5197'
  for (let i = 0; i < 50; i++) { try { if ((await fetch(url)).ok) break } catch { /* not up yet */ } await new Promise((r) => setTimeout(r, 100)) }
  return { url, stop: () => child.kill() }
}

async function measure(browser, url, n) {
  const doc = blueprint(n)
  const context = await browser.newContext(flag('phone') ? { ...devices['Pixel 7'] } : { viewport: { width: 1440, height: 900 }, deviceScaleFactor: DPR })
  const page = await context.newPage()
  await page.addInitScript(() => {
    try { localStorage.setItem('stratum:pref:coached', 'true') } catch { /* storage blocked */ }
    // How long each key takes to show, two ways. `shown`: from the key to the end of the main thread's part of the next
    // frame (a task posted from that frame's animation callback runs when its style, layout and painting are done).
    // `presented`: the browser's own timing of the same key, to the frame reaching the screen
    const keys = (window.__keys = { shown: [], presented: [] })
    addEventListener('keydown', (e) => {
      if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return
      const from = e.timeStamp
      requestAnimationFrame(() => { const after = new MessageChannel(); after.port1.onmessage = () => keys.shown.push(performance.now() - from); after.port2.postMessage(0) })
    }, true)
    try { new PerformanceObserver((list) => { for (const e of list.getEntries()) if (e.name === 'keydown') keys.presented.push(e.duration) }).observe({ type: 'event', durationThreshold: 16 }) } catch { /* not a browser that times events */ }
  })
  const cdp = await context.newCDPSession(page)
  await cdp.send('Performance.enable')
  if (CPU > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU })
  const busy = async () => (await cdp.send('Performance.getMetrics')).metrics.find((m) => m.name === 'TaskDuration').value * 1000
  const out = { components: n, connections: doc.edges.length }
  const frames = FRAMES || (n >= 2000 ? 30 : n >= 1000 ? 45 : 90)

  await page.goto(url + '/')
  await page.evaluate((d) => {
    localStorage.setItem('stratum:doc:' + d.id, JSON.stringify(d))
    localStorage.setItem('stratum:index', JSON.stringify([{ id: d.id, name: d.name, updatedAt: d.updatedAt, nodes: d.nodes.length }]))
  }, doc)

  // opening: from asking for the page to the second frame after the first component is on it
  const open = async () => {
    await page.goto('about:blank')
    await page.goto(url + '/#/d/' + doc.id)
    await page.waitForSelector('[data-kind="node"]', { state: 'attached', timeout: 120_000 })
    return page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(performance.now())))))
  }
  const opened = await open()
  if (want('open')) out.open = opened
  await page.waitForFunction(() => !document.querySelector('.canvas-wrap.intro'), null, { timeout: 20_000 })
  await page.waitForTimeout(400)
  out.drawn = await page.locator('[data-kind="node"]').count()

  const box = await page.locator('.canvas-surface').boundingBox()
  const mid = { x: box.x + box.width / 2, y: box.y + box.height * 0.45 }
  await page.mouse.move(mid.x, mid.y)

  /** Run `drive` (which sends one event a frame for `count` frames, inside the page) and say what the frames cost. */
  const timed = async (name, count, drive) => {
    if (!want(name)) return
    const before = await busy()
    const times = await drive(count)
    out[name] = { ...summary(times), work: ((await busy()) - before) / count }
    await page.waitForTimeout(350)
  }
  // a trackpad, as the app tells one from a wheel: precise deltas with the legacy value at minus three times the delta
  const wheel = (kind) => (count) => page.evaluate(([count, kind, x, y]) => new Promise((done) => {
    const el = document.querySelector('.canvas-surface'), times = []
    let last = performance.now(), i = 0
    const tick = () => {
      const now = performance.now(); times.push(now - last); last = now
      if (++i > count) return done(times.slice(2))
      const init = kind === 'pan'
        ? { deltaX: i % 2 ? 9 : -9, deltaY: i % 4 < 2 ? 6 : -6, wheelDeltaX: i % 2 ? -27 : 27, wheelDeltaY: i % 4 < 2 ? -18 : 18 }
        // (a pinch as Chrome reports one: Ctrl held, and a whole notch for the legacy value however small the delta)
        : { ctrlKey: true, deltaY: Math.floor(i / 15) % 2 ? 2 : -2, wheelDeltaY: Math.floor(i / 15) % 2 ? -120 : 120 }
      el.dispatchEvent(new WheelEvent('wheel', { clientX: x, clientY: y, bubbles: true, cancelable: true, ...init }))
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }), [count, kind, mid.x, mid.y])
  // a pointer held down and moved a little every frame: `button` 0 carries what is under it, 2 turns the camera
  const pointer = (from, button) => async (count) => {
    await page.mouse.move(from.x, from.y)
    await page.mouse.down({ button: button ? 'right' : 'left' })
    await page.mouse.move(from.x + 6, from.y + 3)
    const times = await page.evaluate(([count, x, y, button]) => new Promise((done) => {
      const el = document.querySelector('.canvas-surface'), times = []
      let last = performance.now(), i = 0
      const tick = () => {
        const now = performance.now(); times.push(now - last); last = now
        if (++i > count) return done(times.slice(2))
        const to = button ? { x: x + 6 + i * 2, y: y + (i % 20 < 10 ? i % 10 : 10 - (i % 10)) } : { x: x + 6 + (220 * i) / count, y: y + 3 + (70 * i) / count }
        el.dispatchEvent(new PointerEvent('pointermove', { clientX: to.x, clientY: to.y, bubbles: true, pointerId: 1, pointerType: 'mouse', buttons: button ? 2 : 1, isPrimary: true }))
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    }), [count, from.x, from.y, button])
    if (!button) await page.keyboard.press('Escape')
    await page.mouse.up({ button: button ? 'right' : 'left' })
    return times
  }

  // with everything in view, as it opens
  await timed('pan', frames, wheel('pan'))
  await timed('zoom', frames, wheel('zoom'))
  // at 100%, where a large blueprint is mostly out of view
  if (n > 60 && !flag('phone')) { await page.locator('.zoom-pct').click(); await page.waitForTimeout(700) }
  await timed('pan100', frames, wheel('pan'))
  await timed('zoom100', frames, wheel('zoom'))
  const target = await page.evaluate(([x, y]) => {
    let best = null, least = Infinity
    for (const el of document.querySelectorAll('[data-kind="node"] .nd-body')) {
      const r = el.getBoundingClientRect(), c = { x: r.left + r.width / 2, y: r.top + r.height * 0.6 }, d = Math.hypot(c.x - x, c.y - y)
      if (d < least) { least = d; best = c }
    }
    return best
  }, [mid.x, mid.y])
  if (target) await timed('drag', frames, pointer(target, 0))
  await timed('orbit', Math.max(10, Math.round(frames * 0.6)), pointer(mid, 2))
  await page.keyboard.press('3')
  await page.waitForTimeout(900)

  // edits: from the key to the frame that shows it, the middle of five
  if (want('edit') && target && !flag('phone')) {
    const middle = (list) => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)] ?? 0
    const key = async (name, press) => {
      const shown = [], presented = []
      for (let i = 0; i < 5; i++) {
        await page.evaluate(() => { window.__keys.shown.length = 0; window.__keys.presented.length = 0 })
        await page.keyboard.press(press)
        // two frames for the edit to be drawn, then a moment for the browser to hand over its timing of it
        await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(null)))))
        await page.waitForTimeout(400)
        const seen = await page.evaluate(() => window.__keys)
        shown.push(seen.shown.at(-1) ?? 0)
        presented.push(Math.max(0, ...seen.presented))
      }
      out[name] = { shown: middle(shown), presented: middle(presented) }
    }
    // Back to a known view first: the turn above leaves the blueprint somewhere else on the screen, and a click where a
    // component used to be would select nothing, and time keys that do nothing
    await page.keyboard.press('Escape')
    await page.keyboard.press('f')
    await page.waitForTimeout(900)
    if (n > 60) { await page.locator('.zoom-pct').click(); await page.waitForTimeout(900) }
    const pick = await page.evaluate(([x, y]) => {
      let best = null, least = Infinity
      for (const el of document.querySelectorAll('[data-kind="node"] .nd-body')) {
        const r = el.getBoundingClientRect(), c = { x: r.left + r.width / 2, y: r.top + r.height * 0.6 }, d = Math.hypot(c.x - x, c.y - y)
        if (d < least) { least = d; best = { ...c, id: el.closest('[data-kind="node"]').getAttribute('data-id') } }
      }
      return best
    }, [mid.x, mid.y])
    const place = () => page.evaluate((id) => { const m = document.querySelector(`[data-kind="node"][data-id="${id}"]`).getScreenCTM(); return [Math.round(m.e * 10), Math.round(m.f * 10)].join() }, pick.id)
    await page.mouse.click(pick.x, pick.y)
    await page.waitForTimeout(400)
    // and make sure the key really moves it, and undo really puts it back
    const before = await place()
    await page.keyboard.press('ArrowRight')
    await page.waitForTimeout(600)
    const moved = (await place()) !== before
    await page.keyboard.press('Control+z')
    await page.waitForTimeout(600)
    if (!moved || (await place()) !== before) throw new Error(`could not select and nudge a component of the ${n}-component blueprint: the edit timings would be of nothing`)
    await key('nudge', 'ArrowRight')
    await key('undo', 'Control+z')
    await page.keyboard.press('Escape')
    await key('selectAll', 'Control+a')
    await key('nudgeAll', 'ArrowRight')
    await key('undoAll', 'Control+z')
    await page.keyboard.press('Escape')
  }
  const metrics = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]))
  out.heapMB = metrics.JSHeapUsedSize / 1e6
  out.domNodes = metrics.Nodes
  await context.close()
  return out
}

const { url, stop } = await server()
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: flag('gpu') ? ['--enable-gpu'] : [] })
const results = []
try {
  for (const n of SIZES) results.push(await measure(browser, url, n))
} finally {
  await browser.close()
  stop()
}
const ms = (v) => (v === undefined ? '' : typeof v === 'number' ? v.toFixed(0) : 'shown' in v ? `${v.shown.toFixed(0)} (${v.presented.toFixed(0)})` : `${v.avg.toFixed(1)} (${v.p95.toFixed(0)}) ${v.work.toFixed(1)}`)
const rows = [
  ['components', (r) => String(r.components)], ['drawn when opened', (r) => String(r.drawn)], ['open, ms', (r) => ms(r.open)],
  ['pan, all in view', (r) => ms(r.pan)], ['pinch, all in view', (r) => ms(r.zoom)], ['pan at 100%', (r) => ms(r.pan100)], ['pinch at 100%', (r) => ms(r.zoom100)],
  ['carry one', (r) => ms(r.drag)], ['orbit', (r) => ms(r.orbit)],
  ['nudge one, ms', (r) => ms(r.nudge)], ['undo, ms', (r) => ms(r.undo)], ['select all, ms', (r) => ms(r.selectAll)], ['nudge all, ms', (r) => ms(r.nudgeAll)], ['undo all, ms', (r) => ms(r.undoAll)],
  ['heap, MB', (r) => ms(r.heapMB)], ['DOM nodes', (r) => String(r.domNodes)],
]
console.log(`\n${flag('gpu') ? 'graphics card' : 'software drawing'}, processor slowed ${CPU} times, ${flag('phone') ? 'phone screen' : `1440 by 900 at ${DPR} device pixels to one`}`)
console.log('gestures: average frame ms (95th percentile) main-thread ms a frame')
console.log('edits: ms from the key to the end of the frame that shows it (the browser\'s own timing to the screen)\n')
for (const [name, cell] of rows) console.log(name.padEnd(20) + results.map((r) => cell(r).padStart(22)).join(''))
if (arg('json')) writeFileSync(arg('json'), JSON.stringify({ url, gpu: flag('gpu'), cpu: CPU, phone: flag('phone'), dpr: DPR, results }, null, 1))
