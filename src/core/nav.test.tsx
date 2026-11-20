// @vitest-environment jsdom
import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { goHome, navigate, openLayer, openLayers, useBackLayer, watchHistory } from './nav'

/** let queued work and the browser's own (asynchronous) history traversal finish */
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 30)) })
const back = async () => { history.back(); await settle() }
const forward = async () => { history.forward(); await settle() }
const guard = () => !!history.state?.guard

let stop: () => void
beforeEach(async () => {
  // a page of its own at the top of history, so nothing leaks between tests
  history.pushState(null, '', '#/d/start')
  stop = watchHistory()
  await settle()
})
afterEach(async () => { await settle(); stop() })

describe('layers and the guard entry', () => {
  it('opening a layer puts one guard entry on top of the page, at the same address', async () => {
    const n = history.length
    openLayer(() => {})
    await settle()
    expect(guard()).toBe(true)
    expect(history.length).toBe(n + 1)
    expect(location.hash).toBe('#/d/start')
  })
  it('Back closes the top layer and stays on the page', async () => {
    const close = vi.fn<() => void>()
    openLayer(close)
    await settle()
    await back()
    expect(close).toHaveBeenCalledTimes(1)
    expect(location.hash).toBe('#/d/start')
    expect(guard()).toBe(false)
    expect(openLayers()).toBe(0)
  })
  it('several layers share one guard and come off newest first, one Back each', async () => {
    const order: string[] = []
    const n = history.length
    openLayer(() => order.push('sheet'))
    openLayer(() => order.push('dropdown'))
    await settle()
    expect(history.length).toBe(n + 1)
    await back()
    expect(order).toEqual(['dropdown'])
    expect(guard()).toBe(true) // re-armed for the layer still open
    await back()
    expect(order).toEqual(['dropdown', 'sheet'])
    expect(guard()).toBe(false)
    expect(location.hash).toBe('#/d/start')
  })
  it('closing from the screen steps off the guard, so the next Back is an ordinary one', async () => {
    const close = vi.fn<() => void>()
    const done = openLayer(close)
    await settle()
    done()
    await settle()
    expect(guard()).toBe(false)
    expect(close).not.toHaveBeenCalled() // it was closed by its own button: Back had no part in it
    history.pushState(null, '', '#/d/next')
    await back()
    expect(location.hash).toBe('#/d/start')
  })
  it('closing one layer and opening another in the same breath does not touch history at all', async () => {
    const done = openLayer(() => {})
    await settle()
    const push = vi.spyOn(history, 'pushState'), goBack = vi.spyOn(history, 'back')
    done()
    openLayer(() => {})
    await settle()
    expect(push).not.toHaveBeenCalled()
    expect(goBack).not.toHaveBeenCalled()
    expect(guard()).toBe(true)
    vi.restoreAllMocks()
  })
  it('a layer opened while the guard is still being stepped off gets a fresh guard once that lands', async () => {
    const done = openLayer(() => {})
    await settle()
    done()
    await act(async () => { await Promise.resolve() }) // the step back has been asked for, not delivered
    const close = vi.fn<() => void>()
    openLayer(close)
    await settle()
    expect(guard()).toBe(true)
    await back()
    expect(close).toHaveBeenCalledTimes(1)
  })
  it('taking a layer off twice, or after Back already took it, is harmless', async () => {
    const done = openLayer(() => {})
    await settle()
    await back()
    done(); done()
    await settle()
    expect(openLayers()).toBe(0)
    expect(location.hash).toBe('#/d/start')
  })
  it('opening and closing many times leaves history no longer than one guard', async () => {
    const n = history.length
    for (let i = 0; i < 8; i++) { const done = openLayer(() => {}); await settle(); done(); await settle() }
    expect(history.length).toBeLessThanOrEqual(n + 1)
    expect(guard()).toBe(false)
  })
  it('Forward onto a guard whose layer is gone steps straight back off it', async () => {
    openLayer(() => {})
    await settle()
    await back()
    await forward()
    await settle()
    expect(guard()).toBe(false)
    expect(openLayers()).toBe(0)
    expect(location.hash).toBe('#/d/start')
  })
  it('starting on a stale guard (a reload with something open) steps off it', async () => {
    stop()
    history.pushState({ guard: true }, '')
    stop = watchHistory()
    await settle()
    expect(guard()).toBe(false)
    expect(location.hash).toBe('#/d/start')
  })
  it('Back between ordinary pages is left alone', async () => {
    history.pushState(null, '', '#/d/other')
    await back()
    expect(location.hash).toBe('#/d/start')
    expect(openLayers()).toBe(0)
  })
})

describe('pages', () => {
  const heard = () => { const f = vi.fn<() => void>(); window.addEventListener('hashchange', f); return f }
  it('navigate adds a page, remembers where it came from, and tells the router', () => {
    const f = heard(), n = history.length
    navigate('#/d/abc')
    expect(location.hash).toBe('#/d/abc')
    expect(history.length).toBe(n + 1)
    expect(history.state).toEqual({ from: '#/d/start' })
    expect(f).toHaveBeenCalledTimes(1)
    window.removeEventListener('hashchange', f)
  })
  it('navigating to where you already are does nothing', () => {
    const f = heard(), n = history.length
    navigate('#/d/start')
    expect(history.length).toBe(n)
    expect(f).not.toHaveBeenCalled()
    window.removeEventListener('hashchange', f)
  })
  it('the empty address and "#/" are the same page', () => {
    history.replaceState(null, '', location.pathname)
    const n = history.length
    navigate('#/')
    expect(history.length).toBe(n)
  })
  it('replace swaps the current entry, so Back cannot return to it', async () => {
    history.pushState(null, '', '#/d/gone')
    const n = history.length
    navigate('#/', { replace: true })
    expect(history.length).toBe(n)
    expect(location.hash).toBe('#/')
    await back()
    expect(location.hash).toBe('#/d/start')
  })
  it('a page change with a layer open takes the guard’s place, so the old guard is never landed on', async () => {
    openLayer(() => {})
    await settle()
    const n = history.length
    navigate('#/d/elsewhere')
    expect(history.length).toBe(n)
    expect(guard()).toBe(false)
    await back()
    expect(location.hash).toBe('#/d/start')
    expect(guard()).toBe(false)
  })
  it('home from a page opened from the dashboard is a step back', async () => {
    history.pushState(null, '', '#/')
    navigate('#/d/abc')
    const n = history.length
    goHome()
    await settle()
    expect(location.hash).toBe('#/')
    expect(history.length).toBe(n) // nothing added
    await forward()
    expect(location.hash).toBe('#/d/abc') // the blueprint is ahead, not behind
  })
  it('home with a layer still open steps back past the guard as well', async () => {
    history.pushState(null, '', '#/')
    navigate('#/d/abc')
    openLayer(() => {})
    await settle()
    goHome()
    await settle()
    expect(location.hash).toBe('#/')
    expect(guard()).toBe(false)
  })
  it('home from a page opened by its address goes forward to the dashboard', async () => {
    const n = history.length
    goHome()
    expect(location.hash).toBe('#/')
    expect(history.length).toBe(n + 1)
    await back()
    expect(location.hash).toBe('#/d/start')
  })
  it('home on the dashboard does nothing', () => {
    history.pushState(null, '', '#/')
    const n = history.length
    goHome()
    expect(history.length).toBe(n)
  })
})

describe('useBackLayer', () => {
  function Layer({ open, onClose }: { open: boolean; onClose: () => void }) { useBackLayer(open, onClose); return null }
  it('registers while open, and Back calls the newest close handler', async () => {
    const first = vi.fn<() => void>(), latest = vi.fn<() => void>()
    const { rerender } = render(<Layer open onClose={first} />)
    rerender(<Layer open onClose={latest} />)
    await settle()
    expect(openLayers()).toBe(1)
    await back()
    expect(first).not.toHaveBeenCalled()
    expect(latest).toHaveBeenCalledTimes(1)
  })
  it('lets go when it closes or goes away', async () => {
    const { rerender, unmount } = render(<Layer open onClose={() => {}} />)
    await settle()
    rerender(<Layer open={false} onClose={() => {}} />)
    await settle()
    expect(openLayers()).toBe(0)
    expect(guard()).toBe(false)
    rerender(<Layer open onClose={() => {}} />)
    await settle()
    unmount()
    await settle()
    expect(openLayers()).toBe(0)
    expect(guard()).toBe(false)
  })
  it('a closed layer never registers', async () => {
    render(<Layer open={false} onClose={() => {}} />)
    await settle()
    expect(openLayers()).toBe(0)
    expect(guard()).toBe(false)
  })
})
