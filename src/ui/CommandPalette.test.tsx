// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { providerOf } from '../core/catalog'
import { listSnapshots } from '../core/storage'
import { useStore } from '../core/store'
import { docOf, edge, node, resetStore } from '../test/helpers'
import { CommandPalette } from './CommandPalette'

// these render whole screens; leave headroom for a busy machine
vi.setConfig({ testTimeout: 20_000 })

const S = () => useStore.getState()
const labels = () => [...document.querySelectorAll('.cmdk-item .cmdk-label')].map((e) => e.textContent)
const input = () => screen.getByPlaceholderText(/Search actions/)
const doc = () => docOf([node('a', 'ec2', 0, 0, { name: 'web-frontend' }), node('b', 'rds', 8, 0, { name: 'orders-db' })], [edge('e', 'a', 'b')])

function open(state: object = {}) {
  resetStore({ doc: doc(), ...state })
  const onClose = vi.fn<(...args: any[]) => void>()
  render(<CommandPalette onClose={onClose} />)
  return onClose
}
/** Type a query and run the top result. */
async function run(query: string, state: object = {}) {
  const onClose = open(state)
  await userEvent.type(input(), query)
  await userEvent.keyboard('{Enter}')
  expect(onClose).toHaveBeenCalledTimes(1)
}

const moveOver = (el: Element, dx = 1) => {
  const e = new MouseEvent('pointermove', { bubbles: true })
  Object.defineProperty(e, 'movementX', { value: dx })
  Object.defineProperty(e, 'movementY', { value: 0 })
  fireEvent(el, e)
}

beforeEach(() => resetStore())
afterEach(() => { vi.useRealTimers(); location.hash = '' })

describe('CommandPalette', () => {
  it('opens focused with common actions and a few components', () => {
    open()
    expect(input()).toHaveFocus()
    expect(screen.getByRole('dialog', { name: 'Command palette' })).toBeInTheDocument()
    expect(labels()).toHaveLength(14)
    expect(labels()[0]).toBe('Zoom to fit')
    expect([...document.querySelectorAll('.cmdk-group')].map((g) => g.textContent)).toEqual(['Actions', 'Add component'])
    expect(document.querySelector('.cmdk-item.on')).toHaveTextContent('Zoom to fit')
  })
  it('matches every word, ranks canvas items first and prefixes before substrings', async () => {
    open()
    await userEvent.type(input(), 'orders')
    expect(labels()[0]).toBe('orders-db')
    expect(document.querySelector('.cmdk-group')).toHaveTextContent('Jump to')
    await userEvent.clear(input())
    await userEvent.type(input(), 'view turn')
    expect(labels()).toEqual(['Turn view left', 'Turn view right'])
    await userEvent.clear(input())
    await userEvent.type(input(), 'top')
    expect(labels()[0]).toBe('Top view') // starts with the query
    expect(labels()).toContain('Stop traffic animation') // merely contains it
  })
  it('reflects current state in toggle labels', () => {
    open({ flat: true, lens: 'cost', flow: false, showGrid: false, showLabels: false, theme: 'light' })
    fireEvent.change(input(), { target: { value: 'i' } })
    const all = labels()
    for (const l of ['Switch to isometric view', 'Animate traffic flow', 'Show grid', 'Switch to dark theme']) expect(all).toContain(l)
    fireEvent.change(input(), { target: { value: 'heatmap' } })
    expect(labels()).toEqual(['Turn off cost heatmap'])
    fireEvent.change(input(), { target: { value: 'component names' } })
    expect(labels()).toEqual(['Show component names'])
  })
  it('says when nothing matches and does nothing on Enter', async () => {
    const onClose = open()
    await userEvent.type(input(), 'qqqqq{Enter}')
    expect(screen.getByText('Nothing matches “qqqqq”.')).toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
  })
  it('moves with the arrows inside the list and follows the pointer', async () => {
    open()
    const on = () => document.querySelector('.cmdk-item.on .cmdk-label')!.textContent
    await userEvent.keyboard('{ArrowUp}')
    expect(on()).toBe(labels()[0])
    await userEvent.keyboard('{ArrowDown}{ArrowDown}')
    expect(on()).toBe(labels()[2])
    for (let i = 0; i < 30; i++) fireEvent.keyDown(input(), { key: 'ArrowDown' })
    expect(on()).toBe(labels()[13])
    moveOver(document.querySelectorAll('.cmdk-item')[4], 0) // a list scrolling under a resting pointer does not move the highlight
    expect(on()).toBe(labels()[13])
    moveOver(document.querySelectorAll('.cmdk-item')[4])
    expect(on()).toBe(labels()[4])
    await userEvent.type(input(), 'grid')
    expect(on()).toBe('Hide grid') // a new query starts from the top
  })
  it('closes on Escape without leaking the key, and on a click outside', async () => {
    const onClose = open()
    const seen = vi.fn<(...args: any[]) => void>()
    window.addEventListener('keydown', seen)
    await userEvent.keyboard('{Escape}')
    window.removeEventListener('keydown', seen)
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(seen).not.toHaveBeenCalled()
    fireEvent.pointerDown(screen.getByRole('dialog'))
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.pointerDown(document.querySelector('.scrim')!)
    expect(onClose).toHaveBeenCalledTimes(2)
  })
  it('runs a command on click', async () => {
    const onClose = open()
    await userEvent.type(input(), 'hide grid')
    await userEvent.click(screen.getByRole('button', { name: /Hide grid/ }))
    expect(S().showGrid).toBe(false)
    expect(onClose).toHaveBeenCalled()
  })

  it.each([
    ['open budget', { panel: 'budget' }],
    ['architecture advisor', { panel: 'advisor' }],
    ['export', { modal: 'export' }],
    ['import from', { modal: 'import' }],
    ['share link', { modal: 'share' }],
    ['version history', { modal: 'history' }],
    ['keyboard shortcuts', { modal: 'shortcuts' }],
    ['orbit tool', { tool: 'orbit' }],
    ['show cost heatmap', { lens: 'cost' }],
    ['stop traffic', { flow: false }],
    ['hide component names', { showLabels: false }],
    ['light theme', { theme: 'light' }],
  ])('"%s" changes the app state', async (query, want) => {
    await run(query)
    expect(S()).toMatchObject(want)
  })
  it('selects everything', async () => {
    await run('select all')
    expect(S().selection).toEqual(['a', 'b'])
  })
  it('saves a version', async () => {
    await run('save a version')
    expect(listSnapshots('doc1')).toHaveLength(1)
    expect(S().toasts.at(-1)!.text).toBe('Version saved')
  })
  it('goes back to the list of blueprints', async () => {
    await run('back to all')
    expect(location.hash).toBe('#/')
  })
  it('tidies the layout as an undoable step', async () => {
    await run('tidy')
    expect(S().past).toHaveLength(1)
    expect(S().toasts.at(-1)!.text).toBe('Layout tidied')
  })
  it('translates the blueprint to another cloud, and says when there is nothing to move', async () => {
    await run('translate azure')
    expect(S().doc.nodes.every((n) => providerOf(n.type) === 'azure')).toBe(true)
    expect(S().provider).toBe('azure')
    const before = S().doc
    const onClose = vi.fn<(...args: any[]) => void>()
    render(<CommandPalette onClose={onClose} />)
    await userEvent.type(screen.getAllByPlaceholderText(/Search actions/).at(-1)!, 'translate azure{Enter}')
    expect(S().doc).toBe(before)
    expect(S().toasts.at(-1)).toMatchObject({ text: 'Already on Azure', kind: 'warn' })
  })
  it('drives the camera', async () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    const go = async (q: string) => {
      const onClose = vi.fn<(...args: any[]) => void>()
      const r = render(<CommandPalette onClose={onClose} />)
      await user.type(screen.getByPlaceholderText(/Search actions/), q + '{Enter}')
      r.unmount()
      vi.advanceTimersByTime(1000)
    }
    resetStore({ doc: doc() })
    await go('top view')
    expect(S()).toMatchObject({ pitch: 90, flat: true })
    await go('home view')
    expect(S().flat).toBe(false)
    expect(S().yaw).toBeCloseTo(45)
    await go('turn view left')
    expect(S().yaw).toBeCloseTo(90)
    await go('turn view right')
    expect(S().yaw).toBeCloseTo(45)
    await go('front view')
    expect(S().yaw).toBeCloseTo(0)
    expect(S().pitch).toBeCloseTo(22)
    await go('switch to plan')
    expect(S().flat).toBe(true)
    await go('zoom to fit')
    expect(Number.isFinite(S().view.k)).toBe(true)
  })
  it('jumps to a component on the canvas', async () => {
    await run('orders', { panel: 'budget' })
    expect(S().selection).toEqual(['b'])
    expect(S().panel).toBe('inspect')
  })
  it('adds a component, preferring the cloud the library is on', async () => {
    await run('faas', { provider: 'gcp' })
    const added = S().doc.nodes.at(-1)!
    expect(providerOf(added.type)).toBe('gcp')
    expect(S().selection).toEqual([added.id])
    expect(S().past).toHaveLength(1)
  })
  it('shows what kind of thing each result is', async () => {
    open()
    await userEvent.type(input(), 'orders')
    const row = document.querySelector('.cmdk-item')!
    expect(row.querySelector('.cmdk-ico svg')).not.toBeNull()
    expect(row).toHaveTextContent('RDS / Aurora')
    await userEvent.clear(input())
    await userEvent.type(input(), 'export')
    expect(document.querySelector('.cmdk-item kbd')).toHaveTextContent('Ctrl+E')
    expect(document.querySelector('.cmdk-item .cmdk-ico.dot')).not.toBeNull()
  })
})
