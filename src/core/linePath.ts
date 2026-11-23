import { type Proj, f, pt } from './iso'
import { type NodeT, centerOf } from './types'

/**
 * Drawing a route: from the ground points `core/router` decides on to SVG path data, arrowheads and caption
 * positions. Nothing here chooses where a line goes. Inputs are in cells on the ground; path strings are in
 * scene pixels, through the projection they are given.
 */

/** A point on the ground, in cells. */
export type W = [number, number]

const len = (a: W, b: W) => Math.hypot(b[0] - a[0], b[1] - a[1])
const toward = (a: W, b: W, dist: number): W => {
  const l = len(a, b) || 1
  return [a[0] + ((b[0] - a[0]) / l) * dist, a[1] + ((b[1] - a[1]) / l) * dist]
}

/**
 * Orthogonal ground-plane route between two node centres (world coords).
 * It knows nothing of sides, ports or obstacles. Nothing in the app calls it, only tests: connections are
 * routed by `core/router`.
 */
export function route(a: Pick<NodeT, 'x' | 'y' | 'scale'>, b: Pick<NodeT, 'x' | 'y' | 'scale'>): W[] {
  const A: W = centerOf(a)
  const B: W = centerOf(b)
  const sa = a.scale ?? 1, sb = b.scale ?? 1
  const dx = B[0] - A[0]
  const dy = B[1] - A[1]
  let pts: W[]
  if (Math.abs(dx) < 0.01 || Math.abs(dy) < 0.01) pts = [A, B]
  else if (Math.abs(dx) >= Math.abs(dy)) {
    if (Math.abs(dx) / 2 >= 1.5) {
      const mx = A[0] + Math.round(dx / 2)
      pts = [A, [mx, A[1]], [mx, B[1]], B]
    } else pts = [A, [B[0], A[1]], B]
  } else {
    if (Math.abs(dy) / 2 >= 1.5) {
      const my = A[1] + Math.round(dy / 2)
      pts = [A, [A[0], my], [B[0], my], B]
    } else pts = [A, [A[0], B[1]], B]
  }
  // pull the ends back to the footprint edge
  const n = pts.length
  if (len(pts[0], pts[1]) > 1.2 * sa) pts[0] = toward(pts[0], pts[1], 0.9 * sa)
  if (len(pts[n - 1], pts[n - 2]) > 1.2 * sb) pts[n - 1] = toward(pts[n - 1], pts[n - 2], 1.02 * sb)
  return pts
}

/**
 * SVG path for a world polyline with rounded corners, projected. The trims shorten each end along its own run, and
 * they and `radius` are in cells. A corner is rounded by no more than half the shorter run that meets there.
 */
export function pathOf(p: Proj, pts: W[], trimStart = 0, trimEnd = 0, radius = 0.32): string {
  const w = pts.map((q) => [...q] as W)
  const n = w.length
  if (n < 2) return ''
  if (trimStart) w[0] = toward(w[0], w[1], trimStart)
  if (trimEnd) w[n - 1] = toward(w[n - 1], w[n - 2], trimEnd)
  const S = (q: W) => {
    const s = pt(p, q[0], q[1])
    return f(s[0]) + ' ' + f(s[1])
  }
  let d = 'M' + S(w[0])
  for (let i = 1; i < n - 1; i++) {
    const r = Math.min(radius, len(w[i - 1], w[i]) / 2, len(w[i], w[i + 1]) / 2)
    d += 'L' + S(toward(w[i], w[i - 1], r)) + 'Q' + S(w[i]) + ' ' + S(toward(w[i], w[i + 1], r))
  }
  return d + 'L' + S(w[n - 1])
}

/** SVG path for a curve given as start, two control points and end, projected. The trims shorten it along its own direction at each end. */
export function curveOf(p: Proj, pts: W[], trimStart = 0, trimEnd = 0): string {
  if (pts.length !== 4) return pathOf(p, pts, trimStart, trimEnd)
  const w = pts.map((q) => [...q] as W)
  if (trimStart) w[0] = toward(w[0], w[1], trimStart)
  if (trimEnd) w[3] = toward(w[3], w[2], trimEnd)
  const S = (q: W) => { const s = pt(p, q[0], q[1]); return f(s[0]) + ' ' + f(s[1]) }
  return 'M' + S(w[0]) + 'C' + S(w[1]) + ' ' + S(w[2]) + ' ' + S(w[3])
}

/** The path of a routed connection, whatever shape it is drawn in. */
export const lineOf = (p: Proj, r: { pts: W[]; shape: 'ortho' | 'direct' | 'curved' }, trimStart = 0, trimEnd = 0): string =>
  r.shape === 'curved' ? curveOf(p, r.pts, trimStart, trimEnd) : pathOf(p, r.pts, trimStart, trimEnd)

/** Where a routed connection's caption goes, and which way it reads. */
export function captionAnchor(r: { pts: W[]; shape: 'ortho' | 'direct' | 'curved' }): { at: W; dir: 'x' | 'y' } {
  if (r.shape !== 'curved' || r.pts.length !== 4) return labelAnchor(r.pts)
  // halfway round the curve
  const [a, b, c, d] = r.pts
  return { at: [(a[0] + 3 * b[0] + 3 * c[0] + d[0]) / 8, (a[1] + 3 * b[1] + 3 * c[1] + d[1]) / 8], dir: Math.abs(d[0] - a[0]) >= Math.abs(d[1] - a[1]) ? 'x' : 'y' }
}

/** Arrowhead triangle lying on the ground at `tip`, pointing away from `from`. World points, `size` (its length) in cells. */
export function arrowAt(tip: W, from: W, size = 0.4): W[] {
  const l = len(from, tip) || 1
  const u: W = [(tip[0] - from[0]) / l, (tip[1] - from[1]) / l]
  const v: W = [-u[1], u[0]]
  const base: W = [tip[0] - u[0] * size, tip[1] - u[1] * size]
  const h = size * 0.48
  return [tip, [base[0] + v[0] * h, base[1] + v[1] * h], [base[0] - v[0] * h, base[1] - v[1] * h]]
}

/** Point + axis for an edge label: middle of the longest segment. */
export function labelAnchor(pts: W[]): { at: W; dir: 'x' | 'y' } {
  let best = 0
  let bl = -1
  for (let i = 0; i < pts.length - 1; i++) {
    const l = len(pts[i], pts[i + 1])
    if (l > bl) { bl = l; best = i }
  }
  const a = pts[best], b = pts[best + 1]
  return { at: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], dir: Math.abs(b[0] - a[0]) >= Math.abs(b[1] - a[1]) ? 'x' : 'y' }
}
