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
/** how far past the corner an end run is pulled before it lets go of the side and steps round */
const PULL = 0.7

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
const all = (t: Track, a: NodeT, b: NodeT) => [centreOn(a, t.fromSide) + t.fromAt, ...t.runs, centreOn(b, t.toSide) + t.toAt]

/** The band a single straight run between two facing sides can lie in, or null when they do not overlap. */
function band(t: Track, a: NodeT, b: NodeT): [number, number] | null {
  const ca = centreOn(a, t.fromSide), cb = centreOn(b, t.toSide)
  const lo = Math.max(ca - reach(a), cb - reach(b)), hi = Math.min(ca + reach(a), cb + reach(b))
  return lo <= hi + 1e-9 ? [lo, hi] : null
}

/**
 * Where a run being dragged should come to rest. It is drawn to anything it would line up with:
 * the next run along on the same axis (which is what straightens a line), and the middle of the
 * component at its end. Otherwise it keeps to the grid.
 */
export function snapRun(t: Track, a: NodeT, b: NodeT, run: number, v: number, pull = 0.3): number {
  const L = all(t, a, b), last = L.length - 1
  const marks: number[] = []
  if (run - 2 >= 0) marks.push(L[run - 2])
  if (run + 2 <= last) marks.push(L[run + 2])
  if (run === 0) marks.push(centreOn(a, t.fromSide))
  if (run === last) marks.push(centreOn(b, t.toSide))
  if (last === 1 && facingEachOther(t)) marks.push(centreOn(a, t.fromSide), centreOn(b, t.toSide))
  let best = NaN
  for (const m of marks) if (Math.abs(m - v) <= pull && !(Math.abs(best - v) <= Math.abs(m - v))) best = m
  if (!Number.isNaN(best)) return best
  const step = run === 0 || run === last ? 0.25 : 0.5
  return Math.round(v / step) * step
}

/** The track with run `run` moved sideways to `v`. Run 0 is the one that leaves the first component. */
export function dragRun(t: Track, a: NodeT, b: NodeT, run: number, v: number): Track {
  const m = t.runs.length, ca = centreOn(a, t.fromSide), cb = centreOn(b, t.toSide)
  const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x))
  if (m === 0 && facingEachOther(t)) {
    // one straight run: it slides along both sides at once, and past the end of either it becomes a way round
    const I = band(t, a, b)
    if (I && v >= I[0] - PULL && v <= I[1] + PULL) { const c = clamp(v, I[0], I[1]); return { ...t, fromAt: r3(c - ca), toAt: r3(c - cb) } }
    return { ...t, runs: [beside(a, t.fromSide, STUB), v, beside(b, t.toSide, STUB)] }
  }
  // An end run heading for the next run along (to take the turn between them out) may find its side ends first.
  // Then that run comes the rest of the way to meet it: what was wanted was the two on one line, not either in a particular place
  const L = all(t, a, b)
  if (run <= 0) {
    if (v < ca - reach(a) - PULL || v > ca + reach(a) + PULL) return { ...t, runs: [beside(a, t.fromSide, STUB), v, ...t.runs] }
    const c = clamp(v, ca - reach(a), ca + reach(a)), next = { ...t, fromAt: r3(c - ca) }
    if (same(c, v) || !m || !same(v, L[2])) return next
    if (m > 1) return { ...next, runs: t.runs.map((x, i) => (i === 1 ? c : x)) }
    return Math.abs(c - cb) <= reach(b) + 1e-9 ? { ...next, toAt: r3(c - cb) } : next
  }
  if (run >= m + 1) {
    if (v < cb - reach(b) - PULL || v > cb + reach(b) + PULL) return { ...t, runs: [...t.runs, v, beside(b, t.toSide, STUB)] }
    const c = clamp(v, cb - reach(b), cb + reach(b)), next = { ...t, toAt: r3(c - cb) }
    if (same(c, v) || !m || !same(v, L[m - 1])) return next
    if (m > 1) return { ...next, runs: t.runs.map((x, i) => (i === m - 2 ? c : x)) }
    return Math.abs(c - ca) <= reach(a) + 1e-9 ? { ...next, fromAt: r3(c - ca) } : next
  }
  const runs = [...t.runs]
  runs[run - 1] = v
  // the first and last turn stay outside the components they belong to
  runs[0] = outward(a, t.fromSide, runs[0])
  runs[m - 1] = outward(b, t.toSide, runs[m - 1])
  return { ...t, runs }
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
  const { via: _v, shape: _s, ...rest } = e
  return { ...rest, fromSide: t.fromSide, toSide: t.toSide, fromAt: t.fromAt, toAt: t.toAt, runs: t.runs }
}

/** A connection with no path of its own: the router decides. Its drawing style (`shape`) is kept unless asked otherwise. */
export const unshaped = (e: EdgeT, keepShape = true): EdgeT => {
  const { via: _v, runs: _r, fromAt: _a, toAt: _b, fromSide: _f, toSide: _t, shape, ...rest } = e
  return keepShape && shape ? { ...rest, shape } : rest
}

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
