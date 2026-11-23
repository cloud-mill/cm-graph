import { MAX_PITCH, MIN_PITCH, type Proj, makeCam, pt, unproject } from '../core/iso'
import type { View } from '../core/store'

/**
 * Two-finger camera gestures, kept pure so they can be tested without a screen.
 *
 * The model is the one good maps share, and it works in small steps: each step
 * takes the fingers from where they were to where they are, so fingers can come
 * and go mid-gesture without the camera ever jumping.
 *
 *  - The ground under the middle of the fingers stays under the middle of the
 *    fingers. Moving them pans, spreading them zooms.
 *  - Turning the fingers turns the scene the same way, about that same point,
 *    but only once the twist is clearly meant. A pinch never turns by accident.
 *  - Two fingers side by side, sliding up or down together, tilt the camera.
 *    Once a gesture is a tilt it is only a tilt.
 */

/** Where a finger is, in px from the canvas's top-left corner. */
export interface Finger { x: number; y: number }
/** The whole camera: pan (px) and zoom, and the angle in degrees. Passed in and handed back, never read from the store here. */
export interface Camera { view: View; yaw: number; pitch: number }

export interface Gesture {
  /** `open` has not shown yet whether it is a tilt; `free` pans, zooms and turns; `tilt` only tilts */
  kind: 'open' | 'free' | 'tilt'
  /** where the fingers were at the last step */
  a: Finger
  b: Finger
  /** where they were when the pair formed */
  a0: Finger
  b0: Finger
  /** twist gathered while turning is still locked, in degrees */
  twist: number
  /** the twist has been read as deliberate: the camera now turns with the fingers */
  turning: boolean
  /** the spread has been read as deliberate (it always is, unless a turn got there first) */
  zooming: boolean
  /** finger distance when the turn began, to tell a later deliberate zoom from a wobble */
  turnDist: number
  /** ground point the tilt hinges on, and where on the canvas it stays */
  hinge: [number, number]
  hingeAt: [number, number]
  /** furthest either finger has strayed from where it landed, in px */
  travel: number
}

/** How far out and how far in the view may zoom. */
export const MIN_K = 0.15, MAX_K = 4
/** a twist must pass this many degrees, and sweep this far under the fingers, before it turns the camera */
export const TWIST_START = 7
const TWIST_ARC = 14
/** once a pinch is clearly zooming, turning needs to be this much more deliberate, and the other way round */
const ZOOM_GUARD = 2.2
// both are changes in the distance between the fingers, as the log of a ratio (0.12 is about an eighth wider or narrower):
// how far from where the pair began before it is clearly a zoom, and how far from where a turn began before a turn zooms as well
const ZOOM_COMMIT = 0.12
const ZOOM_AFTER_TURN = 0.14
/** fingers closer together than this give a shaky angle, so their twist counts for less */
const STEADY_SPAN = 64
/** px of travel before a gesture has shown whether it is a tilt */
const DECIDE = 10
export const TILT_SPEED = 0.3 // degrees per pixel

const span = (a: Finger, b: Finger) => Math.max(1, Math.hypot(b.x - a.x, b.y - a.y))
const slope = (a: Finger, b: Finger) => (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI
const mid = (a: Finger, b: Finger): Finger => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })
/** smallest signed difference between two angles, in degrees */
export const turnBetween = (from: number, to: number) => ((to - from + 540) % 360 + 360) % 360 - 180
const clampK = (k: number) => Math.max(MIN_K, Math.min(MAX_K, k))
const clampPitch = (p: number) => Math.max(MIN_PITCH, Math.min(MAX_PITCH, p))

/** Ground point under a canvas position. */
export const groundUnder = (proj: Proj, view: View, x: number, y: number) => unproject(proj, (x - view.x) / view.k, (y - view.y) / view.k)

/** The view that shows ground point `g` at canvas position `at`. */
function pin(yaw: number, pitch: number, k: number, g: [number, number], at: Finger): View {
  const q = pt(makeCam(yaw, pitch), g[0], g[1])
  return { k, x: at.x - q[0] * k, y: at.y - q[1] * k }
}

/** Two fingers are down. `mayTilt` is false when one of them was already busy, so the pair can only pan, zoom and turn. */
export function gestureStart(a: Finger, b: Finger, mayTilt = true): Gesture {
  return { kind: mayTilt ? 'open' : 'free', a, b, a0: a, b0: b, twist: 0, turning: false, zooming: false, turnDist: 0, hinge: [0, 0], hingeAt: [0, 0], travel: 0 }
}

/** Fingers changed (one lifted, another landed): carry on from where the new pair is, as a plain pan, zoom and turn. */
export function gestureRebase(g: Gesture, a: Finger, b: Finger) {
  g.a = a; g.b = b; g.a0 = a; g.b0 = b
  g.twist = 0
  if (g.kind === 'open') g.kind = 'free'
}

/** Did the fingers, side by side, slide up or down together? */
function looksLikeTilt(g: Gesture, a: Finger, b: Finger): boolean | null {
  const da = { x: a.x - g.a0.x, y: a.y - g.a0.y }, db = { x: b.x - g.b0.x, y: b.y - g.b0.y }
  const far = Math.max(Math.hypot(da.x, da.y), Math.hypot(db.x, db.y)), near = Math.min(Math.hypot(da.x, da.y), Math.hypot(db.x, db.y))
  if (far < DECIDE) return null
  // one finger's report can lag the other's: give it a little longer before calling it
  if (near < DECIDE / 2 && far < DECIDE * 2) return null
  const upright = (d: Finger) => Math.abs(d.y) >= DECIDE / 2 && Math.abs(d.x) <= Math.abs(d.y) * 0.6
  const sideBySide = Math.abs(Math.sin((slope(g.a0, g.b0) * Math.PI) / 180)) < 0.77
  const d0 = span(g.a0, g.b0)
  const steady = Math.abs(span(a, b) - d0) <= Math.max(8, d0 * 0.1)
  return upright(da) && upright(db) && Math.sign(da.y) === Math.sign(db.y) && sideBySide && steady
}

/**
 * Take the camera from where the fingers were to where they are now.
 * `centre` is the middle of the visible canvas: a tilt hinges there, so the diagram stays in frame.
 * Returns the new camera for the caller to set, and updates `g` in place: where the fingers now are, and what the gesture has become.
 */
export function gestureMove(g: Gesture, a: Finger, b: Finger, c: Camera, centre: [number, number]): Camera {
  g.travel = Math.max(g.travel, Math.hypot(a.x - g.a0.x, a.y - g.a0.y), Math.hypot(b.x - g.b0.x, b.y - g.b0.y))
  const m0 = mid(g.a, g.b), m1 = mid(a, b)

  if (g.kind === 'tilt') {
    const pitch = clampPitch(c.pitch + (m1.y - m0.y) * TILT_SPEED)
    g.a = a; g.b = b
    return { yaw: c.yaw, pitch, view: pin(c.yaw, pitch, c.view.k, g.hinge, { x: g.hingeAt[0], y: g.hingeAt[1] }) }
  }

  const d0 = span(g.a, g.b), d1 = span(a, b)
  // close fingers make a jittery angle
  const dTwist = turnBetween(slope(g.a, g.b), slope(a, b)) * Math.min(1, d1 / STEADY_SPAN)
  const spread = Math.abs(Math.log(d1 / span(g.a0, g.b0)))

  let dYaw = 0
  if (g.turning) dYaw = dTwist
  else {
    g.twist += dTwist
    const need = Math.max(TWIST_START, ((TWIST_ARC / (d1 / 2)) * 180) / Math.PI) * (spread > ZOOM_COMMIT ? ZOOM_GUARD : 1)
    if (Math.abs(g.twist) > need) { g.turning = true; g.turnDist = d1; g.zooming = spread > ZOOM_COMMIT }
  }
  // a turn holds the zoom still until the fingers clearly spread or close
  if (g.turning && !g.zooming && Math.abs(Math.log(d1 / g.turnDist)) > ZOOM_AFTER_TURN) g.zooming = true
  const scale = !g.turning || g.zooming ? d1 / d0 : 1

  const ground = groundUnder(makeCam(c.yaw, c.pitch), c.view, m0.x, m0.y) as [number, number]
  // the scene follows the fingers: turning them clockwise turns the scene clockwise
  const yaw = c.yaw + dYaw
  const next: Camera = { yaw, pitch: c.pitch, view: pin(yaw, c.pitch, clampK(c.view.k * scale), ground, m1) }
  g.a = a; g.b = b

  if (g.kind === 'open') {
    if (g.turning || spread > ZOOM_COMMIT) g.kind = 'free'
    else {
      const tilt = looksLikeTilt(g, a, b)
      if (tilt) {
        g.kind = 'tilt'
        g.hingeAt = centre
        g.hinge = groundUnder(makeCam(next.yaw, next.pitch), next.view, centre[0], centre[1]) as [number, number]
      } else if (tilt === false) g.kind = 'free'
    }
  }
  return next
}

/** A quick touch of two fingers that never went anywhere: the map convention for zooming out. */
export const isTwoFingerTap = (g: Gesture, heldMs: number) => g.travel < DECIDE && heldMs < 300 && !g.turning && g.kind !== 'tilt'

// ---- momentum -----------------------------------------------------------------

/** Recent positions of a finger, for the speed it was moving at when it let go. */
export interface Trail { t: number; x: number; y: number }

/** Note where the finger is now (`t` in ms), and forget where it was more than 120 ms ago: only the last moments say how fast it left. */
export function track(trail: Trail[], t: number, x: number, y: number) {
  trail.push({ t, x, y })
  while (trail.length > 2 && t - trail[0].t > 120) trail.shift()
}

/** Speed at release in px per ms, or null when the finger had come to rest (no flick). */
export function fling(trail: Trail[], now: number): [number, number] | null {
  const last = trail[trail.length - 1]
  if (!last || trail.length < 2 || now - last.t > 60) return null
  const first = trail.find((s) => last.t - s.t <= 100) ?? trail[0]
  const dt = last.t - first.t
  if (dt < 16) return null
  let vx = (last.x - first.x) / dt, vy = (last.y - first.y) / dt
  const v = Math.hypot(vx, vy)
  if (v < 0.3) return null
  const cap = Math.min(v, 3.5) / v
  vx *= cap; vy *= cap
  return [vx, vy]
}
