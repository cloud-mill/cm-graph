// @vitest-environment jsdom
import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { analyze } from '../core/advisor'
import { docCost, money } from '../core/catalog'
import { useStore } from '../core/store'
import { TEMPLATES } from '../core/templates'
import { docOf, edge, node, resetStore } from '../test/helpers'
import { AdvisorPanel } from './AdvisorPanel'
import { BudgetPanel } from './BudgetPanel'

const S = () => useStore.getState()
beforeEach(() => resetStore())

describe('AdvisorPanel', () => {
  it('has nothing to review on an empty blueprint', () => {
    render(<AdvisorPanel />)
    expect(screen.getByText('Nothing to review yet')).toBeInTheDocument()
    expect(screen.getByText('No findings')).toBeInTheDocument()
    expect(document.querySelector('.score b')).toHaveTextContent('100')
    expect(screen.getByText('In good shape')).toBeInTheDocument()
  })
  it('gives a clean bill to a blueprint with no issues', () => {
    resetStore({ doc: docOf([node('a', 'ec2', 0, 0, { props: { family: 'm7g', size: 'large', os: 'linux', count: 1, disk: 30 } })]) })
    render(<AdvisorPanel />)
    expect(screen.getByText('Nothing to flag')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /recommended fixes/ })).toBeNull()
  })
  it('lists findings, worst first, with counts per severity and savings', () => {
    const doc = TEMPLATES[0].make()
    resetStore({ doc })
    render(<AdvisorPanel />)
    const { findings, score } = analyze(doc)
    const cards = [...document.querySelectorAll('.finding')] as HTMLElement[]
    expect(cards).toHaveLength(findings.length)
    expect(cards.map((c) => c.querySelector('h6')!.textContent)).toEqual(findings.map((f) => f.title))
    expect(document.querySelector('.score b')).toHaveTextContent(String(score))
    expect(screen.getByText(`${findings.length} findings`, { exact: false })).toBeInTheDocument()
    for (const k of ['high', 'medium', 'low'] as const) expect(document.querySelector(`.sev-row .sev-${k}`)).toHaveTextContent(`${findings.filter((f) => f.severity === k).length} ${k}`)
    const saver = findings.find((f) => f.saving)!
    expect(cards[findings.indexOf(saver)]).toHaveTextContent('-' + money(saver.saving!, true) + '/mo')
    expect(document.querySelector('.advisor-hero .save')).toHaveTextContent('/mo recoverable')
  })
  it.each([[1, 86, 'In good shape'], [2, 67, 'Room to improve'], [4, 34, 'Needs attention']])('%i unconnected single-zone database(s) score %i: "%s"', (dbs, score, label) => {
    // each costs 14 points, plus 2.5 for being unconnected once there is more than one
    resetStore({ doc: docOf(Array.from({ length: dbs }, (_, i) => node('db' + i, 'rds', i * 4, 0))) })
    render(<AdvisorPanel />)
    expect(document.querySelector('.score b')).toHaveTextContent(String(score))
    expect(screen.getByText(label)).toBeInTheDocument()
    expect(document.querySelectorAll('.score circle')[1].getAttribute('stroke')).toBe(score >= 85 ? 'var(--pos)' : score >= 60 ? 'var(--warn)' : 'var(--danger)')
  })
  it('shows the components a finding is about', async () => {
    const doc = TEMPLATES[0].make()
    resetStore({ doc })
    render(<AdvisorPanel />)
    const f = analyze(doc).findings[0]
    await userEvent.click(within(document.querySelector('.finding') as HTMLElement).getByRole('button', { name: 'Show' }))
    expect(S().selection).toEqual(f.nodes)
  })
  it('sends a blueprint-wide finding to the budget instead', async () => {
    const doc = docOf(Array.from({ length: 6 }, (_, i) => node('n' + i, 'ec2', i * 4, 0, { props: { family: 'm7g', size: '4xlarge', os: 'linux', count: 4, disk: 30 } })), Array.from({ length: 5 }, (_, i) => edge('e' + i, 'n' + i, 'n' + (i + 1))))
    resetStore({ doc })
    render(<AdvisorPanel />)
    expect(analyze(doc).findings.map((f) => f.id)).toContain('commit')
    await userEvent.click(screen.getByRole('button', { name: 'Open budget' }))
    expect(S().panel).toBe('budget')
    expect(S().selection).toEqual([])
  })
  it('applies one fix as an undoable step and the finding goes away', async () => {
    const doc = TEMPLATES[0].make()
    resetStore({ doc })
    render(<AdvisorPanel />)
    const before = analyze(doc)
    await userEvent.click(screen.getByRole('button', { name: 'Enable Multi-AZ' }))
    expect(S().doc.nodes.find((n) => n.type === 'rds')!.props.multiAZ).toBe(true)
    expect(S().past).toHaveLength(1)
    expect(S().toasts.at(-1)!.text).toBe('Applied: Enable Multi-AZ')
    expect(screen.queryByRole('button', { name: 'Enable Multi-AZ' })).toBeNull()
    expect(Number(document.querySelector('.score b')!.textContent)).toBeGreaterThan(before.score)
  })
  it('applies every recommended fix in one undo step, but never deletes components', async () => {
    const doc = TEMPLATES[0].make()
    doc.nodes.push(node('idle', 'alb', 40, 40))
    resetStore({ doc })
    render(<AdvisorPanel />)
    const fixable = analyze(doc).findings.filter((f) => f.fix && !f.id.startsWith('idle-lb'))
    expect(fixable.length).toBeGreaterThan(1)
    await userEvent.click(screen.getByRole('button', { name: `Apply ${fixable.length} recommended fixes` }))
    expect(S().past).toHaveLength(1)
    expect(S().toasts.at(-1)!.text).toBe(`Applied ${fixable.length} fixes`)
    expect(S().doc.nodes.some((n) => n.id === 'idle')).toBe(true)
    expect(analyze(S().doc).findings.filter((f) => f.fix && !f.id.startsWith('idle-lb'))).toHaveLength(0)
    act(() => S().undo())
    expect(analyze(S().doc).findings).toHaveLength(analyze(doc).findings.length)
    // the idle load balancer can still be removed on request
    await userEvent.click(screen.getByRole('button', { name: 'Remove load balancer' }))
    expect(S().doc.nodes.some((n) => n.id === 'idle')).toBe(false)
  })
  it('uses the singular for one finding', () => {
    resetStore({ doc: docOf([node('db', 'rds', 0, 0, { props: { multiAZ: false, family: 'm7g', size: 'large', engine: 'postgres', replicas: 0, storage: 100 } })]) })
    render(<AdvisorPanel />)
    expect(screen.getByText('1 finding')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /recommended fixes/ })).toBeNull() // a single fix has its own button
  })
})

describe('BudgetPanel', () => {
  it('invites adding components when nothing is billable', () => {
    resetStore({ doc: docOf([node('u', 'users')]) })
    render(<BudgetPanel />)
    expect(screen.getByText('Add billable components to see a breakdown.')).toBeInTheDocument()
    expect(document.querySelector('.budget-center')).toHaveTextContent('$0.00')
    expect(document.querySelectorAll('.cost-row')).toHaveLength(0)
    expect(document.querySelectorAll('.donut circle')).toHaveLength(1)
  })
  it('breaks the bill down by category and by component, dearest first', () => {
    const doc = TEMPLATES[0].make()
    resetStore({ doc, selection: [doc.nodes.find((n) => n.type === 'rds')!.id] })
    render(<BudgetPanel />)
    const cost = docCost(doc)
    expect(document.querySelector('.budget-center')).toHaveTextContent(money(cost.total, true))
    expect(document.querySelector('.budget-sub')).toHaveTextContent(money(cost.total * 12, true) + ' per year')
    const pct = [...document.querySelectorAll('.budget-legend > div .mono')].map((e) => parseInt(e.textContent!))
    expect(pct).toEqual([...pct].sort((a, b) => b - a))
    expect(pct.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(98)
    expect(pct.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(102)
    const rows = [...document.querySelectorAll('.cost-row')] as HTMLElement[]
    const billable = doc.nodes.filter((n) => cost.perNode.get(n.id)!.monthly > 0)
    expect(rows).toHaveLength(billable.length)
    expect(screen.getByText('By component').querySelector('.count')).toHaveTextContent(String(billable.length))
    const top = [...billable].sort((a, b) => cost.perNode.get(b.id)!.monthly - cost.perNode.get(a.id)!.monthly)[0]
    expect(rows[0]).toHaveTextContent(top.name!)
    expect(rows[0].querySelector('.bar i')).toHaveStyle({ width: '100%' })
    expect(document.querySelectorAll('.cost-row.on')).toHaveLength(1)
    expect(document.querySelectorAll('.donut circle').length).toBe(pct.length + 1)
  })
  it('applies commitment pricing and shows what it saves', async () => {
    const doc = TEMPLATES[0].make()
    resetStore({ doc })
    render(<BudgetPanel />)
    expect(document.querySelector('.budget-sub .save')).toBeNull()
    await userEvent.click(screen.getByRole('radio', { name: '3-yr commit' }))
    expect(S().pricing).toBe('commit3')
    const od = docCost(doc).total, c3 = docCost(doc, 'commit3').total
    expect(document.querySelector('.budget-center')).toHaveTextContent(money(c3, true))
    expect(document.querySelector('.budget-sub .save')).toHaveTextContent(`saves ${money(od - c3, true)}/mo vs on-demand`)
    await userEvent.click(screen.getByRole('radio', { name: '1-yr commit' }))
    expect(S().pricing).toBe('commit1')
    await userEvent.click(screen.getByRole('radio', { name: 'On-demand' }))
    expect(document.querySelector('.budget-sub .save')).toBeNull()
  })
  it('reprices for another region as an undoable change', async () => {
    const doc = TEMPLATES[0].make()
    resetStore({ doc })
    render(<BudgetPanel />)
    await userEvent.click(screen.getByRole('combobox', { name: 'Region' }))
    await userEvent.click(screen.getByRole('option', { name: 'sa-east-1' }))
    expect(S().doc.region).toBe('sa-east-1')
    expect(S().past).toHaveLength(1)
    expect(document.querySelector('.budget-center')).toHaveTextContent(money(docCost(doc).total * 1.55, true))
  })
  it('toggles the cost heatmap', async () => {
    resetStore({ doc: TEMPLATES[0].make() })
    render(<BudgetPanel />)
    const sw = screen.getByRole('switch', { name: 'Cost heatmap' })
    await userEvent.click(sw)
    expect(S().lens).toBe('cost')
    expect(sw).toHaveAttribute('aria-checked', 'true')
    await userEvent.click(sw)
    expect(S().lens).toBe('none')
  })
  it('selects a component from its row', async () => {
    const doc = TEMPLATES[0].make()
    resetStore({ doc })
    render(<BudgetPanel />)
    const row = document.querySelector('.cost-row') as HTMLElement
    await userEvent.click(row)
    expect(S().selection).toHaveLength(1)
    expect(row).toHaveTextContent(doc.nodes.find((n) => n.id === S().selection[0])!.name!)
    expect(row).toHaveClass('on')
  })
  it('exports the breakdown as a CSV file', async () => {
    const doc = TEMPLATES[0].make()
    resetStore({ doc })
    let file = '', blob: Blob | undefined
    vi.spyOn(URL, 'createObjectURL').mockImplementation((b) => { blob = b as Blob; return 'blob:csv' })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { file = this.download })
    render(<BudgetPanel />)
    await userEvent.click(screen.getByRole('button', { name: 'Export CSV' }))
    expect(file).toBe('three-tier-web-application-budget.csv')
    expect(blob!.type).toBe('text/csv')
    const text = await blob!.text()
    expect(text.split('\n')[0]).toBe('Component,Service,Category,Line item,Monthly (USD),Yearly (USD)')
    expect(text).toContain('Total,,,us-east-1 · ondemand,' + docCost(doc).total.toFixed(2))
    expect(S().toasts.at(-1)!.text).toBe('Budget exported as CSV')
    expect(document.querySelector('a[download]')).toBeNull() // the temporary link is cleaned up
  })
})
