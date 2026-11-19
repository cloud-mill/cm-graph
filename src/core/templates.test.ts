import { describe, expect, it } from 'vitest'
import { CATALOG, defaultProps, docProviders } from './catalog'
import { AREA_COLORS, Builder, TEMPLATES, instantiate } from './templates'

describe('Builder', () => {
  it('adds components with defaults merged under the given settings', () => {
    const b = new Builder('Draft')
    const id = b.n('ec2', 1, 2, 'web', { count: 3 })
    expect(b.doc.name).toBe('Draft')
    expect(b.doc.nodes[0]).toEqual({ id, type: 'ec2', x: 1, y: 2, name: 'web', props: { ...defaultProps('ec2'), count: 3 } })
    expect(b.n('users', 0, 0)).not.toBe(id)
    expect(b.doc.nodes[1]).toMatchObject({ name: undefined, props: {} })
  })
  it('adds connections, areas and labels with their defaults', () => {
    const b = new Builder('Draft')
    const a = b.n('ec2', 0, 0), c = b.n('rds', 4, 0)
    b.e(a, c)
    b.e(c, a, 'replicate', { style: 'dashed', arrow: 'both', width: 3.5 })
    expect(b.doc.edges[0]).toMatchObject({ from: a, to: c, label: undefined, style: 'solid', arrow: 'end', width: 2 })
    expect(b.doc.edges[1]).toMatchObject({ from: c, to: a, label: 'replicate', style: 'dashed', arrow: 'both', width: 3.5 })
    b.area('vpc', 'Net', 1, 2, 3, 4, AREA_COLORS.vpc)
    expect(b.doc.areas[0]).toMatchObject({ kind: 'vpc', name: 'Net', x: 1, y: 2, w: 3, d: 4, color: '#8F6FF2' })
    b.label('Title', 5, 6)
    b.label('Side', 0, 0, 14, 'y')
    expect(b.doc.labels).toMatchObject([{ text: 'Title', x: 5, y: 6, size: 22, dir: 'x' }, { text: 'Side', size: 14, dir: 'y' }])
    expect(new Set([...b.doc.nodes, ...b.doc.edges, ...b.doc.areas, ...b.doc.labels].map((x) => x.id)).size).toBe(7)
  })
})

describe('templates', () => {
  it('have unique ids and complete card copy', () => {
    expect(new Set(TEMPLATES.map((t) => t.id)).size).toBe(TEMPLATES.length)
    expect(TEMPLATES).toHaveLength(6)
    for (const t of TEMPLATES) {
      expect(t.name.length).toBeGreaterThan(5)
      expect(t.blurb).toMatch(/\.$/)
      expect(t.tags.length).toBeGreaterThanOrEqual(2)
      expect(t.blurb + t.name).not.toMatch(/[‒-―−]/)
    }
  })
  it('instantiate returns an independent copy with fresh ids every time', () => {
    for (const t of TEMPLATES) {
      const a = instantiate(t), b = instantiate(t)
      expect(a.id).not.toBe(b.id)
      const idsA = new Set([...a.nodes, ...a.edges, ...a.areas, ...a.labels].map((x) => x.id))
      for (const x of [...b.nodes, ...b.edges, ...b.areas, ...b.labels]) expect(idsA.has(x.id)).toBe(false)
      // same content, different identity
      expect(b.nodes.map((n) => [n.type, n.x, n.y, n.name])).toEqual(a.nodes.map((n) => [n.type, n.x, n.y, n.name]))
      a.nodes[0].props.touched = true
      a.nodes.pop()
      expect(instantiate(t).nodes).toHaveLength(b.nodes.length)
      expect(instantiate(t).nodes[0].props.touched).toBeUndefined()
    }
  })
  it('use only known component types, valid ids and internally consistent references', () => {
    for (const t of TEMPLATES) {
      const d = t.make()
      const all = [...d.nodes, ...d.edges, ...d.areas, ...d.labels].map((x) => x.id)
      expect(new Set(all).size, t.id).toBe(all.length)
      const ids = new Set(d.nodes.map((n) => n.id))
      for (const n of d.nodes) expect(Object.hasOwn(CATALOG, n.type), `${t.id}: ${n.type}`).toBe(true)
      for (const e of d.edges) { expect(ids.has(e.from) && ids.has(e.to)).toBe(true); expect(e.from).not.toBe(e.to) }
      const pairs = d.edges.map((e) => [e.from, e.to].sort().join('|'))
      expect(new Set(pairs).size, t.id + ' duplicate connections').toBe(pairs.length)
      for (const a of d.areas) { expect(a.w).toBeGreaterThan(0); expect(a.d).toBeGreaterThan(0) }
      expect(d.name).toBe(t.name === 'Three-tier web app' ? 'Three-tier web application' : d.name)
    }
  })
  it('the cloud-specific templates sit entirely on their cloud', () => {
    const by = (id: string) => TEMPLATES.find((t) => t.id === id)!.make()
    expect(docProviders(by('gcp-serverless'))).toEqual(['gcp'])
    expect(by('gcp-serverless').name).toBe('Serverless API on Google Cloud')
    expect(docProviders(by('azure-three-tier'))).toEqual(['azure'])
    expect(by('azure-three-tier').name).toBe('Three-tier web app on Azure')
    for (const id of ['three-tier', 'serverless', 'data', 'k8s']) expect(docProviders(by(id))).toEqual(['aws'])
  })
})
