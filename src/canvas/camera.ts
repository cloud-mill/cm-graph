import { ISO_PITCH, ISO_YAW, MAX_PITCH, MIN_PITCH, type Proj, easeInOut, makeCam, normYaw, pt, unproject } from '../core/iso'
import { type View, useStore } from '../core/store'
import { sceneBounds } from './Scene'

/** Canvas viewport size in CSS px, kept current by <Canvas/>. */
export const cam = { w: 1200, h: 800, left: 0, top: 0 }

/** Live cursor read-out; the canvas writes straight to this element to avoid re-rendering on every move. */
export const hud: { el: HTMLElement | null } = { el: null }

/** Space taken by the floating panels on each side of the canvas. */
export function insets() {
  const s = useStore.getState()
  const narrow = cam.w < 760
  return { l: s.showLib && !narrow ? 268 : 20, r: s.showInsp && !narrow ? 348 : 20, t: 68, b: 88 }
}
/** Centre of the canvas area that is not covered by panels. */
export function center(): [number, number] {
  const i = insets()
  return [i.l + (cam.w - i.l - i.r) / 2, i.t + (cam.h - i.t - i.b) / 2]
}

export const projNow = (): Proj => {
  const s = useStore.getState()
  return makeCam(s.yaw, s.pitch)
}

let raf = 0
export function animateView(to: View, ms = 420) {
  cancelAnimationFrame(raf)
  cancelAnimationFrame(orbitRaf)
  orbitActive = false
  const from = useStore.getState().view
  const t0 = performance.now()
  const step = (now: number) => {
    const t = Math.min(1, (now - t0) / ms)
    const e = easeInOut(t)
    // land exactly on the target: the eased sum can be a hair off
    useStore.setState({ view: t < 1 ? { x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e, k: from.k + (to.k - from.k) * e } : { ...to } })
    if (t < 1) raf = requestAnimationFrame(step)
  }
  raf = requestAnimationFrame(step)
}

/** Frame the whole diagram, or just the given nodes, from the current camera angle. */
export function fitView(ids?: string[], animate = true, maxK = 1.25) {
  // a fit requested mid-turn waits for the camera to settle, so the turn is never cut short
  if (orbitActive && animate) { pendingFit = [ids, maxK]; return }
  const s = useStore.getState()
  const doc = ids?.length ? { ...s.doc, nodes: s.doc.nodes.filter((n) => ids.includes(n.id)), areas: [], labels: [] } : s.doc
  const b = sceneBounds(doc, projNow(), ids?.length ? 140 : 70)
  const i = insets()
  const w = Math.max(100, cam.w - i.l - i.r - 40), h = Math.max(100, cam.h - i.t - i.b - 20)
  const [cx, cy] = center()
  const k = Math.max(0.2, Math.min(maxK, w / b.w, h / b.h))
  const to = { k, x: cx - (b.x + b.w / 2) * k, y: cy - (b.y + b.h / 2) * k }
  if (animate) animateView(to)
  else useStore.setState({ view: to })
}

export function zoomBy(factor: number, cx = center()[0], cy = center()[1]) {
  const { view } = useStore.getState()
  const k = Math.max(0.15, Math.min(4, view.k * factor))
  return { k, x: cx - ((cx - view.x) * k) / view.k, y: cy - ((cy - view.y) * k) / view.k }
}

// ---- orbit ------------------------------------------------------------------

const clampPitch = (p: number) => Math.max(MIN_PITCH, Math.min(MAX_PITCH, p))

/** Ground point currently under a viewport position (defaults to the centre). */
export function groundAt(sx = center()[0], sy = center()[1]): [number, number] {
  const s = useStore.getState()
  return unproject(projNow(), (sx - s.view.x) / s.view.k, (sy - s.view.y) / s.view.k)
}

/** Set the camera angle while keeping world point `pivot` pinned to viewport position `at`. */
function setCam(yaw: number, pitch: number, pivot: [number, number], at: [number, number]) {
  const p = clampPitch(pitch)
  const q = pt(makeCam(yaw, p), pivot[0], pivot[1])
  const k = useStore.getState().view.k
  useStore.setState({ yaw, pitch: p, flat: p >= 89.5, view: { k, x: at[0] - q[0] * k, y: at[1] - q[1] * k } })
}

export const ORBIT_SPEED = 0.35 // degrees per pixel

/**
 * Start an interactive orbit. Returns an updater taking the pointer's total
 * travel; the ground point under (sx, sy) stays put, like grabbing the scene.
 */
export function beginOrbit(sx = center()[0], sy = center()[1]) {
  cancelAnimationFrame(orbitRaf)
  orbitActive = false
  pendingFit = null
  cancelAnimationFrame(raf)
  const s = useStore.getState()
  const yaw0 = s.yaw, pitch0 = s.pitch
  const pivot = groundAt(sx, sy)
  return (dx: number, dy: number) => setCam(yaw0 - dx * ORBIT_SPEED, pitch0 + dy * ORBIT_SPEED, pivot, [sx, sy])
}

let orbitRaf = 0
let orbitActive = false
let pendingFit: [string[] | undefined, number] | null = null
/** Animate to a camera angle along the shortest turn, pivoting on the viewport centre. */
export function orbitTo(yaw: number, pitch: number, ms = 560) {
  cancelAnimationFrame(orbitRaf)
  cancelAnimationFrame(raf)
  const s = useStore.getState()
  const y0 = s.yaw, p0 = s.pitch
  const dy = ((yaw - y0 + 540) % 360 + 360) % 360 - 180
  const dp = clampPitch(pitch) - p0
  const pivot = groundAt()
  const at = center()
  orbitActive = true
  const t0 = performance.now()
  const step = (now: number) => {
    const t = Math.min(1, (now - t0) / ms)
    const e = easeInOut(t)
    setCam(t < 1 ? y0 + dy * e : normYaw(y0 + dy), p0 + dp * e, pivot, at)
    if (t < 1) { orbitRaf = requestAnimationFrame(step); return }
    orbitActive = false
    if (pendingFit) { const [ids, maxK] = pendingFit; pendingFit = null; fitView(ids, true, maxK) }
  }
  orbitRaf = requestAnimationFrame(step)
}

/** Turn the scene by a quarter (or any angle), snapping onto the 45° grid of views. */
export function turn(deg: number) {
  const s = useStore.getState()
  const target = Math.round((s.yaw + deg) / 45) * 45
  orbitTo(target, s.pitch, 420)
}

export const viewHome = () => orbitTo(ISO_YAW, ISO_PITCH)
export const viewTop = () => orbitTo(Math.round(useStore.getState().yaw / 90) * 90, 90)
/** Plan view (true) or the home isometric view (false). */
export const setFlat = (flat: boolean) => (flat ? orbitTo(0, 90) : viewHome())

// ---- eased wheel zoom ---------------------------------------------------------
let zoomRaf = 0
let zoomTarget = 0
let zoomAt: [number, number] = [0, 0]
/** Wheel notches glide to their target instead of jumping; the point under the cursor stays put. */
export function smoothZoom(factor: number, cx: number, cy: number) {
  const s = useStore.getState()
  cancelAnimationFrame(raf)
  if (!zoomRaf) zoomTarget = s.view.k
  zoomTarget = Math.max(0.15, Math.min(4, zoomTarget * factor))
  zoomAt = [cx, cy]
  if (zoomRaf) return
  const step = () => {
    const { view } = useStore.getState()
    const diff = zoomTarget - view.k
    const done = Math.abs(diff) < view.k * 0.002
    const k = done ? zoomTarget : view.k + diff * 0.24
    useStore.setState({ view: { k, x: zoomAt[0] - ((zoomAt[0] - view.x) * k) / view.k, y: zoomAt[1] - ((zoomAt[1] - view.y) * k) / view.k } })
    zoomRaf = done ? 0 : requestAnimationFrame(step)
  }
  zoomRaf = requestAnimationFrame(step)
}
