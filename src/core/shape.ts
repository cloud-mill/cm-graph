import { EDGE, MIN_OUT, type Routed, STUB, routeAll, straightBetween } from './router'
import { clearOf } from './snap'
import { type Doc, type EdgeT, type NodeT, type Side, centerOf, footOf } from './types'

/**
 * Shaping a connection by hand.
 *
 * A right-angled line is a row of runs: the first leaves a side of one component,
 * the last arrives at a side of the other, and those between alternate across and
 * along. Shaping it means moving one run sideways. Nothing else: there are no
 * loose points to place, so a line cannot be tied in a knot, and "straight" is
 * simply the track with no runs in the middle.
 *
 *  - Moving the first or last run slides that end along its side.
 *  - Moving one in the middle moves just that run; its neighbours stretch.
 *  - Pulling an end run past the corner of its component makes it step out and round.
 *  - A run moved level with the next one along merges with it, and the turn between them is gone.
 */

export interface Track { fromSide: Side; toSide: Side; fromAt: number; toAt: number; runs: number[] }

const horizontal = (s: Side) => s === 'e' || s === 'w'
const r3 = (v: number) => Math.round(v * 1000) / 1000
const same = (a: number, b: number) => Math.abs(a - b) < 1e-6
/** the coordinate of the middle of a component, measured across the side */
const centreOn = (n: NodeT, s: Side) => centerOf(n)[horizontal(s) ? 1 : 0]
const reach = (n: NodeT) => footOf(n) / 2 - EDGE
/** the coordinate a run stands at when it is `out` beyond a side */
const beside = (n: NodeT, s: Side, out: number) => (s === 'e' ? n.x + footOf(n) + out : s === 'w' ? n.x - out : s === 's' ? n.y + footOf(n) + out : n.y - out)
const outward = (n: NodeT, s: Side, v: number) => (s === 'e' || s === 's' ? Math.max(v, beside(n, s, MIN_OUT)) : Math.min(v, beside(n, s, MIN_OUT)))
const facingEachOther = (t: Track) => ({ e: 'w', w: 'e', n: 's', s: 'n' } as const)[t.fromSide] === t.toSide
/**
 * The track a drawn line is following, read off the line itself, and which run each of its
 * stretches belongs to. Works for any right-angled line: one the router planned, one already
 * shaped, or one from an older file that goes through points.
 */
export function trackOf(r: Routed, a: NodeT, b: NodeT): { track: Track; seg: number[] } | null {
  if (r.shape !== 'ortho' || r.pts.length < 2) return null
  // one entry per run: its fixed coordinate. Stretches that double back along the same line are one run
  const coords: number[] = [], seg: number[] = []
  let axis: boolean | null = null
  for (let i = 0; i < r.pts.length - 1; i++) {
    const p = r.pts[i], q = r.pts[i + 1], h = p[1] === q[1]
    if (h !== axis) { coords.push(h ? p[1] : p[0]); axis = h }
    seg.push(coords.length - 1)
  }
  return {
    track: { fromSide: r.fromSide, toSide: r.toSide, fromAt: r3(coords[0] - centreOn(a, r.fromSide)), toAt: r3(coords[coords.length - 1] - centreOn(b, r.toSide)), runs: coords.slice(1, -1) },
    seg,
  }
}

/** Every run's coordinate, the two end runs included. */
export const coordsOf = (t: Track, a: NodeT, b: NodeT) => [centreOn(a, t.fromSide) + t.fromAt, ...t.runs, centreOn(b, t.toSide) + t.toAt]

/** The band a single straight run between two facing sides can lie in, or null when they do not overlap. */
function band(t: Track, a: NodeT, b: NodeT): [number, number] | null {
  const ca = centreOn(a, t.fromSide), cb = centreOn(b, t.toSide)
  const lo = Math.max(ca - reach(a), cb - reach(b)), hi = Math.min(ca + reach(a), cb + reach(b))
  return lo <= hi + 1e-9 ? [lo, hi] : null
}

/**
 * For a single step between two facing sides: the line nearest `other` (where the far end is now) on which both
 * ends could sit, making the connection straight. Null when the two sides share no such line.
 */
function meeting(t: Track, a: NodeT, b: NodeT, other: number): number | null {
  const I = t.runs.length === 1 && facingEachOther(t) ? band(t, a, b) : null
  return I ? Math.max(I[0], Math.min(I[1], other)) : null
}

/**
 * Where a run being moved should come to rest when it is let go at `v`. It goes exactly where it is put,
 * unless that is within `pull` of something it would line up with: the next run along on the same axis
 * (which takes the turn between them out), the middle of the component at its end, or, more weakly, a
 * half cell of the grid. `pull` is in cells and is small: a few pixels' worth. With none, nothing draws it.
 */
export function snapRun(t: Track, a: NodeT, b: NodeT, run: number, v: number, pull = 0.1): number {
  if (!(pull > 0)) return r3(v)
  const L = coordsOf(t, a, b), last = L.length - 1
  const marks: number[] = []
  if (run - 2 >= 0) marks.push(L[run - 2])
  if (run + 2 <= last) marks.push(L[run + 2])
  if (run === 0) marks.push(centreOn(a, t.fromSide))
  if (run === last) marks.push(centreOn(b, t.toSide))
  if (last === 1 && facingEachOther(t)) marks.push(centreOn(a, t.fromSide), centreOn(b, t.toSide))
  // an end of a single step between two facing sides: the line on which the two ends could meet and be straight
  const meet = last === 2 && (run === 0 || run === last) ? meeting(t, a, b, run === 0 ? L[2] : L[0]) : null
  if (meet !== null) marks.push(meet)
  let best = NaN
  for (const m of marks) if (Math.abs(m - v) <= pull && !(Math.abs(best - v) <= Math.abs(m - v))) best = m
  if (!Number.isNaN(best)) return best
  const g = Math.round(v * 2) / 2
  return Math.abs(g - v) <= Math.min(pull * 0.5, 0.1) ? g : r3(v)
}

/**
 * The line a run in the hand is all but on already, or null. This is not snapping to a grid and not routing: the only
 * lines it knows are the ones the neighbouring runs of this same connection stand on, because a run brought level with
 * the next one along is a turn the user is taking out, and a hair short of level is a kink nobody meant. `tol` is in
 * cells and is a few pixels' worth. Once caught (`held` is the line it was on a moment ago) it stays until it has been
 * pulled half as far again, so it cannot flicker at the edge. Nothing else about the connection is touched.
 */
export function alignRun(t: Track, a: NodeT, b: NodeT, run: number, v: number, tol: number, held?: number): number | null {
  if (!(tol > 0)) return null
  const L = coordsOf(t, a, b)
  const last = L.length - 1
  // only a line the run can actually stand on: an end has to stay on its side, and the first and last turn outside their components
  const can = (m: number) => {
    if (run === 0 || run === last) { const n = run === 0 ? a : b; return Math.abs(m - centreOn(n, run === 0 ? t.fromSide : t.toSide)) <= reach(n) + 1e-9 }
    return (run !== 1 || same(outward(a, t.fromSide, m), m)) && (run !== last - 1 || same(outward(b, t.toSide, m), m))
  }
  const marks = [L[run - 2], L[run + 2]].filter((m): m is number => m !== undefined && can(m))
  if (held !== undefined && marks.some((m) => same(m, held)) && Math.abs(held - v) <= tol * 1.5) return held
  let best: number | null = null
  for (const m of marks) if (Math.abs(m - v) <= tol && (best === null || Math.abs(m - v) < Math.abs(best - v))) best = m
  return best
}

/** How small a step in a line has to be for cleaning up to take it for a slip of the hand: a tenth of a cell. */
export const KINK = 0.1

/**
 * Whether a connection has a step small enough to be taken for a slip, read off what it carries (its own track, or the
 * path planned for it) without routing anything. Cheap enough to ask every time a menu opens.
 */
export function kinked(doc: Doc, e: EdgeT, tol = KINK): boolean {
  const a = doc.nodes.find((n) => n.id === e.from), b = doc.nodes.find((n) => n.id === e.to)
  if (!a || !b || e.shape) return false
  const t = e.runs && e.fromSide && e.toSide
    ? { fromSide: e.fromSide, toSide: e.toSide, fromAt: e.fromAt ?? 0, toAt: e.toAt ?? 0, runs: e.runs }
    : e.plan && !e.via?.length ? trackOf({ pts: e.plan.pts, leg: [], fromSide: e.plan.fromSide, toSide: e.plan.toSide, manual: false, shape: 'ortho' }, a, b)?.track : null
  if (!t) return false
  const L = coordsOf(t, a, b)
  return L.some((v, i) => i + 2 < L.length && Math.abs(L[i + 2] - v) <= tol && !same(L[i + 2], v))
}

/**
 * Take the small kinks out of these connections: wherever two runs going the same way stand within `tol` of each
 * other, with a short step between them, one is brought onto the other's line and the step is gone. An end of the
 * line stays where it is on its component when the run beside it can move instead; nothing is planned afresh, and a
 * step bigger than `tol` is a step somebody made and is left alone. A line the router had planned becomes the user's
 * when a kink is taken out of it (`taken` counts those), since its path is then one they chose.
 */
export function tidyKinks(doc: Doc, ids: string[], tol = KINK): { doc: Doc; tidied: number; taken: number } {
  const routes = routeAll(doc.nodes, doc.edges), byId = new Map(doc.nodes.map((n) => [n.id, n]))
  let tidied = 0, taken = 0
  const edges = doc.edges.map((e) => {
    const r = routes.get(e.id), a = byId.get(e.from), b = byId.get(e.to)
    const from = ids.includes(e.id) && r && a && b ? trackOf(r, a, b) : null
    if (!from || !a || !b) return e
    let t = from.track, changed = false
    for (let guard = 0; guard < 32; guard++) {
      const L = coordsOf(t, a, b), last = L.length - 1
      // the smallest first, and for each the run that is not an end of the line is the one to move
      const kinks = L.map((v, i) => ({ i, d: i + 2 <= last ? Math.abs(L[i + 2] - v) : Infinity })).filter((k) => k.d <= tol && !same(k.d, 0)).sort((p, q) => p.d - q.d)
      let next: Track | null = null
      for (const { i } of kinks) {
        const tries = i + 2 === last ? [[i, i + 2], [i + 2, i]] : [[i + 2, i], [i, i + 2]]
        for (const [move, to] of tries) {
          const made = simplify(dragRun(t, a, b, move, L[to]), a, b)
          if (made.runs.length < t.runs.length) { next = made; break }
        }
        if (next) break
      }
      if (!next) break
      t = next; changed = true
    }
    if (!changed) return e
    tidied++
    // a line the router had planned is the user's from here on: the path it has now is one they asked for
    if (!isManual(e)) taken++
    return withTrack(e, t)
  })
  return tidied ? { doc: { ...doc, edges }, tidied, taken } : { doc, tidied: 0, taken: 0 }
}

/**
 * The track with run `run` moved sideways to `v`. Run 0 is the one that leaves the first component.
 * Only that run moves, and it moves to exactly `v` wherever a line can be there at all:
 *  - an end run slides its end along the side, and past the corner steps out and round to stay under the hand;
 *  - a run in the middle is moved as it is, and its neighbours stretch;
 *  - the first and last turn stay outside the components they belong to.
 */
export function dragRun(t: Track, a: NodeT, b: NodeT, run: number, v: number): Track {
  const m = t.runs.length, ca = centreOn(a, t.fromSide), cb = centreOn(b, t.toSide)
  const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x))
  // how far out of a side a new step round the corner is taken: half a cell, or less when the line already turns nearer than that
  const step = (n: NodeT, s: Side, turn: number | undefined) => {
    const far = beside(n, s, STUB)
    if (turn === undefined) return far
    const room = Math.abs(turn - beside(n, s, 0))
    return room > STUB + MIN_OUT ? far : beside(n, s, Math.max(MIN_OUT, room / 2))
  }
  if (m === 0 && facingEachOther(t)) {
    // one straight run: it slides along both sides at once. Past the end of either, the ends stay at the corner and the run goes on round
    const I = band(t, a, b)
    const c = I ? clamp(v, I[0], I[1]) : null
    const ends = c === null ? t : { ...t, fromAt: r3(c - ca), toAt: r3(c - cb) }
    if (c !== null && same(c, v)) return ends
    return { ...ends, runs: [beside(a, t.fromSide, STUB), v, beside(b, t.toSide, STUB)] }
  }
  // An end of a single step, put on the line where the two ends can meet: the far end comes the rest of the way and the line is
  // straight. That line is only ever landed on by being drawn to it, which is the user asking for exactly this
  if (m === 1 && (run <= 0 || run >= 2)) {
    const meet = meeting(t, a, b, run <= 0 ? cb + t.toAt : ca + t.fromAt)
    if (meet !== null && same(meet, v)) return { ...t, fromAt: r3(v - ca), toAt: r3(v - cb) }
  }
  if (run <= 0) {
    const c = clamp(v, ca - reach(a), ca + reach(a)), next = { ...t, fromAt: r3(c - ca) }
    return same(c, v) ? next : { ...next, runs: [step(a, t.fromSide, t.runs[0]), v, ...t.runs] }
  }
  if (run >= m + 1) {
    const c = clamp(v, cb - reach(b), cb + reach(b)), next = { ...t, toAt: r3(c - cb) }
    return same(c, v) ? next : { ...next, runs: [...t.runs, v, step(b, t.toSide, t.runs[m - 1])] }
  }
  const runs = [...t.runs]
  runs[run - 1] = v
  // the first and last turn stay outside the components they belong to
  runs[0] = outward(a, t.fromSide, runs[0])
  runs[m - 1] = outward(b, t.toSide, runs[m - 1])
  return { ...t, runs }
}

/**
 * The track with the turn between run `run` and the next one moved: both runs that meet there go with it,
 * the first to `v`, the second to `w`. This is taking a corner of the line in the hand.
 */
export function dragTurn(t: Track, a: NodeT, b: NodeT, run: number, v: number, w: number): Track {
  // the later run first: if it steps round its corner it adds runs after itself, which leaves the earlier one where it was in the row
  return dragRun(dragRun(t, a, b, run + 1, w), a, b, run, v)
}

/**
 * The track with a step put into run `run` where it passes `at` (measured along the run): the line turns there,
 * goes one cell sideways, and carries on. The part nearer the first component stays where it was, unless it is the
 * part that arrives at the second, which cannot move. A straight line between two facing sides becomes a step
 * between them when an end has room to slide, and a detour of three runs when neither has.
 */
export function addBend(t: Track, a: NodeT, b: NodeT, run: number, at: number): Track {
  const L = coordsOf(t, a, b), m = t.runs.length, v = L[run], c = r3(Math.round(at * 4) / 4)
  // towards the next run that goes the same way, so the step shortens the line rather than lengthening it
  const dir = (to: number | undefined) => (to !== undefined && !same(to, v) ? Math.sign(to - v) : 1)
  if (m === 0) {
    const cb = centreOn(b, t.toSide), ca = centreOn(a, t.fromSide)
    for (const d of [1, -1, 0.5, -0.5]) {
      if (Math.abs(v + d - cb) <= reach(b) + 1e-9) return { ...t, toAt: r3(v + d - cb), runs: [c] }
      if (Math.abs(v + d - ca) <= reach(a) + 1e-9) return { ...t, fromAt: r3(v + d - ca), runs: [c] }
    }
    return { ...t, runs: [c - 0.5, v + 1, c + 0.5] }
  }
  if (run >= m + 1) return { ...t, runs: [...t.runs, r3(v + dir(L[run - 2])), c] }
  if (run <= 0) return { ...t, runs: [c, r3(v + dir(L[2])), ...t.runs] }
  return { ...t, runs: [...t.runs.slice(0, run), c, r3(v + dir(L[run + 2])), ...t.runs.slice(run)] }
}

/**
 * The track with the turn between run `run` and the next taken out, by bringing the shorter of the two runs that
 * meet there down to nothing: the run beyond it comes level with the one before. Null when neither can give way,
 * which is when both belong to the components and neither end can slide far enough.
 */
export function removeBend(t: Track, a: NodeT, b: NodeT, run: number): Track | null {
  const L = coordsOf(t, a, b), last = L.length - 1
  if (run < 0 || run + 1 > last) return null
  // run k has no length once its neighbours k-1 and k+1 stand on the same line
  const len = (k: number) => (k - 1 >= 0 && k + 1 <= last ? Math.abs(L[k + 1] - L[k - 1]) : Infinity)
  const tries = len(run) <= len(run + 1) ? [run, run + 1] : [run + 1, run]
  for (const k of tries) {
    if (len(k) === Infinity) continue
    // the neighbour on the far side of the turn comes to the one on the near side; if that cannot be, the other way about
    const pairs = k === run ? [[k + 1, k - 1], [k - 1, k + 1]] : [[k - 1, k + 1], [k + 1, k - 1]]
    for (const [move, to] of pairs) {
      const next = simplify(dragRun(t, a, b, move, L[to]), a, b)
      if (next.runs.length < t.runs.length) return next
    }
  }
  return null
}

/** Take out every turn that no longer does anything: two runs on the same line with nothing between them become one. */
export function simplify(t: Track, a: NodeT, b: NodeT): Track {
  let runs = [...t.runs]
  for (let guard = 0; guard < 64; guard++) {
    const L = [centreOn(a, t.fromSide) + t.fromAt, ...runs, centreOn(b, t.toSide) + t.toAt], m = runs.length
    const k = L.findIndex((v, i) => i + 2 <= m + 1 && same(v, L[i + 2]))
    if (k < 0) break
    // run k+1 has no length. It goes, and so does one of the two it joined (never an end run: those belong to the components)
    if (m === 1) runs = []
    else if (k === 0) runs = runs.slice(2)
    else if (k + 2 === m + 1) runs = runs.slice(0, m - 2)
    else runs = [...runs.slice(0, k), ...runs.slice(k + 2)]
  }
  return { ...t, runs }
}

/** A connection carrying the given track. Anything that described its path another way is dropped. */
export const withTrack = (e: EdgeT, t: Track): EdgeT => {
  const { via: _v, shape: _s, plan: _p, ...rest } = e
  return { ...rest, fromSide: t.fromSide, toSide: t.toSide, fromAt: t.fromAt, toAt: t.toAt, runs: t.runs }
}

/** A connection with no path of its own: the router decides. Its drawing style (`shape`) is kept unless asked otherwise. */
export const unshaped = (e: EdgeT, keepShape = true): EdgeT => {
  const { via: _v, runs: _r, fromAt: _a, toAt: _b, fromSide: _f, toSide: _t, plan: _p, shape, ...rest } = e
  return keepShape && shape ? { ...rest, shape } : rest
}

/** Its path is the user's: the router follows it rather than planning one. */
export const isManual = (e: EdgeT) => !!(e.runs || e.via?.length)

/**
 * Take over each of these connections exactly as it is drawn now: the path the router planned becomes the
 * connection's own, to be kept from then on. Nothing moves. Lines that are not right-angled have no path to keep.
 */
export function keepPath(doc: Doc, ids: string[]): Doc {
  const routes = routeAll(doc.nodes, doc.edges), byId = new Map(doc.nodes.map((n) => [n.id, n]))
  let any = false
  const edges = doc.edges.map((e) => {
    const r = routes.get(e.id), a = byId.get(e.from), b = byId.get(e.to)
    const t = ids.includes(e.id) && !e.runs && r && a && b ? trackOf(r, a, b) : null
    if (t) any = true
    return t ? withTrack(e, t.track) : e
  })
  return any ? { ...doc, edges } : doc
}

/** Which stretch of a drawn line a point on the ground is nearest to. */
export function nearestRun(pts: [number, number][], at: [number, number]): number {
  let best = 0, least = Infinity
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, ay] = pts[i], [bx, by] = pts[i + 1], dx = bx - ax, dy = by - ay
    const t = Math.max(0, Math.min(1, ((at[0] - ax) * dx + (at[1] - ay) * dy) / (dx * dx + dy * dy || 1)))
    const d = Math.hypot(at[0] - ax - dx * t, at[1] - ay - dy * t)
    if (d < least) { least = d; best = i }
  }
  return best
}

/** The connection as drawn, with what is needed to reshape it; null when it is not a right-angled line between two components. */
function drawn(doc: Doc, id: string) {
  const e = doc.edges.find((x) => x.id === id), a = e && doc.nodes.find((n) => n.id === e.from), b = e && doc.nodes.find((n) => n.id === e.to)
  const r = e && routeAll(doc.nodes, doc.edges).get(id), t = r && a && b ? trackOf(r, a, b) : null
  return e && a && b && r && t ? { e, a, b, r, ...t } : null
}
const replaced = (doc: Doc, e: EdgeT): Doc => ({ ...doc, edges: doc.edges.map((x) => (x.id === e.id ? e : x)) })

/** Put a step into a connection at the point of its line nearest `at`. */
export function bendAt(doc: Doc, id: string, at: [number, number]): Doc {
  const d = drawn(doc, id)
  if (!d) return doc
  const i = nearestRun(d.r.pts, at), p = d.r.pts[i], q = d.r.pts[i + 1], along = p[1] === q[1] ? 0 : 1
  // not so near either end of the stretch that the step would sit on a turn
  const lo = Math.min(p[along], q[along]), hi = Math.max(p[along], q[along])
  if (hi - lo < 1) return doc
  return replaced(doc, withTrack(d.e, addBend(d.track, d.a, d.b, d.seg[i], Math.max(lo + 0.5, Math.min(hi - 0.5, at[along])))))
}

/** Take the turn at point `corner` of a connection's drawn line out of it. */
export function unbend(doc: Doc, id: string, corner: number): Doc {
  const d = drawn(doc, id)
  if (!d || corner < 1 || corner > d.r.pts.length - 2 || d.seg[corner - 1] === d.seg[corner]) return doc
  const next = removeBend(d.track, d.a, d.b, d.seg[corner - 1])
  return next ? replaced(doc, withTrack(d.e, next)) : doc
}

/** There is something to hand back to the router: a path the user gave it, or one planned earlier that could be planned again. */
export const canReroute = (e: EdgeT) => isShaped(e) || !!e.plan

export const isShaped = (e: EdgeT) => !!(e.via?.length || e.runs || e.fromSide || e.toSide || e.fromAt !== undefined || e.toAt !== undefined)

/** A shaped connection moved bodily by (dx, dy), as when both its components are carried together. */
export function shifted(e: EdgeT, dx: number, dy: number): EdgeT {
  if (!e.via && !e.runs) return e
  const first = e.fromSide && horizontal(e.fromSide)
  return {
    ...e,
    ...(e.via ? { via: e.via.map(([x, y]) => [x + dx, y + dy] as [number, number]) } : {}),
    // the run after one that travels along x stands at an x, the one after that at a y, and so on
    ...(e.runs && e.fromSide ? { runs: e.runs.map((v, i) => r3(v + ((i % 2 === 0) === first ? dx : dy))) } : {}),
  }
}

export type Straightness =
  /** it is one straight line already */
  | { state: 'straight' }
  /** one action away from straight, as things stand; `through` when that line would pass under something standing between them */
  | { state: 'can'; through: boolean }
  /** the two components do not line up: `move` is the one that would be moved to make them, by (dx, dy) */
  | { state: 'apart'; move: string; dx: number; dy: number }

/** What stands between a connection and being one straight line. */
export function straightness(doc: Doc, e: EdgeT, routed?: Routed): Straightness {
  const a = doc.nodes.find((n) => n.id === e.from), b = doc.nodes.find((n) => n.id === e.to)
  if (!a || !b || e.shape === 'direct') return { state: 'straight' }
  const r = routed ?? routeAll(doc.nodes, doc.edges).get(e.id)
  if (r && r.shape === 'ortho' && r.pts.length === 2) return { state: 'straight' }
  const plan = straightBetween(a, b, doc.nodes)
  if (plan !== 'apart') return { state: 'can', through: !plan.clear }
  // the one with less hanging off it gives way, along whichever axis it has less far to go
  const degree = (id: string) => doc.edges.filter((x) => x.from === id || x.to === id).length
  const mover = degree(a.id) < degree(b.id) ? a : b, other = mover === a ? b : a
  const [mx, my] = centerOf(mover), [ox, oy] = centerOf(other)
  const half = (v: number) => Math.round(v * 2) / 2
  // keep them apart along the line, level across it
  const alongX = Math.abs(ox - mx) >= Math.abs(oy - my)
  return { state: 'apart', move: mover.id, dx: alongX ? 0 : half(ox - mx), dy: alongX ? half(oy - my) : 0 }
}

/**
 * Make each of these connections one straight line where it can be, even if that takes it under
 * something standing between its ends: it was asked for. Where the two ends do not line up at all,
 * the line is handed back to the router, which draws it with as few turns as there can be.
 */
export function straighten(doc: Doc, ids: string[]): { doc: Doc; straight: number; apart: number } {
  let straight = 0, apart = 0
  const byId = new Map(doc.nodes.map((n) => [n.id, n]))
  const edges = doc.edges.map((e) => {
    if (!ids.includes(e.id)) return e
    const a = byId.get(e.from), b = byId.get(e.to)
    if (!a || !b) return e
    const plan = straightBetween(a, b, doc.nodes)
    if (plan === 'apart') { apart++; return isShaped(e) || e.shape === 'curved' ? unshaped(e, false) : e }
    straight++
    return withTrack(e, { fromSide: plan.fromSide, toSide: plan.toSide, fromAt: plan.fromAt, toAt: plan.toAt, runs: [] })
  })
  return { doc: { ...doc, edges }, straight, apart }
}

/** Move one end's component level with the other so the connection can be straight, and make it so. */
export function lineUpEnds(doc: Doc, id: string): Doc {
  const e = doc.edges.find((x) => x.id === id)
  const s = e && straightness(doc, e)
  if (!e || !s || s.state !== 'apart') return e ? straighten(doc, [id]).doc : doc
  const mover = doc.nodes.find((n) => n.id === s.move)!
  // it never lands on another component: the nearest free place to where it was heading
  const [dx, dy] = clearOf([mover], doc.nodes.filter((n) => n.id !== mover.id), s.dx, s.dy, 0.5)
  const moved = { ...doc, nodes: doc.nodes.map((n) => (n.id === mover.id ? { ...n, x: n.x + dx, y: n.y + dy } : n)) }
  return straighten(moved, [id]).doc
}
