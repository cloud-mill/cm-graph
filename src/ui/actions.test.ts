// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { cam } from '../canvas/camera'
import { CATALOG_LIST, equivalent, providerOf } from '../core/catalog'
import { decodeShare, listSnapshots } from '../core/storage'
import { useStore } from '../core/store'
import type { EdgeT } from '../core/types'
import { docOf, edge, node, resetStore } from '../test/helpers'
import { addAtCenter, cleanLines, fitAreaToContents, saveVersion, selectAll, shareUrl, tidy, translateTo, wrapSelectionInArea } from './actions'

const S = () => useStore.getState()
beforeEach(() => { resetStore(); Object.assign(cam, { w: 1200, h: 800, left: 0, top: 0 }) })

describe('translateTo', () => {
  // an AWS component with no counterpart on Google Cloud, found from the catalog rather than assumed
  const orphan = CATALOG_LIST.find((d) => d.provider === 'aws' && !equivalent(d.type, 'gcp'))

  it('moves one component and says so in the singular', () => {
    resetStore({ doc: docOf([node('a', 'ec2'), node('u', 'users', 4)]) })
    translateTo('gcp')
    expect(providerOf(S().doc.nodes[0].type)).toBe('gcp')
    expect(S().doc.nodes[1].type).toBe('users')
    expect(S().toasts.at(-1)!.text).toBe('Moved 1 component to GCP')
    expect(S().provider).toBe('gcp')
  })
  it('warns when everything is already there, without an undo step', () => {
    resetStore({ doc: docOf([node('u', 'users')]) })
    translateTo('azure')
    expect(S().toasts.at(-1)).toMatchObject({ text: 'Already on Azure', kind: 'warn' })
    expect(S().past).toHaveLength(0)
    expect(S().provider).toBe('aws')
  })
  it.skipIf(!orphan)('reports components that have no equivalent', () => {
    resetStore({ doc: docOf([node('a', 'ec2'), node('x', orphan!.type, 4)]) })
    translateTo('gcp')
    expect(S().toasts.at(-1)!.text).toBe('Moved 1 component to GCP · 1 had no equivalent')
    expect(S().doc.nodes[1].type).toBe(orphan!.type)
    resetStore({ doc: docOf([node('x', orphan!.type)]) })
    translateTo('gcp')
    expect(S().toasts.at(-1)).toMatchObject({ text: 'No GCP equivalent for the remaining components', kind: 'warn' })
  })
})

describe('placing and grouping', () => {
  it('drops components side by side, wrapping onto new rows, never on top of each other', () => {
    for (let i = 0; i < 12; i++) addAtCenter('ec2')
    const nodes = S().doc.nodes
    expect(nodes).toHaveLength(12)
    for (const a of nodes) for (const b of nodes) if (a !== b) expect(Math.abs(a.x - b.x) >= 2 || Math.abs(a.y - b.y) >= 2).toBe(true)
    expect(new Set(nodes.map((n) => n.y)).size).toBeGreaterThan(1)
    expect(nodes.map((n) => n.name)).toEqual(Array.from({ length: 12 }, (_, i) => `ec2-${i + 1}`))
  })
  it('selects components, areas and labels, but not connections', () => {
    resetStore({ doc: docOf([node('a')], [], { areas: [{ id: 'r', x: 0, y: 0, w: 4, d: 4, name: 'A', color: '#fff', kind: 'group' }], labels: [{ id: 'l', x: 0, y: 0, text: 't', size: 20, dir: 'x' }] }) })
    selectAll()
    expect(S().selection).toEqual(['a', 'r', 'l'])
  })
  it('does nothing when asked to group or fit without anything to work on', () => {
    resetStore({ doc: docOf([node('a')]), selection: [] })
    wrapSelectionInArea()
    fitAreaToContents('no-such-area')
    tidy()
    expect(S().doc.areas).toHaveLength(0)
    expect(S().past).toHaveLength(1) // only the tidy
    resetStore()
    tidy()
    expect(S().toasts).toHaveLength(0)
  })
})

describe('versions and sharing', () => {
  it('saves a version under the given name, or a dated one', () => {
    resetStore({ doc: docOf([node('a')]) })
    saveVersion('Before launch')
    saveVersion()
    const [auto, named] = listSnapshots('doc1')
    expect(named.name).toBe('Before launch')
    expect(auto.name).toMatch(/^Version .*\d/)
    expect(auto.doc.nodes).toHaveLength(1)
  })
  it('builds a link to this page that decodes to the blueprint', async () => {
    resetStore({ doc: docOf([node('a', 'ec2', 3, 4, { name: 'web' })], [], { name: 'Linked' }) })
    const url = await shareUrl()
    expect(url.startsWith(location.origin + location.pathname + '#/s/')).toBe(true)
    const back = await decodeShare(url.split('#/s/')[1])
    expect(back).toMatchObject({ name: 'Linked' })
    expect(back!.nodes[0]).toMatchObject({ name: 'web', x: 3, y: 4 })
  })
})

describe('cleanLines', () => {
  const kinked: Partial<EdgeT> = { fromSide: 'e', toSide: 'w', fromAt: 0, toAt: 0, runs: [3, 1.04, 5, 3, 6] }
  const made: Partial<EdgeT> = { fromSide: 'e', toSide: 'w', fromAt: 0, toAt: 0, runs: [3, 1.5, 5, 3, 6] }
  const two = () => docOf([node('a', 'ec2', 0, 0), node('b', 'rds', 8, 4), node('c', 'ec2', 0, 10), node('d', 'rds', 8, 14)], [edge('e', 'a', 'b', kinked), edge('f', 'c', 'd', { ...kinked, runs: [3, 11.04, 5, 13, 6] })])

  it('takes the small kinks out of the lines picked, as one undo step, and says how many', () => {
    resetStore({ doc: two(), selection: ['e', 'a'] })
    cleanLines()
    expect(S().doc.edges.map((e) => e.runs)).toEqual([[5, 3, 6], [3, 11.04, 5, 13, 6]])
    expect(S().toasts.at(-1)!.text).toBe('Straightened 1 line')
    expect(S().past).toHaveLength(1)
  })
  it('with no line picked it goes through all of them', () => {
    resetStore({ doc: two(), selection: [] })
    cleanLines()
    expect(S().doc.edges.map((e) => e.runs)).toEqual([[5, 3, 6], [5, 13, 6]])
    expect(S().toasts.at(-1)!.text).toBe('Straightened 2 lines')
  })
  it('leaves a step somebody made alone, says so, and makes no undo step', () => {
    resetStore({ doc: docOf([node('a', 'ec2', 0, 0), node('b', 'rds', 8, 4)], [edge('e', 'a', 'b', made)]) })
    cleanLines(['e'])
    expect(S().doc.edges[0].runs).toEqual([3, 1.5, 5, 3, 6])
    expect(S().toasts.at(-1)!.text).toBe('No small kinks to take out')
    expect(S().past).toHaveLength(0)
  })
})
