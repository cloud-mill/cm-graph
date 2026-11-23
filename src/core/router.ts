import { type Doc, type EdgeT, type NodeT, type Side, footOf } from './types'

/**
 * Connection routing on the ground plane.
 *
 * Every connection leaves a component from a port on one of its four sides and
 * arrives at a port on a side of the other, travelling in right-angled runs.
 *
 *  - Sides are picked to face where the line is going, unless the user pinned one.
 *  - Lines that share a side are spread along it, ordered by where they lead, so
 *    they fan out instead of piling onto one point and crossing at the door.
 *  - Between the ports an automatic route finds the shortest path with the
 *    fewest turns that does not pass through any component.
 *  - Two sides that face each other are joined by one straight run whenever their
 *    ports can be slid to meet: a line is never left with a kink it has no need of.
 *  - A route the user has shaped is theirs. It is kept as a track (the position of
 *    each run), so when a component moves the runs next to it stretch and the rest
 *    stay exactly where they were put. It is never re-planned behind their back.
 *  - A line can also be drawn direct (one straight line, at any angle) or curved.
 *
 * Everything here is pure and deterministic: the same diagram always gives the
 * same lines, so nothing jumps about between redraws. (`findPath` remembers
 * answers it has given, but only ever to give the same answer again.)
 *
 * This module decides where lines go, in cells on the ground. Turning a route
 * into an SVG path is `core/linePath`; reshaping one by hand is `core/shape`.
 */

/** A point on the ground, in cells. */
export type W = [number, number]

/** One connection as it is to be drawn. */
export interface Routed {
  /** ground points in cells, from the port on the first component to the port on the second */
  pts: W[]
  /** for each run pts[i] → pts[i+1]: which stretch between waypoints it belongs to (0 = before the first waypoint) */
  leg: number[]
  fromSide: Side
  toSide: Side
  /** following a shape the user gave it (a track, or an older file's points), not one the router chose. False when a track could not be followed and the router stood in */
  manual: boolean
  /** right-angled runs through `pts`; one straight line between two points; or a curve whose `pts` are its start, two control points and end */
  shape: 'ortho' | 'direct' | 'curved'
}

interface Rect { x0: number; y0: number; x1: number; y1: number }
type Box = Pick<NodeT, 'x' | 'y' | 'scale'>

const DIR: Record<Side, W> = { n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0] }
/** how far a line runs straight out of a port before it may turn, in cells */
export const STUB = 0.5
/** the room a route keeps from components it passes, in cells */
const CLEAR = 0.3
/** what one turn costs an automatic route, in cells of extra length: it goes about this much further to save one */
const BEND = 1.6

const rectOf = (n: Box): Rect => { const s = footOf(n); return { x0: n.x, y0: n.y, x1: n.x + s, y1: n.y + s } }
const mid = (r: Rect): W => [(r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2]
const horizontal = (s: Side) => s === 'e' || s === 'w'
// every coordinate a route is made of is kept to a thousandth of a cell, so two that should be equal compare equal
const r3 = (v: number) => Math.round(v * 1000) / 1000

/**
 * The side of `r` that faces the point `t`. When the other component's rectangle is given, neighbours side by side
 * use left/right and stacked ones use top/bottom, however far off-centre they are; otherwise it is the side towards
 * `t` along whichever axis `t` is further from the middle of `r`.
 */
export function facing(r: Rect, t: W, other?: Rect): Side {
  const [cx, cy] = mid(r), dx = t[0] - cx, dy = t[1] - cy
  if (other) {
    const overlapY = Math.min(r.y1, other.y1) - Math.max(r.y0, other.y0), overlapX = Math.min(r.x1, other.x1) - Math.max(r.x0, other.x0)
    if (overlapY > 0 && overlapX <= 0) return dx >= 0 ? 'e' : 'w'
    if (overlapX > 0 && overlapY <= 0) return dy >= 0 ? 's' : 'n'
  }
  return Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? 'e' : 'w') : dy >= 0 ? 's' : 'n'
}

/** A point on a side of a rectangle, `offset` along it from the middle. */
function portAt(r: Rect, side: Side, offset: number, out = 0): W {
  const [cx, cy] = mid(r)
  if (side === 'e') return [r.x1 + out, cy + offset]
  if (side === 'w') return [r.x0 - out, cy + offset]
  if (side === 's') return [cx + offset, r.y1 + out]
  return [cx + offset, r.y0 - out]
}

/** Drop repeated points and the middle of any three in a row along one line. */
export function tidy(pts: W[]): W[] {
  const out: W[] = []
  for (const p of pts) {
    const q: W = [r3(p[0]), r3(p[1])]
    const a = out[out.length - 1]
    if (a && a[0] === q[0] && a[1] === q[1]) continue
    const b = out[out.length - 2]
    if (a && b && ((b[0] === a[0] && a[0] === q[0]) || (b[1] === a[1] && a[1] === q[1])) && between(b, a, q)) { out[out.length - 1] = q; continue }
    out.push(q)
  }
  return out
}
const between = (b: W, a: W, q: W) => (a[0] - b[0]) * (q[0] - a[0]) >= 0 && (a[1] - b[1]) * (q[1] - a[1]) >= 0

// ---- automatic routing ---------------------------------------------------------------

// two generations: when the young one fills up it becomes the old one, so routes still in use are never all forgotten at once
let cache = new Map<string, W[]>(), aged = new Map<string, W[]>()

/**
 * Shortest right-angled path from `s` (heading `sd`) to `t` (arriving along `td`)
 * that keeps clear of `blocks`. `lane` shifts the preferred middle channel so
 * parallel lines between the same two components do not lie on top of each other.
 *
 * `sd` and `td` are unit steps along an axis, `td` being the way the line is
 * travelling as it arrives. The result starts at `s` and ends at `t`. The search
 * is A* over a sparse grid: the lines through the two ends, the middle channel,
 * and one line `STUB` outside each side of every nearby component.
 */
export function findPath(s: W, sd: W, t: W, td: W, blocks: Rect[], lane = 0): W[] {
  // only components that reach within three cells of the box round the two ends are looked at: it keeps the search and the cache key small
  const lo: W = [Math.min(s[0], t[0]) - 3, Math.min(s[1], t[1]) - 3], hi: W = [Math.max(s[0], t[0]) + 3, Math.max(s[1], t[1]) + 3]
  const near = blocks.filter((b) => b.x1 > lo[0] && b.x0 < hi[0] && b.y1 > lo[1] && b.y0 < hi[1])
  // the same arrangement anywhere on the ground has the same route, so it is remembered relative to where it starts:
  // a whole group carried across the canvas costs nothing to re-route
  const onGrid = (v: number) => Math.abs(v * 2 - Math.round(v * 2)) < 1e-6
  const gx = onGrid(s[0]) && onGrid(t[0]), gy = onGrid(s[1]) && onGrid(t[1])
  const key = [r3(t[0] - s[0]), r3(t[1] - s[1]), sd, td, lane, gx, gy, near.map((b) => [r3(b.x0 - s[0]), r3(b.y0 - s[1]), r3(b.x1 - s[0]), r3(b.y1 - s[1])])].join('|')
  const hit = cache.get(key) ?? aged.get(key)
  if (hit) { cache.set(key, hit); return hit.map((q) => [r3(q[0] + s[0]), r3(q[1] + s[1])] as W) }

  // the middle channel sits on the half-cell grid when the ends do; while something is being dragged between
  // grid positions it follows smoothly instead, so the elbow glides with the component and does not tick
  const midOf = (a: number, b: number, grid: boolean) => (grid ? Math.round(((a + b) / 2) * 2) / 2 : (a + b) / 2)
  const mx = r3(midOf(s[0], t[0], gx) + lane * 0.4), my = r3(midOf(s[1], t[1], gy) + lane * 0.4)
  const xsSet = new Set<number>([s[0], t[0], mx]), ysSet = new Set<number>([s[1], t[1], my])
  for (const b of near) { xsSet.add(r3(b.x0 - STUB)); xsSet.add(r3(b.x1 + STUB)); ysSet.add(r3(b.y0 - STUB)); ysSet.add(r3(b.y1 + STUB)) }
  const xs = [...xsSet].sort((a, b) => a - b), ys = [...ysSet].sort((a, b) => a - b)
  const nx = xs.length, ny = ys.length
  // which hops between neighbouring grid lines are blocked by a component (with its clearance)
  const hBlock = new Uint8Array(nx * ny), vBlock = new Uint8Array(nx * ny)
  for (const b of near) {
    const x0 = b.x0 - CLEAR, x1 = b.x1 + CLEAR, y0 = b.y0 - CLEAR, y1 = b.y1 + CLEAR
    for (let j = 0; j < ny; j++) {
      const inY = ys[j] > y0 && ys[j] < y1
      for (let i = 0; i < nx; i++) {
        // hop right from (i, j): blocked if the row is inside the box and the hop overlaps it sideways
        if (inY && i + 1 < nx && xs[i] < x1 && xs[i + 1] > x0) hBlock[j * nx + i] = 1
        if (xs[i] > x0 && xs[i] < x1 && j + 1 < ny && ys[j] < y1 && ys[j + 1] > y0) vBlock[j * nx + i] = 1
      }
    }
  }
  const si = xs.indexOf(s[0]), sj = ys.indexOf(s[1]), ti = xs.indexOf(t[0]), tj = ys.indexOf(t[1])
  // state: grid point × direction of arrival (0 right, 1 down, 2 left, 3 up)
  const D: W[] = [[1, 0], [0, 1], [-1, 0], [0, -1]]
  const dirOf = (d: W) => D.findIndex((q) => q[0] === d[0] && q[1] === d[1])
  const startDir = dirOf(sd), endDir = dirOf(td)
  const N = nx * ny * 4
  const cost = new Float64Array(N).fill(Infinity), prev = new Int32Array(N).fill(-1)
  const id = (i: number, j: number, d: number) => (j * nx + i) * 4 + d
  const h = (i: number, j: number) => Math.abs(xs[i] - t[0]) + Math.abs(ys[j] - t[1])
  // a small binary heap of [priority, order, state]
  const heap: [number, number, number][] = []
  let order = 0
  const push = (p: number, st: number) => { heap.push([p, order++, st]); let c = heap.length - 1; while (c > 0) { const q = (c - 1) >> 1; if (less(heap[c], heap[q])) { [heap[c], heap[q]] = [heap[q], heap[c]]; c = q } else break } }
  const less = (a: [number, number, number], b: [number, number, number]) => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1])
  const pop = () => {
    const top = heap[0], last = heap.pop()!
    if (heap.length) { heap[0] = last; let c = 0; for (;;) { const l = c * 2 + 1, r = l + 1; let m = c; if (l < heap.length && less(heap[l], heap[m])) m = l; if (r < heap.length && less(heap[r], heap[m])) m = r; if (m === c) break; [heap[c], heap[m]] = [heap[m], heap[c]]; c = m } }
    return top
  }
  const start = id(si, sj, startDir)
  cost[start] = 0
  push(h(si, sj), start)
  let goal = -1
  while (heap.length) {
    const [, , st] = pop()
    const d = st % 4, cell = (st - d) / 4, i = cell % nx, j = (cell - i) / nx
    if (i === ti && j === tj) { goal = st; break }
    const g = cost[st]
    for (let nd = 0; nd < 4; nd++) {
      if ((nd + 2) % 4 === d) continue // no doubling back
      const ni = i + D[nd][0], nj = j + D[nd][1]
      if (ni < 0 || nj < 0 || ni >= nx || nj >= ny) continue
      const blocked = nd === 0 ? hBlock[j * nx + i] : nd === 2 ? hBlock[j * nx + ni] : nd === 1 ? vBlock[j * nx + i] : vBlock[nj * nx + i]
      if (blocked) continue
      let c = g + Math.abs(xs[ni] - xs[i]) + Math.abs(ys[nj] - ys[j])
      // a turn costs, and among equal routes the one that turns nearest the middle wins: that is what keeps lines tidy and stable
      if (nd !== d) c += BEND + 0.02 * (Math.abs(xs[i] - mx) + Math.abs(ys[j] - my))
      // turning the moment it leaves a port makes a line hug its own component: dearer than a turn out in the open
      if (nd !== d && i === si && j === sj) c += BEND * 0.6
      // arriving the wrong way round means one more turn right at the door, which reads worse than one in the open
      if (ni === ti && nj === tj && nd !== endDir) c += BEND * 1.6
      const ns = id(ni, nj, nd)
      if (c < cost[ns] - 1e-9) { cost[ns] = c; prev[ns] = st; push(c + h(ni, nj), ns) }
    }
  }
  let out: W[]
  if (goal < 0) {
    // boxed in: fall back to a plain elbow rather than no line at all
    out = sd[0] !== 0 ? [s, [t[0], s[1]], t] : [s, [s[0], t[1]], t]
  } else {
    out = []
    for (let st = goal; st >= 0; st = prev[st]) { const cell = (st - (st % 4)) / 4, i = cell % nx; out.push([xs[i], ys[(cell - i) / nx]]) }
    out.reverse()
  }
  out = tidy(out)
  if (cache.size > 3000) { aged = cache; cache = new Map() }
  // what is handed back is what the memory of it would hand back, so the same question always has the same answer,
  // the first time it is asked and every time after: a line must not shift by a hair between a drag and its release
  const rel = out.map((q) => [r3(q[0] - s[0]), r3(q[1] - s[1])] as W)
  cache.set(key, rel)
  return rel.map((q) => [r3(q[0] + s[0]), r3(q[1] + s[1])] as W)
}

// ---- whole diagram ---------------------------------------------------------------------

/**
 * One end of a connection while the diagram is being routed.
 *  - `toward`: where the line is heading, as a coordinate along the side. Ends sharing a side are ordered by it.
 *  - `port`: where the line touches the side. `out`: the point `STUB` straight out from there, where path finding starts.
 *  - `at`: set when the end already has a place (the user put it there, or its plan stands), in cells from the middle of the side.
 *  - `lane`: this end's turn among those sharing the side, centred on 0. `mates`: how many share it. `list`: all of them, in order.
 */
interface End { edge: string; node: string; side: Side; toward: number; port: W; out: W; lane: number; at?: number; mates: number; list: End[] }

/** how close to a corner of its component a line may leave a side, in cells */
export const EDGE = 0.15
/** the least a shaped line runs out of a side before it turns, in cells */
export const MIN_OUT = 0.3
/** how far from the middle of a side, as a share of the side, the router slides a port of its own accord to save a line two turns */
const SLIDE = 0.3
/** the room two ports on one side keep between them when one is slid, in cells */
const APART = 0.2

const centreOn = (r: Rect, s: Side) => (horizontal(s) ? (r.y0 + r.y1) / 2 : (r.x0 + r.x1) / 2)
const across = (s: Side, p: W) => (horizontal(s) ? p[1] : p[0])
const opposite = (a: Side, b: Side) => DIR[a][0] + DIR[b][0] === 0 && DIR[a][1] + DIR[b][1] === 0
/** `rb` lies wholly beyond side `s` of `ra` */
const beyond = (ra: Rect, s: Side, rb: Rect) => (s === 'e' ? rb.x0 > ra.x1 : s === 'w' ? rb.x1 < ra.x0 : s === 's' ? rb.y0 > ra.y1 : rb.y1 < ra.y0)
/** how far the port at this end is out from its side, measured to `p` */
const outBy = (r: Rect, s: Side, p: W) => (s === 'e' ? p[0] - r.x1 : s === 'w' ? r.x0 - p[0] : s === 's' ? p[1] - r.y1 : r.y0 - p[1])
/**
 * Stand an end on the line `c` across its side. The coordinate across the side is `c` itself, not the middle of the component plus
 * a rounded offset: a middle can have more decimals than a port is kept to, and two ends put on one line must come out on one line.
 */
const put = (end: End, r: Rect, c: number) => {
  const off = c - centreOn(r, end.side), on = (p: W): W => (horizontal(end.side) ? [r3(p[0]), r3(c)] : [r3(c), r3(p[1])])
  end.port = on(portAt(r, end.side, off)); end.out = on(portAt(r, end.side, off, STUB))
}

/** Nothing but the two components themselves stands on the straight run from `p` to `q`. */
function clearRun(p: W, q: W, blocks: Rect[], skip: Rect[]): boolean {
  const x0 = Math.min(p[0], q[0]), x1 = Math.max(p[0], q[0]), y0 = Math.min(p[1], q[1]), y1 = Math.max(p[1], q[1])
  return blocks.every((b) => skip.includes(b) || !(b.x1 + CLEAR > x0 && b.x0 - CLEAR < x1 && b.y1 + CLEAR > y0 && b.y0 - CLEAR < y1))
}

/** Where the straight line from the middle of `r` towards `t` leaves it. */
function exitOf(r: Rect, t: W): W {
  const [cx, cy] = mid(r), dx = t[0] - cx, dy = t[1] - cy
  if (!dx && !dy) return [cx, cy]
  const k = Math.min(dx ? (r.x1 - r.x0) / 2 / Math.abs(dx) : Infinity, dy ? (r.y1 - r.y0) / 2 / Math.abs(dy) : Infinity)
  return [r3(cx + dx * k), r3(cy + dy * k)]
}

/**
 * A line along the track the user gave it: out of `a`, along each run in turn, into `b`.
 * Nothing here is planned: the only liberty taken is to keep the first and last turn outside
 * the components they belong to. When the components have moved so far that the track no
 * longer makes a line at all (it would have to start inside one of them), there is no answer.
 */
function tracked(a: End, b: End, ra: Rect, rb: Rect, runs: number[]): W[] | null {
  const m = runs.length, h0 = horizontal(a.side)
  // runs alternate, so between two sides on the same axis there is an odd number of them, and an even number otherwise
  if ((m % 2 === 1) !== (h0 === horizontal(b.side))) return null
  const c = [...runs]
  const outward = (r: Rect, s: Side, v: number) => (s === 'e' ? Math.max(v, r.x1 + MIN_OUT) : s === 'w' ? Math.min(v, r.x0 - MIN_OUT) : s === 's' ? Math.max(v, r.y1 + MIN_OUT) : Math.min(v, r.y0 - MIN_OUT))
  if (m) { c[0] = outward(ra, a.side, c[0]); c[m - 1] = outward(rb, b.side, c[m - 1]) }
  const pts: W[] = [a.port]
  let cur = a.port, h = h0
  for (const v of c) { cur = h ? [v, cur[1]] : [cur[0], v]; pts.push(cur); h = !h }
  pts.push(h ? [b.port[0], cur[1]] : [cur[0], b.port[1]], b.port)
  if (outBy(ra, a.side, pts[1]) < MIN_OUT - 1e-6 || outBy(rb, b.side, pts[pts.length - 2]) < MIN_OUT - 1e-6) return null
  return pts
}

/**
 * What a plan was made for. While this still describes the connection and its two components, the plan stands.
 * It covers which two components the line joins, where each stands and how big it is, and anything the user pinned
 * (a side, or a place along one). It leaves out everything else on purpose: other components, other connections and
 * the line's own look do not make a plan stale, so a path is not re-planned because of something that happened elsewhere.
 */
export function planKey(e: EdgeT, a: Box, b: Box): string {
  return [e.from, a.x, a.y, footOf(a), e.to, b.x, b.y, footOf(b), e.fromSide ?? '', e.toSide ?? '', e.fromAt ?? '', e.toAt ?? ''].join(',')
}
/** The router owns this line's path: it is right-angled and the user has not given it a track of their own. */
export const routerOwns = (e: EdgeT) => !e.shape && !e.runs && !e.via?.length

/**
 * The diagram with every line the router owns carrying the path planned for it. A line whose plan still stands is
 * not touched, so a path once planned stays as it is until one of its own two components moves or changes size.
 * This is what makes automatic routing something that happens once, when it is called for, and not a process that
 * keeps running behind the user's back.
 *
 * Returns the same `doc` when no plan is missing or stale, and the same connection objects for lines it leaves alone.
 * Lines planned in the same pass are routed together, and an end whose plan stands keeps its place on its side.
 */
export function withPlans(doc: Doc): Doc {
  const byId = new Map(doc.nodes.map((n) => [n.id, n]))
  const stale = (e: EdgeT) => { const a = byId.get(e.from), b = byId.get(e.to); return !!a && !!b && e.from !== e.to && routerOwns(e) && e.plan?.key !== planKey(e, a, b) }
  if (!doc.edges.some(stale)) return doc
  const routes = routeAll(doc.nodes, doc.edges)
  return {
    ...doc,
    edges: doc.edges.map((e) => {
      const r = stale(e) ? routes.get(e.id) : null
      return r ? { ...e, plan: { pts: r.pts, fromSide: r.fromSide, toSide: r.toSide, key: planKey(e, byId.get(e.from)!, byId.get(e.to)!) } } : e
    }),
  }
}

/**
 * Routes for every connection in the diagram, keyed by connection id. A connection with a missing end, or from a
 * component to itself, has no route.
 *
 * This is what draws, and it reads plans without writing them: a line whose plan still stands is drawn exactly as
 * planned, and one whose plan is stale or missing is routed here and now. That is how a line follows a component
 * while it is being dragged, before `withPlans` stores the new path on release.
 */
export function routeAll(nodes: NodeT[], edges: EdgeT[]): Map<string, Routed> {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const rects = new Map(nodes.map((n) => [n.id, rectOf(n)]))
  const live = edges.filter((e) => byId.has(e.from) && byId.has(e.to) && e.from !== e.to)
  const sided = live.filter((e) => e.shape !== 'direct')
  const viaOf = (e: EdgeT) => (e.shape || e.runs ? [] : e.via ?? [])
  // a plan that still stands is the line: it is drawn as it was planned, whatever has happened elsewhere since
  const plans = new Map<string, NonNullable<EdgeT['plan']>>()
  for (const e of sided) if (routerOwns(e) && e.plan && e.plan.pts.length >= 2 && e.plan.key === planKey(e, byId.get(e.from)!, byId.get(e.to)!)) plans.set(e.id, e.plan)

  // 1. which side each end uses
  const ends = new Map<string, { a: End; b: End }>()
  for (const e of sided) {
    const ra = rects.get(e.from)!, rb = rects.get(e.to)!
    const via = viaOf(e), plan = plans.get(e.id)
    const ta = via.length ? via[0] : mid(rb), tb = via.length ? via[via.length - 1] : mid(ra)
    const sa = plan?.fromSide ?? e.fromSide ?? facing(ra, ta, via.length ? undefined : rb), sb = plan?.toSide ?? e.toSide ?? facing(rb, tb, via.length ? undefined : ra)
    const along = (s: Side, t: W) => (horizontal(s) ? t[1] : t[0])
    const at = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
    // an end whose plan stands sits where the plan put it, just as one the user placed sits where they put it
    const planned = (s: Side, r: Rect, p: W | undefined) => (p ? r3(across(s, p) - centreOn(r, s)) : undefined)
    ends.set(e.id, {
      a: { edge: e.id, node: e.from, side: sa, toward: along(sa, ta), port: [0, 0], out: [0, 0], lane: 0, at: planned(sa, ra, plan?.pts[0]) ?? at(e.fromAt), mates: 1, list: [] },
      b: { edge: e.id, node: e.to, side: sb, toward: along(sb, tb), port: [0, 0], out: [0, 0], lane: 0, at: planned(sb, rb, plan?.pts[plan.pts.length - 1]) ?? at(e.toAt), mates: 1, list: [] },
    })
  }

  // 2. ends that share a side are spread along it, in the order of where they lead. One the user placed sits where they put it
  const sides = new Map<string, End[]>()
  for (const { a, b } of ends.values()) for (const end of [a, b]) {
    const k = end.node + ':' + end.side
    ;(sides.get(k) ?? sides.set(k, []).get(k)!).push(end)
  }
  for (const list of sides.values()) {
    // ends that lead to the same place keep the order the connections were made in (the sort is stable), so a line being drawn,
    // which is the newest, is shown where it will be once it is let go and has an id of its own
    list.sort((p, q) => p.toward - q.toward)
    const r = rects.get(list[0].node)!, size = r.x1 - r.x0
    const gap = Math.min(0.5, (size * 0.76) / list.length)
    const centre = centreOn(r, list[0].side)
    const reach = size / 2 - EDGE
    // An end that is already somewhere (the user placed it, or its plan stands) stays there. The rest take the places along
    // the side that are still free, each the one nearest its own turn in the order, so no line is moved to make room for another
    const slot = (i: number) => centre + (i - (list.length - 1) / 2) * gap
    const fixed = list.filter((end) => end.at !== undefined).map((end) => centre + Math.max(-reach, Math.min(reach, end.at!)))
    const free = list.map((_, i) => slot(i)).filter((v) => !fixed.some((f) => Math.abs(f - v) < gap * 0.4))
    list.forEach((end, i) => {
      let c = slot(i)
      if (end.at !== undefined) c = centre + Math.max(-reach, Math.min(reach, end.at))
      else if (fixed.length && free.length) { const k = free.reduce((best, v, j) => (Math.abs(v - c) < Math.abs(free[best] - c) ? j : best), 0); c = free[k]; free.splice(k, 1) }
      put(end, r, c)
      end.mates = list.length; end.list = list
      // Siblings leaving one side each turn in a channel of their own. Those heading the same way are nested:
      // the one that has furthest to go along the side turns last, so none of them has to cross another.
      const rank = end.toward < centre ? i : list.length - 1 - i
      end.lane = rank - (list.length - 1) / 2
    })
  }

  const blocks = [...rects.values()]

  // 3. two sides that face each other across clear ground are joined by one straight run wherever their ports can be made to meet.
  //    A line the user straightened may use the whole of both sides to stay straight; one left to the router only slides a port
  //    a little way from the middle, and never past a neighbour, so lines sharing a side keep their order
  const straight = new Set<string>()
  for (const e of sided) {
    if (e.shape === 'curved' || viaOf(e).length || (e.runs && e.runs.length) || plans.has(e.id)) continue
    const { a, b } = ends.get(e.id)!, ra = rects.get(e.from)!, rb = rects.get(e.to)!
    if (!opposite(a.side, b.side) || !beyond(ra, a.side, rb)) continue
    const ca = across(a.side, a.port), cb = across(b.side, b.port)
    const kept = !!e.runs
    const room = (end: End, r: Rect, c: number): [number, number] => {
      const centre = centreOn(r, end.side), size = r.x1 - r.x0
      if (kept) return [centre - size / 2 + EDGE, centre + size / 2 - EDGE]
      if (end.at !== undefined) return [c, c]
      const i = end.list.indexOf(end), before = end.list[i - 1], after = end.list[i + 1]
      return [Math.max(centre - size * SLIDE, before ? across(end.side, before.port) + APART : -Infinity), Math.min(centre + size * SLIDE, after ? across(end.side, after.port) - APART : Infinity)]
    }
    const [a0, a1] = room(a, ra, ca), [b0, b1] = room(b, rb, cb)
    const lo = Math.max(a0, b0), hi = Math.min(a1, b1)
    if (lo > hi + 1e-9) continue
    // a kept line stays where its first end was put; otherwise the busier side stays as it is and the other comes to meet it
    const want = kept || a.mates > b.mates ? ca : b.mates > a.mates ? cb : (ca + cb) / 2
    const c = r3(Math.max(lo, Math.min(hi, want)))
    const was: [W, W, W, W] = [a.port, a.out, b.port, b.out]
    put(a, ra, c); put(b, rb, c)
    // the user's word is final; the router's own idea is dropped if something stands in the way
    if (kept || clearRun(a.port, b.port, blocks, [ra, rb])) straight.add(e.id)
    else [a.port, a.out, b.port, b.out] = was
  }

  // 4. parallel lines between the same two components each get their own lane
  const pairs = new Map<string, string[]>()
  for (const e of sided) { const k = e.from < e.to ? e.from + '|' + e.to : e.to + '|' + e.from; (pairs.get(k) ?? pairs.set(k, []).get(k)!).push(e.id) }
  const lane = new Map<string, number>()
  for (const ids of pairs.values()) ids.forEach((id, i) => lane.set(id, i - (ids.length - 1) / 2))

  // 5. the path of each line, by the first of these that applies: direct, a plan that stands, curved, straight (step 3),
  //    its own track, a path found now, or an older file's points. A track that can no longer be followed falls through to a found path
  const out = new Map<string, Routed>()
  for (const e of live) {
    const ra = rects.get(e.from)!, rb = rects.get(e.to)!
    if (e.shape === 'direct') {
      // one line from one to the other, wherever they stand: it leaves each where the line between their middles crosses its edge
      const p = exitOf(ra, mid(rb)), q = exitOf(rb, mid(ra))
      out.set(e.id, { pts: [p, q], leg: [0], fromSide: facing(ra, mid(rb)), toSide: facing(rb, mid(ra)), manual: false, shape: 'direct' })
      continue
    }
    const { a, b } = ends.get(e.id)!
    const plan = plans.get(e.id)
    if (plan) { out.set(e.id, { pts: plan.pts.map((p) => [p[0], p[1]] as W), leg: plan.pts.slice(1).map(() => 0), fromSide: plan.fromSide, toSide: plan.toSide, manual: false, shape: 'ortho' }); continue }
    const via = viaOf(e)
    let pts: W[] | null = null, leg: number[] = [], manual = false
    if (e.shape === 'curved') {
      // a single sweep: out of one side, into the other, pulled further the further apart they are
      const k = Math.max(0.8, Math.min(5, Math.hypot(b.port[0] - a.port[0], b.port[1] - a.port[1]) * 0.4))
      pts = [a.port, [r3(a.port[0] + DIR[a.side][0] * k), r3(a.port[1] + DIR[a.side][1] * k)], [r3(b.port[0] + DIR[b.side][0] * k), r3(b.port[1] + DIR[b.side][1] * k)], b.port]
      out.set(e.id, { pts, leg: [0, 0, 0], fromSide: a.side, toSide: b.side, manual: false, shape: 'curved' })
      continue
    }
    if (straight.has(e.id)) { pts = [a.port, b.port]; manual = !!e.runs }
    else if (e.runs) { const t = tracked(a, b, ra, rb, e.runs); if (t) { pts = tidy(t); manual = true } }
    if (pts) leg = pts.slice(1).map(() => 0)
    else if (!via.length) {
      const path = findPath(a.out, DIR[a.side], b.out, [-DIR[b.side][0], -DIR[b.side][1]], blocks, (lane.get(e.id) ?? 0) + a.lane)
      pts = tidy([a.port, ...path, b.port])
      leg = pts.slice(1).map(() => 0)
    } else {
      manual = true
      // through the user's points in order, turning once between each pair
      const stops: W[] = [a.out, ...via.map((v) => [v[0], v[1]] as W), b.out]
      const raw: { p: W; leg: number }[] = [{ p: a.port, leg: 0 }, { p: a.out, leg: 0 }]
      let horiz = horizontal(a.side)
      for (let i = 1; i < stops.length; i++) {
        const p = stops[i - 1], q = stops[i], last = i === stops.length - 1
        if (p[0] !== q[0] && p[1] !== q[1]) {
          // into the last stop, turn so the final run lines up with the port; otherwise carry on the way we were going, then turn
          const first = last ? !horizontal(b.side) : horiz
          raw.push({ p: first ? [q[0], p[1]] : [p[0], q[1]], leg: i - 1 })
          horiz = !first
        } else if (p[0] !== q[0] || p[1] !== q[1]) horiz = p[1] === q[1]
        raw.push({ p: q, leg: i - 1 })
      }
      raw.push({ p: b.port, leg: via.length })
      // tidy while remembering which stretch each surviving run belongs to
      pts = []; leg = []
      for (const r of raw) {
        const q: W = [r3(r.p[0]), r3(r.p[1])], n = pts.length
        if (n && pts[n - 1][0] === q[0] && pts[n - 1][1] === q[1]) continue
        if (n >= 2 && leg[n - 2] === r.leg && ((pts[n - 2][0] === pts[n - 1][0] && pts[n - 1][0] === q[0]) || (pts[n - 2][1] === pts[n - 1][1] && pts[n - 1][1] === q[1])) && between(pts[n - 2], pts[n - 1], q)) { pts[n - 1] = q; continue }
        if (n) leg.push(r.leg)
        pts.push(q)
      }
    }
    out.set(e.id, { pts, leg, fromSide: a.side, toSide: b.side, manual, shape: 'ortho' })
  }
  return out
}

/**
 * Whether one straight right-angled run can join two components as they stand, and where.
 * It can when they overlap along one axis: then both ends are slid along their sides to the
 * same line, as near the middle of the two as the ground between them allows.
 * A line with nothing standing on it is preferred; when there is none, the one nearest the middle is given
 * with `clear` false, because whether to pass under something is for whoever asked to decide.
 * `apart` means the two do not overlap on either axis, so no such run exists.
 * `fromAt` and `toAt` are in cells from the middle of each side, ready to be stored on the connection.
 */
export function straightBetween(a: NodeT, b: NodeT, nodes: NodeT[]): { fromSide: Side; toSide: Side; fromAt: number; toAt: number; clear: boolean } | 'apart' {
  const ra = rectOf(a), rb = rectOf(b), [ax, ay] = mid(ra), [bx, by] = mid(rb)
  const blocks = nodes.filter((n) => n.id !== a.id && n.id !== b.id).map(rectOf)
  let through: { fromSide: Side; toSide: Side; fromAt: number; toAt: number; clear: boolean } | null = null
  for (const along of ['x', 'y'] as const) {
    // a run along x needs the two to overlap in y and stand apart in x; and the other way round
    const [a0, a1, b0, b1] = along === 'x' ? [ra.y0, ra.y1, rb.y0, rb.y1] : [ra.x0, ra.x1, rb.x0, rb.x1]
    const lo = Math.max(a0, b0) + EDGE, hi = Math.min(a1, b1) - EDGE
    const fromSide: Side | null = along === 'x' ? (rb.x0 > ra.x1 ? 'e' : rb.x1 < ra.x0 ? 'w' : null) : rb.y0 > ra.y1 ? 's' : rb.y1 < ra.y0 ? 'n' : null
    if (lo > hi + 1e-9 || !fromSide) continue
    const toSide = ({ e: 'w', w: 'e', s: 'n', n: 's' } as const)[fromSide]
    const ca = along === 'x' ? ay : ax, cb = along === 'x' ? by : bx
    const want = Math.max(lo, Math.min(hi, (ca + cb) / 2))
    // nearest the middle first, then a quarter cell at a time to either side
    const tries = [want]
    for (let d = 0.25; want - d >= lo - 1e-9 || want + d <= hi + 1e-9; d += 0.25) { if (want - d >= lo - 1e-9) tries.push(want - d); if (want + d <= hi + 1e-9) tries.push(want + d) }
    for (const c of tries) {
      const p: W = along === 'x' ? [fromSide === 'e' ? ra.x1 : ra.x0, c] : [c, fromSide === 's' ? ra.y1 : ra.y0]
      const q: W = along === 'x' ? [fromSide === 'e' ? rb.x0 : rb.x1, c] : [c, fromSide === 's' ? rb.y0 : rb.y1]
      if (clearRun(p, q, blocks, [])) return { fromSide, toSide, fromAt: r3(c - ca), toAt: r3(c - cb), clear: true }
    }
    through ??= { fromSide, toSide, fromAt: r3(want - ca), toAt: r3(want - cb), clear: false }
  }
  return through ?? 'apart'
}

/** A preview route between two components, as it would be drawn if they were connected now. */
export function routePair(a: NodeT, b: NodeT, nodes: NodeT[], pin: Partial<Pick<EdgeT, 'fromSide' | 'toSide' | 'via' | 'shape'>> = {}): W[] {
  const e: EdgeT = { id: '~preview', from: a.id, to: b.id, style: 'solid', arrow: 'end', width: 2, ...pin }
  return routeAll(nodes, [e]).get(e.id)?.pts ?? []
}

/**
 * A preview route from a component to a loose point on the ground: what a
 * connection being drawn looks like before it has found its other end. It
 * leaves by the side facing the point (or `side`, when given) and makes one elbow.
 * It does not avoid anything: `nodes` is accepted and ignored.
 */
export function routeToPoint(a: NodeT, p: W, nodes: NodeT[], side?: Side): W[] {
  const r = rectOf(a), s = side ?? facing(r, p)
  const from = portAt(r, s, 0), q: W = [r3(p[0]), r3(p[1])]
  void nodes
  // one clean elbow: straight out of the door as far as the pointer has gone that way, then across to it.
  // Nothing cleverer: a loose end that re-plans itself round every obstacle as it moves is restless to watch
  const reachOut = horizontal(s) ? (q[0] - from[0]) * DIR[s][0] : (q[1] - from[1]) * DIR[s][1]
  const turn: W = horizontal(s) ? [from[0] + DIR[s][0] * Math.max(STUB, reachOut), from[1]] : [from[0], from[1] + DIR[s][1] * Math.max(STUB, reachOut)]
  return tidy([from, turn, horizontal(s) ? [turn[0], q[1]] : [q[0], turn[1]], q])
}

/** The side of a component nearest to a point (for pinning an end where the user drops it). */
export function nearestSide(n: Box, p: W): Side {
  const r = rectOf(n), [cx, cy] = mid(r), dx = p[0] - cx, dy = p[1] - cy
  return Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? 'e' : 'w') : dy >= 0 ? 's' : 'n'
}

/** The point a fraction `t` (0 to 1) of the way along a right-angled route, with the axis and index of the run it falls on. */
export function along(pts: W[], t: number): { at: W; dir: 'x' | 'y'; run: number } {
  const lens = pts.slice(1).map((p, i) => Math.abs(p[0] - pts[i][0]) + Math.abs(p[1] - pts[i][1]))
  let want = lens.reduce((a, b) => a + b, 0) * t
  for (let i = 0; i < lens.length; i++) {
    if (want <= lens[i] || i === lens.length - 1) {
      const k = lens[i] ? Math.min(1, want / lens[i]) : 0, a = pts[i], b = pts[i + 1]
      return { at: [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k], dir: a[1] === b[1] ? 'x' : 'y', run: i }
    }
    want -= lens[i]
  }
  return { at: pts[0] ?? [0, 0], dir: 'x', run: 0 }
}
