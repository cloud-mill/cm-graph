import { useEffect, useMemo, useRef, useState } from 'react'
import { Copy, Group, Scan, Trash2, Waypoints } from 'lucide-react'
import { MAX_PITCH, MIN_PITCH, type Proj, U, f, makeCam, mix, normYaw, planeMatrix, poly, pt, unproject, upright } from '../core/iso'
import { costOf, defOf, defaultProps, docCost, money, nodeName } from '../core/catalog'
import { traceFlow } from '../core/links'
import { legOfRun, nearestSide, routePair } from '../core/router'
import { pathOf } from '../core/routing'
import { type View, kindOf, moveItems, useStore } from '../core/store'
import { type AreaT, type Doc, type NodeT, MAX_SCALE, MIN_SCALE, centerOf, footOf } from '../core/types'
import { Scene, THEMES, brackets, useRoutes } from './Scene'
import { Model } from './models'
import { animateView, beginOrbit, cam, center, fitView, flushFrame, glide, holdStill, hud, onFrame, projNow, smoothZoom, zoomBy } from './camera'
import { type Finger, type Gesture, MAX_K, MIN_K, type Trail, fling, gestureMove, gestureRebase, gestureStart, isTwoFingerTap, track } from './touch'
import { type Guide, alignGuides } from '../core/guides'
import { haptic, usePhone } from '../ui/device'
import { wrapSelectionInArea } from '../ui/actions'
import { ContextMenu, type MenuState } from '../ui/ContextMenu'
import { keys } from '../ui/atoms'

type Drag =
  | { mode: 'pan'; sx: number; sy: number; vx: number; vy: number; moved: boolean; quiet?: boolean }
  // second tap of a double tap on bare ground, held: sliding it zooms with one thumb
  | { mode: 'dtap'; sx: number; sy: number; view: View; moved: boolean }
  // a finger has landed and has not yet said what it wants: a tap, a pan, or a press-and-hold
  | { mode: 'touch'; id: string | null; kind: string | null; sx: number; sy: number; vx: number; vy: number; wx: number; wy: number }
  | { mode: 'move'; wx: number; wy: number; sx: number; sy: number; base: Doc; active: boolean; step: number }
  | { mode: 'resize'; id: string; corner: number; base: AreaT; active: boolean }
  | { mode: 'nresize'; id: string; corner: number; base: NodeT; active: boolean }
  | { mode: 'connect'; from: string }
  // a waypoint of a connection being dragged; `fresh` means it was created by this drag
  | { mode: 'via'; id: string; index: number; active: boolean; sx: number; sy: number }
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
  const [ghost, setGhost] = useState<[number, number] | null>(null)
  const [wire, setWire] = useState<{ to: [number, number]; target: string | null } | null>(null)
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
  // on a phone the dock's Connect button does this job, with a far bigger target
  const phone = usePhone()
  // fingers need bigger handles than a mouse does
  const coarse = useMemo(() => typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches, [])
  useEffect(() => () => clearTimeout(press.current), [])
  // a connection waiting for its other end only makes sense while the connect tool is up
  useEffect(() => { if (tool !== 'connect' && useStore.getState().linkFrom) useStore.setState({ linkFrom: null }) }, [tool])

  const sel = useMemo(() => new Set(selection), [selection])
  const routes = useRoutes(doc)
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

  // ---- placing from the palette (pointer-driven drag & drop)
  useEffect(() => {
    if (!placing) { setGhost(null); return }
    const over = (e: PointerEvent) => {
      const r = ref.current!.getBoundingClientRect()
      return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom &&
        !!(document.elementFromPoint(e.clientX, e.clientY)?.closest('.canvas-svg'))
    }
    const at = (e: PointerEvent): [number, number] => {
      const [wx, wy] = toWorld(e.clientX, e.clientY, projNow())
      return [Math.round(wx - 1), Math.round(wy - 1)]
    }
    const move = (e: PointerEvent) => setGhost(over(e) ? at(e) : null)
    const up = (e: PointerEvent) => {
      if (!over(e)) return
      const [x, y] = at(e)
      const st = useStore.getState()
      st.addNode(st.placing!, x, y)
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
        drag.current = null
        lastTap.current = null
        setMoving(false); setWire(null); setDraft(null); setMarquee(null); showGuides([])
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
    const handle = (target.closest('[data-handle]') as HTMLElement | null)?.dataset.handle
    const hit = target.closest('[data-kind]') as HTMLElement | null
    const kind = hit?.dataset.kind
    const id = hit?.dataset.id

    if (handle === 'connect') {
      drag.current = { mode: 'connect', from: st.selection[0] }
      setWire({ to: [wx, wy], target: null })
      return
    }
    if (handle && /^[wm]\d+$/.test(handle)) {
      const e = st.doc.edges.find((x) => x.id === st.selection[0])
      if (!e) return
      let index = Number(handle.slice(1))
      if (handle[0] === 'm') {
        // pulling on a straight run puts a waypoint there: from now on the line goes through it
        const r = routes.get(e.id)
        if (!r) return
        index = legOfRun(r, index)
        const at: [number, number] = [Math.round(wx * 2) / 2, Math.round(wy * 2) / 2]
        const via = [...(e.via ?? [])]
        via.splice(index, 0, at)
        st.checkpoint()
        st.apply((d) => ({ ...d, edges: d.edges.map((x) => (x.id === e.id ? { ...x, via } : x)) }), true)
        drag.current = { mode: 'via', id: e.id, index, active: true, sx: 0, sy: 0 }
        setMoving(true)
        return
      }
      drag.current = { mode: 'via', id: e.id, index, active: false, sx: 0, sy: 0 }
      return
    }
    if (handle === 'ea' || handle === 'eb') {
      const e = st.doc.edges.find((x) => x.id === st.selection[0])
      if (e) drag.current = { mode: 'relink', id: e.id, end: handle === 'ea' ? 'from' : 'to', active: false, sx: 0, sy: 0 }
      return
    }
    if (handle && handle.startsWith('n')) {
      const n = st.doc.nodes.find((x) => x.id === st.selection[0])
      if (n) drag.current = { mode: 'nresize', id: n.id, corner: Number(handle[1]), base: n, active: false }
      return
    }
    if (handle && handle.startsWith('r')) {
      const a = st.doc.areas.find((x) => x.id === st.selection[0])
      if (a) drag.current = { mode: 'resize', id: a.id, corner: Number(handle[1]), base: a, active: false }
      return
    }
    if (st.tool === 'text' && !hit) {
      st.addLabel(Math.round(wx * 2) / 2, Math.round(wy * 2) / 2)
      st.set({ tool: 'select', panel: 'inspect' })
      return
    }
    if (st.tool === 'area') {
      drag.current = { mode: 'area', wx: Math.round(wx), wy: Math.round(wy) }
      return
    }
    if (st.tool === 'connect') {
      if (kind === 'node' && id) {
        drag.current = { mode: 'connect', from: id }
        setWire({ to: [wx, wy], target: null })
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
      if (kind === 'edge') return
      const selNow = useStore.getState().selection
      const onlyFree = selNow.every((s) => kindOf(st.doc, s) === 'label')
      drag.current = { mode: 'move', wx, wy, sx: e.clientX, sy: e.clientY, base: st.doc, active: false, step: onlyFree ? 0.5 : 1 }
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
      drag.current = { mode: 'move', wx: d.wx, wy: d.wy, sx: d.sx, sy: d.sy, base: st.doc, active: false, step: onlyFree ? 0.5 : 1 }
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
    if (!d) return
    const st = useStore.getState()
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
    } else if (d.mode === 'move') {
      if (!d.active) {
        if (Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < (e.pointerType === 'touch' ? TOUCH_SLOP : 4)) return
        d.active = true
        setMoving(true)
        // alt-drag clones the selection and moves the copies
        if (e.altKey) { st.duplicate(st.selection, 0, 0); d.base = useStore.getState().doc } else st.checkpoint()
      }
      const [wx, wy] = toWorld(e.clientX, e.clientY)
      const dx = Math.round((wx - d.wx) / d.step) * d.step, dy = Math.round((wy - d.wy) / d.step) * d.step
      const sel = new Set(useStore.getState().selection)
      st.apply((doc) => moveItems(doc, d.base, sel, dx, dy), true)
      // a line appears whenever what is being moved comes level with something else, with a tick under the finger
      if (showGuides(alignGuides(useStore.getState().doc.nodes, sel)) && e.pointerType === 'touch') haptic(5)
    } else if (d.mode === 'resize') {
      if (!d.active) { d.active = true; st.checkpoint() }
      const [wx, wy] = toWorld(e.clientX, e.clientY).map((v) => Math.round(v * 2) / 2)
      const b = d.base
      let x0 = b.x, y0 = b.y, x1 = b.x + b.w, y1 = b.y + b.d
      if (d.corner === 0 || d.corner === 3) x0 = Math.min(wx, x1 - 1); else x1 = Math.max(wx, x0 + 1)
      if (d.corner === 0 || d.corner === 1) y0 = Math.min(wy, y1 - 1); else y1 = Math.max(wy, y0 + 1)
      st.apply((doc) => ({ ...doc, areas: doc.areas.map((a) => (a.id === d.id ? { ...a, x: x0, y: y0, w: x1 - x0, d: y1 - y0 } : a)) }), true)
    } else if (d.mode === 'nresize') {
      // components stay square: the corner opposite the one being dragged is pinned, and the size snaps to half cells
      if (!d.active) { d.active = true; st.checkpoint() }
      const [wx, wy] = toWorld(e.clientX, e.clientY)
      const b = d.base, fs = footOf(b)
      const left = d.corner === 0 || d.corner === 3, top = d.corner === 0 || d.corner === 1
      const ax = left ? b.x + fs : b.x, ay = top ? b.y + fs : b.y
      const want = Math.max(left ? ax - wx : wx - ax, top ? ay - wy : wy - ay)
      const size = Math.max(2 * MIN_SCALE, Math.min(2 * MAX_SCALE, Math.round(want * 2) / 2))
      const x = left ? ax - size : ax, y = top ? ay - size : ay
      st.apply((doc) => ({ ...doc, nodes: doc.nodes.map((n) => (n.id === d.id ? { ...n, x, y, scale: size / 2 } : n)) }), true)
    } else if (d.mode === 'connect') {
      const t = nodeAt(e.clientX, e.clientY)
      setWire({ to: toWorld(e.clientX, e.clientY), target: t && t !== d.from ? t : null })
    } else if (d.mode === 'via') {
      if (!d.active) { d.active = true; setMoving(true); st.checkpoint() }
      // waypoints sit on the half-cell grid, like everything else, so runs line up without effort
      const at = toWorld(e.clientX, e.clientY).map((v) => Math.round(v * 2) / 2) as [number, number]
      st.apply((doc) => ({ ...doc, edges: doc.edges.map((x) => (x.id === d.id && x.via ? { ...x, via: x.via.map((p, i) => (i === d.index ? at : p)) } : x)) }), true)
    } else if (d.mode === 'relink') {
      if (!d.active) { d.active = true; setMoving(true) }
      const t = nodeAt(e.clientX, e.clientY)
      setWire({ to: toWorld(e.clientX, e.clientY), target: t })
    } else if (d.mode === 'marquee') {
      const r = ref.current!.getBoundingClientRect()
      setMarquee({ x: Math.min(d.sx, e.clientX) - r.left, y: Math.min(d.sy, e.clientY) - r.top, w: Math.abs(e.clientX - d.sx), h: Math.abs(e.clientY - d.sy) })
    } else if (d.mode === 'area') {
      const [wx, wy] = toWorld(e.clientX, e.clientY).map(Math.round)
      setDraft({ x: Math.min(d.wx, wx), y: Math.min(d.wy, wy), w: Math.abs(wx - d.wx), d: Math.abs(wy - d.wy) })
    }
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
    if (!space.current) setPanning(false)
    setMoving(false)
    showGuides([])
    if (!d) return
    const st = useStore.getState()
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
    if (d.mode === 'via') {
      if (!d.active) return
      // a waypoint dropped back onto the line it bends adds nothing: take it out, which is also how one is removed by dragging
      const edge = st.doc.edges.find((x) => x.id === d.id), r = routes.get(d.id)
      if (edge?.via && r) {
        const p = edge.via[d.index], prev = d.index > 0 ? edge.via[d.index - 1] : r.pts[0], next = d.index < edge.via.length - 1 ? edge.via[d.index + 1] : r.pts[r.pts.length - 1]
        const near = (q: [number, number]) => Math.hypot(q[0] - p[0], q[1] - p[1]) < 0.75
        const inLine = (prev[0] === p[0] && p[0] === next[0]) || (prev[1] === p[1] && p[1] === next[1])
        if (near(prev as [number, number]) || near(next as [number, number]) || inLine) {
          st.apply((doc) => ({ ...doc, edges: doc.edges.map((x) => (x.id === d.id ? { ...x, via: x.via!.length > 1 ? x.via!.filter((_, i) => i !== d.index) : undefined } : x)) }), true)
          if (e.pointerType === 'touch') haptic(8)
        }
      }
      return
    }
    if (d.mode === 'relink') {
      setWire(null)
      if (!d.active) return
      const t = nodeAt(e.clientX, e.clientY)
      const target = t ? st.doc.nodes.find((n) => n.id === t) : null
      if (!target) return
      const [px, py] = toWorld(e.clientX, e.clientY), fs = footOf(target)
      // dropped near an edge of the component: pin that side. Dropped in its middle: let the router choose
      const off = Math.max(Math.abs(px - (target.x + fs / 2)), Math.abs(py - (target.y + fs / 2))) / (fs / 2)
      if (st.reconnect(d.id, d.end, target.id, off > 0.45 ? nearestSide(target, [px, py]) : undefined)) haptic(10)
      else st.toast('A connection needs two different components', 'warn')
      return
    }
    if (d.mode === 'pan' && !d.moved) { st.select([]); if (st.linkFrom) st.set({ linkFrom: null }) }
    else if (d.mode === 'connect') {
      const t = nodeAt(e.clientX, e.clientY)
      const link = (from: string, to: string) => {
        const id = st.addEdge(from, to)
        if (id) { st.select([id]); haptic(10) }
        else st.toast('Those components are already connected', 'warn')
      }
      if (t && t !== d.from) { link(d.from, t); if (st.linkFrom) st.set({ linkFrom: null }) }
      else if (t === d.from && st.tool === 'connect') {
        // a tap rather than a drag: the first tap picks one end, the second picks the other
        if (st.linkFrom && st.linkFrom !== t) { link(st.linkFrom, t); st.set({ linkFrom: null, tool: 'select' }) }
        else { st.set({ linkFrom: st.linkFrom === t ? null : t }); haptic(6) }
      }
      setWire(null)
    } else if (d.mode === 'marquee') {
      const marquee = marqueeRef.current
      if (marquee && marquee.w + marquee.h > 6) {
        const v = st.view
        const inside = (wx: number, wy: number) => {
          const q = pt(proj, wx, wy)
          const sx = q[0] * v.k + v.x, sy = q[1] * v.k + v.y
          return sx >= marquee.x && sx <= marquee.x + marquee.w && sy >= marquee.y && sy <= marquee.y + marquee.h
        }
        st.select([
          ...st.doc.nodes.filter((n) => inside(...centerOf(n))).map((n) => n.id),
          ...st.doc.areas.filter((a) => inside(a.x, a.y) && inside(a.x + a.w, a.y + a.d) && inside(a.x + a.w, a.y) && inside(a.x, a.y + a.d)).map((a) => a.id),
          ...st.doc.labels.filter((l) => inside(l.x, l.y)).map((l) => l.id),
        ])
      }
      setMarquee(null)
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
    const hit = (document.elementFromPoint(cx, cy)?.closest('[data-kind]') ?? null) as HTMLElement | null
    const id = hit?.dataset.id
    if (id && !st.selection.includes(id)) st.select([id])
    if (!id) st.select([])
    const [wx, wy] = toWorld(cx, cy)
    setMenu({ x: cx, y: cy, wx, wy, target: id ? (hit!.dataset.kind as any) : null })
  }

  const onDoubleClick = (e: React.MouseEvent) => {
    // the canvas captures the pointer, so the event's own target is the canvas: look up what is under it
    const hit = (document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-kind]') ?? (e.target as HTMLElement).closest('[data-kind]')) as HTMLElement | null
    // while several things are being picked, two quick taps are two picks, not a request to edit
    if (useStore.getState().multi) return
    // a waypoint: twice means take it out
    const way = ((document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-handle]') ?? (e.target as HTMLElement).closest('[data-handle]')) as HTMLElement | null)?.dataset.handle
    if (way && /^w\d+$/.test(way)) {
      const st = useStore.getState(), id = st.selection[0], i = Number(way.slice(1))
      st.apply((doc) => ({ ...doc, edges: doc.edges.map((x) => (x.id === id && x.via ? { ...x, via: x.via.length > 1 ? x.via.filter((_, k) => k !== i) : undefined } : x)) }))
      return
    }
    // opens the inspector if it was put away, since a rename has to happen somewhere
    if (hit?.dataset.id) useStore.setState((s) => ({ panel: 'inspect', showInsp: true, ...(innerWidth <= 760 ? { showLib: false } : {}), focusName: s.focusName + 1 }))
  }

  // ---- overlay geometry
  const byId = useMemo(() => new Map(doc.nodes.map((n) => [n.id, n])), [doc.nodes])
  const selNodes = doc.nodes.filter((n) => sel.has(n.id))
  const selAreas = doc.areas.filter((a) => sel.has(a.id))
  const selEdges = doc.edges.filter((e) => sel.has(e.id))
  const selLabels = doc.labels.filter((l) => sel.has(l.id))
  const single = selection.length === 1 && selNodes.length === 1 ? selNodes[0] : null
  const foot = (x: number, y: number, o = 0.06, s = 2) => poly([pt(proj, x - o, y - o), pt(proj, x + s + o, y - o), pt(proj, x + s + o, y + s + o), pt(proj, x - o, y + s + o)])
  const gridOpacity = Math.max(0, Math.min(1, (view.k - 0.3) / 0.35))
  const cursor = orbiting ? 'move' : panning ? 'grabbing' : tool === 'orbit' ? 'move' : placing ? 'copy' : tool === 'connect' || tool === 'area' ? 'crosshair' : tool === 'text' ? 'text' : 'default'
  const relinking = drag.current?.mode === 'relink' ? doc.edges.find((x) => x.id === (drag.current as { id: string }).id) : null
  const wireFrom = wire && drag.current?.mode === 'connect' ? byId.get(drag.current.from) : wire && relinking ? byId.get((drag.current as { end: string }).end === 'from' ? relinking.to : relinking.from) : null
  const wireTarget = wire?.target ? byId.get(wire.target) : null
  const linkNode = linkFrom ? byId.get(linkFrom) : null

  const busy = moving || orbiting || panning || !!wire || !!placing
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

  return (
    <div className={'canvas-wrap' + (intro ? ' intro' : '') + (busy ? ' busy' : '')} data-tool={tool}>
      <svg ref={ref} className="canvas-svg" style={{ cursor }} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp} onContextMenu={onContextMenu} onDoubleClick={onDoubleClick}>
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
            {wireTarget && (
              <g>
                <polygon points={foot(wireTarget.x, wireTarget.y, 0.1, footOf(wireTarget))} fill={ACCENT} fillOpacity={0.18} />
                <path d={fp(wireTarget.x, wireTarget.y, 0.1, footOf(wireTarget))} fill="none" stroke={ACCENT} strokeWidth={2} strokeLinecap="round" />
              </g>
            )}
          </g>
          <Scene doc={doc} proj={proj} theme={theme} showLabels={showLabels} flow={flow} lens={lensMap} fresh={fresh} routes={routes} focus={focus} />
          <g className="overlay">
            {selEdges.map((e) => {
              const a = byId.get(e.from), b = byId.get(e.to), r = routes.get(e.id)
              if (!a || !b || !r) return null
              const d = pathOf(proj, r.pts)
              const editing = selection.length === 1 && tool === 'select'
              const P = (q: [number, number]) => pt(proj, q[0], q[1])
              // fingers get a generous invisible target around each small visible handle
              const grab = (c: [number, number], name: string) => coarse && <circle cx={c[0]} cy={c[1]} r={17 / view.k} fill="transparent" data-handle={name} />
              const last = r.pts.length - 1
              return (
                <g key={e.id}>
                  <g pointerEvents="none">
                    <path d={d} fill="none" stroke={ACCENT} strokeWidth={e.width + 5} strokeOpacity={0.35} strokeLinecap="round" filter="url(#glow)" />
                    <path d={d} fill="none" stroke={ACCENT} strokeWidth={e.width} strokeLinecap="round" strokeLinejoin="round" />
                    {/* both ends of the selected connection are marked, so it is plain what it joins */}
                    {[a, b].map((n) => <path key={n.id} d={fp(n.x, n.y, 0.12, footOf(n))} fill="none" stroke={ACCENT} strokeWidth={2} strokeOpacity={0.8} strokeLinecap="round" strokeLinejoin="round" />)}
                  </g>
                  {editing && !moving && r.pts.slice(0, -1).map((p, i) => {
                    // a faint dot in the middle of each straight run: pull it to bend the line there
                    const q = r.pts[i + 1], len = Math.abs(q[0] - p[0]) + Math.abs(q[1] - p[1])
                    if (len < 1.2) return null
                    const c = P([(p[0] + q[0]) / 2, (p[1] + q[1]) / 2])
                    return (
                      <g key={'m' + i}>
                        {grab(c, 'm' + i)}
                        <circle cx={c[0]} cy={c[1]} r={3.6 / view.k} fill={theme.bg} stroke={ACCENT} strokeOpacity={0.6} strokeWidth={1.2 / view.k} data-handle={'m' + i} className="handle bend-add" style={{ cursor: 'grab' }} />
                      </g>
                    )
                  })}
                  {editing && (e.via ?? []).map((v, i) => {
                    // corners are drawn rounded, so a waypoint at a corner sits on the curve, not out at the sharp point the curve cuts off
                    const j = r.pts.findIndex((q) => q[0] === v[0] && q[1] === v[1])
                    let on: [number, number] = v
                    if (j > 0 && j < last) {
                      const a = r.pts[j - 1], b = r.pts[j + 1], la = Math.hypot(a[0] - v[0], a[1] - v[1]), lb = Math.hypot(b[0] - v[0], b[1] - v[1])
                      const rr = Math.min(0.32, la / 2, lb / 2)
                      on = [v[0] + 0.25 * rr * ((a[0] - v[0]) / la + (b[0] - v[0]) / lb), v[1] + 0.25 * rr * ((a[1] - v[1]) / la + (b[1] - v[1]) / lb)]
                    }
                    const c = P(on)
                    return (
                      <g key={'w' + i}>
                        {grab(c, 'w' + i)}
                        <rect x={c[0] - 5 / view.k} y={c[1] - 5 / view.k} width={10 / view.k} height={10 / view.k} rx={2.5 / view.k} fill={ACCENT} stroke={theme.bg} strokeWidth={1.5 / view.k}
                          data-handle={'w' + i} className="handle bend" style={{ cursor: 'grab' }} />
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
            {wire && wireFrom && (() => {
              const d = wireTarget && wireTarget.id !== wireFrom.id
                ? pathOf(proj, routePair(wireFrom, wireTarget, doc.nodes))
                : (() => { const a = pt(proj, ...centerOf(wireFrom)), b = pt(proj, wire.to[0], wire.to[1]); return `M${f(a[0])} ${f(a[1])}L${f(b[0])} ${f(b[1])}` })()
              return <path d={d} fill="none" stroke={ACCENT} strokeWidth={2} strokeDasharray="5 6" strokeLinecap="round" pointerEvents="none" className="wire" />
            })()}
            {ghost && placing && (
              <g transform={`translate(${pt(proj, ghost[0], ghost[1]).map(f).join(' ')})`} pointerEvents="none" className="ghost">
                <polygon points={foot(0, 0, 0.1)} fill={ACCENT} fillOpacity={0.1} />
                <path d={fp(0, 0, 0.1)} fill="none" stroke={ACCENT} strokeWidth={2} strokeLinecap="round" />
                <g opacity={0.82}><Model type={placing} proj={proj} /></g>
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
            {single && tool === 'select' && !wire && !moving && !phone && (() => {
              const { u: hu } = upright(proj) // keep the handle on the component's screen-right side
              const hk = footOf(single) / 2
              const c = pt(proj, single.x + hk + hu[0] * (hk + 0.8), single.y + hk + hu[1] * (hk + 0.8))
              const r = 9.5 / view.k
              return (
                <g data-handle="connect" style={{ cursor: 'crosshair' }} className="connect-handle">
                  <title>Drag to connect</title>
                  {coarse && <circle cx={c[0]} cy={c[1]} r={22 / view.k} fill="transparent" />}
                  <circle cx={c[0]} cy={c[1]} r={r * 1.7} fill={ACCENT} opacity={0.16} className="pulse" />
                  <circle cx={c[0]} cy={c[1]} r={r} fill={ACCENT} />
                  <path d={`M${c[0] - r * 0.42} ${c[1]}H${c[0] + r * 0.42}M${c[0] + r * 0.06} ${c[1] - r * 0.36}L${c[0] + r * 0.44} ${c[1]}L${c[0] + r * 0.06} ${c[1] + r * 0.36}`}
                    fill="none" stroke={theme.bg} strokeWidth={1.8 / view.k} strokeLinecap="round" strokeLinejoin="round" />
                </g>
              )
            })()}
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
          {!single && <button aria-label="Group" data-tip="Wrap in group" onClick={wrapSelectionInArea}><Group size={14} /></button>}
          <button aria-label="Duplicate" data-tip={keys('Duplicate  ⌘D')} onClick={() => useStore.getState().duplicate(selection)}><Copy size={14} /></button>
          <button aria-label="Focus" data-tip="Focus  F" onClick={() => fitView(selNodes.map((n) => n.id))}><Scan size={14} /></button>
          <button aria-label="Delete" className="danger" data-tip={keys('Delete  ⌫')} onClick={() => useStore.getState().remove(selection)}><Trash2 size={14} /></button>
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
    </div>
  )
}

export { planeMatrix }
