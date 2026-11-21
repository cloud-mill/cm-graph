import { describe, expect, it } from 'vitest'
import { docOf, edge, node } from '../test/helpers'
import { routeAll } from './router'
import { type Track, dragRun, isShaped, lineUpEnds, shifted, simplify, snapRun, straighten, straightness, trackOf, unshaped, withTrack } from './shape'
import type { EdgeT, NodeT } from './types'

const N = (id: string, x: number, y: number, extra: Partial<NodeT> = {}) => node(id, 'ec2', x, y, extra)
const a = N('a', 0, 0), b = N('b', 8, 4)
const route = (nodes: NodeT[], e: Partial<EdgeT> = {}) => routeAll(nodes, [edge('e', 'a', 'b', e)]).get('e')!
const z: Track = { fromSide: 'e', toSide: 'w', fromAt: 0, toAt: 0, runs: [5] }
/** the line a track draws */
const drawn = (t: Track, nodes: NodeT[] = [a, b]) => route(nodes, t).pts

describe('reading the track off a drawn line', () => {
  it('a routed line gives its sides, where each end sits, and one coordinate per run between', () => {
    const r = route([a, b])
    const { track, seg } = trackOf(r, a, b)!
    expect(track).toEqual({ fromSide: 'e', toSide: 'w', fromAt: 0, toAt: 0, runs: [5] })
    expect(seg).toEqual([0, 1, 2])
    // following that track draws the very same line: taking hold of a line never makes it jump
    expect(drawn(track)).toEqual(r.pts)
  })
  it('a straight line has no runs between', () => {
    const level = [a, N('b', 8, 0)]
    expect(trackOf(route(level), level[0], level[1])!.track.runs).toEqual([])
  })
  it('ends that sit off the middle of their side are read as such', () => {
    const { track } = trackOf(route([a, b], { ...z, fromAt: 0.5, toAt: -0.25 }), a, b)!
    expect(track.fromAt).toBe(0.5)
    expect(track.toAt).toBe(-0.25)
  })
  it('an older line through one point, which doubled back on itself, is read as the plain line it should have been', () => {
    const level = [a, N('b', 8, 0)]
    const spur = route(level, { via: [[5, 3]] })
    // the spike down to the point and back
    expect(spur.pts.length).toBeGreaterThan(4)
    const { track, seg } = trackOf(spur, level[0], level[1])!
    expect(seg.length).toBe(spur.pts.length - 1)
    expect(seg.at(-1)).toBe(track.runs.length + 1)
    expect(track.runs.length % 2).toBe(1)
  })
  it('a direct line or a curve has no track', () => {
    expect(trackOf(route([a, b], { shape: 'direct' }), a, b)).toBeNull()
    expect(trackOf(route([a, b], { shape: 'curved' }), a, b)).toBeNull()
  })
})

describe('moving a run', () => {
  it('one in the middle moves alone: its neighbours stretch', () => {
    expect(drawn(dragRun(z, a, b, 1, 3))).toEqual([[2, 1], [3, 1], [3, 5], [8, 5]])
  })
  it('the first and last turn stay outside their components however far a run is pushed', () => {
    expect(dragRun(z, a, b, 1, 0).runs).toEqual([2.3])
    expect(dragRun(z, a, b, 1, 20).runs).toEqual([7.7])
    const long: Track = { ...z, runs: [3, 7, 6] }
    expect(dragRun(long, a, b, 2, 9).runs).toEqual([3, 9, 6])
    expect(dragRun(long, a, b, 3, 99).runs).toEqual([3, 7, 7.7])
  })
  it('the first run slides its end along the side, as far as the side goes', () => {
    expect(dragRun(z, a, b, 0, 1.5).fromAt).toBe(0.5)
    expect(dragRun(z, a, b, 0, 2.2).fromAt).toBe(0.85)
    expect(dragRun(z, a, b, 0, -0.1).fromAt).toBe(-0.85)
    expect(dragRun(z, a, b, 0, 1.5).runs).toEqual([5])
  })
  it('and so does the last', () => {
    expect(dragRun(z, a, b, 2, 4.5).toAt).toBe(-0.5)
    expect(dragRun(z, a, b, 2, 6.2).toAt).toBe(0.85)
  })
  it('an end run heading for the next run along is met by it when the side ends first, so the turn between them can go', () => {
    // a's middle is y = 1 and b's is y = 2: neither end can reach the other's line, but both can reach y = 1.85
    const near = N('b', 8, 1)
    const down = dragRun(z, a, near, 0, 2)
    expect(down).toMatchObject({ fromAt: 0.85, toAt: -0.15 })
    expect(simplify(down, a, near).runs).toEqual([])
    const up = dragRun(z, a, near, 2, 1)
    expect(up).toMatchObject({ fromAt: 0.15, toAt: -0.85 })
    // with more runs between, it is the next run on the same axis that comes to meet it
    const far = N('b', 8, 6), long: Track = { ...z, runs: [3, 2, 6] }
    expect(dragRun(long, a, far, 0, 2)).toMatchObject({ fromAt: 0.85, runs: [3, 1.85, 6] })
    expect(dragRun({ ...z, runs: [3, 6, 6] }, a, far, 4, 6)).toMatchObject({ toAt: -0.85, runs: [3, 6.15, 6] })
    // heading nowhere in particular, an end simply stops at the end of its side
    expect(dragRun(z, a, near, 0, 2.1)).toMatchObject({ fromAt: 0.85, toAt: 0 })
    // and when the other end could not come that far either, it stays where it is
    expect(dragRun({ ...z, toAt: -0.3 }, a, N('b', 8, 1.8), 0, 2.5)).toMatchObject({ fromAt: 0.85, toAt: -0.3 })
    expect(dragRun({ ...z, fromAt: -0.3 }, N('a', 0, 1.8), N('b', 8, 0), 2, 2.5)).toMatchObject({ fromAt: -0.3, toAt: 0.85 })
  })
  it('pulled well past the corner, an end run steps out of the side and goes round', () => {
    const out = dragRun(z, a, b, 0, 4)
    expect(out.fromAt).toBe(0)
    expect(out.runs).toEqual([2.5, 4, 5])
    expect(drawn(out)).toEqual([[2, 1], [2.5, 1], [2.5, 4], [5, 4], [5, 5], [8, 5]])
    const back = dragRun(z, a, b, 2, 8)
    expect(back.runs).toEqual([5, 8, 7.5])
    expect(drawn(back).at(-2)).toEqual([7.5, 5])
  })
  it('one straight run slides along both sides at once, within the strip they share', () => {
    const level = N('b', 8, 1), s: Track = { ...z, runs: [], fromAt: 0.5, toAt: -0.5 }
    const down = dragRun(s, a, level, 0, 1.75)
    expect(down).toMatchObject({ fromAt: 0.75, toAt: -0.25, runs: [] })
    // it stops at the end of the shared strip
    expect(dragRun(s, a, level, 0, 2.2)).toMatchObject({ fromAt: 0.85, runs: [] })
    expect(dragRun(s, a, level, 0, 0.7)).toMatchObject({ toAt: -0.85, runs: [] })
  })
  it('pulled right off both components, a straight run becomes a way round', () => {
    const level = N('b', 8, 0), s: Track = { ...z, runs: [] }
    const round = dragRun(s, a, level, 0, 4)
    expect(round.runs).toEqual([2.5, 4, 7.5])
    expect(drawn(round, [a, level])).toEqual([[2, 1], [2.5, 1], [2.5, 4], [7.5, 4], [7.5, 1], [8, 1]])
    // and the same when the two do not overlap at all, so there is no strip to slide in
    expect(dragRun({ ...z, runs: [] }, a, N('b', 8, 9), 0, 4).runs).toHaveLength(3)
  })
  it('a single corner slides either end along its side', () => {
    const corner: Track = { fromSide: 'e', toSide: 'n', fromAt: 0, toAt: 0, runs: [] }
    expect(dragRun(corner, a, b, 0, 1.5)).toMatchObject({ fromAt: 0.5, runs: [] })
    expect(dragRun(corner, a, b, 1, 8.5)).toMatchObject({ toAt: -0.5, runs: [] })
  })
})

describe('where a run in the hand comes to rest', () => {
  it('level with the next run along, which is what takes a turn out', () => {
    // the first run (y = 1) pulled down towards the last (y = 5)
    const near: Track = { ...z, toAt: -0.8 } // last run at y = 4.2... the first cannot reach, but the pull is the same
    expect(snapRun(near, a, b, 0, 4.05)).toBe(4.2)
    expect(snapRun({ ...z, runs: [3, 7, 6] }, a, b, 1, 6.2)).toBe(6)
    expect(snapRun({ ...z, runs: [3, 7, 6] }, a, b, 3, 2.8)).toBe(3)
  })
  it('on the middle of its component, for an end run', () => {
    expect(snapRun({ ...z, fromAt: 0.5 }, a, b, 0, 1.1)).toBe(1)
    expect(snapRun({ ...z, toAt: 0.5 }, a, b, 2, 4.9)).toBe(5)
  })
  it('a straight run is drawn to the middle of either component', () => {
    const level = N('b', 8, 1), s: Track = { ...z, runs: [], fromAt: 0.5, toAt: -0.5 }
    expect(snapRun(s, a, level, 0, 1.1)).toBe(1)
    expect(snapRun(s, a, level, 0, 1.9)).toBe(2)
  })
  it('the nearer of two marks wins, and otherwise it keeps to the grid: quarter cells along a side, half cells in the open', () => {
    expect(snapRun({ ...z, fromAt: 0.5, toAt: -3.3 }, a, b, 0, 1.4)).toBe(1.5) // nothing within reach
    expect(snapRun(z, a, b, 0, 1.62)).toBe(1.5)
    expect(snapRun(z, a, b, 1, 4.3)).toBe(4.5)
    expect(snapRun({ ...z, runs: [3, 7, 6], toAt: 1.8 }, a, b, 2, 6.9, 1)).toBe(6.8) // 6.8 (the last run) is nearer than 1 (the first)
    expect(snapRun(z, a, b, 0, 1.2, 0.05)).toBe(1.25)
  })
})

describe('tidying a track as it is put down', () => {
  it('the first run brought level with the last makes one straight line', () => {
    const level = N('b', 8, 1)
    // a Z between a (middle y = 1) and b (middle y = 2): the first end is slid down to y = 2
    expect(simplify({ ...z, fromAt: 1, toAt: 0 }, a, level).runs).toEqual([])
  })
  it('a run brought level with the next but one takes the turn between them out, wherever it is', () => {
    const long: Track = { ...z, runs: [3, 7, 6] }
    // middle run level with the first: the first two interior runs go
    expect(simplify({ ...long, runs: [3, 1, 6] }, a, b).runs).toEqual([6])
    // middle run level with the last
    expect(simplify({ ...long, runs: [3, 5, 6] }, a, b).runs).toEqual([3])
    // two interior runs level with each other
    expect(simplify({ ...z, runs: [3, 7, 4, 9, 4] }, a, b).runs).toEqual([3, 7, 4])
    expect(simplify({ ...z, runs: [3, 7, 3, 9, 6] }, a, b).runs).toEqual([3, 9, 6])
  })
  it('several at once, until nothing more can go', () => {
    expect(simplify({ ...z, toAt: -4, runs: [3, 1, 6] }, a, b).runs).toEqual([])
  })
  it('a track with nothing to take out is left alone', () => {
    expect(simplify(z, a, b)).toEqual(z)
    expect(simplify({ ...z, runs: [3, 7, 6] }, a, b).runs).toEqual([3, 7, 6])
  })
})

describe('what a connection carries', () => {
  const e = edge('e', 'a', 'b', { via: [[1, 2]], shape: 'curved', label: 'x' })
  it('given a track, it drops any other description of its path', () => {
    const t = withTrack(e, z)
    expect(t).toMatchObject({ fromSide: 'e', toSide: 'w', fromAt: 0, toAt: 0, runs: [5], label: 'x' })
    expect('via' in t).toBe(false)
    expect('shape' in t).toBe(false)
  })
  it('handed back to the router, it keeps how it is drawn unless told otherwise', () => {
    const shaped = { ...withTrack(e, z), shape: 'curved' as const }
    expect(unshaped(shaped)).toEqual({ ...edge('e', 'a', 'b', { label: 'x' }), shape: 'curved' })
    expect(unshaped(shaped, false)).toEqual(edge('e', 'a', 'b', { label: 'x' }))
    expect(unshaped(edge('e', 'a', 'b'))).toEqual(edge('e', 'a', 'b'))
  })
  it('knows whether it has been shaped', () => {
    expect(isShaped(edge('e', 'a', 'b'))).toBe(false)
    expect(isShaped(edge('e', 'a', 'b', { shape: 'direct' }))).toBe(false)
    for (const p of [{ via: [[1, 1]] }, { runs: [] }, { fromSide: 'e' }, { toSide: 'w' }, { fromAt: 0 }, { toAt: 0 }] as Partial<EdgeT>[]) expect(isShaped(edge('e', 'a', 'b', p))).toBe(true)
  })
  it('moves bodily with its components: runs across shift one way, runs along the other', () => {
    expect(shifted(withTrack(e, { ...z, runs: [3, 7, 6] }), 10, 100).runs).toEqual([13, 107, 16])
    expect(shifted(withTrack(e, { fromSide: 's', toSide: 'n', fromAt: 0, toAt: 0, runs: [3, 7, 6] }), 10, 100).runs).toEqual([103, 17, 106])
    expect(shifted(e, 1, 2).via).toEqual([[2, 4]])
    const plain = edge('e', 'a', 'b')
    expect(shifted(plain, 1, 2)).toBe(plain)
    // a track with no side to say which way its first run goes is left as it is
    expect(shifted(edge('e', 'a', 'b', { runs: [3] }), 1, 2).runs).toEqual([3])
  })
})

describe('how far a connection is from straight', () => {
  const D = (nodes: NodeT[], e: Partial<EdgeT> = {}, more: EdgeT[] = []) => docOf(nodes, [edge('e', 'a', 'b', e), ...more])
  it('straight already', () => {
    const d = D([a, N('b', 8, 0)])
    expect(straightness(d, d.edges[0])).toEqual({ state: 'straight' })
    const direct = D([a, b], { shape: 'direct' })
    expect(straightness(direct, direct.edges[0])).toEqual({ state: 'straight' })
    expect(straightness(docOf([a], [edge('e', 'a', 'gone')]), edge('e', 'a', 'gone'))).toEqual({ state: 'straight' })
  })
  it('one action away: the two overlap, but the line bends (it was shaped, or it is a curve)', () => {
    const bent = D([a, N('b', 8, 0)], { ...z, runs: [2.5, 4, 7.5] })
    expect(straightness(bent, bent.edges[0])).toEqual({ state: 'can', through: false })
    const curve = D([a, N('b', 8, 1.5)], { shape: 'curved' })
    expect(straightness(curve, curve.edges[0])).toEqual({ state: 'can', through: false })
    // a route worked out by whoever is drawing can be passed in instead of being worked out again
    expect(straightness(bent, bent.edges[0], routeAll(bent.nodes, bent.edges).get('e'))).toEqual({ state: 'can', through: false })
  })
  it('one action away, but under something standing between them', () => {
    const d = D([a, N('b', 10, 0), N('x', 5, 0)])
    expect(straightness(d, d.edges[0])).toEqual({ state: 'can', through: true })
  })
  it('apart: says which component would give way, and by how much, along the shorter way', () => {
    const d = D([a, b])
    // neither has anything else attached, so the far end moves; they are further apart in x, so it is brought level in y
    expect(straightness(d, d.edges[0])).toEqual({ state: 'apart', move: 'b', dx: 0, dy: -4 })
    const tall = D([a, N('b', 3, 9)])
    expect(straightness(tall, tall.edges[0])).toEqual({ state: 'apart', move: 'b', dx: -3, dy: 0 })
    // the one with more hanging off it stays put
    const busy = D([a, b, N('c', 20, 20)], {}, [edge('bc', 'b', 'c')])
    expect(straightness(busy, busy.edges[0])).toMatchObject({ move: 'a', dy: 4 })
  })
})

describe('straighten', () => {
  const one = (nodes: NodeT[], e: Partial<EdgeT> = {}) => { const r = straighten(docOf(nodes, [edge('e', 'a', 'b', e), edge('other', 'b', 'a')]), ['e']); return { ...r, e: r.doc.edges[0], pts: routeAll(r.doc.nodes, [r.doc.edges[0]]).get('e')!.pts } }
  it('makes a bent line between overlapping components one straight run, whatever it was before', () => {
    for (const was of [{ ...z, runs: [2.5, 4, 7.5] }, { via: [[5, 3]] }, { shape: 'curved' }, {}] as Partial<EdgeT>[]) {
      const r = one([a, N('b', 8, 1)], was)
      expect(r.pts).toEqual([[2, 1.5], [8, 1.5]])
      expect(r.e).toMatchObject({ fromSide: 'e', toSide: 'w', fromAt: 0.5, toAt: -0.5, runs: [] })
      expect(r.e.via).toBeUndefined()
      expect(r.e.shape).toBeUndefined()
      expect(r).toMatchObject({ straight: 1, apart: 0 })
    }
  })
  it('takes it under whatever stands between, when that is the only straight line there is', () => {
    expect(one([a, N('b', 10, 0), N('x', 5, 0)]).pts).toEqual([[2, 1], [10, 1]])
  })
  it('where the two are out of line it cannot: the line is handed back to the router with nothing pinned, and says so', () => {
    const r = one([a, b], { ...z, runs: [3, 7, 6] })
    expect(r).toMatchObject({ straight: 0, apart: 1 })
    expect(isShaped(r.e)).toBe(false)
    // one that was never shaped is left exactly as it was
    const plain = docOf([a, b], [edge('e', 'a', 'b')])
    expect(straighten(plain, ['e']).doc.edges[0]).toBe(plain.edges[0])
  })
  it('touches only the connections named, and ignores any whose component is missing', () => {
    const d = docOf([a, N('b', 8, 0)], [edge('e', 'a', 'b'), edge('f', 'b', 'a'), edge('g', 'a', 'nope')])
    const r = straighten(d, ['e', 'g'])
    expect(r.doc.edges[1]).toBe(d.edges[1])
    expect(r.doc.edges[2]).toBe(d.edges[2])
    expect(r.straight).toBe(1)
  })
})

describe('lining two components up', () => {
  it('moves the one with less attached level with the other, and the line between them is straight', () => {
    const d = lineUpEnds(docOf([a, b], [edge('e', 'a', 'b')]), 'e')
    expect(d.nodes.find((n) => n.id === 'b')).toMatchObject({ x: 8, y: 0 })
    expect(routeAll(d.nodes, d.edges).get('e')!.pts).toEqual([[2, 1], [8, 1]])
    expect(d.edges[0].runs).toEqual([])
  })
  it('never onto another component: it stops in the nearest free place', () => {
    const d = lineUpEnds(docOf([a, b, N('x', 8, 0)], [edge('e', 'a', 'b')]), 'e')
    const moved = d.nodes.find((n) => n.id === 'b')!
    expect(moved.x !== 8 || moved.y !== 0).toBe(true)
    expect(Math.abs(moved.x - 8) < 2 && Math.abs(moved.y) < 2).toBe(false)
  })
  it('two that are already in line are just straightened, and an unknown connection changes nothing', () => {
    const level = docOf([a, N('b', 8, 1)], [edge('e', 'a', 'b', { ...z, runs: [2.5, 4, 7.5] })])
    const d = lineUpEnds(level, 'e')
    expect(d.nodes).toEqual(level.nodes)
    expect(d.edges[0].runs).toEqual([])
    expect(lineUpEnds(level, 'nope')).toBe(level)
  })
})
