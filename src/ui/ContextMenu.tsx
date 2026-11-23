import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { fitView } from '../canvas/camera'
import { keys } from './atoms'
import { useBackLayer } from '../core/nav'
import { useStore } from '../core/store'
import { canReroute, isManual, kinked, straightness } from '../core/shape'
import { cleanLines, fitAreaToContents, selectAll, straightenLinks, tidy, wrapSelectionInArea } from './actions'

/**
 * Where a context menu was opened and on what. The canvas makes this (and holds it: the menu is open
 * while it is set), after selecting whatever was under the pointer, so the menu acts on the selection.
 */
export interface MenuState {
  /** where it was asked for, in window pixels */
  x: number
  y: number
  /** the same spot on the ground, in cells */
  wx: number
  wy: number
  /** the kind of thing under the pointer; null on empty ground */
  target: 'node' | 'edge' | 'area' | 'label' | null
}

type Item = { label: string; kbd?: string; run: () => void; danger?: boolean } | 'sep'

/**
 * The right-click (or press-and-hold) menu. Its items are worked out once, from the store as it is
 * when the menu opens: nothing can change under it, because any press outside it, Escape, Back or
 * choosing an item closes it.
 */
export function ContextMenu({ menu, onClose }: { menu: MenuState; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x: menu.x, y: menu.y })
  const s = useStore.getState()
  // measured after it is laid out and moved before it is painted, so it never shows hanging off the right or bottom edge
  useLayoutEffect(() => {
    const r = ref.current!.getBoundingClientRect()
    setPos({ x: Math.min(menu.x, innerWidth - r.width - 8), y: Math.min(menu.y, innerHeight - r.height - 8) })
  }, [menu])
  // subscribe once: another key handler may re-render the canvas mid-event, and a listener
  // swapped during dispatch would miss the very Escape it is waiting for
  const closeRef = useRef(onClose)
  useLayoutEffect(() => { closeRef.current = onClose })
  useBackLayer(true, onClose)
  useEffect(() => {
    const close = (e: Event) => { if (!ref.current?.contains(e.target as Node)) closeRef.current() }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') closeRef.current() }
    window.addEventListener('pointerdown', close, true)
    window.addEventListener('keydown', key, true)
    return () => { window.removeEventListener('pointerdown', close, true); window.removeEventListener('keydown', key, true) }
  }, [])

  const sel = s.selection
  const items: Item[] = []
  if (menu.target) {
    if (menu.target === 'edge') {
      const picked = s.doc.edges.filter((e) => sel.includes(e.id))
      // one that cannot be straight as things stand says what making it so will do
      const apart = picked.length === 1 && straightness(s.doc, picked[0]).state === 'apart'
      items.push({ label: apart ? 'Line up and straighten' : 'Straighten', run: () => straightenLinks(sel) })
      // a right-angled line can have a step put in it where the menu was opened, and be handed to the user or back to the router
      if (picked.length === 1 && !picked[0].shape) items.push({ label: 'Add a bend here', run: () => s.addBend(picked[0].id, [menu.wx, menu.wy]) })
      // offered only when there is one: a step in the line too small to have been meant
      if (picked.some((e) => kinked(s.doc, e))) items.push({ label: 'Clean up small kinks', run: () => cleanLines(sel) })
      if (picked.some((e) => !e.shape && !isManual(e))) items.push({ label: 'Keep this path', run: () => s.keepRoute(sel) })
      if (picked.some(canReroute)) items.push({ label: 'Route automatically', run: () => s.resetRoute(sel) })
      items.push({ label: 'Follow the flow', run: () => s.set({ trace: sel[0] }) }, { label: 'Reverse direction', run: () => s.reverseEdge(sel) })
    } else {
      items.push({ label: 'Duplicate', kbd: '⌘D', run: () => s.duplicate(sel) }, { label: 'Copy', kbd: '⌘C', run: () => s.copy() })
    }
    if (menu.target === 'node') {
      items.push({ label: 'Wrap in group', run: wrapSelectionInArea }, { label: 'Zoom to selection', run: () => fitView(sel) })
      if (sel.length === 1 && s.doc.edges.some((e) => e.from === sel[0] || e.to === sel[0])) items.push({ label: 'Follow the flow', run: () => s.set({ trace: sel[0] }) })
    }
    if (menu.target === 'area') items.push({ label: 'Fit to contents', run: () => fitAreaToContents(sel[0]) })
    items.push({ label: 'Edit properties', kbd: '↵', run: () => useStore.setState((st) => ({ panel: 'inspect', focusName: st.focusName + 1 })) })
    items.push('sep', { label: 'Delete', kbd: '⌫', danger: true, run: () => s.remove(sel) })
  } else {
    items.push(
      { label: 'Paste', kbd: '⌘V', run: () => s.paste() },
      { label: 'Add label here', kbd: 'T', run: () => { s.addLabel(Math.round(menu.wx), Math.round(menu.wy)); s.set({ panel: 'inspect' }) } },
      'sep',
      { label: 'Select all', kbd: '⌘A', run: selectAll },
      { label: 'Zoom to fit', kbd: 'F', run: () => fitView() },
      { label: 'Tidy layout', run: tidy },
    )
  }
  return (
    <div ref={ref} className="ctx-menu" style={{ left: pos.x, top: pos.y }} onContextMenu={(e) => e.preventDefault()}>
      {items.map((it, i) =>
        it === 'sep' ? <hr key={i} /> : (
          <button key={i} className={it.danger ? 'danger' : ''} onClick={() => { it.run(); onClose() }}>
            <span>{it.label}</span>
            {it.kbd && <kbd>{keys(it.kbd)}</kbd>}
          </button>
        ),
      )}
    </div>
  )
}
