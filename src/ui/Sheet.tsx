import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { animateView, chrome, fitView, headedTo, reveal } from '../canvas/camera'
import { useBackLayer } from '../core/nav'
import { type View, useStore } from '../core/store'

/** Frame the whole diagram and say where the view will end up. */
function frameAll(): View | null {
  const before = useStore.getState().view
  fitView(undefined, false)
  const to = useStore.getState().view
  useStore.setState({ view: before })
  if (Math.abs(to.x - before.x) < 1 && Math.abs(to.y - before.y) < 1 && Math.abs(to.k - before.k) < 0.001) return null
  animateView(to)
  return to
}

/**
 * A bottom sheet for phones: it rises over the canvas, can be pulled taller or
 * flicked away, and leaves the canvas above it live. Held sideways, the same
 * sheet docks to the right edge instead (that is CSS; the behaviour is shared).
 *
 * Only the header drags the sheet. The content scrolls on its own, so a scroll
 * is never mistaken for a dismissal.
 */
export function Sheet({ label, title, onClose, children, startTall, roomy }: {
  label: string; title?: ReactNode; onClose: () => void; children: ReactNode; startTall?: boolean
  /** opens at two thirds of the screen rather than half: for content that is mostly a long list */
  roomy?: boolean
}) {
  const [tall, setTall] = useState(!!startTall)
  const el = useRef<HTMLElement>(null)
  const drag = useRef<{ y: number; dy: number; t: number; id: number; control: boolean; held: boolean } | null>(null)

  // where the view was before the sheet moved it, and where the sheet put it
  const moved = useRef<{ from: View; to: View } | null>(null)

  // tell the camera how much of the canvas is covered, and bring the selection back into view
  useLayoutEffect(() => {
    const measure = () => {
      const r = el.current!.getBoundingClientRect()
      // upright the sheet spans the screen along the bottom; sideways it is a column down the right edge
      const side = r.width < innerWidth * 0.7
      chrome.bottom = side ? 0 : r.height
      chrome.right = side ? r.width : 0
    }
    measure()
    const t = setTimeout(() => {
      measure()
      const st = useStore.getState()
      const ids = st.doc.nodes.filter((n) => st.selection.includes(n.id)).map((n) => n.id)
      // with something selected, slide it into sight at the zoom the user chose, and only if the sheet
      // hides it; with nothing selected, re-frame the whole diagram in the room that is left
      const to = ids.length ? reveal(ids) : frameAll()
      if (to) moved.current = { from: moved.current?.from ?? st.view, to }
    }, 60)
    window.addEventListener('resize', measure)
    return () => { clearTimeout(t); window.removeEventListener('resize', measure); chrome.bottom = 0; chrome.right = 0 }
  }, [tall])

  // the phone's Back button puts the sheet away before it leaves the page
  useBackLayer(true, onClose)

  // putting the sheet away puts the view back, unless the user has moved it since
  useEffect(() => () => {
    // a sheet put away while the view is still gliding to make room for it counts as not moved: judge by where the glide was going
    const m = moved.current, v = headedTo() ?? useStore.getState().view
    if (m && Math.abs(v.x - m.to.x) < 1 && Math.abs(v.y - m.to.y) < 1 && Math.abs(v.k - m.to.k) < 0.001) animateView(m.from, 320)
  }, [])

  // a field taking focus means typing: give the content all the room there is, and hand it back when the typing is over
  const grew = useRef(false)
  useEffect(() => {
    const field = (t: EventTarget | null) => /INPUT|TEXTAREA/.test((t as HTMLElement | null)?.tagName ?? '')
    const grow = (e: FocusEvent) => { if (field(e.target)) setTall((t) => { if (!t) grew.current = true; return true }) }
    const shrink = (e: FocusEvent) => {
      // moving from one field to the next is still typing
      if (!field(e.target) || field(e.relatedTarget) || !grew.current) return
      grew.current = false
      setTall(false)
    }
    const node = el.current!
    node.addEventListener('focusin', grow)
    node.addEventListener('focusout', shrink)
    return () => { node.removeEventListener('focusin', grow); node.removeEventListener('focusout', shrink) }
  }, [])

  const settle = () => { if (el.current) { el.current.style.transition = ''; el.current.style.transform = '' } }
  const hold = (e: React.PointerEvent, d: NonNullable<typeof drag.current>) => {
    d.held = true
    try { e.currentTarget.setPointerCapture(d.id) } catch { /* pointer already gone */ }
    el.current!.style.transition = 'none'
  }
  const down = (e: React.PointerEvent) => {
    // the whole header drags, tabs and all: a control only takes the pointer back if the finger never travels
    const control = !!(e.target as HTMLElement).closest('button, input, [role=tab], [role=radio]')
    drag.current = { y: e.clientY, dy: 0, t: performance.now(), id: e.pointerId, control, held: false }
    if (!control) hold(e, drag.current)
  }
  const move = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d) return
    d.dy = e.clientY - d.y
    if (!d.held) { if (Math.abs(d.dy) < 8) return; hold(e, d) }
    // follows the finger down; resists being pulled up past its tallest
    el.current!.style.transform = `translateY(${d.dy > 0 ? d.dy : tall ? d.dy / 6 : d.dy / 2}px)`
  }
  const up = () => {
    const d = drag.current
    drag.current = null
    if (!d) return
    settle()
    const fast = Math.abs(d.dy) / Math.max(1, performance.now() - d.t) > 0.6
    if (!d.held) return // a plain tap on a tab or the close button: theirs to handle
    grew.current = false // from here the height is the user's choice
    if (Math.abs(d.dy) < 6) setTall((t) => !t) // a tap on the handle toggles the height
    // a pull down steps a tall sheet back to half height; a long pull or a flick sends it away
    else if (d.dy > (fast ? 30 : 110)) { if (tall && !fast && d.dy < 300) setTall(false); else onClose() }
    else if (d.dy < (fast ? -20 : -50)) setTall(true)
  }

  return (
    <section ref={el} className={'sheet' + (roomy ? ' roomy' : '') + (tall ? ' tall' : '')} role="dialog" aria-label={label}>
      <header className="sheet-head" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
        <i className="sheet-grip" aria-hidden="true" />
        <div className="sheet-title">{title}</div>
        <button className="icon-btn" aria-label={'Close ' + label.toLowerCase()} onClick={onClose}><X size={16} /></button>
      </header>
      <div className="sheet-body">{children}</div>
    </section>
  )
}
