// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useStore } from '../core/store'
import { docOf, edge, node, resetStore } from '../test/helpers'
import { ContextMenu, type MenuState } from './ContextMenu'

const S = () => useStore.getState()
const names = () => [...document.querySelectorAll('.ctx-menu button span')].map((b) => b.textContent)
const doc = () => docOf([node('a', 'ec2', 2, 2), node('b', 'rds', 10, 2)], [edge('e', 'a', 'b')], {
  areas: [{ id: 'r', x: 0, y: 0, w: 30, d: 30, name: 'Area', color: '#8F6FF2', kind: 'group' }],
  labels: [{ id: 'l', x: 0, y: 0, text: 'T', size: 20, dir: 'x' }],
})
function open(target: MenuState['target'], selection: string[], at: Partial<MenuState> = {}) {
  resetStore({ doc: doc(), selection })
  const onClose = vi.fn<(...args: any[]) => void>()
  render(<ContextMenu menu={{ x: 100, y: 120, wx: 4.4, wy: 7.6, target, ...at }} onClose={onClose} />)
  return onClose
}
const click = (name: string) => userEvent.click(screen.getByRole('button', { name: new RegExp('^' + name) }))

beforeEach(() => resetStore())

describe('ContextMenu', () => {
  it('offers the right actions for each kind of target', () => {
    open('node', ['a'])
    expect(names()).toEqual(['Duplicate', 'Copy', 'Wrap in group', 'Zoom to selection', 'Follow the flow', 'Edit properties', 'Delete'])
    document.body.innerHTML = ''
    open('edge', ['e'])
    expect(names()).toEqual(['Straighten', 'Add a bend here', 'Keep this path', 'Follow the flow', 'Reverse direction', 'Edit properties', 'Delete'])
    document.body.innerHTML = ''
    open('area', ['r'])
    expect(names()).toEqual(['Duplicate', 'Copy', 'Fit to contents', 'Edit properties', 'Delete'])
    document.body.innerHTML = ''
    open('label', ['l'])
    expect(names()).toEqual(['Duplicate', 'Copy', 'Edit properties', 'Delete'])
    document.body.innerHTML = ''
    open(null, [])
    expect(names()).toEqual(['Paste', 'Add label here', 'Select all', 'Zoom to fit', 'Tidy layout'])
    expect(document.querySelectorAll('.ctx-menu hr')).toHaveLength(1)
    expect(screen.getByRole('button', { name: /Paste/ })).toHaveTextContent('Ctrl+V')
  })
  it('duplicates, then closes', async () => {
    const onClose = open('node', ['a'])
    await click('Duplicate')
    expect(S().doc.nodes).toHaveLength(3)
    expect(onClose).toHaveBeenCalledTimes(1)
  })
  it('copies, and pastes from the empty-canvas menu', async () => {
    open('node', ['a'])
    await click('Copy')
    expect(S().toasts.at(-1)!.text).toBe('Copied 1 item(s)')
    document.body.innerHTML = ''
    const before = S().doc
    render(<ContextMenu menu={{ x: 0, y: 0, wx: 0, wy: 0, target: null }} onClose={() => {}} />)
    useStore.setState({ doc: before })
    await click('Paste')
    expect(S().doc.nodes).toHaveLength(3)
    expect(S().doc.nodes[2]).toMatchObject({ type: 'ec2', x: 4, y: 4 })
  })
  it('wraps the selection in a group and zooms to it', async () => {
    open('node', ['a', 'b'])
    await click('Wrap in group')
    expect(S().doc.areas).toHaveLength(2)
    expect(S().doc.areas[1]).toMatchObject({ kind: 'group', name: 'Group', x: 1, w: 12 })
    await click('Zoom to selection')
  })
  it('asks for the name field', async () => {
    open('node', ['a'], {})
    useStore.setState({ panel: 'budget' })
    const before = S().focusName
    await click('Edit properties')
    expect(S()).toMatchObject({ panel: 'inspect', focusName: before + 1 })
  })
  it('deletes the selection', async () => {
    open('node', ['a'])
    expect(screen.getByRole('button', { name: /^Delete/ })).toHaveClass('danger')
    await click('Delete')
    expect(S().doc.nodes.map((n) => n.id)).toEqual(['b'])
    expect(S().doc.edges).toHaveLength(0)
  })
  it('reverses a connection', async () => {
    open('edge', ['e'])
    await click('Reverse direction')
    expect(S().doc.edges[0]).toMatchObject({ from: 'b', to: 'a' })
  })
  it('offers to clean up a line only when it has a kink too small to have been meant, and then takes it out', async () => {
    open('edge', ['e'])
    expect(names()).not.toContain('Clean up small kinks')
    act(() => S().patchEdge(['e'], { fromSide: 'e', toSide: 'w', fromAt: 0, toAt: 0, runs: [5, 3.04, 7, 5, 9] }))
    document.body.innerHTML = ''
    render(<ContextMenu menu={{ x: 100, y: 120, wx: 4, wy: 7, target: 'edge' }} onClose={vi.fn<(...args: any[]) => void>()} />)
    await click('Clean up small kinks')
    expect(S().doc.edges[0].runs).toEqual([7, 5, 9])
  })
  it('an automatic line that has a planned path can be asked to plan it again', async () => {
    resetStore()
    act(() => S().load(doc()))
    act(() => S().select(['e']))
    const was = S().doc.edges[0].plan
    expect(was).toBeDefined()
    render(<ContextMenu menu={{ x: 100, y: 120, wx: 4, wy: 7, target: 'edge' }} onClose={vi.fn<(...args: any[]) => void>()} />)
    await click('Route automatically')
    expect(S().doc.edges[0].plan).toBeDefined()
    expect(S().doc.edges[0].plan).not.toBe(was)
  })
  it('straightens a connection, and hands a shaped one back to the router', async () => {
    const onClose = open('edge', ['e'])
    act(() => S().patchEdge(['e'], { fromSide: 'e', toSide: 'w', fromAt: 0, toAt: 0, runs: [4.5, 6, 9.5] }))
    await click('Straighten')
    expect(S().doc.edges[0].runs).toEqual([])
    expect(onClose).toHaveBeenCalled()
    document.body.innerHTML = ''
    render(<ContextMenu menu={{ x: 100, y: 120, wx: 4, wy: 7, target: 'edge' }} onClose={onClose} />)
    expect(names()).toContain('Route automatically')
    await click('Route automatically')
    expect(S().doc.edges[0].runs).toBeUndefined()
  })
  it('puts a bend in a line where the menu was opened, and keeps a path the router planned', async () => {
    const onClose = open('edge', ['e'])
    await click('Add a bend here')
    // the line ran straight along y = 3; it now steps down half a cell where it was pointed at
    expect(S().doc.edges[0]).toMatchObject({ fromSide: 'e', toSide: 'w', toAt: 0.5, runs: [4.5] })
    expect(S().past).toHaveLength(1)
    expect(onClose).toHaveBeenCalled()
    document.body.innerHTML = ''
    render(<ContextMenu menu={{ x: 100, y: 120, wx: 4, wy: 7, target: 'edge' }} onClose={onClose} />)
    // it is the user's line now, so there is nothing to keep, only to hand back
    expect(names()).not.toContain('Keep this path')
    await click('Route automatically')
    document.body.innerHTML = ''
    render(<ContextMenu menu={{ x: 100, y: 120, wx: 4, wy: 7, target: 'edge' }} onClose={onClose} />)
    await click('Keep this path')
    expect(S().doc.edges[0].runs).toEqual([])
    // a curve has neither
    act(() => S().setShape(['e'], 'curved'))
    document.body.innerHTML = ''
    render(<ContextMenu menu={{ x: 100, y: 120, wx: 4, wy: 7, target: 'edge' }} onClose={onClose} />)
    expect(names()).not.toContain('Add a bend here')
    expect(names()).not.toContain('Keep this path')
  })
  it('says when straightening will move a component, and does it', async () => {
    resetStore({ doc: docOf([node('a', 'ec2', 0, 0), node('b', 'rds', 10, 6, { name: 'db' })], [edge('e', 'a', 'b')]), selection: ['e'] })
    render(<ContextMenu menu={{ x: 100, y: 120, wx: 4, wy: 7, target: 'edge' }} onClose={() => {}} />)
    expect(names()[0]).toBe('Line up and straighten')
    await click('Line up and straighten')
    expect(S().doc.nodes[1]).toMatchObject({ x: 10, y: 0 })
    expect(S().doc.edges[0].runs).toEqual([])
  })
  it('fits an area to its contents', async () => {
    open('area', ['r'])
    await click('Fit to contents')
    expect(S().doc.areas[0]).toMatchObject({ x: 1, y: 0.5, w: 12, d: 4.5 })
  })
  it('adds a label at the clicked spot, selects all, fits and tidies', async () => {
    open(null, [])
    useStore.setState({ panel: 'advisor' })
    await click('Add label here')
    expect(S().doc.labels[1]).toMatchObject({ x: 4, y: 8 })
    expect(S().panel).toBe('inspect')
    await click('Select all')
    expect(S().selection).toHaveLength(5)
    await click('Zoom to fit')
    await click('Tidy layout')
    expect(S().toasts.at(-1)!.text).toBe('Layout tidied')
  })
  it('closes on Escape and on a press outside, not inside', () => {
    const onClose = open('node', ['a'])
    fireEvent.pointerDown(document.querySelector('.ctx-menu button')!)
    fireEvent.keyDown(window, { key: 'a' })
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.pointerDown(document.body)
    expect(onClose).toHaveBeenCalledTimes(2)
    expect(fireEvent.contextMenu(document.querySelector('.ctx-menu')!)).toBe(false)
  })
  it('stays inside the window near the bottom-right corner', () => {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ width: 200, height: 240, left: 0, top: 0, right: 200, bottom: 240, x: 0, y: 0, toJSON() {} })
    open('node', ['a'], { x: innerWidth - 10, y: innerHeight - 10 })
    const m = document.querySelector('.ctx-menu') as HTMLElement
    expect(m.style.left).toBe(`${innerWidth - 208}px`)
    expect(m.style.top).toBe(`${innerHeight - 248}px`)
  })
  it('opens at the pointer when there is room', () => {
    open('node', ['a'])
    const m = document.querySelector('.ctx-menu') as HTMLElement
    expect(m.style.left).toBe('100px')
    expect(m.style.top).toBe('120px')
  })
})
