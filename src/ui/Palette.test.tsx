// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CATALOG_LIST } from '../core/catalog'
import { getPref } from '../core/storage'
import { useStore } from '../core/store'
import { docOf, node, resetStore } from '../test/helpers'
import { PHONE, stubMedia } from '../test/media'
import { CloudSeg, Palette } from './Palette'

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

  it('with a finger, a press never starts a drag: the list has to scroll', () => {
    resetStore({ provider: 'aws', tool: 'area' })
    render(<Palette />)
    const vm = screen.getByTitle('Virtual machine: EC2')
    fireEvent.pointerDown(vm, { button: 0, pointerType: 'touch' })
    expect(S()).toMatchObject({ placing: null, tool: 'area' })
    expect(vm).not.toHaveClass('on')
  })
  it('with a finger, a tap adds the component in view and selects it', () => {
    resetStore({ provider: 'aws', doc: docOf([node('x', 'ec2', -1, -1)]), showLib: true })
    render(<Palette />)
    const db = screen.getByTitle('Relational database: RDS / Aurora')
    fireEvent.pointerDown(db, { button: 0, pointerType: 'touch' })
    fireEvent.click(db)
    expect(S().doc.nodes).toHaveLength(2)
    const added = S().doc.nodes[1]
    expect(added).toMatchObject({ type: 'rds', name: 'rds-1' })
    expect(S().selection).toEqual([added.id])
    // not on top of what was already there
    expect(Math.abs(added.x + 1) >= 2 || Math.abs(added.y + 1) >= 2).toBe(true)
    // on a wide screen the library stays open for the next one
    expect(S().showLib).toBe(true)
  })
  it('on a phone, adding puts the library away so the new component can be seen', () => {
    stubMedia(PHONE)
    resetStore({ provider: 'aws', showLib: true, placing: 's3' })
    render(<Palette />)
    const fn = screen.getByTitle('Function: Lambda')
    fireEvent.pointerDown(fn, { button: 0, pointerType: 'touch' })
    fireEvent.click(fn)
    expect(S().doc.nodes.map((n) => n.type)).toEqual(['lambda'])
    expect(S()).toMatchObject({ showLib: false, placing: null })
    vi.unstubAllGlobals()
  })
  it('with a mouse, a single click still adds nothing: it is press-and-drag or double-click', () => {
    render(<Palette />)
    const vm = screen.getByTitle('Virtual machine: EC2')
    fireEvent.pointerDown(vm, { button: 0, pointerType: 'mouse' })
    fireEvent.click(vm)
    expect(S().doc.nodes).toHaveLength(0)
    expect(S().placing).toBe('ec2')
    // and a mouse after a finger goes back to mouse behaviour
    fireEvent.pointerDown(vm, { button: 0, pointerType: 'touch' })
    fireEvent.pointerDown(vm, { button: 0, pointerType: 'mouse' })
    fireEvent.click(vm)
    expect(S().doc.nodes).toHaveLength(0)
  })
})

describe('Palette on a phone', () => {
  beforeEach(() => { stubMedia(PHONE) })
  afterEach(() => { vi.unstubAllGlobals() })
  const chips = () => within(screen.getByRole('radiogroup', { name: 'Category' })).getAllByRole('radio')

  it('is a search field, a row of category chips and the list: the cloud switch lives in the sheet header', () => {
    render(<Palette />)
    expect(document.querySelector('.palette')).toHaveClass('touch')
    expect(screen.queryByRole('radiogroup', { name: 'Cloud provider' })).toBeNull()
    expect(screen.getByPlaceholderText(`Search ${CATALOG_LIST.length} components`)).toBeInTheDocument()
    expect(chips()[0]).toHaveTextContent('All')
    expect(chips()[0]).toHaveAttribute('aria-checked', 'true')
    expect(chips().length).toBeGreaterThan(5)
    // no drop-down to cover the list it filters
    expect(document.querySelector('.cat-select')).toBeNull()
    expect(items()).toHaveLength(count('aws'))
  })
  it('a chip narrows the list to its category, and All brings everything back', () => {
    render(<Palette />)
    fireEvent.click(screen.getByRole('radio', { name: 'Database' }))
    expect([...document.querySelectorAll('.palette h4')].map((h) => h.textContent!.replace(/\d+$/, ''))).toEqual(['Database'])
    expect(screen.getByRole('radio', { name: 'Database' })).toHaveAttribute('aria-checked', 'true')
    expect(items().length).toBeLessThan(count('aws'))
    fireEvent.click(screen.getByRole('radio', { name: 'All' }))
    expect(items()).toHaveLength(count('aws'))
  })
  it('searching looks everywhere, so the chips step back until the search is cleared', async () => {
    render(<Palette />)
    fireEvent.click(screen.getByRole('radio', { name: 'Database' }))
    await userEvent.type(screen.getByLabelText('Search components'), 'queue')
    expect(items().map((i) => i.querySelector('.pal-name')!.textContent)).toContain('SQS')
    expect(chips().every((c) => (c as HTMLButtonElement).disabled)).toBe(true)
    await userEvent.click(screen.getByRole('button', { name: 'Clear search' }))
    expect(screen.getByLabelText('Search components')).toHaveValue('')
    expect(screen.getByLabelText('Search components')).toHaveFocus()
    expect(chips().every((c) => !(c as HTMLButtonElement).disabled)).toBe(true)
    expect([...document.querySelectorAll('.palette h4')]).toHaveLength(1) // the category chosen before is still chosen
  })
  it('the keyboard search key puts the keyboard away so the results can be seen', async () => {
    render(<Palette />)
    const field = screen.getByLabelText('Search components')
    await userEvent.type(field, 'lambda{Enter}')
    expect(field).not.toHaveFocus()
    expect(field).toHaveValue('lambda')
    expect(field).toHaveAttribute('enterkeyhint', 'search')
  })
  it('a new search or filter starts the list from the top', async () => {
    render(<Palette />)
    const list = document.querySelector('.palette-scroll') as HTMLElement
    const scrollTo = vi.fn<(x: number, y: number) => void>()
    list.scrollTo = scrollTo as unknown as typeof list.scrollTo
    fireEvent.click(screen.getByRole('radio', { name: 'Storage' }))
    expect(scrollTo).toHaveBeenLastCalledWith(0, 0)
    scrollTo.mockClear()
    await userEvent.type(screen.getByLabelText('Search components'), 's')
    expect(scrollTo).toHaveBeenCalledWith(0, 0)
  })
})

describe('library pictures', () => {
  // each picture is a small 3D drawing: they are drawn as their tiles come near the screen, not all at once
  let seen: (els: Element[]) => void
  const observed = new Set<Element>()
  beforeEach(() => {
    observed.clear()
    vi.resetModules()
    vi.stubGlobal('IntersectionObserver', class {
      constructor(cb: (entries: { isIntersecting: boolean; target: Element }[]) => void) { seen = (els) => cb(els.map((target) => ({ isIntersecting: true, target }))) }
      observe(el: Element) { observed.add(el) }
      unobserve(el: Element) { observed.delete(el) }
      disconnect() {}
    })
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('draws nothing up front, then each picture once its tile is near, and stops watching it', async () => {
    const { Palette: Lazy } = await import('./Palette')
    render(<Lazy />)
    expect(items()).toHaveLength(count('aws'))
    expect(document.querySelectorAll('.pal-item svg')).toHaveLength(0)
    expect(document.querySelectorAll('.pal-ph')).toHaveLength(count('aws'))
    expect(observed.size).toBe(count('aws'))
    const first = items().slice(0, 6)
    act(() => seen(first))
    expect(document.querySelectorAll('.pal-item svg')).toHaveLength(6)
    first.forEach((t) => expect(observed.has(t)).toBe(false))
    // names are there from the start, so the list can be read and tapped before its pictures arrive
    expect(items()[20]).toHaveTextContent(/\w/)
  })
  it('a tile that leaves the list stops being watched', async () => {
    const { Palette: Lazy } = await import('./Palette')
    render(<Lazy />)
    const before = observed.size
    await userEvent.type(screen.getByLabelText('Search components'), 'lambda')
    expect(observed.size).toBeLessThan(before)
  })
  it('a tile that is not near yet stays undrawn', async () => {
    const { Palette: Lazy } = await import('./Palette')
    render(<Lazy />)
    act(() => (seen as unknown as (e: { isIntersecting: boolean; target: Element }[]) => void)(items().slice(0, 3) as never))
    expect(document.querySelectorAll('.pal-item svg').length).toBe(3)
  })
})

describe('CloudSeg', () => {
  it('switches cloud and remembers the choice on its own, as it does in the phone sheet header', async () => {
    render(<CloudSeg />)
    expect(screen.getByRole('radio', { name: 'AWS' })).toHaveAttribute('aria-checked', 'true')
    await userEvent.click(screen.getByRole('radio', { name: 'GCP' }))
    expect(S().provider).toBe('gcp')
    expect(getPref('provider', 'aws')).toBe('gcp')
    expect(screen.getByRole('radio', { name: 'GCP' })).toHaveAttribute('aria-checked', 'true')
  })
})
