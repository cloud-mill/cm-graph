// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ISO_PITCH, ISO_YAW, MAX_PITCH, MIN_PITCH, makeCam, pt } from '../core/iso'
import { useStore } from '../core/store'
import { docOf, node, resetStore } from '../test/helpers'
import { ORBIT_SPEED, flushFrame, glide, holdStill, inSight, isTurned, onFrame, recover, animateView, beginOrbit, cam, center, chrome, fitView, groundAt, insets, orbitTo, projNow, setFlat, smoothZoom, turn, viewHome, viewTop, zoomBy } from './camera'
import { sceneBounds } from './Scene'

const S = () => useStore.getState()
const run = (ms: number) => vi.advanceTimersByTime(ms)

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance', 'setTimeout', 'clearTimeout', 'Date'] })
  resetStore({ showLib: true, showInsp: true })
  Object.assign(cam, { w: 1200, h: 800, left: 0, top: 0 })
})
afterEach(() => { run(2000); vi.useRealTimers() })

describe('viewport geometry', () => {
  it('reserves room for open panels and none on a narrow screen', () => {
    expect(insets()).toEqual({ l: 268, r: 348, t: 68, b: 88 })
    useStore.setState({ showLib: false })
    expect(insets().l).toBe(20)
    useStore.setState({ showLib: true, showInsp: false })
    expect(insets()).toMatchObject({ l: 268, r: 20 })
  })
  it('on a phone, makes room for the dock and for whatever an open sheet covers', () => {
    cam.w = 390
    // panels are sheets there, so being "open" takes nothing from the sides
    expect(insets()).toEqual({ l: 14, r: 14, t: 64, b: 112 })
    chrome.bottom = 420
    expect(insets().b).toBe(436)
    chrome.bottom = 0
    // held sideways: a slimmer dock, and the sheet docks to the right edge instead
    Object.assign(cam, { w: 844, h: 390 })
    expect(insets()).toEqual({ l: 14, r: 14, t: 64, b: 84 })
    chrome.right = 380
    expect(insets().r).toBe(394)
    chrome.right = 0
  })
  it('centres on the uncovered part of the canvas', () => {
    expect(center()).toEqual([268 + (1200 - 268 - 348) / 2, 68 + (800 - 68 - 88) / 2])
  })
  it('reads the current camera from the store', () => {
    useStore.setState({ yaw: 90, pitch: 50 })
    expect(projNow()).toEqual(makeCam(90, 50))
  })
  it('finds the ground point under a viewport position', () => {
    useStore.setState({ view: { x: 100, y: 50, k: 2 } })
    const q = pt(projNow(), 3, -4)
    const [x, y] = groundAt(100 + q[0] * 2, 50 + q[1] * 2)
    expect(x).toBeCloseTo(3)
    expect(y).toBeCloseTo(-4)
    const [cx, cy] = groundAt()
    const back = pt(projNow(), cx, cy)
    expect(back[0] * 2 + 100).toBeCloseTo(center()[0])
    expect(back[1] * 2 + 50).toBeCloseTo(center()[1])
  })
})

describe('zoom', () => {
  it('keeps the point under the cursor fixed', () => {
    useStore.setState({ view: { x: 40, y: 30, k: 1 } })
    const v = zoomBy(2, 300, 200)
    expect(v.k).toBe(2)
    // scene point under (300, 200) before and after
    expect((300 - v.x) / v.k).toBeCloseTo((300 - 40) / 1)
    expect((200 - v.y) / v.k).toBeCloseTo((200 - 30) / 1)
  })
  it('clamps between 15% and 400% and defaults to the centre', () => {
    expect(zoomBy(100).k).toBe(4)
    expect(zoomBy(0.0001).k).toBe(0.15)
    const v = zoomBy(2)
    expect((center()[0] - v.x) / 2).toBeCloseTo(center()[0])
  })
  it('glides wheel zoom to its target and accumulates notches', () => {
    smoothZoom(1.5, 600, 400)
    smoothZoom(1.5, 600, 400)
    run(16)
    const mid = S().view.k
    expect(mid).toBeGreaterThan(1)
    expect(mid).toBeLessThan(2.25)
    run(1500)
    expect(S().view.k).toBeCloseTo(2.25, 5)
    expect((600 - S().view.x) / S().view.k).toBeCloseTo(600) // the cursor point stayed put
    smoothZoom(1000, 0, 0)
    run(3000)
    expect(S().view.k).toBe(4)
    smoothZoom(1e-9, 0, 0)
    run(3000)
    expect(S().view.k).toBe(0.15)
  })
  it('animates the view to a target and can be redirected mid-flight', () => {
    animateView({ x: 100, y: 0, k: 2 }, 400)
    run(200)
    expect(S().view.x).toBeGreaterThan(0)
    expect(S().view.x).toBeLessThan(100)
    animateView({ x: -50, y: 20, k: 1 }, 100)
    run(400)
    expect(S().view).toEqual({ x: -50, y: 20, k: 1 })
  })
})

describe('fit', () => {
  const doc = docOf([node('a', 'ec2', 0, 0), node('b', 'ec2', 30, 12)])
  const framed = (ids?: string[]) => {
    const v = S().view
    const b = sceneBounds(ids ? { ...doc, nodes: doc.nodes.filter((n) => ids.includes(n.id)) } : doc, projNow(), 0)
    const i = insets()
    // the content box sits inside the uncovered area
    expect(b.x * v.k + v.x).toBeGreaterThanOrEqual(i.l)
    expect((b.x + b.w) * v.k + v.x).toBeLessThanOrEqual(cam.w - i.r)
    expect(b.y * v.k + v.y).toBeGreaterThanOrEqual(i.t)
    expect((b.y + b.h) * v.k + v.y).toBeLessThanOrEqual(cam.h - i.b)
  }
  it('frames the whole blueprint at once when not animated', () => {
    useStore.setState({ doc })
    fitView(undefined, false)
    expect(S().view).not.toEqual({ x: 0, y: 0, k: 1 })
    framed()
  })
  it('animates by default', () => {
    useStore.setState({ doc })
    fitView()
    expect(S().view).toEqual({ x: 0, y: 0, k: 1 })
    run(600)
    framed()
  })
  it('frames just the named components, closer in', () => {
    useStore.setState({ doc })
    fitView(undefined, false)
    const whole = S().view.k
    fitView(['b'], false)
    expect(S().view.k).toBeGreaterThan(whole)
    framed(['b'])
    fitView(['b'], false, 0.5)
    expect(S().view.k).toBe(0.5)
  })
  it('never zooms out past 20% or in past the cap, even with nothing to frame', () => {
    useStore.setState({ doc: docOf([node('a', 'ec2', -400, -400), node('b', 'ec2', 400, 400)]) })
    fitView(undefined, false)
    expect(S().view.k).toBe(0.2)
    useStore.setState({ doc: docOf() })
    fitView(undefined, false)
    expect(S().view.k).toBeLessThanOrEqual(1.25)
    expect(Number.isFinite(S().view.x)).toBe(true)
    cam.w = 50; cam.h = 50
    fitView([], false)
    expect(Number.isFinite(S().view.k)).toBe(true)
  })
})

describe('orbit', () => {
  it('turns with the drag and keeps the grabbed ground point under the pointer', () => {
    useStore.setState({ view: { x: 500, y: 300, k: 1.5 } })
    const grabbed = groundAt(640, 380)
    const update = beginOrbit(640, 380)
    update(100, -20)
    expect(S().yaw).toBeCloseTo(ISO_YAW - 100 * ORBIT_SPEED)
    expect(S().pitch).toBeCloseTo(ISO_PITCH - 20 * ORBIT_SPEED)
    const now = groundAt(640, 380)
    expect(now[0]).toBeCloseTo(grabbed[0])
    expect(now[1]).toBeCloseTo(grabbed[1])
    expect(S().view.k).toBe(1.5)
  })
  it('stops at the lowest and highest camera angles', () => {
    const update = beginOrbit()
    update(0, 10000)
    expect(S().pitch).toBe(MAX_PITCH)
    expect(S().flat).toBe(true)
    update(0, -10000)
    expect(S().pitch).toBe(MIN_PITCH)
    expect(S().flat).toBe(false)
  })
  it('animates to a view along the shortest turn', () => {
    useStore.setState({ yaw: 350 })
    orbitTo(10, 60, 400)
    run(200)
    // passes through 360, not back through 180
    expect(S().yaw).toBeGreaterThan(350)
    expect(S().yaw).toBeLessThan(370)
    run(400)
    expect(S().yaw).toBeCloseTo(10)
    expect(S().pitch).toBeCloseTo(60)
  })
  it('snaps quarter turns onto the 45 degree grid', () => {
    useStore.setState({ yaw: 50 })
    turn(45)
    run(600)
    expect(S().yaw).toBe(90)
    turn(-45)
    run(600)
    expect(S().yaw).toBe(45)
    turn(-45); run(600); turn(-45); run(600)
    expect(S().yaw).toBe(315)
  })
  it('goes home, to the top view and to the plan view', () => {
    useStore.setState({ yaw: 100, pitch: 50 })
    viewTop()
    run(800)
    expect(S()).toMatchObject({ yaw: 90, pitch: 90, flat: true })
    viewHome()
    run(800)
    expect(S().yaw).toBeCloseTo(ISO_YAW)
    expect(S().pitch).toBeCloseTo(ISO_PITCH)
    expect(S().flat).toBe(false)
    setFlat(true)
    run(800)
    expect(S()).toMatchObject({ yaw: 0, pitch: 90, flat: true })
    setFlat(false)
    run(800)
    expect(S().flat).toBe(false)
    expect(S().yaw).toBeCloseTo(ISO_YAW)
  })
  it('holds a fit requested mid-turn until the camera settles', () => {
    useStore.setState({ doc: docOf([node('a', 'ec2', 40, 40)]) })
    orbitTo(135, 40, 400)
    run(100)
    fitView(['a'])
    run(100)
    expect(S().yaw).toBeGreaterThan(ISO_YAW) // the turn carried on
    run(1200)
    expect(S().yaw).toBeCloseTo(135)
    const q = pt(projNow(), 41, 41)
    expect(q[0] * S().view.k + S().view.x).toBeCloseTo(center()[0], 0)
  })
  it('lets a drag take over from an animated turn and drops the queued fit', () => {
    useStore.setState({ doc: docOf([node('a', 'ec2', 40, 40)]) })
    orbitTo(135, 40, 400)
    run(100)
    fitView(['a'])
    const update = beginOrbit()
    const yaw = S().yaw
    run(1000)
    expect(S().yaw).toBe(yaw)
    const view = S().view
    update(10, 0)
    expect(S().yaw).toBeCloseTo(yaw - 10 * ORBIT_SPEED)
    run(1000)
    expect(S().view.k).toBe(view.k) // no late fit
  })
  it('an immediate fit is not deferred by a turn', () => {
    useStore.setState({ doc: docOf([node('a', 'ec2', 40, 40)]) })
    orbitTo(135, 40, 400)
    fitView(undefined, false)
    expect(S().view.x).not.toBe(0)
  })
})

describe('finger-driven camera helpers', () => {
  it('runs only the newest update waiting for a frame, once', () => {
    const a = vi.fn<() => void>(), b = vi.fn<() => void>()
    onFrame(a); onFrame(b)
    vi.advanceTimersByTime(20)
    expect(a).not.toHaveBeenCalled()
    expect(b).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(100)
    expect(b).toHaveBeenCalledTimes(1)
  })
  it('can run the waiting update at once, and then has nothing left to run', () => {
    const a = vi.fn<() => void>()
    onFrame(a)
    flushFrame()
    expect(a).toHaveBeenCalledTimes(1)
    flushFrame()
    vi.advanceTimersByTime(100)
    expect(a).toHaveBeenCalledTimes(1)
  })
  it('a flick coasts in its direction and comes to rest', () => {
    const x0 = S().view.x, y0 = S().view.y
    glide(1, -0.5)
    vi.advanceTimersByTime(200)
    const x1 = S().view.x
    expect(x1).toBeGreaterThan(x0 + 50)
    expect(S().view.y).toBeLessThan(y0 - 25)
    vi.advanceTimersByTime(4000)
    const x2 = S().view.x
    expect(x2).toBeGreaterThan(x1)
    expect(x2 - x0).toBeLessThan(400) // it does not run away
    vi.advanceTimersByTime(1000)
    expect(S().view.x).toBe(x2)
    expect(S().view.k).toBe(1)
  })
  it('holdStill stops a coast, a zoom, a view animation and a turn where they are', () => {
    glide(2, 0); vi.advanceTimersByTime(50); holdStill()
    let v = S().view; vi.advanceTimersByTime(500); expect(S().view).toEqual(v)
    smoothZoom(2, 100, 100); vi.advanceTimersByTime(30); holdStill()
    v = S().view; vi.advanceTimersByTime(500); expect(S().view).toEqual(v)
    animateView({ x: 900, y: 900, k: 2 }); vi.advanceTimersByTime(50); holdStill()
    v = S().view; vi.advanceTimersByTime(900); expect(S().view).toEqual(v)
    orbitTo(200, 80); fitView(); vi.advanceTimersByTime(50); holdStill()
    const yaw = S().yaw; v = S().view; vi.advanceTimersByTime(1500)
    expect(S().yaw).toBe(yaw); expect(S().view).toEqual(v) // and the fit that was queued behind the turn is dropped
  })
  it('a view animation, a turn or a grab each end a coast', () => {
    for (const stop of [() => animateView(S().view, 10), () => orbitTo(S().yaw, S().pitch, 10), () => { beginOrbit() }]) {
      glide(2, 0); vi.advanceTimersByTime(50)
      stop(); vi.advanceTimersByTime(60)
      const x = S().view.x
      vi.advanceTimersByTime(600)
      expect(S().view.x).toBeCloseTo(x)
    }
  })
  it('knows the home view and square plan views from everything else', () => {
    expect(isTurned(ISO_YAW, ISO_PITCH)).toBe(false)
    expect(isTurned(ISO_YAW + 360, ISO_PITCH)).toBe(false)
    expect(isTurned(ISO_YAW + 3, ISO_PITCH)).toBe(true)
    expect(isTurned(ISO_YAW, 50)).toBe(true)
    for (const yaw of [0, 90, 180, 270, -90, 359.8]) expect(isTurned(yaw, 90)).toBe(false)
    expect(isTurned(45, 90)).toBe(true)
  })
  it('recover turns home and frames everything, or just frames it when already square', () => {
    resetStore({ doc: docOf([node('a', 'ec2', 0, 0), node('b', 'rds', 8, 0)]), yaw: 200, pitch: 20, view: { x: 5000, y: -4000, k: 3 } })
    expect(inSight()).toBe(false)
    recover()
    vi.advanceTimersByTime(2500)
    expect(S().yaw).toBe(ISO_YAW); expect(S().pitch).toBeCloseTo(ISO_PITCH)
    expect(inSight()).toBe(true)
    useStore.setState({ view: { x: -7000, y: 0, k: 1 } })
    expect(inSight()).toBe(false)
    recover()
    vi.advanceTimersByTime(1000)
    expect(S().yaw).toBe(ISO_YAW)
    expect(inSight()).toBe(true)
  })
  it('judges sight by the uncovered canvas, edge by edge, and an empty blueprint is always in sight', () => {
    resetStore({ doc: docOf([node('a', 'ec2', 0, 0)]) })
    fitView(undefined, false)
    const v = S().view
    for (const [dx, dy] of [[cam.w, 0], [-cam.w, 0], [0, cam.h], [0, -cam.h]]) {
      useStore.setState({ view: { ...v, x: v.x + dx, y: v.y + dy } })
      expect(inSight()).toBe(false)
    }
    resetStore({ doc: docOf([]), view: { x: 99999, y: 99999, k: 1 } })
    expect(inSight()).toBe(true)
  })
})
