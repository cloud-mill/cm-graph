// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { watchHistory } from '../core/nav'
import { resetStore } from '../test/helpers'
import { COARSE, stubMedia } from '../test/media'
import { QuickAdd } from './QuickAdd'

const show = (provider: 'aws' | 'gcp' | 'azure' = 'aws') => {
  resetStore({ provider })
  const onPick = vi.fn<(type: string) => void>(), onClose = vi.fn<() => void>()
  render(<QuickAdd x={40} y={60} onPick={onPick} onClose={onClose} />)
  return { onPick, onClose, input: screen.getByRole('combobox', { name: 'Search components' }), options: () => screen.queryAllByRole('option') }
}
beforeEach(() => { history.replaceState(null, '', '#/') })
afterEach(() => vi.unstubAllGlobals())

describe('QuickAdd', () => {
  it('opens ready to type, offering the usual next components for the cloud in use', () => {
    const { input, options } = show()
    expect(input).toHaveFocus()
    expect(options().map((o) => o.textContent)).toEqual(expect.arrayContaining([expect.stringContaining('EC2'), expect.stringContaining('Lambda'), expect.stringContaining('S3')]))
    expect(options()[0]).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('dialog', { name: 'Add and connect a component' })).toHaveStyle({ left: '40px', top: '60px' })
  })
  it('offers the same roles on another cloud', () => {
    const { options } = show('gcp')
    expect(options().length).toBeGreaterThan(3)
    expect(options().every((o) => !o.textContent!.includes('AWS'))).toBe(true)
  })
  it('searches every cloud as you type, names that start with it first and this cloud before the others', async () => {
    const { input, options } = show()
    await userEvent.type(input, 'queue')
    expect(options().length).toBeGreaterThan(1)
    expect(options()[0]).toHaveTextContent(/Queue.*SQS/)
    expect(options().some((o) => /GCP|Azure/.test(o.textContent!))).toBe(true)
    expect(options().length).toBeLessThanOrEqual(7)
  })
  it('Enter picks the highlighted one; the arrows move the highlight and stop at the ends', async () => {
    const { input, onPick, options } = show()
    await userEvent.type(input, '{ArrowUp}{ArrowDown}{ArrowDown}')
    expect(options()[2]).toHaveAttribute('aria-selected', 'true')
    await userEvent.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}')
    expect(options().at(-1)).toHaveAttribute('aria-selected', 'true')
    await userEvent.keyboard('{Enter}')
    expect(onPick).toHaveBeenCalledTimes(1)
    expect(typeof onPick.mock.calls[0][0]).toBe('string')
  })
  it('a click picks, and the row under the pointer is the highlighted one', async () => {
    const { onPick, options } = show()
    await userEvent.hover(options()[3])
    expect(options()[3]).toHaveAttribute('aria-selected', 'true')
    await userEvent.click(options()[1])
    expect(onPick).toHaveBeenCalledWith('lambda')
  })
  it('says so when nothing matches, and Enter then picks nothing', async () => {
    const { input, onPick } = show()
    await userEvent.type(input, 'zzzzqq{Enter}')
    expect(screen.getByText('Nothing matches. Try another name.')).toBeInTheDocument()
    expect(onPick).not.toHaveBeenCalled()
  })
  it('Escape closes it, from the search or from a row, and the key goes no further', async () => {
    const { input, onClose, options } = show()
    const outer = vi.fn<(e: KeyboardEvent) => void>()
    window.addEventListener('keydown', outer)
    await userEvent.type(input, '{Escape}')
    options()[0].focus()
    await userEvent.keyboard('{Escape}')
    await userEvent.keyboard('a') // any other key on a row is left alone
    expect(onClose).toHaveBeenCalledTimes(2)
    expect(outer.mock.calls.filter(([e]) => e.key === 'Escape')).toHaveLength(0)
    window.removeEventListener('keydown', outer)
  })
  it('a press anywhere outside closes it; a press inside does not', () => {
    const { input, onClose } = show()
    fireEvent.pointerDown(input)
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.pointerDown(document.body)
    expect(onClose).toHaveBeenCalledTimes(1)
  })
  it('on a touch screen it does not throw the keyboard up: the choices are there to tap', () => {
    stubMedia(COARSE)
    const { input } = show()
    expect(input).not.toHaveFocus()
  })
  it('the Back button closes it', async () => {
    const stop = watchHistory()
    const { onClose } = show()
    await Promise.resolve()
    history.back()
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled())
    stop()
  })
})
