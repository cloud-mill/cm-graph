import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getPref, loadDoc } from './storage'
import { coalesce, enableAutosave, flushSave, kindOf, moveItems, useStore } from './store'
import type { AreaT, LabelT } from './types'
import { docOf, edge, node, resetStore } from '../test/helpers'

const S = () => useStore.getState()
const area = (id: string, x: number, y: number, w: number, d: number): AreaT => ({ id, x, y, w, d, name: id, color: '#888888', kind: 'group' })
const label = (id: string, x: number, y: number): LabelT => ({ id, x, y, text: id, size: 20, dir: 'x' })

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-03-01T00:00:00Z'))
  enableAutosave(false)
  resetStore({ doc: docOf() })
  ;(globalThis as any).document ??= { documentElement: { dataset: {} } }
})
afterEach(() => { enableAutosave(false); vi.useRealTimers() })

describe('apply, undo and redo', () => {
  it('records an undo step, clears redo and marks the blueprint unsaved', () => {
    const before = S().doc
    vi.advanceTimersByTime(5000)
    S().apply((d) => ({ ...d, name: 'Renamed' }))
    expect(S().doc.name).toBe('Renamed')
    expect(S().doc.updatedAt).toBe(Date.now())
    expect(S().past).toEqual([before])
    expect(S().saved).toBe(false)
  })
  it('does nothing when the change returns the same blueprint', () => {
    const before = S().doc
    S().apply((d) => d)
    expect(S().doc).toBe(before)
    expect(S().past).toEqual([])
    expect(S().saved).toBe(true)
  })
  it('transient changes update the blueprint without an undo step and keep redo', () => {
    S().apply((d) => ({ ...d, name: 'A' }))
    S().undo()
    expect(S().future).toHaveLength(1)
    S().apply((d) => ({ ...d, name: 'B' }), true)
    expect(S().doc.name).toBe('B')
    expect(S().past).toHaveLength(0)
    expect(S().future).toHaveLength(1)
    expect(S().saved).toBe(false)
  })
  it('undoes and redoes in order, clearing the selection each time', () => {
    for (const name of ['A', 'B', 'C']) S().apply((d) => ({ ...d, name }))
    S().select(['x'])
    S().undo()
    expect(S().doc.name).toBe('B')
    expect(S().selection).toEqual([])
    S().undo(); S().undo()
    expect(S().doc.name).toBe('Test blueprint')
    S().undo() // nothing left: no change
    expect(S().doc.name).toBe('Test blueprint')
    expect(S().future.map((d) => d.name)).toEqual(['A', 'B', 'C'])
    S().redo(); S().redo(); S().redo()
    expect(S().doc.name).toBe('C')
    S().redo()
    expect(S().doc.name).toBe('C')
    expect(S().past).toHaveLength(3)
  })
  it('a new change after an undo discards the redo branch', () => {
    S().apply((d) => ({ ...d, name: 'A' }))
    S().apply((d) => ({ ...d, name: 'B' }))
    S().undo()
    S().apply((d) => ({ ...d, name: 'C' }))
    expect(S().future).toEqual([])
    S().redo()
    expect(S().doc.name).toBe('C')
  })
  it('keeps at most 120 undo steps', () => {
    for (let i = 0; i < 150; i++) S().apply((d) => ({ ...d, name: 'v' + i }))
    expect(S().past).toHaveLength(120)
    for (let i = 0; i < 200; i++) S().undo()
    expect(S().doc.name).toBe('v29')
    for (let i = 0; i < 150; i++) S().checkpoint()
    expect(S().past.length).toBeLessThanOrEqual(120)
  })
  it('checkpoint stores the current blueprint so a drag can be undone as one step', () => {
    S().apply((d) => ({ ...d, name: 'A' }))
    S().undo()
    const start = S().doc
    S().checkpoint()
    expect(S().future).toEqual([])
    S().apply((d) => ({ ...d, name: 'drag 1' }), true)
    S().apply((d) => ({ ...d, name: 'drag 2' }), true)
    expect(S().past).toEqual([start])
    S().undo()
    expect(S().doc.name).toBe(start.name)
  })
  it('load replaces the blueprint and resets editing state', () => {
    S().apply((d) => ({ ...d, name: 'A' }))
    S().set({ selection: ['x'], tool: 'connect', placing: 'ec2', lens: 'cost', modal: 'export', panel: 'budget' })
    const next = docOf([node('n')], [], { id: 'other' })
    S().load(next)
    expect(S()).toMatchObject({ doc: next, past: [], future: [], selection: [], tool: 'select', placing: null, saved: true, lens: 'none', modal: null, panel: 'inspect' })
  })
})

describe('selection', () => {
  it('replaces by default and toggles when additive', () => {
    S().select(['a', 'b'])
    expect(S().selection).toEqual(['a', 'b'])
    S().select(['c'])
    expect(S().selection).toEqual(['c'])
    S().select(['a'], true)
    expect(S().selection).toEqual(['c', 'a'])
    S().select(['c', 'd'], true)
    expect(S().selection).toEqual(['a', 'd'])
    S().select([], true)
    expect(S().selection).toEqual(['a', 'd'])
    S().select([])
    expect(S().selection).toEqual([])
  })
})

describe('adding things', () => {
  it('adds a component with defaults, a numbered name, and selects it', () => {
    const id = S().addNode('ec2', 4, -2)
    const n = S().doc.nodes[0]
    expect(n).toMatchObject({ id, type: 'ec2', x: 4, y: -2, name: 'ec2-1' })
    expect(n.props).toMatchObject({ family: 'm7g', size: 'large', count: 1 })
    expect(S().selection).toEqual([id])
    expect(S().fresh).toBe(id)
    expect(S().past).toHaveLength(1)
    vi.advanceTimersByTime(700)
    expect(S().fresh).toBeNull()
  })
  it('keeps the entrance mark on the newest component only', () => {
    S().addNode('ec2', 0, 0)
    vi.advanceTimersByTime(400)
    const second = S().addNode('ec2', 4, 0)
    vi.advanceTimersByTime(400) // the first timer fires here and must not clear the second mark
    expect(S().fresh).toBe(second)
    vi.advanceTimersByTime(300)
    expect(S().fresh).toBeNull()
  })
  it('numbers names per type, drops the cloud prefix and leaves unconfigurable components unnamed', () => {
    S().addNode('ec2', 0, 0); S().addNode('ec2', 4, 0); S().addNode('rds', 8, 0)
    S().addNode('gcp-sql', 0, 4); S().addNode('az-vm', 4, 4); S().addNode('users', 8, 4); S().addNode('block', 12, 4)
    expect(S().doc.nodes.map((n) => n.name)).toEqual(['ec2-1', 'ec2-2', 'rds-1', 'sql-1', 'vm-1', undefined, 'block-1'])
  })
  it('never hands out a name that is already in use', () => {
    const a = S().addNode('ec2', 0, 0)
    S().addNode('ec2', 4, 0)
    S().remove([a])
    S().addNode('ec2', 8, 0)
    const names = S().doc.nodes.map((n) => n.name)
    expect(new Set(names).size).toBe(names.length)
    expect(names).toEqual(['ec2-2', 'ec2-1'])
  })
  it('falls back to a generic block for an unknown type', () => {
    S().addNode('no-such-thing', 0, 0)
    expect(S().doc.nodes[0]).toMatchObject({ type: 'no-such-thing', name: 'block-1', props: { fee: 0 } })
  })
  it('switches the advisor tab back to the inspector, but leaves the budget open', () => {
    S().set({ panel: 'advisor' })
    S().addNode('ec2', 0, 0)
    expect(S().panel).toBe('inspect')
    S().set({ panel: 'budget' })
    S().addNode('ec2', 4, 0)
    expect(S().panel).toBe('budget')
  })
  it('connects two components once, in either direction', () => {
    resetStore({ doc: docOf([node('a'), node('b'), node('c')]) })
    const id = S().addEdge('a', 'b')!
    // a new line says what it most likely is and that it was drawn by hand
    expect(S().doc.edges).toEqual([{ id, from: 'a', to: 'b', style: 'solid', arrow: 'end', width: 2, kind: 'request', origin: 'drawn', plan: expect.objectContaining({ fromSide: expect.any(String) }) }])
    expect(S().addEdge('a', 'b')).toBeNull()
    expect(S().addEdge('b', 'a')).toBeNull()
    expect(S().addEdge('a', 'a')).toBeNull()
    expect(S().addEdge('b', 'c')).toBeTruthy()
    expect(S().doc.edges).toHaveLength(2)
    expect(S().past).toHaveLength(2)
  })
  it('refuses to connect to a component that does not exist', () => {
    resetStore({ doc: docOf([node('a')]) })
    expect(S().addEdge('a', 'ghost')).toBeNull()
    expect(S().addEdge('ghost', 'a')).toBeNull()
    expect(S().doc.edges).toEqual([])
  })
  it('adds an area and a label and selects them', () => {
    const a = S().addArea({ x: 1, y: 2, w: 3, d: 4, name: 'VPC', color: '#123456', kind: 'vpc' })
    expect(S().doc.areas).toEqual([{ id: a, x: 1, y: 2, w: 3, d: 4, name: 'VPC', color: '#123456', kind: 'vpc' }])
    expect(S().selection).toEqual([a])
    const focus = S().focusName
    const l = S().addLabel(5, 6)
    expect(S().doc.labels).toEqual([{ id: l, x: 5, y: 6, text: 'Label', size: 20, dir: 'x' }])
    expect(S().selection).toEqual([l])
    expect(S().focusName).toBe(focus + 1)
  })
})

describe('patching', () => {
  beforeEach(() => resetStore({ doc: docOf([node('a'), node('b', 'rds')], [edge('e', 'a', 'b'), edge('f', 'b', 'a')], { areas: [area('ar', 0, 0, 4, 4)], labels: [label('l', 0, 0)] }) }))
  it('patches one component, or the settings of several', () => {
    S().patchNode('a', { name: 'web', color: '#ff0000' })
    expect(S().doc.nodes[0]).toMatchObject({ name: 'web', color: '#ff0000' })
    expect(S().doc.nodes[1].name).toBeUndefined()
    S().patchProps(['a', 'b'], { size: 'xlarge' })
    expect(S().doc.nodes.map((n) => n.props.size)).toEqual(['xlarge', 'xlarge'])
    expect(S().doc.nodes[0].props.family).toBe('m7g')
  })
  it('patches connections, areas and labels', () => {
    S().patchEdge(['e', 'f'], { style: 'dashed' })
    expect(S().doc.edges.map((e) => e.style)).toEqual(['dashed', 'dashed'])
    S().patchEdge(['f'], { arrow: 'both', width: 3.5, label: 'sync' })
    expect(S().doc.edges[1]).toMatchObject({ arrow: 'both', width: 3.5, label: 'sync' })
    expect(S().doc.edges[0].arrow).toBe('end')
    S().patchArea('ar', { kind: 'vpc', w: 9 })
    expect(S().doc.areas[0]).toMatchObject({ kind: 'vpc', w: 9, d: 4 })
    S().patchLabel('l', { text: 'Hello', dir: 'y' })
    expect(S().doc.labels[0]).toMatchObject({ text: 'Hello', dir: 'y', size: 20 })
    expect(S().past).toHaveLength(4)
  })
})

describe('remove', () => {
  beforeEach(() => resetStore({
    doc: docOf([node('a'), node('b'), node('c')], [edge('ab', 'a', 'b'), edge('bc', 'b', 'c'), edge('ca', 'c', 'a')], { areas: [area('ar', 0, 0, 4, 4)], labels: [label('l', 0, 0)] }),
    selection: ['a'],
  }))
  it('removes a component together with its connections', () => {
    S().remove(['a'])
    expect(S().doc.nodes.map((n) => n.id)).toEqual(['b', 'c'])
    expect(S().doc.edges.map((e) => e.id)).toEqual(['bc'])
    expect(S().selection).toEqual([])
  })
  it('removes connections, areas and labels by id, leaving the contents of an area', () => {
    S().remove(['ab', 'ar', 'l'])
    expect(S().doc.edges.map((e) => e.id)).toEqual(['bc', 'ca'])
    expect(S().doc.areas).toEqual([])
    expect(S().doc.labels).toEqual([])
    expect(S().doc.nodes).toHaveLength(3)
  })
  it('is one undo step', () => {
    S().remove(['a', 'b', 'ar'])
    S().undo()
    expect(S().doc.nodes).toHaveLength(3)
    expect(S().doc.edges).toHaveLength(3)
    expect(S().doc.areas).toHaveLength(1)
  })
  it('does nothing for an empty list or ids that are not on the canvas', () => {
    const before = S().doc
    S().remove([])
    expect(S().selection).toEqual(['a'])
    S().remove(['ghost'])
    expect(S().doc).toBe(before)
    expect(S().past).toEqual([])
    expect(S().saved).toBe(true)
  })
})

describe('duplicate, copy and paste', () => {
  beforeEach(() => resetStore({
    doc: docOf(
      [node('a', 'ec2', 0, 0, { name: 'web-1' }), node('b', 'ec2', 4, 0, { name: 'web-2' }), node('c', 'rds', 8, 0, { name: 'orders' }), node('d', 'users', -4, 0)],
      [edge('ab', 'a', 'b', { label: 'x' }), edge('bc', 'b', 'c')],
      { areas: [area('ar', -1, -1, 8, 4)], labels: [label('l', 0, 6)] },
    ),
  }))
  it('duplicates components with their internal connections, offset and renumbered', () => {
    S().duplicate(['a', 'b'])
    const d = S().doc
    expect(d.nodes).toHaveLength(6)
    const [a2, b2] = d.nodes.slice(4)
    expect(a2).toMatchObject({ x: 2, y: 2, name: 'web-3', type: 'ec2' })
    expect(b2).toMatchObject({ x: 6, y: 2, name: 'web-4' })
    expect(a2.id).not.toBe('a')
    // only the connection between the two copies comes along
    expect(d.edges).toHaveLength(3)
    expect(d.edges[2]).toMatchObject({ from: a2.id, to: b2.id, label: 'x' })
    expect(d.edges[2].id).not.toBe('ab')
    expect(S().selection).toEqual([a2.id, b2.id])
    expect(S().past).toHaveLength(1)
  })
  it('keeps names that are not numbered, and unnamed components unnamed', () => {
    S().duplicate(['c', 'd'])
    expect(S().doc.nodes.slice(4).map((n) => n.name)).toEqual(['orders', undefined])
  })
  it('duplicates areas and labels with a custom offset', () => {
    S().duplicate(['ar', 'l'], 0, 5)
    expect(S().doc.areas[1]).toMatchObject({ x: -1, y: 4, w: 8, d: 4, name: 'ar' })
    expect(S().doc.labels[1]).toMatchObject({ x: 0, y: 11, text: 'l' })
    expect(S().selection).toHaveLength(2)
  })
  it('does nothing when asked to duplicate only connections or unknown ids', () => {
    const before = S().doc
    S().duplicate(['ab'])
    S().duplicate(['ghost'])
    S().duplicate([])
    expect(S().doc).toBe(before)
    expect(S().past).toEqual([])
  })
  it('copies the selection and pastes it with a growing offset', () => {
    S().select(['a', 'b', 'ar', 'l'])
    S().copy()
    expect(S().toasts.at(-1)!.text).toBe('Copied 4 item(s)')
    S().paste()
    let d = S().doc
    expect(d.nodes.slice(4).map((n) => [n.x, n.y, n.name])).toEqual([[2, 2, 'web-3'], [6, 2, 'web-4']])
    expect(d.edges).toHaveLength(3)
    expect(d.edges[2].from).toBe(d.nodes[4].id)
    expect(d.areas[1]).toMatchObject({ x: 1, y: 1 })
    expect(d.labels[1]).toMatchObject({ x: 2, y: 8 })
    expect(S().selection).toHaveLength(4)
    S().paste()
    d = S().doc
    expect(d.nodes.slice(6).map((n) => [n.x, n.y, n.name])).toEqual([[4, 4, 'web-5'], [8, 4, 'web-6']])
    expect(S().past).toHaveLength(2)
  })
  it('pastes into another blueprint and survives the originals being deleted', () => {
    S().select(['a', 'b'])
    S().copy()
    S().remove(['a', 'b'])
    S().load(docOf([node('z', 'ec2', 0, 0, { name: 'web-1' })], [], { id: 'second' }))
    S().paste()
    expect(S().doc.nodes.map((n) => n.name)).toEqual(['web-1', 'web-2', 'web-3'])
    expect(S().doc.edges).toHaveLength(1)
  })
  it('copying restarts the paste offset', () => {
    S().select(['c'])
    S().copy(); S().paste(); S().paste()
    S().select(['c'])
    S().copy(); S().paste()
    expect(S().doc.nodes.at(-1)).toMatchObject({ x: 10, y: 2 })
  })
  it('copying nothing shows no toast, and pasting nothing changes nothing', () => {
    S().select([])
    S().copy()
    expect(S().toasts).toEqual([])
    const before = S().doc
    S().paste()
    expect(S().doc).toBe(before)
    expect(S().past).toEqual([])
    // a selection of connections alone has nothing to carry either
    S().select(['ab'])
    S().copy()
    S().paste()
    expect(S().doc).toBe(before)
  })
})

describe('moving', () => {
  const base = docOf(
    [node('in', 'ec2', 1, 1), node('out', 'ec2', 20, 20), node('edge', 'ec2', 9, 9)],
    [],
    { areas: [area('big', 0, 0, 10, 10), area('small', 1, 5, 3, 3), area('poke', 8, 8, 5, 5), area('far', 30, 30, 2, 2)], labels: [label('lin', 2, 2), label('lout', 11, 2), label('lborder', 10, 10)] },
  )
  it('nudges every kind of selected item as one undo step', () => {
    resetStore({ doc: base, selection: ['out', 'far', 'lout'] })
    S().nudge(1, -4)
    const d = S().doc
    expect(d.nodes.find((n) => n.id === 'out')).toMatchObject({ x: 21, y: 16 })
    expect(d.areas.find((a) => a.id === 'far')).toMatchObject({ x: 31, y: 26 })
    expect(d.labels.find((l) => l.id === 'lout')).toMatchObject({ x: 12, y: -2 })
    expect(d.nodes.find((n) => n.id === 'in')).toMatchObject({ x: 1, y: 1 })
    expect(S().past).toHaveLength(1)
  })
  it('nudging with nothing selected, or by nothing, changes nothing', () => {
    resetStore({ doc: base })
    S().nudge(1, 1)
    expect(S().doc).toBe(base)
    S().select(['out'])
    S().nudge(0, 0)
    expect(S().doc).toBe(base)
    expect(S().past).toEqual([])
  })
  it('moving an area carries the components, labels and areas inside it', () => {
    const m = moveItems(base, base, new Set(['big']), 5, 5)
    const n = (id: string) => m.nodes.find((x) => x.id === id)!, a = (id: string) => m.areas.find((x) => x.id === id)!, l = (id: string) => m.labels.find((x) => x.id === id)!
    expect(a('big')).toMatchObject({ x: 5, y: 5 })
    expect(n('in')).toMatchObject({ x: 6, y: 6 })
    expect(n('edge')).toMatchObject({ x: 14, y: 14 }) // centre (10,10) sits on the border, so it counts
    expect(n('out')).toMatchObject({ x: 20, y: 20 })
    expect(a('small')).toMatchObject({ x: 6, y: 10 })
    expect(a('poke')).toMatchObject({ x: 8, y: 8 }) // only partly inside: stays
    expect(a('far')).toMatchObject({ x: 30, y: 30 })
    expect(l('lin')).toMatchObject({ x: 7, y: 7 })
    expect(l('lborder')).toMatchObject({ x: 15, y: 15 })
    expect(l('lout')).toMatchObject({ x: 11, y: 2 })
  })
  it('measures from the drag-start blueprint, so repeated calls do not accumulate', () => {
    const sel = new Set(['in'])
    const once = moveItems(base, base, sel, 3, 0)
    const twice = moveItems(once, base, sel, 4, 0)
    expect(twice.nodes[0]).toMatchObject({ x: 5, y: 1 })
    // membership is also judged from the start, so a component dragged out of an area is not picked up mid-drag
    const dragged = moveItems(moveItems(base, base, new Set(['big']), 50, 0), base, new Set(['big']), 60, 0)
    expect(dragged.nodes[0]).toMatchObject({ x: 61 })
  })
  it('returns the same blueprint for a zero move from the start', () => {
    expect(moveItems(base, base, new Set(['in']), 0, 0)).toBe(base)
    const moved = moveItems(base, base, new Set(['in']), 2, 0)
    expect(moveItems(moved, base, new Set(['in']), 0, 0).nodes[0]).toMatchObject({ x: 1 }) // dragging back to the start restores it
  })
  it('ignores selected ids that were not there when the drag began', () => {
    const later = { ...base, nodes: [...base.nodes, node('new', 'ec2', 0, 0)] }
    expect(moveItems(later, base, new Set(['new']), 5, 5).nodes.at(-1)).toMatchObject({ x: 0, y: 0 })
  })
})

describe('kindOf', () => {
  it('names what an id refers to', () => {
    const d = docOf([node('n')], [edge('e', 'n', 'n')], { areas: [area('a', 0, 0, 1, 1)], labels: [label('l', 0, 0)] })
    expect([kindOf(d, 'n'), kindOf(d, 'e'), kindOf(d, 'a'), kindOf(d, 'l'), kindOf(d, 'zzz')]).toEqual(['node', 'edge', 'area', 'label', null])
  })
})

describe('coalesce', () => {
  it('merges rapid edits to the same field into one undo step', () => {
    coalesce('name', (d) => ({ ...d, name: 'a' }))
    vi.advanceTimersByTime(300)
    coalesce('name', (d) => ({ ...d, name: 'ab' }))
    vi.advanceTimersByTime(1100)
    coalesce('name', (d) => ({ ...d, name: 'abc' }))
    expect(S().doc.name).toBe('abc')
    expect(S().past).toHaveLength(1)
    S().undo()
    expect(S().doc.name).toBe('Test blueprint')
  })
  it('starts a new step after a pause or when the field changes', () => {
    vi.advanceTimersByTime(5000)
    coalesce('k1', (d) => ({ ...d, name: 'a' }))
    vi.advanceTimersByTime(1200)
    coalesce('k1', (d) => ({ ...d, name: 'b' }))
    expect(S().past).toHaveLength(2)
    coalesce('k2', (d) => ({ ...d, region: 'eu-west-1' }))
    expect(S().past).toHaveLength(3)
    coalesce('k1', (d) => ({ ...d, name: 'c' }))
    expect(S().past).toHaveLength(4)
  })
})

describe('autosave', () => {
  it('saves 450ms after the last change, once', () => {
    enableAutosave(true)
    S().apply((d) => ({ ...d, name: 'one' }))
    vi.advanceTimersByTime(400)
    S().apply((d) => ({ ...d, name: 'two' }))
    vi.advanceTimersByTime(400)
    expect(loadDoc('doc1')).toBeNull()
    expect(S().saved).toBe(false)
    vi.advanceTimersByTime(50)
    expect(loadDoc('doc1')!.name).toBe('two')
    expect(S().saved).toBe(true)
  })
  it('does not save while switched off, even if a save was already pending', () => {
    S().apply((d) => ({ ...d, name: 'ignored' }))
    vi.advanceTimersByTime(1000)
    expect(loadDoc('doc1')).toBeNull()
    enableAutosave(true)
    S().apply((d) => ({ ...d, name: 'pending' }))
    enableAutosave(false)
    vi.advanceTimersByTime(1000)
    expect(loadDoc('doc1')).toBeNull()
  })
  it('ignores state changes that do not touch the blueprint', () => {
    enableAutosave(true)
    S().select(['x'])
    S().set({ tool: 'connect' })
    vi.advanceTimersByTime(1000)
    expect(loadDoc('doc1')).toBeNull()
  })
  it('flushSave writes immediately and cancels the pending timer', () => {
    enableAutosave(true)
    S().apply((d) => ({ ...d, name: 'now' }))
    flushSave()
    expect(loadDoc('doc1')!.name).toBe('now')
    const spy = vi.spyOn(Object.getPrototypeOf(localStorage), 'setItem')
    vi.advanceTimersByTime(1000)
    expect(spy).not.toHaveBeenCalled()
  })
  it('flushSave does nothing while autosave is off', () => {
    S().apply((d) => ({ ...d, name: 'x' }))
    flushSave()
    expect(loadDoc('doc1')).toBeNull()
  })
  it('stays marked unsaved when storage is full', () => {
    enableAutosave(true)
    vi.spyOn(Object.getPrototypeOf(localStorage), 'setItem').mockImplementation(() => { throw new Error('full') })
    S().apply((d) => ({ ...d, name: 'x' }))
    vi.advanceTimersByTime(500)
    expect(S().saved).toBe(false)
  })
})

describe('toasts and preferences', () => {
  it('shows a toast for 3.2 seconds', () => {
    S().toast('Hello')
    expect(S().toasts).toMatchObject([{ text: 'Hello', kind: 'ok' }])
    vi.advanceTimersByTime(3199)
    expect(S().toasts).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(S().toasts).toEqual([])
  })
  it('shows at most four at once, dropping the oldest', () => {
    for (let i = 1; i <= 6; i++) S().toast('t' + i, i % 2 ? 'ok' : 'warn')
    expect(S().toasts.map((t) => t.text)).toEqual(['t3', 't4', 't5', 't6'])
    expect(S().toasts.map((t) => t.kind)).toEqual(['ok', 'warn', 'ok', 'warn'])
    expect(new Set(S().toasts.map((t) => t.id)).size).toBe(4)
    vi.advanceTimersByTime(3200)
    expect(S().toasts).toEqual([])
  })
  it('each toast expires on its own clock', () => {
    S().toast('first')
    vi.advanceTimersByTime(2000)
    S().toast('second')
    vi.advanceTimersByTime(1200)
    expect(S().toasts.map((t) => t.text)).toEqual(['second'])
  })
  it('setTheme updates the page, the store and the saved preference', () => {
    S().setTheme('light')
    expect(S().theme).toBe('light')
    expect(document.documentElement.dataset.theme).toBe('light')
    expect(getPref('theme', 'dark')).toBe('light')
    S().setTheme('dark')
    expect(getPref('theme', 'light')).toBe('dark')
  })
  it('set merges arbitrary state', () => {
    S().set({ showGrid: false, pricing: 'commit3' })
    expect(S()).toMatchObject({ showGrid: false, pricing: 'commit3', showLabels: true })
  })
})

describe('when a save cannot be written', () => {
  const full = () => vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError') })

  it('marks the blueprint as not saved and warns once, however many edits follow', () => {
    // the Node test environment has no Storage class, so fail the write on the instance instead
    const spy = typeof Storage === 'undefined' ? vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('full') }) : full()
    enableAutosave(true)
    for (let i = 0; i < 3; i++) {
      S().apply((d) => ({ ...d, name: 'edit ' + i }))
      vi.advanceTimersByTime(500)
    }
    expect(S().saveFailed).toBe(true)
    expect(S().saved).toBe(false)
    expect(S().toasts.filter((t) => /Could not save/.test(t.text))).toHaveLength(1)
    expect(S().toasts[0].kind).toBe('warn')
    // the work is still in memory and still editable
    expect(S().doc.name).toBe('edit 2')
    spy.mockRestore()
  })

  it('recovers as soon as a write succeeds again', () => {
    const spy = typeof Storage === 'undefined' ? vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('full') }) : full()
    enableAutosave(true)
    S().apply((d) => ({ ...d, name: 'lost?' }))
    vi.advanceTimersByTime(500)
    expect(S().saveFailed).toBe(true)
    spy.mockRestore()
    S().apply((d) => ({ ...d, name: 'kept' }))
    vi.advanceTimersByTime(500)
    expect(S().saveFailed).toBe(false)
    expect(S().saved).toBe(true)
    expect(loadDoc('doc1')!.name).toBe('kept')
  })

  it('opening another blueprint clears the warning state', () => {
    useStore.setState({ saveFailed: true, saved: false })
    S().load(docOf([], [], { id: 'other' }))
    expect(S().saveFailed).toBe(false)
    expect(S().saved).toBe(true)
  })
})

describe('shaping and rewiring connections', () => {
  const start = (extra: Partial<Parameters<typeof edge>[3]> = {}) =>
    resetStore({ doc: docOf([node('a', 'ec2', 0, 0), node('b', 'rds', 8, 0), node('c', 'sqs', 8, 8)], [edge('e', 'a', 'b', extra as any)]) })
  const E = () => S().doc.edges.find((x) => x.id === 'e')!

  it('a new connection is given the likely kind for what it joins, and its line style', () => {
    start()
    const id = S().addEdge('a', 'c')!
    expect(S().doc.edges.find((x) => x.id === id)).toMatchObject({ kind: 'event', style: 'dashed', arrow: 'end', origin: 'drawn' })
  })
  it('saying what a connection is restyles it, in one undo step', () => {
    start()
    S().setKind(['e'], 'replication')
    expect(E()).toMatchObject({ kind: 'replication', style: 'dotted', arrow: 'both' })
    S().undo()
    expect(E().kind).toBeUndefined()
    expect(E()).toMatchObject({ style: 'solid', arrow: 'end' })
  })
  it('straightens a connection in one undo step, and says how many could not be', () => {
    start({ runs: [2.5, 4, 5.5], fromSide: 'e', toSide: 'w', fromAt: 0, toAt: 0 })
    expect(S().straighten(['e'])).toEqual({ straight: 1, apart: 0 })
    expect(E()).toMatchObject({ runs: [], fromSide: 'e', toSide: 'w' })
    S().undo()
    expect(E().runs).toEqual([2.5, 4, 5.5])
    // a and c are out of line on both axes
    const id = S().addEdge('a', 'c')!
    expect(S().straighten([id])).toEqual({ straight: 0, apart: 1 })
  })
  it('lines two components up so the connection between them is straight, in one undo step', () => {
    start()
    const id = S().addEdge('a', 'c')!
    const was = S().doc.nodes.find((n) => n.id === 'c')!
    S().lineUp(id)
    const now = S().doc.nodes.find((n) => n.id === 'c')!
    expect(now.x === was.x && now.y === was.y).toBe(false)
    expect(S().doc.edges.find((x) => x.id === id)!.runs).toEqual([])
    S().undo()
    expect(S().doc.nodes.find((n) => n.id === 'c')).toEqual(was)
    expect(S().doc.edges.find((x) => x.id === id)!.runs).toBeUndefined()
  })
  it('changes how a connection is drawn; a track laid for right angles is let go with it', () => {
    start({ runs: [4], fromSide: 'e', toSide: 'w', fromAt: 0.5, toAt: 0 })
    S().setShape(['e'], 'curved')
    expect(E().shape).toBe('curved')
    expect(E().runs).toBeUndefined(); expect(E().fromAt).toBeUndefined(); expect(E().fromSide).toBeUndefined()
    S().setShape(['e'], 'direct')
    expect(E().shape).toBe('direct')
    S().setShape(['e'], undefined)
    expect('shape' in E()).toBe(false)
    // asking for what it already is changes nothing, and takes no undo step
    const before = S().doc
    S().setShape(['e'], undefined)
    expect(S().doc.edges[0]).toBe(before.edges[0])
  })
  it('hands a shaped connection back to the router', () => {
    start({ via: [[4, 6]], fromSide: 's' })
    S().resetRoute(['e'])
    expect(E().via).toBeUndefined()
    expect(E().fromSide).toBeUndefined()
    S().undo()
    expect(E()).toMatchObject({ via: [[4, 6]], fromSide: 's' })
  })
  it('moves an end to another component and plans the line afresh; a side is pinned only when asked', () => {
    start({ via: [[4, 6]] })
    expect(S().reconnect('e', 'to', 'c')).toBe(true)
    // the bend was drawn for the way to `b`: it does not follow the line to somewhere else
    expect(E()).toMatchObject({ from: 'a', to: 'c' })
    expect(E().via).toBeUndefined()
    expect(E().toSide).toBeUndefined()
    expect(S().reconnect('e', 'from', 'b', 'n')).toBe(true)
    expect(E()).toMatchObject({ from: 'b', to: 'c', fromSide: 'n' })
    S().undo(); S().undo()
    expect(E()).toMatchObject({ from: 'a', to: 'b' })
  })
  it('an end re-pinned on the component it is already on has its line planned afresh from that side', () => {
    start({ runs: [4], fromSide: 'e', toSide: 'w', fromAt: 0.5, toAt: 0.25 })
    expect(S().reconnect('e', 'to', 'b', 's')).toBe(true)
    expect(E()).toMatchObject({ to: 'b', toSide: 's', fromSide: 'e' })
    expect(E().runs).toBeUndefined(); expect(E().fromAt).toBeUndefined(); expect(E().toAt).toBeUndefined()
  })
  it('refuses to join a component to itself, or to something that is not there', () => {
    start()
    expect(S().reconnect('e', 'to', 'a')).toBe(false)
    expect(S().reconnect('e', 'to', 'ghost')).toBe(false)
    expect(S().reconnect('ghost', 'to', 'c')).toBe(false)
    expect(E()).toMatchObject({ from: 'a', to: 'b' })
    expect(S().past).toHaveLength(0)
  })
  it('reversing keeps the path: ends, sides and waypoints all swap round', () => {
    start({ via: [[3, 5], [6, 5]], fromSide: 's', toSide: 'w' })
    S().reverseEdge(['e'])
    expect(E()).toMatchObject({ from: 'b', to: 'a', fromSide: 'w', toSide: 's', via: [[6, 5], [3, 5]] })
  })
  it('a second connection between the same two starts clean and is selected', () => {
    start({ label: 'orders', protocol: 'HTTPS', via: [[4, 6]], kind: 'request' })
    const id = S().twinEdge('e')!
    const twin = S().doc.edges.find((x) => x.id === id)!
    expect(twin).toMatchObject({ from: 'a', to: 'b', kind: 'request', origin: 'drawn' })
    expect(twin.label).toBeUndefined(); expect(twin.protocol).toBeUndefined(); expect(twin.via).toBeUndefined()
    expect(S().selection).toEqual([id])
    expect(S().twinEdge('nope')).toBeNull()
  })
  it('moving both ends together carries the shape; moving one end leaves the waypoints where they are', () => {
    start({ via: [[4, 6]] })
    S().apply((d) => moveItems(d, d, new Set(['a', 'b']), 2, 3))
    expect(E().via).toEqual([[6, 9]])
    S().apply((d) => moveItems(d, d, new Set(['a']), 5, 5))
    expect(E().via).toEqual([[6, 9]])
  })
  it('copies of a shaped connection keep the shape, shifted with them', () => {
    start({ via: [[4, 6]] })
    S().duplicate(['a', 'b'], 2, 2)
    expect(S().doc.edges.at(-1)!.via).toEqual([[6, 8]])
    S().select(['a', 'b']); S().copy(); S().paste()
    expect(S().doc.edges.at(-1)!.via).toEqual([[6, 8]])
  })
  it('undo and redo keep what is still there selected', () => {
    start()
    S().select(['e'])
    S().straighten(['e'])
    S().undo()
    expect(S().selection).toEqual(['e'])
    S().redo()
    expect(S().selection).toEqual(['e'])
    // but not something the step took away
    const id = S().addNode('s3', 20, 20)
    expect(S().selection).toEqual([id])
    S().undo()
    expect(S().selection).toEqual([])
  })
  it('following a flow is a view state that a new blueprint clears', () => {
    start()
    S().set({ trace: 'a' })
    S().load(docOf([node('z')]))
    expect(S().trace).toBeNull()
  })
})

describe('adding something already connected', () => {
  beforeEach(() => resetStore({ doc: docOf([node('a', 'ec2', 0, 0), node('b', 'rds', 8, 0)], [edge('e', 'a', 'b', { label: 'orders', kind: 'data', via: [[5, 3]], fromSide: 'n', toSide: 's' })]) }))
  it('adds a component joined from another, as one undo step, with the relationship guessed as for any drawn line', () => {
    const id = S().addLinked('s3', 0, 8, { from: 'a' })
    expect(S().doc.nodes.at(-1)).toMatchObject({ id, type: 's3', x: 0, y: 8 })
    expect(S().doc.edges.at(-1)).toMatchObject({ from: 'a', to: id, origin: 'drawn', kind: 'data' })
    expect(S().selection).toEqual([id])
    expect(S().past).toHaveLength(1)
    S().undo()
    expect([S().doc.nodes.length, S().doc.edges.length]).toEqual([2, 1])
  })
  it('puts a component into the middle of a connection: both halves keep what the line was, each end keeps its own door', () => {
    const id = S().addLinked('lambda', 4, 0, { into: 'e' })
    expect(S().doc.edges.map((x) => [x.from, x.to])).toEqual([['a', id], [id, 'b']])
    expect(S().doc.edges[0]).toMatchObject({ id: 'e', label: 'orders', kind: 'data', fromSide: 'n' })
    expect(S().doc.edges[0].toSide).toBeUndefined()
    expect(S().doc.edges[1]).toMatchObject({ kind: 'data', toSide: 's' })
    expect(S().doc.edges[1].fromSide).toBeUndefined()
    expect(S().doc.edges[1].id).not.toBe('e')
    expect(S().doc.edges.every((x) => x.via === undefined)).toBe(true)
    expect(S().past).toHaveLength(1)
  })
  it('still adds the component when what it was to be joined to has gone', () => {
    const one = S().addLinked('s3', 0, 8, { from: 'nope' }), two = S().addLinked('s3', 4, 8, { into: 'nope' })
    expect(S().doc.nodes.map((n) => n.id)).toEqual(['a', 'b', one, two])
    expect(S().doc.edges).toHaveLength(1)
  })
})

describe('paths are planned as part of the edit that calls for them', () => {
  it('a new connection is planned when it is made, an old blueprint when it is opened, and neither again after', () => {
    resetStore({ doc: docOf([node('a'), node('b', 'ec2', 8, 4), node('c', 'ec2', 0, 8)]) })
    S().addEdge('a', 'b')
    const first = S().doc.edges[0]
    expect(first.plan!.pts.length).toBeGreaterThan(1)
    // unrelated edits leave the very same connection object in place
    S().addNode('rds', 4, 2)
    S().patchNode('c', { name: 'renamed' })
    S().nudge(0, 0)
    expect(S().doc.edges[0]).toBe(first)
    // moving one of its own ends plans it again, in that same step
    S().select(['b'])
    S().nudge(1, 0)
    expect(S().doc.edges[0].plan!.key).not.toBe(first.plan!.key)
    expect(S().past.at(-1)!.edges[0]).toBe(first)
    // undo brings back the plan it had, not a fresh one
    S().undo()
    expect(S().doc.edges[0]).toBe(first)
    // opening a blueprint from before plans existed gives every line the path it is drawn with
    S().load(docOf([node('a'), node('b', 'ec2', 8, 0)], [edge('e', 'a', 'b')]))
    expect(S().doc.edges[0].plan).toMatchObject({ fromSide: 'e', toSide: 'w', pts: [[2, 1], [8, 1]] })
    expect(S()).toMatchObject({ saved: true, past: [] })
  })
  it('handing a line back to the router plans it now, and keeps nothing of what it carried', () => {
    resetStore({ doc: docOf([node('a'), node('b', 'ec2', 8, 4)], [edge('e', 'a', 'b')]) })
    S().load(S().doc)
    const planned = S().doc.edges[0].plan!
    // something is dropped in its way: it stays as it was, until it is asked for again
    S().addNode('rds', 4, 2)
    expect(S().doc.edges[0].plan).toBe(planned)
    S().resetRoute(['e'])
    expect(S().doc.edges[0].plan!.pts).not.toEqual(planned.pts)
    expect(S().doc.edges[0].runs).toBeUndefined()
  })

})

describe('review regressions', () => {
  it('a planned line turned round keeps its path: the same points, the other way', () => {
    S().load(docOf([node('a', 'ec2', 0, 0), node('b', 'rds', 8, 4)], [edge('e', 'a', 'b')]))
    const was = S().doc.edges[0].plan!
    S().reverseEdge(['e'])
    const now = S().doc.edges[0]
    expect(now).toMatchObject({ from: 'b', to: 'a' })
    expect(now.plan!.pts).toEqual([...was.pts].reverse())
    expect([now.plan!.fromSide, now.plan!.toSide]).toEqual([was.toSide, was.fromSide])
    // and the plan still stands: nothing asks for it to be made again
    const kept = now.plan
    S().patchNode('a', { name: 'renamed' })
    expect(S().doc.edges[0].plan).toBe(kept)
  })
  it('positions are kept to the thousandth of a cell: fine nudges do not pile up stray decimals', () => {
    S().load(docOf([node('a', 'ec2', 0, 0)], [], { areas: [area('r', 0.1, 0.1, 4, 4)], labels: [label('l', 0.1, 0.1)] }))
    useStore.setState({ selection: ['a', 'r', 'l'] })
    for (let i = 0; i < 3; i++) S().nudge(0.05, 0.05)
    expect(S().doc.nodes[0]).toMatchObject({ x: 0.15, y: 0.15 })
    expect(S().doc.areas[0]).toMatchObject({ x: 0.25, y: 0.25 })
    expect(S().doc.labels[0]).toMatchObject({ x: 0.25, y: 0.25 })
  })
})
