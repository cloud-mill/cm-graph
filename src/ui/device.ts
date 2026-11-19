import { useSyncExternalStore } from 'react'

/**
 * What kind of device this is, decided once and kept in step with the window.
 *
 * "Phone" is about room, not about touch: a narrow window, or a short one held
 * sideways. It switches the editor to its one-handed layout. Touch gestures on
 * the canvas are separate and follow the pointer that is actually used, so a
 * tablet or a touch laptop gets them too.
 */
const PHONE = '(max-width: 760px), (max-height: 520px) and (pointer: coarse)'

const mq = () => (typeof matchMedia === 'undefined' ? null : matchMedia(PHONE))

export const isPhone = () => !!mq()?.matches

const subscribe = (cb: () => void) => {
  const m = mq()
  m?.addEventListener?.('change', cb)
  return () => m?.removeEventListener?.('change', cb)
}

export const usePhone = () => useSyncExternalStore(subscribe, isPhone, () => false)

/** A short tick under the finger where the device can give one. Never throws, never required. */
export function haptic(ms = 8) {
  try { navigator.vibrate?.(ms) } catch { /* not allowed here: fine */ }
}

/**
 * Keep the layout honest about the space the browser really gives us.
 *
 * Phones cover part of the page with the on-screen keyboard without telling the
 * layout; `--kb` is how much is covered, so sheets can sit on top of the
 * keyboard instead of under it. Also marks the document as a phone for CSS.
 */
export function watchViewport(root: HTMLElement = document.documentElement) {
  const vv = window.visualViewport
  const sync = () => {
    const covered = vv ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop) : 0
    // small differences are the browser's own bars sliding, not a keyboard
    root.style.setProperty('--kb', (covered > 80 ? Math.round(covered) : 0) + 'px')
    root.toggleAttribute('data-kb', covered > 80)
    root.toggleAttribute('data-phone', isPhone())
  }
  sync()
  vv?.addEventListener('resize', sync)
  vv?.addEventListener('scroll', sync)
  window.addEventListener('resize', sync)
  window.addEventListener('orientationchange', sync)
  // Safari zooms the whole page on a two-finger pinch even where touch-action forbids it
  const stop = (e: Event) => e.preventDefault()
  document.addEventListener('gesturestart', stop)
  return () => {
    vv?.removeEventListener('resize', sync); vv?.removeEventListener('scroll', sync)
    window.removeEventListener('resize', sync); window.removeEventListener('orientationchange', sync)
    document.removeEventListener('gesturestart', stop)
  }
}

/**
 * Make sure a finger tap on a button always counts.
 *
 * After a flick, a browser treats the next touch as "stop the scrolling" and
 * swallows its click, even when that touch is on a button nowhere near what was
 * flicked. Here the view coasts under our own control, so that rule only loses
 * taps. If a finger goes down and up on the same control and no click arrives,
 * the click is delivered for it; if the browser's own click turns up late, it is dropped.
 */
export function sureTaps(doc: Document = document) {
  const CONTROL = 'button, a[href], [role="button"]'
  const at = (e: Event) => (e.target instanceof Element ? e.target.closest(CONTROL) : null)
  let down: { el: Element; x: number; y: number; t: number } | null = null
  let wait: ReturnType<typeof setTimeout> | undefined
  let made: { el: Element; t: number } | null = null
  let ours = false
  const onDown = (e: PointerEvent) => {
    const el = e.pointerType === 'touch' && e.isPrimary !== false ? at(e) : null
    down = el ? { el, x: e.clientX, y: e.clientY, t: performance.now() } : null
  }
  const onUp = (e: PointerEvent) => {
    const d = down
    down = null
    if (!d || e.pointerType !== 'touch' || at(e) !== d.el) return
    // a finger that travelled was dragging, and one that rested was holding: neither is a tap
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 12 || performance.now() - d.t > 700) return
    clearTimeout(wait)
    wait = setTimeout(() => { made = { el: d.el, t: performance.now() }; ours = true; try { (d.el as HTMLElement).click() } finally { ours = false } }, 90)
  }
  const onCancel = () => { down = null }
  const onClick = (e: MouseEvent) => {
    if (ours) return
    clearTimeout(wait)
    // the browser's click, arriving after ours already did the job
    if (made && at(e) === made.el && performance.now() - made.t < 600) { e.stopPropagation(); e.preventDefault() }
    made = null
  }
  doc.addEventListener('pointerdown', onDown, true)
  doc.addEventListener('pointerup', onUp, true)
  doc.addEventListener('pointercancel', onCancel, true)
  doc.addEventListener('click', onClick, true)
  return () => {
    clearTimeout(wait)
    doc.removeEventListener('pointerdown', onDown, true); doc.removeEventListener('pointerup', onUp, true)
    doc.removeEventListener('pointercancel', onCancel, true); doc.removeEventListener('click', onClick, true)
  }
}
