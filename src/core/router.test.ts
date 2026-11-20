import { describe, expect, it } from 'vitest'
import { docOf, edge, node } from '../test/helpers'
import { type W, along, facing, findPath, legOfRun, nearestSide, routeAll, routePair, tidy } from './router'
import type { EdgeT, NodeT } from './types'

const rect = (n: NodeT) => ({ x0: n.x, y0: n.y, x1: n.x + 2 * (n.scale ?? 1), y1: n.y + 2 * (n.scale ?? 1) })
/** every run is horizontal or vertical */
const square = (pts: W[]) => pts.every((p, i) => i === 0 || p[0] === pts[i - 1][0] || p[1] === pts[i - 1][1])
const bends = (pts: W[]) => Math.max(0, pts.length - 2)
/** does the route pass through the inside of a component it does not belong to */
const crosses = (pts: W[], n: NodeT) => {
  const r = rect(n)
  return pts.some((p, i) => {
    if (!i) return false
    const a = pts[i - 1], x0 = Math.min(a[0], p[0]), x1 = Math.max(a[0], p[0]), y0 = Math.min(a[1], p[1]), y1 = Math.max(a[1], p[1])
    return x0 < r.x1 && x1 > r.x0 && y0 < r.y1 && y1 > r.y0
  })
}
const one = (nodes: NodeT[], e: Partial<EdgeT> = {}) => routeAll(nodes, [{ ...edge('e', 'a', 'b'), ...e }]).get('e')!

describe('choosing sides', () => {
  const r = { x0: 0, y0: 0, x1: 2, y1: 2 }
  it('faces where the line is going', () => {
    expect(facing(r, [10, 1])).toBe('e')
    expect(facing(r, [-10, 1])).toBe('w')
    expect(facing(r, [1, 10])).toBe('s')
    expect(facing(r, [1, -10])).toBe('n')
  })
  it('neighbours side by side use left and right even when one sits a little higher', () => {
    expect(facing(r, [9, 2.4], { x0: 8, y0: 1.4, x1: 10, y1: 3.4 })).toBe('e')
  })
  it('stacked components use top and bottom', () => {
    expect(facing(r, [2, 9], { x0: 1, y0: 8, x1: 3, y1: 10 })).toBe('s')
  })
  it('finds the side of a component nearest a point', () => {
    const n = node('a', 'ec2', 0, 0)
    expect(nearestSide(n, [1.9, 1])).toBe('e')
    expect(nearestSide(n, [1, 0.1])).toBe('n')
    expect(nearestSide(n, [0.1, 1.2])).toBe('w')
    expect(nearestSide(n, [1.1, 1.9])).toBe('s')
  })
})

describe('automatic routes', () => {
  it('two components in a row are joined by one straight line between facing sides', () => {
    const r = one([node('a', 'ec2', 0, 0), node('b', 'rds', 8, 0)])
    expect(r.pts).toEqual([[2, 1], [8, 1]])
    expect(r.fromSide).toBe('e'); expect(r.toSide).toBe('w')
    expect(r.manual).toBe(false)
  })
  it('a diagonal pair gets two turns, in right angles, turning half way', () => {
    const r = one([node('a', 'ec2', 0, 0), node('b', 'rds', 8, 4)])
    expect(square(r.pts)).toBe(true)
    expect(bends(r.pts)).toBe(2)
    expect(r.pts[1][0]).toBe(5) // the middle of the gap between them
    expect(r.pts[0]).toEqual([2, 1]); expect(r.pts.at(-1)).toEqual([8, 5])
  })
  it('goes round a component that is in the way, never through it', () => {
    const wall = node('w', 's3', 4, 0)
    const r = one([node('a', 'ec2', 0, 0), node('b', 'rds', 8, 0), wall])
    expect(square(r.pts)).toBe(true)
    expect(crosses(r.pts, wall)).toBe(false)
    expect(bends(r.pts)).toBeGreaterThanOrEqual(2)
  })
  it('never passes through its own two components either', () => {
    const a = node('a', 'ec2', 0, 0), b = node('b', 'rds', 0, 8)
    const r = one([a, b], { fromSide: 'n', toSide: 's' })
    expect(square(r.pts)).toBe(true)
    // only the two ends touch them
    expect(crosses(r.pts.slice(1, -1), a)).toBe(false)
    expect(crosses(r.pts.slice(1, -1), b)).toBe(false)
  })
  it('threads a crowded row without touching anything', () => {
    const others = Array.from({ length: 6 }, (_, i) => node('o' + i, 's3', 3 + i * 3, i % 2 ? 1 : -1))
    const r = one([node('a', 'ec2', 0, 0), node('b', 'rds', 24, 0), ...others])
    expect(square(r.pts)).toBe(true)
    for (const o of others) expect(crosses(r.pts, o)).toBe(false)
  })
  it('is the same every time, and unchanged by something moving far away', () => {
    const nodes = [node('a', 'ec2', 0, 0), node('b', 'rds', 8, 4), node('far', 's3', 60, 60)]
    const first = one(nodes).pts
    expect(one(nodes).pts).toEqual(first)
    expect(one([nodes[0], nodes[1], { ...nodes[2], x: 80 }]).pts).toEqual(first)
  })
  it('honours a side the user pinned', () => {
    const r = one([node('a', 'ec2', 0, 0), node('b', 'rds', 8, 0)], { fromSide: 's' })
    expect(r.fromSide).toBe('s')
    expect(r.pts[0]).toEqual([1, 2])
    expect(r.pts[1][1]).toBeGreaterThan(2) // leaves downwards before it turns
    expect(square(r.pts)).toBe(true)
  })
  it('still draws something when a component is boxed in', () => {
    const ring = [[-3, 0], [3, 0], [0, -3], [0, 3], [-3, -3], [3, 3], [-3, 3], [3, -3]].map(([x, y], i) => node('r' + i, 's3', x, y))
    const r = one([node('a', 'ec2', 0, 0), node('b', 'rds', 20, 0), ...ring])
    expect(r.pts.length).toBeGreaterThanOrEqual(2)
    expect(r.pts.every((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]))).toBe(true)
  })
  it('skips connections whose components are missing or the same', () => {
    const m = routeAll([node('a', 'ec2', 0, 0)], [edge('e', 'a', 'gone'), edge('f', 'a', 'a')])
    expect(m.size).toBe(0)
  })
  it('a preview between two components is the route they would get', () => {
    const a = node('a', 'ec2', 0, 0), b = node('b', 'rds', 8, 0)
    expect(routePair(a, b, [a, b])).toEqual([[2, 1], [8, 1]])
  })
})

describe('sharing a side', () => {
  it('lines leaving one side fan out along it in the order of where they lead', () => {
    const nodes = [node('a', 'ec2', 0, 4), node('up', 'rds', 8, 0), node('mid', 'rds', 8, 4), node('down', 'rds', 8, 8)]
    const m = routeAll(nodes, [edge('d', 'a', 'down'), edge('u', 'a', 'up'), edge('m', 'a', 'mid')])
    const y = (id: string) => m.get(id)!.pts[0][1]
    expect(y('u')).toBeLessThan(y('m'))
    expect(y('m')).toBeLessThan(y('d'))
    // all three still leave from the right-hand side
    for (const id of ['u', 'm', 'd']) expect(m.get(id)!.pts[0][0]).toBe(2)
  })
  it('those lines turn in channels of their own instead of lying on top of each other', () => {
    const nodes = [node('a', 'ec2', 0, 4), node('up', 'rds', 8, 0), node('up2', 'rds', 8, -4)]
    const m = routeAll(nodes, [edge('p', 'a', 'up'), edge('q', 'a', 'up2')])
    expect(m.get('p')!.pts[1][0]).not.toBe(m.get('q')!.pts[1][0])
  })
  it('two connections between the same pair run side by side, not one over the other', () => {
    const nodes = [node('a', 'ec2', 0, 0), node('b', 'rds', 8, 0)]
    const m = routeAll(nodes, [edge('p', 'a', 'b'), edge('q', 'a', 'b')])
    const p = m.get('p')!.pts, q = m.get('q')!.pts
    expect(p[0][1]).not.toBe(q[0][1])
    expect(p.at(-1)![1]).not.toBe(q.at(-1)![1])
    expect(JSON.stringify(p)).not.toBe(JSON.stringify(q))
  })
  it('spreads within the side however many lines there are', () => {
    const targets = Array.from({ length: 9 }, (_, i) => node('t' + i, 'rds', 12, i * 3 - 12))
    const m = routeAll([node('a', 'ec2', 0, 0), ...targets], targets.map((t) => edge('e' + t.id, 'a', t.id)))
    for (const r of m.values()) { expect(r.pts[0][1]).toBeGreaterThan(0); expect(r.pts[0][1]).toBeLessThan(2) }
  })
})

describe('routes shaped by hand', () => {
  const nodes = [node('a', 'ec2', 0, 0), node('b', 'rds', 8, 0)]
  it('goes through the waypoints in order, in right angles', () => {
    const r = one(nodes, { via: [[4, 5], [7, 5]] })
    expect(r.manual).toBe(true)
    expect(square(r.pts)).toBe(true)
    const has = (p: W) => r.pts.some((q) => q[0] === p[0] && q[1] === p[1])
    expect(has([4, 5])).toBe(true); expect(has([7, 5])).toBe(true)
  })
  it('each end leaves from the side facing its nearest waypoint', () => {
    const r = one(nodes, { via: [[1, 6]] })
    expect(r.fromSide).toBe('s')
    expect(r.pts[0]).toEqual([1, 2])
  })
  it('is not re-planned when something is put in its way', () => {
    const via: [number, number][] = [[5, 1]]
    const before = one(nodes, { via }).pts
    const after = one([...nodes, node('w', 's3', 4, 0)], { via }).pts
    expect(after).toEqual(before)
  })
  it('keeps its waypoints when an end moves: only the last run follows', () => {
    const via: [number, number][] = [[5, 6]]
    const moved = one([nodes[0], { ...nodes[1], y: 10 }], { via })
    expect(moved.pts.some((p) => p[0] === 5 && p[1] === 6)).toBe(true)
    expect(square(moved.pts)).toBe(true)
  })
  it('says which stretch between waypoints each run belongs to, so a new waypoint lands in the right place', () => {
    const r = one(nodes, { via: [[4, 6], [7, 6]] })
    expect(r.leg.length).toBe(r.pts.length - 1)
    expect(r.leg[0]).toBe(0)
    expect(r.leg.at(-1)).toBe(2)
    expect([...r.leg].sort()).toEqual(r.leg) // never goes backwards
    expect(legOfRun(r, 0)).toBe(0)
    expect(legOfRun(r, 99)).toBe(2)
    expect(legOfRun(one(nodes), 0)).toBe(0)
  })
})

describe('helpers', () => {
  it('tidy drops repeats and points in the middle of a straight run, but not a doubling back', () => {
    expect(tidy([[0, 0], [0, 0], [2, 0], [5, 0], [5, 3]])).toEqual([[0, 0], [5, 0], [5, 3]])
    expect(tidy([[0, 0], [5, 0], [2, 0]])).toEqual([[0, 0], [5, 0], [2, 0]])
  })
  it('finds a point part of the way along a route', () => {
    const pts: W[] = [[0, 0], [4, 0], [4, 4]]
    expect(along(pts, 0.5)).toEqual({ at: [4, 0], dir: 'x', run: 0 })
    expect(along(pts, 0.75)).toEqual({ at: [4, 2], dir: 'y', run: 1 })
    expect(along(pts, 1).at).toEqual([4, 4])
    expect(along([], 0.5).at).toEqual([0, 0])
    expect(along([[1, 1], [1, 1]], 0.5).at).toEqual([1, 1])
  })
  it('a path search with nothing in the way is a single turn or none', () => {
    expect(findPath([0, 0], [1, 0], [6, 0], [1, 0], [])).toEqual([[0, 0], [6, 0]])
    const p = findPath([0, 0], [1, 0], [6, 4], [0, 1], [])
    expect(p).toEqual([[0, 0], [6, 0], [6, 4]])
  })
})

describe('at scale', () => {
  it('routes a 300-component grid quickly, and again almost for free', () => {
    const side = 18
    const nodes = Array.from({ length: 300 }, (_, i) => node('n' + i, 'ec2', (i % side) * 4, Math.floor(i / side) * 4))
    const edges: EdgeT[] = []
    for (let i = 0; i < 299; i++) if ((i + 1) % side) edges.push(edge('h' + i, 'n' + i, 'n' + (i + 1)))
    for (let i = 0; i + side < 300; i += 2) edges.push(edge('v' + i, 'n' + i, 'n' + (i + side)))
    for (let i = 0; i + side * 3 + 5 < 300; i += 7) edges.push(edge('x' + i, 'n' + i, 'n' + (i + side * 3 + 5)))
    const t0 = performance.now()
    const m = routeAll(nodes, edges)
    const cold = performance.now() - t0
    expect(m.size).toBe(edges.length)
    for (const r of m.values()) expect(square(r.pts)).toBe(true)
    const t1 = performance.now()
    routeAll(nodes, edges)
    const warm = performance.now() - t1
    expect(cold).toBeLessThan(1500)
    expect(warm).toBeLessThan(cold)
    void docOf
  })
})
