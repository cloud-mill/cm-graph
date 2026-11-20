import { create } from 'zustand'
import { defOf, defaultProps } from './catalog'
import { ISO_PITCH, ISO_YAW } from './iso'
import { inArea } from './layout'
import { guessKind, kindInfo } from './links'
import { legOfRun, routeAll } from './router'
import { getPref, saveDoc, setPref } from './storage'
import { type AreaT, type Doc, type EdgeT, type LabelT, type LinkKind, type NodeT, type PricingModel, type Side, emptyDoc, uid } from './types'

export type Tool = 'select' | 'connect' | 'area' | 'text' | 'orbit'
export type Panel = 'inspect' | 'budget' | 'advisor'
export type Lens = 'none' | 'cost'
export interface View { x: number; y: number; k: number }
export interface Toast { id: string; text: string; kind?: 'ok' | 'warn' }

interface State {
  doc: Doc
  past: Doc[]
  future: Doc[]
  selection: string[]
  tool: Tool
  /** component type being dragged in from the palette */
  placing: string | null
  /** with the connect tool: the component a connection is being drawn from, waiting for its other end */
  linkFrom: string | null
  /** the component or connection whose flow is being followed; everything off its paths is dimmed */
  trace: string | null
  /** touch: taps add to the selection instead of replacing it */
  multi: boolean
  view: View
  /** orbit camera, in degrees: rotation about the vertical axis and elevation above the ground */
  yaw: number
  pitch: number
  /** true while looking straight down (plan view) */
  flat: boolean
  panel: Panel
  lens: Lens
  showGrid: boolean
  showLabels: boolean
  flow: boolean
  /** which cloud the library is showing */
  provider: 'aws' | 'gcp' | 'azure'
  theme: 'dark' | 'light'
  pricing: PricingModel
  toasts: Toast[]
  saved: boolean
  /** the last autosave could not be written (storage full or blocked) */
  saveFailed: boolean
  focusName: number
  /** floating panels */
  showLib: boolean
  showInsp: boolean
  /** id of the component added most recently (drives its entrance animation) */
  fresh: string | null
  modal: null | 'export' | 'import' | 'shortcuts' | 'command' | 'history' | 'share' | 'gestures'

  load: (doc: Doc) => void
  /** Apply a change. Non-transient changes create an undo step. */
  apply: (fn: (d: Doc) => Doc, transient?: boolean) => void
  checkpoint: () => void
  undo: () => void
  redo: () => void
  select: (ids: string[], additive?: boolean) => void
  set: (p: Partial<State>) => void
  toast: (text: string, kind?: Toast['kind']) => void

  addNode: (type: string, x: number, y: number) => string
  addEdge: (from: string, to: string) => string | null
  /** a second connection between the same two components, for a second relationship */
  twinEdge: (id: string) => string | null
  /** move one end of a connection to another component, optionally pinned to a side of it */
  reconnect: (id: string, end: 'from' | 'to', node: string, side?: Side) => boolean
  /** say what a connection is; the line style follows */
  setKind: (ids: string[], kind: LinkKind) => void
  /** swap which end a connection starts from, keeping its path */
  reverseEdge: (ids: string[]) => void
  /** hand a connection's path back to the automatic router */
  resetRoute: (ids: string[]) => void
  /** put a waypoint on the longest run of a connection, ready to be dragged; returns its index */
  addBend: (id: string) => number
  addArea: (a: Omit<AreaT, 'id'>) => string
  addLabel: (x: number, y: number) => string
  patchNode: (id: string, p: Partial<NodeT>) => void
  patchProps: (ids: string[], p: Record<string, any>) => void
  patchEdge: (ids: string[], p: Partial<EdgeT>) => void
  patchArea: (id: string, p: Partial<AreaT>) => void
  patchLabel: (id: string, p: Partial<LabelT>) => void
  remove: (ids: string[]) => void
  duplicate: (ids: string[], dx?: number, dy?: number) => void
  copy: () => void
  paste: () => void
  nudge: (dx: number, dy: number) => void
  setTheme: (t: 'dark' | 'light') => void
}

let clipboard: { nodes: NodeT[]; edges: EdgeT[]; areas: AreaT[]; labels: LabelT[] } | null = null
let pasteCount = 0
const HISTORY = 120

/** `web-1` copied next to `web-1` and `web-2` becomes `web-3`; other names are left alone. */
function renumber(nodes: NodeT[], existing: NodeT[]): NodeT[] {
  const taken = new Set(existing.map((n) => n.name).filter(Boolean))
  return nodes.map((n) => {
    const m = n.name?.match(/^(.*?)-(\d+)$/)
    if (!m || !taken.has(n.name)) { if (n.name) taken.add(n.name); return n }
    let i = Number(m[2]) + 1
    while (taken.has(`${m[1]}-${i}`)) i++
    taken.add(`${m[1]}-${i}`)
    return { ...n, name: `${m[1]}-${i}` }
  })
}

const touch = (d: Doc): Doc => ({ ...d, updatedAt: Date.now() })

export const useStore = create<State>((set, get) => ({
  doc: emptyDoc(),
  past: [],
  future: [],
  selection: [],
  tool: 'select',
  placing: null,
  linkFrom: null,
  trace: null,
  multi: false,
  view: { x: 0, y: 0, k: 1 },
  yaw: ISO_YAW,
  pitch: ISO_PITCH,
  flat: false,
  panel: 'inspect',
  lens: 'none',
  showGrid: true,
  showLabels: true,
  flow: getPref('flow', true),
  provider: getPref<'aws' | 'gcp' | 'azure'>('provider', 'aws'),
  theme: getPref<'dark' | 'light'>('theme', 'dark'),
  pricing: 'ondemand',
  toasts: [],
  saved: true,
  saveFailed: false,
  focusName: 0,
  showLib: typeof innerWidth === 'undefined' || innerWidth > 1180,
  showInsp: typeof innerWidth === 'undefined' || innerWidth > 940,
  fresh: null,
  modal: null,

  load: (doc) => set({ doc, past: [], future: [], selection: [], tool: 'select', placing: null, linkFrom: null, trace: null, multi: false, saved: true, saveFailed: false, lens: 'none', modal: null, panel: 'inspect' }),

  apply: (fn, transient) => {
    const { doc, past } = get()
    const next = fn(doc)
    if (next === doc) return
    set(transient
      ? { doc: touch(next), saved: false }
      : { doc: touch(next), past: [...past.slice(-(HISTORY - 1)), doc], future: [], saved: false })
  },
  checkpoint: () => set((s) => ({ past: [...s.past.slice(-(HISTORY - 1)), s.doc], future: [] })),
  undo: () => {
    const { past, doc, future } = get()
    if (!past.length) return
    const prev = past[past.length - 1]
    set({ doc: touch(prev), past: past.slice(0, -1), future: [doc, ...future], selection: stillThere(prev, get().selection), saved: false })
  },
  redo: () => {
    const { past, doc, future } = get()
    if (!future.length) return
    set({ doc: touch(future[0]), past: [...past.slice(-(HISTORY - 1)), doc], future: future.slice(1), selection: stillThere(future[0], get().selection), saved: false })
  },
  select: (ids, additive) =>
    set((s) => {
      if (!additive) return { selection: ids }
      const cur = new Set(s.selection)
      for (const id of ids) cur.has(id) ? cur.delete(id) : cur.add(id)
      return { selection: [...cur] }
    }),
  set: (p) => set(p),
  toast: (text, kind = 'ok') => {
    const id = uid()
    set((s) => ({ toasts: [...s.toasts.slice(-3), { id, text, kind }] }))
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 3200)
  },

  addNode: (type, x, y) => {
    const id = uid()
    const d = defOf(type)
    // the lowest free number, so deleting web-1 and adding another never yields two web-2s
    const stem = d.type.replace(/^(gcp|az)-/, '')
    const taken = new Set(get().doc.nodes.map((n) => n.name))
    let i = 1
    while (taken.has(`${stem}-${i}`)) i++
    const name = d.props.length || type === 'block' ? `${stem}-${i}` : undefined
    get().apply((doc) => ({ ...doc, nodes: [...doc.nodes, { id, type, x, y, name, props: defaultProps(type) }] }))
    set({ selection: [id], panel: get().panel === 'advisor' ? 'inspect' : get().panel, fresh: id })
    setTimeout(() => get().fresh === id && set({ fresh: null }), 700)
    return id
  },
  addEdge: (from, to) => {
    const { doc } = get()
    if (from === to) return null
    if (!doc.nodes.some((n) => n.id === from) || !doc.nodes.some((n) => n.id === to)) return null
    // one line between two components by default, whichever way it was dragged: a slip of the hand should not double it.
    // A second relationship is added on purpose, from the connection's inspector
    if (doc.edges.some((e) => (e.from === from && e.to === to) || (e.from === to && e.to === from))) return null
    const id = uid()
    const a = doc.nodes.find((n) => n.id === from)!, b = doc.nodes.find((n) => n.id === to)!
    const kind = guessKind(a, b), k = kindInfo(kind)!
    get().apply((d) => ({ ...d, edges: [...d.edges, { id, from, to, style: k.style, arrow: k.arrow, width: 2, kind, origin: 'drawn' as const }] }))
    return id
  },
  twinEdge: (id) => {
    const e = get().doc.edges.find((x) => x.id === id)
    if (!e) return null
    const copy = { ...e, id: uid(), label: undefined, protocol: undefined, port: undefined, via: undefined, fromSide: undefined, toSide: undefined, origin: 'drawn' as const }
    get().apply((d) => ({ ...d, edges: [...d.edges, copy] }))
    set({ selection: [copy.id] })
    return copy.id
  },
  reconnect: (id, end, node, side) => {
    const { doc } = get()
    const e = doc.edges.find((x) => x.id === id)
    if (!e || !doc.nodes.some((n) => n.id === node)) return false
    const from = end === 'from' ? node : e.from, to = end === 'to' ? node : e.to
    if (from === to) return false
    const key = end === 'from' ? 'fromSide' : 'toSide'
    // moving an end onto another component keeps the shape the user gave the line; a side is pinned only when they aimed for one
    get().apply((d) => ({ ...d, edges: d.edges.map((x) => (x.id === id ? { ...x, from, to, [key]: side } : x)) }))
    return true
  },
  setKind: (ids, kind) => {
    const k = kindInfo(kind)!
    get().apply((d) => ({ ...d, edges: d.edges.map((e) => (ids.includes(e.id) ? { ...e, kind, style: k.style, arrow: k.arrow } : e)) }))
  },
  reverseEdge: (ids) => get().apply((d) => ({
    ...d,
    // the same line the other way round: its ends swap, and so do the sides and the order of its waypoints
    edges: d.edges.map((e) => (ids.includes(e.id) ? { ...e, from: e.to, to: e.from, fromSide: e.toSide, toSide: e.fromSide, ...(e.via ? { via: [...e.via].reverse() } : {}) } : e)),
  })),
  resetRoute: (ids) => get().apply((d) => ({ ...d, edges: d.edges.map((e) => (ids.includes(e.id) && (e.via || e.fromSide || e.toSide) ? { ...e, via: undefined, fromSide: undefined, toSide: undefined } : e)) })),
  addBend: (id) => {
    const { doc } = get()
    const e = doc.edges.find((x) => x.id === id), r = e && routeAll(doc.nodes, doc.edges).get(id)
    if (!e || !r) return -1
    // on the longest straight run, where there is the most room to pull it somewhere
    let best = 0, len = -1
    for (let i = 0; i < r.pts.length - 1; i++) { const l = Math.abs(r.pts[i + 1][0] - r.pts[i][0]) + Math.abs(r.pts[i + 1][1] - r.pts[i][1]); if (l > len) { len = l; best = i } }
    const a = r.pts[best], b = r.pts[best + 1], at: [number, number] = [Math.round((a[0] + b[0])) / 2, Math.round((a[1] + b[1])) / 2]
    const index = legOfRun(r, best), via = [...(e.via ?? [])]
    via.splice(index, 0, at)
    get().apply((d) => ({ ...d, edges: d.edges.map((x) => (x.id === id ? { ...x, via } : x)) }))
    return index
  },
  addArea: (a) => {
    const id = uid()
    get().apply((d) => ({ ...d, areas: [...d.areas, { ...a, id }] }))
    set({ selection: [id] })
    return id
  },
  addLabel: (x, y) => {
    const id = uid()
    get().apply((d) => ({ ...d, labels: [...d.labels, { id, x, y, text: 'Label', size: 20, dir: 'x' }] }))
    set({ selection: [id], focusName: get().focusName + 1 })
    return id
  },
  patchNode: (id, p) => get().apply((d) => ({ ...d, nodes: d.nodes.map((n) => (n.id === id ? { ...n, ...p } : n)) })),
  patchProps: (ids, p) => get().apply((d) => ({ ...d, nodes: d.nodes.map((n) => (ids.includes(n.id) ? { ...n, props: { ...n.props, ...p } } : n)) })),
  patchEdge: (ids, p) => get().apply((d) => ({ ...d, edges: d.edges.map((e) => (ids.includes(e.id) ? { ...e, ...p } : e)) })),
  patchArea: (id, p) => get().apply((d) => ({ ...d, areas: d.areas.map((a) => (a.id === id ? { ...a, ...p } : a)) })),
  patchLabel: (id, p) => get().apply((d) => ({ ...d, labels: d.labels.map((l) => (l.id === id ? { ...l, ...p } : l)) })),

  remove: (ids) => {
    if (!ids.length) return
    const kill = new Set(ids)
    const { doc } = get()
    // nothing on the canvas matches (a stale selection): leave history alone
    if (![...doc.nodes, ...doc.edges, ...doc.areas, ...doc.labels].some((x) => kill.has(x.id))) return
    get().apply((d) => ({
      ...d,
      nodes: d.nodes.filter((n) => !kill.has(n.id)),
      edges: d.edges.filter((e) => !kill.has(e.id) && !kill.has(e.from) && !kill.has(e.to)),
      areas: d.areas.filter((a) => !kill.has(a.id)),
      labels: d.labels.filter((l) => !kill.has(l.id)),
    }))
    set({ selection: [] })
  },
  duplicate: (ids, dx = 2, dy = 2) => {
    const { doc } = get()
    const sel = new Set(ids)
    const map = new Map<string, string>()
    const nodes = renumber(doc.nodes.filter((n) => sel.has(n.id)).map((n) => { const id = uid(); map.set(n.id, id); return { ...n, id, x: n.x + dx, y: n.y + dy } }), doc.nodes)
    const edges = doc.edges.filter((e) => map.has(e.from) && map.has(e.to)).map((e) => ({ ...e, id: uid(), from: map.get(e.from)!, to: map.get(e.to)!, ...(e.via ? { via: e.via.map(([x, y]) => [x + dx, y + dy] as [number, number]) } : {}) }))
    const areas = doc.areas.filter((a) => sel.has(a.id)).map((a) => ({ ...a, id: uid(), x: a.x + dx, y: a.y + dy }))
    const labels = doc.labels.filter((l) => sel.has(l.id)).map((l) => ({ ...l, id: uid(), x: l.x + dx, y: l.y + dy }))
    if (!nodes.length && !areas.length && !labels.length) return
    get().apply((d) => ({ ...d, nodes: [...d.nodes, ...nodes], edges: [...d.edges, ...edges], areas: [...d.areas, ...areas], labels: [...d.labels, ...labels] }))
    set({ selection: [...nodes, ...areas, ...labels].map((x) => x.id) })
  },
  copy: () => {
    const { doc, selection } = get()
    const sel = new Set(selection)
    const nodes = doc.nodes.filter((n) => sel.has(n.id))
    const ids = new Set(nodes.map((n) => n.id))
    clipboard = {
      nodes,
      edges: doc.edges.filter((e) => ids.has(e.from) && ids.has(e.to)),
      areas: doc.areas.filter((a) => sel.has(a.id)),
      labels: doc.labels.filter((l) => sel.has(l.id)),
    }
    pasteCount = 0
    if (nodes.length + clipboard.areas.length + clipboard.labels.length) get().toast(`Copied ${nodes.length + clipboard.areas.length + clipboard.labels.length} item(s)`)
  },
  paste: () => {
    if (!clipboard || !(clipboard.nodes.length + clipboard.areas.length + clipboard.labels.length)) return
    pasteCount++
    const off = pasteCount * 2
    const map = new Map<string, string>()
    const nodes = renumber(clipboard.nodes.map((n) => { const id = uid(); map.set(n.id, id); return { ...n, id, x: n.x + off, y: n.y + off } }), get().doc.nodes)
    const edges = clipboard.edges.map((e) => ({ ...e, id: uid(), from: map.get(e.from)!, to: map.get(e.to)!, ...(e.via ? { via: e.via.map(([x, y]) => [x + off, y + off] as [number, number]) } : {}) }))
    const areas = clipboard.areas.map((a) => ({ ...a, id: uid(), x: a.x + off, y: a.y + off }))
    const labels = clipboard.labels.map((l) => ({ ...l, id: uid(), x: l.x + off, y: l.y + off }))
    get().apply((d) => ({ ...d, nodes: [...d.nodes, ...nodes], edges: [...d.edges, ...edges], areas: [...d.areas, ...areas], labels: [...d.labels, ...labels] }))
    set({ selection: [...nodes, ...areas, ...labels].map((x) => x.id) })
  },
  nudge: (dx, dy) => {
    const sel = new Set(get().selection)
    if (!sel.size) return
    get().apply((d) => moveItems(d, d, sel, dx, dy))
  },
  setTheme: (theme) => {
    setPref('theme', theme)
    document.documentElement.dataset.theme = theme
    set({ theme })
  },
}))

/**
 * Move selected items by a delta measured from `base` (the doc at drag start).
 * Moving an area carries the nodes, labels and areas that sit inside it.
 */
/** What is selected stays selected through undo and redo, as long as it still exists: stepping back mid-edit should not drop what you were editing. */
function stillThere(doc: Doc, selection: string[]): string[] {
  if (!selection.length) return selection
  const ids = new Set([...doc.nodes, ...doc.edges, ...doc.areas, ...doc.labels].map((x) => x.id))
  return selection.filter((id) => ids.has(id))
}

export function moveItems(doc: Doc, base: Doc, sel: Set<string>, dx: number, dy: number): Doc {
  if (!dx && !dy && doc === base) return doc
  const carried = new Set(sel)
  for (const a of base.areas) {
    if (!sel.has(a.id)) continue
    for (const n of base.nodes) if (inArea(a, n)) carried.add(n.id)
    for (const l of base.labels) if (l.x >= a.x && l.x <= a.x + a.w && l.y >= a.y && l.y <= a.y + a.d) carried.add(l.id)
    for (const c of base.areas) if (c.id !== a.id && c.x >= a.x && c.y >= a.y && c.x + c.w <= a.x + a.w && c.y + c.d <= a.y + a.d) carried.add(c.id)
  }
  const bn = new Map(base.nodes.map((n) => [n.id, n]))
  const ba = new Map(base.areas.map((n) => [n.id, n]))
  const bl = new Map(base.labels.map((n) => [n.id, n]))
  const be = new Map(base.edges.map((e) => [e.id, e]))
  return {
    ...doc,
    nodes: doc.nodes.map((n) => (carried.has(n.id) && bn.has(n.id) ? { ...n, x: bn.get(n.id)!.x + dx, y: bn.get(n.id)!.y + dy } : n)),
    areas: doc.areas.map((a) => (carried.has(a.id) && ba.has(a.id) ? { ...a, x: ba.get(a.id)!.x + dx, y: ba.get(a.id)!.y + dy } : a)),
    labels: doc.labels.map((l) => (carried.has(l.id) && bl.has(l.id) ? { ...l, x: bl.get(l.id)!.x + dx, y: bl.get(l.id)!.y + dy } : l)),
    // a hand-shaped line whose two ends move together keeps its shape; one whose ends part company keeps its waypoints where they are
    edges: doc.edges.map((e) => {
      const b = be.get(e.id)
      return b?.via && carried.has(e.from) && carried.has(e.to) ? { ...e, via: b.via.map(([x, y]) => [x + dx, y + dy] as [number, number]) } : e
    }),
  }
}

// ---- autosave ---------------------------------------------------------------
let timer: ReturnType<typeof setTimeout> | undefined
let active = false
export function enableAutosave(on: boolean) {
  active = on
}
useStore.subscribe((s, prev) => {
  if (!active || s.doc === prev.doc) return
  clearTimeout(timer)
  timer = setTimeout(() => {
    const st = useStore.getState()
    if (!active) return
    if (saveDoc(st.doc)) { useStore.setState({ saved: true, saveFailed: false }); return }
    // say so once, not on every edit, and keep the work in memory so it can still be exported
    if (!st.saveFailed) st.toast('Could not save. Browser storage is full or blocked: export a copy to keep your work.', 'warn')
    useStore.setState({ saveFailed: true })
  }, 450)
})
export function flushSave() {
  clearTimeout(timer)
  if (active) saveDoc(useStore.getState().doc)
}

/** Kind lookup for an id within a doc. */
export function kindOf(doc: Doc, id: string): 'node' | 'edge' | 'area' | 'label' | null {
  if (doc.nodes.some((n) => n.id === id)) return 'node'
  if (doc.edges.some((n) => n.id === id)) return 'edge'
  if (doc.areas.some((n) => n.id === id)) return 'area'
  if (doc.labels.some((n) => n.id === id)) return 'label'
  return null
}

// ---- coalesced edits: rapid changes to the same field share one undo step ----
let lastKey = ''
let lastAt = 0
let lastDoc: Doc | null = null
export function coalesce(key: string, fn: (d: Doc) => Doc) {
  const now = Date.now()
  // only fold into the previous step if nothing else (an undo, another edit, a load) happened in between
  const transient = key === lastKey && now - lastAt < 1200 && useStore.getState().doc === lastDoc
  lastKey = key
  lastAt = now
  useStore.getState().apply(fn, transient)
  lastDoc = useStore.getState().doc
}
