import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  Activity, Box, ChevronLeft, Home, PanelLeft, PanelRight, Rotate3d, RotateCcw, RotateCw, CircleHelp, Command, Download, Grid3x3, History, Layers, LayoutGrid, Minus, Moon, MousePointer2,
  Plus, Redo2, Scan, Share2, SquareDashed, Sun, Tag, Type, Undo2, Upload, Waypoints, X, Magnet } from 'lucide-react'
import { Canvas } from '../canvas/Canvas'
import { animateView, beginOrbit, cam, fitView, followView, hud, orbitTo, setFlat, turn, viewHome, viewTop, zoomBy } from '../canvas/camera'
import { sceneBounds } from '../canvas/Scene'
import { analyze } from '../core/advisor'
import { docCost, money, nodeColor, nodeName } from '../core/catalog'
import { makeCam, normYaw, poly, pt, upright } from '../core/iso'
import { type Panel, type Tool, coalesce, enableAutosave, flushSave, useStore } from '../core/store'
import { getPref, loadDoc, setPref } from '../core/storage'
import { IconBtn, Logo, Segmented, useTween, focusPending, keys, typeAhead } from './atoms'
import { saveVersion, selectAll, tidy } from './actions'
import { AdvisorPanel } from './AdvisorPanel'
import { BudgetPanel } from './BudgetPanel'
import { CommandPalette } from './CommandPalette'
import { ExportDialog, HistoryDialog, ImportDialog, ShareDialog, ShortcutsDialog } from './Dialogs'
import { Inspector } from './Inspector'
import { CloudSeg, Palette } from './Palette'
import { footOf } from '../core/types'
import { MAX_K, MIN_K } from '../canvas/touch'
import { describe, traceFlow } from '../core/links'
import { goHome, navigate, useBackLayer } from '../core/nav'
import { usePhone } from './device'
import { GestureGuide, MobileDock, ViewFabs } from './MobileDock'
import { Sheet } from './Sheet'

/*
 * The editor screen: the canvas with everything that floats over it (top bar, toolbar, view cube,
 * read-outs, side panels or phone sheets, dialogs), the keyboard shortcuts, and the loading and
 * autosaving of the blueprint being edited. Drawing and pointer handling belong to canvas/Canvas.
 *
 * All editor state lives in the store, including which panels and which dialog are open, so that
 * menus, the command palette and shortcuts can all change it. Components here keep no state of
 * their own beyond a drag in progress.
 *
 * A pattern used throughout ui/: values that are drawn are read with `useStore(selector)`, which
 * re-renders when they change; `const s = useStore.getState()` is only a way to reach the store's
 * actions (which never change) from event handlers, without subscribing to anything. State must
 * not be drawn from `s`: it is a snapshot taken at render.
 */

function TopBar({ phone }: { phone?: boolean }) {
  const name = useStore((s) => s.doc.name)
  const saved = useStore((s) => s.saved)
  const saveFailed = useStore((s) => s.saveFailed)
  const canUndo = useStore((s) => s.past.length > 0)
  const canRedo = useStore((s) => s.future.length > 0)
  const flat = useStore((s) => s.flat)
  const theme = useStore((s) => s.theme)
  const showLib = useStore((s) => s.showLib)
  const showInsp = useStore((s) => s.showInsp)
  const s = useStore.getState()
  // on a phone the bar keeps only what is needed at all times; the rest lives in the dock and its menu
  if (phone) return (
    <header className="topbar">
      <div className="island">
        <button className="home" onClick={goHome} aria-label="All blueprints"><ChevronLeft size={16} /><Logo size={20} /></button>
        <input className="doc-name" value={name} spellCheck={false} aria-label="Blueprint name" enterKeyHint="done"
          onChange={(e) => coalesce('docname', (d) => ({ ...d, name: e.target.value }))} onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()} />
        <span className={'save-dot' + (saveFailed ? ' failed' : saved ? '' : ' busy')} role="status" aria-label={saveFailed ? 'Not saved' : saved ? 'Saved' : 'Saving'} />
      </div>
      <div className="island">
        <IconBtn title="Undo" onClick={s.undo} disabled={!canUndo}><Undo2 size={17} /></IconBtn>
        <IconBtn title="Redo" onClick={s.redo} disabled={!canRedo}><Redo2 size={17} /></IconBtn>
        <button className="btn primary sm" aria-label="Share" onClick={() => s.set({ modal: 'share' })}><Share2 size={14} /></button>
      </div>
    </header>
  )
  return (
    <header className="topbar">
      <div className="island">
        <button className="home" onClick={goHome} aria-label="All blueprints"><ChevronLeft size={14} /><Logo size={20} /><span className="tip">All blueprints</span></button>
        <span className="crumb">/</span>
        <input className="doc-name" value={name} spellCheck={false} aria-label="Blueprint name"
          onChange={(e) => coalesce('docname', (d) => ({ ...d, name: e.target.value }))} onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
          style={{ width: `calc(${Math.max(6, name.length)} * 0.56em + 22px)` }} />
        <span className={'save-state' + (saveFailed ? ' failed' : saved ? '' : ' busy')} aria-live="polite"><i />{saveFailed ? 'Not saved' : saved ? 'Saved' : 'Saving'}</span>
        <span className="sep" />
        <IconBtn title="Library" kbd="[" active={showLib} onClick={() => s.set({ showLib: !showLib, ...(narrow() && !showLib ? { showInsp: false } : {}) })}><PanelLeft size={15} /></IconBtn>
        <span className="hide-sm">
        <IconBtn title="Undo" kbd="⌘Z" onClick={s.undo} disabled={!canUndo}><Undo2 size={15} /></IconBtn>
        <IconBtn title="Redo" kbd="⇧⌘Z" onClick={s.redo} disabled={!canRedo}><Redo2 size={15} /></IconBtn>
        <IconBtn title="Version history" onClick={() => s.set({ modal: 'history' })}><History size={15} /></IconBtn>
        </span>
      </div>
      <button className="island cmdk-trigger" aria-label="Search or run a command" onClick={() => s.set({ modal: 'command' })}>
        <Command size={13} /><span>Search or run a command</span><kbd>{keys('⌘K')}</kbd>
      </button>
      <div className="island">
        <Segmented size="sm" value={flat ? '2d' : '3d'} onChange={(v) => setFlat(v === '2d')}
          options={[{ value: '3d', label: <><Box size={13} />3D</>, title: 'Home view (3)' }, { value: '2d', label: <><Layers size={13} />2D</>, title: 'Top view (2)' }]} />
        <span className="sep" />
        <span className="hide-xs">
        <IconBtn title="Import" onClick={() => s.set({ modal: 'import' })}><Upload size={15} /></IconBtn>
        <IconBtn title="Export" kbd="⌘E" onClick={() => s.set({ modal: 'export' })}><Download size={15} /></IconBtn>
        </span>
        <span className="hide-xs"><IconBtn title={theme === 'dark' ? 'Light theme' : 'Dark theme'} onClick={() => s.setTheme(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}</IconBtn></span>
        <span className="hide-xs"><IconBtn title="Shortcuts" kbd="?" onClick={() => s.set({ modal: 'shortcuts' })}><CircleHelp size={15} /></IconBtn></span>
        <IconBtn title="Inspector" kbd="]" active={showInsp} onClick={() => s.set({ showInsp: !showInsp, ...(narrow() && !showInsp ? { showLib: false } : {}) })}><PanelRight size={15} /></IconBtn>
        <button className="btn primary sm" aria-label="Share" onClick={() => s.set({ modal: 'share' })}><Share2 size={13} /><span>Share</span></button>
      </div>
    </header>
  )
}

// below this width the panels are bottom sheets, so only one is open at a time.
// 760 is the same width at which ui/device.ts and styles.css switch to the phone layout
const narrow = () => innerWidth <= 760

const TOOLS: { id: Tool; label: string; kbd: string; icon: any }[] = [
  { id: 'select', label: 'Select', kbd: 'V', icon: MousePointer2 },
  { id: 'connect', label: 'Connect', kbd: 'C', icon: Waypoints },
  { id: 'area', label: 'Area', kbd: 'A', icon: SquareDashed },
  { id: 'text', label: 'Text', kbd: 'T', icon: Type },
  { id: 'orbit', label: 'Orbit view', kbd: 'O', icon: Rotate3d },
]

function Toolbar() {
  const tool = useStore((s) => s.tool)
  const showGrid = useStore((s) => s.showGrid)
  const snap = useStore((s) => s.snap)
  const showLabels = useStore((s) => s.showLabels)
  const flow = useStore((s) => s.flow)
  const s = useStore.getState()
  return (
    <div className="toolbar">
      {TOOLS.map((t) => (
        <IconBtn key={t.id} title={t.label} kbd={t.kbd} active={tool === t.id} onClick={() => s.set({ tool: t.id, placing: null })}><t.icon size={16} /></IconBtn>
      ))}
      <hr />
      <IconBtn title="Traffic animation" active={flow} onClick={() => s.set({ flow: !flow })}><Activity size={16} /></IconBtn>
      <IconBtn title="Grid" kbd="G" active={showGrid} onClick={() => s.set({ showGrid: !showGrid })}><Grid3x3 size={16} /></IconBtn>
      {/* off, everything stays exactly where it is put. On, components keep to the grid and lines are drawn to what they line up with. The choice is remembered across sessions */}
      <IconBtn title={snap ? 'Snap to grid: on' : 'Snap to grid: off'} kbd="S" active={snap} onClick={() => { setPref('snap', !snap); s.set({ snap: !snap }) }}><Magnet size={16} /></IconBtn>
      <IconBtn title="Component names" kbd="L" active={showLabels} onClick={() => s.set({ showLabels: !showLabels })}><Tag size={16} /></IconBtn>
      <hr />
      <IconBtn title="Tidy layout" onClick={tidy}><LayoutGrid size={16} /></IconBtn>
    </div>
  )
}

/**
 * The whole diagram in small, with the part on screen framed. The drawing is in scene coordinates: projected
 * screen pixels at zoom 1, before the view's pan and zoom are applied.
 *
 * The diagram is only drawn again when the blueprint or the camera angle changes. The frame follows the view
 * on every frame of a pan or a zoom, so it is not drawn at all: it is a box, carried and stretched to where
 * the view is by a transform (see camera.ts for why it is done that way and no other).
 */
function Minimap() {
  const doc = useStore((s) => s.doc)
  const yaw = useStore((s) => s.yaw)
  const pitch = useStore((s) => s.pitch)
  const ref = useRef<HTMLDivElement>(null)
  const frame = useRef<HTMLDivElement>(null)
  const proj = useMemo(() => makeCam(yaw, pitch), [yaw, pitch])
  const b = useMemo(() => sceneBounds(doc, proj, 120), [doc, proj])
  // Every component of one colour is a single shape: a large blueprint is a few dozen shapes here, not thousands. Each
  // component's outline is kept against the component itself, so an edit works out the outline of what it changed and no more
  const [outlines] = useState(() => ({ proj, of: new WeakMap<object, string>() }))
  const shapes = useMemo(() => {
    if (outlines.proj !== proj) { outlines.proj = proj; outlines.of = new WeakMap() }
    const byColour = new Map<string, string[]>()
    for (const n of doc.nodes) {
      let d = outlines.of.get(n)
      if (d === undefined) {
        const s = footOf(n), q = [pt(proj, n.x, n.y), pt(proj, n.x + s, n.y), pt(proj, n.x + s, n.y + s), pt(proj, n.x, n.y + s)]
        d = 'M' + q.map((c) => Math.round(c[0]) + ' ' + Math.round(c[1])).join('L') + 'Z'
        outlines.of.set(n, d)
      }
      const c = nodeColor(n), list = byColour.get(c)
      if (list) list.push(d); else byColour.set(c, [d])
    }
    return [...byColour].map(([colour, list]) => [colour, list.join('')] as const)
  }, [doc.nodes, proj, outlines])
  const some = doc.nodes.length > 0
  // How big the map is on the page. Measured when it changes and kept, not asked for on every edit: asking makes the
  // browser lay the page out there and then, in the middle of putting the edit on it
  const [size, setSize] = useState({ w: 168, h: 104 })
  useEffect(() => {
    const box = ref.current
    if (!box || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => { const w = box.clientWidth, h = box.clientHeight; if (w && h) setSize((was) => (was.w === w && was.h === h ? was : { w, h })) })
    ro.observe(box)
    return () => ro.disconnect()
  }, [some])
  useLayoutEffect(() => {
    const el = frame.current
    if (!el) return
    // The map is letterboxed in its box (`xMidYMid meet`): `m` is map px to a scene px, and (ox, oy) where the scene's origin lands
    const { w, h } = size
    const m = Math.min(w / b.w, h / b.h), ox = (w - b.w * m) / 2 - b.x * m, oy = (h - b.h * m) / 2 - b.y * m
    // The frame is five pieces, each one pixel square and stretched to its place by a transform: the wash inside it both
    // ways, and each of its four sides along its own length only, so that a side is one pixel thick whatever size the
    // frame is, on every frame of a zoom. A box with a border, scaled as a whole, has a border as thick as the scale
    // makes it, and a box given its real width and height on each frame has the page laid out each time. All of it sits
    // on whole device pixels, where a line a pixel thick is drawn as one
    const [wash, top, right, bottom, left] = Array.from(el.children) as HTMLElement[]
    const whole = (n: number) => { const dpr = (typeof devicePixelRatio === 'number' && devicePixelRatio) || 1; return Math.round(n * dpr) / dpr }
    const fit = (v: { x: number; y: number; k: number }) => {
      const x = whole(ox - (v.x / v.k) * m), y = whole(oy - (v.y / v.k) * m), fw = Math.max(2, whole((cam.w / v.k) * m)), fh = Math.max(2, whole((cam.h / v.k) * m))
      wash.style.transform = `translate(${x}px, ${y}px) scale(${fw}, ${fh})`
      top.style.transform = `translate(${x}px, ${y}px) scaleX(${fw})`
      bottom.style.transform = `translate(${x}px, ${y + fh - 1}px) scaleX(${fw})`
      // (between the other two: where two sides met, the corner would be drawn twice over)
      left.style.transform = `translate(${x}px, ${y + 1}px) scaleY(${fh - 2})`
      right.style.transform = `translate(${x + fw - 1}px, ${y + 1}px) scaleY(${fh - 2})`
    }
    return followView(fit)
  }, [b, some, size])
  // centre the view on the point pressed: the margins the letterboxing adds are taken off before a pixel is turned into a scene position
  const jump = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect(), k = useStore.getState().view.k
    const scale = Math.max(b.w / r.width, b.h / r.height)
    const ox = (r.width * scale - b.w) / 2, oy = (r.height * scale - b.h) / 2
    const sx = b.x - ox + (e.clientX - r.left) * scale, sy = b.y - oy + (e.clientY - r.top) * scale
    useStore.setState({ view: { k, x: cam.w / 2 - sx * k, y: cam.h / 2 - sy * k } })
  }
  if (!some) return null
  // one pixel of the map, in the scene's own px: what a group's outline is drawn with, so that it is a hairline at any size of map
  const hair = 1 / Math.min(size.w / b.w, size.h / b.h)
  return (
    <div ref={ref} className="minimap" onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); jump(e) }} onPointerMove={(e) => e.buttons === 1 && jump(e)}>
      <svg viewBox={`${b.x} ${b.y} ${b.w} ${b.h}`} preserveAspectRatio="xMidYMid meet" aria-hidden>
        {doc.areas.map((a) => (
          <polygon key={a.id} points={poly([pt(proj, a.x, a.y), pt(proj, a.x + a.w, a.y), pt(proj, a.x + a.w, a.y + a.d), pt(proj, a.x, a.y + a.d)])} fill={a.color} fillOpacity={0.1} stroke={a.color} strokeOpacity={0.5} strokeWidth={hair} />
        ))}
        {shapes.map(([colour, d]) => <path key={colour} d={d} fill={colour} />)}
      </svg>
      <div ref={frame} className="mm-view"><i className="mm-wash" /><i /><i /><i /><i /></div>
    </div>
  )
}

/**
 * Navigation cube, as found in CAD viewers: it mirrors the camera, can be
 * dragged to orbit, and each face snaps to that standard view.
 *
 * The drag is kept in a ref: it changes on every pointer move and nothing is drawn from it (the
 * cube redraws because the camera angle in the store changes). The face under the press is noted
 * at pointer down, because once the pointer is captured later events report the svg as their target.
 */
function ViewCube() {
  const yaw = useStore((s) => s.yaw)
  const pitch = useStore((s) => s.pitch)
  const p = useMemo(() => makeCam(yaw, pitch), [yaw, pitch])
  const drag = useRef<{ x: number; y: number; moved: boolean; update: (dx: number, dy: number) => void; face: string | null } | null>(null)
  const K = 0.52 // cube half-size in world units → fits the 76px box at any angle
  const P = (x: number, y: number, z: number) => pt(p, x * K, y * K, z * K)
  const faces: { id: string; label: string; pts: [number, number][]; fill: string; go: () => void }[] = []
  const yF = p.d >= 0 ? 1 : -1, xF = p.c >= 0 ? 1 : -1
  // side views look across the scene from a low angle; the ground would vanish at a true 0°
  faces.push({ id: 'y', label: yF > 0 ? 'FRONT' : 'BACK', fill: yF > 0 ? 'var(--cube-a)' : 'var(--cube-c)', go: () => orbitTo(yF > 0 ? 0 : 180, 22),
    pts: [P(-1, yF, -1), P(1, yF, -1), P(1, yF, 1), P(-1, yF, 1)] })
  faces.push({ id: 'x', label: xF > 0 ? 'RIGHT' : 'LEFT', fill: xF > 0 ? 'var(--cube-b)' : 'var(--cube-a)', go: () => orbitTo(xF > 0 ? 90 : 270, 22),
    pts: [P(xF, -1, -1), P(xF, 1, -1), P(xF, 1, 1), P(xF, -1, 1)] })
  faces.push({ id: 'top', label: 'TOP', fill: 'var(--cube-top)', go: viewTop, pts: [P(-1, -1, 1), P(1, -1, 1), P(1, 1, 1), P(-1, 1, 1)] })
  const centre = (q: [number, number][]) => [q.reduce((s, v) => s + v[0], 0) / 4, q.reduce((s, v) => s + v[1], 0) / 4]
  // a face's size on screen: one seen nearly edge-on is too thin to carry its name
  const area = (q: [number, number][]) => Math.abs((q[1][0] - q[0][0]) * (q[3][1] - q[0][1]) - (q[3][0] - q[0][0]) * (q[1][1] - q[0][1]))
  return (
    <div className="viewcube">
      <svg viewBox="-46 -46 92 92" width={92} height={92}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId)
          drag.current = { x: e.clientX, y: e.clientY, moved: false, update: beginOrbit(), face: (e.target as SVGElement).dataset.face ?? null }
        }}
        onPointerMove={(e) => {
          const d = drag.current
          if (!d) return
          const dx = e.clientX - d.x, dy = e.clientY - d.y
          // under 3px of travel it is still a click on a face, not a drag
          if (!d.moved && Math.hypot(dx, dy) < 3) return
          d.moved = true
          d.update(dx * 1.6, dy * 1.6)
        }}
        onPointerUp={() => {
          const d = drag.current
          drag.current = null
          if (d && !d.moved && d.face) faces.find((f) => f.id === d.face)?.go()
        }}>
        {faces.map((f) => {
          const [cx, cy] = centre(f.pts)
          return (
            <g key={f.id}>
              <polygon className="cube-face" data-face={f.id} points={poly(f.pts)} style={{ fill: f.fill }} />
              {area(f.pts) > 420 && <text x={cx} y={cy} textAnchor="middle" dominantBaseline="central" pointerEvents="none">{f.label}</text>}
            </g>
          )
        })}
      </svg>
      <div className="viewcube-bar">
        <IconBtn title="Turn left" kbd="Q" onClick={() => turn(45)}><RotateCcw size={13} /></IconBtn>
        <IconBtn title="Home view" kbd="3" onClick={viewHome}><Home size={13} /></IconBtn>
        <IconBtn title="Turn right" kbd="E" onClick={() => turn(-45)}><RotateCw size={13} /></IconBtn>
      </div>
    </div>
  )
}

/** Instrument read-out along the bottom edge: cursor position, camera angle and the running total. */
function Hud() {
  const doc = useStore((s) => s.doc)
  const pricing = useStore((s) => s.pricing)
  const lens = useStore((s) => s.lens)
  const yaw = useStore((s) => s.yaw)
  const pitch = useStore((s) => s.pitch)
  const total = useTween(useMemo(() => docCost(doc, pricing).total, [doc, pricing]))
  const cursor = useRef<HTMLSpanElement>(null)
  // the canvas writes the cursor position straight into this element on every pointer move, so tracking it never renders React
  useEffect(() => { hud.el = cursor.current; return () => { hud.el = null } }, [])
  const s = useStore.getState()
  const deg = (v: number) => String(Math.round(v)).padStart(3, '0') + '°'
  return (
    <div className="hud">
      <span className="hud-cell wide" ref={cursor}>X +000  Y +000</span>
      <span className="hud-cell"><em>AZ</em>{deg(normYaw(yaw))}</span>
      <span className="hud-cell"><em>EL</em>{deg(pitch).slice(1)}</span>
      <span className="hud-cell"><em>N</em>{String(doc.nodes.length).padStart(2, '0')}</span>
      <span className="hud-cell"><em>L</em>{String(doc.edges.length).padStart(2, '0')}</span>
      <button className="hud-cell cost" onClick={() => s.set({ panel: 'budget', showInsp: true })}>{money(total, true)}<em>/mo</em></button>
      {lens === 'cost' && <span className="hud-cell heat-legend">low<i />high</span>}
    </div>
  )
}

/** Shown while a flow is being followed: what is being followed, how far it reaches, and the way out. */
function TraceBar() {
  const trace = useStore((s) => s.trace)
  const doc = useStore((s) => s.doc)
  const flow = useMemo(() => (trace ? traceFlow(doc, trace) : null), [doc, trace])
  const stop = () => useStore.getState().set({ trace: null })
  // Back steps out of it, like any other temporary state
  useBackLayer(!!flow, stop)
  // what was being followed has gone
  useEffect(() => { if (trace && !flow) stop() }, [trace, flow])
  if (!flow || !trace) return null
  const edge = doc.edges.find((e) => e.id === trace), node = doc.nodes.find((n) => n.id === trace)
  const what = edge ? describe(doc, edge) : node ? nodeName(node) : ''
  const n = (k: number, word: string) => (k ? `${k} ${word}` : `nothing ${word}`)
  return (
    <div className="trace-bar" role="status">
      <span>Following <b>{what}</b> · {n(flow.up.size, 'upstream')}, {n(flow.down.size, 'downstream')}</span>
      <button className="btn sm" onClick={stop}><X size={13} />Stop</button>
    </div>
  )
}

// every figure the zoom read-out can show: the zoom runs from 15% to 400%
const ZOOM_FROM = Math.round(MIN_K * 100), ZOOM_TO = Math.round(MAX_K * 100)
const FIGURES = Array.from({ length: ZOOM_TO - ZOOM_FROM + 1 }, (_, i) => <i key={i}>{ZOOM_FROM + i}%</i>)

/**
 * The zoom read-out and its buttons. The figure changes on every frame of a zoom, and changing a line of text
 * would have the page laid out on each of them (see camera.ts). So every figure there can be is already there,
 * laid out once, and the read-out only changes which one is visible.
 */
function ZoomControls() {
  const figures = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    let shown: Element | null = null
    return followView((v) => {
      const next = figures.current?.children[Math.max(ZOOM_FROM, Math.min(ZOOM_TO, Math.round(v.k * 100))) - ZOOM_FROM] ?? null
      if (next === shown) return
      shown?.classList.remove('on'); next?.classList.add('on')
      shown = next
    })
  }, [])
  return (
    <div className="zoom-ctl">
      <IconBtn title="Zoom out" kbd="-" onClick={() => animateView(zoomBy(1 / 1.3), 180)}><Minus size={14} /></IconBtn>
      <button className="zoom-pct" onClick={() => animateView({ ...zoomBy(1 / useStore.getState().view.k), k: 1 }, 240)}><span ref={figures}>{FIGURES}</span><span className="tip">Reset to 100%</span></button>
      <IconBtn title="Zoom in" kbd="+" onClick={() => animateView(zoomBy(1.3), 180)}><Plus size={14} /></IconBtn>
      <span className="sep" />
      <IconBtn title="Fit" kbd="F" onClick={() => fitView()}><Scan size={14} /></IconBtn>
    </div>
  )
}

function CanvasChrome({ phone }: { phone?: boolean }) {
  const tool = useStore((s) => s.tool)
  const placing = useStore((s) => s.placing)
  const hint = placing ? 'Release on the canvas to place · Esc cancels'
    : tool === 'connect' ? 'Drag from one component to another'
    : tool === 'area' ? 'Drag on the ground to draw an area'
    : tool === 'text' ? 'Click to drop a label'
    : tool === 'orbit' ? 'Drag to orbit · right-drag orbits from any tool' : null
  if (phone) return <><ViewCube /><Hud /><ViewFabs /><TraceBar /></>
  return (
    <>
      <ViewCube />
      <Toolbar />
      {hint && <div className="hint-pill" key={hint}>{hint}</div>}
      <TraceBar />
      <Hud />
      <div className="zoom">
        <Minimap />
        <ZoomControls />
      </div>
    </>
  )
}

function RightPanel() {
  const panel = useStore((s) => s.panel)
  const doc = useStore((s) => s.doc)
  const issues = useMemo(() => analyze(doc).findings.filter((f) => f.severity !== 'low').length, [doc])
  return (
    <aside className="panel right">
      <RightTabs panel={panel} issues={issues} />
      <div className="right-scroll" key={panel}>
        {panel === 'inspect' ? <Inspector /> : panel === 'budget' ? <BudgetPanel /> : <AdvisorPanel />}
      </div>
    </aside>
  )
}

function RightTabs({ panel, issues }: { panel: Panel; issues: number }) {
  const s = useStore.getState()
  const tabs: { id: Panel; label: string; badge?: number }[] = [
    { id: 'inspect', label: 'Inspect' }, { id: 'budget', label: 'Budget' }, { id: 'advisor', label: 'Advisor', badge: issues },
  ]
  return (
      <div className="tabs" role="tablist">
        {tabs.map((t) => (
          <button key={t.id} role="tab" aria-selected={panel === t.id} className={panel === t.id ? 'on' : ''} onClick={() => s.set({ panel: t.id })}>
            {t.label}{t.badge ? <span className="badge">{t.badge}</span> : null}
          </button>
        ))}
      </div>
  )
}

/** The same three tabs as the desktop side panel, in a sheet: the tabs are the sheet's title. */
function InspectSheet({ onClose }: { onClose: () => void }) {
  const panel = useStore((s) => s.panel)
  const doc = useStore((s) => s.doc)
  const issues = useMemo(() => analyze(doc).findings.filter((f) => f.severity !== 'low').length, [doc])
  return (
    <Sheet label="Inspector" onClose={onClose} title={<RightTabs panel={panel} issues={issues} />}>
      <div className="right-scroll" key={panel}>
        {panel === 'inspect' ? <Inspector /> : panel === 'budget' ? <BudgetPanel /> : <AdvisorPanel />}
      </div>
    </Sheet>
  )
}

/**
 * The editor's keyboard shortcuts: one `keydown` listener on the window for as long as the editor is
 * mounted. It reads the store when a key arrives, not when it was set up, so it never needs replacing.
 *
 * The order of the checks is the policy:
 * 1. just after a field was asked to take focus, plain characters are kept for that field;
 * 2. Cmd/Ctrl+K toggles the command palette from anywhere, even over another dialog;
 * 3. with any dialog open, nothing else here runs: the dialog has the keyboard;
 * 4. Cmd/Ctrl+S and Cmd/Ctrl+E work while typing in a field;
 * 5. everything else is ignored while typing, so text fields keep their own undo, copy, arrows and letters.
 *
 * Phone sheets and the side panels are not dialogs, so shortcuts keep working while they are open.
 * Copy and cut are the only ones that leave the browser's own handling of the key in place.
 */
function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useStore.getState()
      const el = e.target as HTMLElement
      const typing = /INPUT|TEXTAREA|SELECT/.test(el?.tagName ?? '') || el?.isContentEditable
      // a field is about to take focus (a new label, a rename): these keys are meant for it
      if (!typing && focusPending() && !e.metaKey && !e.ctrlKey && e.key.length === 1) { e.preventDefault(); typeAhead(e.key); return }
      const mod = e.metaKey || e.ctrlKey
      const key = e.key.toLowerCase()
      if (mod && key === 'k') { e.preventDefault(); s.set({ modal: s.modal === 'command' ? null : 'command' }); return }
      if (s.modal) return
      if (mod && key === 's') { e.preventDefault(); saveVersion(); return }
      if (mod && key === 'e') { e.preventDefault(); s.set({ modal: 'export' }); return }
      if (typing) return
      if (mod) {
        if (key === 'z') { e.preventDefault(); e.shiftKey ? s.redo() : s.undo() }
        else if (key === 'y') { e.preventDefault(); s.redo() }
        else if (key === 'd') { e.preventDefault(); s.duplicate(s.selection) }
        else if (key === 'c') s.copy()
        else if (key === 'x') { s.copy(); s.remove(s.selection) }
        else if (key === 'v') { e.preventDefault(); s.paste() }
        else if (key === 'a') { e.preventDefault(); selectAll() }
        return
      }
      // a cell at a time, four with Shift, and a twentieth of one with Alt, for placing something finely
      const step = e.altKey ? 0.05 : e.shiftKey ? 4 : 1
      switch (e.key) {
        case 'Escape':
          if (s.placing) s.set({ placing: null })
          else if (s.trace) s.set({ trace: null })
          else if (s.tool !== 'select') s.set({ tool: 'select' })
          else s.select([])
          break
        case 'Delete': case 'Backspace': s.remove(s.selection); break
        case 'Enter': if (s.selection.length) { e.preventDefault(); useStore.setState({ panel: 'inspect', focusName: s.focusName + 1 }) } break
        // arrows follow the screen, whatever way the camera is turned
        case 'ArrowRight': case 'ArrowLeft': case 'ArrowDown': case 'ArrowUp': {
          e.preventDefault()
          const { u, v } = upright(makeCam(s.yaw, s.pitch))
          const d = e.key === 'ArrowRight' ? u : e.key === 'ArrowLeft' ? [-u[0], -u[1]] : e.key === 'ArrowDown' ? v : [-v[0], -v[1]]
          s.nudge(d[0] * step, d[1] * step)
          break
        }
        case '?': s.set({ modal: 'shortcuts' }); break
        case '+': case '=': animateView(zoomBy(1.3), 140); break
        case '-': animateView(zoomBy(1 / 1.3), 140); break
        default:
          if (key === 'v') s.set({ tool: 'select', placing: null })
          else if (key === 'c') s.set({ tool: 'connect', placing: null })
          else if (key === 'a') s.set({ tool: 'area', placing: null })
          else if (key === 't') s.set({ tool: 'text', placing: null })
          else if (key === 'o') s.set({ tool: s.tool === 'orbit' ? 'select' : 'orbit', placing: null })
          else if (key === '[') s.set({ showLib: !s.showLib, ...(narrow() && !s.showLib ? { showInsp: false } : {}) })
          else if (key === ']') s.set({ showInsp: !s.showInsp, ...(narrow() && !s.showInsp ? { showLib: false } : {}) })
          else if (key === '\\') { const on = s.showLib || s.showInsp; s.set({ showLib: !on, showInsp: !on }) }
          else if (key === 'q') turn(45)
          else if (key === 'e') turn(-45)
          else if (key === 'f') fitView(s.selection.length ? s.doc.nodes.filter((n) => s.selection.includes(n.id)).map((n) => n.id) : undefined)
          else if (key === 'g') s.set({ showGrid: !s.showGrid })
          else if (key === 's') { setPref('snap', !s.snap); s.set({ snap: !s.snap }) }
          else if (key === 'l') s.set({ showLabels: !s.showLabels })
          else if (key === 'h') s.set({ lens: s.lens === 'cost' ? 'none' : 'cost' })
          else if (key === '2') setFlat(true)
          else if (key === '3') setFlat(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

/**
 * The editor for the blueprint stored under `id`. It owns the blueprint's time in the store: it loads
 * it, turns autosave on while it is open, and writes the last change as it closes. App keys it by `id`,
 * so each blueprint gets a fresh one.
 */
export function Editor({ id }: { id: string }) {
  const loaded = useStore((s) => s.doc.id === id)
  const modal = useStore((s) => s.modal)
  const s = useStore.getState()
  useShortcuts()
  useEffect(() => {
    // (re)load whenever the store is not holding this blueprint, e.g. after a hot reload
    if (useStore.getState().doc.id !== id) {
      const doc = loadDoc(id)
      // replaced, not added: Back from the dashboard must not land on the missing blueprint and be bounced again
      if (!doc) { navigate('#/', { replace: true }); return }
      // off while the store is filled, so loading is not itself taken for an edit and written back
      enableAutosave(false)
      useStore.getState().load(doc)
      useStore.setState({ yaw: 45, pitch: 35.264, flat: false })
    }
    enableAutosave(true)
    const flush = () => flushSave()
    window.addEventListener('beforeunload', flush)
    // flush first: it only writes while autosave is on. A pending save is on a timer that closing would otherwise outrun
    return () => { flushSave(); enableAutosave(false); window.removeEventListener('beforeunload', flush) }
    // `loaded` is a dependency so that the store losing this blueprint (it is module state, and can be replaced under us) loads it again
  }, [id, loaded])
  const title = useStore((st) => st.doc.name)
  useEffect(() => { document.title = (title || 'Untitled') + ' · CloudMill Graph' }, [title])
  const showLib = useStore((st) => st.showLib)
  const showInsp = useStore((st) => st.showInsp)
  const phone = usePhone()
  // the gestures are the interface on a phone, so they are named once, the first time: after a pause, only if
  // nothing else has opened meanwhile, and marked as seen only when actually shown
  useEffect(() => {
    if (!phone || !loaded || getPref('coached', false)) return
    const t = setTimeout(() => { const st = useStore.getState(); if (!st.modal && !st.showLib && !st.showInsp) { st.set({ modal: 'gestures' }); setPref('coached', true) } }, 1400)
    return () => clearTimeout(t)
  }, [phone, loaded])
  if (!loaded) return <div className="boot"><Logo size={34} /></div>
  const close = () => s.set({ modal: null })
  return (
    <div className={'editor' + (phone ? ' phone' : '')} data-lib={showLib} data-insp={showInsp}>
      <main className="stage">
        <Canvas />
        <CanvasChrome phone={phone} />
      </main>
      <TopBar phone={phone} />
      {phone && <MobileDock />}
      {phone && showLib && <Sheet label="Library" roomy title={<CloudSeg />} onClose={() => s.set({ showLib: false })}><Palette /></Sheet>}
      {phone && showInsp && <InspectSheet onClose={() => s.set({ showInsp: false })} />}
      {!phone && showLib && <Palette />}
      {!phone && showInsp && <RightPanel />}
      {modal === 'gestures' && phone && <GestureGuide onClose={close} />}
      {modal === 'command' && <CommandPalette onClose={close} />}
      {modal === 'export' && <ExportDialog onClose={close} />}
      {modal === 'import' && <ImportDialog onClose={close} />}
      {modal === 'share' && <ShareDialog onClose={close} />}
      {modal === 'shortcuts' && <ShortcutsDialog onClose={close} />}
      {modal === 'history' && <HistoryDialog onClose={close} />}
    </div>
  )
}
