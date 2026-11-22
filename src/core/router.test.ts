import { describe, expect, it } from 'vitest'
import { docOf, edge, node } from '../test/helpers'
import { along, facing, findPath, nearestSide, planKey, routeAll, routePair, routerOwns, straightBetween, tidy, type W, withPlans } from './router'
import type { Doc, EdgeT, NodeT } from './types'

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
  it('says which stretch between waypoints each run belongs to', () => {
    const r = one(nodes, { via: [[4, 6], [7, 6]] })
    expect(r.leg.length).toBe(r.pts.length - 1)
    expect(r.leg[0]).toBe(0)
    expect(r.leg.at(-1)).toBe(2)
    expect([...r.leg].sort()).toEqual(r.leg) // never goes backwards
  })
})

describe('lines that ought to be straight are', () => {
  const row = [node('a', 'ec2', 0, 0), node('b', 'ec2', 6, 0)]
  it('a line level with its target is not kinked by another line sharing the side', () => {
    // a also feeds c, below: the two fan out along a's east side, which used to leave a quarter-cell jog in the line to b
    const nodes = [...row, node('c', 'ec2', 6, 6)]
    const r = routeAll(nodes, [edge('ab', 'a', 'b'), edge('ac', 'a', 'c')])
    expect(r.get('ab')!.pts).toHaveLength(2)
    expect(r.get('ab')!.pts[0][1]).toBe(r.get('ab')!.pts[1][1])
    // the two still leave from different points, in order
    expect(r.get('ab')!.pts[0][1]).toBeLessThan(r.get('ac')!.pts[0][1])
  })
  it('nor by other lines arriving on the side it arrives at', () => {
    const nodes = [node('a', 'ec2', 0, 0), node('d', 'ec2', 0, 5), node('b', 'ec2', 6, 0)]
    const r = routeAll(nodes, [edge('ab', 'a', 'b'), edge('db', 'd', 'b')])
    expect(r.get('ab')!.pts).toHaveLength(2)
  })
  it('components of different sizes with their tops level are joined straight', () => {
    // middles half a cell apart: nothing the user could move would ever have lined them up
    const r = one([node('a', 'ec2', 0, 0, { scale: 1.5 }), node('b', 'ec2', 6, 0)])
    expect(r.pts).toHaveLength(2)
    expect(r.pts[0][1]).toBe(1.25)
  })
  it('components a cell out of line are joined straight too, each end a little off the middle of its side', () => {
    expect(one([node('a', 'ec2', 0, 0), node('b', 'ec2', 6, 1)]).pts).toEqual([[2, 1.5], [6, 1.5]])
    expect(one([node('a', 'ec2', 0, 0), node('b', 'ec2', 1, 6)]).pts).toEqual([[1.5, 2], [1.5, 6]])
  })
  it('further out of line than a port may slide, the line turns as before', () => {
    expect(bends(one([node('a', 'ec2', 0, 0), node('b', 'ec2', 6, 1.5)]).pts)).toBe(2)
  })
  it('a port is not slid when the straight run it would make has something standing on it', () => {
    const r = one([node('a', 'ec2', 0, 0), node('b', 'ec2', 10, 1), node('x', 'ec2', 4, 0.5)])
    expect(crosses(r.pts, node('x', 'ec2', 4, 0.5))).toBe(false)
    expect(r.pts[0][1]).toBe(1) // left where it was, in the middle
  })
  it('a port never slides past its neighbour on the side', () => {
    const nodes = [node('a', 'ec2', 0, 3), node('b', 'ec2', 6, 0), node('c', 'ec2', 6, 3), node('d', 'ec2', 6, 6)]
    const r = routeAll(nodes, [edge('ab', 'a', 'b'), edge('ac', 'a', 'c'), edge('ad', 'a', 'd')])
    const ys = ['ab', 'ac', 'ad'].map((id) => r.get(id)!.pts[0][1])
    expect(ys).toEqual([...ys].sort((p, q) => p - q))
    expect(r.get('ac')!.pts).toHaveLength(2)
  })
})

describe('a track laid by hand', () => {
  const nodes = [node('a', 'ec2', 0, 0), node('b', 'ec2', 8, 4)]
  const z = { fromSide: 'e', toSide: 'w', fromAt: 0, toAt: 0 } as const
  it('runs out of one side, along each run in turn, and into the other', () => {
    const r = one(nodes, { ...z, runs: [3] })
    expect(r.pts).toEqual([[2, 1], [3, 1], [3, 5], [8, 5]])
    expect(r.manual).toBe(true)
    expect(one(nodes, { ...z, runs: [3, 7, 6] }).pts).toEqual([[2, 1], [3, 1], [3, 7], [6, 7], [6, 5], [8, 5]])
  })
  it('each end sits where it was put along its side, and no further than the side goes', () => {
    expect(one(nodes, { ...z, fromAt: 0.5, toAt: -0.5, runs: [5] }).pts).toEqual([[2, 1.5], [5, 1.5], [5, 4.5], [8, 4.5]])
    expect(one(nodes, { ...z, fromAt: 9, runs: [5] }).pts[0]).toEqual([2, 1.85])
  })
  it('is not re-planned when something is put in its way', () => {
    const x = node('x', 'ec2', 4, 2)
    expect(one([...nodes, x], { ...z, runs: [5] }).pts).toEqual(one(nodes, { ...z, runs: [5] }).pts)
  })
  it('when a component moves, the runs next to it stretch and the rest stay where they were put', () => {
    const moved = one([{ ...nodes[0], y: -3 }, nodes[1]], { ...z, runs: [3, 7, 6] })
    expect(moved.pts).toEqual([[2, -2], [3, -2], [3, 7], [6, 7], [6, 5], [8, 5]])
  })
  it('the first and last turn are kept outside the components they belong to', () => {
    // a has been moved right, over where the first run was laid
    const r = one([{ ...nodes[0], x: 2 }, nodes[1]], { ...z, runs: [3] })
    expect(r.pts[1][0]).toBeGreaterThanOrEqual(4.3)
    expect(square(r.pts)).toBe(true)
  })
  it('one that no longer makes a line at all gives way to the router instead of drawing nonsense', () => {
    // b is now to the left of a: a line out of a's east side straight into b's west side cannot be had
    const r = one([nodes[0], { ...nodes[1], x: -8 }], { ...z, runs: [3] })
    expect(r.manual).toBe(false)
    expect(square(r.pts)).toBe(true)
    // and a track with the wrong number of runs for its sides is not followed either
    expect(one(nodes, { ...z, runs: [3, 4] }).manual).toBe(false)
  })
  it('a single corner needs no runs between two sides at right angles', () => {
    const r = one(nodes, { fromSide: 'e', toSide: 'n', fromAt: 0, toAt: 0, runs: [] })
    expect(r.pts).toEqual([[2, 1], [9, 1], [9, 4]])
    // and when the corner would fall inside a component, the router takes over
    expect(one([nodes[0], { ...nodes[1], x: 1 }], { fromSide: 'e', toSide: 'n', fromAt: 0, toAt: 0, runs: [] }).manual).toBe(false)
  })
  it('an empty track between facing sides means straight, and it stays straight as things move', () => {
    const level = [node('a', 'ec2', 0, 0), node('b', 'ec2', 8, 0)]
    const keep = { ...z, runs: [] }
    expect(one(level, keep).pts).toEqual([[2, 1], [8, 1]])
    // b moves down a little: both ends slide along their sides to stay on one line
    const r = one([level[0], { ...level[1], y: 1 }], keep)
    expect(r.pts).toHaveLength(2)
    expect(r.pts[0][1]).toBe(r.pts[1][1])
    expect(r.manual).toBe(true)
    // it passes under something put in its way: the user asked for straight
    expect(one([...level, node('x', 'ec2', 4, 0)], keep).pts).toHaveLength(2)
    // moved right out of line, it cannot be straight any more and is routed
    expect(bends(one([level[0], { ...level[1], y: 6 }], keep).pts)).toBeGreaterThan(0)
  })
  it('an older line through points is still drawn, and a track takes its place when both are present', () => {
    expect(one(nodes, { via: [[5, 9]] }).pts.some((p) => p[1] === 9)).toBe(true)
    expect(one(nodes, { ...z, runs: [3], via: [[5, 9]] }).pts.some((p) => p[1] === 9)).toBe(false)
  })
})

describe('other shapes', () => {
  const nodes = [node('a', 'ec2', 0, 0), node('b', 'ec2', 8, 4)]
  it('a direct line is one straight line from edge to edge, at whatever angle', () => {
    const r = one(nodes, { shape: 'direct' })
    expect(r.shape).toBe('direct')
    expect(r.pts).toEqual([[2, 1.5], [8, 4.5]])
    // straight across when they are level, and nothing at all odd when one sits on the other
    expect(one([node('a', 'ec2', 0, 0), node('b', 'ec2', 8, 0)], { shape: 'direct' }).pts).toEqual([[2, 1], [8, 1]])
    expect(one([node('a', 'ec2', 0, 0), node('b', 'ec2', 0, 0)], { shape: 'direct' }).pts).toEqual([[1, 1], [1, 1]])
    expect(one([node('a', 'ec2', 0, 0), node('b', 'ec2', 0, 8)], { shape: 'direct' }).pts).toEqual([[1, 2], [1, 8]])
  })
  it('a direct line takes no place on a side, so it does not push other lines along it', () => {
    const r = routeAll([...nodes, node('c', 'ec2', 8, 0)], [edge('ab', 'a', 'b', { shape: 'direct' }), edge('ac', 'a', 'c')])
    expect(r.get('ac')!.pts).toEqual([[2, 1], [8, 1]])
  })
  it('a curve leaves one side and arrives at the other, pulled further the further apart they are', () => {
    const r = one(nodes, { shape: 'curved' })
    expect(r.shape).toBe('curved')
    expect(r.pts).toHaveLength(4)
    expect(r.pts[0]).toEqual([2, 1])
    expect(r.pts[3]).toEqual([8, 5])
    expect(r.pts[1][1]).toBe(1) // straight out of the side
    expect(r.pts[2][1]).toBe(5)
    expect(r.pts[1][0]).toBeGreaterThan(2)
    expect(r.pts[2][0]).toBeLessThan(8)
    const far = one([nodes[0], { ...nodes[1], x: 40 }], { shape: 'curved' })
    expect(far.pts[1][0] - far.pts[0][0]).toBe(5)
  })
})

describe('whether two components can be joined straight', () => {
  it('side by side or stacked, with any overlap, they can: both ends on one line as near the middle as may be', () => {
    expect(straightBetween(node('a', 'ec2', 0, 0), node('b', 'ec2', 6, 0), [])).toEqual({ fromSide: 'e', toSide: 'w', fromAt: 0, toAt: 0, clear: true })
    expect(straightBetween(node('a', 'ec2', 6, 0), node('b', 'ec2', 0, 1), [])).toEqual({ fromSide: 'w', toSide: 'e', fromAt: 0.5, toAt: -0.5, clear: true })
    expect(straightBetween(node('a', 'ec2', 0, 0), node('b', 'ec2', 1, 6), [])).toMatchObject({ fromSide: 's', toSide: 'n' })
    expect(straightBetween(node('a', 'ec2', 0, 6), node('b', 'ec2', 0, 0), [])).toMatchObject({ fromSide: 'n', toSide: 's' })
    // barely overlapping: the line runs along the strip they share
    const thin = straightBetween(node('a', 'ec2', 0, 0), node('b', 'ec2', 6, 1.5), [])
    expect(thin).toMatchObject({ fromAt: 0.75, toAt: -0.75 })
  })
  it('out of line on both axes, or one on top of the other, they cannot', () => {
    expect(straightBetween(node('a', 'ec2', 0, 0), node('b', 'ec2', 6, 6), [])).toBe('apart')
    expect(straightBetween(node('a', 'ec2', 0, 0), node('b', 'ec2', 1, 0), [])).toBe('apart')
  })
  it('steps round something standing in the middle when there is room on the sides to do so', () => {
    // x covers the lower half of the gap: the line shifts up to clear it
    const a = node('a', 'ec2', 0, 0, { scale: 2 }), b = node('b', 'ec2', 10, 0, { scale: 2 }), x = node('x', 'ec2', 5, 2)
    const plan = straightBetween(a, b, [a, b, x])
    expect(plan).toMatchObject({ clear: true })
    expect((plan as { fromAt: number }).fromAt).toBeLessThan(0)
  })
  it('and says when no clear line exists, giving the middle one anyway', () => {
    const a = node('a', 'ec2', 0, 0), b = node('b', 'ec2', 10, 0), x = node('x', 'ec2', 5, 0)
    expect(straightBetween(a, b, [a, b, x])).toEqual({ fromSide: 'e', toSide: 'w', fromAt: 0, toAt: 0, clear: false })
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

describe('a path is planned once', () => {
  const a = node('a', 'ec2', 0, 0), b = node('b', 'ec2', 8, 4), c = node('c', 'ec2', 8, 0)
  const pts = (d: Doc, id: string) => routeAll(d.nodes, d.edges).get(id)!.pts
  it('every line the router owns is given the path planned for it, and following the plan draws the very same line', () => {
    const d = docOf([a, b, c], [edge('e', 'a', 'b'), edge('f', 'a', 'c'), edge('m', 'a', 'b', { runs: [3], fromSide: 'e', toSide: 'w', fromAt: 0, toAt: 0 }), edge('k', 'a', 'c', { shape: 'curved' })])
    const before = routeAll(d.nodes, d.edges)
    const planned = withPlans(d)
    expect(planned.edges[0].plan).toMatchObject({ fromSide: 'e', toSide: 'w', pts: before.get('e')!.pts })
    expect(planned.edges[1].plan!.pts).toEqual(before.get('f')!.pts)
    // a line with a track of its own, or one that is not right-angled, has no plan: it is not the router's
    expect(planned.edges[2].plan).toBeUndefined()
    expect(planned.edges[3].plan).toBeUndefined()
    const after = routeAll(planned.nodes, planned.edges)
    for (const id of ['e', 'f', 'm', 'k']) expect(after.get(id)!.pts).toEqual(before.get(id)!.pts)
    expect(after.get('e')!.manual).toBe(false)
    // and once everything is planned there is nothing more to do
    expect(withPlans(planned)).toBe(planned)
    expect(routerOwns(planned.edges[0])).toBe(true)
    expect(routerOwns(planned.edges[2])).toBe(false)
    expect(routerOwns(edge('v', 'a', 'b', { via: [[3, 3]] }))).toBe(false)
  })
  it('nothing else that happens re-plans it: a component dropped on it, a line added beside it, another component moved', () => {
    const d = withPlans(docOf([a, b], [edge('e', 'a', 'b')]))
    const was = pts(d, 'e')
    // unplanned, the line would go round what now stands on it
    const blocked = { ...d, nodes: [...d.nodes, node('x', 'ec2', 4, 2)] }
    expect(pts({ ...blocked, edges: [edge('e', 'a', 'b')] }, 'e')).not.toEqual(was)
    expect(pts(blocked, 'e')).toEqual(was)
    expect(withPlans(blocked)).toBe(blocked)
    // another line joining the same side takes a free place there and leaves this one where it is
    const more = withPlans({ ...d, nodes: [...d.nodes, c], edges: [...d.edges, edge('f', 'a', 'c')] })
    expect(pts(more, 'e')).toEqual(was)
    expect(more.edges[0]).toBe(d.edges[0])
    const pf = pts(more, 'f'), pe = pts(more, 'e')
    expect(pf[0]).not.toEqual(pe[0])
    // and a third: still nothing already there moves, and no two ends share a place
    const third = withPlans({ ...more, nodes: [...more.nodes, node('g', 'ec2', 8, 9)], edges: [...more.edges, edge('h', 'a', 'g', { fromSide: 'e' })] })
    expect(pts(third, 'e')).toEqual(pe)
    expect(pts(third, 'f')).toEqual(pf)
    const starts = ['e', 'f', 'h'].map((id) => pts(third, id)[0][1])
    expect(new Set(starts).size).toBe(3)
  })
  it('is planned again only when one of its own two components moves or changes size, or its pinned side changes', () => {
    const d = withPlans(docOf([a, b, c], [edge('e', 'a', 'b'), edge('f', 'a', 'c')]))
    const moved = withPlans({ ...d, nodes: d.nodes.map((n) => (n.id === 'b' ? { ...n, y: 6.3 } : n)) })
    expect(moved.edges[0].plan!.key).not.toBe(d.edges[0].plan!.key)
    expect(pts(moved, 'e').at(-1)![1]).toBe(7.3)
    // the other line, between two components that did not move, is the same object
    expect(moved.edges[1]).toBe(d.edges[1])
    const bigger = withPlans({ ...d, nodes: d.nodes.map((n) => (n.id === 'a' ? { ...n, scale: 1.5 } : n)) })
    expect(bigger.edges[0].plan!.key).not.toBe(d.edges[0].plan!.key)
    expect(bigger.edges[1].plan!.key).not.toBe(d.edges[1].plan!.key)
    const pinned = withPlans({ ...d, edges: d.edges.map((e) => (e.id === 'e' ? { ...e, fromSide: 's' as const } : e)) })
    expect(pinned.edges[0].plan!.fromSide).toBe('s')
    expect(pinned.edges[1]).toBe(d.edges[1])
  })
  it('a plan made for a different arrangement is never followed, wherever it came from', () => {
    const d = withPlans(docOf([a, b], [edge('e', 'a', 'b')]))
    // the component moved, but the stale plan was left on the line (as a drag in progress does): it is drawn where it belongs now
    const dragged = { ...d, nodes: d.nodes.map((n) => (n.id === 'b' ? { ...n, x: 9.37 } : n)) }
    expect(pts(dragged, 'e').at(-1)).toEqual([9.37, 5])
    expect(pts(dragged, 'e')).toEqual(pts(withPlans(dragged), 'e'))
    // a plan with too few points, or for a line to a component that is gone, is ignored
    const broken = { ...d, edges: [{ ...d.edges[0], plan: { ...d.edges[0].plan!, pts: [[0, 0]] as [number, number][] } }] }
    expect(pts(broken, 'e')).toEqual(pts(d, 'e'))
    const gone = { ...d, nodes: [a] }
    expect(withPlans(gone)).toBe(gone)
    expect(planKey(d.edges[0], a, b)).toBe(d.edges[0].plan!.key)
  })

  it('the same arrangement has the same route the first time it is worked out and every time after, off the grid as well as on it', () => {
    // sizes and places with awkward fractions, as things have once they are put down freely
    const nodes = [node('c', 'ec2', 0.137, 6.291, { scale: 1.218 }), node('g', 'ec2', 12.474, 3.278), node('x', 'ec2', 5.613, 4.907)]
    const edges = [edge('e', 'c', 'g'), edge('f', 'x', 'g'), edge('h', 'c', 'x')]
    const first = routeAll(nodes, edges)
    for (let i = 0; i < 3; i++) {
      const again = routeAll(nodes, edges)
      for (const e of edges) expect(again.get(e.id)!.pts, e.id).toEqual(first.get(e.id)!.pts)
    }
    // every run is still exactly along or across: no hairline step where a remembered route meets its end
    for (const r of first.values()) expect(square(r.pts)).toBe(true)
    // and planning it changes nothing
    const d = withPlans(docOf(nodes, edges))
    for (const e of edges) expect(routeAll(d.nodes, d.edges).get(e.id)!.pts).toEqual(first.get(e.id)!.pts)
  })

})
