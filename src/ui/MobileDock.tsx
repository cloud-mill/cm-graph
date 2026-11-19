import { useEffect, useState } from 'react'
import { ArrowLeftRight, Box, Check, Copy, Ellipsis, Group, Layers, ListChecks, LocateFixed, Maximize2, Navigation2, Plus, Scan, SlidersHorizontal, SquareDashed, Trash2, Type, Waypoints, X } from 'lucide-react'
import { fitView, inSight, isTurned, recover, setFlat } from '../canvas/camera'
import { costOf, defOf, defaultProps, money, nodeName } from '../core/catalog'
import { useStore } from '../core/store'
import { fitAreaToContents, wrapSelectionInArea } from './actions'
import { haptic } from './device'

function Slot({ label, onClick, children, on, danger, primary }: { label: string; onClick: () => void; children: React.ReactNode; on?: boolean; danger?: boolean; primary?: boolean }) {
  return (
    <button className={'dock-btn' + (on ? ' on' : '') + (danger ? ' danger' : '') + (primary ? ' primary' : '')} aria-label={label} aria-pressed={on} onClick={() => { haptic(4); onClick() }}>
      {children}<span>{label}</span>
    </button>
  )
}

const HINTS: Record<string, string> = {
  connect: 'Tap a component, then the one it talks to',
  area: 'Drag across the ground to draw an area',
  text: 'Tap where the label should go',
  orbit: 'Drag to orbit the view',
}

/**
 * The phone's control strip, in the thumb's reach. It is one bar with three
 * faces: tools when nothing is selected, a prompt while a tool is in use, and
 * the actions for whatever is selected. Nothing else on the screen needs both hands.
 */
export function MobileDock() {
  const doc = useStore((s) => s.doc)
  const selection = useStore((s) => s.selection)
  const tool = useStore((s) => s.tool)
  const linkFrom = useStore((s) => s.linkFrom)
  const multi = useStore((s) => s.multi)
  const pricing = useStore((s) => s.pricing)
  const s = useStore.getState()
  const open = (what: 'lib' | 'insp') => s.set(what === 'lib' ? { showLib: true, showInsp: false } : { showInsp: true, showLib: false, panel: 'inspect' })

  const nodes = doc.nodes.filter((n) => selection.includes(n.id))
  const edges = doc.edges.filter((e) => selection.includes(e.id))
  const areas = doc.areas.filter((a) => selection.includes(a.id))
  const labels = doc.labels.filter((l) => selection.includes(l.id))
  const count = nodes.length + edges.length + areas.length + labels.length

  if (tool !== 'select') {
    const from = linkFrom ? doc.nodes.find((n) => n.id === linkFrom) : null
    return (
      <nav className="dock prompt" aria-label="Tool">
        <div className="dock-card">
          <span className="dock-hint" role="status">{from ? <>Now tap what <b>{nodeName(from)}</b> connects to</> : HINTS[tool]}</span>
          <button className="btn sm" onClick={() => s.set({ tool: 'select', linkFrom: null })}><X size={14} />Cancel</button>
        </div>
      </nav>
    )
  }

  if (count) {
    const one = count === 1
    const n = one ? nodes[0] : null
    const title = n ? nodeName(n) : one && edges[0] ? 'Connection' : one && areas[0] ? areas[0].name : one && labels[0] ? labels[0].text.split('\n')[0] : `${count} selected`
    const d = n ? defOf(n.type) : null
    const sub = n ? d!.summary?.({ ...defaultProps(n.type), ...n.props }) ?? d!.svc : one && edges[0] ? 'Line between components' : one && areas[0] ? `Area · ${areas[0].w} × ${areas[0].d}` : one && labels[0] ? 'Text label' : [nodes.length && `${nodes.length} components`, areas.length && `${areas.length} areas`, labels.length && `${labels.length} labels`, edges.length && `${edges.length} connections`].filter(Boolean).join(' · ')
    const total = nodes.reduce((t, x) => t + costOf(x, doc.region, pricing).monthly, 0)
    return (
      <nav className="dock selected" aria-label="Selection">
        <div className="dock-card">
        <div className="dock-info">
          <span className="dock-name"><b>{title}</b><i>{sub}</i></span>
          {total > 0 && <em className="mono">{money(total)}<small>/mo</small></em>}
          <button className="icon-btn" aria-label="Deselect" onClick={() => { s.select([]); s.set({ multi: false }) }}><X size={16} /></button>
        </div>
        <div className="dock-row">
          <Slot label="Edit" onClick={() => open('insp')}><SlidersHorizontal size={18} /></Slot>
          {n && <Slot label="Connect" onClick={() => s.set({ tool: 'connect', linkFrom: n.id })}><Waypoints size={18} /></Slot>}
          {one && edges[0] && <Slot label="Reverse" onClick={() => s.apply((x) => ({ ...x, edges: x.edges.map((e) => (e.id === edges[0].id ? { ...e, from: e.to, to: e.from } : e)) }))}><ArrowLeftRight size={18} /></Slot>}
          {one && areas[0] && <Slot label="Fit" onClick={() => fitAreaToContents(areas[0].id)}><Maximize2 size={18} /></Slot>}
          {nodes.length > 1 && <Slot label="Group" onClick={() => { wrapSelectionInArea(); s.set({ multi: false }) }}><Group size={18} /></Slot>}
          {!edges.length && <Slot label="Copy" onClick={() => s.duplicate(selection)}><Copy size={18} /></Slot>}
          {nodes.length > 0 && <Slot label={multi ? 'Done' : 'More'} on={multi} onClick={() => s.set({ multi: !multi })}>{multi ? <Check size={18} /> : <ListChecks size={18} />}</Slot>}
          <Slot label="Delete" danger onClick={() => { s.remove(selection); s.set({ multi: false }) }}><Trash2 size={18} /></Slot>
        </div>
        </div>
      </nav>
    )
  }

  return (
    <nav className="dock" aria-label="Tools">
      <div className="dock-row">
        <Slot label="Connect" onClick={() => s.set({ tool: 'connect', placing: null })}><Waypoints size={19} /></Slot>
        <Slot label="Area" onClick={() => s.set({ tool: 'area', placing: null })}><SquareDashed size={19} /></Slot>
        <Slot label="Add" primary onClick={() => open('lib')}><Plus size={22} /></Slot>
        <Slot label="Text" onClick={() => s.set({ tool: 'text', placing: null })}><Type size={19} /></Slot>
        <Slot label="Menu" onClick={() => s.set({ modal: 'command' })}><Ellipsis size={19} /></Slot>
      </div>
    </nav>
  )
}

/**
 * View controls that float above the dock. The first two only appear when they are
 * wanted: a way back when the diagram has slid out of sight, and a compass once the
 * camera has been turned, pointing the way home and taking you there with a tap.
 */
export function ViewFabs() {
  const flat = useStore((s) => s.flat)
  const yaw = useStore((s) => s.yaw)
  const pitch = useStore((s) => s.pitch)
  const view = useStore((s) => s.view)
  const doc = useStore((s) => s.doc)
  const [lost, setLost] = useState(false)
  // checked once the camera has been still for a moment, not on every frame of a drag
  useEffect(() => { const t = setTimeout(() => setLost(!inSight()), 260); return () => clearTimeout(t) }, [view, yaw, pitch, doc])
  const turned = isTurned(yaw, pitch)
  return (
    <div className="fabs">
      {lost && <button className="fab wide" onClick={() => { haptic(4); recover() }}><LocateFixed size={16} />Back to diagram</button>}
      {turned && (
        <button className="fab" aria-label="Reset view" onClick={() => { haptic(4); recover() }}>
          <Navigation2 size={17} style={{ transform: `rotate(${45 - yaw}deg) scaleY(${0.55 + 0.45 * Math.sin((pitch * Math.PI) / 180)})` }} />
        </button>
      )}
      <button className="fab" aria-label={flat ? 'Switch to 3D view' : 'Switch to plan view'} onClick={() => { haptic(4); setFlat(!flat) }}>{flat ? <Box size={17} /> : <Layers size={17} />}</button>
      <button className="fab" aria-label="Fit to screen" onClick={() => { haptic(4); fitView() }}><Scan size={17} /></button>
    </div>
  )
}

const GESTURES: [string, string, React.ReactNode][] = [
  ['Move', 'Drag with one finger', <><circle cx="14" cy="20" r="5" /><path d="M22 20h14m-5-5 5 5-5 5" /></>],
  ['Zoom', 'Pinch, or double tap and slide', <><circle cx="12" cy="28" r="4.5" /><circle cx="28" cy="12" r="4.5" /><path d="M5 35l-0 -5m0 5h5M35 5v5m0-5h-5" /><path d="M8.5 31.5 5 35M31.5 8.5 35 5" /></>],
  ['Turn', 'Twist two fingers', <><circle cx="11" cy="26" r="4.5" /><circle cx="29" cy="14" r="4.5" /><path d="M8 13a14 14 0 0 1 11-6m-4-3 4 3-3 4M32 27a14 14 0 0 1-11 6m4 3-4-3 3-4" /></>],
  ['Tilt', 'Slide two fingers up or down', <><circle cx="12" cy="24" r="4.5" /><circle cx="28" cy="24" r="4.5" /><path d="M12 15V6m-3 3 3-3 3 3M28 15V6m-3 3 3-3 3 3" /></>],
]

/** The four camera gestures, drawn rather than described. Shown once, and again from the menu. */
export function GestureGuide({ onClose }: { onClose: () => void }) {
  return (
    <div className="gestures" role="dialog" aria-label="Getting around">
      <div className="gestures-row">
        {GESTURES.map(([name, how, art]) => (
          <div className="gesture" key={name}>
            <svg viewBox="0 0 40 40" width={40} height={40} fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden>{art}</svg>
            <b>{name}</b><span>{how}</span>
          </div>
        ))}
      </div>
      <p>Drag the cube in the corner to orbit with one thumb. Tap its faces for standard views.</p>
      <button className="btn sm primary" onClick={onClose}>Got it</button>
    </div>
  )
}
