import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { chrome, fitView } from '../canvas/camera'
import { useStore } from '../core/store'

/**
 * A bottom sheet for phones: it rises over the canvas, can be pulled taller or
 * flicked away, and leaves the canvas above it live. Held sideways, the same
 * sheet docks to the right edge instead (that is CSS; the behaviour is shared).
 *
 * Only the header drags the sheet. The content scrolls on its own, so a scroll
 * is never mistaken for a dismissal.
 */
export function Sheet({ label, title, onClose, children, startTall }: {
  label: string; title?: ReactNode; onClose: () => void; children: ReactNode; startTall?: boolean
}) {
  const [tall, setTall] = useState(!!startTall)
  const el = useRef<HTMLElement>(null)
  const drag = useRef<{ y: number; dy: number; t: number; id: number; control: boolean; held: boolean } | null>(null)

  // tell the camera how much of the canvas is covered, and bring the selection back into view
  useLayoutEffect(() => {
    const measure = () => {
      const r = el.current!.getBoundingClientRect()
      const side = r.height >= innerHeight * 0.9 && r.width < innerWidth * 0.7
      chrome.bottom = side ? 0 : r.height
      chrome.right = side ? r.width : 0
    }
    measure()
    const sel = useStore.getState().selection
    const ids = useStore.getState().doc.nodes.filter((n) => sel.includes(n.id)).map((n) => n.id)
    // with something selected, keep it in sight at the zoom the user chose; otherwise re-frame the whole diagram in the room left
    const t = setTimeout(() => { measure(); if (ids.length) fitView(ids, true, useStore.getState().view.k); else fitView() }, 60)
    window.addEventListener('resize', measure)
    return () => { clearTimeout(t); window.removeEventListener('resize', measure); chrome.bottom = 0; chrome.right = 0 }
  }, [tall])

  // a field taking focus means typing: give the content all the room there is
  useEffect(() => {
    const grow = (e: FocusEvent) => { if (/INPUT|TEXTAREA/.test((e.target as HTMLElement).tagName)) setTall(true) }
    const node = el.current!
    node.addEventListener('focusin', grow)
    return () => node.removeEventListener('focusin', grow)
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
    if (Math.abs(d.dy) < 6) setTall((t) => !t) // a tap on the handle toggles the height
    // a pull down steps a tall sheet back to half height; a long pull or a flick sends it away
    else if (d.dy > (fast ? 30 : 110)) { if (tall && !fast && d.dy < 300) setTall(false); else onClose() }
    else if (d.dy < (fast ? -20 : -50)) setTall(true)
  }

  return (
    <section ref={el} className={'sheet' + (tall ? ' tall' : '')} role="dialog" aria-label={label}>
      <header className="sheet-head" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
        <i className="sheet-grip" aria-hidden="true" />
        <div className="sheet-title">{title}</div>
        <button className="icon-btn" aria-label={'Close ' + label.toLowerCase()} onClick={onClose}><X size={16} /></button>
      </header>
      <div className="sheet-body">{children}</div>
    </section>
  )
}
