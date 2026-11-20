import { type EdgeT, type NodeT, type Side, footOf } from './types'

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
 *  - A route the user has shaped (it has waypoints) is theirs: it goes through
 *    those points in order and only the short runs at each end follow the
 *    components when they move. It is never re-planned behind their back.
 *
 * Everything here is pure and deterministic: the same diagram always gives the
 * same lines, so nothing jumps about between redraws.
 */

export type W = [number, number]

export interface Routed {
  pts: W[]
  /** for each run pts[i] → pts[i+1]: which stretch between waypoints it belongs to (0 = before the first waypoint) */
  leg: number[]
  fromSide: Side
  toSide: Side
  /** shaped by hand (has waypoints) */
  manual: boolean
}

interface Rect { x0: number; y0: number; x1: number; y1: number }
type Box = Pick<NodeT, 'x' | 'y' | 'scale'>

const DIR: Record<Side, W> = { n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0] }
/** how far a line runs straight out of a port before it may turn */
export const STUB = 0.5
/** the room a route keeps from components it passes */
const CLEAR = 0.3
const BEND = 1.6

const rectOf = (n: Box): Rect => { const s = footOf(n); return { x0: n.x, y0: n.y, x1: n.x + s, y1: n.y + s } }
const mid = (r: Rect): W => [(r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2]
const horizontal = (s: Side) => s === 'e' || s === 'w'
const r3 = (v: number) => Math.round(v * 1000) / 1000

/** The side of `r` that faces the point `t`. Neighbours side by side use left/right, stacked ones use top/bottom. */
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

const cache = new Map<string, W[]>()

/**
 * Shortest right-angled path from `s` (heading `sd`) to `t` (arriving along `td`)
 * that keeps clear of `blocks`. `lane` shifts the preferred middle channel so
 * parallel lines between the same two components do not lie on top of each other.
 */
export function findPath(s: W, sd: W, t: W, td: W, blocks: Rect[], lane = 0): W[] {
  const lo: W = [Math.min(s[0], t[0]) - 3, Math.min(s[1], t[1]) - 3], hi: W = [Math.max(s[0], t[0]) + 3, Math.max(s[1], t[1]) + 3]
  const near = blocks.filter((b) => b.x1 > lo[0] && b.x0 < hi[0] && b.y1 > lo[1] && b.y0 < hi[1])
  const key = [s, sd, t, td, lane, near.map((b) => [b.x0, b.y0, b.x1, b.y1])].join('|')
  const hit = cache.get(key)
  if (hit) return hit

  const mx = r3(Math.round(((s[0] + t[0]) / 2) * 2) / 2 + lane * 0.4), my = r3(Math.round(((s[1] + t[1]) / 2) * 2) / 2 + lane * 0.4)
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
  if (cache.size > 4000) cache.clear()
  cache.set(key, out)
  return out
}

// ---- whole diagram ---------------------------------------------------------------------

interface End { edge: string; node: string; side: Side; toward: number; port: W; out: W; lane: number }

/** Routes for every connection in the diagram, keyed by connection id. */
export function routeAll(nodes: NodeT[], edges: EdgeT[]): Map<string, Routed> {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const rects = new Map(nodes.map((n) => [n.id, rectOf(n)]))
  const live = edges.filter((e) => byId.has(e.from) && byId.has(e.to) && e.from !== e.to)

  // 1. which side each end uses
  const ends = new Map<string, { a: End; b: End }>()
  for (const e of live) {
    const ra = rects.get(e.from)!, rb = rects.get(e.to)!
    const via = e.via ?? []
    const ta = via.length ? via[0] : mid(rb), tb = via.length ? via[via.length - 1] : mid(ra)
    const sa = e.fromSide ?? facing(ra, ta, via.length ? undefined : rb), sb = e.toSide ?? facing(rb, tb, via.length ? undefined : ra)
    const along = (s: Side, t: W) => (horizontal(s) ? t[1] : t[0])
    ends.set(e.id, {
      a: { edge: e.id, node: e.from, side: sa, toward: along(sa, ta), port: [0, 0], out: [0, 0], lane: 0 },
      b: { edge: e.id, node: e.to, side: sb, toward: along(sb, tb), port: [0, 0], out: [0, 0], lane: 0 },
    })
  }

  // 2. spread the lines that share a side along it, in the order of where they lead
  const sides = new Map<string, End[]>()
  for (const { a, b } of ends.values()) for (const end of [a, b]) { const k = end.node + ':' + end.side; (sides.get(k) ?? sides.set(k, []).get(k)!).push(end) }
  for (const list of sides.values()) {
    list.sort((p, q) => p.toward - q.toward || (p.edge < q.edge ? -1 : p.edge > q.edge ? 1 : 0))
    const r = rects.get(list[0].node)!, size = r.x1 - r.x0
    const gap = Math.min(0.5, (size * 0.76) / list.length)
    const centre = horizontal(list[0].side) ? (r.y0 + r.y1) / 2 : (r.x0 + r.x1) / 2
    list.forEach((end, i) => {
      const off = (i - (list.length - 1) / 2) * gap
      end.port = portAt(r, end.side, off)
      end.out = portAt(r, end.side, off, STUB)
      // Siblings leaving one side each turn in a channel of their own. Those heading the same way are nested:
      // the one that has furthest to go along the side turns last, so none of them has to cross another.
      const rank = end.toward < centre ? i : list.length - 1 - i
      end.lane = rank - (list.length - 1) / 2
    })
  }

  // 3. parallel lines between the same two components each get their own lane
  const pairs = new Map<string, string[]>()
  for (const e of live) { const k = e.from < e.to ? e.from + '|' + e.to : e.to + '|' + e.from; (pairs.get(k) ?? pairs.set(k, []).get(k)!).push(e.id) }
  const lane = new Map<string, number>()
  for (const ids of pairs.values()) ids.forEach((id, i) => lane.set(id, i - (ids.length - 1) / 2))

  const blocks = [...rects.values()]
  const out = new Map<string, Routed>()
  for (const e of live) {
    const { a, b } = ends.get(e.id)!
    const via = e.via ?? []
    let pts: W[], leg: number[]
    if (!via.length) {
      const path = findPath(a.out, DIR[a.side], b.out, [-DIR[b.side][0], -DIR[b.side][1]], blocks, (lane.get(e.id) ?? 0) + a.lane)
      pts = tidy([a.port, ...path, b.port])
      leg = pts.slice(1).map(() => 0)
    } else {
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
    out.set(e.id, { pts, leg, fromSide: a.side, toSide: b.side, manual: via.length > 0 })
  }
  return out
}

/** A preview route between two components, as it would be drawn if they were connected now. */
export function routePair(a: NodeT, b: NodeT, nodes: NodeT[]): W[] {
  const e: EdgeT = { id: '~preview', from: a.id, to: b.id, style: 'solid', arrow: 'end', width: 2 }
  return routeAll(nodes, [e]).get(e.id)?.pts ?? []
}

/** Where along a route a new waypoint dropped on run `i` belongs: its index in the waypoint list. */
export const legOfRun = (r: Routed, i: number) => r.leg[Math.max(0, Math.min(r.leg.length - 1, i))] ?? 0

/** The side of a component nearest to a point (for pinning an end where the user drops it). */
export function nearestSide(n: Box, p: W): Side {
  const r = rectOf(n), [cx, cy] = mid(r), dx = p[0] - cx, dy = p[1] - cy
  return Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? 'e' : 'w') : dy >= 0 ? 's' : 'n'
}

/** Total length of a route, and the point a fraction `t` of the way along it. */
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
