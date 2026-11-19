// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cam, chrome } from '../canvas/camera'
import { makeCam, pt } from '../core/iso'
import { useStore } from '../core/store'
import { docOf, node, resetStore } from '../test/helpers'
import { Sheet } from './Sheet'

const sheet = () => screen.getByRole('dialog')
const head = () => document.querySelector('.sheet-head')!
const tall = () => sheet().classList.contains('tall')
let box = { left: 0, top: 400, width: 390, height: 440 }

/** press on the header, travel `dy` over `ms`, and let go */
function pull(dy: number, ms = 400, target: Element = head()) {
  fireEvent.pointerDown(target, { pointerId: 1, clientY: 300 })
  vi.advanceTimersByTime(ms)
  fireEvent.pointerMove(head(), { pointerId: 1, clientY: 300 + dy })
  fireEvent.pointerUp(head(), { pointerId: 1, clientY: 300 + dy })
}

beforeEach(() => {
  vi.useFakeTimers()
  resetStore({ doc: docOf([node('a', 'ec2', 0, 0), node('b', 'rds', 8, 0)]) })
  Object.assign(cam, { w: 390, h: 844, left: 0, top: 0 })
  vi.stubGlobal('innerWidth', 390); vi.stubGlobal('innerHeight', 844)
  box = { left: 0, top: 400, width: 390, height: 440 }
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const b = this.classList?.contains('sheet') ? box : { left: 0, top: 0, width: 0, height: 0 }
    return { ...b, x: b.left, y: b.top, right: b.left + b.width, bottom: b.top + b.height, toJSON() {} } as DOMRect
  })
})
afterEach(() => { vi.runOnlyPendingTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); chrome.bottom = 0; chrome.right = 0 })

const mount = (props: Partial<Parameters<typeof Sheet>[0]> = {}) => {
  const onClose = vi.fn<() => void>()
  const r = render(<Sheet label="Library" title="Add a component" onClose={onClose} {...props}><input aria-label="Search" /><p>Body</p></Sheet>)
  return { onClose, ...r }
}

describe('Sheet', () => {
  it('is a labelled dialog with a title, its content and a way to close it', () => {
    const { onClose } = mount()
    expect(screen.getByRole('dialog', { name: 'Library' })).toBeInTheDocument()
    expect(screen.getByText('Add a component')).toBeInTheDocument()
    expect(screen.getByText('Body')).toBeInTheDocument()
    expect(tall()).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Close library' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
  it('can open at full height', () => {
    mount({ startTall: true })
    expect(tall()).toBe(true)
  })
  it('toggles its height when the handle is tapped', () => {
    const { onClose } = mount()
    pull(0, 80)
    expect(tall()).toBe(true)
    pull(3, 80)
    expect(tall()).toBe(false)
    expect(onClose).not.toHaveBeenCalled()
  })
  it('follows the finger while it is dragged, then lets the stylesheet take over again', () => {
    mount()
    fireEvent.pointerDown(head(), { pointerId: 1, clientY: 300 })
    expect(sheet().style.transition).toBe('none')
    fireEvent.pointerMove(head(), { pointerId: 1, clientY: 360 })
    expect(sheet().style.transform).toBe('translateY(60px)')
    // pulling up resists: it is already as tall as this size goes
    fireEvent.pointerMove(head(), { pointerId: 1, clientY: 260 })
    expect(sheet().style.transform).toBe('translateY(-20px)')
    vi.advanceTimersByTime(500)
    fireEvent.pointerUp(head(), { pointerId: 1, clientY: 260 })
    expect(sheet().style.transform).toBe('')
    expect(sheet().style.transition).toBe('')
  })
  it('resists harder when it is already at full height', () => {
    mount({ startTall: true })
    fireEvent.pointerDown(head(), { pointerId: 1, clientY: 300 })
    fireEvent.pointerMove(head(), { pointerId: 1, clientY: 240 })
    expect(sheet().style.transform).toBe('translateY(-10px)')
    fireEvent.pointerCancel(head(), { pointerId: 1 })
  })
  it('closes when dragged well down', () => {
    const { onClose } = mount()
    pull(160)
    expect(onClose).toHaveBeenCalledTimes(1)
  })
  it('settles back when the drag was too short to mean anything', () => {
    const { onClose } = mount()
    pull(60)
    expect(onClose).not.toHaveBeenCalled()
    expect(tall()).toBe(false)
    pull(-30)
    expect(tall()).toBe(false)
  })
  it('grows when dragged up', () => {
    mount()
    pull(-90)
    expect(tall()).toBe(true)
  })
  it('steps down from full height before closing', () => {
    const { onClose } = mount({ startTall: true })
    pull(160)
    expect(tall()).toBe(false)
    expect(onClose).not.toHaveBeenCalled()
    pull(160)
    expect(onClose).toHaveBeenCalledTimes(1)
  })
  it('a quick flick down closes it from any height; a quick flick up opens it fully', () => {
    const a = mount({ startTall: true })
    pull(50, 40)
    expect(a.onClose).toHaveBeenCalledTimes(1)
    a.unmount()
    mount()
    pull(-26, 30)
    expect(tall()).toBe(true)
  })
  it('ignores moves and releases that are not part of a drag', () => {
    const { onClose } = mount()
    fireEvent.pointerMove(head(), { pointerId: 1, clientY: 900 })
    fireEvent.pointerUp(head(), { pointerId: 1, clientY: 900 })
    expect(sheet().style.transform).toBe('')
    expect(tall()).toBe(false)
    expect(onClose).not.toHaveBeenCalled()
  })
  it('a tap on a control in its header belongs to the control, not to the sheet', () => {
    const { onClose } = mount({ title: <div role="tablist"><button role="tab">Budget</button></div> })
    const tab = screen.getByRole('tab', { name: 'Budget' })
    pull(0, 80, tab)
    expect(tall()).toBe(false) // the handle's tap-to-toggle did not fire
    pull(5, 80, tab) // nor does a slightly unsteady tap
    expect(tall()).toBe(false)
    expect(sheet().style.transition).toBe('')
    expect(onClose).not.toHaveBeenCalled()
  })
  it('but the whole header drags, tabs and all, once the finger actually travels', () => {
    const { onClose } = mount({ title: <div role="tablist"><button role="tab">Budget</button></div> })
    const tab = screen.getByRole('tab', { name: 'Budget' })
    fireEvent.pointerDown(tab, { pointerId: 1, clientY: 300 })
    expect(sheet().style.transition).toBe('') // not held yet
    fireEvent.pointerMove(head(), { pointerId: 1, clientY: 304 })
    expect(sheet().style.transform).toBe('')
    fireEvent.pointerMove(head(), { pointerId: 1, clientY: 340 })
    expect(sheet().style.transition).toBe('none')
    expect(sheet().style.transform).toBe('translateY(40px)')
    vi.advanceTimersByTime(400) // a slow, short drag: it settles back
    fireEvent.pointerUp(head(), { pointerId: 1, clientY: 340 })
    expect(onClose).not.toHaveBeenCalled()
    pull(200, 400, screen.getByRole('button', { name: 'Close library' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
  it('survives a pointer that cannot be captured', () => {
    const { onClose } = mount()
    vi.spyOn(Element.prototype as any, 'setPointerCapture').mockImplementation(() => { throw new DOMException('gone', 'NotFoundError') })
    pull(160)
    expect(onClose).toHaveBeenCalledTimes(1)
  })
  it('takes all the room it can when a field inside it is about to be typed in', () => {
    mount()
    fireEvent.focusIn(screen.getByText('Body'))
    expect(tall()).toBe(false)
    fireEvent.focusIn(screen.getByLabelText('Search'))
    expect(tall()).toBe(true)
  })
})

describe('Sheet and the camera', () => {
  it('tells the camera how much of the canvas it covers, and gives it back on closing', () => {
    const { unmount } = mount()
    expect(chrome).toEqual({ bottom: 440, right: 0 })
    box = { left: 0, top: 60, width: 390, height: 784 }
    act(() => { window.dispatchEvent(new Event('resize')) })
    expect(chrome.bottom).toBe(784)
    unmount()
    expect(chrome).toEqual({ bottom: 0, right: 0 })
  })
  it('measures again when its height changes', () => {
    mount()
    box = { left: 0, top: 60, width: 390, height: 784 }
    pull(-90)
    expect(chrome.bottom).toBe(784)
  })
  it('counts as covering the side when it is docked there on a phone held sideways', () => {
    vi.stubGlobal('innerWidth', 844); vi.stubGlobal('innerHeight', 390)
    box = { left: 464, top: 44, width: 380, height: 360 }
    mount()
    expect(chrome).toEqual({ bottom: 0, right: 380 })
  })
  it('brings the selected component back into view above itself, never zooming in to do it', () => {
    useStore.setState({ selection: ['a'], view: { x: 100, y: 1500, k: 0.8 } })
    mount()
    vi.advanceTimersByTime(60)   // the sheet has settled
    vi.advanceTimersByTime(1000) // the camera glides over
    const v = useStore.getState().view
    expect(v.k).toBeLessThanOrEqual(0.8)
    // the middle of the component now sits in the strip of canvas between the top bar and the sheet
    const q = pt(makeCam(useStore.getState().yaw, useStore.getState().pitch), 1, 1)
    const y = q[1] * v.k + v.y, x = q[0] * v.k + v.x
    expect(y).toBeGreaterThan(64)
    expect(y).toBeLessThan(844 - 440)
    expect(x).toBeGreaterThan(0)
    expect(x).toBeLessThan(390)
  })
  it('with nothing selected, re-frames the whole blueprint in the room that is left', () => {
    useStore.setState({ view: { x: 100, y: 1500, k: 0.8 } })
    mount()
    vi.advanceTimersByTime(2000)
    const v = useStore.getState().view, cam3 = makeCam(useStore.getState().yaw, useStore.getState().pitch)
    // both components now sit between the top bar and the sheet, inside the screen
    for (const [wx, wy] of [[1, 1], [9, 1]]) {
      const q = pt(cam3, wx, wy), x = q[0] * v.k + v.x, y = q[1] * v.k + v.y
      expect(x).toBeGreaterThan(0); expect(x).toBeLessThan(390)
      expect(y).toBeGreaterThan(64); expect(y).toBeLessThan(844 - 440)
    }
  })
})
