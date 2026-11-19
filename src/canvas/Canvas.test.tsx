// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { costOf, money } from '../core/catalog'
import { ISO_YAW, pt } from '../core/iso'
import { useStore } from '../core/store'
import { MAX_SCALE, MIN_SCALE } from '../core/types'
import { docOf, edge, node, resetStore } from '../test/helpers'
import { Canvas, heat } from './Canvas'
import { cam, hud, projNow } from './camera'

// these render whole screens; leave headroom for a busy machine
vi.setConfig({ testTimeout: 20_000 })

const S = () => useStore.getState()
const svg = () => document.querySelector('.canvas-svg') as SVGSVGElement
const hit = (kind: string, id: string) => document.querySelector(`[data-kind="${kind}"][data-id="${id}"]`)!
/** viewport position of a ground point under the current camera */
const at = (wx: number, wy: number) => {
  const q = pt(projNow(), wx, wy), v = S().view
  return { clientX: q[0] * v.k + v.x, clientY: q[1] * v.k + v.y }
}
const down = (el: Element, wx: number, wy: number, o: object = {}) => fireEvent.pointerDown(el, { pointerId: 1, button: 0, ...at(wx, wy), ...o })
const move = (wx: number, wy: number, o: object = {}) => fireEvent.pointerMove(svg(), { pointerId: 1, ...at(wx, wy), ...o })
const up = (wx: number, wy: number, o: object = {}) => fireEvent.pointerUp(svg(), { pointerId: 1, ...at(wx, wy), ...o })
const drag = (el: Element, from: [number, number], to: [number, number], o: object = {}) => { down(el, ...from, o); move(...to, o); up(...to, o) }

const handles = (prefix: string) => [...document.querySelectorAll('[data-handle]')].filter((h) => new RegExp(`^${prefix}\\d$`).test(h.getAttribute('data-handle')!))
const area = (id: string, x: number, y: number, w: number, d: number) => ({ id, x, y, w, d, name: id, color: '#8F6FF2', kind: 'vpc' as const })
const label = (id: string, x: number, y: number) => ({ id, x, y, text: 'Note', size: 20, dir: 'x' as const })

function mount(doc = docOf([node('a', 'ec2', 0, 0, { name: 'web' }), node('b', 'rds', 8, 0, { name: 'db' })]), state: object = {}) {
  resetStore({ doc, ...state })
  const r = render(<Canvas />)
  act(() => { useStore.setState({ view: { x: 600, y: 300, k: 1 } }) })
  return r
}

beforeEach(() => {
  // jsdom lays nothing out: give the canvas a real box at the page origin
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const box = this.classList?.contains('canvas-svg') ? { left: 0, top: 0, right: 1200, bottom: 800, width: 1200, height: 800 } : { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }
    return { ...box, x: box.left, y: box.top, toJSON() {} } as DOMRect
  })
  vi.spyOn(document, 'elementFromPoint').mockImplementation(() => svg())
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('empty canvas', () => {
  it('explains how to start, until there is something on it', () => {
    mount(docOf())
    expect(screen.getByText('An empty plane.')).toBeInTheDocument()
    act(() => { S().addNode('ec2', 0, 0) })
    expect(screen.queryByText('An empty plane.')).toBeNull()
  })
  it('hides the hint while a component is being placed', () => {
    mount(docOf(), { placing: 'ec2' })
    expect(screen.queryByText('An empty plane.')).toBeNull()
  })
  it('draws the grid only when it is on, fading it out when zoomed far away', () => {
    mount(docOf())
    expect(document.querySelector('rect[fill="url(#grid)"]')).toHaveAttribute('opacity', '1')
    act(() => { useStore.setState({ view: { x: 0, y: 0, k: 0.475 } }) })
    expect(document.querySelector('rect[fill="url(#grid)"]')).toHaveAttribute('opacity', '0.5')
    // fully faded, the fine dots are left out altogether rather than painted invisibly; the coarse ones stay
    act(() => { useStore.setState({ view: { x: 0, y: 0, k: 0.2 } }) })
    expect(document.querySelector('rect[fill="url(#grid)"]')).toBeNull()
    expect(document.querySelector('rect[fill="url(#grid-major)"]')).not.toBeNull()
    act(() => { useStore.setState({ showGrid: false }) })
    expect(document.querySelector('rect[fill="url(#grid-major)"]')).toBeNull()
  })
  it('puts one whole dot on every grid point', () => {
    mount(docOf())
    // each tile is shifted half its size, so its single centred dot lands on a multiple of the cell size
    for (const [id, size] of [['grid', 40], ['grid-major', 160]] as const) {
      const p = document.querySelector('pattern#' + id)!
      expect(p.querySelectorAll('circle')).toHaveLength(1)
      expect(Number(p.getAttribute('x')) + Number(p.querySelector('circle')!.getAttribute('cx'))).toBe(0)
      expect(Number(p.getAttribute('y')) + Number(p.querySelector('circle')!.getAttribute('cy'))).toBe(0)
      expect(Number(p.getAttribute('width'))).toBe(size)
    }
  })
})

describe('selecting', () => {
  it('selects on click, replaces on another click and clears on empty ground', () => {
    mount()
    drag(hit('node', 'a'), [1, 1], [1, 1])
    expect(S().selection).toEqual(['a'])
    expect(document.querySelectorAll('.sel-mark')).toHaveLength(1)
    drag(hit('node', 'b'), [9, 1], [9, 1])
    expect(S().selection).toEqual(['b'])
    drag(svg(), [20, 20], [20, 20])
    expect(S().selection).toEqual([])
    expect(S().past).toHaveLength(0) // clicking never creates undo steps
  })
  it('adds and removes with Shift', () => {
    mount()
    drag(hit('node', 'a'), [1, 1], [1, 1])
    drag(hit('node', 'b'), [9, 1], [9, 1], { shiftKey: true })
    expect(S().selection).toEqual(['a', 'b'])
    drag(hit('node', 'a'), [1, 1], [1, 1], { shiftKey: true })
    expect(S().selection).toEqual(['b'])
  })
  it('selects a connection without starting a move', () => {
    mount(docOf([node('a'), node('b', 'ec2', 8, 0)], [edge('e', 'a', 'b')]))
    drag(hit('edge', 'e'), [4, 1], [6, 3])
    expect(S().selection).toEqual(['e'])
    expect(S().past).toHaveLength(0)
    expect(document.querySelector('.overlay path[filter]')).not.toBeNull() // highlighted
  })
  it('selects everything inside a Shift-drag rectangle', () => {
    mount(docOf([node('a', 'ec2', 0, 0), node('b', 'ec2', 30, 30)], [], { areas: [area('in', -1, -1, 4, 4), area('big', -40, -40, 80, 80)], labels: [label('l', 1, 1), label('far', 30, 30)] }))
    const a = at(-3, -3), b = at(4, 4)
    fireEvent.pointerDown(svg(), { pointerId: 1, button: 0, shiftKey: true, clientX: a.clientX - 150, clientY: a.clientY })
    fireEvent.pointerMove(svg(), { pointerId: 1, clientX: b.clientX + 150, clientY: b.clientY })
    expect(svg().querySelector(':scope > rect[rx="3"]')).not.toBeNull()
    fireEvent.pointerUp(svg(), { pointerId: 1, clientX: b.clientX + 150, clientY: b.clientY })
    expect(S().selection.sort()).toEqual(['a', 'in', 'l'])
    expect(svg().querySelector(':scope > rect[rx="3"]')).toBeNull()
  })
  it('ignores a Shift-click that never became a rectangle', () => {
    mount(undefined, { selection: ['a'] })
    drag(svg(), [20, 20], [20, 20], { shiftKey: true })
    expect(S().selection).toEqual(['a'])
  })
  it('outlines selected areas and labels', () => {
    mount(docOf([], [], { areas: [area('r', 0, 0, 4, 4)], labels: [label('lx', 0, 0), { ...label('ly', 5, 5), dir: 'y', text: 'two\nlines' }] }), { selection: ['r'] })
    expect(handles('r')).toHaveLength(4)
    act(() => { S().select(['r', 'lx', 'ly']) })
    expect(handles('r')).toHaveLength(0) // handles only for a single selection
    expect(document.querySelectorAll('.overlay > polygon')).toHaveLength(2)
  })
})

describe('moving', () => {
  it('drags a component on the grid as one undo step', () => {
    mount()
    down(hit('node', 'a'), 1, 1)
    move(1.02, 1.02)
    expect(S().past).toHaveLength(0) // a twitch is not a drag
    move(4.4, 1)
    expect(S().doc.nodes[0]).toMatchObject({ x: 3, y: 0 })
    expect(document.querySelector('.canvas-wrap')).toHaveClass('busy')
    move(6.6, 3.4)
    up(6.6, 3.4)
    expect(S().doc.nodes[0]).toMatchObject({ x: 6, y: 2 })
    expect(S().doc.nodes[1]).toMatchObject({ x: 8, y: 0 })
    expect(S().past).toHaveLength(1)
    expect(document.querySelector('.canvas-wrap')).not.toHaveClass('busy')
    act(() => S().undo())
    expect(S().doc.nodes[0]).toMatchObject({ x: 0, y: 0 })
  })
  it('moves the whole selection together', () => {
    mount(undefined, { selection: ['a', 'b'] })
    drag(hit('node', 'a'), [1, 1], [3, 4])
    expect(S().doc.nodes.map((n) => [n.x, n.y])).toEqual([[2, 3], [10, 3]])
  })
  it('clones with Alt and moves the copies', () => {
    mount()
    drag(hit('node', 'a'), [1, 1], [1, 6], { altKey: true })
    const nodes = S().doc.nodes
    expect(nodes).toHaveLength(3)
    expect(nodes[0]).toMatchObject({ id: 'a', x: 0, y: 0 })
    expect(nodes[2]).toMatchObject({ type: 'ec2', x: 0, y: 5 })
    expect(S().selection).toEqual([nodes[2].id])
    act(() => S().undo())
    expect(S().doc.nodes).toHaveLength(2)
  })
  it('moves labels in half cells', () => {
    mount(docOf([], [], { labels: [label('l', 0, 0)] }))
    drag(hit('label', 'l'), [0, 0], [1.6, 0.3])
    expect(S().doc.labels[0]).toMatchObject({ x: 1.5, y: 0.5 })
  })
  it('carries what sits inside an area', () => {
    mount(docOf([node('in', 'ec2', 1, 1), node('out', 'ec2', 20, 20)], [], { areas: [area('r', 0, 0, 6, 6)] }))
    drag(hit('area', 'r'), [0, 3], [2, 6])
    expect(S().doc.areas[0]).toMatchObject({ x: 2, y: 3 })
    expect(S().doc.nodes[0]).toMatchObject({ x: 3, y: 4 })
    expect(S().doc.nodes[1]).toMatchObject({ x: 20, y: 20 })
  })
  it('ends a drag cleanly when the pointer is cancelled', () => {
    mount()
    down(hit('node', 'a'), 1, 1)
    move(5, 1)
    fireEvent.pointerCancel(svg(), { pointerId: 1 })
    expect(document.querySelector('.canvas-wrap')).not.toHaveClass('busy')
    move(9, 9)
    expect(S().doc.nodes[0]).toMatchObject({ x: 4, y: 0 })
  })
})

describe('resizing', () => {
  it('shows four corner handles for a single selected component', () => {
    mount(undefined, { selection: ['a'] })
    expect(handles('n')).toHaveLength(4)
    expect(document.querySelector('[data-handle="connect"]')).not.toBeNull()
    act(() => S().select(['a', 'b']))
    expect(document.querySelectorAll('[data-handle]')).toHaveLength(0)
    act(() => { S().select(['a']); S().set({ tool: 'connect' }) })
    expect(document.querySelectorAll('[data-handle]')).toHaveLength(0)
  })
  it('points each handle cursor along the way that corner moves on screen', () => {
    mount(undefined, { selection: ['a'] })
    const cur = (i: number) => (document.querySelector(`[data-handle="n${i}"]`) as SVGElement).style.cursor
    // home view: corners 0 and 2 are the top and bottom of the diamond, 1 and 3 its sides
    expect([cur(0), cur(1), cur(2), cur(3)]).toEqual(['ns-resize', 'ew-resize', 'ns-resize', 'ew-resize'])
    act(() => { useStore.setState({ yaw: 0, pitch: 90 }) })
    expect([cur(0), cur(1), cur(2), cur(3)]).toEqual(['nwse-resize', 'nesw-resize', 'nwse-resize', 'nesw-resize'])
  })
  it('grows from the far corner in half cells, as one undo step', () => {
    mount(undefined, { selection: ['a'] })
    down(document.querySelector('[data-handle="n2"]')!, 2, 2)
    move(3.1, 2.6)
    expect(S().doc.nodes[0]).toMatchObject({ x: 0, y: 0, scale: 1.5 })
    move(4.2, 4.2)
    up(4.2, 4.2)
    expect(S().doc.nodes[0]).toMatchObject({ x: 0, y: 0, scale: 2 })
    expect(S().past).toHaveLength(1)
  })
  it('pins the opposite corner when dragging the near one', () => {
    mount(undefined, { selection: ['a'] })
    drag(document.querySelector('[data-handle="n0"]')!, [0, 0], [-2, -1])
    expect(S().doc.nodes[0]).toMatchObject({ x: -2, y: -2, scale: 2 })
    drag(document.querySelector('[data-handle="n1"]')!, [2, -2], [1, -1])
    expect(S().doc.nodes[0]).toMatchObject({ x: -2, y: -1, scale: 1.5 })
    drag(document.querySelector('[data-handle="n3"]')!, [-2, 2], [-1, 1])
    expect(S().doc.nodes[0]).toMatchObject({ x: -1, y: -1, scale: 1 })
  })
  it('stops at the smallest and largest sizes', () => {
    mount(undefined, { selection: ['a'] })
    drag(document.querySelector('[data-handle="n2"]')!, [2, 2], [50, 50])
    expect(S().doc.nodes[0].scale).toBe(MAX_SCALE)
    drag(document.querySelector('[data-handle="n2"]')!, [6, 6], [-30, -30])
    expect(S().doc.nodes[0]).toMatchObject({ x: 0, y: 0, scale: MIN_SCALE })
  })
  it('resizes an area from any corner, never below one cell', () => {
    mount(docOf([], [], { areas: [area('r', 0, 0, 6, 4)] }), { selection: ['r'] })
    const h = (i: number) => document.querySelector(`[data-handle="r${i}"]`)!
    drag(h(2), [6, 4], [9.2, 7.3])
    expect(S().doc.areas[0]).toMatchObject({ x: 0, y: 0, w: 9, d: 7.5 })
    drag(h(0), [0, 0], [-2, -1])
    expect(S().doc.areas[0]).toMatchObject({ x: -2, y: -1, w: 11, d: 8.5 })
    drag(h(1), [9, -1], [5, 1])
    expect(S().doc.areas[0]).toMatchObject({ x: -2, y: 1, w: 7, d: 6.5 })
    drag(h(3), [-2, 7.5], [0, 5])
    expect(S().doc.areas[0]).toMatchObject({ x: 0, y: 1, w: 5, d: 4 })
    drag(h(2), [5, 5], [-50, -50])
    expect(S().doc.areas[0]).toMatchObject({ x: 0, y: 1, w: 1, d: 1 })
    drag(h(0), [0, 1], [50, 50])
    expect(S().doc.areas[0]).toMatchObject({ x: 0, y: 1, w: 1, d: 1 })
    expect(S().past).toHaveLength(6)
  })
})

describe('tools', () => {
  it('draws areas: the first is a VPC, later ones subnets, then returns to Select', () => {
    mount(undefined, { tool: 'area', panel: 'budget' })
    expect(svg().style.cursor).toBe('crosshair')
    down(svg(), -2.2, -2.1)
    move(5.3, 3.8)
    expect(document.querySelector('.overlay polygon')).not.toBeNull()
    up(5.3, 3.8)
    expect(S().doc.areas).toHaveLength(1)
    expect(S().doc.areas[0]).toMatchObject({ x: -2, y: -2, w: 7, d: 6, kind: 'vpc', name: 'VPC' })
    expect(S()).toMatchObject({ tool: 'select', panel: 'inspect', selection: [S().doc.areas[0].id] })
    act(() => S().set({ tool: 'area' }))
    drag(svg(), [3, 3], [0, 0]) // drawn backwards
    expect(S().doc.areas[1]).toMatchObject({ x: 0, y: 0, w: 3, d: 3, kind: 'subnet', name: 'Subnet 1' })
  })
  it('creates the area even when the drag ends before the next paint', () => {
    mount(undefined, { tool: 'area' })
    act(() => { down(svg(), 0, 0); move(4, 4); up(4, 4) })
    expect(S().doc.areas).toHaveLength(1)
  })
  it('ignores an area smaller than a cell and stays on the tool', () => {
    mount(undefined, { tool: 'area' })
    drag(svg(), [0, 0], [0.3, 4])
    expect(S().doc.areas).toHaveLength(0)
    expect(S().tool).toBe('area')
    drag(svg(), [0, 0], [0, 0])
    expect(S().doc.areas).toHaveLength(0)
  })
  it('drops a label where clicked and asks for its text to be focused', () => {
    mount(undefined, { tool: 'text' })
    expect(svg().style.cursor).toBe('text')
    const before = S().focusName
    drag(svg(), [3.2, -1.3], [3.2, -1.3])
    expect(S().doc.labels).toHaveLength(1)
    expect(S().doc.labels[0]).toMatchObject({ x: 3, y: -1.5, text: 'Label' })
    expect(S()).toMatchObject({ tool: 'select', panel: 'inspect', focusName: before + 1 })
    expect(S().selection).toEqual([S().doc.labels[0].id])
  })
  it('connects two components with the Connect tool, and says so when they already are', () => {
    mount(undefined, { tool: 'connect' })
    down(hit('node', 'a'), 1, 1)
    vi.mocked(document.elementFromPoint).mockReturnValue(svg())
    move(4, 1)
    expect(document.querySelector('.wire')).not.toBeNull()
    vi.mocked(document.elementFromPoint).mockReturnValue(hit('node', 'b'))
    move(9, 1)
    expect(document.querySelector('.wire')!.getAttribute('d')).toContain('L') // snapped to a routed path
    up(9, 1)
    expect(S().doc.edges).toHaveLength(1)
    expect(S().doc.edges[0]).toMatchObject({ from: 'a', to: 'b', arrow: 'end', style: 'solid' })
    expect(S().selection).toEqual([S().doc.edges[0].id])
    expect(document.querySelector('.wire')).toBeNull()
    // the other way round is the same pair
    down(hit('node', 'b'), 9, 1)
    vi.mocked(document.elementFromPoint).mockReturnValue(hit('node', 'a'))
    up(1, 1)
    expect(S().doc.edges).toHaveLength(1)
    expect(S().toasts.at(-1)).toMatchObject({ text: 'Those components are already connected', kind: 'warn' })
  })
  it('does not connect a component to itself or to nothing', () => {
    mount(undefined, { tool: 'connect' })
    down(hit('node', 'a'), 1, 1)
    vi.mocked(document.elementFromPoint).mockReturnValue(hit('node', 'a'))
    move(1.5, 1.5)
    up(1.5, 1.5)
    down(hit('node', 'a'), 1, 1)
    vi.mocked(document.elementFromPoint).mockReturnValue(svg())
    up(20, 20)
    expect(S().doc.edges).toHaveLength(0)
    expect(S().toasts).toHaveLength(0)
  })
  it('pans when the Connect tool is dragged on empty ground', () => {
    mount(undefined, { tool: 'connect' })
    fireEvent.pointerDown(svg(), { pointerId: 1, button: 0, clientX: 100, clientY: 100 })
    fireEvent.pointerMove(svg(), { pointerId: 1, clientX: 160, clientY: 130 })
    fireEvent.pointerUp(svg(), { pointerId: 1, clientX: 160, clientY: 130 })
    expect(S().view).toMatchObject({ x: 660, y: 330 })
  })
  it('connects from the handle beside a selected component', () => {
    mount(undefined, { selection: ['a'] })
    down(document.querySelector('[data-handle="connect"] circle')!, 3, 1)
    vi.mocked(document.elementFromPoint).mockReturnValue(hit('node', 'b'))
    move(9, 1)
    up(9, 1)
    expect(S().doc.edges[0]).toMatchObject({ from: 'a', to: 'b' })
  })
  it('orbits with the Orbit tool, a right-drag, or Alt on empty ground', () => {
    mount(undefined, { tool: 'orbit' })
    expect(svg().style.cursor).toBe('move')
    fireEvent.pointerDown(hit('node', 'a'), { pointerId: 1, button: 0, clientX: 400, clientY: 300 })
    fireEvent.pointerMove(svg(), { pointerId: 1, clientX: 402, clientY: 300 })
    expect(S().yaw).toBe(ISO_YAW) // under the drag threshold
    fireEvent.pointerMove(svg(), { pointerId: 1, clientX: 500, clientY: 300 })
    expect(S().yaw).toBeLessThan(ISO_YAW)
    fireEvent.pointerUp(svg(), { pointerId: 1, clientX: 500, clientY: 300 })
    expect(S().selection).toEqual([])

    act(() => S().set({ tool: 'select' }))
    const yaw = S().yaw
    fireEvent.pointerDown(svg(), { pointerId: 1, button: 2, clientX: 400, clientY: 300 })
    fireEvent.pointerMove(svg(), { pointerId: 1, clientX: 300, clientY: 340 })
    fireEvent.pointerUp(svg(), { pointerId: 1, button: 2, clientX: 300, clientY: 340 })
    expect(S().yaw).toBeGreaterThan(yaw)
    expect(document.querySelector('.ctx-menu')).toBeNull() // a drag is not a menu request

    const yaw2 = S().yaw
    fireEvent.pointerDown(svg(), { pointerId: 1, button: 0, altKey: true, clientX: 400, clientY: 300 })
    fireEvent.pointerMove(svg(), { pointerId: 1, clientX: 450, clientY: 300 })
    fireEvent.pointerUp(svg(), { pointerId: 1, clientX: 450, clientY: 300 })
    expect(S().yaw).toBeLessThan(yaw2)
  })
})

describe('panning and zooming', () => {
  it('pans by dragging empty ground and keeps the selection', () => {
    mount(undefined, { selection: ['a'] })
    fireEvent.pointerDown(svg(), { pointerId: 1, button: 0, clientX: 100, clientY: 100 })
    fireEvent.pointerMove(svg(), { pointerId: 1, clientX: 102, clientY: 101 })
    expect(S().view).toMatchObject({ x: 600, y: 300 })
    fireEvent.pointerMove(svg(), { pointerId: 1, clientX: 60, clientY: 140 })
    expect(svg().style.cursor).toBe('grabbing')
    fireEvent.pointerUp(svg(), { pointerId: 1, clientX: 60, clientY: 140 })
    expect(S().view).toMatchObject({ x: 560, y: 340, k: 1 })
    expect(S().selection).toEqual(['a'])
    expect(svg().style.cursor).toBe('default')
  })
  it('pans with the middle button even over a component', () => {
    mount()
    fireEvent.pointerDown(hit('node', 'a'), { pointerId: 1, button: 1, clientX: 100, clientY: 100 })
    fireEvent.pointerMove(svg(), { pointerId: 1, clientX: 110, clientY: 100 })
    fireEvent.pointerUp(svg(), { pointerId: 1, clientX: 110, clientY: 100 })
    expect(S().view.x).toBe(610)
    expect(S().doc.nodes[0].x).toBe(0)
    expect(S().selection).toEqual([])
  })
  it('pans while Space is held, but not while typing in a field', () => {
    mount()
    fireEvent.keyDown(window, { code: 'Space', key: ' ' })
    expect(svg().style.cursor).toBe('grabbing')
    fireEvent.pointerDown(hit('node', 'a'), { pointerId: 1, button: 0, clientX: 100, clientY: 100 })
    fireEvent.pointerMove(svg(), { pointerId: 1, clientX: 130, clientY: 90 })
    fireEvent.pointerUp(svg(), { pointerId: 1, clientX: 130, clientY: 90 })
    expect(S().view).toMatchObject({ x: 630, y: 290 })
    expect(svg().style.cursor).toBe('grabbing') // still held
    fireEvent.keyUp(window, { code: 'Space', key: ' ' })
    expect(svg().style.cursor).toBe('default')
    const input = document.body.appendChild(document.createElement('input'))
    fireEvent.keyDown(input, { code: 'Space', key: ' ' })
    expect(svg().style.cursor).toBe('default')
    input.remove()
  })
  it('scrolls with a trackpad and zooms with pinch about the cursor', () => {
    mount()
    fireEvent.wheel(svg(), { deltaX: 30, deltaY: 12.5 })
    expect(S().view).toMatchObject({ x: 570, y: 287.5, k: 1 })
    const before = (200 - S().view.x) / S().view.k
    fireEvent.wheel(svg(), { deltaY: -12.5, ctrlKey: true, clientX: 200, clientY: 150 })
    expect(S().view.k).toBeCloseTo(Math.exp(0.15))
    expect((200 - S().view.x) / S().view.k).toBeCloseTo(before)
  })
  it('eases a mouse wheel notch towards the cursor', async () => {
    mount()
    fireEvent.wheel(svg(), { deltaY: -100, clientX: 600, clientY: 300 })
    await waitFor(() => expect(S().view.k).toBeCloseTo(Math.exp(0.22), 3), { timeout: 3000 })
    fireEvent.wheel(svg(), { deltaY: 3, deltaMode: 1, clientX: 600, clientY: 300 }) // line-based wheels
    await waitFor(() => expect(S().view.k).toBeCloseTo(Math.exp(0.22 - 0.198), 3), { timeout: 3000 })
  })
})

describe('context menu and double-click', () => {
  it('opens a menu for what is under a right-click and selects it', () => {
    mount()
    vi.mocked(document.elementFromPoint).mockReturnValue(hit('node', 'b'))
    fireEvent.pointerDown(hit('node', 'b'), { pointerId: 1, button: 2, ...at(9, 1) })
    fireEvent.pointerUp(svg(), { pointerId: 1, button: 2, ...at(9, 1) })
    expect(S().selection).toEqual(['b'])
    expect(screen.getByRole('button', { name: /Wrap in group/ })).toBeInTheDocument()
    // the next press anywhere on the canvas dismisses it
    drag(svg(), [20, 20], [20, 20])
    expect(document.querySelector('.ctx-menu')).toBeNull()
  })
  it('keeps a multi-selection when right-clicking one of its members', () => {
    mount(undefined, { selection: ['a', 'b'] })
    vi.mocked(document.elementFromPoint).mockReturnValue(hit('node', 'a'))
    fireEvent.pointerDown(hit('node', 'a'), { pointerId: 1, button: 2, ...at(1, 1) })
    fireEvent.pointerUp(svg(), { pointerId: 1, button: 2, ...at(1, 1) })
    expect(S().selection).toEqual(['a', 'b'])
  })
  it('offers canvas actions on empty ground and adds a label at that spot', () => {
    mount(undefined, { selection: ['a'] })
    fireEvent.pointerDown(svg(), { pointerId: 1, button: 2, ...at(5.2, 6.9) })
    fireEvent.pointerUp(svg(), { pointerId: 1, button: 2, ...at(5.2, 6.9) })
    expect(S().selection).toEqual([])
    fireEvent.click(screen.getByRole('button', { name: /Add label here/ }))
    expect(S().doc.labels[0]).toMatchObject({ x: 5, y: 7 })
    expect(document.querySelector('.ctx-menu')).toBeNull()
  })
  it('suppresses the browser menu', () => {
    mount()
    expect(fireEvent.contextMenu(svg())).toBe(false)
  })
  it('asks for the name field on double-click of an item, not of empty ground', () => {
    mount(undefined, { panel: 'budget' })
    const before = S().focusName
    fireEvent.doubleClick(svg())
    expect(S().focusName).toBe(before)
    fireEvent.doubleClick(hit('node', 'a'))
    expect(S()).toMatchObject({ focusName: before + 1, panel: 'inspect' })
  })
})

describe('placing from the library', () => {
  it('shows a ghost under the pointer and drops the component on release', () => {
    mount(docOf(), { placing: 'rds' })
    expect(svg().style.cursor).toBe('copy')
    fireEvent.pointerMove(window, at(4.2, 6.8))
    expect(document.querySelector('.ghost')).not.toBeNull()
    fireEvent.pointerUp(window, at(4.2, 6.8))
    expect(S().doc.nodes).toHaveLength(1)
    expect(S().doc.nodes[0]).toMatchObject({ type: 'rds', x: 3, y: 6, name: 'rds-1' })
    expect(S().placing).toBeNull()
    expect(document.querySelector('.ghost')).toBeNull()
    expect(S().selection).toEqual([S().doc.nodes[0].id])
  })
  it('keeps placing while Shift is held', () => {
    mount(docOf(), { placing: 'ec2' })
    fireEvent.pointerUp(window, { ...at(0, 0), shiftKey: true })
    fireEvent.pointerUp(window, { ...at(6, 0), shiftKey: true })
    expect(S().doc.nodes.map((n) => n.name)).toEqual(['ec2-1', 'ec2-2'])
    expect(S().placing).toBe('ec2')
  })
  it('does nothing when released outside the canvas or over a panel', () => {
    mount(docOf(), { placing: 'ec2' })
    fireEvent.pointerMove(window, { clientX: 5000, clientY: 100 })
    expect(document.querySelector('.ghost')).toBeNull()
    fireEvent.pointerUp(window, { clientX: 5000, clientY: 100 })
    vi.mocked(document.elementFromPoint).mockReturnValue(document.body) // a panel covers this part of the canvas
    fireEvent.pointerUp(window, { clientX: 100, clientY: 100 })
    expect(S().doc.nodes).toHaveLength(0)
    expect(S().placing).toBe('ec2')
  })
  it('ignores presses on the canvas itself while placing', () => {
    mount(undefined, { placing: 'ec2' })
    down(hit('node', 'a'), 1, 1)
    expect(S().selection).toEqual([])
  })
})

describe('selection bar', () => {
  it('summarises a single component and acts on it', () => {
    const doc = docOf([node('a', 'ec2', 0, 0, { name: 'web' }), node('b', 'users', 8, 0)])
    mount(doc, { selection: ['a'] })
    const bar = document.querySelector('.sel-bar')!
    expect(bar).toHaveTextContent('web')
    expect(bar).toHaveTextContent(money(costOf(doc.nodes[0], doc.region).monthly))
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate' }))
    expect(S().doc.nodes).toHaveLength(3)
    act(() => S().select(['a']))
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    expect(S().tool).toBe('connect')
    expect(document.querySelector('.sel-bar')).toBeNull() // only with the Select tool
    act(() => S().set({ tool: 'select' }))
    fireEvent.click(screen.getByRole('button', { name: 'Focus' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(S().doc.nodes.some((n) => n.id === 'a')).toBe(false)
    expect(document.querySelector('.sel-bar')).toBeNull()
  })
  it('shows no price for a free component and falls back to the service name', () => {
    mount(docOf([node('u', 'users', 0, 0)]), { selection: ['u'] })
    const bar = document.querySelector('.sel-bar')!
    expect(bar).toHaveTextContent('Clients')
    expect(bar.querySelector('em')).toBeNull()
  })
  it('totals several components and can wrap them in a group', () => {
    const doc = docOf([node('a', 'ec2', 0, 0), node('b', 'rds', 8, 0, { scale: 2 })])
    mount(doc, { selection: ['a', 'b'] })
    const bar = document.querySelector('.sel-bar')!
    expect(bar).toHaveTextContent('2 selected')
    expect(bar).toHaveTextContent(money(costOf(doc.nodes[0], doc.region).monthly + costOf(doc.nodes[1], doc.region).monthly))
    expect(screen.queryByRole('button', { name: 'Connect' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Group' }))
    expect(S().doc.areas).toHaveLength(1)
    expect(S().doc.areas[0]).toMatchObject({ kind: 'group', x: -1, w: 14 })
  })
  it('is not shown for a selection without components', () => {
    mount(docOf([], [], { areas: [area('r', 0, 0, 4, 4)] }), { selection: ['r'] })
    expect(document.querySelector('.sel-bar')).toBeNull()
  })
})

describe('cost heatmap and read-outs', () => {
  it('labels each billable component with its monthly cost', () => {
    const doc = docOf([node('a', 'ec2', 0, 0, { name: 'web' }), node('u', 'users', 8, 0)])
    mount(doc, { lens: 'cost' })
    expect(hit('node', 'a').textContent).toContain(money(costOf(doc.nodes[0], doc.region).monthly) + '/mo')
    expect(hit('node', 'u').textContent).not.toContain('/mo')
    act(() => S().set({ pricing: 'commit3' }))
    expect(hit('node', 'a').textContent).toContain(money(costOf(doc.nodes[0], doc.region, 'commit3').monthly) + '/mo')
  })
  it('maps cost share to a cold-to-hot colour', () => {
    expect(heat(0)).toBe('#4a556b')
    expect(heat(-1)).toBe('#4a556b')
    expect(heat(1).toLowerCase()).toBe('#e5574f')
    expect(heat(0.25).toLowerCase()).toBe('#e8c13d')
    expect(heat(0.01)).not.toBe(heat(0.9))
  })
  it('writes the cursor position to the read-out', () => {
    mount()
    const el = document.createElement('span')
    hud.el = el
    move(12.4, -3.6)
    expect(el.textContent).toBe('X +012  Y -004')
    hud.el = null
  })
  it('passes the theme and name visibility through to the scene', () => {
    mount(undefined, { theme: 'light', showLabels: false })
    expect(document.querySelector('.nd-label')).toBeNull()
    expect(document.querySelector('#grid circle')).toHaveAttribute('fill', '#d4d4d8')
  })
  it('plays the build-in animation briefly when a blueprint opens', () => {
    vi.useFakeTimers()
    mount()
    expect(document.querySelector('.canvas-wrap')).toHaveClass('intro')
    act(() => { vi.advanceTimersByTime(1600) })
    expect(document.querySelector('.canvas-wrap')).not.toHaveClass('intro')
  })
  it('fits the blueprint once the canvas has been measured for the first time', () => {
    let measured: () => void = () => {}
    vi.stubGlobal('ResizeObserver', class { constructor(cb: () => void) { measured = cb } observe() {} disconnect() {} })
    mount()
    // as on a first load: nothing measured yet, then the browser reports the real size
    Object.assign(cam, { w: 1200, h: 800 })
    act(() => { useStore.setState({ view: { x: 0, y: 0, k: 1 } }); measured() })
    expect(cam).toMatchObject({ w: 1200, h: 800, left: 0, top: 0 })
    expect(S().view).not.toEqual({ x: 0, y: 0, k: 1 })
    // later resizes keep the user's view
    act(() => { useStore.setState({ view: { x: 5, y: 6, k: 2 } }); Object.assign(cam, { w: 900 }); measured() })
    expect(S().view).toEqual({ x: 5, y: 6, k: 2 })
    expect(cam.w).toBe(1200)
  })
  it('records the tool on the wrapper for styling', () => {
    mount(undefined, { tool: 'area' })
    expect(document.querySelector('.canvas-wrap')).toHaveAttribute('data-tool', 'area')
  })
})
