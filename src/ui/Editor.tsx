import { useEffect, useMemo, useRef } from 'react'
import {
  Activity, Box, ChevronLeft, Home, PanelLeft, PanelRight, Rotate3d, RotateCcw, RotateCw, CircleHelp, Command, Download, Grid3x3, History, Layers, LayoutGrid, Minus, Moon, MousePointer2,
  Plus, Redo2, Scan, Share2, SquareDashed, Sun, Tag, Type, Undo2, Upload, Waypoints,
} from 'lucide-react'
import { Canvas } from '../canvas/Canvas'
import { animateView, beginOrbit, cam, fitView, hud, orbitTo, setFlat, turn, viewHome, viewTop, zoomBy } from '../canvas/camera'
import { sceneBounds } from '../canvas/Scene'
import { analyze } from '../core/advisor'
import { docCost, money, nodeColor } from '../core/catalog'
import { makeCam, normYaw, poly, pt, upright } from '../core/iso'
import { type Panel, type Tool, coalesce, enableAutosave, flushSave, useStore } from '../core/store'
import { loadDoc } from '../core/storage'
import { IconBtn, Segmented, useTween, focusPending, keys, typeAhead } from './atoms'
import { go, saveVersion, selectAll, tidy } from './actions'
import { AdvisorPanel } from './AdvisorPanel'
import { BudgetPanel } from './BudgetPanel'
import { CommandPalette } from './CommandPalette'
import { ExportDialog, HistoryDialog, ImportDialog, ShareDialog, ShortcutsDialog } from './Dialogs'
import { Inspector } from './Inspector'
import { Palette } from './Palette'
import { footOf } from '../core/types'

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

function TopBar() {
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
  return (
    <header className="topbar">
      <div className="island">
        <button className="home" onClick={() => go('#/')} aria-label="All blueprints"><ChevronLeft size={14} /><Logo size={20} /><span className="tip">All blueprints</span></button>
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

// below this width the panels are bottom sheets, so only one is open at a time
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
      <IconBtn title="Component names" kbd="L" active={showLabels} onClick={() => s.set({ showLabels: !showLabels })}><Tag size={16} /></IconBtn>
      <hr />
      <IconBtn title="Tidy layout" onClick={tidy}><LayoutGrid size={16} /></IconBtn>
    </div>
  )
}

function Minimap() {
  const doc = useStore((s) => s.doc)
  const view = useStore((s) => s.view)
  const yaw = useStore((s) => s.yaw)
  const pitch = useStore((s) => s.pitch)
  const ref = useRef<SVGSVGElement>(null)
  const proj = useMemo(() => makeCam(yaw, pitch), [yaw, pitch])
  const b = useMemo(() => {
    const bb = sceneBounds(doc, proj, 120)
    // include the viewport so the frame never leaves the map
    return bb
  }, [doc, proj])
  const vp = { x: -view.x / view.k, y: -view.y / view.k, w: cam.w / view.k, h: cam.h / view.k }
  const jump = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect()
    const scale = Math.max(b.w / r.width, b.h / r.height)
    const ox = (r.width * scale - b.w) / 2, oy = (r.height * scale - b.h) / 2
    const sx = b.x - ox + (e.clientX - r.left) * scale, sy = b.y - oy + (e.clientY - r.top) * scale
    useStore.setState({ view: { k: view.k, x: cam.w / 2 - sx * view.k, y: cam.h / 2 - sy * view.k } })
  }
  if (!doc.nodes.length) return null
  return (
    <svg ref={ref} className="minimap" viewBox={`${b.x} ${b.y} ${b.w} ${b.h}`} preserveAspectRatio="xMidYMid meet"
      onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); jump(e) }} onPointerMove={(e) => e.buttons === 1 && jump(e)}>
      {doc.areas.map((a) => (
        <polygon key={a.id} points={poly([pt(proj, a.x, a.y), pt(proj, a.x + a.w, a.y), pt(proj, a.x + a.w, a.y + a.d), pt(proj, a.x, a.y + a.d)])} fill={a.color} fillOpacity={0.1} stroke={a.color} strokeOpacity={0.5} strokeWidth={1} vectorEffect="non-scaling-stroke" />
      ))}
      {doc.nodes.map((n) => (
        <polygon key={n.id} points={poly([pt(proj, n.x, n.y), pt(proj, n.x + footOf(n), n.y), pt(proj, n.x + footOf(n), n.y + footOf(n)), pt(proj, n.x, n.y + footOf(n))])} fill={nodeColor(n)} />
      ))}
      <rect className="mm-view" x={vp.x} y={vp.y} width={vp.w} height={vp.h} rx={b.w / 120} />
    </svg>
  )
}

/**
 * Navigation cube, as found in CAD viewers: it mirrors the camera, can be
 * dragged to orbit, and each face snaps to that standard view.
 */
function ViewCube() {
  const yaw = useStore((s) => s.yaw)
  const pitch = useStore((s) => s.pitch)
  const flat = useStore((s) => s.flat)
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
        <IconBtn title={flat ? 'Home view' : 'Home view'} kbd="3" onClick={viewHome}><Home size={13} /></IconBtn>
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

function CanvasChrome() {
  const k = useStore((s) => s.view.k)
  const tool = useStore((s) => s.tool)
  const placing = useStore((s) => s.placing)
  const hint = placing ? 'Release on the canvas to place · Esc cancels'
    : tool === 'connect' ? 'Drag from one component to another'
    : tool === 'area' ? 'Drag on the ground to draw an area'
    : tool === 'text' ? 'Click to drop a label'
    : tool === 'orbit' ? 'Drag to orbit · right-drag orbits from any tool' : null
  return (
    <>
      <ViewCube />
      <Toolbar />
      {hint && <div className="hint-pill" key={hint}>{hint}</div>}
      <Hud />
      <div className="zoom">
        <Minimap />
        <div className="zoom-ctl">
          <IconBtn title="Zoom out" kbd="-" onClick={() => animateView(zoomBy(1 / 1.3), 180)}><Minus size={14} /></IconBtn>
          <button className="zoom-pct" onClick={() => animateView(zoomBy(1 / k), 240)}>{Math.round(k * 100)}%<span className="tip">Reset to 100%</span></button>
          <IconBtn title="Zoom in" kbd="+" onClick={() => animateView(zoomBy(1.3), 180)}><Plus size={14} /></IconBtn>
          <span className="sep" />
          <IconBtn title="Fit" kbd="F" onClick={() => fitView()}><Scan size={14} /></IconBtn>
        </div>
      </div>
    </>
  )
}

function RightPanel() {
  const panel = useStore((s) => s.panel)
  const doc = useStore((s) => s.doc)
  const s = useStore.getState()
  const issues = useMemo(() => analyze(doc).findings.filter((f) => f.severity !== 'low').length, [doc])
  const tabs: { id: Panel; label: string; badge?: number }[] = [
    { id: 'inspect', label: 'Inspect' }, { id: 'budget', label: 'Budget' }, { id: 'advisor', label: 'Advisor', badge: issues },
  ]
  return (
    <aside className="panel right">
      <div className="tabs" role="tablist">
        {tabs.map((t) => (
          <button key={t.id} role="tab" aria-selected={panel === t.id} className={panel === t.id ? 'on' : ''} onClick={() => s.set({ panel: t.id })}>
            {t.label}{t.badge ? <span className="badge">{t.badge}</span> : null}
          </button>
        ))}
      </div>
      <div className="right-scroll" key={panel}>
        {panel === 'inspect' ? <Inspector /> : panel === 'budget' ? <BudgetPanel /> : <AdvisorPanel />}
      </div>
    </aside>
  )
}

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
      const step = e.shiftKey ? 4 : 1
      switch (e.key) {
        case 'Escape':
          if (s.placing) s.set({ placing: null })
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

export function Editor({ id }: { id: string }) {
  const loaded = useStore((s) => s.doc.id === id)
  const modal = useStore((s) => s.modal)
  const s = useStore.getState()
  useShortcuts()
  useEffect(() => {
    // (re)load whenever the store is not holding this blueprint, e.g. after a hot reload
    if (useStore.getState().doc.id !== id) {
      const doc = loadDoc(id)
      if (!doc) { go('#/'); return }
      enableAutosave(false)
      useStore.getState().load(doc)
      useStore.setState({ yaw: 45, pitch: 35.264, flat: false })
    }
    enableAutosave(true)
    const flush = () => flushSave()
    window.addEventListener('beforeunload', flush)
    return () => { flushSave(); enableAutosave(false); window.removeEventListener('beforeunload', flush) }
  }, [id, loaded])
  const title = useStore((st) => st.doc.name)
  useEffect(() => { document.title = (title || 'Untitled') + ' · CloudMill Graph' }, [title])
  const showLib = useStore((st) => st.showLib)
  const showInsp = useStore((st) => st.showInsp)
  if (!loaded) return <div className="boot"><Logo size={34} /></div>
  const close = () => s.set({ modal: null })
  return (
    <div className="editor" data-lib={showLib} data-insp={showInsp}>
      <main className="stage">
        <Canvas />
        <CanvasChrome />
      </main>
      <TopBar />
      {showLib && <Palette />}
      {showInsp && <RightPanel />}
      {modal === 'command' && <CommandPalette onClose={close} />}
      {modal === 'export' && <ExportDialog onClose={close} />}
      {modal === 'import' && <ImportDialog onClose={close} />}
      {modal === 'share' && <ShareDialog onClose={close} />}
      {modal === 'shortcuts' && <ShortcutsDialog onClose={close} />}
      {modal === 'history' && <HistoryDialog onClose={close} />}
    </div>
  )
}
