import type { CDPSession, Page } from '@playwright/test'

export interface P { x: number; y: number }

/**
 * Fingers for tests. Every position is in screen pixels.
 *
 * With `real` (Chromium only) the touches go through the browser's own input pipeline, over the DevTools
 * protocol: the same path a phone's screen takes. Gesture conflicts with scrolling and zooming are exercised for
 * real, the browser turns a tap into a click itself, and positions arrive in whole pixels as a finger's do.
 *
 * Other engines have no such hook, so there the pointer events are made in the page and dispatched directly.
 * That reaches the app's own pointer handling and nothing else: the browser does not scroll, zoom or click in
 * answer to them. Tests that need any of that skip themselves unless the browser is Chromium.
 */
export class Fingers {
  private cdp?: CDPSession
  constructor(readonly page: Page, readonly real: boolean) {}

  /**
   * One change to the fingers on the glass. `points` is every finger that is down after it, in the order they came
   * down (a finger is known by its place in the list). `touchEnd` takes an empty list and lifts them all.
   */
  private async send(type: 'touchStart' | 'touchMove' | 'touchEnd', points: P[]) {
    if (this.real) {
      this.cdp ??= await this.page.context().newCDPSession(this.page)
      await this.cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map((p, id) => ({ x: Math.round(p.x), y: Math.round(p.y), id })) })
      return
    }
    await this.page.evaluate(([t, pts]) => {
      const w = window as any
      w.__held ??= []
      const kind = t === 'touchStart' ? 'pointerdown' : t === 'touchMove' ? 'pointermove' : 'pointerup'
      const list: P[] = t === 'touchEnd' ? w.__held : (pts as P[])
      list.forEach((p: P, i: number) => {
        // a finger that is already down is not pressed again when another joins it
        if (t === 'touchStart' && w.__held[i]) return
        // moves and the lift go to whatever was under the finger when it came down, as a browser sends them for touch
        const el = t === 'touchStart' ? document.elementFromPoint(p.x, p.y) : w.__target?.[i]
        w.__target ??= []
        if (t === 'touchStart') w.__target[i] = el
        el?.dispatchEvent(new PointerEvent(kind, { pointerId: 20 + i, pointerType: 'touch', isPrimary: i === 0, clientX: p.x, clientY: p.y, bubbles: true, cancelable: true, button: 0, buttons: kind === 'pointerup' ? 0 : 1 }))
      })
      w.__held = t === 'touchEnd' ? [] : pts
      type P = { x: number; y: number }
    }, [type, points] as const)
  }

  /** Down and straight up in one place. The fallback asks for the click itself, since pointer events made in the page do not raise one. */
  async tap(p: P) {
    await this.send('touchStart', [p])
    await this.send('touchEnd', [])
    if (!this.real) await this.page.evaluate((q) => (document.elementFromPoint(q.x, q.y) as HTMLElement | null)?.click(), p)
  }

  /**
   * One finger from `from` to `to`, a move every 12 ms. `hold` rests it first for that many ms: longer than the
   * app's `HOLD_MS` (420) counts as press-and-hold. `flick` lifts it while it is still moving.
   */
  async drag(from: P, to: P, o: { hold?: number; steps?: number; flick?: boolean } = {}) {
    const steps = o.steps ?? 8
    await this.send('touchStart', [from])
    if (o.hold) await this.page.waitForTimeout(o.hold)
    for (let i = 1; i <= steps; i++) {
      await this.send('touchMove', [{ x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps }])
      await this.page.waitForTimeout(12)
    }
    // a finger that pauses before lifting leaves the view where it is; one that does not is a flick
    // (the app only lets the view coast when the lift comes within 60 ms of the last move)
    if (!o.flick) await this.page.waitForTimeout(110)
    await this.send('touchEnd', [])
  }

  /** A finger down at `p` for `ms`, then up, without moving. */
  async press(p: P, ms: number) {
    await this.send('touchStart', [p])
    await this.page.waitForTimeout(ms)
    await this.send('touchEnd', [])
  }

  /**
   * Two fingers. They start `from` pixels apart around `at`, and end `to` pixels apart around `at + shift`, turned
   * by `twist` degrees along the way (positive is clockwise on screen). They come down one after the other.
   */
  async pinch(at: P, from: number, to: number, o: { shift?: P; twist?: number; steps?: number } = {}) {
    const steps = o.steps ?? 10, shift = o.shift ?? { x: 0, y: 0 }, twist = ((o.twist ?? 0) * Math.PI) / 180
    const pair = (t: number): P[] => {
      const d = (from + (to - from) * t) / 2, a = twist * t, cx = at.x + shift.x * t, cy = at.y + shift.y * t
      return [{ x: cx - Math.cos(a) * d, y: cy - Math.sin(a) * d }, { x: cx + Math.cos(a) * d, y: cy + Math.sin(a) * d }]
    }
    await this.send('touchStart', [pair(0)[0]])
    await this.send('touchStart', pair(0))
    for (let i = 1; i <= steps; i++) { await this.send('touchMove', pair(i / steps)); await this.page.waitForTimeout(12) }
    await this.send('touchEnd', [])
  }

  /** Two fingers down and straight back up. */
  async twoTap(a: P, b: P) {
    await this.send('touchStart', [a])
    await this.send('touchStart', [a, b])
    await this.send('touchEnd', [])
  }

  /** Two quick taps in one place; with `slide`, the second stays down and travels that far down the screen before lifting. */
  async doubleTap(p: P, slide = 0) {
    await this.send('touchStart', [p])
    await this.send('touchEnd', [])
    await this.page.waitForTimeout(60)
    await this.send('touchStart', [p])
    const steps = slide ? 10 : 0
    for (let i = 1; i <= steps; i++) { await this.send('touchMove', [{ x: p.x, y: p.y + (slide * i) / steps }]); await this.page.waitForTimeout(12) }
    await this.send('touchEnd', [])
  }

  /** Put one finger down and leave it there; follow with `move` and `lift`. */
  async down(p: P) { await this.send('touchStart', [p]) }
  /** Lifts every finger that is down, not just one. */
  async lift() { await this.send('touchEnd', []) }
  async move(p: P) { await this.send('touchMove', [p]) }
}
