import { describe, expect, it } from 'vitest'
import { docOf, edge, node } from '../test/helpers'
import { routeAll, withPlans } from './router'
import { KINK, type Track, addBend, alignRun, canReroute, bendAt, dragRun, dragTurn, isManual, isShaped, keepPath, kinked, lineUpEnds, nearestRun, removeBend, shifted, simplify, snapRun, straighten, straightness, tidyKinks, trackOf, unbend, unshaped, withTrack } from './shape'
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
  it('past the corner an end run steps out and round, starting from nothing: it never sticks and then jumps', () => {
    // the end stops at the corner of its side (y = 1.85) and the run carries on under the hand
    const just = dragRun(z, a, b, 0, 1.86)
    expect(just).toMatchObject({ fromAt: 0.85, runs: [2.5, 1.86, 5] })
    expect(drawn(just)).toEqual([[2, 1.85], [2.5, 1.85], [2.5, 1.86], [5, 1.86], [5, 5], [8, 5]])
    const out = dragRun(z, a, b, 0, 4)
    expect(out).toMatchObject({ fromAt: 0.85, runs: [2.5, 4, 5] })
    expect(drawn(out)).toEqual([[2, 1.85], [2.5, 1.85], [2.5, 4], [5, 4], [5, 5], [8, 5]])
    const back = dragRun(z, a, b, 2, 8)
    expect(back).toMatchObject({ toAt: 0.85, runs: [5, 8, 7.5] })
    expect(drawn(back).at(-2)).toEqual([7.5, 5.85])
    // where the line already turns close to the component, the step is taken nearer still, so the run in the hand has somewhere to be
    expect(dragRun({ ...z, runs: [2.4] }, a, b, 0, 4).runs).toEqual([2.3, 4, 2.4])
  })
  it('an end of a single step put on the line where the two ends can meet makes the connection straight: the far end comes the last of the way', () => {
    // a's middle is y = 1 and b's is y = 2: neither end can reach the other's line, but both can reach y = 1.85
    const near = N('b', 8, 1)
    expect(snapRun(z, a, near, 0, 1.8)).toBe(1.85)
    const down = dragRun(z, a, near, 0, 1.85)
    expect(down).toMatchObject({ fromAt: 0.85, toAt: -0.15 })
    expect(simplify(down, a, near).runs).toEqual([])
    expect(snapRun(z, a, near, 2, 1.2)).toBe(1.15)
    expect(simplify(dragRun(z, a, near, 2, 1.15), a, near)).toMatchObject({ fromAt: 0.15, toAt: -0.85, runs: [] })
    // when the far end is already somewhere this end can reach, it does not move at all
    const level = N('b', 8, 0), off: Track = { ...z, toAt: 0.5 }
    expect(dragRun(off, a, level, 0, 1.5)).toEqual({ ...off, fromAt: 0.5 })
    // and two that share no line have nowhere to meet
    expect(snapRun(z, a, b, 0, 1.8)).toBe(1.8)
  })
  it('nothing else moves otherwise: an end run pulled past its corner leaves the far end and every other run alone', () => {
    const near = N('b', 8, 1)
    expect(dragRun(z, a, near, 0, 2)).toMatchObject({ fromAt: 0.85, toAt: 0, runs: [2.5, 2, 5] })
    const far = N('b', 8, 6), long: Track = { ...z, runs: [3, 2, 6] }
    expect(dragRun(long, a, far, 0, 2).runs.slice(-3)).toEqual([3, 2, 6])
  })
  it('one straight run slides along both sides at once, within the strip they share', () => {
    const level = N('b', 8, 1), s: Track = { ...z, runs: [], fromAt: 0.5, toAt: -0.5 }
    expect(dragRun(s, a, level, 0, 1.75)).toEqual({ ...s, fromAt: 0.75, toAt: -0.25 })
    // past the end of the strip the two ends wait at the corner and the run goes on round
    expect(dragRun(s, a, level, 0, 2.2)).toMatchObject({ fromAt: 0.85, toAt: -0.15, runs: [2.5, 2.2, 7.5] })
    expect(dragRun(s, a, level, 0, 0.7)).toMatchObject({ fromAt: 0.15, toAt: -0.85, runs: [2.5, 0.7, 7.5] })
  })
  it('pulled right off both components, a straight run becomes a way round', () => {
    const level = N('b', 8, 0), s: Track = { ...z, runs: [] }
    const round = dragRun(s, a, level, 0, 4)
    expect(round.runs).toEqual([2.5, 4, 7.5])
    expect(drawn(round, [a, level])).toEqual([[2, 1.85], [2.5, 1.85], [2.5, 4], [7.5, 4], [7.5, 1.85], [8, 1.85]])
    // and the same when the two do not overlap at all, so there is no strip to slide in: the ends stay as they were
    expect(dragRun({ ...z, runs: [] }, a, N('b', 8, 9), 0, 4)).toMatchObject({ fromAt: 0, toAt: 0, runs: [2.5, 4, 7.5] })
  })
  it('a single corner slides either end along its side', () => {
    const corner: Track = { fromSide: 'e', toSide: 'n', fromAt: 0, toAt: 0, runs: [] }
    expect(dragRun(corner, a, b, 0, 1.5)).toMatchObject({ fromAt: 0.5, runs: [] })
    expect(dragRun(corner, a, b, 1, 8.5)).toMatchObject({ toAt: -0.5, runs: [] })
  })
})

describe('taking a turn in the hand', () => {
  it('both runs that meet at it go where it goes', () => {
    expect(dragTurn(z, a, b, 0, 1.5, 4)).toEqual({ ...z, fromAt: 0.5, runs: [4] })
    expect(dragTurn(z, a, b, 1, 6, 4.5)).toEqual({ ...z, toAt: -0.5, runs: [6] })
  })
  it('and when one of them steps round its corner, the other still lands where it was put', () => {
    expect(dragTurn(z, a, b, 1, 6, 7)).toEqual({ ...z, toAt: 0.85, runs: [6, 7, 7.5] })
    expect(dragTurn(z, a, b, 0, 3, 4)).toEqual({ ...z, fromAt: 0.85, runs: [2.5, 3, 4] })
  })
})

describe('where a run in the hand comes to rest', () => {
  it('exactly where it is put, when nothing is near', () => {
    expect(snapRun(z, a, b, 1, 4.37)).toBe(4.37)
    expect(snapRun({ ...z, toAt: -0.8 }, a, b, 0, 3.8)).toBe(3.8)
    // however wide the pull, the grid only ever draws it a little way
    expect(snapRun(z, a, b, 1, 4.35, 1)).toBe(4.35)
  })
  it('level with the next run along when it is within a few pixels of it, which is what takes a turn out', () => {
    expect(snapRun({ ...z, toAt: -0.8 }, a, b, 0, 4.27)).toBe(4.2)
    expect(snapRun({ ...z, runs: [3, 7, 6] }, a, b, 1, 6.08)).toBe(6)
    expect(snapRun({ ...z, runs: [3, 7, 6] }, a, b, 3, 2.93)).toBe(3)
  })
  it('on the middle of its component, for an end run', () => {
    expect(snapRun({ ...z, fromAt: 0.5 }, a, b, 0, 1.06)).toBe(1)
    expect(snapRun({ ...z, toAt: 0.5 }, a, b, 2, 4.94)).toBe(5)
  })
  it('a straight run is drawn to the middle of either component', () => {
    const level = N('b', 8, 1), s: Track = { ...z, runs: [], fromAt: 0.5, toAt: -0.5 }
    expect(snapRun(s, a, level, 0, 1.06)).toBe(1)
    expect(snapRun(s, a, level, 0, 1.94)).toBe(2)
  })
  it('the nearer of two marks wins, and a half cell of the grid draws it only from very close', () => {
    expect(snapRun({ ...z, runs: [3, 7, 6], toAt: 1.8 }, a, b, 2, 6.9, 1)).toBe(6.8) // 6.8 (the last run) is nearer than 1 (the first)
    expect(snapRun(z, a, b, 1, 4.46)).toBe(4.5)
    expect(snapRun(z, a, b, 1, 4.4)).toBe(4.4)
  })
  it('with no pull at all nothing draws it: it goes where it is put', () => {
    expect(snapRun(z, a, b, 1, 4.47, 0)).toBe(4.47)
    expect(snapRun({ ...z, fromAt: 0.5 }, a, b, 0, 1.01, 0)).toBe(1.01)
  })
})

describe('putting a bend in, and taking one out', () => {
  it('a run is given a step where it was pointed at: the part nearer the start stays', () => {
    expect(drawn(addBend(z, a, b, 1, 3))).toEqual([[2, 1], [5, 1], [5, 3], [6, 3], [6, 5], [8, 5]])
    // in the first run the step goes towards where the line is heading, and in the last it is the earlier part that moves
    expect(addBend(z, a, b, 0, 3.4).runs).toEqual([3.5, 2, 5])
    expect(drawn(addBend(z, a, b, 2, 6.5))).toEqual([[2, 1], [5, 1], [5, 4], [6.5, 4], [6.5, 5], [8, 5]])
  })
  it('a straight line gets a step by sliding one end along its side, or a detour when neither has room', () => {
    const level = N('b', 8, 0), s: Track = { ...z, runs: [] }
    expect(addBend(s, a, level, 0, 5.1)).toEqual({ ...s, toAt: 0.5, runs: [5] })
    expect(addBend({ ...s, fromAt: 0.6, toAt: 0.6 }, a, level, 0, 5)).toMatchObject({ toAt: -0.4, runs: [5] })
    // b is too small for its end to slide that far, so it is a's end that moves
    expect(addBend(s, a, N('b', 8, 0.5, { scale: 0.5 }), 0, 5)).toMatchObject({ fromAt: 0.5, toAt: 0, runs: [5] })
    const small = [N('a', 0, 0, { scale: 0.5 }), N('b', 8, 0, { scale: 0.5 })]
    expect(addBend(s, small[0], small[1], 0, 5).runs).toEqual([4.5, 1.5, 5.5])
  })
  it('a turn is taken out by bringing the shorter run at it down to nothing', () => {
    // out at y = 1, down x = 3, along y = 7, up x = 6, in at y = 5: the turn where x = 3 meets y = 7
    expect(removeBend({ ...z, runs: [3, 7, 6] }, a, b, 1)).toMatchObject({ runs: [6] })
    // two components nearly level: the end slides and the line is straight
    const near = N('b', 8, 0.5)
    expect(removeBend(z, a, near, 0)).toEqual({ ...z, fromAt: 0.5, runs: [] })
  })
  it('one that cannot go, because the ends are not in line, is left', () => {
    expect(removeBend(z, a, b, 0)).toBeNull()
    expect(removeBend(z, a, b, 1)).toBeNull()
    expect(removeBend(z, a, b, 5)).toBeNull()
    expect(removeBend(z, a, b, -1)).toBeNull()
  })
  it('on a blueprint: at the point of the line nearest where it was asked for', () => {
    const d = docOf([a, b], [edge('e', 'a', 'b')])
    expect(bendAt(d, 'e', [5.2, 3]).edges[0]).toMatchObject({ runs: [5, 3, 6], fromSide: 'e', toSide: 'w' })
    // never on top of a turn, and not at all in a stretch too short to hold one
    expect(bendAt(d, 'e', [5, 1.1]).edges[0].runs).toEqual([5, 1.5, 6])
    const tight = docOf([a, N('b', 2.8, 4)], [edge('e', 'a', 'b', { fromSide: 'e', toSide: 'w', runs: [2.4] })])
    expect(bendAt(tight, 'e', [2.3, 1])).toBe(tight)
    expect(bendAt(d, 'nope', [0, 0])).toBe(d)
    const bent = docOf([a, b], [edge('e', 'a', 'b', { ...z, runs: [3, 7, 6] })])
    expect(unbend(bent, 'e', 2).edges[0].runs).toEqual([6])
    expect(unbend(bent, 'e', 0)).toBe(bent)
    expect(unbend(bent, 'e', 9)).toBe(bent)
    expect(unbend(d, 'e', 1)).toBe(d)
    expect(unbend(d, 'nope', 1)).toBe(d)
  })
  it('which stretch of a line a point is nearest to', () => {
    const pts: [number, number][] = [[2, 1], [5, 1], [5, 5], [8, 5]]
    expect(nearestRun(pts, [3, 1.4])).toBe(0)
    expect(nearestRun(pts, [5.3, 3])).toBe(1)
    expect(nearestRun(pts, [9, 6])).toBe(2)
    expect(nearestRun([[1, 1], [1, 1]], [4, 4])).toBe(0)
  })
})

describe('whose line it is', () => {
  it('keeping a path takes the line exactly as the router drew it: nothing moves, and it is the user\'s from then on', () => {
    const c = N('c', 8, 0), d = docOf([a, b, c], [edge('e', 'a', 'b'), edge('f', 'a', 'c'), edge('g', 'a', 'b', { shape: 'curved' })])
    const before = routeAll(d.nodes, d.edges)
    const kept = keepPath(d, ['e', 'g'])
    expect(isManual(kept.edges[0])).toBe(true)
    expect(isManual(kept.edges[1])).toBe(false)
    expect(kept.edges[2]).toBe(d.edges[2]) // a curve has no path to keep
    const after = routeAll(kept.nodes, kept.edges)
    // not the line itself, and not the one beside it on the same side
    expect(after.get('e')!.pts).toEqual(before.get('e')!.pts)
    expect(after.get('f')!.pts).toEqual(before.get('f')!.pts)
    expect(after.get('e')!.manual).toBe(true)
    // once kept there is nothing more to keep
    expect(keepPath(kept, ['e'])).toBe(kept)
    expect(keepPath(d, ['nope'])).toBe(d)
  })
  it('a kept path stays put when something else in the diagram moves or is added', () => {
    const d = keepPath(docOf([a, b], [edge('e', 'a', 'b')]), ['e'])
    const was = routeAll(d.nodes, d.edges).get('e')!.pts
    // a component dropped right on the line, and another line added to the same side
    const more = { ...d, nodes: [...d.nodes, N('x', 4, 2), N('c', 8, 0)], edges: [...d.edges, edge('f', 'a', 'c')] }
    expect(routeAll(more.nodes, more.edges).get('e')!.pts).toEqual(was)
  })
  it('manual means it has a path of its own, in either form', () => {
    expect(isManual(edge('e', 'a', 'b'))).toBe(false)
    expect(isManual(edge('e', 'a', 'b', { fromSide: 'e' }))).toBe(false)
    expect(isManual(edge('e', 'a', 'b', { runs: [] }))).toBe(true)
    expect(isManual(edge('e', 'a', 'b', { via: [[3, 3]] }))).toBe(true)
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

describe('a run brought all but level with its neighbour is level', () => {
  const zig: Track = { ...z, runs: [3, 7, 6] } // runs stand at y 1, x 3, y 7, x 6, y 5
  it('catches only the lines the neighbouring runs of the same connection stand on, and only from very close', () => {
    expect(alignRun(zig, a, b, 2, 1.04, 0.1)).toBe(1)
    expect(alignRun(zig, a, b, 2, 4.95, 0.1)).toBe(5)
    expect(alignRun(zig, a, b, 1, 5.93, 0.1)).toBe(6)
    // a deliberate small offset is outside it, and so is everything that is not a neighbour: a half cell, a component's middle
    expect(alignRun(zig, a, b, 2, 1.2, 0.1)).toBeNull()
    expect(alignRun(zig, a, b, 2, 3.5, 0.1)).toBeNull()
    expect(alignRun({ ...z, fromAt: 0.5 }, a, b, 0, 1.01, 0.1)).toBeNull()
    // the nearer of two wins
    expect(alignRun({ ...z, runs: [3, 5.1, 6] }, a, b, 2, 5.06, 0.2)).toBe(5)
  })
  it('never to a line the run could not stand on: past the corner of its component, or inside one', () => {
    // b's end is at y = 5, well past the corner of a, whose side only reaches y = 1.85
    expect(alignRun(z, a, b, 0, 4.98, 0.1)).toBeNull()
    expect(alignRun(z, a, N('b', 8, 0.5), 0, 1.48, 0.1)).toBe(1.5)
    // the first turn stays outside a: a run level with something nearer than that is not on offer
    expect(alignRun({ ...z, runs: [5, 3, 2.1, 4, 6] }, a, b, 1, 2.12, 0.1)).toBeNull()
    expect(alignRun({ ...z, runs: [3, 3, 7.9, 4, 6] }, a, b, 5, 7.88, 0.1)).toBeNull()
  })
  it('with no tolerance there is no help at all', () => {
    expect(alignRun(zig, a, b, 2, 1.001, 0)).toBeNull()
  })
  it('once caught it holds a little further than it catches, so it cannot flicker at the edge, and then lets go', () => {
    expect(alignRun(zig, a, b, 2, 1.13, 0.1)).toBeNull()
    expect(alignRun(zig, a, b, 2, 1.13, 0.1, 1)).toBe(1)
    expect(alignRun(zig, a, b, 2, 1.16, 0.1, 1)).toBeNull()
    // what it was on must still be one of its lines
    expect(alignRun(zig, a, b, 2, 1.13, 0.1, 1.1)).toBeNull()
  })
  it('the value handed back is the neighbour itself, so the turn between them drops out exactly', () => {
    const v = alignRun(zig, a, b, 2, 1.03, 0.1)!
    expect(simplify(dragRun(zig, a, b, 2, v), a, b).runs).toEqual([6])
  })
})

describe('cleaning the small kinks out of a line', () => {
  const D = (e: Partial<EdgeT>, nodes: NodeT[] = [a, b]) => docOf(nodes, [edge('e', 'a', 'b', e)])
  const cleaned = (e: Partial<EdgeT>, nodes?: NodeT[]) => tidyKinks(D(e, nodes), ['e'])
  it('a hair of a step in the middle of a line goes, and the rest of the line stays exactly as it was', () => {
    const r = cleaned({ fromSide: 'e', toSide: 'w', fromAt: 0, toAt: 0, runs: [3, 1.04, 5, 3, 6] })
    expect(r.tidied).toBe(1)
    expect(r.doc.edges[0]).toMatchObject({ fromAt: 0, toAt: 0, runs: [5, 3, 6] })
  })
  it('an end of the line stays where it is on its component: the run beside it is the one that moves', () => {
    const r = cleaned({ fromSide: 'e', toSide: 'w', fromAt: 0, toAt: 0, runs: [3, 7, 6, 4.95, 7] })
    expect(r.doc.edges[0]).toMatchObject({ toAt: 0, runs: [3, 7, 6] })
  })
  it('a line that is one small step between two facing sides becomes straight', () => {
    const level = N('b', 8, 0.05)
    const r = cleaned({ fromSide: 'e', toSide: 'w', fromAt: 0, toAt: 0, runs: [5] }, [a, level])
    expect(r.doc.edges[0]).toMatchObject({ runs: [] })
    expect(routeAll(r.doc.nodes, r.doc.edges).get('e')!.pts).toHaveLength(2)
  })
  it('a step somebody made is left alone, and so is a line with none', () => {
    const made = D({ fromSide: 'e', toSide: 'w', fromAt: 0, toAt: 0, runs: [3, 1 + KINK * 2, 5, 3, 6] })
    expect(tidyKinks(made, ['e'])).toEqual({ doc: made, tidied: 0, taken: 0 })
    const plain = D({ fromSide: 'e', toSide: 'w', fromAt: 0, toAt: 0, runs: [5] })
    expect(tidyKinks(plain, ['e']).doc).toBe(plain)
  })
  it('only the lines asked about are looked at, and lines that are not right-angled have nothing to clean', () => {
    const kinked: Partial<EdgeT> = { fromSide: 'e', toSide: 'w', fromAt: 0, toAt: 0, runs: [3, 1.04, 5, 3, 6] }
    expect(tidyKinks(D(kinked), ['other']).tidied).toBe(0)
    expect(tidyKinks(D({ shape: 'curved' }), ['e']).tidied).toBe(0)
  })
  it('several kinks in one line all go in one pass', () => {
    const r = cleaned({ fromSide: 'e', toSide: 'w', fromAt: 0, toAt: 0, runs: [3, 1.04, 4, 1.08, 5, 3, 6] })
    expect(r.doc.edges[0].runs).toEqual([5, 3, 6])
  })
})

describe('whose line it is after cleaning, and what can be asked of a line', () => {
  it('a line the router planned becomes the user\'s when a kink is taken out of it, and that is counted', () => {
    // level to within a twentieth of a cell, with something standing where the straight run would go
    const nodes = [a, N('b', 8, 0.05), N('wall', 4.5, -0.6)]
    const planned = withPlans(docOf(nodes, [edge('e', 'a', 'b', { plan: { pts: [[2, 1], [3, 1], [3, 1.05], [8, 1.05]], fromSide: 'e', toSide: 'w', key: '' } })]))
    const hand = docOf(nodes, [edge('e', 'a', 'b', { fromSide: 'e', toSide: 'w', fromAt: 0, toAt: 0, runs: [3] })])
    expect(tidyKinks(hand, ['e'])).toMatchObject({ tidied: 1, taken: 0 })
    const auto = docOf(nodes, [{ ...planned.edges[0], plan: { ...planned.edges[0].plan!, pts: [[2, 1], [3, 1], [3, 1.05], [8, 1.05]] } }])
    const r = tidyKinks(auto, ['e'])
    expect(r).toMatchObject({ tidied: 1, taken: 1 })
    expect(isManual(r.doc.edges[0])).toBe(true)
    expect(r.doc.edges[0].plan).toBeUndefined()
  })
  it('a kink is seen from what the line carries, without routing anything', () => {
    const D = (e: Partial<EdgeT>) => docOf([a, b], [edge('e', 'a', 'b', e)])
    const has = (e: Partial<EdgeT>) => { const d = D(e); return kinked(d, d.edges[0]) }
    expect(has({ fromSide: 'e', toSide: 'w', fromAt: 0, toAt: 0, runs: [3, 1.04, 5, 3, 6] })).toBe(true)
    expect(has({ fromSide: 'e', toSide: 'w', fromAt: 0, toAt: 0, runs: [3, 1.5, 5, 3, 6] })).toBe(false)
    expect(has({ fromSide: 'e', toSide: 'w', fromAt: 0, toAt: 0, runs: [5] })).toBe(false)
    // a planned path is read the same way
    expect(has({ plan: { pts: [[2, 1], [3, 1], [3, 1.04], [5, 1.04], [5, 5], [8, 5]], fromSide: 'e', toSide: 'w', key: 'k' } })).toBe(true)
    expect(has({ plan: { pts: [[2, 1], [5, 1], [5, 5], [8, 5]], fromSide: 'e', toSide: 'w', key: 'k' } })).toBe(false)
    // nothing to read: no path of its own, not right-angled, or an end that is not there
    expect(has({})).toBe(false)
    expect(has({ shape: 'curved', runs: [3, 1.04, 5, 3, 6], fromSide: 'e', toSide: 'w' })).toBe(false)
    expect(kinked(docOf([a], []), edge('e', 'a', 'gone', { runs: [3, 1.04, 5], fromSide: 'e', toSide: 'w' }))).toBe(false)
    // sides given but no word on where the ends sit: the middle
    expect(has({ fromSide: 'e', toSide: 'w', runs: [3, 1.04, 5, 3, 6] })).toBe(true)
  })
  it('a line can be handed back to the router when it was shaped, or when it has a plan that could be made again', () => {
    expect(canReroute(edge('e', 'a', 'b'))).toBe(false)
    expect(canReroute(edge('e', 'a', 'b', { runs: [5], fromSide: 'e', toSide: 'w' }))).toBe(true)
    expect(canReroute(edge('e', 'a', 'b', { plan: { pts: [[2, 1], [8, 1]], fromSide: 'e', toSide: 'w', key: 'k' } }))).toBe(true)
  })
})
