/**
 * Camera maths. The world is a grid of unit cells on the z=0 plane with height
 * along +z, viewed through an orthographic orbit camera: `yaw` turns the scene
 * about the vertical axis and `pitch` is the camera's elevation above the
 * ground (90° looks straight down). The projection is a 2×3 affine map, so
 * everything drawn through it follows the camera as it orbits.
 *
 * Two coordinate spaces meet here. World (also "ground"): cells, x and y on the
 * ground and z up. Scene: pixels at zoom 1 with the world origin at (0, 0) and y
 * down. Pan and zoom (the store's `view`) are applied outside this module, so a
 * pointer position has to have them taken off before it is given to `unproject`.
 *
 * The colour helpers at the bottom have nothing to do with the camera.
 */
export const U = 40 // scene px per cell: the length of one cell along a ground axis in the home view (see SCALE)

/**
 * A camera, as the coefficients of the map from world to scene (before `U`):
 * scene x = a·x + b·y and scene y = c·x + d·y - e·z.
 */
export interface Proj {
  a: number
  b: number
  c: number
  d: number
  e: number
  /** 1 when looking straight down (pitch of 89.5° or more), otherwise 0 */
  t: number
  /** degrees, as given: `yaw` is not normalised and `pitch` is not clamped, though the coefficients use the clamped pitch */
  yaw: number
  pitch: number
  /** which 90° quadrant the camera sits in; used to keep labels upright */
  q: number
}

const RAD = Math.PI / 180
const SCALE = Math.sqrt(1.5) // makes the home view a true isometric with unit-length axes
export const ISO_YAW = 45
export const ISO_PITCH = Math.atan(Math.SQRT1_2) / RAD // 35.264°
export const MIN_PITCH = 12
export const MAX_PITCH = 90
const lerp = (p: number, q: number, t: number) => p + (q - p) * t

/** A yaw in degrees brought into 0 (inclusive) to 360 (exclusive). */
export const normYaw = (yaw: number) => ((yaw % 360) + 360) % 360

/** The projection for a camera at `yaw` and `pitch`, both in degrees. */
export function makeCam(yaw: number, pitch: number): Proj {
  const th = yaw * RAD
  const ph = Math.max(MIN_PITCH, Math.min(MAX_PITCH, pitch)) * RAD
  const cos = Math.cos(th), sin = Math.sin(th), sp = Math.sin(ph)
  return {
    a: SCALE * cos,
    b: -SCALE * sin,
    c: SCALE * sin * sp,
    d: SCALE * cos * sp,
    e: SCALE * Math.cos(ph),
    t: pitch >= 89.5 ? 1 : 0,
    yaw,
    pitch,
    q: Math.floor((normYaw(yaw) + 1e-6) / 90) % 4,
  }
}

/** Blend between the home isometric view (t=0) and the plan view (t=1). */
export const makeProj = (t: number): Proj => makeCam(lerp(ISO_YAW, 0, t), lerp(ISO_PITCH, 90, t))

export const ISO = makeProj(0)
export const FLAT = makeProj(1)

/** A point in scene pixels. */
export type Pt = [number, number]

/** World (cells, `z` up) to scene pixels. */
export const pt = (p: Proj, x: number, y: number, z = 0): Pt => [
  (x * p.a + y * p.b) * U,
  (x * p.c + y * p.d - z * p.e) * U,
]

/** Scene pixels (pan and zoom already taken off) to world cells on the ground plane, z = 0. The inverse of `pt` there. */
export function unproject(p: Proj, sx: number, sy: number): Pt {
  const det = p.a * p.d - p.b * p.c
  const x = sx / U
  const y = sy / U
  return [(x * p.d - y * p.b) / det, (-x * p.c + y * p.a) / det]
}

/**
 * SVG matrix placing content on the ground plane with its origin at world (x, y, z); 1 content unit = `s` world units.
 * With `dir` 'x' content x and y run along world +x and +y; with 'y' the content is turned a quarter, so its x runs
 * along world -y and its y along world +x.
 */
export function planeMatrix(p: Proj, x: number, y: number, z = 0, s = 1, dir: 'x' | 'y' = 'x') {
  const [tx, ty] = pt(p, x, y, z)
  const k = U * s
  const m =
    dir === 'x'
      ? [p.a * k, p.c * k, p.b * k, p.d * k]
      : [-p.b * k, -p.d * k, p.a * k, p.c * k]
  return `matrix(${m.map(f).join(' ')} ${f(tx)} ${f(ty)})`
}

type V2 = [number, number]
const BASIS: [V2, V2][] = [[[1, 0], [0, 1]], [[0, -1], [1, 0]], [[-1, 0], [0, -1]], [[0, 1], [-1, 0]]]

/**
 * Grid-aligned world directions that currently read as screen-right (`u`) and
 * screen-down (`v`). Text laid along them stays upright from any orbit angle.
 */
export const upright = (p: Proj): { u: V2; v: V2 } => ({ u: BASIS[p.q][0], v: BASIS[p.q][1] })

/** Upright basis for text running along a world axis (`x` or `y`). */
export function uprightAlong(p: Proj, axis: 'x' | 'y'): { u: V2; v: V2 } {
  if (axis === 'x') return p.d >= 0 ? { u: [1, 0], v: [0, 1] } : { u: [-1, 0], v: [0, -1] }
  return p.c < 0 ? { u: [0, 1], v: [-1, 0] } : { u: [0, -1], v: [1, 0] }
}

/** Like planeMatrix, but with explicit in-plane basis vectors for the content's x and y. */
export function planeMatrixUV(p: Proj, x: number, y: number, z: number, s: number, u: V2, v: V2) {
  const [tx, ty] = pt(p, x, y, z)
  const k = U * s
  const m = [(u[0] * p.a + u[1] * p.b) * k, (u[0] * p.c + u[1] * p.d) * k, (v[0] * p.a + v[1] * p.b) * k, (v[0] * p.c + v[1] * p.d) * k]
  return `matrix(${m.map(f).join(' ')} ${f(tx)} ${f(ty)})`
}

/** A number as written into SVG: two decimals at most. */
export const f = (n: number) => (Math.round(n * 100) / 100).toString()
/** Scene points as an SVG `points` attribute. */
export const poly = (pts: Pt[]) => pts.map((q) => f(q[0]) + ',' + f(q[1])).join(' ')

// ---- colour helpers -------------------------------------------------------
// These take colours as `#rgb` or `#rrggbb` only: a named or `rgb()` colour does not parse.

function parse(hex: string): [number, number, number] {
  let h = hex.replace('#', '')
  if (h.length === 3) h = h.split('').map((ch) => ch + ch).join('')
  const n = parseInt(h, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

const toHex = (r: number, g: number, b: number) =>
  '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')

/** `c1` at t = 0, `c2` at t = 1, blended channel by channel in between; channels are clamped, so t may overshoot. */
export function mix(c1: string, c2: string, t: number) {
  const p = parse(c1)
  const q = parse(c2)
  return toHex(lerp(p[0], q[0], t), lerp(p[1], q[1], t), lerp(p[2], q[2], t))
}

/** amt > 0 lightens, amt < 0 darkens. */
export const shade = (hex: string, amt: number) =>
  amt >= 0 ? mix(hex, '#ffffff', amt) : mix(hex, '#05070d', -amt)

export function alpha(hex: string, a: number) {
  const [r, g, b] = parse(hex)
  return `rgba(${r},${g},${b},${a})`
}

export const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
