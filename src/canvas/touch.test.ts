import { describe, expect, it } from 'vitest'
import { ISO_PITCH, ISO_YAW, MAX_PITCH, MIN_PITCH, makeCam, pt } from '../core/iso'
import { type Camera, type Finger, type Trail, MAX_K, MIN_K, TILT_SPEED, TWIST_START, fling, gestureMove, gestureRebase, gestureStart, groundUnder, isTwoFingerTap, track, turnBetween } from './touch'

const HOME: Camera = { view: { x: 300, y: 200, k: 1 }, yaw: ISO_YAW, pitch: ISO_PITCH }
const CENTRE: [number, number] = [200, 300]
/** two fingers a given distance apart about a midpoint, at an angle (clockwise on screen) */
const pair = (mx: number, my: number, dist: number, deg = 0): [Finger, Finger] => {
  const r = (deg * Math.PI) / 180, dx = (Math.cos(r) * dist) / 2, dy = (Math.sin(r) * dist) / 2
  return [{ x: mx - dx, y: my - dy }, { x: mx + dx, y: my + dy }]
}
const ground = (c: Camera, x: number, y: number) => groundUnder(makeCam(c.yaw, c.pitch), c.view, x, y)
const drawn = (c: Camera, g: [number, number]) => { const q = pt(makeCam(c.yaw, c.pitch), g[0], g[1]); return { x: q[0] * c.view.k + c.view.x, y: q[1] * c.view.k + c.view.y } }
/** walk a gesture through a list of finger pairs, the way a screen reports them */
const run = (g: ReturnType<typeof gestureStart>, steps: [Finger, Finger][], from = HOME) => steps.reduce((c, [a, b]) => gestureMove(g, a, b, c, CENTRE), from)
const sweep = (n: number, at: (t: number) => [Finger, Finger]) => Array.from({ length: n }, (_, i) => at((i + 1) / n))

describe('angles', () => {
  it('measures the short way round', () => {
    expect(turnBetween(10, 30)).toBe(20)
    expect(turnBetween(170, -170)).toBe(20)
    expect(turnBetween(-170, 170)).toBe(-20)
    expect(turnBetween(0, 180)).toBe(-180)
  })
})

describe('panning and zooming', () => {
  it('moving both fingers together slides the ground with them', () => {
    const g = gestureStart(...pair(200, 300, 200), false)
    const c = run(g, sweep(6, (t) => pair(200 + 60 * t, 300 + 30 * t, 200)))
    expect(c.view).toEqual({ k: 1, x: 360, y: 230 })
    expect(c.yaw).toBe(ISO_YAW); expect(c.pitch).toBe(ISO_PITCH)
  })
  it('spreading zooms, and the ground between the fingers stays between them', () => {
    const g = gestureStart(...pair(200, 300, 100))
    const under = ground(HOME, 200, 300)
    const c = run(g, sweep(8, (t) => pair(200, 300, 100 + 150 * t)))
    expect(c.view.k).toBeCloseTo(2.5)
    const on = drawn(c, under)
    expect(on.x).toBeCloseTo(200); expect(on.y).toBeCloseTo(300)
    expect(g.kind).toBe('free')
  })
  it('zooms and pans at once without losing the point under the fingers', () => {
    const g = gestureStart(...pair(200, 300, 100), false)
    const under = ground(HOME, 200, 300)
    const c = run(g, sweep(8, (t) => pair(200 + 80 * t, 300 - 40 * t, 100 + 100 * t)))
    const on = drawn(c, under)
    expect(on.x).toBeCloseTo(280); expect(on.y).toBeCloseTo(260)
  })
  it('stops at the zoom limits and carries on the moment the fingers reverse', () => {
    const g = gestureStart(...pair(200, 300, 20))
    let c = run(g, [pair(200, 300, 2000)])
    expect(c.view.k).toBe(MAX_K)
    c = run(g, [pair(200, 300, 1000)], c)
    expect(c.view.k).toBe(MAX_K / 2) // no dead travel to wind back first
    c = run(g, [pair(200, 300, 1)], c)
    expect(c.view.k).toBe(MIN_K)
  })
  it('fingers that land on the same spot do not divide by zero', () => {
    const g = gestureStart({ x: 5, y: 5 }, { x: 5, y: 5 })
    const c = run(g, [[{ x: 5, y: 5 }, { x: 6, y: 5 }]])
    expect(Number.isFinite(c.view.k) && Number.isFinite(c.view.x) && Number.isFinite(c.yaw)).toBe(true)
  })
  it('only one finger reporting at a time ends in the same place as both at once', () => {
    const together = run(gestureStart(...pair(200, 300, 100), false), [pair(230, 280, 180)])
    const [a0, b0] = pair(200, 300, 100), [a1, b1] = pair(230, 280, 180)
    const apart = run(gestureStart(a0, b0, false), [[a1, b0], [a1, b1]])
    expect(apart.view.k).toBeCloseTo(together.view.k)
    expect(apart.view.x).toBeCloseTo(together.view.x)
    expect(apart.view.y).toBeCloseTo(together.view.y)
  })
})

describe('turning', () => {
  it('a pinch with a little wobble never turns the camera', () => {
    const g = gestureStart(...pair(200, 300, 100))
    const c = run(g, sweep(10, (t) => pair(200, 300, 100 + 120 * t, 6 * Math.sin(t * 9))))
    expect(c.yaw).toBe(ISO_YAW)
    expect(g.turning).toBe(false)
  })
  it('a deliberate twist turns the scene the same way as the fingers', () => {
    for (const dir of [1, -1]) {
      const g = gestureStart(...pair(200, 300, 200))
      const c = run(g, sweep(20, (t) => pair(200, 300, 200, dir * 60 * t)))
      expect(g.turning).toBe(true)
      // a ground axis drawn on screen has swung the way the fingers did
      const angle = (cam: Camera) => { const o = drawn(cam, [0, 0]), x = drawn(cam, [1, 1]); return (Math.atan2(x.y - o.y, x.x - o.x) * 180) / Math.PI }
      expect(Math.sign(turnBetween(angle(HOME), angle(c)))).toBe(dir)
      expect(Math.sign(c.yaw - ISO_YAW)).toBe(dir)
    }
  })
  it('follows the fingers degree for degree once it has started, with no jump when it starts', () => {
    const g = gestureStart(...pair(200, 300, 200))
    let c = HOME, last = ISO_YAW, biggest = 0
    for (const [a, b] of sweep(50, (t) => pair(200, 300, 200, 50 * t))) { c = gestureMove(g, a, b, c, CENTRE); biggest = Math.max(biggest, c.yaw - last); last = c.yaw }
    expect(biggest).toBeCloseTo(1) // each 1° of the fingers is at most 1° of the scene
    // everything after the unlock was passed on: 50° less what it took to unlock
    expect(c.yaw - ISO_YAW).toBeGreaterThanOrEqual(50 - TWIST_START - 2)
    expect(c.yaw - ISO_YAW).toBeLessThan(50 - TWIST_START + 0.01)
  })
  it('turns about the point under the fingers', () => {
    const g = gestureStart(...pair(140, 260, 200))
    const under = ground(HOME, 140, 260)
    const c = run(g, sweep(20, (t) => pair(140, 260, 200, 70 * t)))
    const on = drawn(c, under)
    expect(on.x).toBeCloseTo(140); expect(on.y).toBeCloseTo(260)
  })
  it('holds the zoom still while turning, until the fingers clearly spread', () => {
    const g = gestureStart(...pair(200, 300, 200))
    let c = run(g, sweep(20, (t) => pair(200, 300, 200 + 12 * Math.sin(t * 20), 40 * t)))
    expect(g.turning).toBe(true)
    expect(c.view.k).toBeCloseTo(1, 1)
    const k = c.view.k
    c = run(g, sweep(10, (t) => pair(200, 300, 200 + 200 * t, 40)), c)
    expect(g.zooming).toBe(true)
    expect(c.view.k).toBeGreaterThan(k * 1.5)
  })
  it('needs a firmer twist once a pinch is clearly zooming', () => {
    const zoomThenTwist = (deg: number) => {
      const g = gestureStart(...pair(200, 300, 100))
      run(g, [...sweep(6, (t) => pair(200, 300, 100 + 100 * t)), ...sweep(12, (t) => pair(200, 300, 200, deg * t))])
      return g.turning
    }
    expect(zoomThenTwist(TWIST_START + 3)).toBe(false)
    expect(zoomThenTwist(TWIST_START * 2.2 + 4)).toBe(true)
  })
  it('asks more of fingers that are close together, where the angle is shaky', () => {
    const twist = (dist: number, deg: number) => { const g = gestureStart(...pair(200, 300, dist)); run(g, sweep(10, (t) => pair(200, 300, dist, deg * t))); return g.turning }
    expect(twist(200, 12)).toBe(true)
    expect(twist(40, 12)).toBe(false)
    expect(twist(40, 80)).toBe(true)
  })
  it('works looking straight down too', () => {
    const plan = { ...HOME, yaw: 0, pitch: 90 }
    const g = gestureStart(...pair(200, 300, 200))
    const c = run(g, sweep(30, (t) => pair(200, 300, 200, 90 * t)), plan)
    expect(c.yaw).toBeGreaterThan(75)
    expect(c.pitch).toBe(90)
  })
})

describe('tilting', () => {
  const slide = (dy: number, o: { dist?: number; deg?: number; n?: number } = {}) => sweep(o.n ?? 20, (t) => pair(200, 300 + dy * t, o.dist ?? 140, o.deg ?? 0))
  it('two fingers side by side sliding up lower the camera towards the horizon', () => {
    const g = gestureStart(...pair(200, 300, 140))
    const c = run(g, slide(-60))
    expect(g.kind).toBe('tilt')
    expect(c.pitch).toBeLessThan(ISO_PITCH - 10)
    expect(c.yaw).toBe(ISO_YAW); expect(c.view.k).toBe(1)
  })
  it('sliding down raises it, and stops looking straight down', () => {
    const g = gestureStart(...pair(200, 300, 140))
    const c = run(g, slide(400))
    expect(c.pitch).toBe(MAX_PITCH)
    const back = run(g, [pair(200, 690, 140)], c)
    expect(back.pitch).toBeCloseTo(MAX_PITCH - 10 * TILT_SPEED) // reverses at once
  })
  it('stops at the lowest angle', () => {
    const c = run(gestureStart(...pair(200, 300, 140)), slide(-400))
    expect(c.pitch).toBe(MIN_PITCH)
  })
  it('hinges on the middle of the canvas, so the diagram stays in frame', () => {
    const g = gestureStart(...pair(200, 500, 140))
    let c = run(g, sweep(4, (t) => pair(200, 500 - 12 * t, 140)))
    expect(g.kind).toBe('tilt')
    const hinge = ground(c, CENTRE[0], CENTRE[1])
    c = run(g, sweep(10, (t) => pair(200, 488 - 100 * t, 140)), c)
    const on = drawn(c, hinge)
    expect(on.x).toBeCloseTo(CENTRE[0]); expect(on.y).toBeCloseTo(CENTRE[1])
  })
  it('once tilting it only tilts, whatever the fingers do next', () => {
    const g = gestureStart(...pair(200, 300, 140))
    let c = run(g, slide(-30))
    c = run(g, sweep(10, (t) => pair(200 + 50 * t, 270, 140 + 100 * t, 40 * t)), c)
    expect(g.kind).toBe('tilt')
    expect(c.yaw).toBe(ISO_YAW); expect(c.view.k).toBe(1)
  })
  it.each([
    ['sideways', sweep(10, (t) => pair(200 + 60 * t, 300, 140))],
    ['diagonally', sweep(10, (t) => pair(200 + 50 * t, 300 + 50 * t, 140))],
    ['while spreading', sweep(10, (t) => pair(200, 300 - 40 * t, 140 + 60 * t))],
    ['in opposite directions', sweep(10, (t): [Finger, Finger] => [{ x: 130, y: 300 - 30 * t }, { x: 270, y: 300 + 30 * t }])],
  ])('fingers moving %s pan instead', (_, steps) => {
    const g = gestureStart(...pair(200, 300, 140))
    const c = run(g, steps)
    expect(g.kind).toBe('free')
    expect(c.pitch).toBe(ISO_PITCH)
  })
  it('fingers one above the other pan instead', () => {
    const g = gestureStart(...pair(200, 300, 140, 80))
    const c = run(g, sweep(10, (t) => pair(200, 300 - 60 * t, 140, 80)))
    expect(g.kind).toBe('free')
    expect(c.pitch).toBe(ISO_PITCH)
    expect(c.view.y).toBeCloseTo(140)
  })
  it('waits for a finger whose report is late before deciding', () => {
    const [a, b] = pair(200, 300, 140)
    const g = gestureStart(a, b)
    let c = gestureMove(g, { x: a.x, y: a.y - 12 }, b, HOME, CENTRE)
    expect(g.kind).toBe('open')
    c = gestureMove(g, { x: a.x, y: a.y - 12 }, { x: b.x, y: b.y - 12 }, c, CENTRE)
    expect(g.kind).toBe('tilt')
  })
  it('is never a tilt when a finger was already busy', () => {
    const g = gestureStart(...pair(200, 300, 140), false)
    const c = run(g, slide(-60))
    expect(g.kind).toBe('free')
    expect(c.pitch).toBe(ISO_PITCH)
  })
})

describe('fingers coming and going', () => {
  it('a new pair carries on from where the camera is, with no jump', () => {
    const g = gestureStart(...pair(200, 300, 100))
    let c = run(g, sweep(5, (t) => pair(200, 300, 100 + 100 * t)))
    const before = c
    gestureRebase(g, ...pair(90, 120, 300, 70))
    c = run(g, [pair(90, 120, 300, 70)], c)
    expect(c.view.k).toBeCloseTo(before.view.k)
    expect(c.view.x).toBeCloseTo(before.view.x)
    expect(c.yaw).toBe(before.yaw)
    expect(g.kind).toBe('free')
  })
  it('a pair that was still deciding becomes a plain pan and zoom', () => {
    const g = gestureStart(...pair(200, 300, 140))
    gestureRebase(g, ...pair(200, 300, 140))
    run(g, sweep(10, (t) => pair(200, 300 - 60 * t, 140)))
    expect(g.kind).toBe('free')
  })
})

describe('a two-finger tap', () => {
  it('is two fingers that touched briefly and went nowhere', () => {
    const g = gestureStart(...pair(200, 300, 100))
    run(g, [pair(202, 301, 101)])
    expect(isTwoFingerTap(g, 120)).toBe(true)
    expect(isTwoFingerTap(g, 500)).toBe(false)
  })
  it('is not one that moved', () => {
    const g = gestureStart(...pair(200, 300, 100))
    run(g, [pair(230, 300, 100)])
    expect(isTwoFingerTap(g, 120)).toBe(false)
  })
})

describe('flicks', () => {
  const trail = (pts: [number, number, number][]) => { const t: Trail[] = []; pts.forEach(([at, x, y]) => track(t, at, x, y)); return t }
  it('a moving finger leaves with its speed', () => {
    const v = fling(trail([[0, 0, 0], [16, 16, 8], [32, 32, 16], [48, 48, 24]]), 50)!
    expect(v[0]).toBeCloseTo(1); expect(v[1]).toBeCloseTo(0.5)
  })
  it('a finger that came to rest before lifting leaves nothing', () => {
    expect(fling(trail([[0, 0, 0], [16, 30, 0], [32, 60, 0]]), 200)).toBeNull()
  })
  it('a slow drag is not a flick', () => {
    expect(fling(trail([[0, 0, 0], [50, 5, 0], [100, 10, 0]]), 105)).toBeNull()
  })
  it('too little to go on is not a flick', () => {
    expect(fling([], 0)).toBeNull()
    expect(fling(trail([[0, 0, 0]]), 5)).toBeNull()
    expect(fling(trail([[0, 0, 0], [4, 40, 0]]), 5)).toBeNull()
  })
  it('only the last moments count, and the speed is capped', () => {
    const t = trail([[0, 0, 0], [300, 0, 0], [316, 400, 0], [332, 800, 0]])
    expect(t[0].t).toBeGreaterThan(0) // the stale start was dropped
    const v = fling(t, 335)!
    expect(Math.hypot(v[0], v[1])).toBeCloseTo(3.5)
  })
})
