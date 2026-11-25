import type { CDPSession, Page } from '@playwright/test'
import { expect, makeDoc, rested, test } from './fixtures'
import { decode, difference, sharpness } from './pixels'

/**
 * Sharp at every frame of a pinch with two fingers, on every phone project: the same check as sharp.spec.ts makes for
 * the wheel and the trackpad, with real touches (Chrome's own input pipeline) on a screen with two to three device
 * pixels to the pixel. The frame photographed while the fingers are still on the glass must be the picture that is
 * left once they have lifted and the view has come to rest.
 */
const edge = (id: string, from: string, to: string, extra: Record<string, unknown> = {}) => ({ id, from, to, style: 'solid', arrow: 'end', width: 2, ...extra }) as any
const scene = () => makeDoc(
  [
    { id: 'a', type: 'ec2', x: 0, y: 0, name: 'web-1' }, { id: 'b', type: 'rds', x: 6, y: 0, name: 'orders-db' }, { id: 'c', type: 's3', x: 0, y: 6, name: 'assets' },
    { id: 'd', type: 'sqs', x: 6, y: 6, name: 'jobs' }, { id: 'e', type: 'lambda', x: 3, y: 12, name: 'resize' },
  ],
  { edges: [edge('ab', 'a', 'b', { label: 'sql' }), edge('ac', 'a', 'c', { style: 'dashed' }), edge('bd', 'b', 'd', { shape: 'curved' }), edge('cd', 'c', 'd'), edge('de', 'd', 'e', { shape: 'curved', label: 'https' })] },
)
const FRAME = 17
const frames = async (page: Page, n = 1) => { for (let i = 0; i < n; i++) await page.clock.runFor(FRAME) }
const viewing = (page: Page) => page.evaluate(() => document.querySelector('.canvas-wrap')!.hasAttribute('data-viewing'))
const zoomOf = (page: Page) => page.evaluate(() => (document.querySelector('.canvas-layer.top > g') as SVGGElement).getScreenCTM()!.a)
/** What is on the screen once the browser has finished drawing what the page now holds: photographs taken until two running are the same (see sharp.spec.ts). */
async function shown(page: Page, clip: { x: number; y: number; width: number; height: number }) {
  // three of the browser's own frames first (kept from the clock: see `keepFrames` in sharp.spec.ts), by which whatever the page held is drawn
  await page.evaluate(() => new Promise<void>((done) => { const frame = (window as unknown as { __frame: typeof requestAnimationFrame }).__frame; frame(() => frame(() => frame(() => done()))) }))
  let last = await page.screenshot({ clip })
  for (let i = 0; i < 25; i++) {
    await page.waitForTimeout(50)
    const next = await page.screenshot({ clip })
    if (next.equals(last)) return decode(next)
    last = next
  }
  throw new Error('what is on the screen never stopped changing')
}

test.describe('phone: sharp at every frame of a pinch', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'real touches, and photographs of the compositor, need Chrome')

  test('two fingers moving apart, then together: the frame under the fingers is the picture left when they lift', async ({ page, app }) => {
    await page.addInitScript(() => { (window as unknown as { __frame: typeof requestAnimationFrame }).__frame = window.requestAnimationFrame.bind(window) })
    await page.clock.install()
    await app.open(scene())
    // the dots that run along the lines move by themselves: drawn here, but held still (under a finger the canvas is always layered, and they have a surface of their own)
    await page.addStyleTag({ content: '.edge-flow { animation: none !important }' })
    await rested(page)
    await page.clock.pauseAt(new Date(Date.now() + 2000))
    await frames(page, 2)

    const vp = page.viewportSize()!
    // the middle of the canvas, clear of the bar above and the dock below (and of the edges, where a thumb's controls sit)
    const clip = { x: Math.round(vp.width * 0.12), y: Math.round(vp.height * 0.26), width: Math.round(vp.width * 0.76), height: Math.round(vp.height * 0.38) }
    const mid = { x: Math.round(vp.width / 2), y: Math.round(vp.height * 0.45) }
    const cdp: CDPSession = await page.context().newCDPSession(page)
    // two fingers level with each other, `apart` px either side of the middle: level, so nothing reads as a twist
    // Chrome hands a touch to the page with its next frame, not as it is sent: each one is waited for (both fingers'
    // worth) before the clock is moved on, or the page would be a move behind the fingers all the way
    await page.evaluate(() => {
      const w = window as unknown as { __touches: number }
      w.__touches = 0
      for (const kind of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) window.addEventListener(kind, (e) => { if ((e as PointerEvent).pointerType === 'touch') w.__touches++ }, true)
    })
    const heard = () => page.evaluate(() => (window as unknown as { __touches: number }).__touches)
    const touch = async (type: 'touchStart' | 'touchMove' | 'touchEnd', apart?: number) => {
      const before = await heard()
      await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: apart === undefined ? [] : [{ x: mid.x - apart, y: mid.y, id: 0 }, { x: mid.x + apart, y: mid.y, id: 1 }] })
      await expect.poll(heard, { intervals: [5, 10, 20, 40] }).toBeGreaterThanOrEqual(before + 2)
    }

    for (const [what, from, to] of [['fingers moving apart', 40, 92], ['fingers moving together', 96, 50]] as const) {
      const before = await zoomOf(page)
      await touch('touchStart', from)
      await frames(page)
      for (let i = 1; i <= 14; i++) { await touch('touchMove', from + ((to - from) * i) / 14); await frames(page) }
      await frames(page, 2)
      expect(await viewing(page), `${what}: still under way, fingers down`).toBe(true)
      // (not quite the whole of it: a pinch is counted from where the fingers were once they were seen to be pinching)
      const went = (await zoomOf(page)) / before
      expect(to > from ? went : 1 / went, `${what}: the view has gone with the fingers, by ${went.toFixed(2)} times`).toBeGreaterThan(1.5)
      const placed = () => page.evaluate(() => document.querySelector<HTMLElement>('.canvas-pan')!.style.transform + ' ' + document.querySelector<HTMLElement>('.canvas-zoom')!.style.transform + ' ' + (document.querySelector('[data-kind="node"]') as SVGGElement).getAttribute('transform'))
      const during = await placed()
      const first = decode(await page.screenshot({ clip }))
      const a = await shown(page, clip)
      expect(await viewing(page), `${what}: still under way once photographed`).toBe(true)
      // the fingers rest a moment before they lift, so the view does not coast on; then it comes to rest
      await frames(page, 4)
      await touch('touchEnd')
      await page.clock.runFor(500)
      expect(await viewing(page), `${what}: at rest`).toBe(false)
      // lifting the fingers moves nothing: where they left the view is where it stays
      expect(await placed(), `${what}: nothing moves when the fingers lift`).toBe(during)
      const b = await shown(page, clip)
      // even a frame the browser was behind on was drawn at its own size: nothing soft on the way
      expect(sharpness(first) / sharpness(b), `${what}: fine detail at first sight, as a share of that at rest`).toBeGreaterThan(0.9)
      const d = difference(a, b), detail = sharpness(a) / sharpness(b)
      test.info().annotations.push({ type: what, description: `${d.over8} of ${d.pixels} pixels differ by more than 8/255 (${d.over32} by more than 32, worst ${d.worst}); fine detail under the fingers is ${(detail * 100).toFixed(1)}% of that at rest` })
      expect(d.over32 / d.pixels, `${what}: share of pixels that differ plainly between the frame under the fingers and the frame at rest`).toBeLessThan(0.0005)
      expect(detail, `${what}: fine detail under the fingers, as a share of that at rest`).toBeGreaterThan(0.97)
      expect(detail, `${what}: fine detail under the fingers, as a share of that at rest`).toBeLessThan(1.03)
    }
    // photographed at the screen's own resolution: more than one device pixel to the pixel on every phone here
    expect(decode(await page.screenshot({ clip })).w).toBeGreaterThan(clip.width)
  })
})
