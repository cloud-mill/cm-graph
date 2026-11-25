// @vitest-environment jsdom
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { CATALOG_LIST, type ModelKind } from '../core/catalog'
import { FLAT, ISO, makeCam, pt } from '../core/iso'
import { docOf, edge, node } from '../test/helpers'
import { GLYPHS } from './glyphs'
import { Model, ModelIcon, SceneDefs } from './models'
import { Scene, THEMES, brackets, sceneBounds } from './Scene'

const draw = (doc: ReturnType<typeof docOf>, props: Partial<Parameters<typeof Scene>[0]> = {}) =>
  render(<svg><Scene doc={doc} proj={ISO} theme={THEMES.dark} {...props} /></svg>).container

describe('Scene', () => {
  const doc = docOf(
    [node('a', 'ec2', 0, 0, { name: 'web' }), node('b', 'rds', 6, 0, { name: 'db' })],
    [edge('e1', 'a', 'b', { label: 'sql' })],
    {
      areas: [{ id: 'ar', x: -1, y: -1, w: 10, d: 4, name: 'Prod', color: '#8F6FF2', kind: 'vpc' }],
      labels: [{ id: 'l1', x: 0, y: -3, text: 'Title\nsecond', size: 20, dir: 'x' }],
    },
  )
  it('draws every kind of item with the hooks the canvas hit-tests on', () => {
    const c = draw(doc)
    expect(c.querySelectorAll('[data-kind="node"]')).toHaveLength(2)
    expect(c.querySelector('[data-kind="node"][data-id="a"]')).not.toBeNull()
    expect(c.querySelector('[data-kind="edge"][data-id="e1"]')).not.toBeNull()
    expect(c.querySelectorAll('[data-kind="area"][data-id="ar"]')).toHaveLength(2) // border and name
    const label = c.querySelector('[data-kind="label"][data-id="l1"]')!
    expect(label.querySelectorAll('tspan')).toHaveLength(2)
    expect(c.textContent).toContain('web')
    expect(c.textContent).toContain('PROD')
    expect(c.textContent).toContain('SQL')
  })
  it('hides component names on request but keeps other text', () => {
    const c = draw(doc, { showLabels: false })
    expect(c.querySelector('.nd-label')).toBeNull()
    expect(c.textContent).not.toContain('web')
    expect(c.textContent).toContain('PROD')
  })
  it('shows instance counts next to names', () => {
    const c = draw(docOf([node('a', 'ec2', 0, 0, { name: 'web', props: { count: 3 } }), node('b', 'ecs', 4, 0, { name: 'svc', props: { tasks: 5 } }), node('c', 'rds', 8, 0, { name: 'one', props: { count: 1 } })]))
    const labels = [...c.querySelectorAll('.nd-label')].map((l) => l.textContent)
    expect(labels).toContain('web  ×3')
    expect(labels).toContain('svc  ×5')
    expect(labels).toContain('one')
  })
  it('applies a lens: recolours the body and adds a note', () => {
    const plain = draw(docOf([node('a')])).querySelector('.nd-body')!.innerHTML
    const c = draw(docOf([node('a')]), { lens: new Map([['a', { color: '#E5574F', note: '$12/mo' }]]) })
    expect(c.querySelector('.nd-label')!.textContent).toContain('$12/mo')
    expect(c.querySelector('.nd-body')!.innerHTML).not.toBe(plain)
  })
  it('scales a resized component body and leaves the default untouched', () => {
    const c = draw(docOf([node('a'), node('b', 'ec2', 6, 0, { scale: 2 })]))
    expect(c.querySelector('[data-id="a"] .nd-body > g[transform^="scale"]')).toBeNull()
    expect(c.querySelector('[data-id="b"] .nd-body > g')!.getAttribute('transform')).toBe('scale(2)')
  })
  it('marks a just-added component so it can animate in', () => {
    const c = draw(docOf([node('a'), node('b', 'ec2', 6, 0)]), { fresh: 'b' })
    expect(c.querySelector('[data-id="b"]')).toHaveClass('nd-new')
    expect(c.querySelector('[data-id="a"]')).not.toHaveClass('nd-new')
  })
  it('draws line styles, arrowheads, colour and traffic', () => {
    const two = [node('a'), node('b', 'ec2', 8, 0)]
    const all = (e: Parameters<typeof edge>[3], flow = false) => draw(docOf(two, [edge('e', 'a', 'b', e)]), { flow })
    const one = (e: Parameters<typeof edge>[3]) => all(e).querySelector('.edge')!
    expect(one({}).querySelector('.edge-line')!.getAttribute('stroke-dasharray')).toBeNull()
    expect(one({ style: 'dashed' }).querySelector('.edge-line')!.getAttribute('stroke-dasharray')).toBe('5 5')
    expect(one({ style: 'dotted' }).querySelector('.edge-line')!.getAttribute('stroke-dasharray')).toBe('0.5 5')
    expect(one({ arrow: 'none' }).querySelectorAll('polygon')).toHaveLength(0)
    expect(one({ arrow: 'end' }).querySelectorAll('polygon')).toHaveLength(1)
    expect(one({ arrow: 'both' }).querySelectorAll('polygon')).toHaveLength(2)
    expect(one({ color: '#123456' }).querySelector('.edge-line')!.getAttribute('stroke')).toBe('#123456')
    expect(one({}).querySelector('.edge-line')!.getAttribute('stroke')).toBe(THEMES.dark.edge)
    // traffic and captions are layers of their own, over the lines: neither is part of the line's own group
    expect(all({}).querySelector('.edge-flow')).toBeNull()
    expect(all({}, true).querySelector('.edge-flow')).not.toBeNull()
    expect(one({}).querySelector('.edge-flow')).toBeNull()
    expect(all({}).querySelector('.edge-caption')).toBeNull()
    expect(all({ label: 'sql' }).querySelector('.edge-caption')!.textContent).toBe('SQL')
  })
  it('given a window, draws only what touches it: components, lines with their captions and traffic, areas and labels', () => {
    // two groups of everything, the second two hundred cells away
    const both = docOf(
      [node('a', 'ec2', 0, 0), node('b', 'rds', 6, 0), node('c', 'ec2', 200, 200), node('d', 'rds', 206, 200)],
      [edge('near', 'a', 'b', { label: 'sql' }), edge('far', 'c', 'd', { label: 'sql' })],
      {
        areas: [{ id: 'A', x: -1, y: -1, w: 10, d: 4, name: 'Here', color: '#8F6FF2', kind: 'vpc' }, { id: 'B', x: 199, y: 199, w: 10, d: 4, name: 'There', color: '#8F6FF2', kind: 'vpc' }],
        labels: [{ id: 'L', x: 0, y: -3, text: 'Here\nsecond', size: 20, dir: 'x' }, { id: 'M', x: 200, y: 197, text: 'There', size: 20, dir: 'y' }],
      },
    )
    const ids = (c: HTMLElement, kind: string) => [...new Set([...c.querySelectorAll(`[data-kind="${kind}"]`)].map((el) => el.getAttribute('data-id')))].sort()
    const all = draw(both, { flow: true })
    expect(ids(all, 'node')).toEqual(['a', 'b', 'c', 'd'])
    expect(ids(all, 'edge')).toEqual(['far', 'near'])
    expect(all.querySelectorAll('.edge-flow')).toHaveLength(2)
    // a window round the first group, a few hundred pixels each way
    const [x, y] = pt(ISO, 3, 1)
    const here = draw(both, { flow: true, within: { x0: x - 500, y0: y - 400, x1: x + 500, y1: y + 400 } })
    expect(ids(here, 'node')).toEqual(['a', 'b'])
    expect(ids(here, 'edge')).toEqual(['near'])
    expect(ids(here, 'area')).toEqual(['A'])
    expect(ids(here, 'label')).toEqual(['L'])
    expect([...here.querySelectorAll('.edge-flow')].map((el) => el.getAttribute('data-edge'))).toEqual(['near'])
    expect([...here.querySelectorAll('.edge-caption')].map((el) => el.getAttribute('data-edge'))).toEqual(['near'])
    expect(here.textContent).not.toContain('THERE')
    // and round the second
    const [fx, fy] = pt(ISO, 203, 201)
    const there = draw(both, { flow: true, within: { x0: fx - 500, y0: fy - 400, x1: fx + 500, y1: fy + 400 } })
    expect(ids(there, 'node')).toEqual(['c', 'd'])
    expect(ids(there, 'edge')).toEqual(['far'])
    expect(ids(there, 'area')).toEqual(['B'])
    expect(ids(there, 'label')).toEqual(['M'])
    // a window on nothing draws nothing, and is not an error
    expect(draw(both, { within: { x0: 1e6, y0: 1e6, x1: 1e6 + 10, y1: 1e6 + 10 } }).querySelectorAll('[data-kind]')).toHaveLength(0)
  })
  it('skips a connection whose end is missing instead of failing', () => {
    const c = draw(docOf([node('a')], [edge('e', 'a', 'gone')]))
    expect(c.querySelector('[data-kind="edge"]')).toBeNull()
    expect(c.querySelectorAll('[data-kind="node"]')).toHaveLength(1)
  })
  it('paints far components before near ones', () => {
    const c = draw(docOf([node('near', 'ec2', 10, 10), node('far', 'ec2', 0, 0)]))
    expect([...c.querySelectorAll('[data-kind="node"]')].map((n) => n.getAttribute('data-id'))).toEqual(['far', 'near'])
  })
  it('nests areas: outer kinds first, larger before smaller', () => {
    const a = (id: string, kind: any, w: number) => ({ id, x: 0, y: 0, w, d: 4, name: id, color: '#3DB87F', kind })
    const c = draw(docOf([], [], { areas: [a('sub', 'subnet', 4), a('small', 'vpc', 5), a('big', 'vpc', 9), a('grp', 'group', 4), a('zone', 'zone', 4)] }))
    expect([...c.querySelectorAll('text[data-kind="area"]')].map((n) => n.getAttribute('data-id'))).toEqual(['big', 'small', 'zone', 'grp', 'sub'])
    // inner areas are dashed, outer ones solid
    const dash = (id: string) => c.querySelector(`polygon[data-id="${id}"]`)!.parentElement!.querySelector('polygon')!.getAttribute('stroke-dasharray')
    expect(dash('sub')).toBe('2 4')
    expect(dash('big')).toBeNull()
  })
  it('keeps labels readable from behind and along either axis', () => {
    const labels = [{ id: 'x', x: 0, y: 0, text: 'along x', size: 20, dir: 'x' as const, color: '#ff0000' }, { id: 'y', x: 0, y: 0, text: '', size: 20, dir: 'y' as const }]
    const front = render(<svg><Scene doc={docOf([], [], { labels })} proj={makeCam(45, 35)} theme={THEMES.light} /></svg>).container
    const back = render(<svg><Scene doc={docOf([], [], { labels })} proj={makeCam(225, 35)} theme={THEMES.light} /></svg>).container
    expect(front.querySelector('[data-id="x"]')!.getAttribute('text-anchor')).toBe('start')
    expect(back.querySelector('[data-id="x"]')!.getAttribute('text-anchor')).toBe('end')
    expect(front.querySelector('[data-id="y"]')!.getAttribute('text-anchor')).not.toBe(back.querySelector('[data-id="y"]')!.getAttribute('text-anchor'))
    expect(front.querySelector('[data-id="x"]')!.getAttribute('fill')).toBe('#ff0000')
    expect(front.querySelector('[data-id="y"]')!.getAttribute('fill')).toBe(THEMES.light.text)
  })
  it('draws ground light and contact shadows only for themes that ask for them', () => {
    expect(draw(docOf([node('a')])).querySelector('.nd-glow, .nd-ao')).toBeNull()
    const lit = render(<svg><Scene doc={docOf([node('a')])} proj={ISO} theme={{ ...THEMES.dark, glow: 0.3, ao: 0.4 }} /></svg>).container
    expect(lit.querySelector('.nd-glow')).not.toBeNull()
    expect(lit.querySelector('.nd-ao')).not.toBeNull()
  })
})

describe('brackets', () => {
  it('draws four corner marks and shortens them for small rectangles', () => {
    const d = brackets(FLAT, 0, 0, 10, 10, 1)
    expect(d.match(/M/g)).toHaveLength(4)
    expect(brackets(FLAT, 0, 0, 1, 1, 5)).not.toBe(brackets(FLAT, 0, 0, 1, 1, 0.1))
    expect(brackets(FLAT, 0, 0, 1, 1, 5)).toBe(brackets(FLAT, 0, 0, 1, 1, 0.4))
  })
})

describe('sceneBounds', () => {
  it('gives an empty blueprint a sensible default frame', () => {
    expect(sceneBounds(docOf(), ISO, 0)).toEqual({ x: -200, y: -120, w: 400, h: 240 })
    expect(sceneBounds(docOf(), ISO, 10)).toEqual({ x: -210, y: -130, w: 420, h: 260 })
  })
  it('grows to include components, areas and labels', () => {
    const one = sceneBounds(docOf([node('a')]), FLAT, 0)
    const withArea = sceneBounds(docOf([node('a')], [], { areas: [{ id: 'r', x: -20, y: -20, w: 50, d: 50, name: '', color: '#fff', kind: 'group' }] }), FLAT, 0)
    expect(withArea.w).toBeGreaterThan(one.w)
    expect(withArea.x).toBeLessThan(one.x)
    const lx = sceneBounds(docOf([], [], { labels: [{ id: 'l', x: 0, y: 0, text: 't', size: 20, dir: 'x' }] }), FLAT, 0)
    const ly = sceneBounds(docOf([], [], { labels: [{ id: 'l', x: 0, y: 0, text: 't', size: 20, dir: 'y' }] }), FLAT, 0)
    expect(lx.w).toBeGreaterThan(lx.h)
    expect(ly.h).toBeGreaterThan(ly.w)
  })
})

describe('models', () => {
  const kinds = [...new Set(CATALOG_LIST.map((d) => d.model))] as ModelKind[]
  it('has a catalog entry for every model kind', () => {
    expect(kinds.sort()).toEqual(['bucket', 'cluster', 'cylinder', 'disc', 'gate', 'globe', 'people', 'rack', 'slab', 'stack', 'tile', 'tower'])
  })
  it.each(kinds)('draws the %s model from the front and from behind without bad numbers', (kind) => {
    const type = CATALOG_LIST.find((d) => d.model === kind)!.type
    for (const proj of [ISO, makeCam(225, 30), makeCam(135, 60), makeCam(315, 20), FLAT]) {
      const c = render(<svg><Model type={type} proj={proj} /></svg>).container
      expect(c.querySelector('svg')!.children.length).toBeGreaterThan(0)
      expect(c.innerHTML).not.toMatch(/NaN|undefined|Infinity/)
    }
  })
  it('draws every glyph in the catalog', () => {
    for (const d of CATALOG_LIST) {
      const c = render(<svg><Model type={d.type} proj={ISO} /></svg>).container
      expect(c.innerHTML, d.type).not.toMatch(/NaN|undefined/)
      expect(GLYPHS[d.glyph], d.type).toMatch(/^M/)
    }
  })
  it('falls back to the generic block for an unknown type', () => {
    const a = render(<svg><Model type="no-such-thing" proj={ISO} /></svg>).container.innerHTML
    const b = render(<svg><Model type="block" proj={ISO} /></svg>).container.innerHTML
    expect(a).toBe(b)
  })
  it('gives the same picture for the same camera and a different one when recoloured or turned', () => {
    const html = (el: React.ReactElement) => render(<svg>{el}</svg>).container.innerHTML
    const first = html(<Model type="ec2" proj={ISO} />)
    expect(html(<Model type="ec2" proj={ISO} />)).toBe(first)
    expect(html(<Model type="ec2" proj={ISO} color="#ff0000" />)).not.toBe(first)
    expect(html(<Model type="ec2" proj={makeCam(100, 40)} />)).not.toBe(first)
  })
  it('renders a sized thumbnail', () => {
    const c = render(<ModelIcon type="rds" proj={ISO} size={44} color="#00ff00" />).container
    const svg = c.querySelector('svg')!
    expect(svg.getAttribute('width')).toBe('44')
    expect(svg.getAttribute('viewBox')!.split(' ').map(Number).every(Number.isFinite)).toBe(true)
    expect(render(<ModelIcon type="rds" proj={ISO} />).container.querySelector('svg')!.getAttribute('width')).toBe('56')
  })
  it('defines the shared gradients once', () => {
    const c = render(<svg><SceneDefs /></svg>).container
    expect(c.querySelector('#st-ao')).not.toBeNull()
  })
})

describe('glyphs', () => {
  it('are non-empty path data', () => {
    expect(Object.keys(GLYPHS).length).toBeGreaterThan(30)
    for (const [k, d] of Object.entries(GLYPHS)) expect(d, k).toMatch(/^M[\d\s.A-Za-z-]+$/)
  })
})
