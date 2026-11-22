import { useEffect, useMemo, useRef, useState } from 'react'
import { AlignCenterVertical, AlignHorizontalSpaceAround, Copy, CornerDownRight, Group, Minus, Pin, Scan, Slash, Spline, Trash2, Wand2, Waypoints } from 'lucide-react'
import { MAX_PITCH, MIN_PITCH, type Proj, U, f, makeCam, mix, normYaw, planeMatrix, poly, pt, unproject, upright } from '../core/iso'
import { costOf, defOf, defaultProps, docCost, money, nodeName } from '../core/catalog'
import { traceFlow } from '../core/links'
import { routeAll, routeToPoint } from '../core/router'
import { arrowAt, lineOf, pathOf } from '../core/routing'
import { type Track, alignRun, coordsOf, dragRun, isManual, nearestRun, simplify, snapRun, straightness, trackOf, withTrack } from '../core/shape'
import { SIDES, doorNear, magnet, portsOf, reachTo } from '../core/snap'
import { inArea, lineUp, spaceEvenly } from '../core/layout'
import { type View, kindOf, moveItems, useStore, reended } from '../core/store'
import { type AreaT, type Doc, type NodeT, type Side, MAX_SCALE, MIN_SCALE, centerOf, footOf, type EdgeT } from '../core/types'
import { Scene, THEMES, brackets, useRoutes } from './Scene'
import { Model } from './models'
import { animateView, beginOrbit, cam, center, fitView, flushFrame, glide, holdStill, hud, insets, onFrame, projNow, smoothZoom, zoomBy } from './camera'
import { type Finger, type Gesture, MAX_K, MIN_K, type Trail, fling, gestureMove, gestureRebase, gestureStart, isTwoFingerTap, track } from './touch'
import { type Gap, type Guide, alignGuides, spacingGaps } from '../core/guides'
import { QuickAdd } from './QuickAdd'
import { haptic } from '../ui/device'
import { straightenLinks, wrapSelectionInArea } from '../ui/actions'
import { ContextMenu, type MenuState } from '../ui/ContextMenu'
import { keys } from '../ui/atoms'

type Drag =
  | { mode: 'pan'; sx: number; sy: number; vx: number; vy: number; moved: boolean; quiet?: boolean }
  // second tap of a double tap on bare ground, held: sliding it zooms with one thumb
  | { mode: 'dtap'; sx: number; sy: number; view: View; moved: boolean }
  // a finger has landed and has not yet said what it wants: a tap, a pan, or a press-and-hold
  | { mode: 'touch'; id: string | null; kind: string | null; sx: number; sy: number; vx: number; vy: number; wx: number; wy: number }
  // `lx`, `ly`: how far it has been moved, which is what is on screen and what is kept; `ax`, `ay`: where the thing under the pointer stood,
  // which is what goes from grid position to grid position when snapping is on; `cloned`: this drag made the copies it is moving
  | { mode: 'move'; wx: number; wy: number; sx: number; sy: number; base: Doc; active: boolean; step: number; lx: number; ly: number; ax?: number; ay?: number; cloned?: boolean; home: string | null }
  // `wx`, `wy`: where on the ground the corner was taken hold of, so it moves as far as the pointer does from wherever on the handle it was caught
  | { mode: 'resize'; id: string; corner: number; base: AreaT; active: boolean; wx: number; wy: number }
  | { mode: 'nresize'; id: string; corner: number; base: NodeT; active: boolean; wx: number; wy: number }
  | { mode: 'connect'; from: string; sx: number; sy: number }
  // a connection being reshaped: one run moved sideways, or a turn (the two runs that meet at it) moved about. `track` is the line
  // as it was picked up and `last` as it would be left if let go now. Each run in the hand remembers where it stood (`from`) and
  // which ground coordinate moves it; `wx`, `wy` is where on the ground it was taken hold of, so it goes as far as the pointer does
  // and no further, wherever on its width it was caught
  | { mode: 'seg'; id: string; held: { run: number; axis: 'x' | 'y'; from: number; on?: number }[]; track: Track; last: Track; turns: number; active: boolean; base: Doc; sx: number; sy: number; wx: number; wy: number; rested?: number }
  // one end of a connection being dragged to another component, or to another side of the same one
  | { mode: 'relink'; id: string; end: 'from' | 'to'; active: boolean; sx: number; sy: number }
  | { mode: 'marquee'; sx: number; sy: number }
  | { mode: 'area'; wx: number; wy: number }
  | { mode: 'orbit'; sx: number; sy: number; moved: boolean; button: number; update: (dx: number, dy: number) => void }


export function heat(t: number) {
  if (t <= 0) return '#4a556b'
  const s = Math.sqrt(t)
  return s < 0.5 ? mix('#2BB5D4', '#E8C13D', s * 2) : mix('#E8C13D', '#E5574F', (s - 0.5) * 2)
}

// rough body heights, so the selection bar sits just above each kind of component
const HEIGHT: Record<string, number> = { tower: 1.9, rack: 2.1, slab: 0.55, tile: 0.3, cylinder: 1.7, bucket: 1.5, stack: 1.05, cluster: 0.95, people: 1.2, globe: 1.9, disc: 0.5, gate: 1.45 }

/** how long a finger rests before it counts as press-and-hold, and how far it may wander and still be a tap */
export const HOLD_MS = 420
const TOUCH_SLOP = 9

/** Where the pointer is and what is held down with it: everything a drag needs to take its next step. */
interface Ptr { x: number; y: number; shift: boolean; alt: boolean; ctrl: boolean; touch: boolean }
const r3 = (v: number) => Math.round(v * 1000) / 1000 + 0
/** A coordinate as it is kept: where it was put, or the nearest grid position when snapping is on. */
const put = (v: number, step: number, snap: boolean) => (snap ? Math.round(v / step) * step + 0 : r3(v))
/** Snapping is off unless the user turned it on; Ctrl (or Cmd) held during a drag flips it for that drag. */
const snapping = (p: { ctrl?: boolean; ctrlKey?: boolean; metaKey?: boolean }) => useStore.getState().snap !== !!(p.ctrl || p.ctrlKey || p.metaKey)
/** A connection in the hand: the end that is fixed, where the loose end is, and what it has caught. */
interface Wire { from: string; to: [number, number]; target: string | null; side?: Side; bad?: boolean; relink?: { id: string; end: 'from' | 'to' } }
/** drags that carry something across the ground, which the view follows when the pointer reaches its edge */
const CARRIES = new Set(['move', 'connect', 'relink', 'seg', 'resize', 'nresize'])
const EDGE_ZONE = 30

export function Canvas() {
  const ref = useRef<SVGSVGElement>(null)
  const doc = useStore((s) => s.doc)
  const view = useStore((s) => s.view)
  const yaw = useStore((s) => s.yaw)
  const pitch = useStore((s) => s.pitch)
  const selection = useStore((s) => s.selection)
  const tool = useStore((s) => s.tool)
  const placing = useStore((s) => s.placing)
  const themeName = useStore((s) => s.theme)
  const showGrid = useStore((s) => s.showGrid)
  const showLabels = useStore((s) => s.showLabels)
  const flow = useStore((s) => s.flow)
  const lens = useStore((s) => s.lens)
  const pricing = useStore((s) => s.pricing)

  const proj = useMemo(() => makeCam(yaw, pitch), [yaw, pitch])
  const theme = THEMES[themeName]
  const ACCENT = theme.accent
  const fresh = useStore((s) => s.fresh)
  const [moving, setMoving] = useState(false)
  // components build in when a blueprint opens
  const [intro, setIntro] = useState(true)
  useEffect(() => { setIntro(true); const t = setTimeout(() => setIntro(false), 1500); return () => clearTimeout(t) }, [doc.id])
  const drag = useRef<Drag | null>(null)
  const space = useRef(false)
  // ---- what is in the hand. None of this is the blueprint: it is drawn over it while a drag lasts and written once, when it ends.
  // The panels, the autosave and the undo history never see the frames in between.
  const [liveDoc, setLiveDoc] = useState<Doc | null>(null)
  const liveRef = useRef<Doc | null>(null)
  const setLive = (d: Doc | null) => { liveRef.current = d; setLiveDoc(d) }
  const [gaps, setGaps] = useState<Gap[]>([])
  const [dropArea, setDropArea] = useState<string | null>(null)
  const [hover, setHoverState] = useState<string | null>(null)
  const hoverRef = useRef<string | null>(null)
  const setHover = (id: string | null) => { if (hoverRef.current !== id) { hoverRef.current = id; setHoverState(id) } }
  const [picking, setPicking] = useState<string[]>([])
  const [splice, setSplice] = useState<string | null>(null)
  const [quick, setQuick] = useState<{ x: number; y: number; wx: number; wy: number; from: string } | null>(null)
  const lastPtr = useRef<Ptr | null>(null)
  const scrollRaf = useRef(0)
  const [ghost, setGhost] = useState<{ at: [number, number] } | null>(null)
  const [wire, setWireState] = useState<Wire | null>(null)
  const wireRef = useRef<Wire | null>(null)
  const setWire = (w: Wire | null) => { wireRef.current = w; setWireState(w) }
  const [marquee, setMarqueeState] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const [draft, setDraftState] = useState<{ x: number; y: number; w: number; d: number } | null>(null)
  // a quick drag can end before the next render, so pointer-up reads the live shapes from refs
  const draftRef = useRef<typeof draft>(null)
  const marqueeRef = useRef<typeof marquee>(null)
  const setDraft = (v: typeof draft) => { draftRef.current = v; setDraftState(v) }
  const setMarquee = (v: typeof marquee) => { marqueeRef.current = v; setMarqueeState(v) }
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [panning, setPanning] = useState(false)
  const [orbiting, setOrbiting] = useState(false)
  // touch: where each finger is, the two-finger gesture in progress, and the press-and-hold timer
  const fingers = useRef(new Map<number, Finger>())
  const gesture = useRef<Gesture | null>(null)
  const landed = useRef({ first: 0, pair: 0 })
  const trail = useRef<Trail[]>([])
  const lastTap = useRef<{ t: number; x: number; y: number } | null>(null)
  // what a two-finger gesture is doing right now, shown as a small read-out while it lasts
  const [reading, setReading] = useState<'turn' | 'tilt' | null>(null)
  const press = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [guides, setGuides] = useState<Guide[]>([])
  const guideKey = useRef('')
  const linkFrom = useStore((s) => s.linkFrom)
  // fingers need bigger handles than a mouse does
  const coarse = useMemo(() => typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches, [])
  useEffect(() => () => { clearTimeout(press.current); cancelAnimationFrame(scrollRaf.current) }, [])
  // a connection waiting for its other end only makes sense while the connect tool is up
  useEffect(() => { if (tool !== 'connect' && useStore.getState().linkFrom) useStore.setState({ linkFrom: null }) }, [tool])

  const sel = useMemo(() => new Set(selection), [selection])
  // what is drawn: the blueprint, or the blueprint with whatever is in the hand
  const shown = liveDoc ?? doc
  const routes = useRoutes(shown)
  const trace = useStore((s) => s.trace)
  const focus = useMemo(() => (trace ? traceFlow(doc, trace) : null), [doc, trace])

  const lensMap = useMemo(() => {
    if (lens !== 'cost') return null
    const c = docCost(doc, pricing)
    const max = Math.max(1, ...[...c.perNode.values()].map((v) => v.monthly))
    return new Map(doc.nodes.map((n) => {
      const m = c.perNode.get(n.id)?.monthly ?? 0
      return [n.id, { color: heat(m / max), note: m > 0 ? money(m) + '/mo' : undefined }]
    }))
  }, [lens, doc, pricing])

  // ---- viewport size
  useEffect(() => {
    const el = ref.current!
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect()
      const first = cam.w === 1200 && cam.h === 800
      cam.w = r.width; cam.h = r.height; cam.left = r.left; cam.top = r.top
      if (first) fitView(undefined, false)
    })
    ro.observe(el)
    const r = el.getBoundingClientRect()
    cam.w = r.width; cam.h = r.height; cam.left = r.left; cam.top = r.top
    fitView(undefined, false)
    return () => ro.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.id])

  const toWorld = (cx: number, cy: number, p: Proj = proj): [number, number] => {
    const r = ref.current!.getBoundingClientRect()
    const v = useStore.getState().view
    return unproject(p, (cx - r.left - v.x) / v.k, (cy - r.top - v.y) / v.k)
  }
  const nodeAt = (cx: number, cy: number) => {
    const el = document.elementFromPoint(cx, cy)?.closest('[data-kind="node"]') as HTMLElement | null
    return el?.dataset.id ?? null
  }

  // ---- wheel zoom / pan
  useEffect(() => {
    const el = ref.current!
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const r = el.getBoundingClientRect()
      const { view } = useStore.getState()
      const mouseWheel = e.deltaMode !== 0 || (e.deltaX === 0 && Math.abs(e.deltaY) >= 40 && Number.isInteger(e.deltaY))
      if (e.ctrlKey || e.metaKey || mouseWheel) {
        const dy = e.deltaMode === 1 ? e.deltaY * 30 : e.deltaY
        if (mouseWheel) smoothZoom(Math.exp(-dy * 0.0022), e.clientX - r.left, e.clientY - r.top)
        else useStore.setState({ view: zoomBy(Math.exp(-dy * 0.012), e.clientX - r.left, e.clientY - r.top) })
      } else {
        useStore.setState({ view: { ...view, x: view.x - e.deltaX, y: view.y - e.deltaY } })
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  // ---- space-to-pan
  useEffect(() => {
    const typing = (e: KeyboardEvent) => /INPUT|TEXTAREA|SELECT/.test((e.target as HTMLElement)?.tagName ?? '')
    const down = (e: KeyboardEvent) => { if (e.code === 'Space' && !typing(e)) { space.current = true; setPanning(true); e.preventDefault() } }
    const up = (e: KeyboardEvent) => { if (e.code === 'Space') { space.current = false; setPanning(false) } }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up) }
  }, [])

  // ---- Escape puts back whatever is in the hand, exactly as it was
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const d = drag.current
      if (!d || !(CARRIES.has(d.mode) || d.mode === 'marquee' || d.mode === 'area') || (d.mode === 'move' && !d.active)) return
      // copies made by this very drag go too
      if (d.mode === 'move' && d.cloned) useStore.getState().undo()
      drag.current = null
      dropHand()
      e.stopImmediatePropagation(); e.preventDefault()
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---- placing from the palette (pointer-driven drag & drop)
  useEffect(() => {
    if (!placing) { setGhost(null); setSplice(null); return }
    const over = (e: PointerEvent) => {
      const r = ref.current!.getBoundingClientRect()
      return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom &&
        !!(document.elementFromPoint(e.clientX, e.clientY)?.closest('.canvas-svg'))
    }
    const at = (e: PointerEvent): [number, number] => {
      const [wx, wy] = toWorld(e.clientX, e.clientY, projNow())
      return [wx - 1, wy - 1]
    }
    // it goes exactly where it is pointed, and where it is shown is where it is put. With snapping on that is the nearest whole cell
    const spot = (e: PointerEvent): [number, number] => { const [x, y] = at(e), on = snapping(e); return [put(x, 1, on), put(y, 1, on)] }
    // a connection under the pointer: letting go there puts the new component in the middle of it
    const lineAt = (e: PointerEvent) => {
      const el = document.elementFromPoint(e.clientX, e.clientY)
      return el?.closest('[data-kind="node"]') ? null : (el?.closest('[data-kind="edge"]') as HTMLElement | null)?.dataset.id ?? null
    }
    const move = (e: PointerEvent) => {
      if (!over(e)) { setGhost(null); setSplice(null); showGuides([]); return }
      const [x, y] = spot(e)
      setGhost({ at: [x, y] })
      setSplice(lineAt(e))
      const nodes = useStore.getState().doc.nodes
      showGuides(alignGuides([...nodes, { id: '~new', type: 'block', x, y, props: {} }], new Set(['~new']), level()))
    }
    const up = (e: PointerEvent) => {
      showGuides([]); setSplice(null)
      if (!over(e)) return
      const [x, y] = spot(e)
      const st = useStore.getState(), into = lineAt(e)
      if (into) { st.addLinked(st.placing!, x, y, { into }); haptic(10) } else st.addNode(st.placing!, x, y)
      if (!e.shiftKey) st.set({ placing: null })
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placing])

  const onPointerDown = (e: React.PointerEvent) => {
    setMenu(null)
    if (placing) return
    if (quick) closeQuick()
    const st = useStore.getState()
    const target = e.target as HTMLElement
    const touch = e.pointerType === 'touch'
    try { ref.current!.setPointerCapture(e.pointerId) } catch { /* a pointer that is already gone cannot be captured */ }
    if (touch) {
      const r = ref.current!.getBoundingClientRect()
      const now = performance.now()
      // a finger on the glass stops whatever the camera was doing
      holdStill()
      fingers.current.set(e.pointerId, { x: e.clientX - r.left, y: e.clientY - r.top })
      if (fingers.current.size === 2) {
        // a second finger turns whatever the first was doing into a camera gesture
        const d = drag.current
        const idle = !d || d.mode === 'touch' || d.mode === 'dtap' || (d.mode === 'pan' && !d.moved)
        clearTimeout(press.current)
        // a move in progress ends where it is: a second finger should not throw away a long carry
        if (d?.mode === 'move' && d.active && liveRef.current && (d.lx || d.ly)) st.apply(() => liveRef.current!, d.cloned)
        drag.current = null
        lastTap.current = null
        dropHand()
        const [a, b] = [...fingers.current.values()]
        // only fingers that land together, with nothing else going on, can be a tilt
        gesture.current = gestureStart(a, b, idle && now - landed.current.first < 300)
        landed.current.pair = now
        setPanning(true)
      }
      if (fingers.current.size >= 2) return
      landed.current.first = now
    }
    const hitEl = target.closest('[data-kind], [data-handle]')
    // orbit: right-drag anywhere, alt-drag on empty ground, or any drag with the orbit tool
    if (e.button === 2 || (e.button === 0 && (st.tool === 'orbit' || (e.altKey && !hitEl)))) {
      const r = ref.current!.getBoundingClientRect()
      drag.current = { mode: 'orbit', sx: e.clientX, sy: e.clientY, moved: false, button: e.button, update: beginOrbit(e.clientX - r.left, e.clientY - r.top) }
      return
    }
    if (e.button === 1 || space.current) {
      drag.current = { mode: 'pan', sx: e.clientX, sy: e.clientY, vx: st.view.x, vy: st.view.y, moved: true }
      setPanning(true)
      return
    }
    const [wx, wy] = toWorld(e.clientX, e.clientY)
    const grip = target.closest('[data-handle]') as HTMLElement | null
    let handle = grip?.dataset.handle
    let hit = target.closest('[data-kind]') as HTMLElement | null
    // A door's finger-sized target is invisible and, when the view is small, reaches over the body of its own component.
    // What the finger is on is what it can see: where the two overlap, the press is on the component, not the door
    if (handle === 'connect' && target.getAttribute('fill') === 'transparent') {
      const body = (document.elementsFromPoint?.(e.clientX, e.clientY) ?? []).map((el) => el.closest('.nd-body')?.closest('[data-kind="node"]') as HTMLElement | null).find((el) => !!el)
      if (body && body.dataset.id === (grip!.dataset.id ?? st.selection[0])) { handle = undefined; hit = body }
    }
    const kind = hit?.dataset.kind
    const id = hit?.dataset.id

    if (handle === 'connect') {
      // any door of a component starts a connection from it, whether or not it is selected
      const from = (target.closest('[data-handle]') as HTMLElement).dataset.id ?? st.selection[0]
      drag.current = { mode: 'connect', from, sx: e.clientX, sy: e.clientY }
      setWire({ from, to: [wx, wy], target: null })
      if (touch) haptic(6)
      return
    }
    if (handle && /^[sc]\d+$/.test(handle)) {
      // a run of the selected connection: pulled sideways, it moves. A turn: both runs that meet at it go where it goes
      grabRun(st.selection[0], Number(handle.slice(1)), e.clientX, e.clientY, handle[0] === 'c')
      // a finger that rests on the line and lifts without pulling it is asking for the line's menu. It is only known
      // when the finger lifts: a slow start to a pull must never be cut short by a menu
      if (touch && drag.current?.mode === 'seg') drag.current.rested = performance.now()
      return
    }
    if (handle === 'ea' || handle === 'eb') {
      const e = st.doc.edges.find((x) => x.id === st.selection[0])
      if (e) drag.current = { mode: 'relink', id: e.id, end: handle === 'ea' ? 'from' : 'to', active: false, sx: 0, sy: 0 }
      return
    }
    if (handle && handle.startsWith('n')) {
      const n = st.doc.nodes.find((x) => x.id === st.selection[0])
      if (n) drag.current = { mode: 'nresize', id: n.id, corner: Number(handle[1]), base: n, active: false, wx, wy }
      return
    }
    if (handle && handle.startsWith('r')) {
      const a = st.doc.areas.find((x) => x.id === st.selection[0])
      if (a) drag.current = { mode: 'resize', id: a.id, corner: Number(handle[1]), base: a, active: false, wx, wy }
      return
    }
    if (st.tool === 'text' && !hit) {
      st.addLabel(put(wx, 0.5, snapping(e)), put(wy, 0.5, snapping(e)))
      st.set({ tool: 'select', panel: 'inspect' })
      return
    }
    if (st.tool === 'area') {
      drag.current = { mode: 'area', wx: put(wx, 1, snapping(e)), wy: put(wy, 1, snapping(e)) }
      return
    }
    if (st.tool === 'connect') {
      if (kind === 'node' && id) {
        drag.current = { mode: 'connect', from: id, sx: e.clientX, sy: e.clientY }
        setWire({ from: id, to: [wx, wy], target: null })
      } else drag.current = { mode: 'pan', sx: e.clientX, sy: e.clientY, vx: st.view.x, vy: st.view.y, moved: false }
      return
    }
    // a second tap on bare ground, straight after the first: lift to zoom in, or slide to zoom with one thumb
    const tapped = lastTap.current
    if (touch && st.tool === 'select' && !id && tapped && performance.now() - tapped.t < 320 && Math.hypot(e.clientX - tapped.x, e.clientY - tapped.y) < 40) {
      lastTap.current = null
      drag.current = { mode: 'dtap', sx: e.clientX, sy: e.clientY, view: st.view, moved: false }
      return
    }
    // touch, select tool: dragging something that is already selected moves it; anything else waits to
    // see whether this is a tap (select), a drag (pan) or a press-and-hold (pick up, or the menu)
    if (touch && st.tool === 'select' && !(id && kind && kind !== 'edge' && st.selection.includes(id) && !st.multi)) {
      drag.current = { mode: 'touch', id: id ?? null, kind: kind ?? null, sx: e.clientX, sy: e.clientY, vx: st.view.x, vy: st.view.y, wx, wy }
      clearTimeout(press.current)
      press.current = setTimeout(() => longPress(), HOLD_MS)
      return
    }
    if (id && kind) {
      if (e.shiftKey) st.select([id], true)
      else if (!st.selection.includes(id)) st.select([id])
      if (kind === 'edge') {
        // a line can be taken hold of anywhere along it, selected or not: pressing picks it, pulling moves the run under the pointer
        if (!e.shiftKey) { const r = routes.get(id); if (r) grabRun(id, nearestRun(r.pts, [wx, wy]), e.clientX, e.clientY) }
        return
      }
      const selNow = useStore.getState().selection
      const onlyFree = selNow.every((s) => kindOf(st.doc, s) === 'label')
      drag.current = { mode: 'move', wx, wy, sx: e.clientX, sy: e.clientY, base: st.doc, active: false, step: onlyFree ? 0.5 : 1, lx: 0, ly: 0, home: null }
      return
    }
    if (e.shiftKey) {
      drag.current = { mode: 'marquee', sx: e.clientX, sy: e.clientY }
      return
    }
    drag.current = { mode: 'pan', sx: e.clientX, sy: e.clientY, vx: st.view.x, vy: st.view.y, moved: false }
  }

  const showGuides = (g: Guide[]) => {
    const key = g.map((x) => x.axis + x.at + ':' + x.from + ':' + x.to).join()
    if (key === guideKey.current) return false
    const more = g.length > guideKey.current.split(',').filter(Boolean).length
    guideKey.current = key
    setGuides(g)
    return more
  }

  /** Take hold of stretch `i` of a connection's drawn line, ready to move the run it belongs to; or, with `turn`, of the turn at point `i` of it. */
  const grabRun = (id: string, i: number, sx: number, sy: number, turn = false) => {
    const st = useStore.getState()
    const e = st.doc.edges.find((x) => x.id === id), r = routes.get(id)
    const a = e && st.doc.nodes.find((n) => n.id === e.from), b = e && st.doc.nodes.find((n) => n.id === e.to)
    const t = r && a && b ? trackOf(r, a, b) : null
    if (!t || !r || !a || !b) return
    const L = coordsOf(t.track, a, b)
    const hold = (k: number) => { const p = r.pts[k], q = r.pts[k + 1]; return p && q ? { run: t.seg[k], axis: p[1] === q[1] ? 'y' as const : 'x' as const, from: L[t.seg[k]] } : null }
    const held = (turn ? [hold(i - 1), hold(i)] : [hold(i)]).filter((h): h is NonNullable<typeof h> => !!h)
    if (held.length !== (turn ? 2 : 1) || (turn && held[0].run === held[1].run)) return
    const [wx, wy] = toWorld(sx, sy)
    drag.current = { mode: 'seg', id, held, track: t.track, last: t.track, turns: t.track.runs.length, active: false, base: st.doc, sx, sy, wx, wy }
  }

  /** Put down whatever is in the hand without keeping it. */
  const dropHand = () => {
    cancelAnimationFrame(scrollRaf.current); scrollRaf.current = 0
    setLive(null); setMoving(false); setWire(null); setDraft(null); setMarquee(null); showGuides([]); setGaps([]); setDropArea(null); setPicking([])
  }
  const closeQuick = () => { setQuick(null); setWire(null) }
  /** The group a component would belong to where it stands: the smallest area around it. */
  const areaOf = (d: Doc, ids: Set<string>) => {
    const n = d.nodes.find((x) => ids.has(x.id))
    if (!n) return null
    return d.areas.filter((a) => !ids.has(a.id) && inArea(a, n)).sort((a, b) => a.w * a.d - b.w * b.d)[0]?.id ?? null
  }
  /** A component's four doors. The one on the side its name is written sits further out, clear of the text. */
  const doors = (n: NodeT, p: Proj = proj) => {
    const ports = portsOf(n)
    if (!useStore.getState().showLabels) return ports
    const v = upright(p).v, side: Side = v[0] > 0 ? 'e' : v[0] < 0 ? 'w' : v[1] > 0 ? 's' : 'n'
    ports[side] = portsOf(n, 1.05)[side]
    return ports
  }
  /** How nearly level two things must be for the line that says so to show: about a pixel on screen. It is a remark, not a correction. */
  const level = () => Math.max(0.01, 1 / (U * useStore.getState().view.k))

  /** One step of a drag that carries something across the ground. Also run by the view when it follows the pointer at the edge. */
  const carry = (d: Drag, p: Ptr) => {
    const st = useStore.getState()
    if (d.mode === 'move') {
      if (!d.active) {
        if (Math.hypot(p.x - d.sx, p.y - d.sy) < (p.touch ? TOUCH_SLOP : 4)) return
        d.active = true
        setMoving(true)
        // alt-drag clones the selection and moves the copies
        if (p.alt) { st.duplicate(st.selection, 0, 0); d.base = useStore.getState().doc; d.cloned = true }
        d.home = areaOf(d.base, new Set(useStore.getState().selection))
        const held = useStore.getState().selection.map((id) => d.base.nodes.find((n) => n.id === id) ?? d.base.areas.find((a) => a.id === id) ?? d.base.labels.find((l) => l.id === id)).find((x) => !!x)
        d.ax = held?.x; d.ay = held?.y
      }
      const [wx, wy] = toWorld(p.x, p.y)
      // exactly as far as the pointer has gone, and no further
      let dx = r3(wx - d.wx), dy = r3(wy - d.wy)
      // shift keeps the move to one axis: whichever it has gone furthest along
      if (p.shift) { if (Math.abs(dx) >= Math.abs(dy)) dy = 0; else dx = 0 }
      // with snapping on, the thing in the hand goes from one grid position to the next as it is carried, so what is shown is still what is kept
      if (snapping(p) && d.ax !== undefined && d.ay !== undefined) { dx = put(d.ax + dx, d.step, true) - d.ax; dy = put(d.ay + dy, d.step, true) - d.ay }
      if (dx === d.lx && dy === d.ly && liveRef.current) return
      d.lx = dx; d.ly = dy
      const ids = new Set(useStore.getState().selection)
      const next = moveItems(d.base, d.base, ids, dx, dy)
      // a line appears whenever what is being moved comes level with something else, with a tick under the finger. It only says so: nothing is moved to make it true
      if (showGuides(alignGuides(next.nodes, ids, level())) && p.touch) haptic(5)
      setGaps(spacingGaps(next.nodes, ids))
      const into = areaOf(next, ids)
      setDropArea(into !== d.home ? into : null)
      setLive(next)
    } else if (d.mode === 'resize') {
      d.active = true
      const on = snapping(p), [px, py] = toWorld(p.x, p.y)
      const b = d.base
      let x0 = b.x, y0 = b.y, x1 = b.x + b.w, y1 = b.y + b.d
      // the corner goes as far as the pointer has gone
      const left = d.corner === 0 || d.corner === 3, top = d.corner === 0 || d.corner === 1
      const wx = put((left ? x0 : x1) + px - d.wx, 0.5, on), wy = put((top ? y0 : y1) + py - d.wy, 0.5, on)
      if (d.corner === 0 || d.corner === 3) x0 = Math.min(wx, x1 - 1); else x1 = Math.max(wx, x0 + 1)
      if (d.corner === 0 || d.corner === 1) y0 = Math.min(wy, y1 - 1); else y1 = Math.max(wy, y0 + 1)
      setLive({ ...st.doc, areas: st.doc.areas.map((a) => (a.id === d.id ? { ...a, x: x0, y: y0, w: r3(x1 - x0), d: r3(y1 - y0) } : a)) })
    } else if (d.mode === 'nresize') {
      // components stay square: the corner opposite the one being dragged is pinned. The size is whatever the pointer makes it, or half cells with snapping on
      d.active = true
      const [wx, wy] = toWorld(p.x, p.y)
      const b = d.base, fs = footOf(b)
      const left = d.corner === 0 || d.corner === 3, top = d.corner === 0 || d.corner === 1
      const ax = left ? b.x + fs : b.x, ay = top ? b.y + fs : b.y
      // it grows by as much as the pointer has moved outwards, along whichever axis that is more
      const want = fs + Math.max(left ? d.wx - wx : wx - d.wx, top ? d.wy - wy : wy - d.wy)
      const size = Math.max(2 * MIN_SCALE, Math.min(2 * MAX_SCALE, put(want, 0.5, snapping(p))))
      const x = left ? r3(ax - size) : ax, y = top ? r3(ay - size) : ay
      setLive({ ...st.doc, nodes: st.doc.nodes.map((n) => (n.id === d.id ? { ...n, x, y, scale: size / 2 } : n)) })
    } else if (d.mode === 'seg') {
      if (!d.active) {
        if (Math.hypot(p.x - d.sx, p.y - d.sy) < (p.touch ? TOUCH_SLOP : 4)) return
        d.active = true
        setMoving(true)
      }
      const edge = d.base.edges.find((x) => x.id === d.id), a = edge && d.base.nodes.find((n) => n.id === edge.from), b = edge && d.base.nodes.find((n) => n.id === edge.to)
      if (!edge || !a || !b) return
      const [wx, wy] = toWorld(p.x, p.y)
      // It goes exactly as far as the pointer has gone, with one courtesy: brought within a few pixels of level with the next run
      // along, it is level, so a turn can be taken out without a pixel-perfect hand and no hair of a kink is left behind. Alt holds
      // that off. Everything else that might draw it (the middle of a component, a half cell) only does with snapping on (Ctrl flips it)
      const cell = U * st.view.k
      const tol = p.alt ? 0 : (p.touch ? 7 : 4) / cell, pull = !p.alt && st.snap !== p.ctrl ? (p.touch ? 10 : 6) / cell : 0
      const to = d.held.map((h) => {
        const v = h.from + (h.axis === 'y' ? wy - d.wy : wx - d.wx)
        h.on = alignRun(d.track, a, b, h.run, v, tol, h.on) ?? undefined
        return h.on ?? snapRun(d.track, a, b, h.run, v, pull)
      })
      // the later run first: if it steps round a corner it adds runs after itself, which leaves the earlier one where it was in the row
      let next = d.track
      for (let i = d.held.length - 1; i >= 0; i--) next = dragRun(next, a, b, d.held[i].run, to[i])
      if (JSON.stringify(next) === JSON.stringify(d.last) && liveRef.current) return
      d.last = next
      // a tick under the finger each time a turn drops out of the line or comes back into it
      const turns = simplify(next, a, b).runs.length
      if (turns !== d.turns) { d.turns = turns; if (p.touch) haptic(5) }
      setLive({ ...d.base, edges: d.base.edges.map((x) => (x.id === d.id ? withTrack(x, next) : x)) })
    } else if (d.mode === 'connect' || d.mode === 'relink') {
      if (d.mode === 'relink' && !d.active) { d.active = true; setMoving(true) }
      const to = toWorld(p.x, p.y), k = U * st.view.k
      const edge = d.mode === 'relink' ? st.doc.edges.find((x) => x.id === d.id) : null
      // the end that stays put: where a new connection starts, or the other end of the one being moved
      const from = d.mode === 'connect' ? d.from : edge ? (d.end === 'from' ? edge.to : edge.from) : ''
      // near enough is good enough: the loose end is drawn to the nearest component within reach
      const t = magnet(st.doc.nodes, to, Math.max(0.9, (p.touch ? 44 : 26) / k), d.mode === 'connect' ? d.from : undefined, nodeAt(p.x, p.y))
      const side = t ? doorNear(doors(t), to, Math.max(0.32, (p.touch ? 24 : 13) / k)) : undefined
      const bad = !!t && (d.mode === 'connect' ? st.doc.edges.some((x) => (x.from === from && x.to === t.id) || (x.from === t.id && x.to === from)) : t.id === from)
      // a tick under the finger each time the loose end catches something new
      if (p.touch && t && wireRef.current?.target !== t.id) haptic(5)
      setWire({ from, to, target: t?.id ?? null, side, bad, relink: d.mode === 'relink' ? { id: d.id, end: d.end } : undefined })
    }
  }

  /** How hard the pointer is pushing against each edge of the canvas, in pixels per frame. */
  const edgePush = (p: Ptr): [number, number] => {
    // the edges that count are those of the ground left clear by the panels, since that is all there is to see
    const r = ref.current!.getBoundingClientRect(), i = insets()
    const f = (d: number) => (d < EDGE_ZONE ? Math.min(1, 1 - d / EDGE_ZONE) : 0)
    return [(f(r.right - i.r + 12 - p.x) - f(p.x - r.left - i.l + 12)) * 14, (f(r.bottom - p.y) - f(p.y - r.top - i.t + 30)) * 14]
  }
  /** While something is carried to the edge of the canvas, the view moves on so it can be taken further. */
  const follow = () => {
    scrollRaf.current = 0
    const d = drag.current, p = lastPtr.current
    if (!d || !p || !CARRIES.has(d.mode) || ('active' in d && !d.active)) return
    const [vx, vy] = edgePush(p)
    if (!vx && !vy) return
    const v = useStore.getState().view
    useStore.setState({ view: { ...v, x: v.x - vx, y: v.y - vy } })
    carry(d, p)
    scrollRaf.current = requestAnimationFrame(follow)
  }

  /** Move the camera to where the two fingers are now. */
  const stepGesture = () => {
    const g = gesture.current
    if (!g || fingers.current.size < 2) return
    const [a, b] = [...fingers.current.values()]
    const s = useStore.getState()
    const was = { turning: g.turning, kind: g.kind }
    const next = gestureMove(g, a, b, { view: s.view, yaw: s.yaw, pitch: s.pitch }, center())
    // a tick when the camera lets go into a turn or a tilt, and when a tilt reaches the end of its travel
    if ((g.turning && !was.turning) || (g.kind === 'tilt' && was.kind !== 'tilt')) { haptic(8); setReading(g.kind === 'tilt' ? 'tilt' : 'turn') }
    if (next.pitch !== s.pitch && (next.pitch >= MAX_PITCH || next.pitch <= MIN_PITCH)) haptic(10)
    useStore.setState({ view: next.view, yaw: next.yaw, pitch: next.pitch, flat: next.pitch >= 89.5 })
  }

  /** A finger has rested in one place: pick up what is under it, or open the menu on bare ground. */
  const longPress = () => {
    const d = drag.current
    if (!d || d.mode !== 'touch') return
    const st = useStore.getState()
    haptic(12)
    if (d.id && d.kind !== 'edge') {
      if (st.multi) { if (!st.selection.includes(d.id)) st.select([d.id], true) } else st.select([d.id])
      const onlyFree = useStore.getState().selection.every((s) => kindOf(st.doc, s) === 'label')
      drag.current = { mode: 'move', wx: d.wx, wy: d.wy, sx: d.sx, sy: d.sy, base: st.doc, active: false, step: onlyFree ? 0.5 : 1, lx: 0, ly: 0, home: null }
      setMoving(true) // the selection lifts straight away, so the hold is felt before the drag
      return
    }
    drag.current = null
    openMenuAt(d.sx, d.sy)
  }

  const onPointerMove = (e: React.PointerEvent) => {
    if (e.pointerType === 'touch' && fingers.current.has(e.pointerId)) {
      const r = ref.current!.getBoundingClientRect()
      fingers.current.set(e.pointerId, { x: e.clientX - r.left, y: e.clientY - r.top })
      if (gesture.current) {
        // both fingers report separately: wait for the frame so the camera moves once, with both in place
        if (fingers.current.size >= 2) onFrame(stepGesture)
        return
      }
    }
    const d = drag.current
    if (hud.el) {
      const [hx, hy] = toWorld(e.clientX, e.clientY)
      const n = (v: number) => (v < 0 ? '-' : '+') + String(Math.abs(Math.round(v))).padStart(3, '0')
      hud.el.textContent = `X ${n(hx)}  Y ${n(hy)}`
    }
    if (!d) { if (e.pointerType !== 'touch') trackHover(e); return }
    const st = useStore.getState()
    if (CARRIES.has(d.mode)) {
      const p: Ptr = { x: e.clientX, y: e.clientY, shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey || e.metaKey, touch: e.pointerType === 'touch' }
      lastPtr.current = p
      carry(d, p)
      if (!scrollRaf.current && edgePush(p).some(Boolean)) scrollRaf.current = requestAnimationFrame(follow)
      return
    }
    if (d.mode === 'touch') {
      // it moved before the hold was up: this is a pan
      if (Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < TOUCH_SLOP) return
      clearTimeout(press.current)
      drag.current = { mode: 'pan', sx: d.sx, sy: d.sy, vx: d.vx, vy: d.vy, moved: true }
      setPanning(true)
      trail.current = []
      track(trail.current, performance.now(), e.clientX, e.clientY)
      st.set({ view: { ...st.view, x: d.vx + e.clientX - d.sx, y: d.vy + e.clientY - d.sy } })
      return
    }
    if (d.mode === 'dtap') {
      const dy = e.clientY - d.sy
      if (!d.moved && Math.abs(dy) < TOUCH_SLOP) return
      if (!d.moved) { d.moved = true; d.sy += Math.sign(dy) * TOUCH_SLOP; setPanning(true) }
      // down zooms in, up zooms out, about the spot that was tapped
      const r = ref.current!.getBoundingClientRect()
      const cx = d.sx - r.left, cy = d.sy - r.top
      const k = Math.max(MIN_K, Math.min(MAX_K, d.view.k * Math.exp((e.clientY - d.sy) * 0.01)))
      st.set({ view: { k, x: cx - ((cx - d.view.x) * k) / d.view.k, y: cy - ((cy - d.view.y) * k) / d.view.k } })
      return
    }
    if (d.mode === 'pan') {
      const dx = e.clientX - d.sx, dy = e.clientY - d.sy
      if (!d.moved && Math.hypot(dx, dy) < 4) return
      if (!d.moved) { d.moved = true; setPanning(true) }
      if (e.pointerType === 'touch') track(trail.current, performance.now(), e.clientX, e.clientY)
      st.set({ view: { ...st.view, x: d.vx + dx, y: d.vy + dy } })
    } else if (d.mode === 'orbit') {
      const dx = e.clientX - d.sx, dy = e.clientY - d.sy
      if (!d.moved && Math.hypot(dx, dy) < 4) return
      if (!d.moved) { d.moved = true; setOrbiting(true) }
      d.update(dx, dy)
    } else if (d.mode === 'marquee') {
      const r = ref.current!.getBoundingClientRect()
      const m = { x: Math.min(d.sx, e.clientX) - r.left, y: Math.min(d.sy, e.clientY) - r.top, w: Math.abs(e.clientX - d.sx), h: Math.abs(e.clientY - d.sy) }
      setMarquee(m)
      // what the box has caught so far lights up as it grows
      const ids = inMarquee(m)
      setPicking((was) => (was.length === ids.length && was.every((x, i) => x === ids[i]) ? was : ids))
    } else if (d.mode === 'area') {
      const [wx, wy] = toWorld(e.clientX, e.clientY).map((v) => put(v, 1, snapping(e)))
      setDraft({ x: Math.min(d.wx, wx), y: Math.min(d.wy, wy), w: r3(Math.abs(wx - d.wx)), d: r3(Math.abs(wy - d.wy)) })
    }
  }

  /** Which component the pointer is over, or just beside: its doors show while it is. */
  const trackHover = (e: React.PointerEvent) => {
    const st = useStore.getState()
    if (st.tool !== 'select' || st.placing) return setHover(null)
    const t = e.target as Element
    let id = (t.closest?.('[data-handle="connect"]') as HTMLElement | null)?.dataset.id ?? (t.closest?.('[data-kind="node"]') as HTMLElement | null)?.dataset.id ?? null
    // the doors sit outside the body, so the pointer may leave it to reach one without losing them
    if (!id && hoverRef.current && !t.closest?.('[data-kind], [data-handle]')) {
      const n = st.doc.nodes.find((x) => x.id === hoverRef.current)
      if (n && reachTo(n, toWorld(e.clientX, e.clientY)) < 1.3) id = n.id
    }
    setHover(id)
  }

  /** Everything a selection box on screen has inside it. */
  const inMarquee = (m: { x: number; y: number; w: number; h: number }) => {
    const st = useStore.getState(), v = st.view
    const inside = (wx: number, wy: number) => {
      const q = pt(proj, wx, wy)
      const sx = q[0] * v.k + v.x, sy = q[1] * v.k + v.y
      return sx >= m.x && sx <= m.x + m.w && sy >= m.y && sy <= m.y + m.h
    }
    return [
      ...st.doc.nodes.filter((n) => inside(...centerOf(n))).map((n) => n.id),
      ...st.doc.areas.filter((a) => inside(a.x, a.y) && inside(a.x + a.w, a.y + a.d) && inside(a.x + a.w, a.y) && inside(a.x, a.y + a.d)).map((a) => a.id),
      ...st.doc.labels.filter((l) => inside(l.x, l.y)).map((l) => l.id),
    ]
  }

  const onPointerUp = (e: React.PointerEvent) => {
    clearTimeout(press.current)
    if (e.pointerType === 'touch') {
      const g = gesture.current
      if (g) flushFrame()
      const pair = [...fingers.current.keys()].slice(0, 2)
      fingers.current.delete(e.pointerId)
      if (g) {
        const left = [...fingers.current.values()]
        if (left.length >= 2) {
          // one of three or more lifted: the gesture carries on with the two that are left
          if (pair.includes(e.pointerId)) gestureRebase(g, left[0], left[1])
          return
        }
        gesture.current = null
        setReading(null)
        const s = useStore.getState()
        if (s.yaw < 0 || s.yaw >= 360) useStore.setState({ yaw: normYaw(s.yaw) })
        const r = ref.current!.getBoundingClientRect()
        if (isTwoFingerTap(g, performance.now() - landed.current.pair)) {
          // two fingers touched and left: step back out, about the spot between them
          haptic(6)
          animateView(zoomBy(0.5, (g.a.x + g.b.x) / 2, (g.a.y + g.b.y) / 2), 260)
          drag.current = null
          setPanning(false)
        } else if (left.length === 1) {
          // the finger still down carries on as a pan, from exactly where things are
          trail.current = []
          drag.current = { mode: 'pan', sx: left[0].x + r.left, sy: left[0].y + r.top, vx: s.view.x, vy: s.view.y, moved: true, quiet: true }
        } else { drag.current = null; setPanning(false) }
        return
      }
    }
    const d = drag.current
    drag.current = null
    cancelAnimationFrame(scrollRaf.current); scrollRaf.current = 0
    if (!space.current) setPanning(false)
    setMoving(false)
    showGuides([]); setGaps([]); setDropArea(null)
    if (!d) return
    const st = useStore.getState()
    if (d.mode === 'move') {
      // written once, as one step, and it is the very thing that was on screen: nothing is rounded, pushed aside or eased afterwards
      const to = liveRef.current
      setLive(null)
      if (d.active && to && (d.lx || d.ly)) st.apply(() => to, d.cloned)
      return
    }
    if (d.mode === 'resize' || d.mode === 'nresize') {
      const to = liveRef.current
      setLive(null)
      if (d.active && to) st.apply(() => to)
      return
    }
    if (d.mode === 'dtap') {
      if (d.moved) return
      haptic(6)
      const r = ref.current!.getBoundingClientRect()
      animateView(zoomBy(2, d.sx - r.left, d.sy - r.top), 260)
      return
    }
    if (d.mode === 'pan' && d.moved && e.pointerType === 'touch' && e.type !== 'pointercancel') {
      // a flick keeps going and eases to a stop; a finger that came to rest leaves the view where it is
      const v = fling(trail.current, performance.now())
      if (v && !(d.quiet && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 24)) glide(v[0], v[1])
      return
    }
    if (d.mode === 'touch') {
      // lifted without moving: a tap
      if (!d.id) { lastTap.current = st.tool === 'select' && e.type !== 'pointercancel' ? { t: performance.now(), x: e.clientX, y: e.clientY } : null; st.select([]); if (st.multi) st.set({ multi: false }); return }
      haptic(6)
      st.select([d.id], st.multi)
      return
    }
    if (d.mode === 'orbit') {
      setOrbiting(false)
      // a right-click that never became a drag is a context-menu request
      if (!d.moved && d.button === 2) openMenuAt(e.clientX, e.clientY)
      return
    }
    if (d.mode === 'seg') {
      setLive(null)
      if (!d.active) {
        if (d.rested !== undefined && e.type !== 'pointercancel' && performance.now() - d.rested >= HOLD_MS) {
          // after the tap that the lifting finger also counts as has been and gone, so it cannot land on the menu
          haptic(12); setTimeout(() => openMenuAt(d.sx, d.sy), 90)
        }
        return
      }
      const edge = d.base.edges.find((x) => x.id === d.id), a = edge && d.base.nodes.find((n) => n.id === edge.from), b = edge && d.base.nodes.find((n) => n.id === edge.to)
      if (!edge || !a || !b) return
      // turns that no longer do anything are taken out as it is put down; one step, and none at all if the line ends up as it began
      const next = withTrack(edge, simplify(d.last, a, b))
      if (JSON.stringify(next) !== JSON.stringify(edge)) st.apply((doc) => ({ ...doc, edges: doc.edges.map((x) => (x.id === d.id ? next : x)) }))
      return
    }
    if (d.mode === 'relink') {
      const w = wireRef.current
      setWire(null)
      if (!d.active) return
      const target = w?.target ? st.doc.nodes.find((n) => n.id === w.target) : null
      if (!target) return
      // aimed at a door: the line arrives there. Anywhere else on the component: the router picks the side, and goes on picking it as things move
      if (st.reconnect(d.id, d.end, target.id, w?.side)) haptic(10)
      else st.toast('A connection needs two different components', 'warn')
      return
    }
    if (d.mode === 'pan' && !d.moved) { st.select([]); if (st.linkFrom) st.set({ linkFrom: null }) }
    else if (d.mode === 'connect') {
      // where it was let go is what counts, even if the pointer never reported moving there
      if (e.type !== 'pointercancel') carry(d, { x: e.clientX, y: e.clientY, shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey || e.metaKey, touch: e.pointerType === 'touch' })
      const w = wireRef.current
      const link = (from: string, to: string, side?: Side) => {
        const id = st.addEdge(from, to)
        if (id) {
          // aimed at one door in particular: the line arrives there
          if (side) st.apply((doc) => ({ ...doc, edges: doc.edges.map((x) => (x.id === id ? { ...x, toSide: side } : x)) }), true)
          st.select([id]); haptic(10)
        } else {
          // they are joined already: show the line that joins them instead of leaving the hand empty
          const there = st.doc.edges.find((x) => (x.from === from && x.to === to) || (x.from === to && x.to === from))
          if (there) st.select([there.id])
          st.toast('Those components are already connected', 'warn')
        }
      }
      const t = w?.target ?? null
      const source = st.doc.nodes.find((n) => n.id === d.from)
      const [px, py] = toWorld(e.clientX, e.clientY)
      const onSelf = nodeAt(e.clientX, e.clientY) === d.from || (!t && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 6)
      if (t && !onSelf) { link(d.from, t, w?.side); if (st.linkFrom) st.set({ linkFrom: null }); setWire(null) }
      else if (onSelf && st.tool === 'connect') {
        // a tap rather than a drag: the first tap picks one end, the second picks the other
        if (st.linkFrom && st.linkFrom !== d.from) { link(st.linkFrom, d.from); st.set({ linkFrom: null, tool: 'select' }) }
        else { st.set({ linkFrom: st.linkFrom === d.from ? null : d.from }); haptic(6) }
        setWire(null)
      } else if (!onSelf && source && e.type !== 'pointercancel' && reachTo(source, [px, py]) > 1.4) {
        // let go on open ground: offer to put something there, already connected
        const r = ref.current!.getBoundingClientRect()
        setWire({ from: d.from, to: [px, py], target: null })
        setQuick({ x: e.clientX - r.left, y: e.clientY - r.top, wx: px, wy: py, from: d.from })
      } else setWire(null)
    } else if (d.mode === 'marquee') {
      const marquee = marqueeRef.current
      if (marquee && marquee.w + marquee.h > 6) st.select(inMarquee(marquee))
      setMarquee(null); setPicking([])
    } else if (d.mode === 'area') {
      const draft = draftRef.current
      if (draft && draft.w >= 1 && draft.d >= 1) {
        const n = st.doc.areas.length
        st.addArea({ ...draft, kind: n === 0 ? 'vpc' : 'subnet', name: n === 0 ? 'VPC' : 'Subnet ' + n, color: n === 0 ? '#8F6FF2' : ['#3DB87F', '#4F7FF2', '#E8A33D', '#E85C9C'][(n - 1) % 4] })
        st.set({ tool: 'select', panel: 'inspect' })
      }
      setDraft(null)
    }
  }

  const onContextMenu = (e: React.MouseEvent) => e.preventDefault()
  const openMenuAt = (cx: number, cy: number) => {
    const st = useStore.getState()
    // the pointer is captured by the canvas, so look up what is actually under it
    const under = document.elementFromPoint(cx, cy)
    const hit = (under?.closest('[data-kind]') ?? null) as HTMLElement | null
    // the selected connection wears its handles over the line: a press on one of those is a press on the line
    const worn = !hit && under?.closest('.edge-sel') && st.selection.length === 1 && st.doc.edges.some((e) => e.id === st.selection[0])
    const id = worn ? st.selection[0] : hit?.dataset.id
    if (id && !st.selection.includes(id)) st.select([id])
    if (!id) st.select([])
    const [wx, wy] = toWorld(cx, cy)
    setMenu({ x: cx, y: cy, wx, wy, target: worn ? 'edge' : id ? (hit!.dataset.kind as any) : null })
  }

  const onDoubleClick = (e: React.MouseEvent) => {
    // the canvas captures the pointer, so the event's own target is the canvas: look up what is under it
    const hit = (document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-kind]') ?? (e.target as HTMLElement).closest('[data-kind]')) as HTMLElement | null
    // while several things are being picked, two quick taps are two picks, not a request to edit
    if (useStore.getState().multi) return
    // on a turn of the selected connection: that turn is taken out
    const turn = (document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-handle]') as HTMLElement | null)?.dataset.handle
    if (turn && /^c\d+$/.test(turn)) { const st = useStore.getState(); st.removeBend(st.selection[0], Number(turn.slice(1))); return }
    // opens the inspector if it was put away, since a rename has to happen somewhere
    if (hit?.dataset.id) useStore.setState((s) => ({ panel: 'inspect', showInsp: true, ...(innerWidth <= 760 ? { showLib: false } : {}), focusName: s.focusName + 1 }))
  }

  // ---- overlay geometry
  const byId = useMemo(() => new Map(shown.nodes.map((n) => [n.id, n])), [shown.nodes])
  const selNodes = shown.nodes.filter((n) => sel.has(n.id))
  const selAreas = shown.areas.filter((a) => sel.has(a.id))
  const selEdges = shown.edges.filter((e) => sel.has(e.id))
  const selLabels = shown.labels.filter((l) => sel.has(l.id))
  const single = selection.length === 1 && selNodes.length === 1 ? selNodes[0] : null
  const foot = (x: number, y: number, o = 0.06, s = 2) => poly([pt(proj, x - o, y - o), pt(proj, x + s + o, y - o), pt(proj, x + s + o, y + s + o), pt(proj, x - o, y + s + o)])
  const gridOpacity = Math.max(0, Math.min(1, (view.k - 0.3) / 0.35))
  const cursor = orbiting ? 'move' : panning ? 'grabbing' : tool === 'orbit' ? 'move' : placing ? 'copy' : tool === 'connect' || tool === 'area' ? 'crosshair' : tool === 'text' ? 'text' : 'default'
  const wireFrom = wire ? byId.get(wire.from) : null
  const wireTarget = wire?.target ? byId.get(wire.target) : null
  const linkNode = linkFrom ? byId.get(linkFrom) : null

  const busy = moving || orbiting || panning || !!wire || !!placing
  // doors show on what the pointer is over and on the one thing selected; while a connection is in the hand, on what it has caught
  const hoverNode = hover && !busy && tool === 'select' ? byId.get(hover) : null
  const doorNodes = wire ? (wireTarget && !wire.bad ? [wireTarget] : []) : busy || tool !== 'select' ? [] : [...new Set([single, hoverNode].filter((n): n is NodeT => !!n))]
  const into = dropArea ? shown.areas.find((a) => a.id === dropArea) : null
  const fp = (x: number, y: number, o: number, s = 2) => brackets(proj, x - o, y - o, x + s + o, y + s + o, 0.55)
  // screen position of a point in the scene
  const toScreen = (wx: number, wy: number, wz = 0) => { const q = pt(proj, wx, wy, wz); return [q[0] * view.k + view.x, q[1] * view.k + view.y] }
  const barAt = selNodes.length ? (() => {
    const xs = selNodes.map((n) => centerOf(n)[0]), ys = selNodes.map((n) => centerOf(n)[1])
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2
    // anchor above the tallest point of the selection
    // (the body in a 3D view, the footprint's far edge when looking straight down)
    const tops = selNodes.flatMap((n) => { const fs = footOf(n), k = fs / 2; return [toScreen(n.x + k, n.y + k, ((HEIGHT[defOf(n.type).model] ?? 1.6) + 0.25) * k)[1], ...[[0, 0], [fs, 0], [0, fs], [fs, fs]].map(([dx, dy]) => toScreen(n.x + dx, n.y + dy)[1])] })
    return [toScreen(cx, cy, 0)[0], Math.min(...tops)]
  })() : null

  // one selected connection gets its own bar, where the line is: straighten it, change how it is drawn, hand it back to the router
  const oneEdge = selection.length === 1 && selEdges.length === 1 ? selEdges[0] : null
  const oneRoute = oneEdge ? routes.get(oneEdge.id) : null
  // it sits above the whole of the line, never on it: the line is what is being worked on
  const edgeBar = oneEdge && oneRoute ? (() => { const q = oneRoute.pts.map((p) => toScreen(p[0], p[1])); const xs = q.map((p) => p[0]); return [(Math.min(...xs) + Math.max(...xs)) / 2, Math.min(...q.map((p) => p[1])) - 16] })() : null
  const straight = oneEdge && oneRoute ? straightness(shown, oneEdge, oneRoute) : null

  return (
    <div className={'canvas-wrap' + (intro ? ' intro' : '') + (busy ? ' busy' : '')} data-tool={tool}>
      <svg ref={ref} className="canvas-svg" style={{ cursor }} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp} onPointerLeave={() => setHover(null)} onContextMenu={onContextMenu} onDoubleClick={onDoubleClick}>
        <defs>
          {/* dotted ground: a dot per cell, a stronger one every fourth. Each tile is shifted half a cell so one whole dot sits on the grid point: a quarter of the drawing of four clipped corner dots */}
          <pattern id="grid" x={-U / 2} y={-U / 2} width={U} height={U} patternUnits="userSpaceOnUse">
            <circle cx={U / 2} cy={U / 2} r={1.15} fill={theme.grid} />
          </pattern>
          <pattern id="grid-major" x={-U * 2} y={-U * 2} width={U * 4} height={U * 4} patternUnits="userSpaceOnUse">
            <circle cx={U * 2} cy={U * 2} r={1.9} fill={theme.gridMajor} />
          </pattern>
          <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="3.5" />
          </filter>
        </defs>
        <g transform={`translate(${f(view.x)} ${f(view.y)}) scale(${view.k})`}>
          {showGrid && (
            <g transform={`matrix(${proj.a} ${proj.c} ${proj.b} ${proj.d} 0 0)`} pointerEvents="none">
              {/* zoomed far out the fine dots have faded away, so they are not drawn at all */}
              {gridOpacity > 0 && <rect x={-300 * U} y={-300 * U} width={600 * U} height={600 * U} fill="url(#grid)" opacity={gridOpacity} />}
              <rect x={-300 * U} y={-300 * U} width={600 * U} height={600 * U} fill="url(#grid-major)" />
              {/* origin mark */}
              <path d={`M${-U * 0.5} 0H${U * 0.5}M0 ${-U * 0.5}V${U * 0.5}`} stroke={theme.gridMajor} strokeWidth={1.2} />
            </g>
          )}
          {/* selection marks sit under the scene so bodies occlude them naturally */}
          <g pointerEvents="none">
            {selNodes.map((n) => (
              <g key={n.id} className="sel-mark">
                <polygon points={foot(n.x, n.y, 0.1, footOf(n))} fill={ACCENT} fillOpacity={0.09} />
                <path d={fp(n.x, n.y, 0.1, footOf(n))} fill="none" stroke={ACCENT} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
              </g>
            ))}
            {/* where what is in the hand will come to rest */}
            {/* the group it is about to join */}
            {into && <polygon className="drop-area" points={poly([pt(proj, into.x, into.y), pt(proj, into.x + into.w, into.y), pt(proj, into.x + into.w, into.y + into.d), pt(proj, into.x, into.y + into.d)])} fill={ACCENT} fillOpacity={0.06} stroke={ACCENT} strokeOpacity={0.8} strokeWidth={1.5 / view.k} strokeLinejoin="round" />}
            {/* what a selection box has caught so far */}
            {picking.map((id) => { const n = byId.get(id); return n && !sel.has(id) ? <path key={'p' + id} className="picking" d={fp(n.x, n.y, 0.1, footOf(n))} fill="none" stroke={ACCENT} strokeOpacity={0.6} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" /> : null })}
            {/* a component's footprint answers the pointer before anything is pressed */}
            {hoverNode && !sel.has(hoverNode.id) && <path className="hover-mark" d={fp(hoverNode.x, hoverNode.y, 0.1, footOf(hoverNode))} fill="none" stroke={ACCENT} strokeOpacity={0.4} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />}
            {linkNode && (
              <g className="link-from">
                <polygon points={foot(linkNode.x, linkNode.y, 0.1, footOf(linkNode))} fill={ACCENT} fillOpacity={0.18} />
                <path d={fp(linkNode.x, linkNode.y, 0.1, footOf(linkNode))} fill="none" stroke={ACCENT} strokeWidth={2} strokeLinecap="round" />
              </g>
            )}
            {guides.map((g) => {
              const a = g.axis === 'x' ? pt(proj, g.at, g.from - 1.6) : pt(proj, g.from - 1.6, g.at)
              const b = g.axis === 'x' ? pt(proj, g.at, g.to + 1.6) : pt(proj, g.to + 1.6, g.at)
              return <line key={g.axis + g.at} className="guide" x1={f(a[0])} y1={f(a[1])} x2={f(b[0])} y2={f(b[1])} stroke={ACCENT} strokeOpacity={0.75} strokeWidth={1 / view.k} strokeDasharray={`${3 / view.k} ${4 / view.k}`} />
            })}
            {/* equal gaps: a measure across each, capped at both ends */}
            {gaps.map((g) => {
              const P = (along: number, across: number) => (g.axis === 'x' ? pt(proj, along, across) : pt(proj, across, along))
              const a = P(g.from, g.at), b = P(g.to, g.at), c = 0.22
              const cap = (v: number) => { const p = P(v, g.at - c), q = P(v, g.at + c); return `M${f(p[0])} ${f(p[1])}L${f(q[0])} ${f(q[1])}` }
              return <path key={g.axis + g.from + ':' + g.to} className="gap" d={`M${f(a[0])} ${f(a[1])}L${f(b[0])} ${f(b[1])}${cap(g.from)}${cap(g.to)}`} fill="none" stroke={ACCENT} strokeOpacity={0.85} strokeWidth={1.25 / view.k} strokeLinecap="round" />
            })}
            {wireTarget && (
              <g className={'wire-target' + (wire?.bad ? ' bad' : '')}>
                <polygon points={foot(wireTarget.x, wireTarget.y, 0.1, footOf(wireTarget))} fill={wire?.bad ? theme.textDim : ACCENT} fillOpacity={wire?.bad ? 0.08 : 0.18} />
                <path d={fp(wireTarget.x, wireTarget.y, 0.1, footOf(wireTarget))} fill="none" stroke={wire?.bad ? theme.textDim : ACCENT} strokeWidth={2} strokeLinecap="round" strokeDasharray={wire?.bad ? '3 5' : undefined} />
              </g>
            )}
          </g>
          <Scene doc={shown} proj={proj} theme={theme} showLabels={showLabels} flow={flow} lens={lensMap} fresh={fresh} routes={routes} focus={focus}
            lifted={moving && drag.current?.mode === 'move' ? sel : null} dim={wire?.relink?.id} />
          <g className="overlay">
            {selEdges.map((e) => {
              const a = byId.get(e.from), b = byId.get(e.to), r = routes.get(e.id)
              // while one of its ends is in the hand, the line is drawn where it is going, not where it was
              if (!a || !b || !r || wire?.relink?.id === e.id) return null
              const d = lineOf(proj, r)
              const editing = selection.length === 1 && tool === 'select'
              const P = (q: [number, number]) => pt(proj, q[0], q[1])
              // fingers get a generous invisible target around each small visible handle
              const grab = (c: [number, number], name: string) => coarse && <circle cx={c[0]} cy={c[1]} r={17 / view.k} fill="transparent" data-handle={name} />
              const last = r.pts.length - 1
              const held = drag.current?.mode === 'seg' && moving
              return (
                <g key={e.id} className={'edge-sel' + (held ? ' held' : '')}>
                  <g pointerEvents="none">
                    <path d={d} fill="none" stroke={ACCENT} strokeWidth={e.width + 5} strokeOpacity={0.35} strokeLinecap="round" filter="url(#glow)" />
                    <path d={d} fill="none" stroke={ACCENT} strokeWidth={e.width} strokeLinecap="round" strokeLinejoin="round" />
                    {/* both ends of the selected connection are marked, so it is plain what it joins */}
                    {[a, b].map((n) => <path key={n.id} d={fp(n.x, n.y, 0.12, footOf(n))} fill="none" stroke={ACCENT} strokeWidth={2} strokeOpacity={0.8} strokeLinecap="round" strokeLinejoin="round" />)}
                  </g>
                  {/* every run of a right-angled line can be taken hold of along its whole length and moved sideways.
                      A short grip in the middle of each says so, and the pointer shows which way it goes */}
                  {editing && !moving && r.shape === 'ortho' && r.pts.slice(0, -1).map((p, i) => {
                    const q = r.pts[i + 1], len = Math.abs(q[0] - p[0]) + Math.abs(q[1] - p[1])
                    if (len < 0.2) return null
                    const A = P(p), B = P(q), c = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2]
                    const L = Math.hypot(B[0] - A[0], B[1] - A[1]) || 1, ux = (B[0] - A[0]) / L, uy = (B[1] - A[1]) / L
                    // which way the run travels on screen when it is moved: across itself on the ground
                    const side = p[1] === q[1] ? [P([p[0], p[1] + 1]), A] : [P([p[0] + 1, p[1]]), A]
                    const deg = ((Math.atan2(side[0][1] - side[1][1], side[0][0] - side[1][0]) * 180) / Math.PI + 360) % 180
                    const cursor = ['ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize'][Math.round(deg / 45) % 4]
                    const g = Math.min(8, (L * view.k) / 3) / view.k
                    return (
                      <g key={'s' + i} className="run-hit" data-handle={'s' + i} style={{ cursor }}>
                        <line x1={A[0]} y1={A[1]} x2={B[0]} y2={B[1]} stroke="transparent" strokeWidth={(coarse ? 30 : 14) / view.k} strokeLinecap="butt" />
                        {len >= 0.9 && <line className="run-grip" x1={c[0] - ux * g} y1={c[1] - uy * g} x2={c[0] + ux * g} y2={c[1] + uy * g} stroke={theme.bg} strokeWidth={7 / view.k} strokeLinecap="round" pointerEvents="none" />}
                        {len >= 0.9 && <line className="run-grip" x1={c[0] - ux * g} y1={c[1] - uy * g} x2={c[0] + ux * g} y2={c[1] + uy * g} stroke={ACCENT} strokeWidth={3.5 / view.k} strokeLinecap="round" pointerEvents="none" />}
                      </g>
                    )
                  })}
                  {/* each turn can be taken hold of too, and moved wherever: the two runs that meet at it follow */}
                  {editing && !moving && r.shape === 'ortho' && r.pts.slice(1, -1).map((p, i) => {
                    const c = P(p)
                    return (
                      <g key={'c' + i}>
                        {grab(c, 'c' + (i + 1))}
                        <circle cx={c[0]} cy={c[1]} r={8 / view.k} fill="transparent" data-handle={'c' + (i + 1)} style={{ cursor: 'move' }} />
                        <circle className="turn-grip" cx={c[0]} cy={c[1]} r={3.2 / view.k} fill={ACCENT} stroke={theme.bg} strokeWidth={1.5 / view.k} pointerEvents="none" />
                      </g>
                    )
                  })}
                  {editing && ([['ea', r.pts[0]], ['eb', r.pts[last]]] as const).map(([name, p]) => {
                    const c = P(p as [number, number])
                    return (
                      <g key={name}>
                        {grab(c, name)}
                        <circle cx={c[0]} cy={c[1]} r={5.5 / view.k} fill={theme.bg} stroke={ACCENT} strokeWidth={2 / view.k} data-handle={name} className="handle link-end" style={{ cursor: 'crosshair' }} />
                      </g>
                    )
                  })}
                </g>
              )
            })}
            {selAreas.map((a) => {
              const corners = [pt(proj, a.x, a.y), pt(proj, a.x + a.w, a.y), pt(proj, a.x + a.w, a.y + a.d), pt(proj, a.x, a.y + a.d)]
              return (
                <g key={a.id}>
                  <polygon points={poly(corners)} fill={ACCENT} fillOpacity={0.04} stroke={ACCENT} strokeWidth={1.25 / view.k} strokeLinejoin="round" pointerEvents="none" />
                  {selection.length === 1 && coarse && corners.map((c, i) => <circle key={'t' + i} cx={c[0]} cy={c[1]} r={15 / view.k} fill="transparent" data-handle={'r' + i} />)}
                  {selection.length === 1 && corners.map((c, i) => (
                    <rect key={i} x={c[0] - 5 / view.k} y={c[1] - 5 / view.k} width={10 / view.k} height={10 / view.k} rx={2.5 / view.k} fill={theme.bg} stroke={ACCENT} strokeWidth={1.5 / view.k}
                      data-handle={'r' + i} className="handle" style={{ cursor: 'crosshair' }} />
                  ))}
                </g>
              )
            })}
            {selLabels.map((l) => {
              const len = Math.max(...l.text.split('\n').map((t) => t.length)) * l.size * 0.56 / U
              const rows = l.text.split('\n').length * l.size * 1.2 / U
              const c = l.dir === 'x'
                ? [pt(proj, l.x - 0.15, l.y - 0.1), pt(proj, l.x + len + 0.15, l.y - 0.1), pt(proj, l.x + len + 0.15, l.y + rows), pt(proj, l.x - 0.15, l.y + rows)]
                : [pt(proj, l.x - 0.1, l.y + 0.15), pt(proj, l.x - 0.1, l.y - len - 0.15), pt(proj, l.x + rows, l.y - len - 0.15), pt(proj, l.x + rows, l.y + 0.15)]
              return <polygon key={l.id} points={poly(c)} fill={ACCENT} fillOpacity={0.05} stroke={ACCENT} strokeWidth={1.25 / view.k} pointerEvents="none" />
            })}
            {draft && (
              <g pointerEvents="none">
                <polygon points={poly([pt(proj, draft.x, draft.y), pt(proj, draft.x + draft.w, draft.y), pt(proj, draft.x + draft.w, draft.y + draft.d), pt(proj, draft.x, draft.y + draft.d)])}
                  fill={ACCENT} fillOpacity={0.07} stroke={ACCENT} strokeOpacity={0.5} strokeWidth={1} />
                <path d={brackets(proj, draft.x, draft.y, draft.x + draft.w, draft.y + draft.d, 0.6)} fill="none" stroke={ACCENT} strokeWidth={2} strokeLinecap="round" />
              </g>
            )}
            {splice && routes.get(splice) && <path className="splice" d={lineOf(proj, routes.get(splice)!)} fill="none" stroke={ACCENT} strokeWidth={4} strokeLinecap="round" strokeLinejoin="round" pointerEvents="none" />}
            {wire && wireFrom && (() => {
              // the line as it will be drawn if it is let go now: routed round what is in the way, to what it has caught or to the pointer
              const caught = wireTarget && !wire.bad && wireTarget.id !== wireFrom.id ? wireTarget : null
              const back = wire.relink?.end === 'from'
              // caught, it is routed exactly as it will be once it is let go: as part of the whole diagram, beside the lines already on those sides
              const moving = wire.relink ? shown.edges.find((x) => x.id === wire.relink!.id) : null
              const made: EdgeT | null = !caught ? null : moving ? reended(moving, wire.relink!.end, caught.id, wire.side) : { id: '~wire', from: wireFrom.id, to: caught.id, style: 'solid', arrow: 'end', width: 2, toSide: wire.side }
              const pts = made
                ? routeAll(shown.nodes, moving ? shown.edges.map((x) => (x.id === made.id ? made : x)) : [...shown.edges, made]).get(made.id)?.pts ?? []
                : routeToPoint(wireFrom, wire.to, shown.nodes)
              if (pts.length < 2) return null
              const n = pts.length, tip = back ? null : pts[n - 1]
              return (
                <g pointerEvents="none" className={'wire' + (caught ? ' caught' : '') + (wire.bad ? ' bad' : '')}>
                  <path d={pathOf(proj, pts, 0, caught && tip ? 0.26 : 0)} fill="none" stroke={ACCENT} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" strokeDasharray={caught ? undefined : '5 6'} />
                  {caught && tip && <polygon points={poly(arrowAt(tip, pts[n - 2], 0.34).map((q) => pt(proj, q[0], q[1])))} fill={ACCENT} stroke={ACCENT} strokeWidth={1} strokeLinejoin="round" />}
                  {!caught && (() => { const c = pt(proj, wire.to[0], wire.to[1]); return <circle cx={f(c[0])} cy={f(c[1])} r={3.5 / view.k} fill={ACCENT} /> })()}
                </g>
              )
            })()}
            {ghost && placing && (
              <g pointerEvents="none" className="ghost">
                {/* the cell it will land in, then the component itself, following the pointer */}
                <polygon points={foot(ghost.at[0], ghost.at[1], 0.1)} fill={ACCENT} fillOpacity={0.1} />
                <path d={fp(ghost.at[0], ghost.at[1], 0.1)} fill="none" stroke={ACCENT} strokeWidth={2} strokeLinecap="round" />
                <g transform={`translate(${pt(proj, ghost.at[0], ghost.at[1]).map(f).join(' ')})`} opacity={0.82}><Model type={placing} proj={proj} /></g>
              </g>
            )}
            {/* corner handles: drag to resize the selected component */}
            {single && tool === 'select' && !wire && !moving && (!coarse || footOf(single) * U * view.k > 64) && [[0, 0], [1, 0], [1, 1], [0, 1]].map(([ix, iy], i) => {
              const fs = footOf(single), o = 0.1
              const c = pt(proj, single.x + (ix ? fs + o : -o), single.y + (iy ? fs + o : -o))
              const r = 4.5 / view.k
              // the arrow points the way the corner actually moves on screen, whatever the camera angle
              const mid = pt(proj, single.x + fs / 2, single.y + fs / 2)
              const deg = ((Math.atan2(c[1] - mid[1], c[0] - mid[0]) * 180) / Math.PI + 360) % 180
              const arrow = ['ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize'][Math.round(deg / 45) % 4]
              return (
                <g key={i} data-handle={'n' + i} style={{ cursor: arrow }}>
                  {coarse && <circle cx={c[0]} cy={c[1]} r={15 / view.k} fill="transparent" />}
                  <rect x={c[0] - r} y={c[1] - r} width={r * 2} height={r * 2} rx={r * 0.3} fill={theme.bg} stroke={ACCENT} strokeWidth={1.5 / view.k}
                    className="handle" style={{ cursor: arrow }}><title>Drag to resize</title></rect>
                </g>
              )
            })}
            {/* doors: press on one and pull to draw a connection. They show on what the pointer is over, on the one thing selected,
                and on whatever a connection in the hand has caught */}
            {doorNodes.map((n) => {
              const ports = doors(n)
              return SIDES.map((side) => {
                const c = pt(proj, ports[side][0], ports[side][1])
                const aimed = !!wire && wire.target === n.id && wire.side === side
                return (
                  <g key={n.id + side} data-handle="connect" data-id={n.id} data-side={side} className={'connect-handle door' + (aimed ? ' aimed' : '')} style={{ cursor: 'crosshair' }} pointerEvents={wire ? 'none' : undefined}>
                    <title>Drag to connect</title>
                    <circle cx={c[0]} cy={c[1]} r={(coarse ? 20 : 11) / view.k} fill="transparent" />
                    <circle className="door-dot" cx={c[0]} cy={c[1]} r={(aimed ? 6 : 4.2) / view.k} fill={aimed ? ACCENT : theme.bg} stroke={ACCENT} strokeWidth={1.6 / view.k} />
                  </g>
                )
              })
            })}
          </g>
        </g>
        {marquee && <rect x={marquee.x} y={marquee.y} width={marquee.w} height={marquee.h} rx={3} fill={ACCENT} fillOpacity={0.06} stroke={ACCENT} strokeOpacity={0.7} strokeWidth={1} pointerEvents="none" />}
      </svg>
      {/* what the fingers are doing to the camera, while they are doing it */}
      {reading && <div className="gesture-pill mono" role="status">{reading === 'turn' ? `Turn ${Math.round(normYaw(yaw - 45))}°` : pitch >= 89.5 ? 'Plan view' : `Tilt ${Math.round(90 - pitch)}°`}</div>}
      {barAt && !busy && tool === 'select' && (
        <div className="sel-bar" style={{ left: barAt[0], top: barAt[1] }} key={selection.join()}>
          {single ? (
            <span className="sel-bar-info">
              <b>{nodeName(single)}</b>
              <i>{defOf(single.type).summary?.({ ...defaultProps(single.type), ...single.props }) ?? defOf(single.type).svc}</i>
              {costOf(single, doc.region, pricing).monthly > 0 && <em>{money(costOf(single, doc.region, pricing).monthly)}</em>}
            </span>
          ) : (
            <span className="sel-bar-info"><b>{selNodes.length} selected</b><em>{money(selNodes.reduce((t, n) => t + costOf(n, doc.region, pricing).monthly, 0))}</em></span>
          )}
          <span className="sel-bar-sep" />
          {single && <button aria-label="Connect" data-tip="Connect  C" onClick={() => useStore.setState({ tool: 'connect' })}><Waypoints size={14} /></button>}
          {!single && <button aria-label="Line up" data-tip="Line up" onClick={() => useStore.getState().apply((d) => lineUp(d, selection))}><AlignCenterVertical size={14} /></button>}
          {!single && selNodes.length > 2 && <button aria-label="Space evenly" data-tip="Space evenly" onClick={() => useStore.getState().apply((d) => spaceEvenly(d, selection))}><AlignHorizontalSpaceAround size={14} /></button>}
          {!single && <button aria-label="Group" data-tip="Wrap in group" onClick={wrapSelectionInArea}><Group size={14} /></button>}
          <button aria-label="Duplicate" data-tip={keys('Duplicate  ⌘D')} onClick={() => useStore.getState().duplicate(selection)}><Copy size={14} /></button>
          <button aria-label="Focus" data-tip="Focus  F" onClick={() => fitView(selNodes.map((n) => n.id))}><Scan size={14} /></button>
          <button aria-label="Delete" className="danger" data-tip={keys('Delete  ⌫')} onClick={() => useStore.getState().remove(selection)}><Trash2 size={14} /></button>
        </div>
      )}
      {oneEdge && edgeBar && straight && !busy && tool === 'select' && (
        <div className="sel-bar edge-bar" style={{ left: edgeBar[0], top: edgeBar[1] }} key={oneEdge.id}>
          {straight.state === 'apart'
            ? <button className="wide" aria-label="Line up" data-tip="Move one into line with the other, so the line is straight" onClick={() => straightenLinks([oneEdge.id])}><Minus size={14} />Line up</button>
            : <button className="wide" aria-label="Straighten" disabled={straight.state === 'straight' && !!oneEdge.runs} data-tip={straight.state === 'can' && straight.through ? 'Make it one straight line, passing under what stands between' : 'Make it one straight line'} onClick={() => straightenLinks([oneEdge.id])}><Minus size={14} />Straighten</button>}
          <span className="sel-bar-sep" />
          <button aria-label="Right-angled" aria-pressed={!oneEdge.shape} data-tip="Right-angled" onClick={() => useStore.getState().setShape([oneEdge.id], undefined)}><CornerDownRight size={14} /></button>
          <button aria-label="Direct" aria-pressed={oneEdge.shape === 'direct'} data-tip="Direct: one line, at any angle" onClick={() => useStore.getState().setShape([oneEdge.id], 'direct')}><Slash size={14} /></button>
          <button aria-label="Curved" aria-pressed={oneEdge.shape === 'curved'} data-tip="Curved" onClick={() => useStore.getState().setShape([oneEdge.id], 'curved')}><Spline size={14} /></button>
          <span className="sel-bar-sep" />
          {/* whose line it is: the router's, to plan afresh as things move, or the user's, to stay as it was left */}
          <button aria-label="Route automatically" aria-pressed={!isManual(oneEdge)} data-tip={isManual(oneEdge) ? 'Shaped by hand. Route it automatically again' : 'Routed automatically'} onClick={() => useStore.getState().resetRoute([oneEdge.id])}><Wand2 size={14} /></button>
          <button aria-label="Keep this path" aria-pressed={isManual(oneEdge)} disabled={!!oneEdge.shape} data-tip={isManual(oneEdge) ? 'Shaped by hand: it stays as you left it' : 'Keep this path as it is'} onClick={() => useStore.getState().keepRoute([oneEdge.id])}><Pin size={14} /></button>
        </div>
      )}
      {doc.nodes.length === 0 && doc.areas.length === 0 && doc.labels.length === 0 && !placing && (
        <div className="empty-hint">
          <div className="empty-mark" />
          <div className="empty-title">An empty plane.</div>
          <div className="empty-sub not-phone">Drag a component in from the library, or summon anything with <kbd>{keys('⌘K')}</kbd></div>
          <div className="empty-sub only-phone">Tap <b>Add</b> below to place your first component.</div>
        </div>
      )}
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
      {quick && (
        // kept inside the part of the canvas the panels leave clear, and above the pointer when there is no room below it
        <QuickAdd x={Math.max(insets().l, Math.min(quick.x - 14, cam.w - insets().r - 252))} y={quick.y + 12 > cam.h - insets().b - 290 ? Math.max(insets().t, quick.y - 296) : quick.y + 12} onClose={closeQuick}
          onPick={(type) => {
            // where the connection was let go is where the new component stands
            const q = quick, st = useStore.getState(), x = put(q.wx - 1, 1, st.snap), y = put(q.wy - 1, 1, st.snap)
            closeQuick(); st.addLinked(type, x, y, { from: q.from }); haptic(10)
          }} />
      )}
    </div>
  )
}

export { planeMatrix }
