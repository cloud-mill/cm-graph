import type { Page } from '@playwright/test'
import { type App, type SeedDoc, expect, makeDoc, rested, test } from './fixtures'
import { decode, difference, sharpness } from './pixels'

/**
 * The canvas is sharp on every frame of a zoom, not only once the zoom has ended.
 *
 * What is checked is what is on the screen. The page's clock is held still, so a zoom can be stopped while it is still
 * "under way" (the canvas counts the view as at rest a moment after it last moved) and the frame photographed; then the
 * clock is let run, the view comes to rest, and the frame is photographed again. The two must be the same picture. A
 * canvas that shows a stretched or half-resolution picture while it zooms, and sharpens it afterwards, fails here on
 * both counts: thousands of pixels differ, and the first picture has less fine detail than the second.
 *
 * Small differences are expected and allowed for. While a zoom lasts the scene is drawn with the rest of the page, and
 * at rest on a surface of its own (see Canvas.tsx): the same shapes at the same size, but put through the browser's
 * antialiasing by two routes, which leaves the odd edge pixel a shade apart and now and then one letter a quarter of a
 * pixel along.
 */
const edge = (id: string, from: string, to: string, extra: Record<string, unknown> = {}) => ({ id, from, to, style: 'solid', arrow: 'end', width: 2, ...extra }) as SeedDoc['edges'][number]
/** Nine components with everything a zoom could soften: names, captions on lines, straight, dashed and curved lines, a group and a note. */
const scene = () => makeDoc(
  [
    { id: 'a', type: 'ec2', x: 0, y: 0, name: 'web-1' }, { id: 'b', type: 'rds', x: 6, y: 0, name: 'orders-db' }, { id: 'e', type: 'cloudfront', x: 12, y: 0, name: 'edge' },
    { id: 'c', type: 's3', x: 0, y: 6, name: 'assets' }, { id: 'd', type: 'sqs', x: 6, y: 6, name: 'jobs' }, { id: 'f', type: 'lambda', x: 12, y: 6, name: 'resize' },
    { id: 'g', type: 'alb', x: 0, y: 12, name: 'balancer' }, { id: 'h', type: 'dynamodb', x: 6, y: 12, name: 'sessions' }, { id: 'i', type: 'elasticache', x: 12, y: 12, name: 'cache' },
  ],
  {
    edges: [
      edge('ab', 'a', 'b', { label: 'sql' }), edge('be', 'b', 'e'), edge('ac', 'a', 'c', { style: 'dashed' }), edge('cd', 'c', 'd', { label: 'enqueue' }),
      edge('bd', 'b', 'd', { shape: 'curved' }), edge('de', 'd', 'e', { shape: 'curved', arrow: 'both', label: 'https' }), edge('df', 'd', 'f'),
      edge('cg', 'c', 'g'), edge('gh', 'g', 'h', { style: 'dashed', label: 'tcp' }), edge('hi', 'h', 'i', { shape: 'curved' }), edge('fi', 'f', 'i'),
    ],
    areas: [{ id: 'vpc', x: -1, y: -1, w: 10, d: 10, name: 'production', color: '#8F6FF2', kind: 'vpc' }],
    labels: [{ id: 'note', x: 0, y: -3.2, text: 'Order pipeline', size: 20, dir: 'x' }],
  },
)

/** The part of the canvas clear of the panels, bars and map that float over it: CSS px of the 1440 x 900 viewport every test here runs at. */
const CLEAR = { x: 331, y: 112, width: 669, height: 590 }
/** Where the pinches are made: the middle of that. */
const MID = { x: 665, y: 400 }
/** One frame by the page's clock, in ms: enough to run whatever was asked of the next animation frame. */
const FRAME = 17

/**
 * One report of a pinch on a trackpad, as Chrome makes them: a wheel event with Ctrl held, `deltaY` a hundred times the
 * log of the change in scale, and a whole notch for the legacy value whatever the size of the movement. `dy` below zero
 * zooms in, 1% a unit.
 */
const pinch = (page: Page, dy: number, at = MID) => page.evaluate(([x, y, dy]) => {
  document.querySelector('.canvas-surface')!.dispatchEvent(new WheelEvent('wheel', { clientX: x, clientY: y, deltaY: dy, wheelDeltaY: dy < 0 ? 120 : -120, ctrlKey: true, bubbles: true, cancelable: true } as WheelEventInit))
}, [at.x, at.y, dy] as const)
const frames = async (page: Page, n = 1) => { for (let i = 0; i < n; i++) await page.clock.runFor(FRAME) }

interface View { layer: string; zoom: string; k: number; viewing: boolean; zooming: boolean; own: boolean; onScreen: number }
/** How the canvas has the view written on the page, read without waiting for anything (the clock is held: nothing would come). */
const view = (page: Page) => page.evaluate((): View => {
  const wrap = document.querySelector('.canvas-wrap')!, pan = document.querySelector<HTMLElement>('.canvas-pan')!, zoom = document.querySelector<HTMLElement>('.canvas-zoom')!
  return {
    layer: pan.style.transform, zoom: zoom.style.transform, k: Number(/scale\(([-\d.e]+)\)/.exec(zoom.style.transform)?.[1] ?? NaN),
    viewing: wrap.hasAttribute('data-viewing'), zooming: wrap.hasAttribute('data-zooming'), own: getComputedStyle(pan).willChange === 'transform',
    // the zoom as the browser has it for something in the scene: how many screen px one scene px covers
    onScreen: (document.querySelector('.canvas-layer.top > g') as SVGGElement).getScreenCTM()!.a,
  }
})

/**
 * Open the scene and take hold of the clock: from here time passes only when a test says so, a frame at a time.
 * Two things that change by themselves or by where the pointer is are put out of the picture first. Neither is what
 * these tests are about, and both are meant to stand still while the view moves and pick up again at rest: the dots
 * that run along the lines, and the marks that answer the pointer.
 */
async function held(page: Page, app: App, doc: SeedDoc = scene()) {
  await keepFrames(page)
  await page.clock.install()
  await app.open(doc)
  await page.addStyleTag({ content: '.edge-flow { display: none !important } .hover-mark, .door { visibility: hidden !important } .nd:hover .nd-body { filter: none !important }' })
  await rested(page)
  await page.clock.pauseAt(new Date(Date.now() + 2000))
  await frames(page, 2)
}

/**
 * The browser's own frames, kept out of the clock's reach: taking hold of the clock replaces `requestAnimationFrame`
 * with one that only fires when the clock is stepped, and a test also needs to know when the browser has really drawn.
 * Call before `page.clock.install()`.
 */
const keepFrames = (page: Page) => page.addInitScript(() => { (window as unknown as { __frame: typeof requestAnimationFrame }).__frame = window.requestAnimationFrame.bind(window) })
/**
 * Three of the browser's own frames have begun since this was asked. The page's work for a frame is handed over to be
 * drawn before the next frame's begins, and cannot be handed over while the one before is still being drawn, so by the
 * third whatever the page held when this was called is on the screen, however busy the machine.
 */
const drawn = (page: Page) => page.evaluate(() => new Promise<void>((done) => {
  const frame = (window as unknown as { __frame: typeof requestAnimationFrame }).__frame
  frame(() => frame(() => frame(() => done())))
}))

/** Step the clock until the view has stopped changing: an eased zoom glides to its end over a few frames. It is still under way when this returns. */
async function glided(page: Page) {
  let was = '', same = 0
  for (let i = 0; i < 90 && same < 2; i++) {
    await frames(page)
    const v = await view(page), now = v.layer + v.zoom
    same = now === was ? same + 1 : 0
    was = now
  }
  expect(same, 'the zoom came to its end').toBe(2)
}

/**
 * What is on the screen once the browser has finished drawing what the page now holds: photographs taken until two
 * running are the same. With the clock held nothing on the page changes by itself, so a photograph that differs from
 * the next is one the browser had not caught up for (on a machine busy with other tests it can be a frame or two
 * behind the page).
 */
async function shown(page: Page) {
  await drawn(page)
  let last = await page.screenshot({ clip: CLEAR })
  for (let i = 0; i < 25; i++) {
    await page.waitForTimeout(50)
    const next = await page.screenshot({ clip: CLEAR })
    if (next.equals(last)) return decode(next)
    last = next
  }
  throw new Error('what is on the screen never stopped changing')
}

/**
 * The frame on screen now, with the zoom still under way, against the frame once the view has come to rest: the same
 * picture, and neither softer than the other. Returns how the view stood while it was under way.
 */
async function sameAtRest(page: Page, what: string) {
  const during = await view(page)
  expect(during.viewing, `${what}: still under way when photographed`).toBe(true)
  // the very first look, whatever the browser had got to, and then the frame it settles on
  const first = decode(await page.screenshot({ clip: CLEAR }))
  const a = await shown(page)
  expect((await view(page)).viewing, `${what}: still under way once photographed`).toBe(true)
  await page.clock.runFor(400)
  const after = await view(page)
  expect(after.viewing, `${what}: at rest`).toBe(false)
  expect(after.own, `${what}: the layer has its own surface back at rest`).toBe(true)
  // coming to rest moves nothing: where the last frame of the zoom put the scene is where it stays
  expect([after.layer, after.zoom], `${what}: nothing moves at rest`).toEqual([during.layer, during.zoom])
  const b = await shown(page)
  // Even a frame the browser was behind on was a frame drawn at its own size: nothing soft is shown on the way. (It
  // may be a step of the zoom behind, so it is held to being sharp, not to being the same picture)
  expect(sharpness(first) / sharpness(b), `${what}: fine detail at first sight, as a share of that at rest`).toBeGreaterThan(0.9)
  const d = difference(a, b), detail = sharpness(a) / sharpness(b)
  test.info().annotations.push({ type: what, description: `${d.over8} of ${d.pixels} pixels differ by more than 8/255 (${d.over32} by more than 32, worst ${d.worst}); fine detail while zooming is ${(detail * 100).toFixed(1)}% of that at rest; zoom ${(during.k * 100).toFixed(0)}%` })
  // a stretched picture differs from the one drawn afresh in one pixel in a hundred or more; antialiasing by another route, in a few in a hundred thousand
  expect(d.over32 / d.pixels, `${what}: share of pixels that differ plainly between the zooming frame and the frame at rest`).toBeLessThan(0.0005)
  expect(detail, `${what}: fine detail in the zooming frame, as a share of that at rest`).toBeGreaterThan(0.97)
  expect(detail, `${what}: fine detail in the zooming frame, as a share of that at rest`).toBeLessThan(1.03)
  return during
}

test.describe('sharp at every frame of a zoom', () => {
  test('a pinch on a trackpad, in or out, slow or fast: the frame while it is under way is the picture it comes to rest on', async ({ page, app }) => {
    await held(page, app)
    const start = (await view(page)).k
    for (const [what, dy, n] of [['a slow pinch in', -2, 24], ['a slow pinch out', 2, 30], ['a fast pinch in', -9, 9], ['a fast pinch out', 11, 9]] as const) {
      for (let i = 0; i < n; i++) { await pinch(page, dy); await frames(page) }
      await frames(page, 2)
      const v = await sameAtRest(page, what)
      // drawn with the rest of the page while it lasts, not as a layer of its own being scaled
      expect(v.zooming, `${what}: in the middle of a zoom`).toBe(true)
      expect(v.own).toBe(false)
    }
    // and it went somewhere: in by about 60%, out past where it began, in again, out again
    expect((await view(page)).k).not.toBeCloseTo(start, 2)
  })

  test('in and out by turns without a pause between: still the picture it comes to rest on', async ({ page, app }) => {
    await held(page, app)
    for (let i = 0; i < 36; i++) { await pinch(page, Math.floor(i / 6) % 2 ? 4 : -5); await frames(page) }
    await frames(page, 2)
    await sameAtRest(page, 'a pinch that keeps changing its mind')
  })

  test('the wheel, the buttons and the keys, which glide to the new zoom: sharp when the glide ends, before the view has come to rest', async ({ page, app }) => {
    await held(page, app)
    // the pointer on open ground, between components and clear of the lines
    await page.mouse.move(MID.x + 6, MID.y + 4)
    await frames(page, 2)
    await app.notches(-3)
    await glided(page)
    await sameAtRest(page, 'three notches of the wheel in')
    await app.notches(2)
    await glided(page)
    await sameAtRest(page, 'two notches of the wheel out')
    await page.mouse.move(5, 5)
    await page.getByRole('button', { name: 'Zoom in', exact: true }).click()
    await frames(page, 4)
    await page.getByRole('button', { name: 'Zoom in', exact: true }).click()
    await glided(page)
    await sameAtRest(page, 'the zoom-in button, twice')
    await page.getByRole('button', { name: 'Zoom out', exact: true }).click()
    await glided(page)
    await sameAtRest(page, 'the zoom-out button')
    await page.keyboard.press('+')
    await glided(page)
    await sameAtRest(page, 'the + key')
    await page.keyboard.press('-')
    await glided(page)
    await sameAtRest(page, 'the - key')
  })

  test('a zoom that arrives at exactly 100% is drawn on the layer\'s own surface, as it will be at rest', async ({ page, app }) => {
    await held(page, app)
    for (let i = 0; i < 8; i++) { await pinch(page, -3); await frames(page) }
    await page.locator('.zoom-pct').click()
    await glided(page)
    const during = await view(page)
    expect(during.k).toBe(1)
    // At its natural size, drawn with the page on the page's opaque ground, text qualifies for subpixel antialiasing
    // where the screen has it on, which a layer with a surface of its own never gets: so at 100% the scene is on that
    // surface already, while the zoom is still under way, and what is on screen has no reason to change at rest
    expect(during.viewing).toBe(true)
    expect(during.zooming, 'not drawn with the page at 100%').toBe(false)
    expect(during.own).toBe(true)
    await sameAtRest(page, 'arriving at exactly 100%')
  })

  test('a pan in the same breath as a pinch is drawn the same way, and is the picture it comes to rest on', async ({ page, app }) => {
    await held(page, app)
    for (let i = 0; i < 10; i++) { await pinch(page, -3); await frames(page) }
    // two fingers sliding, straight after: a wheel event without Ctrl
    for (let i = 0; i < 10; i++) {
      await page.evaluate(([x, y]) => { document.querySelector('.canvas-surface')!.dispatchEvent(new WheelEvent('wheel', { clientX: x, clientY: y, deltaX: 7, deltaY: 4, wheelDeltaX: -21, wheelDeltaY: -12, bubbles: true, cancelable: true } as WheelEventInit)) }, [MID.x, MID.y] as const)
      await frames(page)
    }
    await frames(page, 2)
    await sameAtRest(page, 'a pinch, then a pan')
  })
})

test.describe('how a zoom is put on the screen', () => {
  test('the zoom asked for is on screen in the very next frame, and the layer is moved to it, never stretched', async ({ page, app }) => {
    await held(page, app)
    const k0 = (await view(page)).k
    let k = k0
    for (let i = 1; i <= 30; i++) {
      const dy = i <= 18 ? -2 : 3
      await pinch(page, dy)
      await frames(page)
      k *= Math.exp(-dy / 100)
      const v = await view(page)
      // not a frame behind, and not eased towards it: a pinch is followed exactly
      // (the page hands a style back to six figures)
      expect(v.k, `frame ${i}: the zoom written on the scene`).toBeCloseTo(k, 5)
      expect(v.onScreen, `frame ${i}: the zoom the browser draws the scene at`).toBeCloseTo(k, 5)
      // A layer the browser has already drawn, shown at another size, is a stretched picture. The layer only ever
      // carries a move, in whole pixels; the zoom is inside it, where a change means the shapes are drawn again
      expect(v.layer, `frame ${i}: the layer's own transform`).toMatch(/^translate\(-?\d+px, -?\d+px\)$/)
      expect(v.zoom, `frame ${i}`).toContain(`scale(`)
    }
  })

  test('the ground under the fingers stays under them, frame by frame, and lines stay on their components', async ({ page, app }) => {
    await held(page, app)
    // where the corner of a component and the two ends of the curved line that leaves it are drawn, in screen px
    const read = () => page.evaluate(() => {
      const at = (el: SVGGraphicsElement, x = 0, y = 0) => { const m = el.getScreenCTM()!; return [x * m.a + y * m.c + m.e, x * m.b + y * m.d + m.f] }
      const d = document.querySelector('[data-kind="node"][data-id="d"]') as SVGGElement
      const line = document.querySelector('.edge-hit[data-id="de"]') as SVGPathElement, p0 = line.getPointAtLength(0), p1 = line.getPointAtLength(line.getTotalLength())
      return { corner: at(d), from: at(line, p0.x, p0.y), to: at(line, p1.x, p1.y) }
    })
    const first = await read(), k0 = (await view(page)).onScreen
    // pinch about that corner: it is the one point that must not move at all
    const about = { x: first.corner[0], y: first.corner[1] }
    for (let i = 1; i <= 24; i++) {
      await pinch(page, i <= 12 ? -4 : 5, about)
      await frames(page)
      const now = await read(), k = (await view(page)).onScreen
      expect(Math.hypot(now.corner[0] - first.corner[0], now.corner[1] - first.corner[1]), `frame ${i}: how far the ground under the fingers has moved`).toBeLessThan(0.01)
      // everything else is where the zoom puts it: as far from that corner as it was, times the change of zoom
      for (const end of ['from', 'to'] as const) for (const axis of [0, 1]) {
        expect((now[end][axis] - now.corner[axis]) / k, `frame ${i}: the line's ${end} end`).toBeCloseTo((first[end][axis] - first.corner[axis]) / k0, 3)
      }
    }
  })

  test('handles and doors keep their size on screen on every frame of a zoom, not only once it has ended', async ({ page, app }) => {
    await keepFrames(page)
    await page.clock.install()
    await app.open(scene())
    await rested(page)
    await app.pick('a')
    await expect(page.locator('.door-dot').first()).toBeAttached()
    await page.clock.pauseAt(new Date(Date.now() + 2000))
    await frames(page, 2)
    const sizes = () => page.evaluate(() => [...document.querySelectorAll('.door-dot, rect[data-handle^="n"], [data-handle^="n"] rect')].map((el) => el.getBoundingClientRect().width))
    const first = await sizes()
    expect(first.length).toBeGreaterThan(4)
    for (let i = 1; i <= 20; i++) {
      await pinch(page, i <= 12 ? -5 : 6)
      await frames(page)
      const now = await sizes()
      expect(now.length).toBe(first.length)
      now.forEach((w, j) => expect(Math.abs(w - first[j]), `frame ${i}: mark ${j} is ${w} px wide, was ${first[j]}`).toBeLessThan(0.05))
    }
  })

  test('words are set out once and drawn at whatever the zoom makes of them: a name is as wide, in proportion, at every zoom', async ({ page, app }) => {
    await held(page, app)
    // looking straight down, so a name lies along the screen and its box is its length
    await page.keyboard.press('2')
    await page.clock.runFor(900)
    const words = () => page.evaluate(() => [...document.querySelectorAll<SVGTextElement>('.nd-label, .edge-caption')].map((t) => { const r = t.getBoundingClientRect(); return Math.hypot(r.width, r.height) }))
    const first = await words(), k0 = (await view(page)).onScreen
    expect(first.length).toBeGreaterThan(10)
    for (const dy of [-7, -7, -7, -7, 9, 9, 9, 9, 9, 9, 9]) {
      await pinch(page, dy)
      await frames(page)
      const now = await words(), k = (await view(page)).onScreen
      // letters laid out afresh for each size would drift by a few parts in a hundred as their spacing was rounded
      now.forEach((w, j) => expect(w / k / (first[j] / k0), `a name at ${(k * 100).toFixed(0)}%: its length against the zoom`).toBeCloseTo(1, 3))
    }
    await expect(page.locator('.nd-label').first()).toHaveCSS('text-rendering', 'geometricprecision')
  })

  test('nothing of the scene is drawn again by the app for a zoom while nothing on it is sized by the zoom', async ({ page, app }) => {
    await held(page, app)
    await page.evaluate(() => {
      const w = window as unknown as { __seen: number; __watch: MutationObserver }
      w.__seen = 0
      w.__watch = new MutationObserver((list) => { w.__seen += list.length })
      for (const el of document.querySelectorAll('.canvas-layer')) w.__watch.observe(el, { attributes: true, childList: true, subtree: true, characterData: true })
    })
    for (let i = 0; i < 20; i++) { await pinch(page, i < 10 ? -3 : 4); await frames(page) }
    // the browser draws every shape again at each new scale: that is its work, from shapes that have not changed
    expect(await page.evaluate(() => { const w = window as unknown as { __seen: number; __watch: MutationObserver }; return w.__seen + w.__watch.takeRecords().length }), 'changes made to the scene during a pinch').toBe(0)
  })
})

test.describe('on other pixels', () => {
  test('when the number of device pixels to the pixel changes, the scene is put on the new pixels', async ({ page, app }) => {
    await app.open(scene())
    await rested(page)
    // how far the view is from the layer's whole pixels: the part of a pixel that goes with the zoom
    const off = async () => { const m = /translate\(([-\d.e]+)px, ([-\d.e]+)px\)/.exec((await view(page)).zoom); return m ? [Number(m[1]), Number(m[2])] : [0, 0] }
    // A view that would sit differently on the two screens: more than a quarter of a pixel from a whole one, which is
    // nearer a half. A pinch leaves the view wherever it leaves it, so pinch until it is such a view
    for (let i = 0; i < 12; i++) {
      await pinch(page, i % 2 ? 3.7 : -5.3)
      await page.waitForTimeout(60)
      await rested(page)
      if ((await off()).some((v) => Math.abs(v) > 0.3)) break
    }
    const before = await view(page), was = await off()
    expect(was.some((v) => Math.abs(v) > 0.3), 'a view between pixels to start from').toBe(true)
    expect(before.layer).toMatch(/^translate\(-?\d+px, -?\d+px\)$/)
    const where = (v: View, f: number[]) => { const m = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(v.layer)!; return [Number(m[1]) + f[0], Number(m[2]) + f[1]] }
    // The browser's own zoom does this (the window is as wide, its pixels are not, so the page is a different width in
    // its own pixels), as does a window dragged to another screen: here, twice the device pixels and a pixel narrower
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1439, height: 900, deviceScaleFactor: 2, mobile: false })
    await expect.poll(() => page.evaluate(() => devicePixelRatio)).toBe(2)
    // on whole device pixels again, which here are halves, and so never more than a quarter of a pixel from the view
    await expect.poll(async () => Math.max(...(await off()).map(Math.abs))).toBeLessThanOrEqual(0.2501)
    const after = await view(page), now = await off()
    expect(after.layer).toMatch(/^translate\(-?\d+(\.5)?px, -?\d+(\.5)?px\)$/)
    // and it is the same view: nothing has moved on the glass
    where(after, now).forEach((v, i) => expect(v).toBeCloseTo(where(before, was)[i], 4))
    expect(after.k).toBe(before.k)
  })
})

test.describe('on a screen with two device pixels to the pixel', () => {
  test.use({ deviceScaleFactor: 2 })
  test('a pinch is the picture it comes to rest on there too, at the screen\'s own resolution', async ({ page, app }) => {
    await held(page, app)
    for (const [what, dy, n] of [['a pinch in at 2x', -3, 18], ['a pinch out at 2x', 4, 20]] as const) {
      for (let i = 0; i < n; i++) { await pinch(page, dy); await frames(page) }
      await frames(page, 2)
      const v = await sameAtRest(page, what)
      // whole device pixels, which at 2x are halves of a CSS pixel
      expect(v.layer).toMatch(/^translate\(-?\d+(\.5)?px, -?\d+(\.5)?px\)$/)
    }
    // the photograph is at the screen's resolution, not the page's
    expect(decode(await page.screenshot({ clip: CLEAR })).w).toBe(CLEAR.width * 2)
  })
})
