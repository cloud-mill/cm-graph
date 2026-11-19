// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CATALOG_LIST, docCost, money } from '../core/catalog'
import { getPref, listDocs, loadDoc, saveDoc } from '../core/storage'
import { useStore } from '../core/store'
import { TEMPLATES } from '../core/templates'
import { docOf, node, resetStore } from '../test/helpers'
import { Dashboard } from './Dashboard'

// these render whole screens; leave headroom for a busy machine
vi.setConfig({ testTimeout: 20_000 })

const stored = (id: string, name: string, updatedAt = Date.now(), nodes = [node('a')]) => saveDoc({ ...docOf(nodes), id, name, updatedAt })
const openBtn = (name: string) => screen.getByRole('button', { name: `Open ${name}` })
/** The whole card of a saved blueprint: its picture, details and its own buttons. */
const card = (name: string) => openBtn(name).closest('.card') as HTMLElement
const opened = () => location.hash.match(/^#\/d\/([\w-]+)$/)?.[1]

beforeEach(() => {
  resetStore()
  // still pictures: the orbiting previews are exercised on their own below
  vi.spyOn(window, 'matchMedia').mockImplementation((q) => ({ matches: /reduce/.test(q), media: q, addEventListener() {}, removeEventListener() {} }) as any)
})
afterEach(() => { vi.useRealTimers() })

describe('Dashboard', () => {
  it('introduces the product with figures taken from the real sample', () => {
    render(<Dashboard />)
    expect(document.title).toBe('CloudMill Graph · cloud architecture studio')
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Infrastructure,drawn to scale.')
    const sample = TEMPLATES[0].make()
    expect(document.querySelector('.feat-total')).toHaveTextContent(money(docCost(sample).total))
    expect(screen.getByText(new RegExp(`${CATALOG_LIST.length} components across AWS`))).toBeInTheDocument()
    expect(screen.getByLabelText('Terraform generated from the sample blueprint')).toHaveTextContent('resource "aws_db_instance"')
    expect(document.querySelectorAll('.feat')).toHaveLength(4)
    const hero = TEMPLATES[3].make()
    expect(document.querySelector('.hero-stage')).toHaveTextContent(`${hero.nodes.length} nodes · ${hero.edges.length} links`)
    expect(document.body.textContent).not.toMatch(/[–—]/)
  })
  it('starts a new, empty blueprint from either button', async () => {
    render(<Dashboard />)
    await userEvent.click(screen.getByRole('button', { name: 'New blueprint' }))
    const first = opened()!
    expect(loadDoc(first)).toMatchObject({ name: 'Untitled blueprint', nodes: [] })
    await userEvent.click(screen.getByRole('button', { name: 'Start a blueprint' }))
    expect(opened()).not.toBe(first)
    expect(listDocs()).toHaveLength(2)
  })
  it('starts from the empty state too', async () => {
    render(<Dashboard />)
    expect(screen.getByText(/^Stored in this browser\./)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /Nothing drafted yet/ }))
    expect(loadDoc(opened()!)!.nodes).toHaveLength(0)
  })
  it('opens the sample from the button, the picture or the keyboard', async () => {
    render(<Dashboard />)
    await userEvent.click(screen.getByRole('button', { name: 'Open the sample' }))
    const a = opened()!
    expect(loadDoc(a)!.name).toBe('Kubernetes microservices')
    await userEvent.click(screen.getByRole('button', { name: 'Open the sample blueprint' }))
    const b = opened()!
    expect(b).not.toBe(a)
    // it has the button role, so it answers to both keys a button does, and to no others
    fireEvent.keyDown(screen.getByRole('button', { name: 'Open the sample blueprint' }), { key: 'x' })
    expect(opened()).toBe(b)
    fireEvent.keyDown(screen.getByRole('button', { name: 'Open the sample blueprint' }), { key: ' ' })
    const c = opened()!
    expect(c).not.toBe(b)
    fireEvent.keyDown(screen.getByRole('button', { name: 'Open the sample blueprint' }), { key: 'Enter' })
    expect(opened()).not.toBe(c)
  })
  it('offers every template, each opening as an independent copy', async () => {
    render(<Dashboard />)
    for (const t of TEMPLATES) expect(screen.getByRole('button', { name: `Start from the ${t.name} template` })).toBeInTheDocument()
    const t = TEMPLATES[1]
    const el = screen.getByRole('button', { name: `Start from the ${t.name} template` })
    expect(el).toHaveTextContent(t.blurb)
    expect(el).toHaveTextContent(money(docCost(t.make()).total, true) + '/mo')
    await userEvent.click(el)
    const a = opened()!
    fireEvent.keyDown(el, { key: 'Enter' })
    const b = opened()!
    expect(a).not.toBe(b)
    expect(loadDoc(a)!.name).toBe(t.make().name)
    expect(loadDoc(a)!.nodes[0].id).not.toBe(loadDoc(b)!.nodes[0].id)
    fireEvent.keyDown(el, { key: 'x' })
    expect(opened()).toBe(b)
  })
  it('lists saved blueprints, most recent first, and opens one', async () => {
    stored('old', 'Older', Date.now() - 3 * 86400_000)
    stored('new', 'Newer', Date.now() - 5 * 60_000, [])
    stored('', '', Date.now() - 2 * 3600_000)
    render(<Dashboard />)
    const names = [...document.querySelectorAll('.card.doc h3')].map((h) => h.textContent)
    expect(names).toEqual(['Newer', 'Untitled', 'Older'])
    expect(screen.getByText('3 stored in this browser. Nothing leaves it unless you share a link.')).toBeInTheDocument()
    expect(card('Newer')).toHaveTextContent('Empty plane')
    expect(card('Newer')).toHaveTextContent('00 nodes')
    expect(card('Newer')).toHaveTextContent('5m ago')
    expect(card('Untitled')).toHaveTextContent('2h ago')
    expect(card('Older')).toHaveTextContent('3d ago')
    expect(card('Older')).toHaveTextContent('01 nodes')
    await userEvent.click(openBtn('Older'))
    expect(opened()).toBe('old')
    openBtn('Newer').focus()
    await userEvent.keyboard('{Enter}')
    expect(opened()).toBe('new')
  })
  it('words ages from "just now" to a date', () => {
    stored('a', 'Fresh', Date.now() - 5_000)
    stored('b', 'Ancient', new Date(2020, 2, 14).getTime())
    render(<Dashboard />)
    expect(card('Fresh')).toHaveTextContent('just now')
    expect(card('Ancient')).toHaveTextContent(new Date(2020, 2, 14).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))
  })
  it('skips an index entry whose blueprint is gone', () => {
    stored('a', 'Here')
    stored('b', 'Lost')
    localStorage.removeItem('stratum:doc:b')
    render(<Dashboard />)
    expect([...document.querySelectorAll('.card.doc h3')].map((h) => h.textContent)).toEqual(['Here'])
  })
  it('duplicates a blueprint without opening it', async () => {
    stored('a', 'Shop')
    render(<Dashboard />)
    await userEvent.click(within(card('Shop')).getByRole('button', { name: 'Duplicate' }))
    expect(location.hash).toBe('')
    expect(card('Shop (copy)')).toBeInTheDocument()
    expect(listDocs()).toHaveLength(2)
  })
  it('deletes only after a second, explicit click', async () => {
    stored('a', 'Shop')
    stored('b', 'Other')
    render(<Dashboard />)
    await userEvent.click(within(card('Shop')).getByRole('button', { name: 'Delete' }))
    expect(listDocs()).toHaveLength(2)
    const confirm = within(card('Shop')).getByRole('button', { name: 'Delete?' })
    expect(confirm).toHaveFocus()
    await userEvent.click(confirm)
    expect(screen.queryByRole('button', { name: 'Open Shop' })).toBeNull()
    expect(listDocs().map((d) => d.id)).toEqual(['b'])
    expect(loadDoc('a')).toBeNull()
    expect(location.hash).toBe('')
  })
  it('backs out of deleting when focus moves away', async () => {
    stored('a', 'Shop')
    render(<Dashboard />)
    await userEvent.click(within(card('Shop')).getByRole('button', { name: 'Delete' }))
    fireEvent.blur(within(card('Shop')).getByRole('button', { name: 'Delete?' }))
    expect(within(card('Shop')).queryByRole('button', { name: 'Delete?' })).toBeNull()
    expect(within(card('Shop')).getByRole('button', { name: 'Delete' })).toBeInTheDocument()
    expect(listDocs()).toHaveLength(1)
  })
  it('confirming a delete from the keyboard does not also open the blueprint', async () => {
    stored('a', 'Shop')
    render(<Dashboard />)
    await userEvent.click(within(card('Shop')).getByRole('button', { name: 'Delete' }))
    await userEvent.keyboard('{Enter}')
    expect(listDocs()).toHaveLength(0)
    expect(location.hash).toBe('')
    expect(screen.getByRole('button', { name: /Nothing drafted yet/ })).toBeInTheDocument()
  })
  it('filters once there are more than three blueprints', async () => {
    for (const [i, n] of ['Alpha shop', 'Beta API', 'Gamma lake'].entries()) stored('d' + i, n)
    const { unmount } = render(<Dashboard />)
    expect(screen.queryByLabelText('Filter blueprints')).toBeNull()
    unmount()
    stored('d3', 'Delta SHOP')
    render(<Dashboard />)
    const q = screen.getByLabelText('Filter blueprints')
    await userEvent.type(q, '  shop ')
    expect([...document.querySelectorAll('.card.doc h3')].map((h) => h.textContent).sort()).toEqual(['Alpha shop', 'Delta SHOP'])
    await userEvent.clear(q)
    await userEvent.type(q, 'zzz')
    expect(screen.getByText('No blueprints match “zzz”.')).toBeInTheDocument()
    expect(document.querySelectorAll('.card.doc')).toHaveLength(0)
  })
  it('switches theme and remembers it', async () => {
    render(<Dashboard />)
    const t = screen.getByRole('button', { name: 'Toggle theme' })
    expect(t).toHaveTextContent('Light theme')
    await userEvent.click(t)
    expect(useStore.getState().theme).toBe('light')
    expect(document.documentElement.dataset.theme).toBe('light')
    expect(getPref('theme', 'dark')).toBe('light')
    expect(t).toHaveTextContent('Dark theme')
    await userEvent.click(t)
    expect(document.documentElement.dataset.theme).toBe('dark')
  })
  it('creates a blueprint from pasted Terraform', async () => {
    render(<Dashboard />)
    await userEvent.click(screen.getByRole('button', { name: 'Import Terraform' }))
    const dlg = screen.getByRole('dialog', { name: 'Import' })
    await userEvent.click(within(dlg).getByRole('button', { name: 'Load sample' }))
    await userEvent.click(within(dlg).getByRole('button', { name: 'Create blueprint' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    const doc = loadDoc(opened()!)!
    expect(doc.name).toBe('Imported from Terraform')
    expect(doc.nodes).toHaveLength(11)
  })
  it('offers the same import from the hero, which is where a phone finds it', async () => {
    render(<Dashboard />)
    const again = screen.getByRole('button', { name: 'Import from Terraform' })
    expect(again).toHaveClass('only-phone')
    await userEvent.click(again)
    expect(screen.getByRole('dialog', { name: 'Import' })).toBeInTheDocument()
  })
  it('closes the import dialog without creating anything', async () => {
    render(<Dashboard />)
    await userEvent.click(screen.getByRole('button', { name: 'Import Terraform' }))
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(listDocs()).toHaveLength(0)
  })
  it('scrolls to a section from the navigation', async () => {
    const scroll = vi.spyOn(Element.prototype, 'scrollIntoView')
    render(<Dashboard />)
    await userEvent.click(screen.getByRole('link', { name: 'Templates' }))
    await userEvent.click(screen.getByRole('link', { name: 'Blueprints' }))
    expect(scroll.mock.contexts.map((e) => (e as Element).id)).toEqual(['templates', 'blueprints'])
    expect(location.hash).toBe('')
  })
})

describe('live previews', () => {
  const frames = (ms: number) => act(() => { vi.advanceTimersByTime(ms) })
  beforeEach(() => {
    vi.mocked(window.matchMedia).mockImplementation((q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} }) as any)
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance', 'setTimeout', 'clearTimeout', 'Date'] })
  })
  it('the hero drifts through a slow orbit and reports its heading', () => {
    render(<Dashboard />)
    const az = document.querySelector('.readout.tr span')!
    const art = () => document.querySelector('.hero-stage svg g')!.innerHTML
    const first = art()
    expect(az.textContent).toBe('045°')
    frames(4000)
    expect(az.textContent).not.toBe('045°')
    expect(az.textContent).toMatch(/^0\d\d°$/)
    expect(art()).not.toBe(first)
  })
  it('a card leans while hovered and settles back afterwards', () => {
    render(<Dashboard />)
    const el = screen.getByRole('button', { name: `Start from the ${TEMPLATES[0].name} template` })
    const art = () => el.querySelector('svg g')!.innerHTML
    const rest = art()
    frames(500)
    expect(art()).toBe(rest) // nothing moves until hovered
    fireEvent.pointerEnter(el)
    frames(1500)
    const leaning = art()
    expect(leaning).not.toBe(rest)
    fireEvent.pointerLeave(el)
    frames(4000)
    expect(art()).not.toBe(leaning)
  })
  it('stops animating when the page is left', () => {
    const cancel = vi.spyOn(globalThis, 'cancelAnimationFrame')
    const { unmount } = render(<Dashboard />)
    frames(100)
    unmount()
    expect(cancel).toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})
