// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PHONE, stubMedia } from '../test/media'
import { haptic, isPhone, sureTaps, usePhone, watchViewport } from './device'

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

function Probe() { return <span>{usePhone() ? 'phone' : 'desk'}</span> }

describe('phone detection', () => {
  it('follows the window as it narrows and widens', () => {
    const media = stubMedia()
    expect(isPhone()).toBe(false)
    render(<Probe />)
    expect(screen.getByText('desk')).toBeInTheDocument()
    act(() => media.set(PHONE))
    expect(isPhone()).toBe(true)
    expect(screen.getByText('phone')).toBeInTheDocument()
    act(() => media.set(() => false))
    expect(screen.getByText('desk')).toBeInTheDocument()
  })
  it('asks about room, and about a short screen held sideways, in one question', () => {
    const asked: string[] = []
    stubMedia((q) => { asked.push(q); return false })
    isPhone()
    expect(asked[0]).toContain('max-width: 760px')
    expect(asked[0]).toContain('max-height: 520px')
    expect(asked[0]).toContain('pointer: coarse')
  })
  it('stops listening when the component goes away', () => {
    const media = stubMedia()
    const { unmount } = render(<Probe />)
    unmount()
    expect(() => media.set(PHONE)).not.toThrow()
  })
  it('is not a phone where the browser cannot say', () => {
    vi.stubGlobal('matchMedia', undefined)
    expect(isPhone()).toBe(false)
    render(<Probe />)
    expect(screen.getByText('desk')).toBeInTheDocument()
  })
  it('copes with an old matchMedia that has no event methods', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }))
    render(<Probe />)
    expect(screen.getByText('phone')).toBeInTheDocument()
  })
})

describe('haptic', () => {
  it('ticks where the device can', () => {
    const vibrate = vi.fn<(ms: number) => boolean>()
    Object.defineProperty(navigator, 'vibrate', { value: vibrate, configurable: true })
    haptic()
    haptic(12)
    expect(vibrate.mock.calls).toEqual([[8], [12]])
    delete (navigator as any).vibrate
  })
  it('does nothing, quietly, where it cannot or may not', () => {
    expect(() => haptic()).not.toThrow()
    Object.defineProperty(navigator, 'vibrate', { value: () => { throw new Error('blocked') }, configurable: true })
    expect(() => haptic()).not.toThrow()
    delete (navigator as any).vibrate
  })
})

describe('watchViewport', () => {
  const fakeViewport = (height: number, offsetTop = 0) => {
    const subs = new Map<string, Set<() => void>>()
    const vv = {
      height, offsetTop,
      addEventListener: (t: string, f: () => void) => { (subs.get(t) ?? subs.set(t, new Set()).get(t)!).add(f) },
      removeEventListener: (t: string, f: () => void) => { subs.get(t)?.delete(f) },
      fire: (t: string) => subs.get(t)?.forEach((f) => f()),
      count: () => [...subs.values()].reduce((n, s) => n + s.size, 0),
    }
    vi.stubGlobal('visualViewport', vv)
    return vv
  }

  it('reports how much of the page the keyboard covers, and when it goes away', () => {
    stubMedia()
    const root = document.createElement('div')
    const vv = fakeViewport(window.innerHeight)
    const stop = watchViewport(root)
    expect(root.style.getPropertyValue('--kb')).toBe('0px')
    expect(root.hasAttribute('data-kb')).toBe(false)

    vv.height = window.innerHeight - 320
    vv.fire('resize')
    expect(root.style.getPropertyValue('--kb')).toBe('320px')
    expect(root.hasAttribute('data-kb')).toBe(true)

    // the page scrolled under the keyboard: less of it is covered
    vv.offsetTop = 100
    vv.fire('scroll')
    expect(root.style.getPropertyValue('--kb')).toBe('220px')

    vv.height = window.innerHeight; vv.offsetTop = 0
    vv.fire('resize')
    expect(root.style.getPropertyValue('--kb')).toBe('0px')
    expect(root.hasAttribute('data-kb')).toBe(false)
    stop()
  })
  it('does not mistake the browser bars sliding away for a keyboard', () => {
    stubMedia()
    const root = document.createElement('div')
    fakeViewport(window.innerHeight - 60)
    const stop = watchViewport(root)
    expect(root.style.getPropertyValue('--kb')).toBe('0px')
    expect(root.hasAttribute('data-kb')).toBe(false)
    stop()
  })
  it('marks the document as a phone and keeps the mark current', () => {
    const media = stubMedia(PHONE)
    const root = document.createElement('div')
    fakeViewport(window.innerHeight)
    const stop = watchViewport(root)
    expect(root.hasAttribute('data-phone')).toBe(true)
    media.set(() => false)
    window.dispatchEvent(new Event('resize'))
    expect(root.hasAttribute('data-phone')).toBe(false)
    media.set(PHONE)
    window.dispatchEvent(new Event('orientationchange'))
    expect(root.hasAttribute('data-phone')).toBe(true)
    stop()
  })
  it('works where there is no visual viewport at all', () => {
    stubMedia()
    vi.stubGlobal('visualViewport', undefined)
    const root = document.createElement('div')
    const stop = watchViewport(root)
    expect(root.style.getPropertyValue('--kb')).toBe('0px')
    expect(() => stop()).not.toThrow()
  })
  it('defaults to the document itself', () => {
    stubMedia(PHONE)
    fakeViewport(window.innerHeight)
    const stop = watchViewport()
    expect(document.documentElement.hasAttribute('data-phone')).toBe(true)
    stop()
    document.documentElement.removeAttribute('data-phone')
    document.documentElement.style.removeProperty('--kb')
  })
  it('stops the page itself being pinch-zoomed, and lets go of everything on cleanup', () => {
    stubMedia()
    const root = document.createElement('div')
    const vv = fakeViewport(window.innerHeight)
    const stop = watchViewport(root)
    const pinch = new Event('gesturestart', { cancelable: true })
    document.dispatchEvent(pinch)
    expect(pinch.defaultPrevented).toBe(true)
    expect(vv.count()).toBe(2)

    stop()
    expect(vv.count()).toBe(0)
    const after = new Event('gesturestart', { cancelable: true })
    document.dispatchEvent(after)
    expect(after.defaultPrevented).toBe(false)
    vv.height = 100
    window.dispatchEvent(new Event('resize'))
    expect(root.style.getPropertyValue('--kb')).toBe('0px')
  })
})

describe('sureTaps', () => {
  const setup = () => {
    vi.useFakeTimers()
    const stop = sureTaps()
    const onClick = vi.fn<() => void>()
    render(<><button onClick={onClick}><span>Go</span></button><button disabled onClick={onClick}>Off</button><p>plain</p></>)
    return { stop, onClick, go: screen.getByText('Go'), off: screen.getByText('Off'), plain: screen.getByText('plain') }
  }
  const touch = { pointerType: 'touch', isPrimary: true }
  afterEach(() => { vi.runOnlyPendingTimers(); vi.useRealTimers() })

  it('delivers the click the browser swallowed', () => {
    const { stop, onClick, go } = setup()
    fireEvent.pointerDown(go, { ...touch, clientX: 10, clientY: 10 })
    fireEvent.pointerUp(go, { ...touch, clientX: 12, clientY: 11 })
    expect(onClick).not.toHaveBeenCalled()
    vi.advanceTimersByTime(100)
    expect(onClick).toHaveBeenCalledTimes(1)
    stop()
  })
  it('stays out of the way when the browser clicks as usual', () => {
    const { stop, onClick, go } = setup()
    fireEvent.pointerDown(go, touch); fireEvent.pointerUp(go, touch)
    fireEvent.click(go)
    vi.advanceTimersByTime(500)
    expect(onClick).toHaveBeenCalledTimes(1)
    stop()
  })
  it('drops the browser click if it turns up after ours', () => {
    const { stop, onClick, go } = setup()
    fireEvent.pointerDown(go, touch); fireEvent.pointerUp(go, touch)
    vi.advanceTimersByTime(100)
    fireEvent.click(go)
    expect(onClick).toHaveBeenCalledTimes(1)
    // but only that one: the next real tap counts
    fireEvent.click(go)
    expect(onClick).toHaveBeenCalledTimes(2)
    stop()
  })
  it('a late click somewhere else is nothing to do with it', () => {
    const { stop, onClick, go, plain } = setup()
    const other = vi.fn<() => void>()
    plain.addEventListener('click', other)
    fireEvent.pointerDown(go, touch); fireEvent.pointerUp(go, touch)
    vi.advanceTimersByTime(100)
    fireEvent.click(plain)
    expect(other).toHaveBeenCalledTimes(1)
    expect(onClick).toHaveBeenCalledTimes(1)
    stop()
  })
  it.each([
    ['a drag that started on the button', (go: HTMLElement) => { fireEvent.pointerDown(go, { ...touch, clientX: 10, clientY: 10 }); fireEvent.pointerUp(go, { ...touch, clientX: 60, clientY: 10 }) }],
    ['a finger that slid off the button', (go: HTMLElement) => { fireEvent.pointerDown(go, touch); fireEvent.pointerUp(document.body, touch) }],
    ['a touch that was cancelled', (go: HTMLElement) => { fireEvent.pointerDown(go, touch); fireEvent.pointerCancel(go, touch); fireEvent.pointerUp(go, touch) }],
    ['a mouse', (go: HTMLElement) => { fireEvent.pointerDown(go, { pointerType: 'mouse' }); fireEvent.pointerUp(go, { pointerType: 'mouse' }) }],
    ['a second finger', (go: HTMLElement) => { fireEvent.pointerDown(go, { pointerType: 'touch', isPrimary: false }); fireEvent.pointerUp(go, { pointerType: 'touch', isPrimary: false }) }],
    ['a lift with nothing pressed', (go: HTMLElement) => { fireEvent.pointerUp(go, touch) }],
  ])('does nothing for %s', (_, act) => {
    const { stop, onClick, go } = setup()
    act(go)
    vi.advanceTimersByTime(500)
    expect(onClick).not.toHaveBeenCalled()
    stop()
  })
  it('does nothing for a long hold', () => {
    const { stop, onClick, go } = setup()
    fireEvent.pointerDown(go, touch)
    vi.advanceTimersByTime(900)
    fireEvent.pointerUp(go, touch)
    vi.advanceTimersByTime(500)
    expect(onClick).not.toHaveBeenCalled()
    stop()
  })
  it('does nothing outside a control, or on one that is disabled', () => {
    const { stop, onClick, off, plain } = setup()
    fireEvent.pointerDown(plain, touch); fireEvent.pointerUp(plain, touch)
    fireEvent.pointerDown(off, touch); fireEvent.pointerUp(off, touch)
    fireEvent.pointerDown(document, touch); fireEvent.pointerUp(document, touch)
    vi.advanceTimersByTime(500)
    expect(onClick).not.toHaveBeenCalled()
    stop()
  })
  it('stops when asked', () => {
    const { stop, onClick, go } = setup()
    fireEvent.pointerDown(go, touch); fireEvent.pointerUp(go, touch)
    stop()
    vi.advanceTimersByTime(500)
    fireEvent.pointerDown(go, touch); fireEvent.pointerUp(go, touch)
    vi.advanceTimersByTime(500)
    expect(onClick).not.toHaveBeenCalled()
  })
})
