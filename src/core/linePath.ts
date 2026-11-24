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

// ---- one geometry for every layer ------------------------------------------------------------------------------
//
// A connection is drawn several times over: a dark channel under it, the line itself (stopping short of its arrowhead),
// the dots of traffic, the area that takes a click, and the highlight when it is selected. Every one of those has to lie
// on exactly the same path. So the path is worked out once, as a row of pieces on the ground, and a shortened version is
// cut out of those same pieces: a piece of a curve is split where the cut falls (de Casteljau), which leaves the part that
// remains precisely where it was. Nothing is ever shortened by moving an end point, because that redraws the curve.

/** One piece of a line on the ground: 2 points are a straight stretch, 3 a rounded corner (quadratic), 4 a sweep (cubic). Cells. */
export type Piece = W[]

const lerp = (a: W, b: W, t: number): W => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
/** The two halves of a piece cut at `t` (0 to 1). Each half traces exactly the part of the original it covers. */
function split(piece: Piece, t: number): [Piece, Piece] {
  const left: W[] = [], right: W[] = []
  let row = piece
  while (row.length) {
    left.push(row[0]); right.unshift(row[row.length - 1])
    row = row.slice(1).map((q, i) => lerp(row[i], q, t))
  }
  return [left, right]
}
const STEPS = 48
const at = (piece: Piece, t: number): W => split(piece, t)[0][piece.length - 1]
/** Length of a piece in cells: exact for a straight one, measured along short chords for a curved one. */
function lengthOf(piece: Piece): number {
  if (piece.length === 2) return len(piece[0], piece[1])
  let total = 0, prev = piece[0]
  for (let i = 1; i <= STEPS; i++) { const q = at(piece, i / STEPS); total += len(prev, q); prev = q }
  return total
}
/** How far along a piece (0 to 1) a distance of `s` cells from its start falls. */
function paramAt(piece: Piece, s: number): number {
  if (piece.length === 2) return Math.max(0, Math.min(1, s / (len(piece[0], piece[1]) || 1)))
  let gone = 0, prev = piece[0]
  for (let i = 1; i <= STEPS; i++) {
    const q = at(piece, i / STEPS), step = len(prev, q)
    if (gone + step >= s) return (i - 1 + (step ? (s - gone) / step : 0)) / STEPS
    gone += step; prev = q
  }
  return 1
}

/**
 * The path of a row of ground points as pieces: straight stretches joined by rounded corners. `radius` is in cells, and a
 * corner is rounded by no more than half the shorter run that meets there, so two corners on a short run meet in its middle
 * and the line stays one continuous sweep.
 */
export function piecesOf(pts: W[], radius = 0.32): Piece[] {
  const n = pts.length
  if (n < 2) return []
  const out: Piece[] = []
  let from = pts[0]
  for (let i = 1; i < n - 1; i++) {
    const r = Math.min(radius, len(pts[i - 1], pts[i]) / 2, len(pts[i], pts[i + 1]) / 2)
    const into = toward(pts[i], pts[i - 1], r), away = toward(pts[i], pts[i + 1], r)
    out.push([from, into], [into, pts[i], away])
    from = away
  }
  out.push([from, pts[n - 1]])
  return out
}

/** The pieces of a routed connection, whatever shape it is drawn in: the one geometry every layer of it is drawn from. */
export const routePieces = (r: { pts: W[]; shape: 'ortho' | 'direct' | 'curved' }): Piece[] =>
  r.shape === 'curved' && r.pts.length === 4 ? [r.pts] : piecesOf(r.pts)

/**
 * The same pieces with `start` and `end` cells of length taken off the ends, measured along the line. What is left lies
 * exactly on the original. Neither end gives up more than 45% of the whole, so there is always a line left to draw.
 */
export function shortened(pieces: Piece[], start = 0, end = 0): Piece[] {
  if (!pieces.length || (!(start > 0) && !(end > 0))) return pieces
  const total = pieces.reduce((sum, q) => sum + lengthOf(q), 0)
  const cut = (list: Piece[], s: number, fromEnd: boolean): Piece[] => {
    let left = Math.min(s, total * 0.45)
    if (!(left > 0)) return list
    const rest = [...list]
    for (;;) {
      const i = fromEnd ? rest.length - 1 : 0, l = lengthOf(rest[i])
      if (rest.length > 1 && l <= left) { left -= l; rest.splice(i, 1); continue }
      const t = paramAt(rest[i], fromEnd ? l - left : left), [head, tail] = split(rest[i], t)
      rest[i] = fromEnd ? head : tail
      return rest
    }
  }
  return cut(cut(pieces, start, false), end, true)
}

/** The point `back` cells along the line from one of its ends; the far end itself when the line is shorter than that. */
export function pointFrom(pieces: Piece[], back: number, fromEnd: boolean): W {
  const lengths = pieces.map(lengthOf), total = lengths.reduce((sum, l) => sum + l, 0)
  let s = Math.max(0, Math.min(total, fromEnd ? total - back : back))
  for (let i = 0; i < pieces.length; i++) {
    if (s <= lengths[i] || i === pieces.length - 1) return at(pieces[i], paramAt(pieces[i], s))
    s -= lengths[i]
  }
  return [0, 0]
}

/** SVG path data for a row of pieces, projected into scene pixels. */
export function pathData(p: Proj, pieces: Piece[]): string {
  if (!pieces.length) return ''
  const S = (q: W) => { const s = pt(p, q[0], q[1]); return f(s[0]) + ' ' + f(s[1]) }
  let d = 'M' + S(pieces[0][0])
  for (const q of pieces) d += 'LQC'[q.length - 2] + q.slice(1).map(S).join(' ')
  return d
}

/**
 * SVG path for a world polyline with rounded corners, projected. The trims take that many cells off each end, measured
 * along the line; `radius` is in cells. The corners are those of the whole line, so a trimmed path lies on the untrimmed one.
 */
export function pathOf(p: Proj, pts: W[], trimStart = 0, trimEnd = 0, radius = 0.32): string {
  return pathData(p, shortened(piecesOf(pts, radius), trimStart, trimEnd))
}

/** SVG path for a curve given as start, two control points and end, projected. The trims take that length off each end without moving the curve. */
export function curveOf(p: Proj, pts: W[], trimStart = 0, trimEnd = 0): string {
  if (pts.length !== 4) return pathOf(p, pts, trimStart, trimEnd)
  return pathData(p, shortened([pts], trimStart, trimEnd))
}

/** The path of a routed connection, whatever shape it is drawn in. */
export const lineOf = (p: Proj, r: { pts: W[]; shape: 'ortho' | 'direct' | 'curved' }, trimStart = 0, trimEnd = 0): string =>
  pathData(p, shortened(routePieces(r), trimStart, trimEnd))

/** how far short of its arrowhead's tip a line stops, and how long the arrowhead is: cells. The line ends inside the head */
export const HEAD_TRIM = 0.26, HEAD = 0.34

/** Everything that is drawn of one connection's path, all of it from the same pieces. */
export interface LineDrawing {
  /** the whole path, end to end: the channel under the line, the traffic on it, the area that takes a click */
  full: string
  /** the same path stopping short inside each arrowhead: the visible line, and its highlight when selected */
  line: string
  /** one triangle per arrowhead, on the ground in cells, each lying along the line where it arrives */
  heads: W[][]
}
const drawn = new WeakMap<object, { p: Proj; arrow: string; out: LineDrawing }>()
/**
 * The drawing of a routed connection. Asked twice with the same route, camera and arrows it hands back the same object,
 * so the scene and the selection highlight drawn over it cannot differ by so much as a rounding.
 */
export function drawingOf(p: Proj, r: { pts: W[]; shape: 'ortho' | 'direct' | 'curved' }, arrow: 'none' | 'end' | 'both'): LineDrawing {
  const hit = drawn.get(r)
  if (hit && hit.p === p && hit.arrow === arrow) return hit.out
  const pieces = routePieces(r), n = r.pts.length
  const atEnd = arrow !== 'none', atStart = arrow === 'both'
  // a head points along the line as it arrives: from the point one head's length back along the path to the tip
  const head = (fromEnd: boolean) => arrowAt(fromEnd ? r.pts[n - 1] : r.pts[0], pointFrom(pieces, HEAD, fromEnd), HEAD)
  const out: LineDrawing = {
    full: pathData(p, pieces),
    line: pathData(p, shortened(pieces, atStart ? HEAD_TRIM : 0, atEnd ? HEAD_TRIM : 0)),
    heads: n < 2 ? [] : [...(atEnd ? [head(true)] : []), ...(atStart ? [head(false)] : [])],
  }
  drawn.set(r, { p, arrow, out })
  return out
}

/**
 * Where a routed connection's caption goes and which way it reads. On a right-angled or direct line it stands beside
 * the middle of the longest run. On a curve it is centred on the line itself, halfway along (`on`), reading along
 * whichever axis the curve is mostly following there: a caption beside a slanting curve would be crossed by it.
 */
export function captionAnchor(r: { pts: W[]; shape: 'ortho' | 'direct' | 'curved' }): { at: W; dir: 'x' | 'y'; on?: boolean } {
  if (r.shape !== 'curved' || r.pts.length !== 4) return labelAnchor(r.pts)
  const pieces: Piece[] = [r.pts], half = lengthOf(r.pts) / 2
  const before = pointFrom(pieces, Math.max(0, half - 0.05), false), after = pointFrom(pieces, half + 0.05, false)
  return { at: pointFrom(pieces, half, false), dir: Math.abs(after[0] - before[0]) >= Math.abs(after[1] - before[1]) ? 'x' : 'y', on: true }
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
