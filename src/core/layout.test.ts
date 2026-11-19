import { describe, expect, it } from 'vitest'
import { autoLayout, fitArea, inArea } from './layout'
import { TEMPLATES } from './templates'
import type { AreaT, Doc } from './types'
import { docOf, edge, node } from '../test/helpers'

const area = (id: string, x: number, y: number, w: number, d: number, extra: Partial<AreaT> = {}): AreaT => ({ id, x, y, w, d, name: id, color: '#888888', kind: 'group', ...extra })
const overlapFree = (d: Doc) => {
  for (const a of d.nodes) for (const b of d.nodes) if (a !== b && Math.abs(a.x - b.x) < 2 && Math.abs(a.y - b.y) < 2) return false
  return true
}
const pos = (d: Doc, id: string) => d.nodes.find((n) => n.id === id)!

describe('inArea', () => {
  const a = area('a', 0, 0, 10, 6)
  it('tests the centre of the footprint, borders included', () => {
    expect(inArea(a, { x: -1, y: -1 })).toBe(true) // centre (0,0) on the corner
    expect(inArea(a, { x: 9, y: 5 })).toBe(true) // centre (10,6) on the far corner
    expect(inArea(a, { x: 9.01, y: 5 })).toBe(false)
    expect(inArea(a, { x: 4, y: 5.01 })).toBe(false)
    expect(inArea(a, { x: -1.01, y: 2 })).toBe(false)
    expect(inArea(a, { x: 4, y: -1.01 })).toBe(false)
  })
})

describe('fitArea', () => {
  const a = area('a', 50, 50, 3, 3)
  it('returns the same area when there is nothing to wrap', () => {
    expect(fitArea(a, [])).toBe(a)
  })
  it('wraps nodes with padding and room for the title', () => {
    expect(fitArea(a, [{ x: 0, y: 0 }, { x: 6, y: 4 }])).toMatchObject({ id: 'a', x: -1, y: -1.5, w: 10, d: 8.5 })
    expect(fitArea(a, [{ x: 0, y: 0 }], 0)).toMatchObject({ x: 0, y: -0.5, w: 2, d: 2.5 })
    expect(fitArea(a, [{ x: 0, y: 0 }], 2.5)).toMatchObject({ x: -2.5, y: -3, w: 7, d: 7.5 })
  })
  it('accounts for resized components', () => {
    expect(fitArea(a, [{ x: 0, y: 0, scale: 3 }], 0)).toMatchObject({ w: 6, d: 6.5 })
    expect(fitArea(a, [{ x: 0, y: 0, scale: 0.5 }], 0)).toMatchObject({ w: 1, d: 1.5 })
  })
  it('includes extra rectangles, with or without nodes', () => {
    expect(fitArea(a, [], 1, [{ x: 10, y: 10, w: 4, d: 4 }])).toMatchObject({ x: 9, y: 8.5, w: 6, d: 6.5 })
    expect(fitArea(a, [{ x: 0, y: 0 }], 1, [{ x: 10, y: 10, w: 4, d: 4 }])).toMatchObject({ x: -1, y: -1.5, w: 16, d: 16.5 })
  })
  it('keeps the other fields of the area', () => {
    expect(fitArea(area('z', 0, 0, 1, 1, { kind: 'vpc', name: 'Prod', color: '#123456' }), [{ x: 0, y: 0 }])).toMatchObject({ id: 'z', kind: 'vpc', name: 'Prod', color: '#123456' })
  })
})

describe('autoLayout', () => {
  it('returns the same blueprint when it is empty', () => {
    const d = docOf()
    expect(autoLayout(d)).toBe(d)
  })
  it('puts a single component at the origin', () => {
    const l = autoLayout(docOf([node('a', 'ec2', 37, -12)]))
    expect(l.nodes[0]).toMatchObject({ id: 'a', x: 0, y: 0 })
  })
  it('lays a chain out left to right in request order', () => {
    const d = docOf([node('db', 'rds', 0, 0), node('web', 'ec2', 0, 0), node('lb', 'alb', 0, 0), node('u', 'users', 0, 0)], [edge('1', 'u', 'lb'), edge('2', 'lb', 'web'), edge('3', 'web', 'db')])
    const l = autoLayout(d)
    expect(['u', 'lb', 'web', 'db'].map((id) => pos(l, id).x)).toEqual([0, 6, 12, 18])
    expect(new Set(l.nodes.map((n) => n.y)).size).toBe(1)
  })
  it('does not mutate the input and keeps everything but positions', () => {
    const d = docOf([node('a', 'ec2', 5, 5, { name: 'A', color: '#111111', scale: 2 }), node('b', 'rds', 9, 9)], [edge('1', 'a', 'b')])
    const before = JSON.stringify(d)
    const l = autoLayout(d)
    expect(JSON.stringify(d)).toBe(before)
    expect(l.edges).toBe(d.edges)
    expect(pos(l, 'a')).toMatchObject({ name: 'A', color: '#111111', scale: 2, type: 'ec2' })
  })
  it('is deterministic', () => {
    for (const t of TEMPLATES) {
      const d = t.make()
      expect(autoLayout(d)).toEqual(autoLayout(d))
      // and stable: tidying a tidy layout changes nothing
      const once = autoLayout(d)
      expect(autoLayout(once).nodes).toEqual(once.nodes)
    }
  })
  it('terminates on cycles and keeps components apart', () => {
    const d = docOf([node('a'), node('b'), node('c')], [edge('1', 'a', 'b'), edge('2', 'b', 'c'), edge('3', 'c', 'a')])
    const l = autoLayout(d)
    expect(overlapFree(l)).toBe(true)
    expect(new Set(l.nodes.map((n) => n.x)).size).toBe(3)
  })
  it('ignores self-loops and edges to missing components', () => {
    const d = docOf([node('a'), node('b')], [edge('1', 'a', 'a'), edge('2', 'a', 'ghost'), edge('3', 'ghost', 'b')])
    const l = autoLayout(d)
    expect(l.nodes).toHaveLength(2)
    expect(overlapFree(l)).toBe(true)
    for (const n of l.nodes) { expect(Number.isFinite(n.x)).toBe(true); expect(Number.isFinite(n.y)).toBe(true) }
  })
  it('spreads disconnected components by tier without stacking them', () => {
    const d = docOf([node('u', 'users'), node('w1', 'ec2'), node('w2', 'ec2'), node('w3', 'ec2'), node('db', 'rds'), node('mon', 'cloudwatch')])
    const l = autoLayout(d)
    expect(overlapFree(l)).toBe(true)
    expect(pos(l, 'u').x).toBeLessThan(pos(l, 'db').x)
    expect(pos(l, 'db').x).toBeLessThanOrEqual(pos(l, 'mon').x)
    expect(Math.min(...l.nodes.map((n) => n.x))).toBe(0)
  })
  it('fans siblings out in one column and centres their parent', () => {
    const d = docOf([node('lb', 'alb'), node('a'), node('b'), node('c')], [edge('1', 'lb', 'a'), edge('2', 'lb', 'b'), edge('3', 'lb', 'c')])
    const l = autoLayout(d)
    const ys = ['a', 'b', 'c'].map((id) => pos(l, id).y).sort((p, q) => p - q)
    expect(ys[1] - ys[0]).toBe(5)
    expect(ys[2] - ys[1]).toBe(5)
    expect(pos(l, 'lb').y).toBe(ys[1])
  })
  it('re-wraps areas around their members and keeps outsiders out', () => {
    const d = docOf(
      [node('u', 'users', -10, 0), node('lb', 'alb', 0, 0), node('w', 'ec2', 4, 0), node('db', 'rds', 8, 0)],
      [edge('1', 'u', 'lb'), edge('2', 'lb', 'w'), edge('3', 'w', 'db')],
      { areas: [area('vpc', -1, -1, 12, 4, { kind: 'vpc' }), area('empty', 100, 100, 3, 3)] },
    )
    const l = autoLayout(d)
    const vpc = l.areas.find((a) => a.id === 'vpc')!
    for (const id of ['lb', 'w', 'db']) expect(inArea(vpc, pos(l, id))).toBe(true)
    expect(inArea(vpc, pos(l, 'u'))).toBe(false)
    // an area with no members is left exactly where it was
    expect(l.areas.find((a) => a.id === 'empty')).toEqual(d.areas[1])
  })
  it('nests child areas inside their parent', () => {
    const d = docOf(
      [node('a', 'alb', 0, 0), node('b', 'ec2', 4, 0), node('c', 'ec2', 4, 4), node('d', 'rds', 8, 0)],
      [edge('1', 'a', 'b'), edge('2', 'a', 'c'), edge('3', 'b', 'd')],
      { areas: [area('outer', -1, -1, 12, 8, { kind: 'vpc' }), area('inner', 3.5, -0.5, 3, 7.5, { kind: 'subnet' })] },
    )
    const l = autoLayout(d)
    const outer = l.areas[0], inner = l.areas[1]
    expect(inner.x).toBeGreaterThan(outer.x)
    expect(inner.y).toBeGreaterThan(outer.y)
    expect(inner.x + inner.w).toBeLessThan(outer.x + outer.w)
    expect(inner.y + inner.d).toBeLessThan(outer.y + outer.d)
    expect(l.nodes.filter((n) => inArea(inner, n)).map((n) => n.id).sort()).toEqual(['b', 'c'])
    expect(l.nodes.every((n) => inArea(outer, n))).toBe(true)
    expect(overlapFree(l)).toBe(true)
  })
  it('honours an explicit membership map over geometry', () => {
    // every node starts at the origin, so geometry alone would put all of them in the area
    const d = docOf([node('a', 'alb'), node('b', 'ec2'), node('c', 'rds')], [edge('1', 'a', 'b'), edge('2', 'b', 'c')], { areas: [area('net', 0, 0, 4, 4)] })
    const l = autoLayout(d, new Map([['net', ['b', 'c']]]))
    const net = l.areas[0]
    expect(l.nodes.filter((n) => inArea(net, n)).map((n) => n.id).sort()).toEqual(['b', 'c'])
  })
  it('steps free components aside when their column runs through an area', () => {
    const d = docOf(
      [node('a', 'alb', 0, 0), node('b', 'ec2', 6, 0), node('c', 'rds', 12, 0), node('side', 'lambda', 6, 20)],
      [edge('1', 'a', 'b'), edge('2', 'b', 'c'), edge('3', 'a', 'side'), edge('4', 'side', 'c')],
      { areas: [area('net', -1, -1.5, 16, 5)] },
    )
    const l = autoLayout(d)
    expect(inArea(l.areas[0], pos(l, 'side'))).toBe(false)
    expect(pos(l, 'side').x).toBe(pos(l, 'b').x)
    expect(overlapFree(l)).toBe(true)
  })
  it('handles a large graph quickly', () => {
    const nodes = Array.from({ length: 300 }, (_, i) => node('n' + i, i % 3 ? 'ec2' : 'rds'))
    const edges = Array.from({ length: 299 }, (_, i) => edge('e' + i, 'n' + Math.floor(i / 3), 'n' + (i + 1)))
    const t0 = performance.now()
    const l = autoLayout(docOf(nodes, edges))
    expect(performance.now() - t0).toBeLessThan(3000)
    expect(overlapFree(l)).toBe(true)
  })
})
