import { describe, expect, it } from 'vitest'
import { alignGuides, spacingGaps } from './guides'
import { lineUp, spaceEvenly } from './layout'
import { findPath, routeAll, routePair, routeToPoint } from './router'
import { clearOf, doorNear, magnet, portsOf, reachTo } from './snap'
import { docOf, edge, node } from '../test/helpers'

describe('doors and reach', () => {
  const n = node('a', 'ec2', 2, 4)
  it('a component has a door in the middle of each side, a little way out', () => {
    expect(portsOf(n, 0.5)).toEqual({ n: [3, 3.5], s: [3, 6.5], e: [4.5, 5], w: [1.5, 5] })
    // and they scale with it
    expect(portsOf({ ...n, scale: 2 }, 0.5).e).toEqual([6.5, 6])
  })
  it('reach is nothing inside the footprint and the gap outside it', () => {
    expect(reachTo(n, [3, 5])).toBe(0)
    expect(reachTo(n, [5, 5])).toBe(1)
    expect(reachTo(n, [5, 7])).toBeCloseTo(Math.SQRT2)
  })
  it('the door being aimed at is the nearest within reach, or none', () => {
    const ports = portsOf(n)
    expect(doorNear(ports, [4.5, 5.1], 0.3)).toBe('e')
    expect(doorNear(ports, [3, 3.4], 0.3)).toBe('n')
    expect(doorNear(ports, [3, 5], 0.3)).toBeUndefined()
  })
})

describe('magnet: what a loose end catches', () => {
  const nodes = [node('a', 'ec2', 0, 0), node('b', 'rds', 6, 0), node('c', 's3', 0, 6)]
  it('takes what is under the pointer first, whatever is nearer on the ground', () => {
    // a tall body can cover ground that belongs to a neighbour's cell
    expect(magnet(nodes, [0.5, 5.9], 1, 'b', 'a')?.id).toBe('a')
  })
  it('otherwise takes the nearest component within reach, and nothing beyond it', () => {
    expect(magnet(nodes, [5.3, 1], 0.9)?.id).toBe('b')
    expect(magnet(nodes, [4, 1], 0.9)).toBeNull()
    expect(magnet(nodes, [3.1, 1], 2)?.id).toBe('a')
  })
  it('never catches the component the line started from', () => {
    expect(magnet(nodes, [1, 1], 0.9, 'a')).toBeNull()
    expect(magnet(nodes, [1, 1], 0.9, 'a', 'a')).toBeNull()
    expect(magnet(nodes, [1, 1], 0.9)?.id).toBe('a')
  })
})

describe('clearOf: nowhere is shared', () => {
  const still = [node('b', 'rds', 6, 0), node('c', 's3', 9, 0)]
  it('leaves a free spot alone', () => {
    expect(clearOf([node('a', 'ec2', 0, 0)], still, 3, 0)).toEqual([3, 0])
    // touching is not overlapping
    expect(clearOf([node('a', 'ec2', 0, 0)], still, 4, 0)).toEqual([4, 0])
  })
  it('offers the nearest free spot when the one asked for is taken', () => {
    const [dx, dy] = clearOf([node('a', 'ec2', 0, 0)], still, 6, 0)
    expect(Math.abs(dx - 6) + Math.abs(dy)).toBe(2) // two cells clear, straight up or down or to the left
    expect(dx === 6 || dy === 0).toBe(true)
  })
  it('moves a whole group by one offset, so it keeps its shape', () => {
    const group = [node('a', 'ec2', 0, 0), node('d', 'sqs', 3, 0)]
    const [dx, dy] = clearOf(group, still, 6, 0)
    for (const g of group) for (const s of still) expect(g.x + dx + 2 <= s.x || s.x + 2 <= g.x + dx || g.y + dy + 2 <= s.y || s.y + 2 <= g.y + dy).toBe(true)
  })
  it('gives the spot back unchanged when everything nearby is taken', () => {
    const wall = Array.from({ length: 81 }, (_, i) => node('w' + i, 'ec2', (i % 9) * 2 - 8, Math.floor(i / 9) * 2 - 8))
    expect(clearOf([node('a', 'ec2', 20, 20)], wall, -20, -20, 1, 2)).toEqual([-20, -20])
  })
  it('respects the size of what is moved', () => {
    expect(clearOf([node('a', 'ec2', 0, 0, { scale: 2 })], [node('b', 'rds', 5, 0)], 2, 0)[0]).not.toBe(2)
  })
})

describe('equal spacing', () => {
  const row = [node('a', 'ec2', 0, 0), node('b', 'rds', 6, 0)]
  it('marks both gaps when the moving component sits midway between two neighbours', () => {
    const gaps = spacingGaps([node('a', 'ec2', 0, 0), node('m', 'sqs', 4, 0), node('b', 'rds', 8, 0)], new Set(['m']))
    expect(gaps).toEqual([{ axis: 'x', at: 1, from: 2, to: 4 }, { axis: 'x', at: 1, from: 6, to: 8 }])
  })
  it('marks the rhythm when it continues the spacing its neighbours already have, on either side', () => {
    const spans = (m: number) => spacingGaps([...row, node('m', 'sqs', m, 0)], new Set(['m'])).map((g) => [g.axis, g.at, g.from, g.to]).sort((p, q) => Number(p[2]) - Number(q[2]))
    expect(spans(12)).toEqual([['x', 1, 2, 6], ['x', 1, 8, 12]])
    expect(spans(-6)).toEqual([['x', 1, -4, 0], ['x', 1, 2, 6]])
  })
  it('works down a column as well', () => {
    const gaps = spacingGaps([node('a', 'ec2', 0, 0), node('m', 'sqs', 0, 5), node('b', 'rds', 0, 10)], new Set(['m']))
    expect(gaps.map((g) => g.axis)).toEqual(['y', 'y'])
    expect(gaps.map((g) => [g.from, g.to])).toEqual([[2, 5], [7, 10]])
  })
  it('says nothing when the gaps differ, when nothing is level with it, or when nothing is moving', () => {
    expect(spacingGaps([...row, node('m', 'sqs', 11, 0)], new Set(['m']))).toEqual([])
    expect(spacingGaps([...row, node('m', 'sqs', 12, 9)], new Set(['m']))).toEqual([])
    expect(spacingGaps(row, new Set())).toEqual([])
    expect(spacingGaps(row, new Set(['a', 'b']))).toEqual([])
  })
  it('treats a group being moved as one block', () => {
    const gaps = spacingGaps([node('a', 'ec2', 0, 0), node('m', 'sqs', 5, 0), node('n', 'sqs', 8, 0), node('b', 'rds', 13, 0)], new Set(['m', 'n']))
    expect(gaps.map((g) => [g.from, g.to])).toEqual([[2, 5], [10, 13]])
  })
  it('agrees with the alignment guides about what "level" means', () => {
    const nodes = [...row, node('m', 'sqs', 12, 0)]
    expect(alignGuides(nodes, new Set(['m'])).some((g) => g.axis === 'y')).toBe(true)
  })
})

describe('lining up and spacing out', () => {
  it('lines a loose row up on its middle member', () => {
    const d = lineUp(docOf([node('a', 'ec2', 0, 0), node('b', 'rds', 6, 1), node('c', 's3', 12, 3)]), ['a', 'b', 'c'])
    expect(d.nodes.map((n) => [n.x, n.y])).toEqual([[0, 1], [6, 1], [12, 1]])
  })
  it('lines a loose stack up as a column', () => {
    const d = lineUp(docOf([node('a', 'ec2', 0, 0), node('b', 'rds', 1, 6)]), ['a', 'b'])
    expect(d.nodes.map((n) => n.x)).toEqual([0, 0])
    expect(d.nodes.map((n) => n.y)).toEqual([0, 6])
  })
  it('two that would land on each other are moved along just far enough to stand clear', () => {
    const d = lineUp(docOf([node('a', 'ec2', 0, 0), node('b', 'rds', 1, 4), node('c', 's3', 8, 1)]), ['a', 'b', 'c'])
    expect(d.nodes.map((n) => [n.x, n.y])).toEqual([[0, 1], [3, 1], [8, 1]])
  })
  it('leaves everything else, and an already straight line, alone', () => {
    const doc = docOf([node('a', 'ec2', 0, 0), node('b', 'rds', 6, 0), node('z', 's3', 3, 9)])
    expect(lineUp(doc, ['a', 'b'])).toBe(doc)
    expect(lineUp(doc, ['a'])).toBe(doc)
    expect(lineUp(doc, ['a', 'z']).nodes[1]).toBe(doc.nodes[1])
  })
  it('spaces a row evenly between its two ends', () => {
    const d = spaceEvenly(docOf([node('a', 'ec2', 0, 0), node('b', 'rds', 3, 0), node('c', 's3', 12, 0)]), ['a', 'b', 'c'])
    expect(d.nodes.map((n) => n.x)).toEqual([0, 6, 12])
  })
  it('spaces a column, and counts sizes so the gaps between footprints are what is equal', () => {
    const d = spaceEvenly(docOf([node('a', 'ec2', 0, 0), node('b', 'rds', 0, 3, { scale: 2 }), node('c', 's3', 0, 14)]), ['a', 'b', 'c'])
    expect(d.nodes.map((n) => n.y)).toEqual([0, 6, 14])
    // 2 + 4 + 4 + 4 + 2: three footprints of different sizes, two equal gaps, both ends where they were
    expect([d.nodes[1].y - 2, d.nodes[2].y - (d.nodes[1].y + 4)]).toEqual([4, 4])
  })
  it('never leaves them touching: a row too tight to share out is opened up', () => {
    const d = spaceEvenly(docOf([node('a', 'ec2', 0, 0), node('b', 'rds', 2, 0), node('c', 's3', 4, 0)]), ['a', 'b', 'c'])
    expect(d.nodes.map((n) => n.x)).toEqual([0, 3, 6])
  })
  it('needs three, and leaves an even row alone', () => {
    const doc = docOf([node('a', 'ec2', 0, 0), node('b', 'rds', 6, 0), node('c', 's3', 12, 0)])
    expect(spaceEvenly(doc, ['a', 'b'])).toBe(doc)
    expect(spaceEvenly(doc, ['a', 'b', 'c'])).toBe(doc)
  })
})

describe('routes for something in the hand', () => {
  const a = node('a', 'ec2', 0, 0), b = node('b', 'rds', 8, 0)
  it('a loose end is one clean elbow from the door facing the pointer', () => {
    expect(routeToPoint(a, [6, 4], [a, b])).toEqual([[2, 1], [6, 1], [6, 4]])
    expect(routeToPoint(a, [1, -5], [a, b])).toEqual([[1, 0], [1, -5]])
    expect(routeToPoint(a, [-4, 3], [a, b])).toEqual([[0, 1], [-4, 1], [-4, 3]])
  })
  it('right beside the door it still leaves straight out before turning', () => {
    expect(routeToPoint(a, [2.2, 3], [a], 'e')).toEqual([[2, 1], [2.5, 1], [2.5, 3], [2.2, 3]])
  })
  it('a preview between two components can be asked to arrive at a particular door', () => {
    const auto = routePair(a, b, [a, b]), pinned = routePair(a, b, [a, b], { toSide: 'n' })
    expect(auto.at(-1)).toEqual([8, 1])
    expect(pinned.at(-1)).toEqual([9, 0])
  })
  it('the same arrangement anywhere on the ground has the same route, moved', () => {
    const blocks = [{ x0: 4, y0: 0, x1: 6, y1: 2 }]
    const here = findPath([2.5, 1], [1, 0], [7.5, 1], [1, 0], blocks)
    const there = findPath([12.5, 31], [1, 0], [17.5, 31], [1, 0], [{ x0: 14, y0: 30, x1: 16, y1: 32 }])
    expect(there).toEqual(here.map(([x, y]) => [x + 10, y + 30]))
    // and between grid positions, as while something is carried
    const off = findPath([2.83, 1.41], [1, 0], [7.83, 1.41], [1, 0], [{ x0: 4.33, y0: 0.41, x1: 6.33, y1: 2.41 }])
    expect(off.length).toBe(here.length)
    off.forEach(([x, y], i) => { expect(x).toBeCloseTo(here[i][0] + 0.33, 2); expect(y).toBeCloseTo(here[i][1] + 0.41, 2) })
  })
  it('while a component is carried between cells its elbow glides with it instead of ticking from half cell to half cell', () => {
    const at = (x: number) => routeAll([a, node('b', 'rds', x, 6)], [edge('e', 'a', 'b')]).get('e')!.pts
    const xs = [8, 8.1, 8.2, 8.3, 8.4].map((x) => at(x)[1][0])
    for (let i = 1; i < xs.length; i++) { expect(xs[i] - xs[i - 1]).toBeGreaterThan(0); expect(xs[i] - xs[i - 1]).toBeLessThan(0.11) }
  })
})
