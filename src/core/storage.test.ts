import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  addSnapshot, coerceDoc, decodeShare, deleteDoc, duplicateDoc, encodeShare, getPref, listDocs, listSnapshots, loadDoc, removeSnapshot, saveDoc, setPref,
} from './storage'
import { TEMPLATES } from './templates'
import { emptyDoc } from './types'
import { docOf, edge, node } from '../test/helpers'

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-03-01T00:00:00Z')) })
afterEach(() => { vi.useRealTimers() })

describe('blueprints', () => {
  it('saves, lists newest first, loads and deletes', () => {
    const a = { ...docOf([node('n1')]), id: 'a', name: 'Alpha', updatedAt: 100 }
    const b = { ...docOf(), id: 'b', name: 'Beta', updatedAt: 300 }
    expect(listDocs()).toEqual([])
    expect(saveDoc(a)).toBe(true)
    expect(saveDoc(b)).toBe(true)
    expect(listDocs()).toEqual([{ id: 'b', name: 'Beta', updatedAt: 300, nodes: 0 }, { id: 'a', name: 'Alpha', updatedAt: 100, nodes: 1 }])
    expect(loadDoc('a')).toEqual(a)
    expect(loadDoc('nope')).toBeNull()
    deleteDoc('a')
    expect(loadDoc('a')).toBeNull()
    expect(listDocs().map((m) => m.id)).toEqual(['b'])
  })
  it('replaces the index entry when a blueprint is saved again', () => {
    const a = { ...docOf(), id: 'a', name: 'One', updatedAt: 1 }
    saveDoc(a)
    saveDoc({ ...a, name: 'Two', updatedAt: 2, nodes: [node('x'), node('y')] })
    expect(listDocs()).toEqual([{ id: 'a', name: 'Two', updatedAt: 2, nodes: 2 }])
  })
  it('deleting a blueprint removes its versions too, and is safe for unknown ids', () => {
    const a = { ...docOf(), id: 'a' }
    saveDoc(a)
    addSnapshot(a, 'v1')
    deleteDoc('a')
    expect(listSnapshots('a')).toEqual([])
    expect(() => deleteDoc('missing')).not.toThrow()
  })
  it('duplicates under a new id with a fresh timestamp', () => {
    const a = { ...docOf([node('n1')], []), id: 'a', name: 'Alpha', createdAt: 5, updatedAt: 5 }
    saveDoc(a)
    const copy = duplicateDoc('a')!
    expect(copy.id).not.toBe('a')
    expect(copy).toMatchObject({ name: 'Alpha (copy)', createdAt: Date.now(), updatedAt: Date.now() })
    expect(copy.nodes).toEqual(a.nodes)
    expect(loadDoc(copy.id)).toEqual(copy)
    expect(listDocs()).toHaveLength(2)
    expect(duplicateDoc('missing')).toBeNull()
  })
  it('uses its own key prefix and leaves other keys alone', () => {
    localStorage.setItem('other-app', 'x')
    saveDoc({ ...docOf(), id: 'a' })
    expect(Object.keys(JSON.parse(JSON.stringify({ k: localStorage.getItem('stratum:doc:a') })))).toEqual(['k'])
    expect(localStorage.getItem('stratum:index')).toContain('"a"')
    deleteDoc('a')
    expect(localStorage.getItem('other-app')).toBe('x')
  })
})

describe('resilience', () => {
  it('falls back when stored JSON is corrupt', () => {
    localStorage.setItem('stratum:index', '{not json')
    localStorage.setItem('stratum:doc:a', 'undefined')
    localStorage.setItem('stratum:pref:theme', '')
    expect(listDocs()).toEqual([])
    expect(loadDoc('a')).toBeNull()
    expect(getPref('theme', 'dark')).toBe('dark')
    // and a save repairs the index
    saveDoc({ ...docOf(), id: 'b' })
    expect(listDocs().map((m) => m.id)).toEqual(['b'])
  })
  it('ignores an index that is not a list', () => {
    localStorage.setItem('stratum:index', '{"a":1}')
    expect(listDocs()).toEqual([])
    expect(saveDoc({ ...docOf(), id: 'b' })).toBe(true)
    expect(listDocs().map((m) => m.id)).toEqual(['b'])
  })
  it('reports a failed save when storage is full, and does not list what it could not store', () => {
    const spy = vi.spyOn(Object.getPrototypeOf(localStorage), 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError') })
    expect(saveDoc({ ...docOf(), id: 'a' })).toBe(false)
    expect(setPref('theme', 'light')).toBe(false)
    spy.mockRestore()
    expect(listDocs()).toEqual([])
    expect(loadDoc('a')).toBeNull()
  })
  it('keeps the last good copy listed when a later save fails', () => {
    const a = { ...docOf(), id: 'a', name: 'Good', updatedAt: 1 }
    saveDoc(a)
    const spy = vi.spyOn(Object.getPrototypeOf(localStorage), 'setItem').mockImplementation(() => { throw new Error('full') })
    expect(saveDoc({ ...a, name: 'Lost', updatedAt: 2 })).toBe(false)
    spy.mockRestore()
    expect(listDocs()).toEqual([{ id: 'a', name: 'Good', updatedAt: 1, nodes: 0 }])
    expect(loadDoc('a')!.name).toBe('Good')
  })
  it('survives storage that throws on read', () => {
    const spy = vi.spyOn(Object.getPrototypeOf(localStorage), 'getItem').mockImplementation(() => { throw new Error('denied') })
    expect(listDocs()).toEqual([])
    expect(loadDoc('a')).toBeNull()
    expect(getPref('x', 7)).toBe(7)
    spy.mockRestore()
  })
})

describe('versions', () => {
  it('stores newest first and removes by id', () => {
    const d = { ...docOf([node('n1')]), id: 'a' }
    addSnapshot(d, 'first')
    vi.advanceTimersByTime(1000)
    addSnapshot({ ...d, nodes: [] }, 'second')
    const snaps = listSnapshots('a')
    expect(snaps.map((s) => s.name)).toEqual(['second', 'first'])
    expect(snaps[0].at - snaps[1].at).toBe(1000)
    expect(snaps[1].doc.nodes).toHaveLength(1)
    removeSnapshot('a', snaps[0].id)
    expect(listSnapshots('a').map((s) => s.name)).toEqual(['first'])
    removeSnapshot('a', 'missing')
    expect(listSnapshots('a')).toHaveLength(1)
    expect(listSnapshots('other')).toEqual([])
  })
  it('keeps only the 20 most recent', () => {
    const d = { ...docOf(), id: 'a' }
    for (let i = 1; i <= 25; i++) addSnapshot(d, 'v' + i)
    const names = listSnapshots('a').map((s) => s.name)
    expect(names).toHaveLength(20)
    expect(names[0]).toBe('v25')
    expect(names[19]).toBe('v6')
  })
})

describe('preferences', () => {
  it('round-trips values of any JSON type', () => {
    expect(getPref('flow', true)).toBe(true)
    setPref('flow', false)
    expect(getPref('flow', true)).toBe(false)
    setPref('n', 0)
    expect(getPref('n', 5)).toBe(0) // a stored falsy value is still a stored value
    setPref('obj', { a: [1, 2] })
    expect(getPref('obj', null)).toEqual({ a: [1, 2] })
  })
})

describe('coerceDoc', () => {
  it('rejects anything that is not a blueprint', () => {
    for (const junk of [null, undefined, 0, 'x', true, [], [1], {}, { nodes: 'no' }, { nodes: {} }, { nodes: null }]) expect(coerceDoc(junk), JSON.stringify(junk)).toBeNull()
  })
  it('fills in defaults for a minimal blueprint and always issues a new id', () => {
    const d = coerceDoc({ nodes: [] })!
    expect(d).toMatchObject({ name: 'Imported blueprint', region: 'us-east-1', nodes: [], edges: [], areas: [], labels: [], createdAt: Date.now(), updatedAt: Date.now() })
    expect(coerceDoc({ id: 'keep-me', nodes: [] })!.id).not.toBe('keep-me')
    expect(coerceDoc({ nodes: [], name: 42, region: [] })).toMatchObject({ name: 'Imported blueprint', region: 'us-east-1' })
    expect(coerceDoc({ nodes: [], name: 'Mine', region: 'eu-west-1' })).toMatchObject({ name: 'Mine', region: 'eu-west-1' })
  })
  it('drops malformed components and normalises the rest', () => {
    const d = coerceDoc({
      nodes: [
        null, 5, 'x', {}, { type: 7 },
        { id: 'a', type: 'ec2', x: '3', y: NaN, name: 9, props: 'no', color: 1, notes: {}, link: [] },
        { id: 'b', type: 'rds', x: Infinity, y: -Infinity, name: 'DB', props: { size: 'large' }, color: '#fff', notes: 'n', link: 'https://x' },
        { type: 'lambda', x: 1.5, y: -2 },
      ],
    })!
    expect(d.nodes).toHaveLength(3)
    expect(d.nodes[0]).toEqual({ id: 'a', type: 'ec2', x: 0, y: 0, name: undefined, props: {}, color: undefined, notes: undefined, link: undefined })
    expect(d.nodes[1]).toEqual({ id: 'b', type: 'rds', x: 0, y: 0, name: 'DB', props: { size: 'large' }, color: '#fff', notes: 'n', link: 'https://x' })
    expect(d.nodes[2]).toMatchObject({ type: 'lambda', x: 1.5, y: -2, props: {} })
    expect(d.nodes[2].id).toMatch(/^[a-z0-9]+$/)
  })
  it('does not accept an array as a component\'s settings', () => {
    expect(coerceDoc({ nodes: [{ id: 'a', type: 'ec2', props: [1, 2] }] })!.nodes[0].props).toEqual({})
  })
  it('gives repeated component ids a new id so nothing collides', () => {
    const d = coerceDoc({ nodes: [{ id: 'a', type: 'ec2' }, { id: 'a', type: 'rds' }, { id: 'a', type: 's3' }], edges: [{ from: 'a', to: 'a' }] })!
    expect(new Set(d.nodes.map((n) => n.id)).size).toBe(3)
    expect(d.nodes[0].id).toBe('a')
  })
  it('keeps a size only when it is a real, in-range number other than the default', () => {
    const scale = (v: unknown) => coerceDoc({ nodes: [{ id: 'a', type: 'ec2', scale: v }] })!.nodes[0].scale
    expect(scale(0.5)).toBe(0.5)
    expect(scale(3)).toBe(3)
    expect(scale(1.25)).toBe(1.25)
    for (const bad of [1, 0.49, 3.01, 0, -1, NaN, Infinity, '2', null, undefined, {}]) expect(scale(bad), String(bad)).toBeUndefined()
    expect('scale' in coerceDoc({ nodes: [{ id: 'a', type: 'ec2', scale: 1 }] })!.nodes[0]).toBe(false)
  })
  it('keeps only connections between components that exist, and repairs their settings', () => {
    const d = coerceDoc({
      nodes: [{ id: 'a', type: 'ec2' }, { id: 'b', type: 'rds' }],
      edges: [
        null, 'x', { from: 'a' }, { from: 'a', to: 'ghost' }, { from: 'ghost', to: 'b' },
        { from: 'a', to: 'b' },
        { id: 'e2', from: 'b', to: 'a', label: 'sql', color: '#f00', style: 'dashed', arrow: 'both', width: 3.5 },
        { id: 'e3', from: 'a', to: 'b', label: 5, color: 5, style: 'wavy', arrow: 'start', width: 'thick' },
      ],
    })!
    expect(d.edges).toHaveLength(3)
    expect(d.edges[0]).toMatchObject({ from: 'a', to: 'b', label: undefined, color: undefined, style: 'solid', arrow: 'end', width: 2 })
    expect(d.edges[0].id).toBeTruthy()
    expect(d.edges[1]).toEqual({ id: 'e2', from: 'b', to: 'a', label: 'sql', color: '#f00', style: 'dashed', arrow: 'both', width: 3.5 })
    expect(d.edges[2]).toMatchObject({ id: 'e3', label: undefined, color: undefined, style: 'solid', arrow: 'end', width: 2 })
  })
  it('drops a connection from a component to itself', () => {
    expect(coerceDoc({ nodes: [{ id: 'a', type: 'ec2' }], edges: [{ from: 'a', to: 'a' }] })!.edges).toEqual([])
  })
  it('tolerates edges, areas and labels that are not lists', () => {
    const d = coerceDoc({ nodes: [], edges: 'x', areas: 5, labels: {} })!
    expect([d.edges, d.areas, d.labels]).toEqual([[], [], []])
  })
  it('normalises areas, skipping entries that are not objects', () => {
    const d = coerceDoc({ nodes: [], areas: [null, 'x', 3, {}, { id: 'v', x: 1, y: 2, w: 0, d: -4, name: 'Net', color: '#123456', kind: 'vpc' }, { w: 'wide', d: NaN, kind: 'castle', name: 1, color: 2 }] })!
    expect(d.areas).toHaveLength(3)
    expect(d.areas[0]).toMatchObject({ x: 0, y: 0, w: 4, d: 4, name: 'Area', color: '#8F6FF2', kind: 'group' })
    expect(d.areas[1]).toEqual({ id: 'v', x: 1, y: 2, w: 1, d: 1, name: 'Net', color: '#123456', kind: 'vpc' })
    expect(d.areas[2]).toMatchObject({ w: 4, d: 4, kind: 'group', name: 'Area', color: '#8F6FF2' })
    for (const k of ['vpc', 'subnet', 'zone', 'group']) expect(coerceDoc({ nodes: [], areas: [{ kind: k }] })!.areas[0].kind).toBe(k)
  })
  it('normalises labels, skipping entries that are not objects', () => {
    const d = coerceDoc({ nodes: [], labels: [null, 7, {}, { id: 'l', x: 1, y: 2, text: 'Hi', size: 30, color: '#fff', dir: 'y' }, { text: 5, size: 'big', dir: 'z', color: 0 }] })!
    expect(d.labels).toHaveLength(3)
    expect(d.labels[0]).toMatchObject({ x: 0, y: 0, text: 'Label', size: 20, color: undefined, dir: 'x' })
    expect(d.labels[1]).toEqual({ id: 'l', x: 1, y: 2, text: 'Hi', size: 30, color: '#fff', dir: 'y' })
    expect(d.labels[2]).toMatchObject({ text: 'Label', size: 20, dir: 'x' })
  })
  it('keeps label sizes within a drawable range', () => {
    const size = (v: number) => coerceDoc({ nodes: [], labels: [{ size: v }] })!.labels[0].size
    expect(size(0)).toBe(20)
    expect(size(-12)).toBe(20)
    expect(size(1e9)).toBe(20)
    expect(size(8)).toBe(8)
    expect(size(96)).toBe(96)
  })
  it('passes a real blueprint through unchanged apart from id and timestamps', () => {
    for (const t of TEMPLATES) {
      const src = t.make()
      const back = coerceDoc(JSON.parse(JSON.stringify(src)))!
      const strip = ({ id: _i, createdAt: _c, updatedAt: _u, ...rest }: any) => JSON.parse(JSON.stringify(rest))
      expect(strip(back)).toEqual(strip(src))
    }
  })
})

describe('share links', () => {
  beforeEach(() => { vi.useRealTimers() })
  it('round-trips a blueprint through a url-safe payload', async () => {
    const src = TEMPLATES[0].make()
    const payload = await encodeShare(src)
    expect(payload).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(payload.length).toBeLessThan(JSON.stringify(src).length / 2)
    const back = (await decodeShare(payload))!
    expect(back.id).not.toBe(src.id)
    expect(back.name).toBe(src.name)
    expect(back.nodes).toEqual(JSON.parse(JSON.stringify(src.nodes)))
    expect(back.edges).toEqual(JSON.parse(JSON.stringify(src.edges)))
    expect(back.areas).toEqual(src.areas)
    expect(back.labels).toEqual(JSON.parse(JSON.stringify(src.labels)))
  })
  it('does not leak the local id or timestamps into the link', async () => {
    const src = { ...emptyDoc('Secret plan'), id: 'local-id-123', createdAt: 111222333, updatedAt: 444555666 }
    const back = (await decodeShare(await encodeShare(src)))!
    expect(back.id).not.toBe('local-id-123')
    expect(back.createdAt).not.toBe(111222333)
  })
  it('keeps unicode names and notes intact', async () => {
    const src = docOf([node('a', 'ec2', 0, 0, { name: 'café ☁️ 日本', notes: 'line1\nline2 "quoted"' })], [], { name: 'Ünïcødé' })
    const back = (await decodeShare(await encodeShare(src)))!
    expect(back.name).toBe('Ünïcødé')
    expect(back.nodes[0]).toMatchObject({ name: 'café ☁️ 日本', notes: 'line1\nline2 "quoted"' })
  })
  it('round-trips an empty blueprint and a very large one', async () => {
    expect((await decodeShare(await encodeShare(emptyDoc())))!.nodes).toEqual([])
    const big = docOf(Array.from({ length: 1500 }, (_, i) => node('n' + i, 'ec2', i * 3, 0)), Array.from({ length: 1499 }, (_, i) => edge('e' + i, 'n' + i, 'n' + (i + 1))))
    const back = (await decodeShare(await encodeShare(big)))!
    expect(back.nodes).toHaveLength(1500)
    expect(back.edges).toHaveLength(1499)
  })
  it('returns null for damaged or hostile payloads', async () => {
    const good = await encodeShare(TEMPLATES[1].make())
    for (const bad of ['', '!!!', 'AAAA', good.slice(0, 20), good.slice(10), 'not base64 at all %%%', good.slice(0, -40)]) {
      expect(await decodeShare(bad), bad.slice(0, 12)).toBeNull()
    }
  })
  it('returns null when the payload decodes to something that is not a blueprint', async () => {
    const pack = async (v: unknown) => {
      const bytes = new Uint8Array(await new Response(new Blob([JSON.stringify(v)]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer())
      return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    }
    expect(await decodeShare(await pack({ hello: 'world' }))).toBeNull()
    expect(await decodeShare(await pack([1, 2, 3]))).toBeNull()
    expect(await decodeShare(await pack(null))).toBeNull()
    expect((await decodeShare(await pack({ nodes: [{ type: 'ec2' }], areas: [null], labels: [null] })))!.nodes).toHaveLength(1)
  })
})

describe('loadDoc repairs what it reads', () => {
  const put = (id: string, raw: unknown) => localStorage.setItem('stratum:doc:' + id, JSON.stringify(raw))

  it('fills in missing collections and positions instead of handing the editor a broken blueprint', () => {
    put('odd', { id: 'odd', name: 'Odd', nodes: [{ id: 'a', type: 'ec2' }, { id: 'b', type: 'no-such-type', x: 4, y: 'x' }], edges: [{ id: 'e', from: 'a', to: 'missing' }] })
    const d = loadDoc('odd')!
    expect(d.nodes.map((n) => [n.id, n.x, n.y, n.props])).toEqual([['a', 0, 0, {}], ['b', 4, 0, {}]])
    expect(d.edges).toEqual([])
    expect(d.areas).toEqual([])
    expect(d.labels).toEqual([])
    expect(d.region).toBe('us-east-1')
  })

  it('keeps the identity of the stored blueprint: id, name and timestamps', () => {
    put('keep', { id: 'something-else', name: '', nodes: [], createdAt: 111, updatedAt: 222 })
    const d = loadDoc('keep')!
    // the storage key wins, so a copied or hand-edited file cannot open under another blueprint's id
    expect(d.id).toBe('keep')
    expect(d.name).toBe('')
    expect([d.createdAt, d.updatedAt]).toEqual([111, 222])
  })

  it('gives sensible defaults for a missing name or timestamps', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-01T00:00:00Z'))
    put('bare', { nodes: [], name: 42, createdAt: 'yesterday' })
    const d = loadDoc('bare')!
    expect(d.name).toBe('Untitled blueprint')
    expect(d.createdAt).toBe(Date.parse('2026-03-01T00:00:00Z'))
    expect(d.updatedAt).toBe(Date.parse('2026-03-01T00:00:00Z'))
    vi.useRealTimers()
  })

  it('returns nothing for a value that is not a blueprint at all', () => {
    for (const raw of [null, 7, 'text', [], {}, { nodes: 'many' }]) { put('junk', raw); expect(loadDoc('junk')).toBeNull() }
  })

  it('round-trips a healthy blueprint unchanged', () => {
    const doc = { ...emptyDoc('Fine'), id: 'fine', nodes: [{ id: 'a', type: 'ec2', x: 1, y: 2, name: 'web', props: { count: 2 }, scale: 1.5 }], edges: [], areas: [{ id: 'z', x: 0, y: 0, w: 4, d: 4, name: 'VPC', color: '#8F6FF2', kind: 'vpc' as const }] }
    saveDoc(doc)
    expect(loadDoc('fine')).toEqual(doc)
  })
})

describe('coerceDoc: connections', () => {
  const raw = (e: object) => ({ nodes: [{ id: 'a', type: 'ec2', x: 0, y: 0 }, { id: 'b', type: 'rds', x: 8, y: 0 }], edges: [{ id: 'e', from: 'a', to: 'b', ...e }] })
  it('an older file with none of the new fields reads as a plain automatic connection', () => {
    const e = coerceDoc(raw({}))!.edges[0]
    expect(e).toMatchObject({ style: 'solid', arrow: 'end', width: 2 })
    for (const k of ['kind', 'protocol', 'port', 'origin', 'via', 'fromSide', 'toSide']) expect(k in e, k).toBe(false)
  })
  it('keeps what a connection means and how it was shaped', () => {
    const e = coerceDoc(raw({ kind: 'event', protocol: 'AMQP', port: '5672', origin: 'imported', via: [[4, 5], [6.5, 5]], fromSide: 's', toSide: 'w' }))!.edges[0]
    expect(e).toMatchObject({ kind: 'event', protocol: 'AMQP', port: '5672', origin: 'imported', via: [[4, 5], [6.5, 5]], fromSide: 's', toSide: 'w' })
  })
  it('drops anything it does not recognise rather than trusting it', () => {
    const e = coerceDoc(raw({ kind: 'telepathy', origin: 'observed', fromSide: 'up', toSide: 7, protocol: 5, port: {}, via: [[1, 'x']] }))!.edges[0] as any
    for (const k of ['kind', 'protocol', 'port', 'origin', 'via', 'fromSide', 'toSide']) expect(k in e, k).toBe(false)
  })
  it('keeps a line\'s track, where its ends sit and how it is drawn, so a straightened line is still straight after a round trip', () => {
    const e = coerceDoc(raw({ shape: 'curved', runs: [3, 7.5, 6], fromAt: 0.5, toAt: -0.25, fromSide: 'e', toSide: 'w' }))!.edges[0]
    expect(e).toMatchObject({ shape: 'curved', runs: [3, 7.5, 6], fromAt: 0.5, toAt: -0.25 })
    expect(coerceDoc(raw({ runs: [], shape: 'direct' }))!.edges[0]).toMatchObject({ runs: [], shape: 'direct' })
  })
  it('refuses a track, an end position or a shape that is not what it should be', () => {
    for (const bad of [{ runs: [1, 'x'] }, { runs: 'x' }, { runs: [NaN] }, { runs: Array.from({ length: 65 }, () => 1) }]) expect('runs' in coerceDoc(raw(bad))!.edges[0], JSON.stringify(bad).slice(0, 30)).toBe(false)
    const e = coerceDoc(raw({ fromAt: 'x', toAt: Infinity, shape: 'wiggly' }))!.edges[0]
    for (const k of ['fromAt', 'toAt', 'shape']) expect(k in e, k).toBe(false)
  })
  it('refuses waypoints that are not finite pairs, or absurdly many', () => {
    for (const via of [[[1, 2, 3]], [[NaN, 1]], [[Infinity, 0]], 'x', [], Array.from({ length: 65 }, () => [1, 1])]) expect('via' in coerceDoc(raw({ via }))!.edges[0], JSON.stringify(via).slice(0, 30)).toBe(false)
  })
  it('caps the length of protocol and port', () => {
    const e = coerceDoc(raw({ protocol: 'x'.repeat(200), port: '9'.repeat(200) }))!.edges[0]
    expect(e.protocol).toHaveLength(40); expect(e.port).toHaveLength(40)
  })
})
