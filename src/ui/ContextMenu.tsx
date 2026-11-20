import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { fitView } from '../canvas/camera'
import { keys } from './atoms'
import { useBackLayer } from '../core/nav'
import { useStore } from '../core/store'
import { fitAreaToContents, selectAll, tidy, wrapSelectionInArea } from './actions'

export interface MenuState {
  x: number
  y: number
  wx: number
  wy: number
  target: 'node' | 'edge' | 'area' | 'label' | null
}

type Item = { label: string; kbd?: string; run: () => void; danger?: boolean } | 'sep'

export function ContextMenu({ menu, onClose }: { menu: MenuState; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x: menu.x, y: menu.y })
  const s = useStore.getState()
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
      const shaped = s.doc.edges.some((e) => sel.includes(e.id) && (e.via?.length || e.fromSide || e.toSide))
      items.push({ label: 'Follow the flow', run: () => s.set({ trace: sel[0] }) }, { label: 'Reverse direction', run: () => s.reverseEdge(sel) })
      if (sel.length === 1) items.push({ label: 'Add a bend', run: () => { s.addBend(sel[0]) } })
      if (shaped) items.push({ label: 'Route automatically', run: () => s.resetRoute(sel) })
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
