// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cam } from '../canvas/camera'
import { costOf, money } from '../core/catalog'
import { inArea } from '../core/layout'
import { useStore } from '../core/store'
import type { AreaT, LabelT } from '../core/types'
import { docOf, edge, node, resetStore } from '../test/helpers'
import { GestureGuide, MobileDock, ViewFabs } from './MobileDock'

const S = () => useStore.getState()
const area = (id: string, x: number, y: number, w: number, d: number, name = 'Public subnet'): AreaT => ({ id, x, y, w, d, name, color: '#3DB87F', kind: 'subnet' })
const label = (id: string, text: string): LabelT => ({ id, x: 0, y: 0, text, size: 20, dir: 'x' })
const DOC = () => docOf(
  [node('a', 'ec2', 0, 0, { name: 'web' }), node('b', 'rds', 8, 0, { name: 'db' }), node('u', 'users', -6, 0)],
  [edge('e', 'a', 'b')],
  { areas: [area('z', -30, -30, 3, 3)], labels: [label('l', 'Edge tier\nsecond line')] },
)
const mount = (state: object = {}) => { resetStore({ doc: DOC(), ...state }); return render(<MobileDock />) }
const tap = (name: string | RegExp) => fireEvent.click(screen.getByRole('button', { name }))
const buttons = (nav: HTMLElement) => within(nav).getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent)

beforeEach(() => {
  vi.useFakeTimers()
  Object.assign(cam, { w: 390, h: 844, left: 0, top: 0 })
})
afterEach(() => { vi.runOnlyPendingTimers(); vi.useRealTimers() })

describe('dock with nothing selected', () => {
  it('offers the tools, with Add in the middle', () => {
    mount()
    expect(buttons(screen.getByRole('navigation', { name: 'Tools' }))).toEqual(['Connect', 'Area', 'Add', 'Text', 'Menu'])
    expect(screen.getByRole('button', { name: 'Add' })).toHaveClass('primary')
  })
  it('Add opens the library, and puts the inspector away if it was up', () => {
    mount({ showInsp: true, showLib: false })
    tap('Add')
    expect(S()).toMatchObject({ showLib: true, showInsp: false })
  })
  it('each tool button takes up its tool and drops any component being placed', () => {
    mount({ placing: 'ec2' })
    tap('Connect')
    expect(S()).toMatchObject({ tool: 'connect', placing: null })
    act(() => S().set({ tool: 'select', placing: 's3' }))
    tap('Area')
    expect(S()).toMatchObject({ tool: 'area', placing: null })
    act(() => S().set({ tool: 'select' }))
    tap('Text')
    expect(S().tool).toBe('text')
  })
  it('Menu opens the command palette, where everything else lives', () => {
    mount()
    tap('Menu')
    expect(S().modal).toBe('command')
  })
  it('gives a tick under the finger where the device can', () => {
    const vibrate = vi.fn<(ms: number) => boolean>()
    Object.defineProperty(navigator, 'vibrate', { value: vibrate, configurable: true })
    mount()
    tap('Menu')
    expect(vibrate).toHaveBeenCalledWith(4)
    delete (navigator as any).vibrate
  })
})

describe('dock while a tool is in use', () => {
  it.each([
    ['connect', 'Tap a component, then the one it talks to'],
    ['area', 'Drag across the ground to draw an area'],
    ['text', 'Tap where the label should go'],
    ['orbit', 'Drag to orbit the view'],
  ] as const)('says what the %s tool is waiting for', (tool, hint) => {
    mount({ tool })
    const nav = screen.getByRole('navigation', { name: 'Tool' })
    expect(within(nav).getByRole('status')).toHaveTextContent(hint)
    expect(screen.queryByRole('button', { name: 'Add' })).toBeNull()
  })
  it('names the component a connection is being drawn from', () => {
    mount({ tool: 'connect', linkFrom: 'a' })
    expect(screen.getByRole('status')).toHaveTextContent('Now tap what web connects to')
  })
  it('falls back to the general prompt if that component has gone', () => {
    mount({ tool: 'connect', linkFrom: 'ghost' })
    expect(screen.getByRole('status')).toHaveTextContent('Tap a component, then the one it talks to')
  })
  it('Cancel goes back to selecting and forgets the half-drawn connection', () => {
    mount({ tool: 'connect', linkFrom: 'a' })
    tap(/Cancel/)
    expect(S()).toMatchObject({ tool: 'select', linkFrom: null })
  })
  it('takes precedence over the selection', () => {
    mount({ tool: 'area', selection: ['a'] })
    expect(screen.getByRole('navigation', { name: 'Tool' })).toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: 'Selection' })).toBeNull()
  })
})

describe('dock with one component selected', () => {
  it('shows its name, its settings in brief and its price, with the actions that apply', () => {
    mount({ selection: ['a'] })
    const nav = screen.getByRole('navigation', { name: 'Selection' })
    expect(nav).toHaveTextContent('web')
    expect(nav).toHaveTextContent('m7g.large')
    expect(nav).toHaveTextContent(money(costOf(S().doc.nodes[0], 'us-east-1').monthly) + '/mo')
    expect(buttons(nav)).toEqual(['Deselect', 'Edit', 'Connect', 'Copy', 'More', 'Delete'])
  })
  it('shows the product name for a component with no settings, and no price when it is free', () => {
    mount({ selection: ['u'] })
    const nav = screen.getByRole('navigation', { name: 'Selection' })
    expect(nav).toHaveTextContent('Users')
    expect(nav).toHaveTextContent('Clients')
    expect(nav).not.toHaveTextContent('/mo')
  })
  it('never prints "undefined" for a component saved without all its settings', () => {
    const doc = DOC()
    doc.nodes[0] = { ...doc.nodes[0], props: {} }
    resetStore({ doc, selection: ['a'] })
    render(<MobileDock />)
    expect(screen.getByRole('navigation', { name: 'Selection' }).textContent).not.toMatch(/undefined|NaN/)
  })
  it('Edit opens the inspector on its first tab and closes the library', () => {
    mount({ selection: ['a'], showLib: true, panel: 'budget' })
    tap('Edit')
    expect(S()).toMatchObject({ showInsp: true, showLib: false, panel: 'inspect' })
  })
  it('Connect starts a connection from this component', () => {
    mount({ selection: ['a'] })
    tap('Connect')
    expect(S()).toMatchObject({ tool: 'connect', linkFrom: 'a' })
  })
  it('Copy makes a renumbered duplicate and selects it', () => {
    mount({ selection: ['a'] })
    tap('Copy')
    expect(S().doc.nodes).toHaveLength(4)
    expect(S().selection).toEqual([S().doc.nodes[3].id])
    expect(S().doc.nodes[3]).toMatchObject({ type: 'ec2', x: 2, y: 2 })
  })
  it('More turns on adding to the selection, Done turns it off', () => {
    mount({ selection: ['a'] })
    tap('More')
    expect(S().multi).toBe(true)
    const done = screen.getByRole('button', { name: 'Done' })
    expect(done).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(done)
    expect(S().multi).toBe(false)
    expect(screen.getByRole('button', { name: 'More' })).toBeInTheDocument()
  })
  it('Delete removes it with its connections, in one undo step, and leaves multi-select', () => {
    mount({ selection: ['a'], multi: true })
    tap('Delete')
    expect(S().doc.nodes.map((n) => n.id)).toEqual(['b', 'u'])
    expect(S().doc.edges).toEqual([])
    expect(S()).toMatchObject({ selection: [], multi: false })
    S().undo()
    expect(S().doc.nodes).toHaveLength(3)
    expect(S().doc.edges).toHaveLength(1)
  })
  it('Deselect clears the selection and returns to the tools', () => {
    mount({ selection: ['a'], multi: true })
    tap('Deselect')
    expect(S()).toMatchObject({ selection: [], multi: false })
    expect(screen.getByRole('navigation', { name: 'Tools' })).toBeInTheDocument()
  })
})

describe('dock with other things selected', () => {
  it('a connection can be edited, reversed or deleted, and nothing else', () => {
    mount({ selection: ['e'] })
    const nav = screen.getByRole('navigation', { name: 'Selection' })
    expect(nav).toHaveTextContent('Connection')
    expect(nav).toHaveTextContent('web connects to db') // what it joins, in words
    expect(buttons(nav)).toEqual(['Deselect', 'Edit', 'Follow', 'Bend', 'Reverse', 'Delete'])
    tap('Reverse')
    expect(S().doc.edges[0]).toMatchObject({ id: 'e', from: 'b', to: 'a' })
    S().undo()
    expect(S().doc.edges[0]).toMatchObject({ from: 'a', to: 'b' })
  })
  it('an area shows its name and size, and can be fitted to what is inside it', () => {
    const doc = DOC()
    doc.areas = [area('z', -1, -1, 30, 30)]
    resetStore({ doc, selection: ['z'] })
    render(<MobileDock />)
    const nav = screen.getByRole('navigation', { name: 'Selection' })
    expect(nav).toHaveTextContent('Public subnet')
    expect(nav).toHaveTextContent('Area · 30 × 30')
    expect(buttons(nav)).toEqual(['Deselect', 'Edit', 'Fit', 'Copy', 'Delete'])
    tap('Fit')
    const z = S().doc.areas[0]
    expect(z.w).toBeLessThan(30)
    // it wraps the two components that were inside it; the one outside stays outside
    expect(S().doc.nodes.map((n) => inArea(z, n))).toEqual([true, true, false])
  })
  it('a text label is named by its first line', () => {
    mount({ selection: ['l'] })
    const nav = screen.getByRole('navigation', { name: 'Selection' })
    expect(nav).toHaveTextContent('Edge tier')
    expect(nav).not.toHaveTextContent('second line')
    expect(nav).toHaveTextContent('Text label')
    expect(buttons(nav)).toEqual(['Deselect', 'Edit', 'Copy', 'Delete'])
    tap('Copy')
    expect(S().doc.labels).toHaveLength(2)
  })
  it('several components show a count and a total, and can be grouped', () => {
    mount({ selection: ['a', 'b'] })
    const nav = screen.getByRole('navigation', { name: 'Selection' })
    expect(nav).toHaveTextContent('2 selected')
    expect(nav).toHaveTextContent('2 components')
    const total = S().doc.nodes.slice(0, 2).reduce((t, n) => t + costOf(n, 'us-east-1').monthly, 0)
    expect(nav).toHaveTextContent(money(total) + '/mo')
    expect(buttons(nav)).toEqual(['Deselect', 'Edit', 'Group', 'Copy', 'More', 'Delete'])
    tap('Group')
    expect(S().doc.areas).toHaveLength(2)
    expect(S().doc.areas[1]).toMatchObject({ kind: 'group', name: 'Group' })
  })
  it('a mixed selection is summarised by kind and deleted together', () => {
    mount({ selection: ['a', 'z', 'l', 'e'] })
    const nav = screen.getByRole('navigation', { name: 'Selection' })
    expect(nav).toHaveTextContent('4 selected')
    expect(nav).toHaveTextContent('1 components · 1 areas · 1 labels · 1 connections')
    // a connection in the selection cannot be duplicated on its own, so Copy is not offered
    expect(buttons(nav)).toEqual(['Deselect', 'Edit', 'More', 'Delete'])
    tap('Delete')
    expect(S().doc).toMatchObject({ areas: [], labels: [], edges: [] })
    expect(S().doc.nodes.map((n) => n.id)).toEqual(['b', 'u'])
  })
  it('ignores ids in the selection that no longer exist', () => {
    mount({ selection: ['gone'] })
    expect(screen.getByRole('navigation', { name: 'Tools' })).toBeInTheDocument()
  })
  it('follows the pricing model', () => {
    mount({ selection: ['a'], pricing: 'commit3' })
    expect(screen.getByRole('navigation', { name: 'Selection' })).toHaveTextContent(money(costOf(S().doc.nodes[0], 'us-east-1', 'commit3').monthly))
  })
})

describe('ViewFabs', () => {
  it('flips between the 3D and plan views', () => {
    resetStore({ doc: DOC() })
    const { rerender } = render(<ViewFabs />)
    fireEvent.click(screen.getByRole('button', { name: 'Switch to plan view' }))
    vi.advanceTimersByTime(1500)
    expect(S().flat).toBe(true)
    expect(S().pitch).toBe(90)
    rerender(<ViewFabs />)
    fireEvent.click(screen.getByRole('button', { name: 'Switch to 3D view' }))
    vi.advanceTimersByTime(1500)
    expect(S().flat).toBe(false)
  })
  it('frames the whole blueprint', () => {
    resetStore({ doc: DOC(), view: { x: 5000, y: 5000, k: 3 } })
    render(<ViewFabs />)
    fireEvent.click(screen.getByRole('button', { name: 'Fit to screen' }))
    vi.advanceTimersByTime(1500)
    const v = S().view
    expect(v.k).toBeLessThan(3)
    expect(Math.abs(v.x)).toBeLessThan(2000)
  })
  it('offers a way home only once the camera has been turned or tilted, and takes it', () => {
    resetStore({ doc: DOC() })
    render(<ViewFabs />)
    expect(screen.queryByRole('button', { name: 'Reset view' })).toBeNull()
    act(() => S().set({ yaw: 130, pitch: 20 }))
    fireEvent.click(screen.getByRole('button', { name: 'Reset view' }))
    act(() => { vi.advanceTimersByTime(2500) })
    expect(S().yaw).toBe(45)
    expect(S().pitch).toBeCloseTo(35.26, 1)
    expect(screen.queryByRole('button', { name: 'Reset view' })).toBeNull()
  })
  it('a square-on plan view is not "turned", a skewed one is', () => {
    resetStore({ doc: DOC(), yaw: 90, pitch: 90, flat: true })
    render(<ViewFabs />)
    expect(screen.queryByRole('button', { name: 'Reset view' })).toBeNull()
    act(() => S().set({ yaw: 120 }))
    expect(screen.getByRole('button', { name: 'Reset view' })).toBeInTheDocument()
  })
  it('offers the way back when the diagram has slid out of sight, once the view has come to rest', () => {
    resetStore({ doc: DOC() })
    render(<ViewFabs />)
    act(() => { vi.advanceTimersByTime(300) })
    expect(screen.queryByRole('button', { name: 'Back to diagram' })).toBeNull()
    act(() => S().set({ view: { x: 9000, y: 9000, k: 1 } }))
    expect(screen.queryByRole('button', { name: 'Back to diagram' })).toBeNull() // still moving, for all it knows
    act(() => { vi.advanceTimersByTime(300) })
    fireEvent.click(screen.getByRole('button', { name: 'Back to diagram' }))
    act(() => { vi.advanceTimersByTime(1000) })
    expect(Math.abs(S().view.x)).toBeLessThan(2000)
    act(() => { vi.advanceTimersByTime(300) })
    expect(screen.queryByRole('button', { name: 'Back to diagram' })).toBeNull()
  })
  it('with something selected, offers to add the next component without deselecting first', () => {
    resetStore({ doc: DOC(), showInsp: true })
    render(<ViewFabs />)
    expect(screen.queryByRole('button', { name: 'Add another component' })).toBeNull()
    act(() => S().select(['a']))
    fireEvent.click(screen.getByRole('button', { name: 'Add another component' }))
    expect(S()).toMatchObject({ showLib: true, showInsp: false })
    expect(S().selection).toEqual(['a'])
    // not while a tool is in use: the dock is showing its prompt then
    act(() => S().set({ tool: 'connect' }))
    expect(screen.queryByRole('button', { name: 'Add another component' })).toBeNull()
  })
  it('an empty blueprint is never lost', () => {
    resetStore({ doc: docOf([]), view: { x: 9000, y: 9000, k: 1 } })
    render(<ViewFabs />)
    act(() => { vi.advanceTimersByTime(300) })
    expect(screen.queryByRole('button', { name: 'Back to diagram' })).toBeNull()
  })
})

describe('GestureGuide', () => {
  it('names the four camera gestures and the cube, and closes', () => {
    const onClose = vi.fn<() => void>()
    render(<GestureGuide onClose={onClose} />)
    const guide = screen.getByRole('dialog', { name: 'Getting around' })
    for (const name of ['Move', 'Zoom', 'Turn', 'Tilt']) expect(within(guide).getByText(name)).toBeInTheDocument()
    expect(within(guide).getByText(/Drag the cube/)).toBeInTheDocument()
    fireEvent.click(within(guide).getByRole('button', { name: 'Got it' }))
    expect(onClose).toHaveBeenCalled()
  })
})
