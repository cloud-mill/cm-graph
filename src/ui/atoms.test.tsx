// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useStore } from '../core/store'
import { resetStore } from '../test/helpers'
import { IconBtn, Modal, NumberInput, Row, SWATCHES, Segmented, Select, Swatches, TextInput, Toggle, focusPending, keys, typeAhead, useTween } from './atoms'

/** A pointer that really moved; jsdom does not carry movementX/Y through the event constructor. */
const moveOver = (el: Element, dx = 1) => {
  const e = new MouseEvent('pointermove', { bubbles: true })
  Object.defineProperty(e, 'movementX', { value: dx })
  Object.defineProperty(e, 'movementY', { value: 0 })
  fireEvent(el, e)
}

beforeEach(() => resetStore())
afterEach(() => { vi.useRealTimers() })

describe('Segmented', () => {
  it('marks the current option and reports a pick', async () => {
    const onChange = vi.fn<(...args: any[]) => void>()
    render(<Segmented value="b" onChange={onChange} size="sm" options={[{ value: 'a', label: 'Alpha', title: 'First' }, { value: 'b', label: 'Beta' }]} />)
    expect(screen.getByRole('radiogroup')).toHaveClass('seg-sm')
    expect(screen.getByRole('radio', { name: 'Beta' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('radio', { name: 'Alpha' })).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByRole('radio', { name: 'Alpha' })).toHaveAttribute('title', 'First')
    await userEvent.click(screen.getByRole('radio', { name: 'Alpha' }))
    expect(onChange).toHaveBeenCalledWith('a')
  })
})

describe('IconBtn', () => {
  it('exposes its title, pressed state and shortcut', async () => {
    const onClick = vi.fn<(...args: any[]) => void>()
    render(<IconBtn title="Grid" kbd="G" active onClick={onClick}>x</IconBtn>)
    const b = screen.getByRole('button', { name: 'Grid' })
    expect(b).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('tooltip')).toHaveTextContent('GridG')
    await userEvent.click(b)
    expect(onClick).toHaveBeenCalledTimes(1)
  })
  it('does nothing when disabled', async () => {
    const onClick = vi.fn<(...args: any[]) => void>()
    render(<IconBtn title="Undo" disabled onClick={onClick}>x</IconBtn>)
    const b = screen.getByRole('button', { name: 'Undo' })
    expect(b).toBeDisabled()
    await userEvent.click(b)
    expect(onClick).not.toHaveBeenCalled()
  })
})

describe('keys', () => {
  it('spells Mac symbols as words on other platforms', () => {
    // jsdom does not report a Mac platform
    expect(keys('⌘K')).toBe('Ctrl+K')
    expect(keys('⇧⌘Z')).toBe('Ctrl+Shift+Z')
    expect(keys('⌥ + drag')).toBe('Alt + drag')
    expect(keys('⇧')).toBe('Shift')
    expect(keys('⌫')).toBe('Del')
    expect(keys('F')).toBe('F')
  })
})

describe('Modal', () => {
  const setup = (footer = false) => {
    const onClose = vi.fn<(...args: any[]) => void>()
    render(<Modal title="Export" subtitle="Sub" onClose={onClose} footer={footer ? <button>Go</button> : undefined}><input aria-label="inner" /></Modal>)
    return onClose
  }
  it('renders title, subtitle, body and footer', () => {
    setup(true)
    const dlg = screen.getByRole('dialog', { name: 'Export' })
    expect(dlg).toHaveTextContent('Sub')
    expect(screen.getByRole('button', { name: 'Go' })).toBeInTheDocument()
    expect(dlg.querySelector('footer')).not.toBeNull()
  })
  it('has no footer element when none is given', () => {
    setup()
    expect(screen.getByRole('dialog').querySelector('footer')).toBeNull()
  })
  it('closes on Escape, the close button and a click on the scrim, but not inside', async () => {
    const onClose = setup()
    fireEvent.keyDown(window, { key: 'a' })
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    await userEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledTimes(2)
    fireEvent.pointerDown(screen.getByRole('dialog'))
    fireEvent.pointerDown(screen.getByLabelText('inner'))
    expect(onClose).toHaveBeenCalledTimes(2)
    fireEvent.pointerDown(document.querySelector('.scrim')!)
    expect(onClose).toHaveBeenCalledTimes(3)
  })
  it('stops listening once closed', () => {
    const onClose = vi.fn<(...args: any[]) => void>()
    const { unmount } = render(<Modal title="T" onClose={onClose}>x</Modal>)
    unmount()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
  })
})

describe('TextInput', () => {
  function Host({ multiline, focusKey }: { multiline?: boolean; focusKey?: number }) {
    const [v, setV] = useState('abc')
    return <TextInput label="Component name" value={v} onChange={setV} placeholder="Name" multiline={multiline} mono autoFocusKey={focusKey} className="extra" />
  }
  it('edits its value and blurs on Enter or Escape', async () => {
    render(<Host />)
    const el = screen.getByPlaceholderText('Name') as HTMLInputElement
    expect(el.tagName).toBe('INPUT')
    expect(el).toHaveClass('input', 'mono', 'extra')
    await userEvent.type(el, 'd')
    expect(el.value).toBe('abcd')
    expect(el).toHaveFocus()
    await userEvent.keyboard('{Enter}')
    expect(el).not.toHaveFocus()
    el.focus()
    await userEvent.keyboard('{Escape}')
    expect(el).not.toHaveFocus()
  })
  it('keeps Enter for new lines when multiline', async () => {
    render(<Host multiline />)
    const el = screen.getByPlaceholderText('Name') as HTMLTextAreaElement
    expect(el.tagName).toBe('TEXTAREA')
    await userEvent.type(el, '{Enter}x')
    expect(el.value).toBe('abc\nx')
    expect(el).toHaveFocus()
    await userEvent.keyboard('{Escape}')
    expect(el).not.toHaveFocus()
  })
  it('takes focus once per request and enters what was typed ahead', () => {
    vi.useFakeTimers()
    const exec = vi.spyOn(document, 'execCommand').mockReturnValue(true)
    // the request is noted the moment the store asks for focus
    act(() => { useStore.setState({ focusName: 101 }) })
    expect(focusPending()).toBe(true)
    typeAhead('h'); typeAhead('i')
    const { rerender } = render(<Host focusKey={101} />)
    const el = screen.getByPlaceholderText('Name') as HTMLInputElement
    expect(el).not.toHaveFocus()
    act(() => { vi.advanceTimersByTime(40) })
    expect(el).toHaveFocus()
    expect(el.selectionStart).toBe(0)
    expect(el.selectionEnd).toBe(3)
    expect(exec).toHaveBeenCalledWith('insertText', false, 'hi')
    expect(focusPending()).toBe(false)
    // the same request is not honoured twice
    el.blur()
    rerender(<Host focusKey={101} />)
    act(() => { vi.advanceTimersByTime(40) })
    expect(el).not.toHaveFocus()
    expect(exec).toHaveBeenCalledTimes(1)
  })
  it('does not steal focus without a request', () => {
    vi.useFakeTimers()
    render(<Host focusKey={0} />)
    act(() => { vi.advanceTimersByTime(40) })
    expect(screen.getByPlaceholderText('Name')).not.toHaveFocus()
  })
})

describe('NumberInput', () => {
  function Host({ onChange, ...p }: { onChange?: (v: number) => void; min?: number; max?: number; step?: number; unit?: string; start?: number }) {
    const [v, setV] = useState(p.start ?? 5)
    return <><NumberInput label="Instances" value={v} onChange={(n) => { setV(n); onChange?.(n) }} min={p.min} max={p.max} step={p.step} unit={p.unit} /><button onClick={() => setV(42)}>ext</button></>
  }
  it('commits typed numbers and shows the unit', async () => {
    const onChange = vi.fn<(...args: any[]) => void>()
    render(<Host onChange={onChange} unit="GB" />)
    const el = screen.getByRole('textbox') as HTMLInputElement
    expect(screen.getByText('GB')).toBeInTheDocument()
    await userEvent.clear(el)
    expect(onChange).not.toHaveBeenCalled() // an empty field is not a number
    await userEvent.type(el, '12')
    expect(onChange).toHaveBeenLastCalledWith(12)
  })
  it('ignores text that is not a number and restores the value on blur', async () => {
    const onChange = vi.fn<(...args: any[]) => void>()
    render(<Host onChange={onChange} />)
    const el = screen.getByRole('textbox') as HTMLInputElement
    await userEvent.clear(el)
    await userEvent.type(el, 'abc')
    expect(onChange).not.toHaveBeenCalled()
    expect(el.value).toBe('abc')
    fireEvent.blur(el)
    expect(el.value).toBe('5')
  })
  it('clamps to min and max', async () => {
    const onChange = vi.fn<(...args: any[]) => void>()
    render(<Host onChange={onChange} min={2} max={10} />)
    const el = screen.getByRole('textbox') as HTMLInputElement
    await userEvent.clear(el)
    await userEvent.type(el, '99')
    expect(onChange).toHaveBeenLastCalledWith(10)
    await userEvent.clear(el)
    await userEvent.type(el, '1')
    expect(onChange).toHaveBeenLastCalledWith(2)
    fireEvent.blur(el)
    expect(el.value).toBe('2')
  })
  it('steps with the arrow keys, ten at a time with Shift, inside the limits', async () => {
    const onChange = vi.fn<(...args: any[]) => void>()
    render(<Host onChange={onChange} min={0} max={20} step={2} />)
    const el = screen.getByRole('textbox') as HTMLInputElement
    el.focus()
    await userEvent.keyboard('{ArrowUp}')
    expect(onChange).toHaveBeenLastCalledWith(7)
    expect(el.value).toBe('7')
    await userEvent.keyboard('{ArrowDown}{ArrowDown}')
    expect(onChange).toHaveBeenLastCalledWith(3)
    await userEvent.keyboard('{Shift>}{ArrowUp}{/Shift}')
    expect(onChange).toHaveBeenLastCalledWith(20)
    await userEvent.keyboard('{Shift>}{ArrowDown}{ArrowDown}{/Shift}')
    expect(onChange).toHaveBeenLastCalledWith(0)
  })
  it('avoids floating point noise when stepping by fractions', async () => {
    const onChange = vi.fn<(...args: any[]) => void>()
    render(<Host onChange={onChange} start={0.1} step={0.2} />)
    screen.getByRole('textbox').focus()
    await userEvent.keyboard('{ArrowUp}')
    expect(onChange).toHaveBeenLastCalledWith(0.3)
  })
  it('blurs on Enter and Escape and selects on focus', async () => {
    render(<Host />)
    const el = screen.getByRole('textbox') as HTMLInputElement
    await userEvent.click(el)
    expect(el.selectionEnd).toBe(1)
    await userEvent.keyboard('{Enter}')
    expect(el).not.toHaveFocus()
    await userEvent.click(el)
    await userEvent.keyboard('{Escape}')
    expect(el).not.toHaveFocus()
  })
  it('follows outside changes while idle, but not while being typed in', async () => {
    render(<Host />)
    const el = screen.getByRole('textbox') as HTMLInputElement
    await userEvent.click(screen.getByText('ext'))
    expect(el.value).toBe('42')
    fireEvent.focus(el)
    fireEvent.change(el, { target: { value: '4' } })
    fireEvent.click(screen.getByText('ext'))
    expect(el.value).toBe('4')
    fireEvent.blur(el)
    expect(el.value).toBe('42')
  })
  it('does not report a value that did not change', async () => {
    const onChange = vi.fn<(...args: any[]) => void>()
    render(<Host onChange={onChange} />)
    const el = screen.getByRole('textbox')
    fireEvent.change(el, { target: { value: '5.0' } })
    expect(onChange).not.toHaveBeenCalled()
  })
})

describe('Swatches', () => {
  it('highlights the current colour whatever its case and reports a pick', async () => {
    const onChange = vi.fn<(...args: any[]) => void>()
    render(<Swatches value={SWATCHES[2].toLowerCase()} onChange={onChange} />)
    expect(screen.getByRole('button', { name: SWATCHES[2] })).toHaveClass('on')
    expect(screen.queryByRole('button', { name: 'Default colour' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: SWATCHES[4] }))
    expect(onChange).toHaveBeenCalledWith(SWATCHES[4])
    expect(screen.getAllByRole('button')).toHaveLength(SWATCHES.length)
  })
  it('offers a reset that is on when no colour is set', async () => {
    const onChange = vi.fn<(...args: any[]) => void>()
    render(<Swatches allowReset onChange={onChange} />)
    const reset = screen.getByRole('button', { name: 'Default colour' })
    expect(reset).toHaveClass('on')
    await userEvent.click(reset)
    expect(onChange).toHaveBeenCalledWith(undefined)
  })
})

describe('Row and Toggle', () => {
  it('labels a control', () => {
    render(<Row label="Engine"><b>x</b></Row>)
    expect(screen.getByText('Engine')).toHaveClass('row-label')
  })
  it('flips and announces its state', async () => {
    const onChange = vi.fn<(...args: any[]) => void>()
    const { rerender } = render(<Toggle label="Multi-AZ" value={false} onChange={onChange} />)
    const sw = screen.getByRole('switch', { name: 'Multi-AZ' })
    expect(sw).toHaveAttribute('aria-checked', 'false')
    await userEvent.click(sw)
    expect(onChange).toHaveBeenCalledWith(true)
    rerender(<Toggle label="Multi-AZ" value onChange={onChange} />)
    expect(sw).toHaveAttribute('aria-checked', 'true')
    expect(sw).toHaveClass('on')
    await userEvent.click(sw)
    expect(onChange).toHaveBeenLastCalledWith(false)
  })
})

describe('useTween', () => {
  function Show({ v }: { v: number }) { return <span data-testid="v">{useTween(v, 400)}</span> }
  it('eases to a new value and lands exactly on it', () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance', 'setTimeout', 'clearTimeout', 'Date'] })
    const { rerender } = render(<Show v={0} />)
    expect(screen.getByTestId('v')).toHaveTextContent('0')
    rerender(<Show v={100} />)
    act(() => { vi.advanceTimersByTime(200) })
    const mid = Number(screen.getByTestId('v').textContent)
    expect(mid).toBeGreaterThan(50) // ease-out: past half way at half time
    expect(mid).toBeLessThan(100)
    act(() => { vi.advanceTimersByTime(400) })
    expect(screen.getByTestId('v')).toHaveTextContent(/^100$/)
  })
  it('stops animating when unmounted', () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] })
    const cancel = vi.spyOn(globalThis, 'cancelAnimationFrame')
    const { rerender, unmount } = render(<Show v={0} />)
    rerender(<Show v={10} />)
    unmount()
    expect(cancel).toHaveBeenCalled()
  })
})

describe('Select', () => {
  const OPTS = [{ value: 'a', label: 'Apple' }, { value: 'b', label: 'Banana' }, { value: 'c', label: 'Cherry' }, { value: 'd', label: 'Avocado' }]
  function Host({ onChange, start = 'b' }: { onChange?: (v: string) => void; start?: string }) {
    const [v, setV] = useState(start)
    return <Select label="Fruit" value={v} options={OPTS} onChange={(n) => { setV(n); onChange?.(n) }} className="x" />
  }
  const box = () => screen.getByRole('combobox', { name: 'Fruit' })
  const active = () => document.querySelector('.select-item.active')?.textContent

  it('shows the current label and opens on click with the current option active', async () => {
    render(<Host />)
    expect(box()).toHaveTextContent('Banana')
    expect(box()).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('listbox')).toBeNull()
    await userEvent.click(box())
    expect(box()).toHaveAttribute('aria-expanded', 'true')
    const list = screen.getByRole('listbox', { name: 'Fruit' })
    expect(list.parentElement).toBe(document.body)
    expect(box().getAttribute('aria-controls')).toBe(list.id)
    expect(screen.getAllByRole('option')).toHaveLength(4)
    expect(screen.getByRole('option', { name: 'Banana' })).toHaveAttribute('aria-selected', 'true')
    expect(active()).toBe('Banana')
    expect(box().getAttribute('aria-activedescendant')).toBe(screen.getByRole('option', { name: 'Banana' }).id)
    await userEvent.click(box())
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(box()).not.toHaveAttribute('aria-activedescendant')
  })
  it('falls back to the raw value when it is not among the options', () => {
    render(<Host start="zzz" />)
    expect(box()).toHaveTextContent('zzz')
  })
  it('picks with the mouse and returns focus to the field', async () => {
    const onChange = vi.fn<(...args: any[]) => void>()
    render(<Host onChange={onChange} />)
    await userEvent.click(box())
    moveOver(screen.getByRole('option', { name: 'Apple' }), 0) // the list appearing under a resting pointer is not a hover
    expect(active()).toBe('Banana')
    moveOver(screen.getByRole('option', { name: 'Cherry' }))
    expect(active()).toBe('Cherry')
    await userEvent.click(screen.getByRole('option', { name: 'Cherry' }))
    expect(onChange).toHaveBeenCalledWith('c')
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(box()).toHaveFocus()
    expect(box()).toHaveTextContent('Cherry')
  })
  it('does not report picking the value it already has', async () => {
    const onChange = vi.fn<(...args: any[]) => void>()
    render(<Host onChange={onChange} />)
    await userEvent.click(box())
    await userEvent.click(screen.getByRole('option', { name: 'Banana' }))
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.queryByRole('listbox')).toBeNull()
  })
  it.each(['{ArrowDown}', '{ArrowUp}', '{Enter}', ' '])('opens from the keyboard with %s', async (k) => {
    render(<Host />)
    box().focus()
    await userEvent.keyboard(k)
    expect(screen.getByRole('listbox')).toBeInTheDocument()
    expect(active()).toBe('Banana')
  })
  it('ignores other keys while closed', async () => {
    render(<Host />)
    box().focus()
    await userEvent.keyboard('x{Home}')
    expect(screen.queryByRole('listbox')).toBeNull()
  })
  it('moves with arrows (wrapping), Home and End, and picks with Enter or Space', async () => {
    const onChange = vi.fn<(...args: any[]) => void>()
    render(<Host onChange={onChange} />)
    box().focus()
    await userEvent.keyboard('{ArrowDown}')
    await userEvent.keyboard('{ArrowDown}')
    expect(active()).toBe('Cherry')
    await userEvent.keyboard('{ArrowDown}{ArrowDown}')
    expect(active()).toBe('Apple') // wrapped past the end
    await userEvent.keyboard('{ArrowUp}')
    expect(active()).toBe('Avocado') // and back round
    await userEvent.keyboard('{Home}')
    expect(active()).toBe('Apple')
    await userEvent.keyboard('{End}')
    expect(active()).toBe('Avocado')
    await userEvent.keyboard('{Enter}')
    expect(onChange).toHaveBeenLastCalledWith('d')
    await userEvent.keyboard(' ')
    await userEvent.keyboard('{Home}')
    await userEvent.keyboard(' ')
    expect(onChange).toHaveBeenLastCalledWith('a')
    expect(screen.queryByRole('listbox')).toBeNull()
  })
  it('jumps to the next option starting with a typed letter', async () => {
    render(<Host start="a" />)
    box().focus()
    await userEvent.keyboard('{Enter}')
    await userEvent.keyboard('a')
    expect(active()).toBe('Avocado')
    await userEvent.keyboard('A')
    expect(active()).toBe('Apple')
    await userEvent.keyboard('c')
    expect(active()).toBe('Cherry')
    await userEvent.keyboard('z')
    expect(active()).toBe('Cherry')
  })
  it('closes on Escape and on Tab without changing the value', async () => {
    const onChange = vi.fn<(...args: any[]) => void>()
    render(<Host onChange={onChange} />)
    box().focus()
    await userEvent.keyboard('{Enter}{ArrowDown}{Escape}')
    expect(screen.queryByRole('listbox')).toBeNull()
    await userEvent.keyboard('{Enter}')
    fireEvent.keyDown(box(), { key: 'Tab' })
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(onChange).not.toHaveBeenCalled()
  })
  it('keeps keys to itself while open, and lets them through when closed', async () => {
    const seen: string[] = []
    const spy = (e: KeyboardEvent) => seen.push(e.key)
    window.addEventListener('keydown', spy)
    render(<Host />)
    box().focus()
    await userEvent.keyboard('g')
    expect(seen).toEqual(['g'])
    await userEvent.keyboard('{Enter}')
    await userEvent.keyboard('g{ArrowDown}')
    expect(seen).toEqual(['g'])
    // shortcuts with Ctrl or Cmd always reach the app, and never move the list
    fireEvent.keyDown(box(), { key: 'z', ctrlKey: true })
    fireEvent.keyDown(box(), { key: 'ArrowDown', metaKey: true })
    expect(seen).toEqual(['g', 'z', 'ArrowDown'])
    expect(active()).toBe('Cherry')
    window.removeEventListener('keydown', spy)
  })
  it('closes when the pointer goes down elsewhere, the page scrolls or resizes safely', async () => {
    render(<><Host /><button>other</button></>)
    await userEvent.click(box())
    fireEvent.pointerDown(screen.getByRole('option', { name: 'Apple' }))
    expect(screen.getByRole('listbox')).toBeInTheDocument()
    fireEvent.scroll(screen.getByRole('listbox'))
    expect(screen.getByRole('listbox')).toBeInTheDocument() // scrolling the list itself keeps it open
    fireEvent(window, new Event('resize'))
    expect(screen.getByRole('listbox')).toBeInTheDocument()
    fireEvent.pointerDown(screen.getByText('other'))
    expect(screen.queryByRole('listbox')).toBeNull()
    await userEvent.click(box())
    fireEvent.scroll(document)
    expect(screen.queryByRole('listbox')).toBeNull()
  })
  it('opens upward when there is no room below', async () => {
    render(<Host />)
    const rect = { left: 900, right: 1000, top: 700, bottom: 730, width: 100, height: 30, x: 900, y: 700, toJSON() {} }
    vi.spyOn(box(), 'getBoundingClientRect').mockReturnValue(rect as DOMRect)
    await userEvent.click(box())
    const list = screen.getByRole('listbox')
    expect(list.style.bottom).toBe(`${innerHeight - 700 + 4}px`)
    expect(list.style.top).toBe('')
    // never off the right edge, never narrower than is readable
    expect(list.style.width).toBe('168px')
    expect(parseFloat(list.style.left)).toBe(innerWidth - 168 - 8)
  })
  it('opens downward by default', async () => {
    render(<Host />)
    await userEvent.click(box())
    expect(screen.getByRole('listbox').style.top).toBe('4px')
  })
})
