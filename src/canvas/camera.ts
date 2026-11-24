import { ISO_PITCH, ISO_YAW, MAX_PITCH, MIN_PITCH, type Proj, easeInOut, makeCam, normYaw, pt, unproject } from '../core/iso'
import { type View, useStore } from '../core/store'
import { sceneBounds } from './Scene'
import { MAX_K, MIN_K } from './touch'

/**
 * The camera: where the view is (`view`: pan in px and zoom), which way it looks (`yaw`, `pitch`, in degrees), and every
 * animation that moves either. All of it lives in the store; this module only writes it, a frame at a time.
 *
 * Positions taken and returned here are px from the canvas's top-left corner unless they are ground cells. A ground point
 * `g` is drawn at `pt(proj, g) * view.k + view`, so keeping a point still under a finger or the cursor while the zoom or the
 * angle changes means solving that for the pan: `setCam`, `zoomBy` and `smoothZoom` all do exactly this.
 *
 * The animations (glide, view, orbit, eased zoom) each hold one frame request in a module variable. There is one canvas, so
 * one of each is enough. Starting one cancels some of the others; `holdStill` stops them all.
 */
/** Canvas viewport size in CSS px and its corner in client px, kept current by <Canvas/>. Until it has been measured it holds a stand-in, 1200 by 800. */
export const cam = { w: 1200, h: 800, left: 0, top: 0 }

/** Live cursor read-out; the canvas writes straight to this element to avoid re-rendering on every move. */
export const hud: { el: HTMLElement | null } = { el: null }

/** Canvas covered by a phone sheet, kept current by <Sheet/>: from the bottom edge upright, from the right edge sideways. */
export const chrome = { bottom: 0, right: 0 }

/** Space taken by the floating panels on each side of the canvas, in px. Fits, centring and edge-following all keep to what is left. */
export function insets() {
  const s = useStore.getState()
  const narrow = cam.w < 760 || cam.h < 520
  // on a phone the dock sits along the bottom, and an open sheet covers more still
  if (narrow) return { l: 14, r: Math.max(14, chrome.right + 14), t: 64, b: Math.max(cam.h < 520 ? 84 : 112, chrome.bottom + 16) }
  return { l: s.showLib ? 268 : 20, r: s.showInsp ? 348 : 20, t: 68, b: 88 }
}
/** Centre of the canvas area that is not covered by panels. */
export function center(): [number, number] {
  const i = insets()
  return [i.l + (cam.w - i.l - i.r) / 2, i.t + (cam.h - i.t - i.b) / 2]
}

/** The projection for the camera angle in the store right now, for code that runs outside a render and so has no `proj` of its own. */
export const projNow = (): Proj => {
  const s = useStore.getState()
  return makeCam(s.yaw, s.pitch)
}

// ---- one update per frame ---------------------------------------------------------
let frameJob: (() => void) | null = null
let frameRaf = 0
/** Run `job` before the next paint. A newer job replaces one still waiting, so several finger reports in a frame cost one redraw. */
export function onFrame(job: () => void) {
  frameJob = job
  if (!frameRaf) frameRaf = requestAnimationFrame(flushFrame)
}
/** Run the waiting update now. */
export function flushFrame() {
  cancelAnimationFrame(frameRaf)
  frameRaf = 0
  const job = frameJob
  frameJob = null
  job?.()
}

// ---- momentum ---------------------------------------------------------------------
let glideRaf = 0
/** Let a flicked pan coast to a stop. Speeds are px per ms. */
export function glide(vx: number, vy: number) {
  cancelAnimationFrame(glideRaf)
  let last = performance.now()
  const step = (now: number) => {
    const dt = Math.min(48, now - last)
    last = now
    const { view } = useStore.getState()
    useStore.setState({ view: { ...view, x: view.x + vx * dt, y: view.y + vy * dt } })
    const slow = Math.exp(-dt / 280)
    vx *= slow; vy *= slow
    glideRaf = Math.hypot(vx, vy) > 0.02 ? requestAnimationFrame(step) : 0
  }
  glideRaf = requestAnimationFrame(step)
}
/** Stop every camera movement in flight: a finger on the glass always wins. */
export function holdStill() {
  heading = null
  cancelAnimationFrame(glideRaf); glideRaf = 0
  cancelAnimationFrame(raf)
  cancelAnimationFrame(orbitRaf)
  cancelAnimationFrame(zoomRaf); zoomRaf = 0
  orbitActive = false
  pendingFit = null
}

let raf = 0
let heading: View | null = null
/** Where a view animation in flight will end, or null when the view is at rest (or under a finger). */
export const headedTo = () => heading
/** Ease the view (pan and zoom) to `to`. Takes over from a view animation, a glide or a turn already in flight. */
export function animateView(to: View, ms = 420) {
  cancelAnimationFrame(raf)
  // a wheel zoom still easing would go on setting the view against this one
  stopZoom()
  heading = to
  cancelAnimationFrame(glideRaf); glideRaf = 0
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
    else heading = null
  }
  raf = requestAnimationFrame(step)
}

/**
 * Frame the whole diagram, or just the given nodes, from the current camera angle, in the part of the canvas the panels
 * leave clear. `maxK` is the most it will zoom in to do so, so a small diagram is not blown up to fill the screen.
 */
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

/**
 * The view zoomed by `factor` about canvas position (cx, cy), which keeps what is under that position where it is.
 * Only works it out: the caller sets it, or animates to it. The zoom stays within 0.15 to 4.
 */
export function zoomBy(factor: number, cx = center()[0], cy = center()[1]) {
  const { view } = useStore.getState()
  const k = Math.max(MIN_K, Math.min(MAX_K, view.k * factor))
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
  heading = null
  cancelAnimationFrame(orbitRaf)
  orbitActive = false
  pendingFit = null
  cancelAnimationFrame(raf)
  cancelAnimationFrame(glideRaf); glideRaf = 0
  const s = useStore.getState()
  const yaw0 = s.yaw, pitch0 = s.pitch
  const pivot = groundAt(sx, sy)
  return (dx: number, dy: number) => setCam(yaw0 - dx * ORBIT_SPEED, pitch0 + dy * ORBIT_SPEED, pivot, [sx, sy])
}

let orbitRaf = 0
// an animated turn is in flight, and the fit that asked to run once it has landed (`fitView` puts it here)
let orbitActive = false
let pendingFit: [string[] | undefined, number] | null = null
/** Animate to a camera angle along the shortest turn, pivoting on the viewport centre. */
export function orbitTo(yaw: number, pitch: number, ms = 560) {
  heading = null
  cancelAnimationFrame(orbitRaf)
  cancelAnimationFrame(raf)
  cancelAnimationFrame(glideRaf); glideRaf = 0
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

/** Back to the home isometric angle. */
export const viewHome = () => orbitTo(ISO_YAW, ISO_PITCH)
/** Straight down, squared up to the nearest quarter turn. */
export const viewTop = () => orbitTo(Math.round(useStore.getState().yaw / 90) * 90, 90)
/** Plan view (true) or the home isometric view (false). */
export const setFlat = (flat: boolean) => (flat ? orbitTo(0, 90) : viewHome())
/** Is the camera somewhere other than the home view, or a square-on plan view? */
export function isTurned(yaw: number, pitch: number) {
  if (pitch >= 89.5) { const m = ((yaw % 90) + 90) % 90; return Math.min(m, 90 - m) > 0.5 }
  return Math.abs(normYaw(yaw) - ISO_YAW) > 0.5 || Math.abs(pitch - ISO_PITCH) > 0.5
}
/** Back to a familiar angle with everything in frame, wherever the camera has wandered. */
export function recover() {
  const s = useStore.getState()
  if (isTurned(s.yaw, s.pitch)) viewHome()
  fitView()
}
/**
 * Slide the view, at the zoom it has, so the given components sit in the part of
 * the canvas that is not covered. Does nothing when they already do. Returns
 * where the view is headed, or null when it stays put.
 */
export function reveal(ids: string[]): View | null {
  const s = useStore.getState()
  const nodes = s.doc.nodes.filter((n) => ids.includes(n.id))
  if (!nodes.length) return null
  const b = sceneBounds({ ...s.doc, nodes, areas: [], labels: [] }, projNow(), 0), v = s.view, i = insets()
  const x0 = b.x * v.k + v.x, x1 = (b.x + b.w) * v.k + v.x, y0 = b.y * v.k + v.y, y1 = (b.y + b.h) * v.k + v.y
  if (x0 >= i.l && x1 <= cam.w - i.r && y0 >= i.t && y1 <= cam.h - i.b) return null
  const [cx, cy] = center()
  const to = { k: v.k, x: cx - (b.x + b.w / 2) * v.k, y: cy - (b.y + b.h / 2) * v.k }
  animateView(to)
  return to
}

/** Can any of the diagram be seen in the part of the canvas that is not covered? */
export function inSight() {
  const s = useStore.getState()
  if (!s.doc.nodes.length && !s.doc.areas.length && !s.doc.labels.length) return true
  const b = sceneBounds(s.doc, projNow(), 0), v = s.view, i = insets()
  return b.x * v.k + v.x < cam.w - i.r && (b.x + b.w) * v.k + v.x > i.l && b.y * v.k + v.y < cam.h - i.b && (b.y + b.h) * v.k + v.y > i.t
}

// ---- eased wheel zoom ---------------------------------------------------------
let zoomRaf = 0
let zoomLast = 0
// the zoom the notches so far add up to: each new one builds on this, not on wherever the easing has got to
let zoomTarget = 0
let zoomAt: [number, number] = [0, 0]
/**
 * How quickly an eased zoom closes on its target, as a time constant in ms. Two thirds of the way in the first two frames
 * and there, to the eye, within a tenth of a second: long enough to read as movement, too short to trail the hand.
 */
const ZOOM_EASE_MS = 30
/** Stop an eased wheel zoom where it is. For anything else that is about to set the view, so the two do not pull against each other. */
export function stopZoom() {
  cancelAnimationFrame(zoomRaf); zoomRaf = 0
}
/**
 * Zoom by `factor` about canvas position (cx, cy), gliding there. For the separate notches of a mouse wheel: each notch
 * adds to a target and the view closes on it quickly, so a notch reads as one small smooth step and several in a row as
 * one movement. The point under the cursor stays put throughout. The easing works in the logarithm of the zoom and by
 * elapsed time, so it feels the same at every zoom level and on every display, and it ends as soon as it has arrived:
 * nothing coasts on after the wheel stops. A notch the other way turns it round at once.
 */
export function smoothZoom(factor: number, cx: number, cy: number) {
  heading = null
  const s = useStore.getState()
  cancelAnimationFrame(raf)
  if (!zoomRaf) zoomTarget = s.view.k
  zoomTarget = Math.max(MIN_K, Math.min(MAX_K, zoomTarget * factor))
  zoomAt = [cx, cy]
  if (zoomRaf) return
  zoomLast = performance.now()
  const step = (now: number) => {
    const { view } = useStore.getState()
    const dt = Math.max(0, Math.min(64, now - zoomLast))
    zoomLast = now
    const gap = Math.log(zoomTarget / view.k)
    // within a twentieth of a percent it is there
    const done = Math.abs(gap) < 0.0005
    const k = done ? zoomTarget : view.k * Math.exp(gap * (1 - Math.exp(-dt / ZOOM_EASE_MS)))
    useStore.setState({ view: { k, x: zoomAt[0] - ((zoomAt[0] - view.x) * k) / view.k, y: zoomAt[1] - ((zoomAt[1] - view.y) * k) / view.k } })
    zoomRaf = done ? 0 : requestAnimationFrame(step)
  }
  zoomRaf = requestAnimationFrame(step)
}
