import { type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronsUpDown, X } from 'lucide-react'
import { useBackLayer } from '../core/nav'
import { useStore } from '../core/store'

/*
 * The small controls every panel and dialog is built from. They hold no application state: each is
 * given a value and reports a change, and only keeps what belongs to the control itself (a half-typed
 * number, an open list). The one exception is the focus request further down, which listens to the store.
 */

/** Three stacked planes: the product is literally layers of infrastructure. */
export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden className="logo">
      <path d="M16 4.5 28 11 16 17.5 4 11z" fill="currentColor" />
      <path d="M4 16l12 6.5L28 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" opacity=".55" />
      <path d="M4 21l12 6.5L28 21" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" opacity=".25" />
    </svg>
  )
}

/** A row of mutually exclusive choices, announced as a radio group. */
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

/** Keyboard activation for elements that act as buttons: Enter and Space, as a real button has. Keys pressed on a real control nested inside are left to that control. */
export const onActivate = (run: () => void) => (e: React.KeyboardEvent) => {
  if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); run() }
}

/** Decides how shortcuts are written, not how they work: the handlers accept Cmd and Ctrl alike. */
export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
/** Shortcut labels are written with Mac symbols; everywhere else they read as words. */
export const keys = (s: string) => isMac ? s : s.replace(/⇧⌘/g, 'Ctrl+Shift+').replace(/⌘/g, 'Ctrl+').replace(/⌥/g, 'Alt').replace(/⇧/g, 'Shift').replace(/⌫/g, 'Del')

/** An icon-only button. `title` is its accessible name and its tooltip, which is a real element (not the `title` attribute) so the shortcut can be shown as a keycap. */
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

/**
 * A dialog over a scrim. It closes on Escape, on a press on the scrim itself, on its close button and
 * on the phone's Back button. Escape is heard in the capture phase and stopped there, so nothing
 * underneath (a field's own Escape, the editor's "cancel") also acts on the same key.
 *
 * It does not move focus into itself, keep Tab inside, or put focus back when it closes; a dialog
 * that needs a field focused does that itself.
 */
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

// ---- focus on request -----------------------------------------------------------
// "Rename this" can be asked from the canvas, a menu or the keyboard, and the field that should take
// focus may not exist yet (the inspector may be about to show a different thing). So the request is
// a counter in the store, `focusName`: whoever wants a rename adds one to it, and the name field of
// whatever the inspector shows next is given it as `autoFocusKey`. Between the request and the field
// taking focus, the editor's shortcut handler passes typed characters to `typeAhead` instead of
// running them as shortcuts, so "select, Enter, type" never loses its first letters.
// This is module state because the field that answers is not the component that was asked.

// the last request honoured: a name field that mounts later with the same number does not take focus again
let handledFocus = 0
let focusAskedAt = -Infinity
// fields that have been handed a request and have not taken focus yet
let answering = 0
/**
 * True from the moment a field is asked to take focus until it has, so typing meant for it is not read as shortcuts.
 * For a moment after the request on trust, and from then on for as long as a field is on its way to answering it:
 * however busy the page is, nothing typed in between is dropped.
 */
export const focusPending = () => answering > 0 || performance.now() - focusAskedAt < 250
let typedAhead = ''
/** Keep what was typed before the field was ready; it is entered as soon as focus lands. */
export const typeAhead = (ch: string) => { typedAhead += ch }
// the request is noted the instant it is made, before React has rendered the field
useStore.subscribe((s, prev) => { if (s.focusName !== prev.focusName) { focusAskedAt = performance.now(); typedAhead = '' } })

/**
 * A plain controlled text field: every keystroke is reported, and Escape or (on one line) Enter
 * leaves the field. `autoFocusKey` is the store's `focusName`: when it is a number not yet honoured,
 * the field takes focus, selects its text and enters whatever was typed ahead.
 */
export function TextInput({ value, onChange, placeholder, className, autoFocusKey, multiline, mono, label, list, inputMode }: {
  value: string; onChange: (v: string) => void; placeholder?: string; className?: string; autoFocusKey?: number; multiline?: boolean; mono?: boolean; label: string
  /** id of a list of suggestions */
  list?: string; inputMode?: 'text' | 'numeric'
}) {
  const ref = useRef<any>(null)
  // A layout effect, so the field is counted as answering before the next key can arrive: the render that hands it the
  // request is finished inside the event that made it
  useLayoutEffect(() => {
    // focus once per request, and after the pointer event that caused it has settled
    if (!autoFocusKey || autoFocusKey === handledFocus) return
    answering++
    let open = true
    const answered = () => { if (open) { open = false; answering-- } }
    const t = setTimeout(() => {
      answered()
      handledFocus = autoFocusKey; focusAskedAt = -Infinity
      ref.current?.focus(); ref.current?.select()
      if (typedAhead) { document.execCommand('insertText', false, typedAhead); typedAhead = '' }
    }, 30)
    return () => { clearTimeout(t); answered() }
  }, [autoFocusKey])
  const props = {
    ref, value, placeholder, 'aria-label': label, className: 'input ' + (mono ? 'mono ' : '') + (className ?? ''),
    onChange: (e: any) => onChange(e.target.value),
    onKeyDown: (e: any) => { if (e.key === 'Escape' || (e.key === 'Enter' && !multiline)) e.currentTarget.blur() },
    spellCheck: false,
  }
  return multiline ? <textarea rows={3} {...props} /> : <input {...props} list={list} inputMode={inputMode} />
}

/**
 * A number field that keeps its own text while it has focus, so a value half typed ("", "1.") is not
 * rewritten under the caret. Every keystroke that parses is reported at once, clamped to `min`..`max`;
 * the up and down arrows step by `step` (ten times that with Shift). On blur it shows the value it was given.
 */
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

/** The colours offered for components, areas, labels and connections. */
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

/** Eases a displayed number towards its target, so totals tick instead of snapping. A new target met mid-way starts from the number showing, not from the old target. */
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
 *
 * Focus never leaves the button: the list is announced through `aria-activedescendant`. The list is
 * drawn on the body and placed by hand in window coordinates, so the scrolling panel the field sits
 * in cannot clip it; in return it closes when anything outside it scrolls, since it would be left behind.
 * On a phone, Back closes it.
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

  // place the list under the field, or above it when there is more room there. A layout effect, so it is
  // placed before it is first painted; the same effect owns the window listeners that close or re-place it
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
            // keys are handled by the combobox button, which keeps focus while the list is open.
            // Only a pointer that really moved takes the highlight: a row sliding under a resting pointer as the list scrolls does not
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
