// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CATALOG, costOf, docCost, money, providerOf } from '../core/catalog'
import { useStore } from '../core/store'
import { TEMPLATES } from '../core/templates'
import { docOf, edge, node, resetStore } from '../test/helpers'
import { SWATCHES } from './atoms'
import { Inspector } from './Inspector'

// these render whole screens; leave headroom for a busy machine
vi.setConfig({ testTimeout: 20_000 })

const S = () => useStore.getState()
const show = (doc = docOf(), selection: string[] = []) => { resetStore({ doc, selection }); return render(<Inspector />) }
const pick = async (label: string, option: string) => {
  await userEvent.click(screen.getByRole('combobox', { name: label }))
  await userEvent.click(screen.getByRole('option', { name: option }))
}

beforeEach(() => resetStore())

describe('blueprint settings (nothing selected)', () => {
  it('renames the blueprint as one undo step', async () => {
    show(docOf([], [], { name: 'Old' }))
    const name = screen.getByDisplayValue('Old')
    await userEvent.clear(name)
    await userEvent.type(name, 'New name')
    expect(S().doc.name).toBe('New name')
    expect(S().past).toHaveLength(1)
    act(() => S().undo())
    expect(S().doc.name).toBe('Old')
  })
  it('keeps a later rename undoable after an undo', async () => {
    show(docOf([], [], { name: 'Old' }))
    const name = screen.getByDisplayValue('Old')
    await userEvent.type(name, '1')
    act(() => S().undo())
    await userEvent.type(name, '2')
    expect(S().past).toHaveLength(1)
    act(() => S().undo())
    expect(S().doc.name).toBe('Old')
  })
  it('shows counts, the total and changes region', async () => {
    const doc = TEMPLATES[0].make()
    show(doc)
    const grid = document.querySelector('.stat-grid')!
    expect(grid).toHaveTextContent(`${doc.nodes.length}Components`)
    expect(grid).toHaveTextContent(`${doc.edges.length}Connections`)
    expect(grid).toHaveTextContent(`${doc.areas.length}Areas`)
    expect(grid).toHaveTextContent(money(docCost(doc).total, true))
    expect(screen.getByText('AWS blueprint')).toBeInTheDocument()
    await pick('Region', 'Asia Pacific (Tokyo)')
    expect(S().doc.region).toBe('ap-northeast-1')
    expect(grid).toHaveTextContent(money(docCost(S().doc).total, true))
    expect(docCost(S().doc).total).toBeGreaterThan(docCost(doc).total)
  })
  it('has no cloud comparison for an empty blueprint', () => {
    show()
    expect(screen.getByText('Blueprint settings')).toBeInTheDocument()
    expect(document.querySelector('.clouds')).toBeNull()
    expect(screen.getByText('Working on the canvas')).toBeInTheDocument()
  })
  it('prices the architecture on each cloud and moves it in one undo step', async () => {
    const doc = TEMPLATES[0].make()
    show(doc)
    const rows = [...document.querySelectorAll('.cloud-row')] as HTMLElement[]
    expect(rows).toHaveLength(3)
    expect(rows[0]).toHaveClass('on')
    expect(rows[0]).toHaveTextContent('Current')
    expect(rows[1]).toHaveTextContent('none yet')
    expect(document.querySelectorAll('.cloud-cost.best')).toHaveLength(1)
    await userEvent.click(within(rows[1]).getByRole('button', { name: 'Move' }))
    expect(S().doc.nodes.every((n) => ['gcp', 'any'].includes(providerOf(n.type)))).toBe(true)
    expect(S().provider).toBe('gcp')
    expect(S().past).toHaveLength(1)
    expect(S().toasts.at(-1)!.text).toMatch(/^Moved \d+ components to GCP$/)
    expect(screen.getByText('GCP blueprint')).toBeInTheDocument()
    expect(document.querySelectorAll('.cloud-row')[1]).toHaveClass('on')
    act(() => S().undo())
    expect(S().doc.nodes.map((n) => n.type)).toEqual(doc.nodes.map((n) => n.type))
  })
  it('names every cloud in a mixed blueprint, most used first', () => {
    show(docOf([node('a', 'ec2'), node('b', 'ec2', 4), node('c', 'gcp-sql', 8), node('u', 'users', 12)]))
    expect(screen.getByText('AWS + GCP blueprint')).toBeInTheDocument()
    expect(document.querySelectorAll('.cloud-row')[0]).toHaveTextContent('2 components')
    expect(document.querySelectorAll('.cloud-row')[1]).toHaveTextContent('1 component')
    expect(document.querySelectorAll('.cloud-row.on')).toHaveLength(0)
  })
})

describe('one component', () => {
  const doc = () => docOf(
    [node('a', 'ec2', 0, 0, { name: 'web' }), node('b', 'rds', 8, 0, { name: 'db' }), node('u', 'users', -6, 0)],
    [edge('e1', 'a', 'b'), edge('e2', 'u', 'a', { label: 'HTTPS' }), edge('e3', 'b', 'u', { arrow: 'both' })],
  )
  it('shows what it is and renames it as one undo step', async () => {
    show(doc(), ['a'])
    expect(screen.getByText('Virtual machine · EC2')).toBeInTheDocument()
    const name = screen.getByDisplayValue('web')
    await userEvent.type(name, '-01')
    expect(S().doc.nodes[0].name).toBe('web-01')
    expect(S().past).toHaveLength(1)
    await userEvent.clear(name)
    expect(S().doc.nodes[0].name).toBeUndefined() // falls back to the default name
    expect(name).toHaveAttribute('placeholder', 'Virtual machine')
  })
  it('edits select, number and toggle settings and reprices', async () => {
    show(doc(), ['a'])
    await pick('Family', 'c5')
    expect(S().doc.nodes[0].props.family).toBe('c5')
    const count = within(screen.getByText('Instances').closest('.row') as HTMLElement).getByRole('textbox')
    await userEvent.clear(count)
    await userEvent.type(count, '4')
    expect(S().doc.nodes[0].props.count).toBe(4)
    const card = document.querySelector('.cost-card')!
    expect(card).toHaveTextContent('4 × c5.large')
    expect(card).toHaveTextContent(money(costOf(S().doc.nodes[0], 'us-east-1').monthly))
    act(() => S().select(['b']))
    const before = costOf(S().doc.nodes[1], 'us-east-1').monthly
    await userEvent.click(screen.getByRole('switch', { name: 'Multi-AZ standby' }))
    expect(S().doc.nodes[1].props.multiAZ).toBe(true)
    expect(costOf(S().doc.nodes[1], 'us-east-1').monthly).toBeGreaterThan(before)
    expect(screen.getByRole('switch', { name: 'Multi-AZ standby' })).toHaveAttribute('aria-checked', 'true')
  })
  it('respects the limits of a numeric setting', async () => {
    show(doc(), ['a'])
    const count = within(screen.getByText('Instances').closest('.row') as HTMLElement).getByRole('textbox')
    await userEvent.clear(count)
    await userEvent.type(count, '9999')
    expect(S().doc.nodes[0].props.count).toBe(500)
    await userEvent.clear(count)
    await userEvent.type(count, '0')
    expect(S().doc.nodes[0].props.count).toBe(1)
  })
  it('hides settings whose condition is not met', () => {
    const block = CATALOG.block
    const saved = block.props
    block.props = [...saved, { key: 'extra', label: 'Only when paid', type: 'number', default: 1, showIf: (p) => p.fee > 0 }]
    try {
      show(docOf([node('k', 'block', 0, 0, { props: { fee: 0, extra: 1 } })]), ['k'])
      expect(screen.queryByText('Only when paid')).toBeNull()
      act(() => S().patchProps(['k'], { fee: 5 }))
      expect(screen.getByText('Only when paid')).toBeInTheDocument()
    } finally { block.props = saved }
  })
  it('says so when a component costs nothing and has no settings', () => {
    show(doc(), ['u'])
    expect(screen.getByText('No direct charge for this component.')).toBeInTheDocument()
    expect(screen.queryByText('Configuration')).toBeNull()
    expect(document.querySelector('.cost-total')).toHaveTextContent('Monthly$0.00/mo')
  })
  it('resizes about the centre and returns to the default cleanly', async () => {
    show(doc(), ['a'])
    expect(screen.getByRole('combobox', { name: 'Scale' })).toHaveTextContent('100%')
    await pick('Scale', '200%')
    expect(S().doc.nodes[0]).toMatchObject({ x: -1, y: -1, scale: 2 })
    await pick('Scale', '50%')
    expect(S().doc.nodes[0]).toMatchObject({ x: 0.5, y: 0.5, scale: 0.5 })
    await pick('Scale', '100%')
    expect(S().doc.nodes[0]).toMatchObject({ x: 0, y: 0 })
    expect('scale' in S().doc.nodes[0]).toBe(false)
    expect(S().past).toHaveLength(3)
  })
  it('lists a size set by dragging even when it is not a preset', async () => {
    show(docOf([node('a', 'ec2', 0, 0, { scale: 1.75 })]), ['a'])
    expect(screen.getByRole('combobox', { name: 'Scale' })).toHaveTextContent('175%')
    await userEvent.click(screen.getByRole('combobox', { name: 'Scale' }))
    expect(screen.getAllByRole('option')).toHaveLength(9)
  })
  it('recolours and resets the colour', async () => {
    show(doc(), ['a'])
    expect(screen.getByRole('button', { name: 'Default colour' })).toHaveClass('on')
    await userEvent.click(screen.getByRole('button', { name: SWATCHES[3] }))
    expect(S().doc.nodes[0].color).toBe(SWATCHES[3])
    expect(screen.getByRole('button', { name: SWATCHES[3] })).toHaveClass('on')
    await userEvent.click(screen.getByRole('button', { name: 'Default colour' }))
    expect(S().doc.nodes[0].color).toBeUndefined()
  })
  it('keeps notes and only links to http(s) addresses', async () => {
    show(doc(), ['a'])
    await userEvent.type(screen.getByPlaceholderText(/Runbook notes/), 'owner: ops')
    expect(S().doc.nodes[0].notes).toBe('owner: ops')
    const link = screen.getByPlaceholderText('https://link-to-docs-or-console')
    await userEvent.type(link, 'javascript:alert(1)')
    expect(S().doc.nodes[0].link).toBe('javascript:alert(1)')
    expect(screen.queryByRole('link', { name: 'Open link' })).toBeNull()
    await userEvent.clear(link)
    expect(S().doc.nodes[0].link).toBeUndefined()
    await userEvent.type(link, 'https://example.com/runbook')
    const a = screen.getByRole('link', { name: 'Open link' })
    expect(a).toHaveAttribute('href', 'https://example.com/runbook')
    expect(a).toHaveAttribute('target', '_blank')
    expect(a.getAttribute('rel')).toContain('noopener')
  })
  it('lists connections with their direction and selects one on click', async () => {
    show(doc(), ['a'])
    const conns = [...document.querySelectorAll('.conn')] as HTMLElement[]
    expect(conns.map((c) => c.textContent)).toEqual(['→dbRDS / Aurora', '←UsersHTTPS'])
    await userEvent.click(conns[1])
    expect(S().selection).toEqual(['e2'])
    expect(screen.getByText('Connection')).toBeInTheDocument()
    act(() => S().select(['b']))
    expect(document.querySelectorAll('.conn')[1]).toHaveTextContent('↔')
    act(() => S().remove(['e1', 'e2']))
    act(() => S().select(['a']))
    expect(document.querySelector('.conn-list')).toBeNull()
  })
  it('focuses, duplicates and deletes', async () => {
    show(doc(), ['a'])
    await userEvent.click(screen.getByRole('button', { name: 'Focus' }))
    await userEvent.click(screen.getByRole('button', { name: 'Duplicate' }))
    expect(S().doc.nodes).toHaveLength(4)
    expect(S().selection).toEqual([S().doc.nodes[3].id])
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(S().doc.nodes).toHaveLength(3)
    expect(S().selection).toEqual([])
    expect(screen.getByText(/blueprint$/)).toBeInTheDocument() // back to the blueprint view
  })
})

describe('several components', () => {
  it('edits all of one type together', async () => {
    show(docOf([node('a', 'ec2', 0, 0), node('b', 'ec2', 4, 0)]), ['a', 'b'])
    expect(screen.getByText('2 components')).toBeInTheDocument()
    expect(screen.getByText('Virtual machine · EC2')).toBeInTheDocument()
    await pick('Size', 'xlarge')
    expect(S().doc.nodes.map((n) => n.props.size)).toEqual(['xlarge', 'xlarge'])
    expect(S().past).toHaveLength(1)
    const total = S().doc.nodes.reduce((t, n) => t + costOf(n, 'us-east-1').monthly, 0)
    expect(document.querySelector('.cost-total')).toHaveTextContent('Selection total' + money(total))
    expect(document.querySelectorAll('.cost-line')).toHaveLength(0)
    await userEvent.click(screen.getByRole('button', { name: SWATCHES[0] }))
    expect(S().doc.nodes.map((n) => n.color)).toEqual([SWATCHES[0], SWATCHES[0]])
    expect(screen.queryByPlaceholderText(/Runbook notes/)).toBeNull()
  })
  it('shows mixed sizes as Mixed and can set them all', async () => {
    show(docOf([node('a', 'ec2', 0, 0), node('b', 'ec2', 4, 0, { scale: 2, color: '#111111' })]), ['a', 'b'])
    expect(screen.getByRole('combobox', { name: 'Scale' })).toHaveTextContent('Mixed')
    expect(document.querySelector('.swatch.on')).toBeNull()
    await userEvent.click(screen.getByRole('combobox', { name: 'Scale' }))
    await userEvent.click(screen.getByRole('option', { name: 'Mixed' }))
    expect(S().past).toHaveLength(0)
    await pick('Scale', '150%')
    expect(S().doc.nodes.map((n) => n.scale)).toEqual([1.5, 1.5])
    expect(screen.getByRole('combobox', { name: 'Scale' })).toHaveTextContent('150%')
  })
  it('hides settings for different types', () => {
    show(docOf([node('a', 'ec2'), node('b', 'rds', 4)]), ['a', 'b'])
    expect(screen.getByText('Mixed selection')).toBeInTheDocument()
    expect(screen.queryByText('Configuration')).toBeNull()
    expect(screen.getByText('Selection total')).toBeInTheDocument()
  })
})

describe('connection', () => {
  const doc = () => docOf([node('a', 'ec2', 0, 0, { name: 'web' }), node('b', 'rds', 8, 0, { name: 'db' })], [edge('e1', 'a', 'b'), edge('e2', 'b', 'a')])
  it('edits label, line, arrows, weight and colour', async () => {
    show(doc(), ['e1'])
    expect(screen.getByText('web connects to db')).toBeInTheDocument()
    await userEvent.type(screen.getByLabelText('Connection label'), 'SQL')
    expect(S().doc.edges[0].label).toBe('SQL')
    await userEvent.clear(screen.getByLabelText('Connection label'))
    expect(S().doc.edges[0].label).toBeUndefined()
    await userEvent.click(screen.getByRole('radio', { name: 'Dashed' }))
    await userEvent.click(screen.getByRole('radio', { name: 'Both' }))
    await userEvent.click(screen.getByRole('radio', { name: 'Bold' }))
    await userEvent.click(screen.getByRole('button', { name: SWATCHES[5] }))
    expect(S().doc.edges[0]).toMatchObject({ style: 'dashed', arrow: 'both', width: 3.5, color: SWATCHES[5] })
    expect(screen.getByRole('radio', { name: 'Bold' })).toHaveAttribute('aria-checked', 'true')
    await userEvent.click(screen.getByRole('radio', { name: 'Dotted' }))
    await userEvent.click(screen.getByRole('radio', { name: 'None' }))
    await userEvent.click(screen.getByRole('radio', { name: 'Thin' }))
    await userEvent.click(screen.getByRole('button', { name: 'Default colour' }))
    expect(S().doc.edges[0]).toMatchObject({ style: 'dotted', arrow: 'none', width: 1.5 })
    expect(S().doc.edges[0].color).toBeUndefined()
    expect(S().doc.edges[1]).toMatchObject({ style: 'solid', arrow: 'end', width: 2 })
  })
  it('reverses and deletes', async () => {
    show(doc(), ['e1'])
    await userEvent.click(screen.getByRole('button', { name: 'Reverse' }))
    expect(S().doc.edges[0]).toMatchObject({ from: 'b', to: 'a' })
    expect(screen.getByText('db connects to web')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(S().doc.edges.map((e) => e.id)).toEqual(['e2'])
  })
  it('styles several at once and offers no label field', async () => {
    show(doc(), ['e1', 'e2'])
    expect(screen.getByText('2 connections')).toBeInTheDocument()
    expect(screen.queryByLabelText('Connection label')).toBeNull()
    await userEvent.click(screen.getByRole('radio', { name: 'Dashed' }))
    expect(S().doc.edges.map((e) => e.style)).toEqual(['dashed', 'dashed'])
    await userEvent.click(screen.getByRole('button', { name: 'Reverse' }))
    expect(S().doc.edges.map((e) => e.from)).toEqual(['b', 'a'])
  })
})

describe('area', () => {
  const doc = () => docOf([node('a', 'ec2', 2, 2), node('z', 'ec2', 40, 40)], [], { areas: [{ id: 'r', x: 0, y: 0, w: 20, d: 12, name: 'Prod', color: SWATCHES[5], kind: 'vpc' }] })
  it('renames, changes kind and colour', async () => {
    show(doc(), ['r'])
    expect(screen.getByText('Area · 20 × 12 cells')).toBeInTheDocument()
    await userEvent.type(screen.getByDisplayValue('Prod'), ' VPC')
    await userEvent.click(screen.getByRole('radio', { name: 'Zone' }))
    await userEvent.click(screen.getByRole('button', { name: SWATCHES[1] }))
    expect(S().doc.areas[0]).toMatchObject({ name: 'Prod VPC', kind: 'zone', color: SWATCHES[1] })
    expect(screen.queryByRole('button', { name: 'Default colour' })).toBeNull() // an area always has a colour
  })
  it('fits to its contents, duplicates and deletes', async () => {
    show(doc(), ['r'])
    await userEvent.click(screen.getByRole('button', { name: 'Fit contents' }))
    expect(S().doc.areas[0]).toMatchObject({ x: 1, y: 0.5, w: 4, d: 4.5 })
    await userEvent.click(screen.getByRole('button', { name: 'Duplicate' }))
    expect(S().doc.areas).toHaveLength(2)
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(S().doc.areas).toHaveLength(1)
    expect(S().doc.nodes).toHaveLength(2) // contents stay
  })
  it('leaves an empty area alone when asked to fit', async () => {
    show(docOf([], [], { areas: [{ id: 'r', x: 0, y: 0, w: 5, d: 5, name: 'E', color: SWATCHES[5], kind: 'group' }] }), ['r'])
    await userEvent.click(screen.getByRole('button', { name: 'Fit contents' }))
    expect(S().doc.areas[0]).toMatchObject({ x: 0, y: 0, w: 5, d: 5 })
    expect(S().past).toHaveLength(0)
  })
})

describe('text label', () => {
  const doc = () => docOf([], [], { labels: [{ id: 'l', x: 0, y: 0, text: 'Title', size: 20, dir: 'x' }] })
  it('edits text, size within limits, direction and colour', async () => {
    show(doc(), ['l'])
    expect(screen.getByText('Text label')).toBeInTheDocument()
    await userEvent.type(screen.getByDisplayValue('Title'), '{Enter}two')
    expect(S().doc.labels[0].text).toBe('Title\ntwo')
    const size = within(screen.getByText('Size').closest('.row') as HTMLElement).getByRole('textbox')
    await userEvent.clear(size)
    await userEvent.type(size, '500')
    expect(S().doc.labels[0].size).toBe(96)
    fireEvent.keyDown(size, { key: 'ArrowDown' })
    expect(S().doc.labels[0].size).toBe(94)
    await userEvent.click(screen.getByRole('radio', { name: /Along Y/ }))
    await userEvent.click(screen.getByRole('button', { name: SWATCHES[7] }))
    expect(S().doc.labels[0]).toMatchObject({ dir: 'y', color: SWATCHES[7] })
  })
  it('duplicates and deletes, with nothing to focus on', async () => {
    show(doc(), ['l'])
    expect(screen.queryByRole('button', { name: 'Focus' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Duplicate' }))
    expect(S().doc.labels).toHaveLength(2)
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(S().doc.labels).toHaveLength(1)
  })
})

describe('mixed selection', () => {
  const doc = () => docOf([node('a'), node('b', 'ec2', 4)], [edge('e', 'a', 'b')], {
    areas: [{ id: 'r', x: 0, y: 0, w: 5, d: 5, name: 'E', color: SWATCHES[5], kind: 'group' }],
    labels: [{ id: 'l', x: 0, y: 0, text: 'T', size: 20, dir: 'x' }],
  })
  it('summarises what is selected with correct plurals', () => {
    show(doc(), ['a', 'b', 'r', 'l', 'e'])
    expect(screen.getByText('5 items selected')).toBeInTheDocument()
    expect(screen.getByText('2 components · 1 area · 1 label · 1 connection')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Focus' })).toBeInTheDocument()
  })
  it('offers no focus without components, and deletes the lot', async () => {
    show(doc(), ['r', 'l'])
    expect(screen.getByText('1 area · 1 label')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Focus' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(S().doc.areas).toHaveLength(0)
    expect(S().doc.labels).toHaveLength(0)
    expect(S().doc.nodes).toHaveLength(2)
  })
  it('ignores ids that no longer exist', () => {
    show(doc(), ['gone'])
    expect(screen.getByText('AWS blueprint')).toBeInTheDocument()
  })
})

describe('connection: what it is and how it runs', () => {
  const doc = (extra: object = {}, more: ReturnType<typeof edge>[] = []) => docOf(
    [node('a', 'ec2', 0, 0, { name: 'web' }), node('b', 'rds', 8, 0, { name: 'db' }), node('u', 'users', -6, 0, { name: 'Clients' })],
    [edge('e', 'a', 'b', extra), ...more],
  )
  const E = () => S().doc.edges[0]

  it('says what it joins in a sentence, and each end leads to its component', async () => {
    show(doc({ kind: 'data', protocol: 'PostgreSQL', port: '5432' }), ['e'])
    expect(screen.getByText('web reads and writes db over PostgreSQL 5432')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /From\s*web/ }))
    expect(S().selection).toEqual(['a'])
  })
  it('choosing the relationship restyles the line and explains itself', async () => {
    show(doc(), ['e'])
    expect(screen.getByRole('combobox', { name: 'Relationship' })).toHaveTextContent('Not said')
    await pick('Relationship', 'Event')
    expect(E()).toMatchObject({ kind: 'event', style: 'dashed', arrow: 'end' })
    expect(screen.getByText(/without waiting/)).toBeInTheDocument()
    await pick('Relationship', 'Dependency')
    expect(screen.getByText(/no traffic implied/)).toBeInTheDocument()
  })
  it('takes a protocol and a port, shown along the line, and clears them again', async () => {
    show(doc(), ['e'])
    await userEvent.type(screen.getByLabelText('Protocol'), 'HTTPS')
    await userEvent.type(screen.getByLabelText('Port'), '443')
    expect(E()).toMatchObject({ protocol: 'HTTPS', port: '443' })
    await userEvent.clear(screen.getByLabelText('Port'))
    expect(E().port).toBeUndefined()
    expect(document.querySelectorAll('#link-protocols option').length).toBeGreaterThan(8)
  })
  it('says where the connection came from, and that none of it is measured', () => {
    const first = show(doc({ origin: 'inferred' }), ['e'])
    expect(screen.getByText('Inferred.')).toBeInTheDocument()
    expect(screen.getByText(/Guessed while importing/)).toBeInTheDocument()
    expect(screen.getByText(/none of this is measured traffic/)).toBeInTheDocument()
    first.unmount()
    show(doc(), ['e'])
    expect(screen.getByText('Drawn.')).toBeInTheDocument() // older files read as drawn by hand
  })
  it('flags a connection that looks wrong', async () => {
    resetStore({ doc: docOf([node('u', 'users', 0, 0, { name: 'Clients' }), node('b', 'rds', 8, 0, { name: 'db' })], [edge('e', 'u', 'b', { kind: 'data' })]), selection: ['e'] })
    render(<Inspector />)
    expect(screen.getByRole('status')).toHaveTextContent(/Clients reaches db directly/)
    await userEvent.type(screen.getByLabelText('Port'), 'abc')
    expect(screen.getAllByRole('status').some((el) => /not a number/.test(el.textContent!))).toBe(true)
  })
  it('describes the path and offers to bend it or hand it back to the router', async () => {
    show(doc(), ['e'])
    expect(screen.getByText(/Routed automatically around other components/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Route automatically' })).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: 'Add a bend' }))
    expect(E().via).toHaveLength(1)
    expect(screen.getByText(/Shaped by hand, through 1 point\./)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Add a bend' }))
    expect(screen.getByText(/through 2 points/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Route automatically' }))
    expect(E().via).toBeUndefined()
  })
  it('says so when only a side has been chosen', () => {
    show(doc({ fromSide: 's' }), ['e'])
    expect(screen.getByText(/from the side you chose/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Route automatically' })).toBeEnabled()
  })
  it('reversing keeps the shape, and a second connection can be added between the same two', async () => {
    show(doc({ via: [[3, 5], [6, 5]] }), ['e'])
    await userEvent.click(screen.getByRole('button', { name: 'Reverse' }))
    expect(E()).toMatchObject({ from: 'b', to: 'a', via: [[6, 5], [3, 5]] })
    await userEvent.click(screen.getByRole('button', { name: 'Second connection' }))
    expect(S().doc.edges).toHaveLength(2)
    expect(S().selection).toEqual([S().doc.edges[1].id])
  })
  it('follows the flow from the connection, and stops', async () => {
    show(doc(), ['e'])
    await userEvent.click(screen.getByRole('button', { name: 'Follow the flow' }))
    expect(S().trace).toBe('e')
    await userEvent.click(screen.getByRole('button', { name: 'Stop following' }))
    expect(S().trace).toBeNull()
  })
  it('with several selected: counts the shaped ones and resets them together', async () => {
    show(doc({ via: [[4, 4]] }, [edge('f', 'u', 'a')]), ['e', 'f'])
    expect(screen.getByText(/1 of these has been shaped by hand/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add a bend' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Route automatically' }))
    expect(screen.getByText('All routed automatically.')).toBeInTheDocument()
    await pick('Relationship', 'Request')
    expect(S().doc.edges.map((x) => x.kind)).toEqual(['request', 'request'])
  })
})

describe('component: its connections', () => {
  const doc = () => docOf(
    [node('u', 'users', -6, 0, { name: 'Clients' }), node('a', 'ec2', 0, 0, { name: 'web' }), node('b', 'rds', 8, 0, { name: 'db' }), node('q', 'sqs', 8, 8, { name: 'jobs' })],
    [edge('e1', 'u', 'a', { kind: 'request', protocol: 'HTTPS' }), edge('e2', 'a', 'b', { kind: 'data' }), edge('e3', 'a', 'q', { arrow: 'none' })],
  )
  it('says how far it reaches each way and lists each connection with what it carries', () => {
    show(doc(), ['a'])
    // the arrowless line to jobs is an association, so jobs counts on both sides
    expect(screen.getByText(/2 upstream, 2 downstream/)).toBeInTheDocument()
    const rows = [...document.querySelectorAll('.conn')].map((r) => r.textContent)
    expect(rows).toEqual(['←ClientsHTTPS', '→dbData', '–jobsSQS'])
  })
  it('follows the flow from the component', async () => {
    show(doc(), ['a'])
    await userEvent.click(screen.getByRole('button', { name: 'Follow the flow' }))
    expect(S().trace).toBe('a')
    expect(screen.getByRole('button', { name: 'Stop following' })).toBeInTheDocument()
  })
  it('an end of the chain says there is nothing beyond it', () => {
    show(doc(), ['u'])
    expect(screen.getByText(/Nothing upstream, 3 downstream/)).toBeInTheDocument()
  })
})

describe('component: what its cost rests on', () => {
  const lines = () => [...document.querySelectorAll('.cost-line')]
  it('marks each line as fixed, usage-based or an estimate', () => {
    show(docOf([node('a', 'alb', 0, 0, { name: 'lb' })]), ['a'])
    expect(lines().map((l) => l.className)).toEqual(['cost-line fixed', 'cost-line usage'])
    expect(lines()[0].querySelector('.basis')).toHaveAttribute('title', expect.stringMatching(/provisioned all month/))
    expect(screen.getByText(/List price in US East \(N\. Virginia\), all month \(730 hours\)/)).toBeInTheDocument()
  })
  it('an estimate is shown as approximate, with what it stands in for', async () => {
    show(docOf([node('a', 'ec2', 0, 0, { name: 'web', props: { family: 'm5', size: 'nano', os: 'linux', count: 1, disk: 30 } })]), ['a'])
    expect(lines()[0]).toHaveClass('estimate')
    expect(lines()[0]).toHaveTextContent(/~\$/)
    expect(lines()[0]).toHaveTextContent(/AWS does not sell m5\.nano/)
  })
  it('changing a setting reprices at once, from the published price of the new choice', async () => {
    show(docOf([node('a', 'ec2', 0, 0, { name: 'web', props: { family: 'm5', size: 'large', os: 'linux', count: 1, disk: 0 } })]), ['a'])
    expect(document.querySelector('.cost-total')).toHaveTextContent(money(0.096 * 730))
    await pick('Size', 'xlarge')
    expect(document.querySelector('.cost-total')).toHaveTextContent(money(0.192 * 730))
    await pick('Platform', 'Windows')
    expect(document.querySelector('.cost-total')).toHaveTextContent(money(0.376 * 730))
  })
  it('says where free allowances are handled when a line counts towards one', () => {
    show(docOf([node('a', 'lambda', 0, 0, { name: 'fn' })]), ['a'])
    expect(screen.getByText(/Free monthly allowances are taken off once for the whole blueprint/)).toBeInTheDocument()
  })
  it('says when reserved rates are in play', () => {
    resetStore({ doc: docOf([node('a', 'ec2', 0, 0, { name: 'web' })]), selection: ['a'], pricing: 'commit1' })
    render(<Inspector />)
    expect(screen.getByText(/with reserved rates where they are published/)).toBeInTheDocument()
    expect(lines()[0]).toHaveTextContent(/Reserved for 1 year, no upfront payment/)
  })
})
