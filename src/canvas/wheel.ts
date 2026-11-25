/**
 * Reading the wheel. A `wheel` event does not say what sent it, and the same turn of a wheel arrives as very different
 * numbers on different systems: 100 px a notch from Chrome on Windows, 120 on Linux, about 4 px (with acceleration) from
 * a mouse on a Mac, 3 lines from Firefox. A trackpad sends a stream of small pixel deltas, and a pinch on one arrives as
 * a wheel event with Ctrl held. So nothing here trusts `deltaY` as a distance. Each event is turned into one of three
 * things the canvas can act on, in units that mean the same everywhere:
 *
 *  - a mouse wheel turning: a number of notches (fractions for a high-resolution wheel), each a fixed, small zoom step;
 *  - a pinch: a zoom factor that follows the fingers directly;
 *  - two fingers sliding on a trackpad, or a wheel tilted or turned with Shift: a pan, in screen pixels.
 *
 * Pure: it takes the numbers on the event and returns what to do. The canvas does it.
 */

/** The fields of a `WheelEvent` this reads. `wheelDeltaY` is the old non-standard property; Chrome, Edge and Safari still set it. */
export interface WheelInput {
  deltaX: number
  deltaY: number
  deltaMode: number
  ctrlKey: boolean
  metaKey?: boolean
  wheelDeltaY?: number
}

export type WheelAct =
  /** zoom about the pointer by `factor`. `eased` for a wheel's separate notches, which glide; a pinch is followed at once */
  | { kind: 'zoom'; factor: number; eased: boolean }
  /** slide the view by this many screen pixels */
  | { kind: 'pan'; dx: number; dy: number }

/** How much one notch of a mouse wheel zooms: a tenth. From 100% it takes about seven notches to double. */
export const NOTCH_ZOOM = 1.1
/** The most notches one event may count for. A free-spinning wheel can report a dozen at once; the view should not leap. */
export const MAX_NOTCHES = 3
/**
 * A pinch reports a hundredth of the change in scale per unit, on every browser that reports pinches this way: `deltaY`
 * is a hundred times the natural log of how far the fingers have moved apart since the last event (Chrome's own rule,
 * which the others follow near enough). Undone exactly, the view grows by just what the fingers did.
 */
const PINCH_RATE = 0.01
/** The most one pinch event may count for, in its own units: about a 1.5 times change. Guards against a stray large report. */
const MAX_PINCH = 40
/**
 * The least a real notch of a wheel moves `deltaY`, give or take: a third of a line's hundred, on a Windows set to scroll
 * one line a notch. Anything that claims to be a whole notch and moves less than this is not a wheel (see `notchesOf`).
 */
const LEAST_NOTCH = 30
/** Pixels to a line, for the rare wheel that scrolls sideways in lines. */
const LINE = 16

const clamp = (v: number, most: number) => Math.max(-most, Math.min(most, v))

/**
 * How many notches of a mouse wheel this event is, towards the user positive; or null when it did not come from a wheel
 * turning in notches (a trackpad, or a sideways scroll).
 *
 * The test that works across systems is the ratio between the legacy `wheelDeltaY` and `deltaY`. Browsers derive one from
 * the other: for a device with precise scrolling (a trackpad) `wheelDeltaY` is exactly -3 times `deltaY`; for a wheel it
 * is 120 a notch whatever `deltaY` says. So a ratio of 3 means trackpad, and anything else is a wheel whose notch count
 * is `wheelDeltaY / 120`. Firefox sets no `wheelDeltaY` but reports a wheel in lines, three to the notch.
 *
 * One thing breaks that rule, and it is the commonest gesture on a laptop. Chrome and Edge turn a pinch on a trackpad
 * into wheel events with Ctrl held, as every browser does, but give each a legacy value of one whole notch (120, the
 * sign saying which way) however small the movement, with `deltaY` a hundred times the natural log of the change in
 * scale since the last event: a number like 1.6. (Measured from Chrome's own input pipeline: a pinch of 1.7 times
 * arrives as 23 events, `deltaY` between -1.5 and -3.2, every one with `wheelDeltaY` 120.) Counted as notches, a pinch
 * would be a tenth sixty times a second: fingers moved apart by a third sent the view to more than twice its size.
 * A real notch with Ctrl held moves `deltaY` by a third of a line's hundred at the very least, so the two are told
 * apart by that.
 */
export function notchesOf(e: WheelInput): number | null {
  if (e.deltaY === 0) return null
  if (e.deltaMode === 1) return e.deltaY / 3
  if (e.deltaMode === 2) return Math.sign(e.deltaY)
  if (e.ctrlKey && Math.abs(e.wheelDeltaY ?? 0) === 120 && Math.abs(e.deltaY) < LEAST_NOTCH) return null
  if (typeof e.wheelDeltaY === 'number' && e.wheelDeltaY !== 0) {
    if (Math.abs(e.wheelDeltaY + 3 * e.deltaY) < 0.5) return null
    return -e.wheelDeltaY / 120
  }
  // no legacy value to go by: a wheel moves straight up and down in whole steps of some size, a trackpad in small ones
  return e.deltaX === 0 && Number.isInteger(e.deltaY) && Math.abs(e.deltaY) >= 40 ? e.deltaY / 100 : null
}

/** What the canvas should do about a wheel event. */
export function readWheel(e: WheelInput): WheelAct {
  const notches = notchesOf(e)
  // a wheel zooms, with or without Ctrl, by the same small step each notch
  if (notches !== null) return { kind: 'zoom', factor: Math.pow(NOTCH_ZOOM, -clamp(notches, MAX_NOTCHES)), eased: true }
  // a pinch on a trackpad arrives with Ctrl held (and Cmd with a trackpad scroll is asked for as zoom the same way)
  if ((e.ctrlKey || e.metaKey) && e.deltaY !== 0) return { kind: 'zoom', factor: Math.exp(-clamp(e.deltaY, MAX_PINCH) * PINCH_RATE), eased: false }
  const unit = e.deltaMode === 1 ? LINE : 1
  return { kind: 'pan', dx: -e.deltaX * unit, dy: -e.deltaY * unit }
}
