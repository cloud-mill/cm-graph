import { describe, expect, it } from 'vitest'
import { MAX_NOTCHES, NOTCH_ZOOM, type WheelInput, notchesOf, readWheel } from './wheel'

const ev = (e: Partial<WheelInput>): WheelInput => ({ deltaX: 0, deltaY: 0, deltaMode: 0, ctrlKey: false, ...e })
/** one notch away from the user (zooming in), as each system reports it */
const NOTCH_IN: Record<string, WheelInput> = {
  'Chrome on Windows': ev({ deltaY: -100, wheelDeltaY: 120 }),
  'Chrome on Linux': ev({ deltaY: -120, wheelDeltaY: 144 }),
  'Chrome on a Mac, slow': ev({ deltaY: -4.000244140625, wheelDeltaY: 120 }),
  'Windows set to five lines a notch': ev({ deltaY: -166.66666666666666, wheelDeltaY: 120 }),
  'Firefox, in lines': ev({ deltaY: -3, deltaMode: 1 }),
  'a browser that scrolls by the page': ev({ deltaY: -1, deltaMode: 2 }),
  'no legacy value to go by': ev({ deltaY: -100 }),
}

describe('how many notches a wheel event is', () => {
  it('one notch is one notch, however the system reports it', () => {
    for (const [name, e] of Object.entries(NOTCH_IN)) {
      // Chrome on Linux reports its notch a fifth larger in both properties; it is still read as one step, near enough
      expect(notchesOf(e), name).toBeCloseTo(-1, name === 'Chrome on Linux' ? 0 : 5)
    }
  })
  it('a trackpad is not a wheel: its legacy value is exactly three times its delta, however large the delta', () => {
    for (const deltaY of [1, -2.5, 12, 40, -80, 120, 333]) expect(notchesOf(ev({ deltaY, wheelDeltaY: -3 * deltaY }))).toBeNull()
  })
  it('a high-resolution wheel counts in fractions of a notch', () => {
    expect(notchesOf(ev({ deltaY: -12.5, wheelDeltaY: 15 }))).toBeCloseTo(-0.125, 5)
  })
  it('a sideways movement is never a notch', () => {
    expect(notchesOf(ev({ deltaX: 100, wheelDeltaY: 0 }))).toBeNull()
    expect(notchesOf(ev({ deltaX: 3, deltaMode: 1 }))).toBeNull()
  })
  it('with no legacy value, small or fractional or slanting movement is taken for a trackpad', () => {
    expect(notchesOf(ev({ deltaY: 12 }))).toBeNull()
    expect(notchesOf(ev({ deltaY: 52.5 }))).toBeNull()
    expect(notchesOf(ev({ deltaY: 100, deltaX: 4 }))).toBeNull()
    expect(notchesOf(ev({ deltaY: 200 }))).toBe(2)
  })
})

describe('what the canvas does about a wheel event', () => {
  it('one notch of a wheel is one small eased step of zoom, the same on every system', () => {
    for (const [name, e] of Object.entries(NOTCH_IN)) {
      const act = readWheel(e)
      expect(act, name).toMatchObject({ kind: 'zoom', eased: true })
      if (act.kind !== 'zoom') continue
      expect(act.factor, name).toBeGreaterThan(1.09)
      expect(act.factor, name).toBeLessThan(1.125)
    }
    expect(readWheel(NOTCH_IN['Chrome on Windows'])).toEqual({ kind: 'zoom', factor: NOTCH_ZOOM, eased: true })
  })
  it('a notch towards the user zooms out by exactly what a notch away zooms in', () => {
    const out = readWheel(ev({ deltaY: 100, wheelDeltaY: -120 })), back = readWheel(ev({ deltaY: -100, wheelDeltaY: 120 }))
    expect(out.kind === 'zoom' && back.kind === 'zoom' && out.factor * back.factor).toBeCloseTo(1, 12)
  })
  it('a wheel spun hard is held to a few notches an event, so the view never leaps', () => {
    const act = readWheel(ev({ deltaY: -2400, wheelDeltaY: 2880 }))
    expect(act).toEqual({ kind: 'zoom', factor: Math.pow(NOTCH_ZOOM, MAX_NOTCHES), eased: true })
    expect(readWheel(ev({ deltaY: 90, deltaMode: 1 }))).toEqual({ kind: 'zoom', factor: Math.pow(NOTCH_ZOOM, -MAX_NOTCHES), eased: true })
  })
  it('Ctrl with a mouse wheel is the same small step, not a pinch', () => {
    expect(readWheel(ev({ deltaY: -100, wheelDeltaY: 120, ctrlKey: true }))).toEqual({ kind: 'zoom', factor: NOTCH_ZOOM, eased: true })
  })
  it('a pinch follows the fingers at once, in proportion, and a stray large report is held back', () => {
    const small = readWheel(ev({ deltaY: -2, wheelDeltaY: 6, ctrlKey: true }))
    expect(small).toMatchObject({ kind: 'zoom', eased: false })
    expect(small.kind === 'zoom' && small.factor).toBeCloseTo(Math.exp(0.02), 12)
    // twice the movement is the same step taken twice
    const twice = readWheel(ev({ deltaY: -4, wheelDeltaY: 12, ctrlKey: true }))
    expect(twice.kind === 'zoom' && small.kind === 'zoom' && twice.factor).toBeCloseTo((small as any).factor ** 2, 12)
    const stray = readWheel(ev({ deltaY: 900, wheelDeltaY: -2700, ctrlKey: true }))
    expect(stray.kind === 'zoom' && stray.factor).toBeCloseTo(Math.exp(-0.4), 12)
    // Cmd with a trackpad scroll asks for the same
    expect(readWheel(ev({ deltaY: -2, wheelDeltaY: 6, metaKey: true }))).toMatchObject({ kind: 'zoom', eased: false })
  })
  it('two fingers sliding on a trackpad pan, pixel for pixel, however fast', () => {
    expect(readWheel(ev({ deltaX: 30, deltaY: 12.5, wheelDeltaY: -37.5 }))).toEqual({ kind: 'pan', dx: -30, dy: -12.5 })
    expect(readWheel(ev({ deltaY: 120, wheelDeltaY: -360 }))).toEqual({ kind: 'pan', dx: -0, dy: -120 })
  })
  it('a wheel turned sideways, or with Shift, pans sideways', () => {
    expect(readWheel(ev({ deltaX: 100, wheelDeltaY: 0 }))).toEqual({ kind: 'pan', dx: -100, dy: -0 })
    expect(readWheel(ev({ deltaX: 3, deltaMode: 1 }))).toEqual({ kind: 'pan', dx: -48, dy: -0 })
    // Ctrl with nothing to zoom by is still a pan
    expect(readWheel(ev({ deltaX: 10, ctrlKey: true }))).toMatchObject({ kind: 'pan' })
  })
})
