import { describe, expect, it } from 'vitest'
import { FLAT, ISO, U } from './iso'
import { HEAD, HEAD_TRIM, type Piece, type W, arrowAt, captionAnchor, curveOf, drawingOf, labelAnchor, lineOf, pathData, pathOf, piecesOf, pointFrom, route, shortened } from './linePath'

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
  it('shortened at an end, it is still the same curve: only less of it is drawn', () => {
    // the old way moved the end point back, which redrew the whole sweep; a line and its highlight then parted company
    const whole = sample([curve]), cut = shortened([curve], 0.5, 0.5)
    expect(cut).toHaveLength(1)
    for (const q of sample(cut)) expect(nearest(whole, q)).toBeLessThan(0.03) // the samples are 0.045 apart; moving the end point strayed by ten times that
    // half a cell has gone from each end, measured along the curve
    expect(Math.hypot(cut[0][0][0], cut[0][0][1])).toBeCloseTo(0.5, 1)
    expect(Math.hypot(cut[0][3][0] - 8, cut[0][3][1] - 4)).toBeCloseTo(0.5, 1)
    expect(curveOf(FLAT, curve, 0.5, 0.5)).toBe(pathData(FLAT, cut))
    expect(curveOf(FLAT, curve, 0, 0)).toBe(curveOf(FLAT, curve))
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
  it('a caption sits on a curve halfway along it, reading along whichever way the curve is going there', () => {
    const c = captionAnchor({ pts: curve, shape: 'curved' })
    expect(c).toMatchObject({ dir: 'x', on: true })
    expect(c.at[0]).toBeCloseTo(4, 2); expect(c.at[1]).toBeCloseTo(2, 2)
    expect(captionAnchor({ pts: [[0, 0], [0, 2], [1, 6], [1, 8]], shape: 'curved' }).dir).toBe('y')
    expect(captionAnchor({ pts: [[0, 0], [8, 0], [8, 2]], shape: 'ortho' })).toEqual(labelAnchor([[0, 0], [8, 0], [8, 2]]))
  })
})

/** points along a row of pieces, close together, for comparing one path with another */
function sample(pieces: Piece[]): W[] {
  const out: W[] = []
  for (const q of pieces) for (let i = 0; i <= 200; i++) {
    const t = i / 200
    let row = q
    while (row.length > 1) row = row.slice(1).map((b, k) => [row[k][0] + (b[0] - row[k][0]) * t, row[k][1] + (b[1] - row[k][1]) * t] as W)
    out.push(row[0])
  }
  return out
}
const nearest = (path: W[], q: W) => Math.min(...path.map((p) => Math.hypot(p[0] - q[0], p[1] - q[1])))

describe('one geometry for every layer of a line', () => {
  const bends: W[] = [[0, 0], [4, 0], [4, 0.5], [8, 0.5], [8, 6]]
  it('a right-angled line is straight stretches joined by rounded corners, and two corners on a short run meet in its middle', () => {
    const pieces = piecesOf(bends)
    expect(pieces.map((q) => q.length)).toEqual([2, 3, 2, 3, 2, 3, 2])
    // the run between the first two corners is half a cell: each corner takes a quarter, and nothing straight is left of it
    expect(pieces[1][2]).toEqual([4, 0.25])
    expect(pieces[3][0]).toEqual([4, 0.25])
    expect(pathData(FLAT, pieces)).toBe(pathOf(FLAT, bends))
    expect(piecesOf([[1, 1]])).toEqual([])
    expect(pathData(FLAT, [])).toBe('')
  })
  it('a shortened right-angled line keeps the corners of the whole one, even when the cut falls inside a corner', () => {
    const tight: W[] = [[0, 0], [4, 0], [4, 0.3]]
    const whole = sample(piecesOf(tight))
    for (const trim of [0.1, 0.26, 0.4]) for (const q of sample(shortened(piecesOf(tight), 0, trim))) expect(nearest(whole, q)).toBeLessThan(0.01)
    // a cut longer than the last stretch goes on into the corner before it
    expect(shortened(piecesOf(tight), 0, 0.26).at(-1)).toHaveLength(3)
    expect(shortened(piecesOf(tight), 0.26, 0)[0][0]).toEqual([0.26, 0])
  })
  it('never cuts a line away to nothing, and leaves it alone when nothing is asked', () => {
    const short = piecesOf([[0, 0], [0.4, 0]])
    const left = shortened(short, 5, 5)
    expect(left).toHaveLength(1)
    expect(left[0][1][0] - left[0][0][0]).toBeCloseTo(0.04, 5)
    expect(shortened(short)).toBe(short)
    expect(shortened([])).toEqual([])
  })
  it('finds the point a given distance along a line from either end', () => {
    const pieces = piecesOf([[0, 0], [10, 0]])
    expect(pointFrom(pieces, 3, false)).toEqual([3, 0])
    expect(pointFrom(pieces, 3, true)).toEqual([7, 0])
    expect(pointFrom(pieces, 99, true)).toEqual([0, 0])
    const round = piecesOf([[0, 0], [4, 0], [4, 4]])
    const mid = pointFrom(round, 4, false)
    expect(nearest(sample(round), mid)).toBeLessThan(0.01)
    expect(pointFrom([], 1, false)).toEqual([0, 0])
  })
  it('the drawing of a connection: the line stops inside its arrowhead and lies on the whole path, and the head lies along the curve', () => {
    const r = { pts: [[2, 1], [5, 1], [3, 9], [6, 9]] as W[], shape: 'curved' as const }
    const g = drawingOf(FLAT, r, 'both')
    expect(g.full).toBe(lineOf(FLAT, r))
    expect(g.line).toBe(lineOf(FLAT, r, HEAD_TRIM, HEAD_TRIM))
    expect(g.line).not.toBe(g.full)
    expect(g.heads).toHaveLength(2)
    // each head has its tip on the end of the line and its base centred on the curve, one head's length back
    const whole = sample([r.pts])
    for (const [tip, left, right] of g.heads) {
      expect(nearest([r.pts[0], r.pts[3]], tip)).toBe(0)
      expect(nearest(whole, [(left[0] + right[0]) / 2, (left[1] + right[1]) / 2])).toBeLessThan(0.01)
      expect(Math.hypot((left[0] + right[0]) / 2 - tip[0], (left[1] + right[1]) / 2 - tip[1])).toBeCloseTo(HEAD, 5)
    }
    expect(drawingOf(FLAT, r, 'end').heads).toHaveLength(1)
    expect(drawingOf(FLAT, r, 'none')).toMatchObject({ heads: [], line: g.full })
    expect(drawingOf(FLAT, { pts: [[0, 0]], shape: 'ortho' }, 'end')).toEqual({ full: '', line: '', heads: [] })
  })
  it('asked again for the same route, camera and arrows it hands back the very same drawing', () => {
    const r = { pts: [[0, 0], [4, 0], [4, 4]] as W[], shape: 'ortho' as const }
    const g = drawingOf(FLAT, r, 'end')
    expect(drawingOf(FLAT, r, 'end')).toBe(g)
    expect(drawingOf(FLAT, r, 'both')).not.toBe(g)
    expect(drawingOf(ISO, r, 'both').full).not.toBe(g.full)
  })
})
