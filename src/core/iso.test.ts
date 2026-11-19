import { describe, expect, it } from 'vitest'
import {
  FLAT, ISO, ISO_PITCH, ISO_YAW, MAX_PITCH, MIN_PITCH, U, alpha, easeInOut, f, makeCam, makeProj, mix, normYaw, planeMatrix, planeMatrixUV, poly, pt, shade, unproject, upright, uprightAlong,
} from './iso'

const nums = (m: string) => m.match(/-?\d+(\.\d+)?/g)!.map(Number)

describe('camera', () => {
  it('normalises yaw into [0, 360)', () => {
    expect(normYaw(0)).toBe(0)
    expect(normYaw(360)).toBe(0)
    expect(normYaw(-90)).toBe(270)
    expect(normYaw(725)).toBe(5)
  })
  it('clamps pitch to the supported range without changing the stored angle', () => {
    const low = makeCam(0, 1), min = makeCam(0, MIN_PITCH)
    expect(low.e).toBeCloseTo(min.e, 10)
    expect(low.d).toBeCloseTo(min.d, 10)
    expect(low.pitch).toBe(1)
    const high = makeCam(0, 400), max = makeCam(0, MAX_PITCH)
    expect(high.d).toBeCloseTo(max.d, 10)
    expect(high.e).toBeCloseTo(0, 10)
  })
  it('flags the plan view only when looking straight down', () => {
    expect(makeCam(0, 90).t).toBe(1)
    expect(makeCam(0, 89.5).t).toBe(1)
    expect(makeCam(0, 89.4).t).toBe(0)
    expect(ISO.t).toBe(0)
    expect(FLAT.t).toBe(1)
  })
  it('reports the quadrant the camera sits in', () => {
    expect([0, 45, 89.9, 90, 135, 180, 269, 270, 359, 360, -1].map((y) => makeCam(y, 35).q)).toEqual([0, 0, 0, 1, 1, 2, 2, 3, 3, 0, 3])
  })
  it('blends from the home view to the plan view', () => {
    expect(makeProj(0)).toMatchObject({ yaw: ISO_YAW, pitch: ISO_PITCH })
    expect(makeProj(1)).toMatchObject({ yaw: 0, pitch: 90 })
    expect(makeProj(0.5).yaw).toBeCloseTo(22.5)
  })
  it('lifts points by height in 3D and ignores height in plan', () => {
    const ground = pt(ISO, 2, 3), raised = pt(ISO, 2, 3, 1)
    expect(raised[0]).toBeCloseTo(ground[0])
    expect(raised[1]).toBeLessThan(ground[1])
    expect(ground[1] - raised[1]).toBeCloseTo(ISO.e * U)
    expect(pt(FLAT, 2, 3, 9)[1]).toBeCloseTo(pt(FLAT, 2, 3)[1])
  })
  it('unproject inverts pt at the origin and far away', () => {
    for (const [x, y] of [[0, 0], [1e4, -1e4], [-0.5, 0.25]]) {
      const [bx, by] = unproject(ISO, ...pt(ISO, x, y))
      expect(bx).toBeCloseTo(x, 5)
      expect(by).toBeCloseTo(y, 5)
    }
  })
})

describe('plane matrices', () => {
  it('maps content axes onto the world x and y axes', () => {
    const m = nums(planeMatrix(ISO, 3, 4, 0, 1))
    expect(m).toHaveLength(6)
    // content (1, 0) lands where world (x+1, y) does
    const o = pt(ISO, 3, 4), ex = pt(ISO, 4, 4), ey = pt(ISO, 3, 5)
    expect(m[4]).toBeCloseTo(o[0], 1)
    expect(m[5]).toBeCloseTo(o[1], 1)
    expect(m[0] + m[4]).toBeCloseTo(ex[0], 1)
    expect(m[1] + m[5]).toBeCloseTo(ex[1], 1)
    expect(m[2] + m[4]).toBeCloseTo(ey[0], 1)
    expect(m[3] + m[5]).toBeCloseTo(ey[1], 1)
  })
  it('rotates the content a quarter turn for the y direction and applies scale and height', () => {
    const m = nums(planeMatrix(ISO, 0, 0, 2, 0.5, 'y'))
    // content x runs along world -y, content y along world +x, at half size
    const negY = pt(ISO, 0, -0.5), posX = pt(ISO, 0.5, 0), lift = pt(ISO, 0, 0, 2)
    expect(m[0]).toBeCloseTo(negY[0], 1)
    expect(m[1]).toBeCloseTo(negY[1], 1)
    expect(m[2]).toBeCloseTo(posX[0], 1)
    expect(m[3]).toBeCloseTo(posX[1], 1)
    expect(m[5]).toBeCloseTo(lift[1], 1)
  })
  it('planeMatrixUV with the identity basis matches planeMatrix', () => {
    expect(planeMatrixUV(ISO, 1, 2, 0, 1, [1, 0], [0, 1])).toBe(planeMatrix(ISO, 1, 2, 0, 1, 'x'))
    const flipped = nums(planeMatrixUV(ISO, 1, 2, 0, 1, [-1, 0], [0, -1])), plain = nums(planeMatrix(ISO, 1, 2))
    expect(flipped.slice(0, 4)).toEqual(plain.slice(0, 4).map((v) => (v === 0 ? 0 : -v)))
    expect(flipped.slice(4)).toEqual(plain.slice(4))
  })
})

describe('upright bases', () => {
  it('returns a right-handed grid basis for every quadrant', () => {
    for (const yaw of [0, 90, 180, 270]) {
      const { u, v } = upright(makeCam(yaw + 10, 40))
      expect(Math.abs(u[0]) + Math.abs(u[1])).toBe(1)
      expect(u[0] * v[0] + u[1] * v[1]).toBeCloseTo(0)
      expect(u[0] * v[1] - u[1] * v[0]).toBe(1)
    }
  })
  it('keeps text along an axis reading left to right from every side', () => {
    for (const yaw of [20, 110, 200, 290]) {
      const p = makeCam(yaw, 40)
      for (const axis of ['x', 'y'] as const) {
        const { u, v } = uprightAlong(p, axis)
        // the reading direction never points screen-left, and lines stack downwards
        expect(u[0] * p.a + u[1] * p.b).toBeGreaterThanOrEqual(-1e-9)
        expect(v[0] * p.c + v[1] * p.d).toBeGreaterThan(0)
        expect(axis === 'x' ? u[1] : u[0]).toBe(0)
      }
    }
    expect(uprightAlong(makeCam(45, 35), 'x')).toEqual({ u: [1, 0], v: [0, 1] })
    expect(uprightAlong(makeCam(225, 35), 'x')).toEqual({ u: [-1, 0], v: [0, -1] })
    expect(uprightAlong(makeCam(45, 35), 'y')).toEqual({ u: [0, -1], v: [1, 0] })
    expect(uprightAlong(makeCam(225, 35), 'y')).toEqual({ u: [0, 1], v: [-1, 0] })
  })
})

describe('formatting and colour', () => {
  it('rounds coordinates to two decimals', () => {
    expect(f(1.005)).toBe('1')
    expect(f(1.239)).toBe('1.24')
    expect(f(-0.001)).toBe('0')
    expect(f(12)).toBe('12')
    expect(poly([[0, 0], [1.111, 2.229]])).toBe('0,0 1.11,2.23')
    expect(poly([])).toBe('')
  })
  it('mixes colours, including 3-digit hex', () => {
    expect(mix('#000000', '#ffffff', 0)).toBe('#000000')
    expect(mix('#000000', '#ffffff', 1)).toBe('#ffffff')
    expect(mix('#000000', '#ffffff', 0.5)).toBe('#808080')
    expect(mix('#f00', '#00f', 0.5)).toBe('#800080')
    expect(mix('ff0000', '#ff0000', 0.3)).toBe('#ff0000')
    // out-of-range blends are clamped to valid channels
    expect(mix('#000000', '#ffffff', 2)).toBe('#ffffff')
    expect(mix('#000000', '#ffffff', -1)).toBe('#000000')
  })
  it('lightens towards white and darkens towards near-black', () => {
    expect(shade('#808080', 0)).toBe('#808080')
    expect(shade('#808080', 1)).toBe('#ffffff')
    expect(shade('#808080', -1)).toBe('#05070d')
    expect(parseInt(shade('#808080', 0.2).slice(1, 3), 16)).toBeGreaterThan(0x80)
    expect(parseInt(shade('#808080', -0.2).slice(1, 3), 16)).toBeLessThan(0x80)
  })
  it('builds rgba strings', () => {
    expect(alpha('#ff8000', 0.5)).toBe('rgba(255,128,0,0.5)')
    expect(alpha('#fff', 1)).toBe('rgba(255,255,255,1)')
  })
  it('eases from 0 to 1 symmetrically', () => {
    expect(easeInOut(0)).toBe(0)
    expect(easeInOut(1)).toBe(1)
    expect(easeInOut(0.5)).toBeCloseTo(0.5)
    expect(easeInOut(0.25)).toBeCloseTo(1 - easeInOut(0.75))
    expect(easeInOut(0.25)).toBeLessThan(0.25)
  })
})
