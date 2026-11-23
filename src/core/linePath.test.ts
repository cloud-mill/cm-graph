import { describe, expect, it } from 'vitest'
import { FLAT, ISO, U } from './iso'
import { type W, arrowAt, captionAnchor, curveOf, labelAnchor, lineOf, pathOf, route } from './linePath'

const at = (x: number, y: number, scale?: number) => ({ x, y, scale })

describe('route', () => {
  it('is a straight line when the components share a row or a column', () => {
    expect(route(at(0, 0), at(8, 0))).toHaveLength(2)
    expect(route(at(0, 0), at(0, -8))).toHaveLength(2)
  })
  it('pulls both ends back to the footprint edge', () => {
    const r = route(at(0, 0), at(8, 0))
    expect(r[0]).toEqual([1.9, 1])
    expect(r[1][0]).toBeCloseTo(9 - 1.02)
  })
  it('leaves the ends at the centres when the components touch', () => {
    const r = route(at(0, 0), at(1, 0))
    expect(r).toEqual([[1, 1], [2, 1]])
  })
  it('uses a dog-leg through the midpoint for long horizontal runs', () => {
    const r = route(at(0, 0), at(10, 4))
    expect(r).toHaveLength(4)
    expect(r[1]).toEqual([6, 1])
    expect(r[2]).toEqual([6, 5])
  })
  it('uses a single corner for short offsets', () => {
    const h = route(at(0, 0), at(2, 1))
    expect(h).toHaveLength(3)
    expect(h[1]).toEqual([3, 1])
    const v = route(at(0, 0), at(1, 2))
    expect(v).toHaveLength(3)
    expect(v[1]).toEqual([1, 3])
  })
  it('routes vertically first when the vertical distance dominates', () => {
    const r = route(at(0, 0), at(4, 10))
    expect(r).toHaveLength(4)
    expect(r[1]).toEqual([1, 6])
    expect(r[2]).toEqual([5, 6])
    const up = route(at(0, 0), at(-4, -10))
    expect(up[1][0]).toBe(1)
    expect(up[1][1]).toBe(-4)
  })
  it('never produces a diagonal segment', () => {
    for (const [x, y] of [[7, 3], [-7, 3], [3, -9], [-2, -3], [2.5, 6.5], [40, 1]]) {
      const r = route(at(0, 0), at(x, y))
      for (let i = 0; i < r.length - 1; i++) expect(Math.min(Math.abs(r[i + 1][0] - r[i][0]), Math.abs(r[i + 1][1] - r[i][1]))).toBeLessThan(1e-9)
    }
  })
  it('is anchored to a zero-length path for a component routed to itself', () => {
    const r = route(at(3, 3), at(3, 3))
    expect(r).toEqual([[4, 4], [4, 4]])
  })
})

describe('pathOf', () => {
  it('returns nothing for fewer than two points', () => {
    expect(pathOf(ISO, [])).toBe('')
    expect(pathOf(ISO, [[1, 1]])).toBe('')
  })
  it('draws a straight segment in plan view at 40px per cell', () => {
    expect(pathOf(FLAT, [[0, 0], [2, 0]])).toMatch(/^M0 0L\d+(\.\d+)? 0$/)
    const end = Number(pathOf(FLAT, [[0, 0], [2, 0]]).split('L')[1].split(' ')[0])
    expect(end / U).toBeCloseTo(2 * Math.sqrt(1.5), 1)
  })
  it('trims both ends', () => {
    const k = U * Math.sqrt(1.5)
    const d = pathOf(FLAT, [[0, 0], [10, 0]], 1, 2)
    const [m, l] = d.slice(1).split('L').map((s) => Number(s.split(' ')[0]))
    expect(m / k).toBeCloseTo(1, 2)
    expect(l / k).toBeCloseTo(8, 2)
  })
  it('rounds each interior corner with a quadratic curve', () => {
    const pts: W[] = [[0, 0], [4, 0], [4, 4], [8, 4]]
    const d = pathOf(FLAT, pts)
    expect(d.match(/Q/g)).toHaveLength(2)
    expect(d.match(/L/g)).toHaveLength(3)
  })
  it('clamps the corner radius to half the shortest neighbouring segment', () => {
    const k = U * Math.sqrt(1.5)
    const d = pathOf(FLAT, [[0, 0], [0.2, 0], [0.2, 5]], 0, 0, 0.32)
    // the curve starts 0.1 before the corner, not 0.32
    const start = Number(d.split('L')[1].split(' ')[0])
    expect(start / k).toBeCloseTo(0.1, 2)
  })
  it('does not mutate its input', () => {
    const pts: W[] = [[0, 0], [5, 0]]
    pathOf(ISO, pts, 1, 1)
    expect(pts).toEqual([[0, 0], [5, 0]])
  })
})

describe('arrowAt', () => {
  it('builds a triangle behind the tip, symmetric about the direction of travel', () => {
    const [tip, l, r] = arrowAt([4, 0], [0, 0], 0.5)
    expect(tip).toEqual([4, 0])
    expect(l[0]).toBeCloseTo(3.5)
    expect(r[0]).toBeCloseTo(3.5)
    expect(l[1]).toBeCloseTo(0.24)
    expect(r[1]).toBeCloseTo(-0.24)
  })
  it('copes with a zero-length direction', () => {
    const tri = arrowAt([1, 1], [1, 1])
    for (const p of tri) for (const v of p) expect(Number.isFinite(v)).toBe(true)
  })
})

describe('labelAnchor', () => {
  it('sits on the middle of the longest segment and follows its axis', () => {
    expect(labelAnchor([[0, 0], [2, 0], [2, 10], [3, 10]])).toEqual({ at: [2, 5], dir: 'y' })
    expect(labelAnchor([[0, 0], [8, 0], [8, 2]])).toEqual({ at: [4, 0], dir: 'x' })
  })
  it('prefers the first segment on a tie', () => {
    expect(labelAnchor([[0, 0], [4, 0], [4, 4]])).toEqual({ at: [2, 0], dir: 'x' })
  })
})

describe('curves and the line of a routed connection', () => {
  const curve: W[] = [[0, 0], [2, 0], [6, 4], [8, 4]]
  it('a curve is one sweep through its two control points', () => {
    const d = curveOf(FLAT, curve)
    expect(d).toMatch(/^M[^LQ]+C[^LQ]+$/)
    expect(d.startsWith('M0 0C')).toBe(true)
  })
  it('is shortened along its own direction at either end, to leave room for an arrowhead', () => {
    expect(curveOf(FLAT, curve, 0.5, 0)).toBe(curveOf(FLAT, [[0.5, 0], ...curve.slice(1)]))
    expect(curveOf(FLAT, curve, 0, 0.5)).toBe(curveOf(FLAT, [...curve.slice(0, 3), [7.5, 4]]))
  })
  it('given anything but four points it is drawn as a plain line', () => {
    expect(curveOf(FLAT, [[0, 0], [4, 0]])).toBe(pathOf(FLAT, [[0, 0], [4, 0]]))
  })
  it('a routed connection is drawn in its own shape', () => {
    expect(lineOf(FLAT, { pts: curve, shape: 'curved' })).toBe(curveOf(FLAT, curve))
    expect(lineOf(FLAT, { pts: curve, shape: 'ortho' }, 0.1, 0.1)).toBe(pathOf(FLAT, curve, 0.1, 0.1))
    // a direct line at an angle is one stroke from end to end
    expect(lineOf(FLAT, { pts: [[0, 0], [6, 3]], shape: 'direct' })).toMatch(/^M0 0L[\d.]+ [\d.]+$/)
  })
  it('a caption sits halfway round a curve, reading along whichever way it mostly goes', () => {
    expect(captionAnchor({ pts: curve, shape: 'curved' })).toEqual({ at: [4, 2], dir: 'x' })
    expect(captionAnchor({ pts: [[0, 0], [0, 2], [1, 6], [1, 8]], shape: 'curved' }).dir).toBe('y')
    expect(captionAnchor({ pts: [[0, 0], [8, 0], [8, 2]], shape: 'ortho' })).toEqual(labelAnchor([[0, 0], [8, 0], [8, 2]]))
  })
})
