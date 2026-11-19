// @vitest-environment jsdom
import { act, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { encodeShare, listDocs, loadDoc, saveDoc } from './core/storage'
import { useStore } from './core/store'
import { docOf, node, resetStore } from './test/helpers'

// these render whole screens; leave headroom for a busy machine
vi.setConfig({ testTimeout: 20_000 })

const S = () => useStore.getState()
const goto = (hash: string) => act(() => { location.hash = hash; window.dispatchEvent(new HashChangeEvent('hashchange')) })

beforeEach(() => {
  resetStore()
  vi.spyOn(window, 'matchMedia').mockImplementation((q) => ({ matches: /reduce/.test(q), media: q, addEventListener() {}, removeEventListener() {} }) as any)
})

describe('App', () => {
  it('shows the list of blueprints by default and applies the theme', () => {
    resetStore({ theme: 'light' })
    render(<App />)
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Infrastructure')
    expect(document.documentElement.dataset.theme).toBe('light')
    act(() => S().setTheme('dark'))
    expect(document.documentElement.dataset.theme).toBe('dark')
  })
  it('follows the address between the list and a blueprint', () => {
    saveDoc(docOf([node('a')], [], { name: 'Shop' }))
    render(<App />)
    goto('#/d/doc1')
    expect(screen.getByLabelText('Blueprint name')).toHaveValue('Shop')
    goto('#/')
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument()
    expect(document.querySelector('.editor')).toBeNull()
  })
  it('opens straight into a blueprint when loaded on its address', () => {
    saveDoc(docOf([node('a')], [], { name: 'Shop' }))
    location.hash = '#/d/doc1'
    render(<App />)
    expect(screen.getByLabelText('Blueprint name')).toHaveValue('Shop')
  })
  it('falls back to the list for an address it does not know', () => {
    location.hash = '#/nonsense'
    render(<App />)
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument()
  })
  it('opens a shared link as a new local copy', async () => {
    const shared = docOf([node('a', 'ec2', 0, 0, { name: 'web' }), node('b', 'rds', 8, 0)], [], { name: 'Shared design' })
    location.hash = '#/s/' + (await encodeShare(shared))
    render(<App />)
    expect(document.querySelector('.boot')).not.toBeNull() // a quiet holding screen while decoding
    await waitFor(() => expect(location.hash).toMatch(/^#\/d\//))
    const id = location.hash.slice(4)
    expect(id).not.toBe('doc1')
    expect(loadDoc(id)).toMatchObject({ name: 'Shared design' })
    expect(loadDoc(id)!.nodes.map((n) => n.name)).toEqual(['web', undefined])
    expect(S().toasts.at(-1)!.text).toBe('Opened a copy of the shared blueprint')
    goto(location.hash)
    expect(screen.getByLabelText('Blueprint name')).toHaveValue('Shared design')
    expect(screen.getByText('Opened a copy of the shared blueprint')).toHaveClass('toast', 'ok')
  })
  it('says so when a shared link is damaged, and returns to the list', async () => {
    location.hash = '#/s/this-is-not-a-blueprint'
    render(<App />)
    await waitFor(() => expect(S().toasts).toHaveLength(1))
    expect(S().toasts[0]).toMatchObject({ text: 'That share link is damaged or incomplete', kind: 'warn' })
    expect(location.hash).toBe('#/')
    expect(listDocs()).toHaveLength(0)
    expect(screen.getByText('That share link is damaged or incomplete')).toHaveClass('warn')
  })
  it('ignores a share link that finishes decoding after the page has moved on', async () => {
    location.hash = '#/s/' + (await encodeShare(docOf([node('a')])))
    const { unmount } = render(<App />)
    unmount()
    await new Promise((r) => setTimeout(r, 50))
    expect(listDocs()).toHaveLength(0)
    expect(S().toasts).toHaveLength(0)
  })
  it('shows a way out instead of a blank page when a screen fails to draw', () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    // the blueprint in memory is in a shape the editor cannot draw
    useStore.setState({ doc: { ...docOf(), id: 'bad', nodes: 'oops' as any } })
    location.hash = '#/d/bad'
    render(<App />)
    expect(screen.getByText('Something broke while drawing this screen.')).toBeInTheDocument()
    expect(screen.getByText(/Your blueprints are saved in this browser/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Back to all blueprints' })).toBeInTheDocument()
    expect(document.querySelector('.crash code')!.textContent).not.toBe('')
    expect(quiet).toHaveBeenCalled()
    // leaving for another screen clears the failure
    goto('#/')
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument()
  })
  it('shows toasts and lets them expire', () => {
    vi.useFakeTimers()
    try {
      render(<App />)
      act(() => { S().toast('Saved it'); S().toast('Careful', 'warn') })
      expect(screen.getByText('Saved it')).toHaveClass('ok')
      expect(screen.getByText('Careful')).toHaveClass('warn')
      expect(document.querySelector('.toasts')).toHaveAttribute('aria-live', 'polite')
      act(() => { vi.advanceTimersByTime(3300) })
      expect(document.querySelectorAll('.toast')).toHaveLength(0)
    } finally { vi.useRealTimers() }
  })
})
