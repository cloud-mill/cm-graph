// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { CATALOG_LIST } from '../core/catalog'
import { getPref } from '../core/storage'
import { useStore } from '../core/store'
import { docOf, node, resetStore } from '../test/helpers'
import { Palette } from './Palette'

const S = () => useStore.getState()
const items = () => [...document.querySelectorAll('.pal-item')] as HTMLElement[]
const count = (p: string) => CATALOG_LIST.filter((d) => d.provider === p || d.provider === 'any').length

beforeEach(() => { resetStore({ provider: 'aws' }) })

describe('Palette', () => {
  it('lists the current cloud plus the cloud-neutral components', () => {
    render(<Palette />)
    expect(items()).toHaveLength(count('aws'))
    expect(screen.getByText(`${count('aws')} / ${CATALOG_LIST.length}`)).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'AWS' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTitle('Virtual machine: EC2')).toHaveTextContent('EC2Virtual machine')
    expect(screen.getByTitle('Users: Clients')).toHaveTextContent('UsersClients')
  })
  it('switches cloud and remembers the choice', async () => {
    render(<Palette />)
    await userEvent.click(screen.getByRole('radio', { name: 'Azure' }))
    expect(S().provider).toBe('azure')
    expect(getPref('provider', 'aws')).toBe('azure')
    expect(items()).toHaveLength(count('azure'))
    expect(screen.queryByTitle('Virtual machine: EC2')).toBeNull()
    expect(screen.getByRole('radio', { name: 'Azure' })).toHaveAttribute('aria-checked', 'true')
  })
  it('searches every cloud, the current one first, and tags the results', async () => {
    render(<Palette />)
    await userEvent.type(screen.getByPlaceholderText('Search components'), 'virtual machine')
    const names = items().map((i) => i.querySelector('.pal-name')!.textContent)
    expect(names).toHaveLength(3)
    expect(names[0]).toBe('EC2')
    expect(items()[0].querySelector('.pal-aws')!.textContent).toBe('AWS · Virtual machine')
    expect(items().map((i) => i.querySelector('.pal-aws')!.textContent!.split(' · ')[0]).sort()).toEqual(['AWS', 'Azure', 'GCP'])
  })
  it('finds components by keyword, and says when nothing matches', async () => {
    render(<Palette />)
    const q = screen.getByPlaceholderText('Search components')
    await userEvent.type(q, 'KUBERNETES')
    expect(items().length).toBeGreaterThanOrEqual(3)
    await userEvent.clear(q)
    await userEvent.type(q, 'zzzz')
    expect(items()).toHaveLength(0)
    expect(screen.getByText('Nothing matches “zzzz”.')).toBeInTheDocument()
  })
  it('clears the search and leaves the field on Escape', async () => {
    render(<Palette />)
    const q = screen.getByPlaceholderText('Search components') as HTMLInputElement
    await userEvent.type(q, 'queue{Escape}')
    expect(q.value).toBe('')
    expect(q).not.toHaveFocus()
    expect(items()).toHaveLength(count('aws'))
  })
  it('filters by category, and search overrides the filter', async () => {
    render(<Palette />)
    await userEvent.click(screen.getByRole('combobox', { name: 'Category' }))
    await userEvent.click(screen.getByRole('option', { name: 'Database' }))
    const dbs = CATALOG_LIST.filter((d) => d.provider === 'aws' && d.category === 'database').length
    expect(items()).toHaveLength(dbs)
    expect(document.querySelectorAll('.palette-scroll section')).toHaveLength(1)
    expect(document.querySelector('.palette-scroll h4')).toHaveTextContent('Database' + String(dbs).padStart(2, '0'))
    await userEvent.type(screen.getByPlaceholderText('Search components'), 'ec2')
    expect(screen.getByTitle('Virtual machine: EC2')).toBeInTheDocument()
  })
  it('jumps to the search field with "/", unless something is being typed', async () => {
    render(<><Palette /><input aria-label="other" /></>)
    const q = screen.getByPlaceholderText('Search components')
    const other = screen.getByLabelText('other') as HTMLInputElement
    other.focus()
    await userEvent.keyboard('/')
    expect(other).toHaveFocus()
    expect(other.value).toBe('/')
    other.blur()
    expect(fireEvent.keyDown(window, { key: '/' })).toBe(false) // handled, so the "/" is not typed
    expect(q).toHaveFocus()
    fireEvent.keyDown(window, { key: 'x' })
  })
  it('starts placing on press with the primary button only', () => {
    resetStore({ provider: 'aws', tool: 'area' })
    render(<Palette />)
    const vm = screen.getByTitle('Virtual machine: EC2')
    fireEvent.pointerDown(vm, { button: 2 })
    expect(S().placing).toBeNull()
    fireEvent.pointerDown(vm, { button: 0 })
    expect(S()).toMatchObject({ placing: 'ec2', tool: 'select' })
    expect(vm).toHaveClass('on')
  })
  it('drops a component in view on double-click, beside what is already there', () => {
    resetStore({ provider: 'aws', doc: docOf([node('x', 'ec2', -1, -1)]) })
    render(<Palette />)
    const db = screen.getByTitle('Relational database: RDS / Aurora')
    fireEvent.pointerDown(db, { button: 0 })
    fireEvent.doubleClick(db)
    expect(S().placing).toBeNull()
    fireEvent.doubleClick(db)
    const [, a, b] = S().doc.nodes
    expect(a).toMatchObject({ type: 'rds', name: 'rds-1' })
    expect(b).toMatchObject({ type: 'rds', name: 'rds-2' })
    for (const p of S().doc.nodes) for (const q of S().doc.nodes) if (p !== q) expect(Math.abs(p.x - q.x) >= 2 || Math.abs(p.y - q.y) >= 2).toBe(true)
    expect(S().selection).toEqual([b.id])
  })
})
