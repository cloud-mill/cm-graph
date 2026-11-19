import { describe, expect, it } from 'vitest'
import { node } from '../test/helpers'
import { alignGuides } from './guides'

const moving = (...ids: string[]) => new Set(ids)

describe('alignGuides', () => {
  it('draws nothing when the moving component lines up with nothing', () => {
    expect(alignGuides([node('a', 'ec2', 0, 0), node('b', 'ec2', 5, 7)], moving('a'))).toEqual([])
    expect(alignGuides([node('a', 'ec2', 0, 0)], moving('a'))).toEqual([])
    expect(alignGuides([], moving('a'))).toEqual([])
  })
  it('draws nothing when nothing is moving', () => {
    expect(alignGuides([node('a', 'ec2', 0, 0), node('b', 'ec2', 0, 6)], moving())).toEqual([])
  })
  it('marks a shared column with a line along y through both centres', () => {
    const g = alignGuides([node('a', 'ec2', 3, 0), node('b', 'ec2', 3, 8)], moving('a'))
    expect(g).toEqual([{ axis: 'x', at: 4, from: 1, to: 9 }])
  })
  it('marks a shared row with a line along x', () => {
    const g = alignGuides([node('a', 'ec2', 10, 2), node('b', 'ec2', -4, 2)], moving('a'))
    expect(g).toEqual([{ axis: 'y', at: 3, from: -3, to: 11 }])
  })
  it('gives both lines when a component sits on a row and a column at once', () => {
    const g = alignGuides([node('a', 'ec2', 0, 0), node('b', 'ec2', 0, 6), node('c', 'ec2', 6, 0)], moving('a'))
    expect(g).toHaveLength(2)
    expect(g).toContainEqual({ axis: 'x', at: 1, from: 1, to: 7 })
    expect(g).toContainEqual({ axis: 'y', at: 1, from: 1, to: 7 })
  })
  it('stretches one line over everything on it rather than drawing several', () => {
    const g = alignGuides([node('a', 'ec2', 0, 4), node('b', 'ec2', 0, -6), node('c', 'ec2', 0, 12), node('d', 'ec2', 0, 20)], moving('a'))
    expect(g).toEqual([{ axis: 'x', at: 1, from: -5, to: 21 }])
  })
  it('lines up centres, so a resized component aligns by its middle and not its corner', () => {
    // a 4×4 component at (0,0) has its centre at (2,2), level with a 2×2 one at (8,1)
    const nodes = [node('a', 'ec2', 0, 0, { scale: 2 }), node('b', 'ec2', 8, 1), node('c', 'ec2', 8, 0)]
    expect(alignGuides(nodes, moving('a'))).toEqual([{ axis: 'y', at: 2, from: 2, to: 9 }])
  })
  it('never aligns the things being moved with each other', () => {
    const nodes = [node('a', 'ec2', 0, 0), node('b', 'ec2', 0, 6), node('c', 'ec2', 20, 20)]
    expect(alignGuides(nodes, moving('a', 'b'))).toEqual([])
  })
  it('covers every moving component that lines up with a resting one', () => {
    const nodes = [node('a', 'ec2', 0, 0), node('b', 'ec2', 6, 6), node('r', 'ec2', 0, 12), node('s', 'ec2', 12, 6)]
    const g = alignGuides(nodes, moving('a', 'b'))
    expect(g).toContainEqual({ axis: 'x', at: 1, from: 1, to: 13 })
    expect(g).toContainEqual({ axis: 'y', at: 7, from: 7, to: 13 })
    expect(g).toHaveLength(2)
  })
  it('allows a little slack, and no more', () => {
    const nodes = [node('a', 'ec2', 0, 0), node('b', 'ec2', 0.005, 6)]
    expect(alignGuides(nodes, moving('a'))).toHaveLength(1)
    expect(alignGuides([node('a', 'ec2', 0, 0), node('b', 'ec2', 0.5, 6)], moving('a'))).toEqual([])
    expect(alignGuides([node('a', 'ec2', 0, 0), node('b', 'ec2', 0.5, 6)], moving('a'), 0.6)).toHaveLength(1)
  })
})
