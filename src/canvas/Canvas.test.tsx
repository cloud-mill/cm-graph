// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { costOf, money } from '../core/catalog'
import { ISO_PITCH, ISO_YAW, pt, unproject } from '../core/iso'
import { useStore } from '../core/store'
import { MAX_SCALE, MIN_SCALE } from '../core/types'
import { docOf, edge, node, resetStore } from '../test/helpers'
import { COARSE, PHONE, stubMedia } from '../test/media'
import { Canvas, HOLD_MS, heat } from './Canvas'
import { cam, flushFrame, hud, projNow } from './camera'

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

// a component's handle is a group wrapping the visible square (and, for fingers, a bigger invisible target): count each handle once
const handles = (prefix: string) => [...new Set([...document.querySelectorAll('[data-handle]')].map((h) => h.getAttribute('data-handle')!).filter((h) => new RegExp(`^${prefix}\\d$`).test(h)))]
const area = (id: string, x: number, y: number, w: number, d: number) => ({ id, x, y, w, d, name: id, color: '#8F6FF2', kind: 'vpc' as const })
/** where a component is drawn on the ground right now, which while it is carried is not where the blueprint has it */
const drawnAt = (id: string) => {
  const m = hit('node', id).getAttribute('transform')!.match(/translate\((-?[\d.]+) (-?[\d.]+)\)/)!
  return unproject(projNow(), Number(m[1]), Number(m[2])).map((v) => Math.round(v * 100) / 100 + 0)
}
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
    down(hit('edge', 'e'), 4, 1); up(4, 1)
    expect(S().selection).toEqual(['e'])
    expect(S().past).toHaveLength(0)
    expect(document.querySelector('.overlay path[filter]')).not.toBeNull() // highlighted
  })
  it('a connection can be taken hold of without selecting it first: pressing picks it, pulling moves the run under the pointer', () => {
    mount(docOf([node('a'), node('b', 'ec2', 8, 4)], [edge('e', 'a', 'b')]))
    // the middle run of the Z, at x = 5
    drag(hit('edge', 'e'), [5, 3], [3.1, 3])
    expect(S().selection).toEqual(['e'])
    expect(S().doc.edges[0]).toMatchObject({ runs: [3.1], fromSide: 'e', toSide: 'w' })
    expect(S().past).toHaveLength(1)
    // with Shift it is only added to what is selected
    act(() => S().undo())
    fireEvent.pointerDown(hit('edge', 'e'), { pointerId: 1, button: 0, shiftKey: true, ...at(5, 3) }); move(3, 3); up(3, 3)
    expect(S().doc.edges[0].runs).toBeUndefined()
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
  it('a component goes exactly where it is dragged, and what is on screen as it is let go is what is kept, as one undo step', () => {
    mount()
    down(hit('node', 'a'), 1, 1)
    move(1.02, 1.02)
    expect(S().past).toHaveLength(0) // a twitch is not a drag
    move(4.4, 1)
    // in the hand: it is drawn where the pointer has taken it, and the blueprint is not touched yet
    expect(drawnAt('a')).toEqual([3.4, 0])
    expect(document.querySelectorAll('.landing')).toHaveLength(0)
    expect(hit('node', 'a')).toHaveClass('up')
    expect(S().doc.nodes[0]).toMatchObject({ x: 0, y: 0 })
    expect(S()).toMatchObject({ past: [], saved: true })
    expect(document.querySelector('.canvas-wrap')).toHaveClass('busy')
    move(6.63, 3.41)
    const shown = hit('node', 'a').getAttribute('transform')
    up(6.63, 3.41)
    // not rounded to a cell, not eased anywhere: the same place, to the pixel
    expect(S().doc.nodes[0]).toMatchObject({ x: 5.63, y: 2.41 })
    expect(hit('node', 'a').getAttribute('transform')).toBe(shown)
    expect(document.querySelector('.canvas-wrap')).not.toHaveClass('settle')
    expect(S().doc.nodes[1]).toMatchObject({ x: 8, y: 0 })
    expect(S().past).toHaveLength(1)
    expect(document.querySelector('.canvas-wrap')).not.toHaveClass('busy')
    act(() => S().undo())
    expect(S().doc.nodes[0]).toMatchObject({ x: 0, y: 0 })
  })
  it('moved again and again by tiny amounts, it goes just that far each time', () => {
    mount()
    drag(hit('node', 'a'), [1, 1], [1.13, 1.07])
    expect(S().doc.nodes[0]).toMatchObject({ x: 0.13, y: 0.07 })
    drag(hit('node', 'a'), [1.13, 1.07], [1.2, 1])
    expect(S().doc.nodes[0]).toMatchObject({ x: 0.2, y: 0 })
    expect(S().past).toHaveLength(2)
  })
  it('with snapping on it keeps to whole cells as it is carried, so what is shown is still what is kept; Ctrl flips snapping for one drag', () => {
    mount(undefined, { snap: true })
    down(hit('node', 'a'), 1, 1)
    move(4.4, 1.3)
    expect(drawnAt('a')).toEqual([3, 0])
    const shown = hit('node', 'a').getAttribute('transform')
    up(4.4, 1.3)
    expect(S().doc.nodes[0]).toMatchObject({ x: 3, y: 0 })
    expect(hit('node', 'a').getAttribute('transform')).toBe(shown)
    // Ctrl held: free for this drag
    drag(hit('node', 'a'), [4, 1], [4.3, 1.2], { ctrlKey: true })
    expect(S().doc.nodes[0]).toMatchObject({ x: 3.3, y: 0.2 })
    // one that was put down off the grid comes back onto it when carried with snapping on
    drag(hit('node', 'a'), [4.3, 1.2], [5.2, 1.2])
    expect(S().doc.nodes[0]).toMatchObject({ x: 4, y: 0 })
    cleanup()
    // and with snapping off, Ctrl turns it on for the one drag
    mount()
    drag(hit('node', 'a'), [1, 1], [4.4, 1.3], { ctrlKey: true })
    expect(S().doc.nodes[0]).toMatchObject({ x: 3, y: 0 })
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
  it('a label goes exactly where it is dragged, and keeps to half cells with snapping on', () => {
    mount(docOf([], [], { labels: [label('l', 0, 0)] }))
    drag(hit('label', 'l'), [0, 0], [1.6, 0.3])
    expect(S().doc.labels[0]).toMatchObject({ x: 1.6, y: 0.3 })
    cleanup()
    mount(docOf([], [], { labels: [label('l', 0, 0)] }), { snap: true })
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
  it('grows from the far corner by as much as the corner is pulled, as one undo step', () => {
    mount(undefined, { selection: ['a'] })
    down(document.querySelector('[data-handle="n2"]')!, 2, 2)
    move(3.1, 2.6)
    // shown at its new size while the corner is held; written when it is let go
    expect(hit('node', 'a').querySelector('.nd-body g')!.getAttribute('transform')).toBe('scale(1.55)')
    expect(S().doc.nodes[0].scale).toBeUndefined()
    move(4.2, 4.2)
    up(4.2, 4.2)
    expect(S().doc.nodes[0]).toMatchObject({ x: 0, y: 0, scale: 2.1 })
    expect(S().past).toHaveLength(1)
  })
  it('caught off the middle of its handle, a corner does not jump: the size changes only by how far it is pulled', () => {
    mount(undefined, { selection: ['a'] })
    drag(document.querySelector('[data-handle="n2"]')!, [2.12, 2.09], [3.12, 3.09])
    expect(S().doc.nodes[0]).toMatchObject({ x: 0, y: 0, scale: 1.5 })
  })
  it('with snapping on a component is sized in half cells', () => {
    mount(undefined, { selection: ['a'], snap: true })
    drag(document.querySelector('[data-handle="n2"]')!, [2, 2], [3.1, 2.6])
    expect(S().doc.nodes[0]).toMatchObject({ x: 0, y: 0, scale: 1.5 })
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
  it('an area corner goes exactly as far as it is pulled, from wherever on its handle it was caught', () => {
    mount(docOf([], [], { areas: [area('r', 0, 0, 6, 4)] }), { selection: ['r'] })
    drag(document.querySelector('[data-handle="r2"]')!, [6.1, 4.05], [9.3, 7.35])
    expect(S().doc.areas[0]).toMatchObject({ x: 0, y: 0, w: 9.2, d: 7.3 })
    drag(document.querySelector('[data-handle="r0"]')!, [0, 0], [-2.13, -1.4])
    expect(S().doc.areas[0]).toMatchObject({ x: -2.13, y: -1.4, w: 11.33, d: 8.7 })
  })
  it('with snapping on, resizes an area from any corner in half cells, never below one cell', () => {
    mount(docOf([], [], { areas: [area('r', 0, 0, 6, 4)] }), { selection: ['r'], snap: true })
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
    // from where the pointer went down to where it came up, exactly
    expect(S().doc.areas[0]).toMatchObject({ x: -2.2, y: -2.1, w: 7.5, d: 5.9, kind: 'vpc', name: 'VPC' })
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
    expect(S().doc.labels[0]).toMatchObject({ x: 3.2, y: -1.3, text: 'Label' })
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
    expect(document.querySelector('.wire.caught path')!.getAttribute('d')).toContain('L') // snapped to a routed path
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
    // its middle where the pointer was
    expect(S().doc.nodes[0]).toMatchObject({ type: 'rds', x: 3.2, y: 5.8, name: 'rds-1' })
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

// ---- touch ---------------------------------------------------------------------

/** one finger: `id` tells fingers apart, positions are ground cells unless given as client px */
const finger = (id: number) => {
  const o = { pointerId: id, pointerType: 'touch', button: 0 }
  return {
    down: (el: Element, wx: number, wy: number) => fireEvent.pointerDown(el, { ...o, ...at(wx, wy) }),
    move: (wx: number, wy: number) => fireEvent.pointerMove(svg(), { ...o, ...at(wx, wy) }),
    up: (wx: number, wy: number) => fireEvent.pointerUp(svg(), { ...o, ...at(wx, wy) }),
    downAt: (x: number, y: number, el: Element = svg()) => fireEvent.pointerDown(el, { ...o, clientX: x, clientY: y }),
    // two-finger moves are applied once per frame: `flushFrame` is that frame arriving
    moveTo: (x: number, y: number) => { const r = fireEvent.pointerMove(svg(), { ...o, clientX: x, clientY: y }); act(() => flushFrame()); return r },
    upAt: (x: number, y: number) => fireEvent.pointerUp(svg(), { ...o, clientX: x, clientY: y }),
    cancel: () => fireEvent.pointerCancel(svg(), { ...o }),
  }
}
const f1 = finger(11), f2 = finger(12), f3 = finger(13)
const tap = (el: Element, wx: number, wy: number) => { f1.down(el, wx, wy); f1.up(wx, wy) }
/** where a ground point is drawn right now */
const drawn = (wx: number, wy: number) => at(wx, wy)
const busy = () => document.querySelector('.canvas-wrap')!.classList.contains('busy')

describe('touch: one finger', () => {
  it('a tap selects, and a tap elsewhere replaces the selection', () => {
    mount()
    tap(hit('node', 'a'), 1, 1)
    expect(S().selection).toEqual(['a'])
    tap(hit('node', 'b'), 9, 1)
    expect(S().selection).toEqual(['b'])
  })
  it('a tap on a connection selects it', () => {
    mount(docOf([node('a', 'ec2', 0, 0), node('b', 'rds', 8, 0)], [edge('e', 'a', 'b')]))
    tap(hit('edge', 'e'), 5, 1)
    expect(S().selection).toEqual(['e'])
  })
  it('a tap on bare ground clears the selection and ends multi-select', () => {
    mount(undefined, { selection: ['a'], multi: true })
    tap(svg(), 4, 4)
    expect(S()).toMatchObject({ selection: [], multi: false })
  })
  it('a finger that trembles a little is still a tap', () => {
    mount()
    const p = at(1, 1)
    f1.downAt(p.clientX, p.clientY, hit('node', 'a'))
    f1.moveTo(p.clientX + 5, p.clientY + 4)
    f1.upAt(p.clientX + 5, p.clientY + 4)
    expect(S().selection).toEqual(['a'])
    expect(S().view).toEqual({ x: 600, y: 300, k: 1 })
  })
  it('dragging across a component that is not selected pans: it never moves by accident', () => {
    mount()
    const p = at(1, 1)
    f1.downAt(p.clientX, p.clientY, hit('node', 'a'))
    f1.moveTo(p.clientX + 60, p.clientY - 25)
    expect(busy()).toBe(true)
    f1.moveTo(p.clientX + 80, p.clientY - 30)
    f1.upAt(p.clientX + 80, p.clientY - 30)
    expect(S().view).toEqual({ x: 680, y: 270, k: 1 })
    expect(S().doc.nodes[0]).toMatchObject({ x: 0, y: 0 })
    expect(S().selection).toEqual([])
    expect(S().past).toHaveLength(0)
    expect(busy()).toBe(false)
  })
  it('dragging bare ground pans too', () => {
    mount(undefined, { selection: ['a'] })
    f1.downAt(300, 600)
    f1.moveTo(250, 640)
    f1.upAt(250, 640)
    expect(S().view).toEqual({ x: 550, y: 340, k: 1 })
    expect(S().selection).toEqual(['a']) // a pan is not a tap: the selection stays
  })
  it('dragging a selected component moves it exactly as far as the finger goes, as one undo step', () => {
    mount(undefined, { selection: ['a'] })
    f1.down(hit('node', 'a'), 1, 1)
    f1.move(3.2, 2.1)
    expect(busy()).toBe(true)
    f1.up(3.2, 2.1)
    expect(S().doc.nodes[0]).toMatchObject({ x: 2.2, y: 1.1 })
    expect(S().view).toEqual({ x: 600, y: 300, k: 1 })
    expect(S().past).toHaveLength(1)
    act(() => S().undo())
    expect(S().doc.nodes[0]).toMatchObject({ x: 0, y: 0 })
  })
  it('needs a firmer push than a mouse before a move begins', () => {
    mount(undefined, { selection: ['a'] })
    const p = at(1, 1)
    f1.downAt(p.clientX, p.clientY, hit('node', 'a'))
    f1.moveTo(p.clientX + 6, p.clientY) // past the mouse threshold, inside the finger one
    expect(busy()).toBe(false)
    f1.upAt(p.clientX + 6, p.clientY)
    expect(S().past).toHaveLength(0)
  })
  it('keeps working when the browser refuses to capture the pointer', () => {
    mount()
    vi.spyOn(Element.prototype as any, 'setPointerCapture').mockImplementation(() => { throw new DOMException('gone', 'NotFoundError') })
    tap(hit('node', 'a'), 1, 1)
    expect(S().selection).toEqual(['a'])
  })
  it('with another tool up, a finger uses that tool as a mouse would', () => {
    mount(docOf(), { tool: 'area' })
    f1.down(svg(), 0, 0)
    f1.move(4, 3)
    f1.up(4, 3)
    expect(S().doc.areas).toMatchObject([{ x: 0, y: 0, w: 4, d: 3 }])
  })
})

describe('touch: press and hold', () => {
  beforeEach(() => { vi.useFakeTimers() })

  it('on a component picks it up: it is selected at once and the same finger carries it', () => {
    const vibrate = vi.fn<(ms: number) => boolean>()
    Object.defineProperty(navigator, 'vibrate', { value: vibrate, configurable: true })
    mount()
    f1.down(hit('node', 'b'), 9, 1)
    act(() => { vi.advanceTimersByTime(HOLD_MS - 10) })
    expect(S().selection).toEqual([])
    act(() => { vi.advanceTimersByTime(20) })
    expect(S().selection).toEqual(['b'])
    expect(vibrate).toHaveBeenCalledWith(12)
    expect(busy()).toBe(true) // lifted
    f1.move(9, 4)
    expect(drawnAt('b')).toEqual([8, 3])
    f1.up(9, 4)
    expect(S().doc.nodes[1]).toMatchObject({ x: 8, y: 3 })
    expect(busy()).toBe(false)
    expect(S().past).toHaveLength(1)
    expect(S().view).toEqual({ x: 600, y: 300, k: 1 })
    delete (navigator as any).vibrate
  })
  it('on a component, released without moving, just leaves it selected', () => {
    mount()
    f1.down(hit('node', 'a'), 1, 1)
    act(() => { vi.advanceTimersByTime(HOLD_MS) })
    f1.up(1, 1)
    expect(S().selection).toEqual(['a'])
    expect(S().past).toHaveLength(0)
    expect(document.querySelector('.ctx-menu')).toBeNull()
  })
  it('on a text label moves it in half cells', () => {
    mount(docOf([], [], { labels: [label('l', 0, 0)] }))
    f1.down(hit('label', 'l'), 0, 0)
    act(() => { vi.advanceTimersByTime(HOLD_MS) })
    f1.move(1.5, 0)
    f1.up(1.5, 0)
    expect(S().doc.labels[0]).toMatchObject({ x: 1.5, y: 0 })
  })
  it('on bare ground opens the menu there', () => {
    mount(undefined, { selection: ['a'] })
    f1.downAt(300, 600)
    act(() => { vi.advanceTimersByTime(HOLD_MS) })
    const menu = document.querySelector('.ctx-menu')!
    expect(menu).toHaveTextContent('Add label here')
    expect(S().selection).toEqual([])
    // lifting the finger afterwards is not a tap and does not close it
    f1.upAt(300, 600)
    expect(document.querySelector('.ctx-menu')).not.toBeNull()
  })
  it('on a connection opens its menu rather than trying to move it', () => {
    mount(docOf([node('a', 'ec2', 0, 0), node('b', 'rds', 8, 0)], [edge('e', 'a', 'b')]))
    vi.mocked(document.elementFromPoint).mockReturnValue(hit('edge', 'e'))
    f1.down(hit('edge', 'e'), 5, 1)
    act(() => { vi.advanceTimersByTime(HOLD_MS) })
    expect(S().selection).toEqual(['e'])
    expect(document.querySelector('.ctx-menu')).toHaveTextContent('Reverse direction')
  })
  it('is called off as soon as the finger travels', () => {
    mount()
    const p = at(1, 1)
    f1.downAt(p.clientX, p.clientY, hit('node', 'a'))
    f1.moveTo(p.clientX + 40, p.clientY)
    act(() => { vi.advanceTimersByTime(HOLD_MS * 2) })
    expect(S().selection).toEqual([])
    expect(document.querySelector('.ctx-menu')).toBeNull()
    f1.upAt(p.clientX + 40, p.clientY)
    expect(S().view.x).toBe(640)
  })
  it('is called off when the finger lifts early, and when the canvas goes away', () => {
    const { unmount } = mount()
    tap(hit('node', 'a'), 1, 1)
    act(() => { vi.advanceTimersByTime(HOLD_MS * 2) })
    expect(busy()).toBe(false)
    f1.down(hit('node', 'b'), 9, 1)
    unmount()
    expect(() => vi.advanceTimersByTime(HOLD_MS * 2)).not.toThrow()
    expect(S().selection).toEqual(['a'])
  })
  it('does nothing if a second finger has already turned it into a pinch', () => {
    mount()
    f1.down(hit('node', 'a'), 1, 1)
    f2.downAt(900, 500)
    act(() => { vi.advanceTimersByTime(HOLD_MS * 2) })
    expect(S().selection).toEqual([])
    expect(document.querySelector('.ctx-menu')).toBeNull()
  })
})

describe('touch: getting around with one finger', () => {
  it('a flick keeps the view moving, and it eases to a stop', () => {
    vi.useFakeTimers()
    mount()
    f1.downAt(600, 400)
    for (let i = 1; i <= 6; i++) { act(() => { vi.advanceTimersByTime(16) }); f1.moveTo(600 + i * 20, 400) }
    const x = S().view.x
    f1.upAt(720, 400)
    act(() => { vi.advanceTimersByTime(120) })
    const mid = S().view.x
    expect(mid).toBeGreaterThan(x + 40)
    act(() => { vi.advanceTimersByTime(3000) })
    const end = S().view.x
    expect(end).toBeGreaterThan(mid)
    act(() => { vi.advanceTimersByTime(1000) })
    expect(S().view.x).toBe(end)
    expect(S().view.y).toBe(300)
  })
  it('a finger that stops before lifting leaves the view exactly there', () => {
    vi.useFakeTimers()
    mount()
    f1.downAt(600, 400)
    for (let i = 1; i <= 6; i++) { act(() => { vi.advanceTimersByTime(16) }); f1.moveTo(600 + i * 20, 400) }
    act(() => { vi.advanceTimersByTime(200) })
    const x = S().view.x
    f1.upAt(720, 400)
    act(() => { vi.advanceTimersByTime(1000) })
    expect(S().view.x).toBe(x)
  })
  it('touching the glass stops a coasting view dead', () => {
    vi.useFakeTimers()
    mount()
    f1.downAt(600, 400)
    for (let i = 1; i <= 6; i++) { act(() => { vi.advanceTimersByTime(16) }); f1.moveTo(600 + i * 20, 400) }
    f1.upAt(720, 400)
    act(() => { vi.advanceTimersByTime(64) })
    f1.downAt(300, 300)
    const x = S().view.x
    act(() => { vi.advanceTimersByTime(1000) })
    expect(S().view.x).toBe(x)
    f1.cancel()
  })
  it('a double tap on bare ground zooms in on that spot', () => {
    vi.useFakeTimers()
    mount()
    f1.downAt(700, 500); f1.upAt(700, 500)
    act(() => { vi.advanceTimersByTime(120) })
    f1.downAt(704, 498); f1.upAt(704, 498)
    act(() => { vi.advanceTimersByTime(600) })
    expect(S().view.k).toBeCloseTo(2)
    // what was under the second tap still is
    expect(S().view.x).toBeCloseTo(704 - (704 - 600) * 2)
    expect(S().view.y).toBeCloseTo(498 - (498 - 300) * 2)
  })
  it('two slow taps are just two taps', () => {
    vi.useFakeTimers()
    mount()
    f1.downAt(700, 500); f1.upAt(700, 500)
    act(() => { vi.advanceTimersByTime(600) })
    f1.downAt(700, 500); f1.upAt(700, 500)
    act(() => { vi.advanceTimersByTime(600) })
    expect(S().view.k).toBe(1)
  })
  it('two quick taps far apart are just two taps', () => {
    vi.useFakeTimers()
    mount()
    f1.downAt(700, 500); f1.upAt(700, 500)
    f1.downAt(900, 300); f1.upAt(900, 300)
    act(() => { vi.advanceTimersByTime(600) })
    expect(S().view.k).toBe(1)
  })
  it('double tap and slide zooms with one thumb: down for in, up for out, about the tapped spot', () => {
    mount()
    f1.downAt(700, 500); f1.upAt(700, 500)
    f1.downAt(700, 500)
    f1.moveTo(700, 505)
    expect(S().view.k).toBe(1) // not yet a slide
    f1.moveTo(700, 579)
    expect(S().view.k).toBeCloseTo(Math.exp(0.7))
    expect(busy()).toBe(true)
    // the tapped spot has not moved
    expect((700 - S().view.x) / S().view.k).toBeCloseTo(700 - 600, 0)
    f1.moveTo(700, 409)
    expect(S().view.k).toBeCloseTo(Math.exp(-1))
    f1.moveTo(700, -2000)
    expect(S().view.k).toBe(0.15)
    f1.upAt(700, -2000)
    expect(busy()).toBe(false)
    expect(S().view.k).toBe(0.15) // lifting after a slide is not a double tap
  })
  it('a second finger during a double tap turns it into an ordinary pinch', () => {
    mount()
    f1.downAt(500, 400); f1.upAt(500, 400)
    f1.downAt(500, 400); f2.downAt(700, 400)
    f1.moveTo(400, 400); f2.moveTo(800, 400)
    expect(S().view.k).toBeCloseTo(2)
    f1.cancel(); f2.cancel()
  })
})

describe('touch: multi-select', () => {
  it('taps add to and take from the selection', () => {
    mount(undefined, { selection: ['a'], multi: true })
    tap(hit('node', 'b'), 9, 1)
    expect(S().selection).toEqual(['a', 'b'])
    tap(hit('node', 'a'), 1, 1)
    expect(S().selection).toEqual(['b'])
    expect(S().multi).toBe(true)
  })
  it('press and hold adds what is under the finger and carries the whole selection', () => {
    vi.useFakeTimers()
    mount(undefined, { selection: ['a'], multi: true })
    f1.down(hit('node', 'b'), 9, 1)
    act(() => { vi.advanceTimersByTime(HOLD_MS) })
    expect(S().selection).toEqual(['a', 'b'])
    f1.move(9, 3)
    f1.up(9, 3)
    expect(S().doc.nodes.map((n) => [n.x, n.y])).toEqual([[0, 2], [8, 2]])
  })
  it('press and hold on something already selected keeps it selected', () => {
    vi.useFakeTimers()
    mount(undefined, { selection: ['a', 'b'], multi: true })
    f1.down(hit('node', 'a'), 1, 1)
    act(() => { vi.advanceTimersByTime(HOLD_MS) })
    expect(S().selection).toEqual(['a', 'b'])
  })
})

describe('touch: two fingers', () => {
  it('spreading zooms about the middle of the fingers, so the ground under them stays put', () => {
    mount()
    const before = drawn(2, 3)
    f1.downAt(500, 400); f2.downAt(700, 400)
    expect(busy()).toBe(true)
    f1.moveTo(400, 400); f2.moveTo(800, 400)
    expect(S().view.k).toBeCloseTo(2)
    // the ground point that was under (600, 400) is still there
    const g = [(600 - 600) / 1, (400 - 300) / 1] // scene px under the midpoint before the pinch
    expect(g[0] * 2 + S().view.x).toBeCloseTo(600)
    expect(g[1] * 2 + S().view.y).toBeCloseTo(400)
    expect(drawn(2, 3)).not.toEqual(before)
    f2.upAt(800, 400)
    f1.upAt(400, 400)
    expect(busy()).toBe(false)
    expect(S().yaw).toBe(ISO_YAW)
    expect(S().selection).toEqual([])
  })
  it('moving both fingers together pans', () => {
    mount()
    f1.downAt(500, 400); f2.downAt(700, 400)
    f1.moveTo(530, 350); f2.moveTo(730, 350)
    expect(S().view.k).toBeCloseTo(1)
    expect(S().view.x).toBeCloseTo(630)
    expect(S().view.y).toBeCloseTo(250)
    f1.upAt(530, 350); f2.upAt(730, 350)
  })
  it('zoom stops at its limits', () => {
    mount()
    f1.downAt(590, 400); f2.downAt(610, 400)
    f1.moveTo(0, 400); f2.moveTo(1200, 400)
    expect(S().view.k).toBe(4)
    f1.upAt(0, 400); f2.upAt(1200, 400)
    f1.downAt(0, 400); f2.downAt(1200, 400)
    f1.moveTo(599, 400); f2.moveTo(601, 400)
    expect(S().view.k).toBe(0.15)
    f1.cancel(); f2.cancel()
  })
  it('a second finger ends a move in progress where it is, and the pinch takes over', () => {
    mount(undefined, { selection: ['a'] })
    f1.down(hit('node', 'a'), 1, 1)
    f1.move(3, 1)
    expect(drawnAt('a')[0]).toBe(2)
    const p = at(3, 1)
    f2.downAt(p.clientX + 200, p.clientY)
    f1.moveTo(p.clientX - 100, p.clientY)
    expect(S().doc.nodes[0].x).toBe(2) // no longer following the finger
    expect(S().view.k).toBeGreaterThan(1)
    f1.upAt(p.clientX - 100, p.clientY); f2.upAt(p.clientX + 200, p.clientY)
    expect(document.querySelectorAll('.guide')).toHaveLength(0)
  })
  it('the finger left down after a pinch carries on as a pan, with no jump and no tap', () => {
    mount(undefined, { selection: ['a'] })
    f1.downAt(500, 400); f2.downAt(700, 400)
    f1.moveTo(450, 400); f2.moveTo(750, 400)
    f2.upAt(750, 400)
    const view = S().view
    expect(busy()).toBe(true)
    f1.moveTo(450, 400)
    expect(S().view).toEqual(view) // lifting one finger moved nothing
    f1.moveTo(480, 430)
    expect(S().view).toEqual({ ...view, x: view.x + 30, y: view.y + 30 })
    f1.upAt(480, 430)
    expect(busy()).toBe(false)
    expect(S().selection).toEqual(['a']) // and its lifting is not a tap
    // the next touch is an ordinary one again
    tap(svg(), 4, 4)
    expect(S().selection).toEqual([])
  })
  it('when one of the pair lifts with a third finger down, the two that are left carry on without a jump', () => {
    mount()
    f1.downAt(500, 400); f2.downAt(700, 400); f3.downAt(600, 600)
    f1.moveTo(450, 400); f2.moveTo(750, 400)
    const view = S().view
    f1.upAt(450, 400)
    f2.moveTo(750, 400)
    expect(S().view.k).toBeCloseTo(view.k); expect(S().view.x).toBeCloseTo(view.x); expect(S().view.y).toBeCloseTo(view.y)
    f2.moveTo(790, 400); f3.moveTo(640, 600)
    expect(S().view.x).toBeCloseTo(view.x + 40)
    f2.cancel(); f3.cancel()
  })
  it('a third finger changes nothing', () => {
    mount()
    f1.downAt(500, 400); f2.downAt(700, 400); f3.downAt(600, 600)
    f1.moveTo(400, 400); f2.moveTo(800, 400)
    expect(S().view.k).toBeCloseTo(2)
    f3.upAt(600, 600)
    f1.moveTo(450, 400)
    expect(S().view.k).toBeCloseTo(1.75)
    f1.cancel(); f2.cancel()
    expect(busy()).toBe(false)
  })
  /** both fingers, a given distance apart about (600, 400), turned `deg` clockwise */
  const twistTo = (deg: number, dist = 200) => {
    const r = (deg * Math.PI) / 180
    f1.moveTo(600 - (Math.cos(r) * dist) / 2, 400 - (Math.sin(r) * dist) / 2)
    f2.moveTo(600 + (Math.cos(r) * dist) / 2, 400 + (Math.sin(r) * dist) / 2)
  }
  it('a deliberate twist turns the scene the way the fingers turn, about the point between them', () => {
    mount()
    const under = unproject(projNow(), (600 - S().view.x) / S().view.k, (400 - S().view.y) / S().view.k)
    f1.downAt(500, 400); f2.downAt(700, 400)
    for (let d = 2; d <= 50; d += 2) twistTo(d)
    // clockwise fingers, clockwise scene: yaw grows, by the twist less the little it took to be sure
    expect(S().yaw).toBeGreaterThan(ISO_YAW + 36)
    expect(S().yaw).toBeLessThan(ISO_YAW + 50)
    expect(S().view.k).toBeCloseTo(1)
    const q = pt(projNow(), under[0], under[1])
    expect(q[0] * S().view.k + S().view.x).toBeCloseTo(600)
    expect(q[1] * S().view.k + S().view.y).toBeCloseTo(400)
    expect(screen.getByRole('status')).toHaveTextContent(/^Turn \d+°$/)
    f1.cancel(); f2.cancel()
    expect(screen.queryByRole('status')).toBeNull()
  })
  it('a turn stays exactly where it was left: nothing snaps afterwards', () => {
    vi.useFakeTimers()
    mount()
    f1.downAt(500, 400); f2.downAt(700, 400)
    for (let d = -2; d >= -34; d -= 2) twistTo(d)
    const yaw = S().yaw
    expect(yaw).toBeLessThan(ISO_YAW - 20)
    f1.cancel(); f2.cancel()
    act(() => { vi.advanceTimersByTime(600) })
    expect(S().yaw).toBe(yaw)
  })
  it('a turn past north comes back as an ordinary angle', () => {
    mount()
    f1.downAt(500, 400); f2.downAt(700, 400)
    for (let d = -3; d >= -90; d -= 3) twistTo(d)
    expect(S().yaw).toBeLessThan(0)
    f1.cancel(); f2.cancel()
    expect(S().yaw).toBeGreaterThan(270)
    expect(S().yaw).toBeLessThan(360)
  })
  it('a pinch that wobbles does not turn', () => {
    mount()
    f1.downAt(500, 400); f2.downAt(700, 400)
    for (let i = 1; i <= 10; i++) twistTo(5 * Math.sin(i), 200 + i * 30)
    expect(S().yaw).toBe(ISO_YAW)
    expect(S().view.k).toBeCloseTo(2.5)
    f1.cancel(); f2.cancel()
  })
  it('two fingers side by side sliding up tilt the camera, and nothing else', () => {
    mount()
    f1.downAt(500, 400); f2.downAt(700, 400)
    for (let y = 392; y >= 300; y -= 8) { f1.moveTo(500, y); f2.moveTo(700, y) }
    expect(S().pitch).toBeLessThan(ISO_PITCH - 15)
    expect(S().yaw).toBe(ISO_YAW)
    expect(S().view.k).toBeCloseTo(1, 2)
    expect(screen.getByRole('status')).toHaveTextContent(/^Tilt \d+°$/)
    f1.cancel(); f2.cancel()
  })
  it('sliding down tilts to the plan view and says so', () => {
    mount()
    f1.downAt(500, 300); f2.downAt(700, 300)
    for (let y = 310; y <= 560; y += 10) { f1.moveTo(500, y); f2.moveTo(700, y) }
    expect(S().pitch).toBe(90)
    expect(S().flat).toBe(true)
    expect(screen.getByRole('status')).toHaveTextContent('Plan view')
    f1.cancel(); f2.cancel()
  })
  it('a second finger that joins a pan in progress never tilts', () => {
    mount()
    f1.downAt(500, 400)
    f1.moveTo(500, 440)
    f2.downAt(700, 440)
    for (let y = 430; y >= 340; y -= 10) { f1.moveTo(500, y); f2.moveTo(700, y) }
    expect(S().pitch).toBe(ISO_PITCH)
    f1.cancel(); f2.cancel()
  })
  it('two fingers touched and lifted step the zoom back out', () => {
    vi.useFakeTimers()
    mount()
    f1.downAt(500, 400); f2.downAt(700, 400)
    f1.upAt(500, 400); f2.upAt(700, 400)
    act(() => { vi.advanceTimersByTime(600) })
    expect(S().view.k).toBeCloseTo(0.5)
    // about the point between the fingers
    expect(S().view.x).toBeCloseTo(600); expect(S().view.y).toBeCloseTo(350)
  })
  it('two fingers that rested first are not a tap', () => {
    vi.useFakeTimers()
    mount()
    f1.downAt(500, 400); f2.downAt(700, 400)
    act(() => { vi.advanceTimersByTime(500) })
    f1.upAt(500, 400); f2.upAt(700, 400)
    act(() => { vi.advanceTimersByTime(600) })
    expect(S().view.k).toBe(1)
  })
  it('stops a camera animation the moment the fingers land', () => {
    vi.useFakeTimers()
    mount()
    act(() => { S().set({ selection: [] }) })
    const k0 = S().view.k
    f1.downAt(500, 400); f2.downAt(700, 400)
    act(() => { vi.advanceTimersByTime(1000) })
    expect(S().view.k).toBe(k0)
    f1.cancel(); f2.cancel()
  })
})

describe('touch: connecting by taps', () => {
  const tapNode = (id: 'a' | 'b') => {
    vi.mocked(document.elementFromPoint).mockReturnValue(hit('node', id))
    tap(hit('node', id), id === 'a' ? 1 : 9, 1)
  }
  it('the first tap picks one end and marks it; tapping it again lets go', () => {
    mount(undefined, { tool: 'connect' })
    tapNode('a')
    expect(S().linkFrom).toBe('a')
    expect(document.querySelector('.link-from')).not.toBeNull()
    expect(S().doc.edges).toHaveLength(0)
    tapNode('a')
    expect(S().linkFrom).toBeNull()
    expect(document.querySelector('.link-from')).toBeNull()
  })
  it('the second tap, on another component, makes the connection and returns to selecting', () => {
    mount(undefined, { tool: 'connect' })
    tapNode('a')
    tapNode('b')
    expect(S().doc.edges).toMatchObject([{ from: 'a', to: 'b', arrow: 'end' }])
    expect(S()).toMatchObject({ linkFrom: null, tool: 'select' })
    expect(S().selection).toEqual([S().doc.edges[0].id])
  })
  it('starts from the component the dock handed over', () => {
    mount(undefined, { tool: 'connect', linkFrom: 'b' })
    tapNode('a')
    expect(S().doc.edges).toMatchObject([{ from: 'b', to: 'a' }])
  })
  it('says so when the two are already connected, and still finishes', () => {
    mount(docOf([node('a', 'ec2', 0, 0), node('b', 'rds', 8, 0)], [edge('e', 'b', 'a')]), { tool: 'connect', linkFrom: 'a' })
    tapNode('b')
    expect(S().doc.edges).toHaveLength(1)
    expect(S().toasts.at(-1)).toMatchObject({ text: 'Those components are already connected', kind: 'warn' })
    expect(S()).toMatchObject({ linkFrom: null, tool: 'select' })
  })
  it('a tap on bare ground gives up the half-drawn connection but keeps the tool', () => {
    mount(undefined, { tool: 'connect', linkFrom: 'a' })
    vi.mocked(document.elementFromPoint).mockReturnValue(svg())
    tap(svg(), 4, 4)
    expect(S()).toMatchObject({ linkFrom: null, tool: 'connect' })
  })
  it('dragging from one component to another still connects, and clears any armed end', () => {
    mount(docOf([node('a', 'ec2', 0, 0), node('b', 'rds', 8, 0), node('c', 's3', 0, 8)]), { tool: 'connect', linkFrom: 'c' })
    f1.down(hit('node', 'a'), 1, 1)
    vi.mocked(document.elementFromPoint).mockReturnValue(hit('node', 'b'))
    f1.move(9, 1)
    f1.up(9, 1)
    expect(S().doc.edges).toMatchObject([{ from: 'a', to: 'b' }])
    expect(S()).toMatchObject({ linkFrom: null, tool: 'connect' }) // a drag keeps the tool, for the next one
  })
  it('leaving the connect tool forgets the armed end', () => {
    mount(undefined, { tool: 'connect', linkFrom: 'a' })
    act(() => { S().set({ tool: 'select' }) })
    expect(S().linkFrom).toBeNull()
  })
  it('works the same with a mouse', () => {
    mount(undefined, { tool: 'connect' })
    vi.mocked(document.elementFromPoint).mockReturnValue(hit('node', 'a'))
    drag(hit('node', 'a'), [1, 1], [1, 1])
    expect(S().linkFrom).toBe('a')
    vi.mocked(document.elementFromPoint).mockReturnValue(hit('node', 'b'))
    drag(hit('node', 'b'), [9, 1], [9, 1])
    expect(S().doc.edges).toMatchObject([{ from: 'a', to: 'b' }])
  })
  it('the connection handle on a selected component does not arm anything when merely tapped', () => {
    mount(undefined, { selection: ['a'] })
    vi.mocked(document.elementFromPoint).mockReturnValue(hit('node', 'a'))
    const h = document.querySelector('[data-handle="connect"]')!
    drag(h, [1, 1], [1, 1])
    expect(S().linkFrom).toBeNull()
    expect(S().doc.edges).toHaveLength(0)
  })
})

describe('alignment guides', () => {
  it('draws a line while what is being moved is level with something else, and clears it on release', () => {
    mount(undefined, { selection: ['a'] })
    down(hit('node', 'a'), 1, 1)
    move(3, 1) // still on the same row as b
    const lines = document.querySelectorAll('.guide')
    expect(lines).toHaveLength(1)
    // it runs through both centres, a little past each end
    const a = at(3 - 1.6, 1), b = at(9 + 1.6, 1), v = S().view
    expect(Number(lines[0].getAttribute('x1')) * v.k + v.x).toBeCloseTo(a.clientX, 1)
    expect(Number(lines[0].getAttribute('x2')) * v.k + v.x).toBeCloseTo(b.clientX, 1)
    move(3, 4) // off the row
    expect(document.querySelectorAll('.guide')).toHaveLength(0)
    move(9, 6) // straight below b: a column this time
    expect(document.querySelectorAll('.guide')).toHaveLength(1)
    up(9, 6)
    expect(document.querySelectorAll('.guide')).toHaveLength(0)
  })
  it('ticks under the finger each time a new line appears, and only then', () => {
    const vibrate = vi.fn<(ms: number) => boolean>()
    Object.defineProperty(navigator, 'vibrate', { value: vibrate, configurable: true })
    mount(docOf([node('a', 'ec2', 0, 4), node('b', 'rds', 8, 0)]), { selection: ['a'] })
    f1.down(hit('node', 'a'), 1, 5)
    f1.move(3, 5)
    expect(vibrate).not.toHaveBeenCalledWith(5)
    f1.move(3, 1) // level with b
    expect(vibrate.mock.calls.filter((c) => c[0] === 5)).toHaveLength(1)
    f1.move(4, 1) // still level: the same line, no second tick
    expect(vibrate.mock.calls.filter((c) => c[0] === 5)).toHaveLength(1)
    f1.move(4, 3)
    f1.move(4, 1)
    expect(vibrate.mock.calls.filter((c) => c[0] === 5)).toHaveLength(2)
    f1.up(4, 1)
    delete (navigator as any).vibrate
  })
  it('a mouse gets the lines without the tick', () => {
    const vibrate = vi.fn<(ms: number) => boolean>()
    Object.defineProperty(navigator, 'vibrate', { value: vibrate, configurable: true })
    mount(undefined, { selection: ['a'] })
    drag(hit('node', 'a'), [1, 1], [3, 1])
    expect(vibrate).not.toHaveBeenCalled()
    delete (navigator as any).vibrate
  })
})

describe('touch targets and the phone layout', () => {
  // an invisible target big enough for a fingertip (a mouse's doors have a small one of their own)
  const targets = () => [...document.querySelectorAll('.overlay circle[fill="transparent"]')].filter((c) => Number(c.getAttribute('r')) >= 15)
  it('a mouse gets no enlarged targets', () => {
    mount(undefined, { selection: ['a'] })
    expect(targets()).toHaveLength(0)
  })
  it('where a door\'s invisible finger target reaches over the body of its own component, a press there takes the component, not the door', () => {
    stubMedia(COARSE)
    mount(undefined, { selection: ['a'] })
    const door = document.querySelector('[data-handle="connect"] circle[fill="transparent"]')!
    // the finger is on the door's target and on the body at once, as it is when the view is small
    // jsdom has no layout, so it has no elementsFromPoint of its own
    const under = vi.fn<() => Element[]>(() => [door, hit('node', 'a').querySelector('.nd-body')!])
    Object.defineProperty(document, 'elementsFromPoint', { value: under, configurable: true })
    drag(door, [1, 1], [2.3, 1.4])
    expect(S().doc.nodes[0]).toMatchObject({ x: 1.3, y: 0.4 })
    expect(S().doc.edges).toHaveLength(0)
    expect(document.querySelector('.wire')).toBeNull()
    // clear of the body, the same target still pulls a connection out
    const again = document.querySelector('[data-handle="connect"] circle[fill="transparent"]')!
    under.mockImplementation(() => [again])
    down(again, 3, 1)
    move(5, 1)
    expect(document.querySelector('.wire')).not.toBeNull()
    fireEvent.keyDown(window, { key: 'Escape' })
    delete (document as any).elementsFromPoint
  })
  it('fingers get a generous invisible target around every handle', () => {
    stubMedia(COARSE)
    mount(undefined, { selection: ['a'] })
    expect(handles('n')).toHaveLength(4)
    // four resize corners and the four doors a connection is pulled from
    expect(targets()).toHaveLength(8)
    for (const c of targets()) expect(Number(c.getAttribute('r'))).toBeGreaterThanOrEqual(15)
    // a press on the target starts the resize, as a press on the square does
    const corner = document.querySelector('g[data-handle="n2"] circle')!
    down(corner, 2.1, 2.1)
    move(4.1, 4.1)
    up(4.1, 4.1)
    expect(S().doc.nodes[0].scale).toBe(2)
  })
  it('targets keep their size on screen at any zoom', () => {
    stubMedia(COARSE)
    mount(undefined, { selection: ['a'] })
    act(() => { useStore.setState({ view: { x: 600, y: 300, k: 2 } }) })
    expect(Number(document.querySelector('g[data-handle="n0"] circle')!.getAttribute('r'))).toBeCloseTo(7.5)
  })
  it('leaves the resize corners out when the component is too small on screen for fingers to tell them apart', () => {
    stubMedia(COARSE)
    mount(undefined, { selection: ['a'] })
    act(() => { useStore.setState({ view: { x: 600, y: 300, k: 0.5 } }) })
    expect(handles('n')).toHaveLength(0)
    expect(document.querySelector('[data-handle="connect"]')).not.toBeNull()
    // a bigger component earns them back at the same zoom
    act(() => { S().patchNode('a', { scale: 2 }) })
    expect(handles('n')).toHaveLength(4)
  })
  it('area corners get the larger target too', () => {
    stubMedia(COARSE)
    mount(docOf([], [], { areas: [area('r', 0, 0, 6, 4)] }), { selection: ['r'] })
    expect(handles('r')).toHaveLength(4)
    expect(targets()).toHaveLength(4)
    down(targets()[2], 6, 4)
    move(8, 5)
    up(8, 5)
    expect(S().doc.areas[0]).toMatchObject({ w: 8, d: 5 })
  })
  it('on a phone the selected component has its four doors too, each with a fingertip of room', () => {
    stubMedia((q) => PHONE(q) || COARSE(q))
    mount(undefined, { selection: ['a'] })
    const doors = [...document.querySelectorAll('[data-handle="connect"]')]
    expect(doors.map((d) => d.getAttribute('data-side')).sort()).toEqual(['e', 'n', 's', 'w'])
    for (const d of doors) expect(Number(d.querySelector('circle')!.getAttribute('r'))).toBeGreaterThanOrEqual(20)
    expect(handles('n')).toHaveLength(4)
  })
  it('the empty canvas speaks to both kinds of device', () => {
    mount(docOf())
    expect(document.querySelector('.empty-sub.not-phone')).toHaveTextContent('Drag a component in from the library')
    expect(document.querySelector('.empty-sub.only-phone')).toHaveTextContent('Tap Add below to place your first component.')
  })
})

describe('double-click', () => {
  it('opens the inspector if it was put away', () => {
    mount(undefined, { showInsp: false, showLib: true, panel: 'budget' })
    vi.mocked(document.elementFromPoint).mockReturnValue(hit('node', 'a'))
    const before = S().focusName
    fireEvent.doubleClick(svg(), at(1, 1))
    expect(S()).toMatchObject({ showInsp: true, panel: 'inspect', showLib: true })
    expect(S().focusName).toBe(before + 1)
  })
  it('on a narrow screen it takes the library\'s place', () => {
    vi.stubGlobal('innerWidth', 390)
    mount(undefined, { showInsp: false, showLib: true })
    vi.mocked(document.elementFromPoint).mockReturnValue(hit('node', 'a'))
    fireEvent.doubleClick(svg(), at(1, 1))
    expect(S()).toMatchObject({ showInsp: true, showLib: false })
  })
})

describe('shaping a connection', () => {
  const linked = (extra: object = {}, state: object = {}) => mount(
    docOf([node('a', 'ec2', 0, 0, { name: 'web' }), node('b', 'rds', 8, 0, { name: 'db' }), node('c', 'sqs', 8, 8, { name: 'jobs' })], [edge('e', 'a', 'b', extra)]),
    { selection: ['e'], ...state },
  )
  const E = () => S().doc.edges[0]
  const handle = (name: string) => document.querySelector(`[data-handle="${name}"]`)!
  const names = () => [...new Set([...document.querySelectorAll('[data-handle]')].map((h) => h.getAttribute('data-handle')!))].sort()

  // b four cells down from a: the line between them is a Z, out of a at y = 1, down at x = 5, into b at y = 5
  const bent = (extra: object = {}, state: object = {}) => mount(
    docOf([node('a', 'ec2', 0, 0, { name: 'web' }), node('b', 'rds', 8, 4, { name: 'db' })], [edge('e', 'a', 'b', extra)]),
    { selection: ['e'], ...state },
  )
  const track = { fromSide: 'e', toSide: 'w', fromAt: 0, toAt: 0 } as const
  const drawn = () => document.querySelector('.edge-hit')!.getAttribute('d')!

  it('a selected connection shows its two ends, each run and each turn as something to take hold of, and both components marked', () => {
    linked()
    expect(names()).toEqual(['ea', 'eb', 's0'])
    // the two components it joins are outlined along with the line
    expect(document.querySelectorAll('.overlay path[stroke-opacity="0.8"]')).toHaveLength(2)
    cleanup()
    bent()
    expect(names()).toEqual(['c1', 'c2', 'ea', 'eb', 's0', 's1', 's2'])
    expect(document.querySelectorAll('.turn-grip')).toHaveLength(2)
    // a grip in the middle of each run long enough to hold one
    expect(document.querySelectorAll('.run-grip').length).toBe(6)
  })
  it('shows no handles when it is one of several things selected, or while another tool is up', () => {
    linked({}, { selection: ['e', 'a'] })
    expect(names().filter((n) => /^(ea|eb|[sc]\d)$/.test(n))).toEqual([])
    cleanup()
    linked({}, { tool: 'connect' })
    expect(names().filter((n) => /^(ea|eb|[sc]\d)$/.test(n))).toEqual([])
  })
  it('a direct line or a curve has ends to move but no runs', () => {
    linked({ shape: 'direct' })
    expect(names()).toEqual(['ea', 'eb'])
    cleanup()
    linked({ shape: 'curved' })
    expect(names()).toEqual(['ea', 'eb'])
    expect(drawn()).toContain('C')
  })
  it('pulling a run moves just that run: shown as it goes, written once when it is let go', () => {
    bent()
    const was = drawn()
    down(handle('s1'), 5, 3)
    move(3.6, 3)
    move(3.2, 3)
    // in the hand: drawn where it is, and not yet part of the blueprint
    expect(drawn()).not.toBe(was)
    expect(E().runs).toBeUndefined()
    expect(S().past).toHaveLength(0)
    up(3.2, 3)
    expect(E()).toMatchObject({ ...track, runs: [3.2] })
    expect(S().past).toHaveLength(1)
    act(() => S().undo())
    expect(E().runs).toBeUndefined()
    expect(drawn()).toBe(was)
    expect(S().selection).toEqual(['e']) // still selected, still ready to be shaped
  })
  it('a run goes exactly where it is put, and cannot be pushed into the component at its end', () => {
    bent()
    drag(handle('s1'), [5, 3], [6.3, 3])
    expect(E().runs).toEqual([6.3])
    drag(handle('s1'), [6.3, 3], [0, 3])
    expect(E().runs).toEqual([2.3])
  })
  it('moves as far as the pointer moves, wherever across its width it was caught: no jump as it is picked up', () => {
    bent()
    // caught a fifth of a cell to one side of the line, and pulled one cell
    drag(handle('s1'), [5.2, 3], [6.2, 3])
    expect(E().runs).toEqual([6])
  })
  it('what is on screen as it is let go is what is kept: the drawn line does not change on release', () => {
    bent()
    down(handle('s1'), 5, 3); move(6.37, 3)
    const held = drawn()
    up(6.37, 3)
    expect(drawn()).toBe(held)
    // nor when it is deselected, or picked again
    act(() => S().select([]))
    expect(drawn()).toBe(held)
    act(() => S().select(['e']))
    expect(drawn()).toBe(held)
  })
  it('the same place is reached whether the pointer went there in one move or a hundred', () => {
    bent()
    drag(handle('s1'), [5, 3], [3.37, 3])
    const fast = E().runs
    act(() => S().undo())
    down(handle('s1'), 5, 3)
    for (let i = 1; i <= 100; i++) move(5 - (1.63 * i) / 100, 3 + Math.sin(i))
    up(3.37, 3)
    expect(E().runs).toEqual(fast)
    expect(S().past).toHaveLength(1)
  })
  it('goes only where it is put. With snapping on it settles on what it would line up with from a few pixels away; Ctrl flips that for one drag, and Alt holds all of it off', () => {
    // a Z between a (middle y = 1) and b (middle y = 2) whose last run is at y = 2: the first run can come as far as y = 1.85
    const near = (state: object = {}) => mount(docOf([node('a'), node('b', 'rds', 8, 1)], [edge('e', 'a', 'b', { ...track, fromAt: -0.5, runs: [5] })]), { selection: ['e'], ...state })
    near()
    drag(handle('s0'), [3, 0.5], [3, 1.84])
    expect(E()).toMatchObject({ fromAt: 0.84, runs: [5] })
    // with snapping off, Ctrl turns it on for the one drag; Alt does not
    act(() => S().undo())
    drag(handle('s0'), [3, 0.5], [3, 1.84], { ctrlKey: true })
    expect(E().runs).toEqual([])
    act(() => S().undo())
    drag(handle('s0'), [3, 0.5], [3, 1.84], { altKey: true })
    expect(E()).toMatchObject({ fromAt: 0.84, runs: [5] })
    cleanup(); near({ snap: true })
    drag(handle('s0'), [3, 0.5], [3, 1.84])
    expect(E().runs).toEqual([])
    cleanup(); near({ snap: true })
    drag(handle('s0'), [3, 0.5], [3, 1.84], { ctrlKey: true })
    expect(E()).toMatchObject({ fromAt: 0.84, runs: [5] })
    cleanup(); near({ snap: true })
    drag(handle('s0'), [3, 0.5], [3, 1.84], { altKey: true })
    expect(E()).toMatchObject({ fromAt: 0.84, runs: [5] })
  })
  it('a run let go a few pixels short of level with the next one along is level, with snapping off: the kink is never made', () => {
    // runs at y 1, x 3, y 7, x 6, y 5: the middle one is brought up to within three pixels of the first
    const zig = () => mount(docOf([node('a'), node('b', 'rds', 8, 4)], [edge('e', 'a', 'b', { ...track, runs: [3, 7, 6] })]), { selection: ['e'] })
    zig()
    expect(S().snap).toBe(false)
    drag(handle('s2'), [4.5, 7], [4.5, 1.07])
    expect(E()).toMatchObject({ fromAt: 0, toAt: 0, runs: [6] })
    // what was on screen as it was let go is what was kept
    expect(S().past).toHaveLength(1)
    // a deliberate offset, a quarter of a cell, is kept as made
    cleanup(); zig()
    drag(handle('s2'), [4.5, 7], [4.5, 1.25])
    expect(E().runs).toEqual([3, 1.25, 6])
    // and Alt keeps even a hair of one
    cleanup(); zig()
    drag(handle('s2'), [4.5, 7], [4.5, 1.07], { altKey: true })
    expect(E().runs).toEqual([3, 1.07, 6])
  })
  it('once level it stays level until it is pulled clear, so it cannot flicker at the edge', () => {
    mount(docOf([node('a'), node('b', 'rds', 8, 4)], [edge('e', 'a', 'b', { ...track, runs: [3, 7, 6] })]), { selection: ['e'] })
    down(handle('s2'), 4.5, 7); move(4.5, 4); move(4.5, 1.05)
    move(4.5, 1.13) // past where it would have been caught, but not yet clear
    up(4.5, 1.13)
    expect(E().runs).toEqual([6])
    act(() => S().undo())
    down(handle('s2'), 4.5, 7); move(4.5, 4); move(4.5, 1.13); up(4.5, 1.13)
    expect(E().runs).toEqual([3, 1.13, 6])
  })
  it('a turn taken in the hand moves both runs that meet at it', () => {
    bent()
    // the turn at (5, 1), where the first run meets the one going down
    drag(handle('c1'), [5, 1], [4.2, 1.6])
    expect(E()).toMatchObject({ ...track, fromAt: 0.6, runs: [4.2] })
    expect(S().past).toHaveLength(1)
    // and the other, at (4.2, 5): the run going down and the end at b
    drag(handle('c2'), [4.2, 5], [6.1, 4.7])
    expect(E()).toMatchObject({ fromAt: 0.6, toAt: -0.3, runs: [6.1] })
  })
  it('double-click on a turn takes it out; where the ends are not in line and it cannot go, nothing happens', () => {
    bent({ ...track, runs: [3, 7, 6] })
    expect(names().filter((n) => n[0] === 'c')).toEqual(['c1', 'c2', 'c3', 'c4'])
    const spy = vi.spyOn(document, 'elementFromPoint').mockReturnValue(handle('c2'))
    fireEvent.doubleClick(svg(), at(3, 7))
    expect(E().runs).toEqual([6])
    expect(S().past).toHaveLength(1)
    spy.mockReturnValue(handle('c1'))
    fireEvent.doubleClick(svg(), at(6, 1))
    expect(E().runs).toEqual([6])
    expect(S().past).toHaveLength(1)
    spy.mockRestore()
  })
  it('a press on a run that never moves, or barely moves, changes nothing', () => {
    bent()
    down(handle('s1'), 5, 3); up(5, 3)
    down(handle('s1'), 5, 3); move(5.02, 3); up(5.02, 3)
    expect(E().runs).toBeUndefined()
    expect(S().past).toHaveLength(0)
  })
  it('the first run pulled level with the last makes the line straight: the turn between them is taken out', () => {
    // a is at y 0 to 2 and b at y 1 to 3, with a Z laid between them
    mount(docOf([node('a'), node('b', 'rds', 8, 1)], [edge('e', 'a', 'b', { ...track, runs: [5] })]), { selection: ['e'], snap: true })
    expect(names()).toEqual(['c1', 'c2', 'ea', 'eb', 's0', 's1', 's2'])
    down(handle('s0'), 3, 1)
    move(3, 1.84) // near enough to where the two ends can meet (y = 1.85) to be drawn onto that line
    expect(names()).toContain('ea')
    up(3, 1.84)
    expect(E().runs).toEqual([])
    expect(E().fromAt! + 1).toBe(E().toAt! + 2) // both ends on one line
    expect(names()).toEqual(['ea', 'eb', 's0'])
    expect(S().past).toHaveLength(1)
  })
  it('a straight line pulled sideways slides along both components, and past their corners steps out and round', () => {
    linked({}, { snap: true })
    drag(handle('s0'), [5, 1], [5, 1.5])
    expect(E()).toMatchObject({ fromAt: 0.5, toAt: 0.5, runs: [] })
    drag(handle('s0'), [5, 1.5], [5, 4])
    expect(E()).toMatchObject({ fromAt: 0.85, toAt: 0.85, runs: [2.5, 4, 7.5] })
    expect(names()).toEqual(['c1', 'c2', 'c3', 'c4', 'ea', 'eb', 's0', 's1', 's2', 's3', 's4'])
    // and pulled back onto the line its ends are on, it is straight again
    drag(handle('s2'), [5, 4], [5, 1.84])
    expect(E().runs).toEqual([])
  })
  it('putting a run back where it was takes no undo step', () => {
    bent({ ...track, runs: [5] })
    down(handle('s1'), 5, 3); move(3, 3); move(5, 3); up(5, 3)
    expect(S().past).toHaveLength(0)
  })
  it('an older line through a point becomes a track the moment a run of it is moved, and its dead end goes', () => {
    linked({ via: [[5, 4]] })
    drag(handle('s1'), [5, 2], [3, 2])
    expect(E().via).toBeUndefined()
    expect(E().runs).toEqual([])
  })
  it('Escape puts a run back exactly as it was', () => {
    bent()
    const was = drawn()
    down(handle('s1'), 5, 3); move(3, 3)
    fireEvent.keyDown(window, { key: 'Escape' })
    up(3, 3)
    expect(E().runs).toBeUndefined()
    expect(drawn()).toBe(was)
    expect(S().past).toHaveLength(0)
  })
  it('the bar at the line straightens it, changes how it is drawn, and hands it back to the router', () => {
    linked({ ...track, runs: [2.5, 4, 7.5] })
    const bar = document.querySelector('.edge-bar')!
    const press = (name: string) => fireEvent.click(bar.querySelector(`[aria-label="${name}"]`)!)
    press('Straighten')
    expect(E().runs).toEqual([])
    expect(bar.querySelector('[aria-label="Straighten"]')).toBeDisabled()
    press('Curved')
    expect(E().shape).toBe('curved')
    expect(bar.querySelector('[aria-label="Curved"]')).toHaveAttribute('aria-pressed', 'true')
    press('Direct')
    expect(E().shape).toBe('direct')
    press('Right-angled')
    expect(E().shape).toBeUndefined()
    // whose line it is shows on the bar: the router's now, and the user's once they keep the path or shape it
    expect(bar.querySelector('[aria-label="Route automatically"]')).toHaveAttribute('aria-pressed', 'true')
    expect(bar.querySelector('[aria-label="Keep this path"]')).toHaveAttribute('aria-pressed', 'false')
    const was = drawn()
    press('Keep this path')
    expect(E().runs).toEqual([])
    expect(drawn()).toBe(was)
    expect(bar.querySelector('[aria-label="Keep this path"]')).toHaveAttribute('aria-pressed', 'true')
    expect(bar.querySelector('[aria-label="Route automatically"]')).toHaveAttribute('aria-pressed', 'false')
    press('Route automatically')
    expect(E().runs).toBeUndefined()
    press('Curved')
    expect(bar.querySelector('[aria-label="Keep this path"]')).toBeDisabled()
  })
  it('for two components that are out of line the bar offers to line them up, and for one with something between says what straight will mean', () => {
    bent()
    const wide = () => document.querySelector('.edge-bar .wide')!
    expect(wide()).toHaveAttribute('aria-label', 'Line up')
    fireEvent.click(wide())
    expect(S().doc.nodes[1]).toMatchObject({ x: 8, y: 0 })
    expect(E().runs).toEqual([])
    cleanup()
    mount(docOf([node('a'), node('b', 'rds', 10, 0), node('x', 's3', 5, 0)], [edge('e', 'a', 'b')]), { selection: ['e'] })
    expect(wide().getAttribute('data-tip')).toMatch(/passing under/)
  })
  it('the bar sits above the whole line, and goes away while something is in the hand', () => {
    bent()
    const bar = document.querySelector<HTMLElement>('.edge-bar')!
    const top = Math.min(at(2, 1).clientY, at(8, 5).clientY)
    expect(parseFloat(bar.style.top)).toBeLessThan(top)
    down(handle('s1'), 5, 3); move(3, 3)
    expect(document.querySelector('.edge-bar')).toBeNull()
    up(3, 3)
    expect(document.querySelector('.edge-bar')).not.toBeNull()
  })
  it('dragging an end onto another component reconnects it there', () => {
    linked()
    down(handle('eb'), 8, 1)
    vi.mocked(document.elementFromPoint).mockReturnValue(hit('node', 'c'))
    move(9, 9)
    expect(document.querySelector('.wire')).not.toBeNull()
    up(9, 9) // its middle: the router picks the side
    expect(E()).toMatchObject({ from: 'a', to: 'c' })
    expect(E().toSide).toBeUndefined()
    expect(document.querySelector('.wire')).toBeNull()
    expect(S().past).toHaveLength(1)
  })
  it('aiming an end at one of a component\'s doors pins that side; anywhere else on it leaves the router to choose', () => {
    linked()
    down(handle('eb'), 8, 1)
    vi.mocked(document.elementFromPoint).mockReturnValue(hit('node', 'b'))
    move(9, -0.4) // the door in the middle of its far side
    // the door being aimed at says so
    expect(document.querySelector('.door.aimed')).toHaveAttribute('data-side', 'n')
    up(9, -0.4)
    expect(E()).toMatchObject({ to: 'b', toSide: 'n' })
    down(handle('eb'), 9, 2)
    move(9.3, 1.2); up(9.3, 1.2) // on the body, at no door in particular
    expect(E().toSide).toBeUndefined()
  })
  it('dropping an end on bare ground leaves the connection as it was', () => {
    linked()
    drag(handle('ea'), [2, 1], [4, 6])
    expect(E()).toMatchObject({ from: 'a', to: 'b' })
    expect(S().past).toHaveLength(0)
  })
  it('refuses to put both ends on one component, and says why', () => {
    linked()
    down(handle('eb'), 8, 1)
    vi.mocked(document.elementFromPoint).mockReturnValue(hit('node', 'a'))
    move(1, 1); up(1, 1)
    expect(E()).toMatchObject({ from: 'a', to: 'b' })
    expect(S().toasts.at(-1)!.text).toMatch(/two different components/)
  })
  it('a click on an end that never moves does nothing', () => {
    linked()
    down(handle('ea'), 2, 1); up(2, 1)
    expect(E()).toMatchObject({ from: 'a', to: 'b' })
    expect(document.querySelector('.wire')).toBeNull()
  })
  it('fingers get a generous invisible target around each end and along every run', () => {
    stubMedia(COARSE)
    bent()
    for (const n of ['ea', 'eb']) {
      const big = [...document.querySelectorAll(`[data-handle="${n}"]`)].find((el) => el.getAttribute('fill') === 'transparent')!
      expect(Number(big.getAttribute('r'))).toBeGreaterThanOrEqual(17)
    }
    expect(Number(handle('s1').querySelector('line')!.getAttribute('stroke-width'))).toBeGreaterThanOrEqual(30)
  })
  it('a finger that rests on the line and lifts without pulling it gets the line\'s menu; one that pulls, however slowly it starts, never does', () => {
    stubMedia(COARSE)
    vi.useFakeTimers()
    bent()
    const o = { pointerType: 'touch', pointerId: 32 }
    const spy = vi.spyOn(document, 'elementFromPoint').mockImplementation(() => handle('s1'))
    // rested well past a press-and-hold, then pulled: it is a pull, and no menu comes up during it or after
    down(handle('s1'), 5, 3, o)
    act(() => { vi.advanceTimersByTime(HOLD_MS * 3) })
    expect(document.querySelector('.ctx-menu')).toBeNull()
    move(4.2, 3, o); up(4.2, 3, o)
    act(() => { vi.advanceTimersByTime(500) })
    expect(document.querySelector('.ctx-menu')).toBeNull()
    expect(E().runs).toEqual([4.2])
    // a quick tap is neither
    down(handle('s1'), 4.2, 3, o); up(4.2, 3, o)
    act(() => { vi.advanceTimersByTime(500) })
    expect(document.querySelector('.ctx-menu')).toBeNull()
    // rested and lifted: the menu, once the tap that the lifting finger counts as has gone by
    down(handle('s1'), 4.2, 3, o)
    act(() => { vi.advanceTimersByTime(HOLD_MS + 20) })
    up(4.2, 3, o)
    expect(document.querySelector('.ctx-menu')).toBeNull()
    act(() => { vi.advanceTimersByTime(100) })
    expect([...document.querySelectorAll('.ctx-menu button span')].map((b) => b.textContent)).toContain('Add a bend here')
    expect(E().runs).toEqual([4.2])
    spy.mockRestore()
    vi.useRealTimers()
  })
  it('a right-click on the handles the selected line wears opens the line\'s menu, not the canvas\'s', () => {
    bent()
    const spy = vi.spyOn(document, 'elementFromPoint').mockReturnValue(handle('s1'))
    fireEvent.pointerDown(handle('s1'), { pointerId: 1, button: 2, ...at(5, 3) })
    fireEvent.pointerUp(svg(), { pointerId: 1, button: 2, ...at(5, 3) })
    expect(S().selection).toEqual(['e'])
    expect([...document.querySelectorAll('.ctx-menu button span')].map((b) => b.textContent)).toContain('Add a bend here')
    spy.mockRestore()
  })
  it('a finger drags a run without panning the view, with a tick when a turn drops out', () => {
    stubMedia(COARSE)
    const buzz = vi.fn<(n: number) => boolean>(() => true)
    vi.stubGlobal('navigator', { ...navigator, vibrate: buzz })
    mount(docOf([node('a'), node('b', 'rds', 8, 1)], [edge('e', 'a', 'b', { ...track, runs: [5] })]), { selection: ['e'], snap: true })
    const view = S().view
    const o = { pointerType: 'touch', pointerId: 31 }
    down(handle('s0'), 3, 1, o); move(3, 1.5, o); move(3, 1.86, o); up(3, 1.86, o) // let go just by the line where the two ends can meet
    expect(E().runs).toEqual([])
    expect(S().view).toEqual(view)
    expect(buzz).toHaveBeenCalled()
  })
})

describe('following a flow on the canvas', () => {
  const chain = (state: object = {}) => mount(
    docOf([node('a', 'ec2', 0, 0, { name: 'web' }), node('b', 'rds', 8, 0, { name: 'db' }), node('c', 'sqs', 8, 8, { name: 'jobs' }), node('z', 's3', 20, 20, { name: 'apart' })], [edge('e', 'a', 'b'), edge('f', 'a', 'c')]),
    state,
  )
  const nodeEl = (id: string) => hit('node', id) as Element
  const edgeEl = (id: string) => hit('edge', id).closest('.edge')!
  it('nothing steps back until a flow is being followed', () => {
    chain()
    expect(document.querySelectorAll('.nd.off, .edge.off, .edge.on')).toHaveLength(0)
  })
  it('what is on the paths stays lit and shows its direction; the rest steps back', () => {
    chain({ trace: 'b' })
    expect(nodeEl('a')).not.toHaveClass('off'); expect(nodeEl('b')).not.toHaveClass('off')
    expect(nodeEl('c')).toHaveClass('off'); expect(nodeEl('z')).toHaveClass('off')
    expect(edgeEl('e')).toHaveClass('on'); expect(edgeEl('f')).toHaveClass('off')
    expect(edgeEl('e').querySelector('.edge-flow')).not.toBeNull()
    expect(edgeEl('f').querySelector('.edge-flow')).toBeNull()
  })
  it('a dependency never shows movement, because nothing travels along it', () => {
    mount(docOf([node('a'), node('b', 'rds', 8, 0)], [edge('e', 'a', 'b', { kind: 'dependency' })]), { trace: 'a', flow: true })
    expect(edgeEl('e')).toHaveClass('on')
    expect(edgeEl('e').querySelector('.edge-flow')).toBeNull()
  })
  it('a connection that no longer exists is simply not followed', () => {
    chain({ trace: 'gone' })
    expect(document.querySelectorAll('.nd.off, .edge.off')).toHaveLength(0)
  })
})

describe('what a connection shows', () => {
  it('writes its label, protocol and port along the line', () => {
    mount(docOf([node('a'), node('b', 'rds', 8, 0)], [edge('e', 'a', 'b', { label: 'orders', protocol: 'PostgreSQL', port: '5432' })]))
    expect(hit('edge', 'e').closest('.edge')!.querySelector('text')).toHaveTextContent('ORDERS · POSTGRESQL 5432')
  })
  it('previews a new connection along the route it would take', () => {
    mount(docOf([node('a'), node('b', 'rds', 8, 0), node('w', 's3', 4, 0)]), { selection: ['a'] })
    down(document.querySelector('[data-handle="connect"]')!, 1, 1)
    vi.mocked(document.elementFromPoint).mockReturnValue(hit('node', 'b'))
    move(9, 1)
    // not a straight line through the component in between
    expect(document.querySelector('.wire path')!.getAttribute('d')!.match(/[LQ]/g)!.length).toBeGreaterThan(2)
    up(9, 1)
  })
})

// ---- direct manipulation: what is in the hand, doors, and forgiving connections -----------------------------

const hover = (el: Element, wx: number, wy: number) => fireEvent.pointerMove(el, { pointerId: 1, pointerType: 'mouse', ...at(wx, wy) })
const doorsOf = (id: string) => [...document.querySelectorAll(`.door[data-id="${id}"]`)]
const doorOf = (id: string, side: string) => document.querySelector(`.door[data-id="${id}"][data-side="${side}"]`)!
const quick = () => screen.queryByRole('dialog', { name: 'Add and connect a component' })

describe('doors', () => {
  it('show on the component under the pointer, with nothing selected and no tool chosen', () => {
    mount()
    expect(document.querySelectorAll('.door')).toHaveLength(0)
    hover(hit('node', 'b'), 9, 1)
    expect(doorsOf('b').map((d) => d.getAttribute('data-side')).sort()).toEqual(['e', 'n', 's', 'w'])
    expect(document.querySelector('.hover-mark')).not.toBeNull()
    expect(S().selection).toEqual([])
  })
  it('stay while the pointer leaves the body to reach one, and go when it moves away', () => {
    mount()
    hover(hit('node', 'b'), 9, 1)
    hover(svg(), 10.6, 1) // off the body, on the way to the east door
    expect(doorsOf('b')).toHaveLength(4)
    hover(doorOf('b', 'e'), 10.42, 1)
    expect(doorsOf('b')).toHaveLength(4)
    hover(svg(), 14, 1)
    expect(document.querySelectorAll('.door')).toHaveLength(0)
    hover(hit('node', 'b'), 9, 1)
    fireEvent.pointerLeave(svg())
    expect(document.querySelectorAll('.door')).toHaveLength(0)
  })
  it('the one on the side the name is written sits further out, clear of the text, unless names are hidden', () => {
    mount(undefined, { selection: ['a'] })
    const far = () => SIDE_OUT().filter((d) => d > 0.9).length
    const SIDE_OUT = () => doorsOf('a').map((d) => {
      const c = d.querySelector('.door-dot')!, v = S().view
      const [wx, wy] = unproject(projNow(), (Number(c.getAttribute('cx'))), (Number(c.getAttribute('cy'))))
      void v
      return Math.max(Math.abs(wx - 1), Math.abs(wy - 1)) - 1
    })
    expect(far()).toBe(1)
    act(() => { useStore.setState({ showLabels: false }) })
    expect(far()).toBe(0)
  })
  it('a touch does not show them by hovering, and other tools do not show them at all', () => {
    mount()
    fireEvent.pointerMove(hit('node', 'b'), { pointerId: 1, pointerType: 'touch', ...at(9, 1) })
    expect(document.querySelectorAll('.door')).toHaveLength(0)
    act(() => { useStore.setState({ tool: 'area' }) })
    hover(hit('node', 'b'), 9, 1)
    expect(document.querySelectorAll('.door')).toHaveLength(0)
  })
  it('the selected component keeps its doors while the pointer is elsewhere, and another under the pointer shows its own', () => {
    mount(undefined, { selection: ['a'] })
    expect(doorsOf('a')).toHaveLength(4)
    hover(hit('node', 'b'), 9, 1)
    expect(document.querySelectorAll('.door')).toHaveLength(8)
    // the selected one is already marked: no second mark for it under the pointer
    hover(hit('node', 'a'), 1, 1)
    expect(document.querySelector('.hover-mark')).toBeNull()
  })
})

describe('pulling a connection', () => {
  const pull = (id: string, side: string, to: [number, number], under: Element = svg()) => {
    hover(hit('node', id), ...(id === 'a' ? [1, 1] : [9, 1]) as [number, number])
    const d = doorOf(id, side), c = d.querySelector('.door-dot')!
    const from = unproject(projNow(), Number(c.getAttribute('cx')), Number(c.getAttribute('cy')))
    down(d, from[0], from[1])
    vi.mocked(document.elementFromPoint).mockReturnValue(under as Element)
    move(...to)
  }
  it('from a door of a component that was never selected, to somewhere near another: one gesture, one connection', () => {
    mount()
    pull('a', 'e', [7.3, 1.2]) // most of a cell short of `b`
    expect(document.querySelector('.wire.caught')).not.toBeNull()
    expect(document.querySelector('.wire-target')).not.toBeNull()
    // what it has caught offers its own doors
    expect(doorsOf('b')).toHaveLength(4)
    expect(doorsOf('a')).toHaveLength(0)
    up(7.3, 1.2)
    expect(S().doc.edges).toHaveLength(1)
    expect(S().doc.edges[0]).toMatchObject({ from: 'a', to: 'b', origin: 'drawn' })
    expect(S().doc.edges[0].toSide).toBeUndefined()
    expect(S().selection).toEqual([S().doc.edges[0].id])
    expect(S().past).toHaveLength(1)
    expect(document.querySelector('.wire')).toBeNull()
  })
  it('out in the open it is a loose end: one elbow to the pointer, dashed, with a dot at its tip', () => {
    mount()
    pull('a', 'e', [5, 4])
    const wire = document.querySelector('.wire')!
    expect(wire).not.toHaveClass('caught')
    expect(wire.querySelector('path')).toHaveAttribute('stroke-dasharray')
    expect(wire.querySelector('circle')).not.toBeNull()
    expect(wire.querySelector('polygon')).toBeNull()
    expect(document.querySelector('.wire-target')).toBeNull()
    up(5, 4)
  })
  it('caught, it is drawn solid with its arrowhead, as the line it will become', () => {
    mount()
    pull('a', 'e', [9, 1], hit('node', 'b'))
    const wire = document.querySelector('.wire.caught')!
    expect(wire.querySelector('path')).not.toHaveAttribute('stroke-dasharray')
    expect(wire.querySelector('polygon')).not.toBeNull()
    up(9, 1)
  })
  it('aimed at one door, the line arrives there, in the same undo step', () => {
    mount()
    pull('a', 'e', [9, -0.42])
    expect(document.querySelector('.door.aimed')).toHaveAttribute('data-side', 'n')
    up(9, -0.42)
    expect(S().doc.edges[0]).toMatchObject({ from: 'a', to: 'b', toSide: 'n' })
    expect(S().past).toHaveLength(1)
  })
  it('says while it is still in the hand that two components are joined already, then shows the line that joins them', () => {
    mount(docOf([node('a'), node('b', 'rds', 8, 0)], [edge('e', 'b', 'a')]))
    pull('a', 'e', [9, 1], hit('node', 'b'))
    expect(document.querySelector('.wire-target')).toHaveClass('bad')
    expect(document.querySelector('.wire.caught')).toBeNull()
    expect(document.querySelectorAll('.door')).toHaveLength(0)
    up(9, 1)
    expect(S().doc.edges).toHaveLength(1)
    expect(S().selection).toEqual(['e'])
    expect(S().toasts.at(-1)).toMatchObject({ text: 'Those components are already connected', kind: 'warn' })
    expect(S().past).toHaveLength(0)
  })
  it('let go on open ground it asks what to put there, and adds it connected as one step', async () => {
    mount()
    pull('a', 's', [1, 8])
    up(1, 8)
    expect(quick()).not.toBeNull()
    // the loose end waits where it was let go
    expect(document.querySelector('.wire')).not.toBeNull()
    expect(S().doc.nodes).toHaveLength(2)
    await userEvent.type(screen.getByRole('combobox', { name: 'Search components' }), 'queue')
    expect(screen.getAllByRole('option')[0]).toHaveTextContent('Queue')
    await userEvent.keyboard('{Enter}')
    expect(quick()).toBeNull()
    expect(document.querySelector('.wire')).toBeNull()
    expect(S().doc.nodes).toHaveLength(3)
    expect(S().doc.nodes[2]).toMatchObject({ type: 'sqs', x: 0, y: 7 })
    expect(S().doc.edges).toHaveLength(1)
    expect(S().doc.edges[0]).toMatchObject({ from: 'a', to: S().doc.nodes[2].id })
    expect(S().past).toHaveLength(1)
    act(() => S().undo())
    expect([S().doc.nodes.length, S().doc.edges.length]).toEqual([2, 0])
  })
  it('what it adds never lands on something that is already there', async () => {
    mount(docOf([node('a'), node('b', 'rds', 8, 0), node('c', 's3', 0, 7)]))
    pull('a', 's', [1.2, 6.4]) // short of `c`, out of its reach, but where a new component would overlap it
    vi.mocked(document.elementFromPoint).mockReturnValue(svg())
    act(() => { useStore.setState({ view: { x: 600, y: 300, k: 4 } }) }) // zoomed in, so reach is small
    move(1.2, 5.2); up(1.2, 5.2)
    await userEvent.click(screen.getAllByRole('option')[0])
    const made = S().doc.nodes[3], c = S().doc.nodes[2]
    expect(made.x + 2 <= c.x || c.x + 2 <= made.x || made.y + 2 <= c.y || c.y + 2 <= made.y).toBe(true)
    expect(S().doc.nodes.every((n) => n === made || made.x + 2 <= n.x || n.x + 2 <= made.x || made.y + 2 <= n.y || n.y + 2 <= made.y)).toBe(true)
  })
  it('Escape in the search, or a press anywhere else, answers "nothing": nothing is added and the loose end goes', async () => {
    mount()
    pull('a', 's', [1, 8]); up(1, 8)
    await userEvent.keyboard('{Escape}')
    expect(quick()).toBeNull()
    expect(document.querySelector('.wire')).toBeNull()
    pull('a', 's', [1, 8]); up(1, 8)
    expect(quick()).not.toBeNull()
    fireEvent.pointerDown(svg(), { pointerId: 1, button: 0, ...at(12, 6) })
    fireEvent.pointerUp(svg(), { pointerId: 1, ...at(12, 6) })
    expect(quick()).toBeNull()
    expect(document.querySelector('.wire')).toBeNull()
    expect(S().doc.nodes).toHaveLength(2)
    expect(S().past).toHaveLength(0)
  })
  it('a pull that barely leaves its own component is not a question about open ground', () => {
    mount()
    pull('a', 'e', [3, 1.5])
    up(3, 1.5)
    expect(quick()).toBeNull()
    expect(document.querySelector('.wire')).toBeNull()
    expect(S().doc.edges).toHaveLength(0)
  })
  it('Escape drops a line that is being pulled', () => {
    mount()
    pull('a', 'e', [9, 1], hit('node', 'b'))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(document.querySelector('.wire')).toBeNull()
    up(9, 1)
    expect(S().doc.edges).toHaveLength(0)
  })
  it('a finger gets a longer reach than a mouse', () => {
    mount(undefined, { selection: ['a'] })
    const d = doorOf('a', 'e')
    fireEvent.pointerDown(d, { pointerId: 1, button: 0, pointerType: 'touch', ...at(2.42, 1) })
    fireEvent.pointerMove(svg(), { pointerId: 1, pointerType: 'touch', ...at(6.95, 1) }) // more than a cell short
    expect(document.querySelector('.wire.caught')).not.toBeNull()
    fireEvent.pointerUp(svg(), { pointerId: 1, pointerType: 'touch', ...at(6.95, 1) })
    expect(S().doc.edges).toHaveLength(1)
  })
})

describe('moving an end of a connection', () => {
  const linked = () => mount(docOf([node('a', 'ec2', 0, 0), node('b', 'rds', 8, 0), node('c', 'sqs', 8, 8)], [edge('e', 'a', 'b', { via: [[5, 3]] })]), { selection: ['e'] })
  const handle = (name: string) => document.querySelector(`[data-handle="${name}"]`)!
  it('the line steps back while its end is in the hand, and the end catches what it is near', () => {
    linked()
    down(handle('eb'), 8, 1)
    move(7.4, 9) // beside `c`, not on it
    expect(hit('edge', 'e').closest('.edge')).toHaveClass('off')
    expect(document.querySelector('.wire.caught')).not.toBeNull()
    // the selected line's own highlight and handles are not drawn over where it used to run
    expect(document.querySelector('[data-handle="ea"]')).toBeNull()
    up(7.4, 9)
    expect(S().doc.edges[0]).toMatchObject({ from: 'a', to: 'c' })
    // a bend drawn for the way to `b` does not follow it to `c`
    expect(S().doc.edges[0].via).toBeUndefined()
    expect(hit('edge', 'e').closest('.edge')).not.toHaveClass('off')
  })
  it('moving the starting end is previewed from where it would start', () => {
    linked()
    down(handle('ea'), 2, 1)
    vi.mocked(document.elementFromPoint).mockReturnValue(hit('node', 'c'))
    move(9, 9)
    const wire = document.querySelector('.wire.caught')!
    expect(wire.querySelector('polygon')).toBeNull() // no arrowhead on the end being held
    up(9, 9)
    expect(S().doc.edges[0]).toMatchObject({ from: 'c', to: 'b' })
  })
  it('onto the component at its other end is refused while it is still in the hand', () => {
    linked()
    down(handle('eb'), 8, 1)
    vi.mocked(document.elementFromPoint).mockReturnValue(hit('node', 'a'))
    move(1, 1)
    expect(document.querySelector('.wire-target')).toHaveClass('bad')
    up(1, 1)
    expect(S().doc.edges[0]).toMatchObject({ from: 'a', to: 'b', via: [[5, 3]] })
    expect(S().toasts.at(-1)).toMatchObject({ kind: 'warn' })
  })
})

describe('carrying', () => {
  it('Escape puts it back exactly, and nothing was ever written', () => {
    mount()
    down(hit('node', 'a'), 1, 1)
    move(4.4, 2.3)
    expect(drawnAt('a')).toEqual([3.4, 1.3])
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(drawnAt('a')).toEqual([0, 0])
    expect(document.querySelector('.canvas-wrap')).not.toHaveClass('busy')
    move(6, 3); up(6, 3) // the rest of the gesture is ignored
    expect(S().doc.nodes[0]).toMatchObject({ x: 0, y: 0 })
    expect(S()).toMatchObject({ past: [], saved: true })
  })
  it('Escape also takes back the copies an alt-drag made', () => {
    mount()
    down(hit('node', 'a'), 1, 1, { altKey: true })
    move(4, 4, { altKey: true })
    expect(S().doc.nodes).toHaveLength(3)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(S().doc.nodes).toHaveLength(2)
    expect(S().past).toHaveLength(0)
  })
  it('Escape with nothing in the hand is left for the rest of the editor', () => {
    mount(undefined, { selection: ['a'] })
    const seen = vi.fn<(e: KeyboardEvent) => void>()
    window.addEventListener('keydown', seen)
    fireEvent.keyDown(window, { key: 'Escape' })
    down(hit('node', 'a'), 1, 1) // pressed, not yet carried
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(seen).toHaveBeenCalledTimes(2)
    window.removeEventListener('keydown', seen)
    up(1, 1)
  })
  it('is put exactly where it is dropped, even on another component: nothing pushes it aside', () => {
    mount()
    down(hit('node', 'a'), 1, 1)
    move(9, 1) // straight onto `b`
    up(9, 1)
    expect(S().doc.nodes[0]).toMatchObject({ x: 8, y: 0 })
    expect(S().doc.nodes[1]).toMatchObject({ x: 8, y: 0 })
    // and right up against one, a hair's breadth away
    drag(hit('node', 'a'), [9, 1], [7.03, 1.02])
    expect(S().doc.nodes[0]).toMatchObject({ x: 6.03, y: 0.02 })
    expect(S().past).toHaveLength(2)
  })
  it('shift keeps the move to the axis it has gone furthest along', () => {
    mount()
    down(hit('node', 'a'), 1, 1)
    move(4, 2.4, { shiftKey: true })
    expect(drawnAt('a')[1]).toBe(0)
    up(4, 2.4, { shiftKey: true })
    expect(S().doc.nodes[0]).toMatchObject({ x: 3, y: 0 })
    down(hit('node', 'a'), 4, 1)
    move(5.2, 6, { shiftKey: true }); up(5.2, 6, { shiftKey: true })
    expect(S().doc.nodes[0]).toMatchObject({ x: 3, y: 5 })
  })
  it('marks equal gaps as a component comes level with its neighbours at their spacing', () => {
    mount(docOf([node('a', 'ec2', 0, 0), node('b', 'rds', 6, 0), node('m', 'sqs', 13, 5)]))
    down(hit('node', 'm'), 14, 6)
    move(13, 1)
    expect(document.querySelectorAll('.gap')).toHaveLength(2)
    move(14, 1)
    expect(document.querySelectorAll('.gap')).toHaveLength(0)
    move(13, 1); up(13, 1)
    expect(document.querySelectorAll('.gap')).toHaveLength(0)
    expect(S().doc.nodes[2]).toMatchObject({ x: 12, y: 0 })
  })
  it('lights up the group it is about to join, and not the one it is already in', () => {
    mount(docOf([node('a', 'ec2', 0, 0), node('b', 'rds', 11, 1)], [], { areas: [area('r', 10, 0, 6, 6)] }))
    down(hit('node', 'a'), 1, 1)
    move(4, 1)
    expect(document.querySelector('.drop-area')).toBeNull()
    move(14.2, 4)
    expect(document.querySelector('.drop-area')).not.toBeNull()
    up(14.2, 4)
    expect(document.querySelector('.drop-area')).toBeNull()
    // moved about inside its own group, nothing lights up
    down(hit('node', 'a'), 14, 4)
    move(14, 5.2)
    expect(document.querySelector('.drop-area')).toBeNull()
    up(14, 5.2)
  })
  it('nothing is eased or adjusted after it is let go: no timers are left running that could move it', () => {
    vi.useFakeTimers()
    mount()
    drag(hit('node', 'a'), [1, 1], [3.3, 1])
    const shown = hit('node', 'a').getAttribute('transform')
    expect(document.querySelector('.canvas-wrap')).not.toHaveClass('settle')
    act(() => { vi.advanceTimersByTime(2000) })
    expect(hit('node', 'a').getAttribute('transform')).toBe(shown)
    expect(S().doc.nodes[0]).toMatchObject({ x: 2.3, y: 0 })
    expect(S().past).toHaveLength(1)
    vi.useRealTimers()
  })
  it('carried to the edge of the clear ground, the view moves on and the component with it', () => {
    vi.useFakeTimers()
    mount()
    const before = S().view.x
    down(hit('node', 'a'), 1, 1)
    fireEvent.pointerMove(svg(), { pointerId: 1, clientX: 700, clientY: 400 })
    const mid = drawnAt('a')[0]
    // the right-hand edge of the ground the inspector leaves clear
    fireEvent.pointerMove(svg(), { pointerId: 1, clientX: 860, clientY: 400 })
    act(() => { vi.advanceTimersByTime(200) })
    expect(S().view.x).toBeLessThan(before - 40)
    expect(drawnAt('a')[0]).toBeGreaterThan(mid + 1)
    // back in the middle it stops
    fireEvent.pointerMove(svg(), { pointerId: 1, clientX: 600, clientY: 400 })
    act(() => { vi.advanceTimersByTime(60) })
    const rest = S().view.x
    act(() => { vi.advanceTimersByTime(200) })
    expect(S().view.x).toBe(rest)
    fireEvent.pointerUp(svg(), { pointerId: 1, clientX: 600, clientY: 400 })
  })
  it('a very large group follows the pointer just as exactly', () => {
    const many = Array.from({ length: 48 }, (_, i) => node('n' + i, 'ec2', (i % 8) * 4, Math.floor(i / 8) * 4))
    mount(docOf(many), { selection: many.map((n) => n.id) })
    down(hit('node', 'n0'), 1, 1)
    move(1.37, 1)
    expect(drawnAt('n0')[0]).toBe(0.37)
    move(3.2, 1); up(3.2, 1)
    expect(S().doc.nodes[0].x).toBe(2.2)
    expect(S().doc.nodes[47].x).toBe(30.2)
  })
  it('an area corner is shown where it is dragged and written when it is let go', () => {
    mount(docOf([], [], { areas: [area('r', 0, 0, 6, 4)] }), { selection: ['r'] })
    down(document.querySelector('[data-handle="r2"]')!, 6, 4)
    move(8, 5)
    expect(S().doc.areas[0]).toMatchObject({ w: 6, d: 4 })
    expect(S().past).toHaveLength(0)
    up(8, 5)
    expect(S().doc.areas[0]).toMatchObject({ w: 8, d: 5 })
    expect(S().past).toHaveLength(1)
  })
})

describe('selecting with a box', () => {
  it('lights up what it has caught as it grows', () => {
    mount(docOf([node('a', 'ec2', 0, 0), node('b', 'rds', 8, 0), node('c', 's3', 0, 20)]), { selection: ['a'] })
    const p = at(-2, -2), q = at(11, 3)
    fireEvent.pointerDown(svg(), { pointerId: 1, button: 0, shiftKey: true, clientX: Math.min(p.clientX, q.clientX) - 150, clientY: Math.min(p.clientY, q.clientY) - 150 })
    fireEvent.pointerMove(svg(), { pointerId: 1, shiftKey: true, clientX: Math.max(p.clientX, q.clientX) + 150, clientY: Math.max(p.clientY, q.clientY) + 150 })
    // `b` is new to the selection; `a` is already marked as selected
    expect(document.querySelectorAll('.picking')).toHaveLength(1)
    fireEvent.pointerUp(svg(), { pointerId: 1, clientX: Math.max(p.clientX, q.clientX) + 150, clientY: Math.max(p.clientY, q.clientY) + 150 })
    expect(document.querySelectorAll('.picking')).toHaveLength(0)
    expect(S().selection.sort()).toEqual(['a', 'b'])
  })
  it('the group can be lined up and spaced out from the bar above it, a step each', async () => {
    mount(docOf([node('a', 'ec2', 0, 0), node('b', 'rds', 5, 1), node('c', 's3', 14, 2)]), { selection: ['a', 'b', 'c'] })
    await userEvent.click(screen.getByRole('button', { name: 'Line up' }))
    expect(S().doc.nodes.map((n) => n.y)).toEqual([1, 1, 1])
    await userEvent.click(screen.getByRole('button', { name: 'Space evenly' }))
    expect(S().doc.nodes.map((n) => n.x)).toEqual([0, 7, 14])
    expect(S().past).toHaveLength(2)
    // two is a line, but not something to space
    act(() => S().select(['a', 'b']))
    expect(screen.queryByRole('button', { name: 'Space evenly' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Line up' })).toBeInTheDocument()
  })
})

describe('placing from the library, continued', () => {
  it('the ghost is drawn exactly where the component will be put, and that is where it is put', () => {
    mount(docOf(), { placing: 'rds' })
    fireEvent.pointerMove(window, at(4.3, 6.8))
    const body = document.querySelector('.ghost g[transform]')!.getAttribute('transform')!.match(/translate\((-?[\d.]+) (-?[\d.]+)\)/)!
    const [wx, wy] = unproject(projNow(), Number(body[1]), Number(body[2]))
    expect(wx).toBeCloseTo(3.3, 2)
    expect(wy).toBeCloseTo(5.8, 2)
    fireEvent.pointerUp(window, at(4.3, 6.8))
    expect(S().doc.nodes[0]).toMatchObject({ x: 3.3, y: 5.8 })
  })
  it('with snapping on a new component is put on the nearest whole cell, and the ghost shows that cell', () => {
    mount(docOf(), { placing: 'rds', snap: true })
    fireEvent.pointerMove(window, at(4.3, 6.8))
    const body = document.querySelector('.ghost g[transform]')!.getAttribute('transform')!.match(/translate\((-?[\d.]+) (-?[\d.]+)\)/)!
    expect(unproject(projNow(), Number(body[1]), Number(body[2])).map((v) => Math.round(v * 100) / 100)).toEqual([3, 6])
    fireEvent.pointerUp(window, at(4.3, 6.8))
    expect(S().doc.nodes[0]).toMatchObject({ x: 3, y: 6 })
  })
  it('lines up with what is already there show while it is carried in', () => {
    mount(undefined, { placing: 'rds' })
    fireEvent.pointerMove(window, at(1, 9))
    expect(document.querySelectorAll('.guide').length).toBeGreaterThan(0)
    fireEvent.pointerUp(window, at(1, 9))
    expect(document.querySelectorAll('.guide')).toHaveLength(0)
  })
  it('is put where it is dropped even when something is already there', () => {
    mount(undefined, { placing: 'rds' })
    fireEvent.pointerUp(window, at(1.2, 1.1)) // right on top of `a`
    expect(S().doc.nodes[2]).toMatchObject({ x: 0.2, y: 0.1 })
  })
  it('dropped on a connection, it goes into the middle of it: the line lights up first, and it is one step', () => {
    mount(docOf([node('a'), node('b', 'rds', 8, 0)], [edge('e', 'a', 'b', { label: 'orders', kind: 'data', via: [[5, 3]], toSide: 's' })]), { placing: 'lambda' })
    vi.mocked(document.elementFromPoint).mockReturnValue(hit('edge', 'e'))
    fireEvent.pointerMove(window, at(5, 1))
    expect(document.querySelector('.splice')).not.toBeNull()
    fireEvent.pointerUp(window, at(5, 1))
    expect(document.querySelector('.splice')).toBeNull()
    const made = S().doc.nodes[2]
    expect(S().doc.edges.map((e) => [e.from, e.to])).toEqual([['a', made.id], [made.id, 'b']])
    // both halves are what the line was; its name stays on the first, its hand-drawn path is let go, the far door is kept
    expect(S().doc.edges[0]).toMatchObject({ id: 'e', label: 'orders', kind: 'data' })
    expect(S().doc.edges[1]).toMatchObject({ kind: 'data', toSide: 's' })
    expect(S().doc.edges[1].label).toBeUndefined()
    expect(S().doc.edges.every((e) => e.via === undefined)).toBe(true)
    expect(S().past).toHaveLength(1)
    act(() => S().undo())
    expect(S().doc.edges.map((e) => [e.from, e.to])).toEqual([['a', 'b']])
  })
  it('over a component rather than the line behind it, it is an ordinary drop', () => {
    mount(docOf([node('a'), node('b', 'rds', 8, 0)], [edge('e', 'a', 'b')]), { placing: 'lambda' })
    vi.mocked(document.elementFromPoint).mockReturnValue(hit('node', 'b'))
    fireEvent.pointerMove(window, at(9, 1))
    expect(document.querySelector('.splice')).toBeNull()
    fireEvent.pointerUp(window, at(9, 1))
    expect(S().doc.edges).toHaveLength(1)
  })
})
