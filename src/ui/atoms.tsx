import { type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronsUpDown, X } from 'lucide-react'
import { useBackLayer } from '../core/nav'
import { useStore } from '../core/store'

export function Segmented<T extends string>({ value, options, onChange, size }: {
  value: T
  options: { value: T; label: ReactNode; title?: string; disabled?: boolean }[]
  onChange: (v: T) => void
  size?: 'sm'
}) {
  return (
    <div className={'seg' + (size === 'sm' ? ' seg-sm' : '')} role="radiogroup">
      {options.map((o) => (
        <button key={o.value} role="radio" aria-checked={o.value === value} className={o.value === value ? 'on' : ''} title={o.title} disabled={o.disabled} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

/** Keyboard activation for elements that act as buttons: Enter and Space, as a real button has. */
export const onActivate = (run: () => void) => (e: React.KeyboardEvent) => {
  if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); run() }
}

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
/** Shortcut labels are written with Mac symbols; everywhere else they read as words. */
export const keys = (s: string) => isMac ? s : s.replace(/⇧⌘/g, 'Ctrl+Shift+').replace(/⌘/g, 'Ctrl+').replace(/⌥/g, 'Alt').replace(/⇧/g, 'Shift').replace(/⌫/g, 'Del')

export function IconBtn({ title, onClick, active, disabled, children, kbd }: {
  title: string; onClick?: () => void; active?: boolean; disabled?: boolean; children: ReactNode; kbd?: string
}) {
  return (
    <button className={'icon-btn' + (active ? ' on' : '')} onClick={onClick} disabled={disabled} aria-label={title} aria-pressed={active}>
      {children}
      <span className="tip" role="tooltip">{title}{kbd && <kbd>{keys(kbd)}</kbd>}</span>
    </button>
  )
}

export function Modal({ title, subtitle, onClose, children, width = 560, footer }: {
  title: string; subtitle?: string; onClose: () => void; children: ReactNode; width?: number; footer?: ReactNode
}) {
  // subscribed once, so a re-render during the key event cannot drop the listener
  const closeRef = useRef(onClose)
  useLayoutEffect(() => { closeRef.current = onClose })
  // the phone's Back button closes a dialog before it leaves the page
  useBackLayer(true, onClose)
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); closeRef.current() } }
    window.addEventListener('keydown', k, true)
    return () => window.removeEventListener('keydown', k, true)
  }, [])
  return (
    <div className="scrim" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ width }} role="dialog" aria-label={title}>
        <header>
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer>{footer}</footer>}
      </div>
    </div>
  )
}

let handledFocus = 0
let focusAskedAt = -Infinity
/** True for a moment after a field was asked to take focus, so typing meant for it is not read as shortcuts. */
export const focusPending = () => performance.now() - focusAskedAt < 250
let typedAhead = ''
/** Keep what was typed before the field was ready; it is entered as soon as focus lands. */
export const typeAhead = (ch: string) => { typedAhead += ch }
// the request is noted the instant it is made, before React has rendered the field
useStore.subscribe((s, prev) => { if (s.focusName !== prev.focusName) { focusAskedAt = performance.now(); typedAhead = '' } })

/** Text input that keeps local state while typing so external updates don't fight the caret. */
export function TextInput({ value, onChange, placeholder, className, autoFocusKey, multiline, mono, label, list, inputMode }: {
  value: string; onChange: (v: string) => void; placeholder?: string; className?: string; autoFocusKey?: number; multiline?: boolean; mono?: boolean; label: string
  /** id of a list of suggestions */
  list?: string; inputMode?: 'text' | 'numeric'
}) {
  const ref = useRef<any>(null)
  useEffect(() => {
    // focus once per request, and after the pointer event that caused it has settled
    if (!autoFocusKey || autoFocusKey === handledFocus) return
    const t = setTimeout(() => {
      handledFocus = autoFocusKey; focusAskedAt = -Infinity
      ref.current?.focus(); ref.current?.select()
      if (typedAhead) { document.execCommand('insertText', false, typedAhead); typedAhead = '' }
    }, 30)
    return () => clearTimeout(t)
  }, [autoFocusKey])
  const props = {
    ref, value, placeholder, 'aria-label': label, className: 'input ' + (mono ? 'mono ' : '') + (className ?? ''),
    onChange: (e: any) => onChange(e.target.value),
    onKeyDown: (e: any) => { if (e.key === 'Escape' || (e.key === 'Enter' && !multiline)) e.currentTarget.blur() },
    spellCheck: false,
  }
  return multiline ? <textarea rows={3} {...props} /> : <input {...props} list={list} inputMode={inputMode} />
}

export function NumberInput({ value, onChange, min = 0, max = 1e7, step = 1, unit, label }: {
  value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number; unit?: string; label: string
}) {
  const [text, setText] = useState(String(value))
  const focused = useRef(false)
  useEffect(() => { if (!focused.current) setText(String(value)) }, [value])
  const commit = (raw: string) => {
    let v = parseFloat(raw)
    if (isNaN(v)) return
    v = Math.max(min, max != null ? Math.min(max, v) : v)
    if (v !== value) onChange(v)
  }
  return (
    <div className="num">
      <input className="input" inputMode="decimal" value={text} aria-label={label}
        onFocus={(e) => { focused.current = true; e.currentTarget.select() }}
        onBlur={() => { focused.current = false; setText(String(value)) }}
        onChange={(e) => { setText(e.target.value); commit(e.target.value) }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault()
            const s = (e.shiftKey ? 10 : 1) * step * (e.key === 'ArrowUp' ? 1 : -1)
            const v = Math.max(min, max != null ? Math.min(max, value + s) : value + s)
            const r = Math.round(v * 1000) / 1000
            setText(String(r)); onChange(r)
          } else if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur()
        }} />
      {unit && <span className="unit">{unit}</span>}
    </div>
  )
}

export const SWATCHES = ['#F2903A', '#E8A33D', '#3DB87F', '#2BB5D4', '#4F7FF2', '#8F6FF2', '#E85C9C', '#E5574F', '#8792A8', '#566178']

export function Swatches({ value, onChange, allowReset, mixed }: { value?: string; onChange: (c: string | undefined) => void; allowReset?: boolean; /** the selection has several colours, so none is marked */ mixed?: boolean }) {
  return (
    <div className="swatches">
      {allowReset && <button className={'swatch reset' + (!value && !mixed ? ' on' : '')} onClick={() => onChange(undefined)} title="Default colour" aria-label="Default colour" />}
      {SWATCHES.map((c) => (
        <button key={c} className={'swatch' + (value?.toLowerCase() === c.toLowerCase() ? ' on' : '')} style={{ background: c }} onClick={() => onChange(c)} aria-label={c} />
      ))}
    </div>
  )
}

export function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="row">
      <span className="row-label">{label}</span>
      <span className="row-ctl">{children}</span>
    </div>
  )
}

export function Toggle({ value, onChange, label }: { value: boolean; onChange: (v: boolean) => void; label: string }) {
  return <button role="switch" aria-checked={value} aria-label={label} className={'toggle' + (value ? ' on' : '')} onClick={(e) => { e.preventDefault(); onChange(!value) }}><i /></button>
}

/** Eases a displayed number towards its target, so totals tick instead of snapping. */
export function useTween(value: number, ms = 420) {
  const [v, setV] = useState(value)
  const from = useRef(value)
  useEffect(() => {
    const start = from.current
    if (start === value) return
    const t0 = performance.now()
    let raf = 0
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / ms)
      const e = 1 - Math.pow(1 - t, 3)
      const cur = start + (value - start) * e
      from.current = cur
      setV(cur)
      if (t < 1) raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [value, ms])
  return v
}

/**
 * A dropdown drawn by the app rather than the operating system, so it looks the
 * same everywhere and matches both themes. Behaves like a native select:
 * arrows, Home/End, Enter, Escape and typing a letter all work.
 */
export function Select<T extends string>({ value, options, onChange, label, className }: {
  value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label?: string; className?: string
}) {
  const [open, setOpen] = useState(false)
  useBackLayer(open, () => setOpen(false))
  const [active, setActive] = useState(0)
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number; width: number; maxHeight: number } | null>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const id = useId()
  const current = options.find((o) => o.value === value)

  const show = () => {
    setActive(Math.max(0, options.findIndex((o) => o.value === value)))
    setOpen(true)
  }
  const pick = (i: number) => {
    const o = options[i]
    if (o && o.value !== value) onChange(o.value)
    setOpen(false)
    trigger.current?.focus()
  }

  // place the list under the field, or above it when there is more room there
  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      const r = trigger.current!.getBoundingClientRect()
      const below = innerHeight - r.bottom - 12, above = r.top - 12
      const want = Math.min(380, options.length * 30 + 10)
      const up = below < Math.min(want, 160) && above > below
      const width = Math.max(r.width, 168)
      setPos({
        left: Math.max(8, Math.min(r.left, innerWidth - width - 8)), width,
        ...(up ? { bottom: innerHeight - r.top + 4 } : { top: r.bottom + 4 }),
        maxHeight: Math.max(120, Math.min(380, up ? above : below)),
      })
    }
    place()
    const away = (e: PointerEvent) => { if (!list.current?.contains(e.target as Node) && !trigger.current?.contains(e.target as Node)) setOpen(false) }
    const close = (e: Event) => { if (!list.current?.contains(e.target as Node)) setOpen(false) }
    window.addEventListener('resize', place)
    window.addEventListener('scroll', close, true)
    window.addEventListener('pointerdown', away, true)
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', close, true); window.removeEventListener('pointerdown', away, true) }
  }, [open, options.length])

  useEffect(() => { if (open) list.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' }) }, [open, active])

  const onKey = (e: React.KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey) return // undo, save and the rest still work while a dropdown has focus
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) { e.preventDefault(); e.stopPropagation(); show() }
      return
    }
    e.stopPropagation() // while the list is open, keys belong to it rather than to canvas shortcuts
    const n = options.length
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => (a + 1) % n) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => (a - 1 + n) % n) }
    else if (e.key === 'Home') { e.preventDefault(); setActive(0) }
    else if (e.key === 'End') { e.preventDefault(); setActive(n - 1) }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(active) }
    else if (e.key === 'Escape' || e.key === 'Tab') { if (e.key === 'Escape') e.preventDefault(); setOpen(false) }
    else if (e.key.length === 1) {
      const k = e.key.toLowerCase()
      const from = (active + 1) % n
      const order = [...options.slice(from), ...options.slice(0, from)]
      const hit = order.find((o) => o.label.toLowerCase().startsWith(k))
      if (hit) setActive(options.indexOf(hit))
    }
  }

  return (
    <>
      <button ref={trigger} type="button" className={'input select ' + (className ?? '') + (open ? ' open' : '')} role="combobox" aria-haspopup="listbox"
        aria-expanded={open} aria-controls={id} aria-label={label} aria-activedescendant={open ? `${id}-${active}` : undefined} onClick={() => (open ? setOpen(false) : show())} onKeyDown={onKey}>
        <span>{current?.label ?? value}</span><ChevronsUpDown size={12} />
      </button>
      {open && pos && createPortal(
        <div ref={list} id={id} className="select-list" role="listbox" aria-label={label} style={pos}>
          {options.map((o, i) => (
            // keys are handled by the combobox button, which keeps focus while the list is open
            // oxlint-disable-next-line jsx-a11y/click-events-have-key-events
            <div key={o.value} id={`${id}-${i}`} role="option" tabIndex={-1} aria-selected={o.value === value} data-active={i === active}
              className={'select-item' + (i === active ? ' active' : '')} onPointerMove={(e) => { if ((e.movementX || e.movementY) && i !== active) setActive(i) }} onClick={() => pick(i)}>
              <span>{o.label}</span>{o.value === value && <Check size={13} />}
            </div>
          ))}
        </div>, document.body)}
    </>
  )
}
