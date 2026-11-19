// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { decodeShare, listSnapshots } from '../core/storage'
import { useStore } from '../core/store'
import { TEMPLATES } from '../core/templates'
import { SAMPLE_TF } from '../core/terraform'
import type { Doc } from '../core/types'
import { docOf, edge, node, resetStore } from '../test/helpers'
import { ExportDialog, HistoryDialog, ImportDialog, ShareDialog, ShortcutsDialog } from './Dialogs'

// these render whole screens; leave headroom for a busy machine
vi.setConfig({ testTimeout: 20_000 })

const S = () => useStore.getState()
const small = () => docOf([node('a', 'ec2', 0, 0, { name: 'web' }), node('b', 'rds', 8, 0, { name: 'db' })], [edge('e', 'a', 'b')], { name: 'My Shop: v2' })

let saved: { name: string; blob: Blob }[] = []
let clip = ''
beforeEach(() => {
  resetStore({ doc: small() })
  saved = []
  clip = ''
  let last: Blob
  vi.spyOn(URL, 'createObjectURL').mockImplementation((b) => { last = b as Blob; return 'blob:x' })
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { if (this.download) saved.push({ name: this.download, blob: last }) })
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn<(t: string) => Promise<void>>(async (t) => { clip = t }) } })
})

afterEach(() => { vi.unstubAllGlobals() })

/** Stand-ins for image decoding and canvas rasterising, which jsdom does not do. */
function fakeRaster(ok = true) {
  const sizes: [number, number][] = []
  vi.stubGlobal('Image', class { onload?: () => void; onerror?: () => void; set src(_: string) { setTimeout(() => (ok ? this.onload?.() : this.onerror?.())) } })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage() {} } as any)
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (this: HTMLCanvasElement, cb: BlobCallback) { sizes.push([this.width, this.height]); cb(new Blob(['png'], { type: 'image/png' })) })
  return sizes
}

describe('ExportDialog', () => {
  const open = () => { const onClose = vi.fn<(...args: any[]) => void>(); render(<ExportDialog onClose={onClose} />); return onClose }
  const format = (name: string) => userEvent.click(screen.getByRole('button', { name: new RegExp('^' + name) }))

  it('starts on PNG with a live preview and image options', () => {
    open()
    expect(screen.getByRole('dialog', { name: 'Export' })).toHaveTextContent('My Shop: v2')
    expect(screen.getByRole('button', { name: /^PNG image/ })).toHaveClass('on')
    expect(document.querySelector('.export-preview svg.preview')).not.toBeNull()
    expect(screen.getByRole('radio', { name: 'Iso' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('radio', { name: '2×' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.queryByRole('button', { name: 'Copy' })).toBeNull()
  })
  it('defaults to the current camera when it has been turned, and to plan when flat', () => {
    resetStore({ doc: small(), yaw: 120, pitch: 50 })
    open()
    expect(screen.getByRole('radio', { name: 'Current' })).toHaveAttribute('aria-checked', 'true')
    document.body.innerHTML = ''
    resetStore({ doc: small(), yaw: 0, pitch: 90, flat: true })
    open()
    expect(screen.getByRole('radio', { name: 'Plan' })).toHaveAttribute('aria-checked', 'true')
  })
  it('previews theme, background, names and view choices', async () => {
    open()
    const pane = document.querySelector('.export-preview') as HTMLElement
    expect(pane.style.background).toBe('rgb(6, 6, 6)')
    await userEvent.click(screen.getByRole('radio', { name: 'Light' }))
    expect(pane.style.background).toBe('rgb(255, 255, 255)')
    await userEvent.click(screen.getByRole('switch', { name: 'Background' }))
    expect(pane).toHaveClass('checker')
    expect(pane.style.background).toBe('')
    expect(pane.querySelector('.nd-label')).not.toBeNull()
    await userEvent.click(screen.getByRole('switch', { name: 'Names' }))
    expect(pane.querySelector('.nd-label')).toBeNull()
    const iso = pane.querySelector('svg')!.getAttribute('viewBox')
    await userEvent.click(screen.getByRole('radio', { name: 'Plan' }))
    expect(pane.querySelector('svg')!.getAttribute('viewBox')).not.toBe(iso)
  })
  it('downloads a PNG at the chosen scale', async () => {
    const sizes = fakeRaster()
    const onClose = open()
    await userEvent.click(screen.getByRole('radio', { name: '1×' }))
    await userEvent.click(screen.getByRole('button', { name: 'Download' }))
    await waitFor(() => expect(saved).toHaveLength(1))
    expect(saved[0].name).toBe('my-shop-v2.png')
    expect(saved[0].blob.type).toBe('image/png')
    expect(S().toasts.at(-1)!.text).toBe('Export downloaded')
    expect(onClose).toHaveBeenCalledTimes(1)
    await userEvent.click(screen.getByRole('radio', { name: '4×' }))
    await userEvent.click(screen.getByRole('button', { name: 'Download' }))
    await waitFor(() => expect(saved).toHaveLength(2))
    expect(sizes[1][0] / sizes[0][0]).toBeCloseTo(4, 1)
  })
  it('reports a failed render and stays open', async () => {
    fakeRaster(false)
    const onClose = open()
    await userEvent.click(screen.getByRole('button', { name: 'Download' }))
    await waitFor(() => expect(S().toasts.at(-1)).toMatchObject({ text: 'Could not rasterise diagram', kind: 'warn' }))
    expect(onClose).not.toHaveBeenCalled()
    expect(saved).toHaveLength(0)
    expect(screen.getByRole('button', { name: 'Download' })).toBeEnabled()
  })
  it('downloads a standalone SVG without editor-only attributes', async () => {
    open()
    await format('SVG vector')
    expect(screen.queryByRole('radio', { name: '2×' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Download' }))
    await waitFor(() => expect(saved).toHaveLength(1))
    expect(saved[0].name).toBe('my-shop-v2.svg')
    expect(saved[0].blob.type).toBe('image/svg+xml')
    const svg = await saved[0].blob.text()
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/)
    expect(svg).toContain('web')
    expect(svg).not.toMatch(/data-kind|data-id|cursor:/)
  })
  it('shows and downloads Terraform, and copies it', async () => {
    open()
    await format('Terraform')
    expect(document.querySelector('pre.code')).toHaveTextContent('resource "aws_instance" "web"')
    expect(document.querySelector('.export-opts')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Copy' }))
    expect(clip).toContain('resource "aws_db_instance" "db"')
    expect(S().toasts.at(-1)!.text).toBe('Copied to clipboard')
    await userEvent.click(screen.getByRole('button', { name: 'Download' }))
    await waitFor(() => expect(saved).toHaveLength(1))
    expect(saved[0].name).toBe('main.tf')
    expect(await saved[0].blob.text()).toBe(clip)
  })
  it('downloads the blueprint as JSON that loads back', async () => {
    open()
    await format('Blueprint JSON')
    await userEvent.click(screen.getByRole('button', { name: 'Download' }))
    await waitFor(() => expect(saved).toHaveLength(1))
    expect(saved[0].name).toBe('my-shop-v2.cloudmill.json')
    expect(saved[0].blob.type).toBe('application/json')
    expect(JSON.parse(await saved[0].blob.text())).toEqual(JSON.parse(JSON.stringify(S().doc)))
  })
  it('downloads the budget as CSV in the current pricing model', async () => {
    resetStore({ doc: small(), pricing: 'commit1' })
    open()
    await format('Budget CSV')
    expect(document.querySelector('pre.code')).toHaveTextContent('us-east-1 · commit1')
    await userEvent.click(screen.getByRole('button', { name: 'Download' }))
    await waitFor(() => expect(saved).toHaveLength(1))
    expect(saved[0].name).toBe('my-shop-v2-budget.csv')
    expect(saved[0].blob.type).toBe('text/csv')
  })
})

describe('ImportDialog', () => {
  const open = (onDoc?: (d: Doc) => void) => { const onClose = vi.fn<(...args: any[]) => void>(); render(<ImportDialog onClose={onClose} onDoc={onDoc} />); return onClose }
  const box = () => screen.getByRole('textbox') as HTMLTextAreaElement
  const importBtn = () => screen.getByRole('button', { name: /^(Import|Create blueprint)$/ })

  it('starts empty with nothing to import', () => {
    open()
    expect(importBtn()).toBeDisabled()
    expect(screen.getByText('A live preview appears here.')).toBeInTheDocument()
    expect(box().placeholder).toContain('.tf files')
  })
  it('previews the Terraform sample and replaces the canvas as one undoable step', async () => {
    const onClose = open()
    await userEvent.click(screen.getByRole('button', { name: 'Load sample' }))
    expect(box().value).toBe(SAMPLE_TF)
    const stats = document.querySelector('.import-stats')!
    expect(stats).toHaveTextContent('10 of 21 resources mapped')
    expect(stats).toHaveTextContent('connections inferred')
    expect(stats).toHaveTextContent(/\d+ supporting types? folded in/)
    expect(document.querySelector('.export-preview svg.preview')).not.toBeNull()
    expect(screen.getByText('Replaces the current canvas. You can undo.')).toBeInTheDocument()
    await userEvent.click(importBtn())
    expect(S().doc.nodes).toHaveLength(11) // ten resources and the users they serve
    expect(S().doc.name).toBe('My Shop: v2') // the blueprint keeps its identity
    expect(S().doc.id).toBe('doc1')
    expect(S().selection).toEqual([])
    expect(S().toasts.at(-1)!.text).toBe('Imported 10 components')
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(S().past).toHaveLength(1)
    act(() => S().undo())
    expect(S().doc.nodes.map((n) => n.id)).toEqual(['a', 'b'])
  })
  it('does not warn about replacing an empty canvas', async () => {
    resetStore()
    open()
    await userEvent.click(screen.getByRole('button', { name: 'Load sample' }))
    expect(screen.queryByText(/Replaces the current canvas/)).toBeNull()
  })
  it('explains Terraform it cannot map', () => {
    open()
    fireEvent.change(box(), { target: { value: 'resource "random_pet" "x" {}\nresource "null_resource" "y" {}' } })
    expect(screen.getByText('Found 2 resource block(s), but none map to a known component.')).toBeInTheDocument()
    expect(importBtn()).toBeDisabled()
    fireEvent.change(box(), { target: { value: 'not terraform at all' } })
    expect(screen.getByText('Found 0 resource block(s), but none map to a known component.')).toBeInTheDocument()
  })
  it('uses the singular for one component', async () => {
    open()
    fireEvent.change(box(), { target: { value: 'resource "aws_s3_bucket" "logs" {}' } })
    expect(document.querySelector('.import-stats')).toHaveTextContent('1 of 1 resources mapped')
    await userEvent.click(importBtn())
    expect(S().toasts.at(-1)!.text).toBe('Imported 1 component')
  })
  it('imports blueprint JSON and rejects what is not one', async () => {
    open()
    await userEvent.click(screen.getByRole('radio', { name: 'Blueprint JSON' }))
    expect(screen.queryByRole('button', { name: 'Load sample' })).toBeNull()
    expect(box().placeholder).toContain('.cloudmill.json')
    fireEvent.change(box(), { target: { value: '{ nope' } })
    expect(screen.getByText(/^Invalid JSON: /)).toBeInTheDocument()
    fireEvent.change(box(), { target: { value: '{"hello":"world"}' } })
    expect(screen.getByText('This JSON is not a blueprint file.')).toBeInTheDocument()
    expect(importBtn()).toBeDisabled()
    fireEvent.change(box(), { target: { value: JSON.stringify(TEMPLATES[1].make()) } })
    expect(document.querySelector('.import-stats')).toBeNull() // statistics are a Terraform thing
    await userEvent.click(importBtn())
    expect(S().doc.nodes).toHaveLength(TEMPLATES[1].make().nodes.length)
  })
  it('clears the text when switching format', async () => {
    open()
    await userEvent.click(screen.getByRole('button', { name: 'Load sample' }))
    await userEvent.click(screen.getByRole('radio', { name: 'Blueprint JSON' }))
    expect(box().value).toBe('')
    expect(importBtn()).toBeDisabled()
  })
  it('reads a chosen file and picks the format from its name', async () => {
    open()
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    const click = vi.spyOn(input, 'click')
    await userEvent.click(screen.getByRole('button', { name: 'Choose file…' }))
    expect(click).toHaveBeenCalled()
    await userEvent.upload(input, new File([JSON.stringify(small())], 'shop.cloudmill.JSON', { type: 'application/json' }))
    await waitFor(() => expect(box().value).toContain('"web"'))
    expect(screen.getByRole('radio', { name: 'Blueprint JSON' })).toHaveAttribute('aria-checked', 'true')
    await userEvent.upload(input, new File(['resource "aws_sqs_queue" "jobs" {}'], 'main.tf'))
    await waitFor(() => expect(box().value).toContain('aws_sqs_queue'))
    expect(screen.getByRole('radio', { name: 'Terraform (HCL)' })).toHaveAttribute('aria-checked', 'true')
    expect(importBtn()).toBeEnabled()
    fireEvent.change(input, { target: { files: [] } }) // a cancelled file dialog changes nothing
    expect(box().value).toContain('aws_sqs_queue')
  })
  it('accepts a dropped file', async () => {
    open()
    expect(fireEvent.dragOver(box())).toBe(false)
    fireEvent.drop(box(), { dataTransfer: { files: [new File(['resource "aws_sns_topic" "t" {}'], 'x.tf')] } })
    await waitFor(() => expect(box().value).toContain('aws_sns_topic'))
  })
  it('hands the result to the caller when creating a new blueprint', async () => {
    const onDoc = vi.fn<(...args: any[]) => void>()
    const onClose = open(onDoc)
    await userEvent.click(screen.getByRole('button', { name: 'Load sample' }))
    expect(screen.queryByText(/Replaces the current canvas/)).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Create blueprint' }))
    expect(onDoc).toHaveBeenCalledTimes(1)
    expect(onDoc.mock.calls[0][0].nodes).toHaveLength(11)
    expect(S().doc.nodes).toHaveLength(2) // the open blueprint is untouched
    expect(onClose).toHaveBeenCalled()
  })
  it('cancels without changing anything', async () => {
    const onClose = open()
    await userEvent.click(screen.getByRole('button', { name: 'Load sample' }))
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalled()
    expect(S().past).toHaveLength(0)
  })
})

describe('ShareDialog', () => {
  it('builds a link that carries the whole blueprint and copies it', async () => {
    render(<ShareDialog onClose={() => {}} />)
    const field = screen.getByRole('textbox') as HTMLInputElement
    expect(field.value).toBe('Generating…')
    expect(screen.getByRole('button', { name: 'Copy link' })).toBeDisabled()
    await waitFor(() => expect(field.value).toMatch(/#\/s\/[\w-]+$/))
    expect(screen.getByText(/compressed into the link itself \(\d+\.\d KB\)/)).toBeInTheDocument()
    const back = await decodeShare(field.value.split('#/s/')[1])
    expect(back!.nodes.map((n) => n.name)).toEqual(['web', 'db'])
    expect(back!.name).toBe('My Shop: v2')
    await userEvent.click(field)
    expect(field.selectionEnd).toBe(field.value.length)
    await userEvent.click(screen.getByRole('button', { name: 'Copy link' }))
    expect(clip).toBe(field.value)
    expect(S().toasts.at(-1)!.text).toBe('Link copied')
    expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument()
  })
  it('goes back to "Copy link" after a moment', async () => {
    render(<ShareDialog onClose={() => {}} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copy link' })).toBeEnabled())
    vi.useFakeTimers()
    try {
      fireEvent.click(screen.getByRole('button', { name: 'Copy link' }))
      await act(async () => { await Promise.resolve() })
      expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument()
      act(() => { vi.advanceTimersByTime(1700) })
      expect(screen.getByRole('button', { name: 'Copy link' })).toBeInTheDocument()
    } finally { vi.useRealTimers() }
  })
  it('refreshes the link when the blueprint changes', async () => {
    render(<ShareDialog onClose={() => {}} />)
    const field = screen.getByRole('textbox') as HTMLInputElement
    await waitFor(() => expect(field.value).toMatch(/#\/s\//))
    const first = field.value
    act(() => { S().addNode('s3', 20, 20) })
    await waitFor(() => expect(field.value).not.toBe(first))
  })
})

describe('ShortcutsDialog', () => {
  it('lists every group with keys spelled for this platform', async () => {
    const onClose = vi.fn<(...args: any[]) => void>()
    render(<ShortcutsDialog onClose={onClose} />)
    expect([...document.querySelectorAll('.keys h5')].map((h) => h.textContent)).toEqual(['Tools', 'Panels', 'Canvas', 'Editing', 'App'])
    expect(screen.getByText('Command palette').parentElement).toHaveTextContent('Ctrl+K')
    expect(screen.getByText('Undo / redo').parentElement).toHaveTextContent('Ctrl+Z / Ctrl+Shift+Z')
    expect(document.body.textContent).not.toMatch(/[⌘⇧⌥⌫]/)
    await userEvent.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalled()
  })
})

describe('HistoryDialog', () => {
  const open = () => { const onClose = vi.fn<(...args: any[]) => void>(); render(<HistoryDialog onClose={onClose} />); return onClose }
  const rows = () => [...document.querySelectorAll('.snap')] as HTMLElement[]
  const field = () => screen.getByPlaceholderText(/Name this version/) as HTMLInputElement

  it('starts with an explanation when there are no versions', () => {
    open()
    expect(screen.getByText(/No versions yet\. Save one before a big change\./)).toBeInTheDocument()
    expect(screen.getByText('Select a version to preview it.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Restore/ })).toBeNull()
  })
  it('saves named and unnamed versions, newest first, and previews the pick', async () => {
    open()
    await userEvent.type(field(), '  Before the split  ')
    await userEvent.click(screen.getByRole('button', { name: 'Save version' }))
    expect(field().value).toBe('')
    await userEvent.type(field(), '{Enter}')
    await userEvent.type(field(), '   {Enter}')
    expect(rows().map((r) => r.querySelector('b')!.textContent)).toEqual(['Version 3', 'Version 2', 'Before the split'])
    expect(rows()[0]).toHaveClass('on')
    expect(rows()[0]).toHaveTextContent('2 components')
    expect(document.querySelector('.export-preview svg.preview')).not.toBeNull()
    expect(listSnapshots('doc1')).toHaveLength(3)
    await userEvent.click(rows()[2])
    expect(rows()[2]).toHaveClass('on')
    expect(rows()[2]).toHaveAttribute('aria-pressed', 'true')
  })
  it('picks a version from the keyboard, without stealing keys from its delete button', async () => {
    open()
    await userEvent.type(field(), 'one{Enter}')
    await userEvent.type(field(), 'two{Enter}')
    rows()[1].focus()
    await userEvent.keyboard('{Enter}')
    expect(rows()[1]).toHaveClass('on')
    rows()[0].focus()
    await userEvent.keyboard(' ')
    expect(rows()[0]).toHaveClass('on')
    fireEvent.keyDown(rows()[1].querySelector('button')!, { key: 'Enter' })
    expect(rows()[0]).toHaveClass('on')
  })
  it('restores a version as an undoable step', async () => {
    const onClose = open()
    await userEvent.type(field(), 'good{Enter}')
    act(() => { S().remove(['b']); S().apply((d) => ({ ...d, region: 'eu-west-1' })) })
    expect(S().doc.nodes).toHaveLength(1)
    await userEvent.click(screen.getByRole('button', { name: 'Restore this version' }))
    expect(S().doc.nodes.map((n) => n.id)).toEqual(['a', 'b'])
    expect(S().doc.edges).toHaveLength(1)
    expect(S().doc.region).toBe('us-east-1')
    expect(S().toasts.at(-1)!.text).toBe('Restored “good”')
    expect(onClose).toHaveBeenCalled()
    act(() => S().undo())
    expect(S().doc.nodes).toHaveLength(1)
  })
  it('deletes versions and moves the preview on', async () => {
    open()
    for (const n of ['one', 'two', 'three']) await userEvent.type(field(), n + '{Enter}')
    await userEvent.click(rows()[1])
    // deleting another row leaves the pick alone
    await userEvent.click(rows()[2].querySelector('button')!)
    expect(rows().map((r) => r.querySelector('b')!.textContent)).toEqual(['three', 'two'])
    expect(rows()[1]).toHaveClass('on')
    // deleting the picked row moves to the newest
    await userEvent.click(rows()[1].querySelector('button')!)
    expect(rows()).toHaveLength(1)
    expect(rows()[0]).toHaveClass('on')
    await userEvent.click(rows()[0].querySelector('button')!)
    expect(rows()).toHaveLength(0)
    expect(screen.getByText('Select a version to preview it.')).toBeInTheDocument()
    expect(listSnapshots('doc1')).toHaveLength(0)
  })
  it('lists versions saved earlier', () => {
    resetStore({ doc: small() })
    const { unmount } = render(<HistoryDialog onClose={() => {}} />)
    fireEvent.change(field(), { target: { value: 'kept' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save version' }))
    unmount()
    open()
    expect(rows()).toHaveLength(1)
    expect(rows()[0]).toHaveTextContent('kept')
  })
})
