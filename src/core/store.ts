import { create } from 'zustand'
import { defOf, defaultProps } from './catalog'
import { ISO_PITCH, ISO_YAW } from './iso'
import { inArea } from './layout'
import { guessKind, kindInfo } from './links'
import { bendAt, isShaped, keepPath, lineUpEnds, shifted, straighten, tidyKinks, unbend, unshaped } from './shape'
import { planKey, withPlans } from './router'
import { getPref, saveDoc, setPref } from './storage'
import { type AreaT, type Doc, type EdgeT, type LabelT, type LinkKind, type NodeT, type PricingModel, type Side, emptyDoc, uid } from './types'

/**
 * The editor's one store: the open blueprint with its undo history, and the interface state around it (selection,
 * tool, camera, panels, preferences, toasts).
 *
 * The blueprint only changes through `apply` (and `load`, `undo`, `redo`); every editing action below is a thin
 * wrapper round it. A document in the store is immutable: a change is a new `Doc`, and anything untouched keeps
 * its identity, which is what the canvas relies on to redraw only what changed.
 *
 * Not held here: the live document drawn during a drag (the canvas keeps that and commits it with `apply` on
 * release), and anything in browser storage beyond the autosave at the bottom of this file.
 */
export type Tool = 'select' | 'connect' | 'area' | 'text' | 'orbit'
export type Panel = 'inspect' | 'budget' | 'advisor'
export type Lens = 'none' | 'cost'
/** Pan and zoom: scene pixels are scaled by `k`, then moved by (x, y) screen pixels. */
export interface View { x: number; y: number; k: number }
export interface Toast { id: string; text: string; kind?: 'ok' | 'warn' }

interface State {
  /** the blueprint as committed. Every line the router owns carries a plan that stands (see `apply`) */
  doc: Doc
  /** undo steps, oldest first, at most `HISTORY` of them; whole documents, which is cheap because they share what did not change */
  past: Doc[]
  /** redo steps, nearest first; emptied by any new undo step */
  future: Doc[]
  /** ids of anything selected: components, connections, areas and labels share one id space */
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
  /** off (as it starts): everything goes exactly where it is put. On: components keep to the grid and lines are drawn to what they would line up with */
  snap: boolean
  showLabels: boolean
  flow: boolean
  /** which cloud the library is showing */
  provider: 'aws' | 'gcp' | 'azure'
  theme: 'dark' | 'light'
  pricing: PricingModel
  toasts: Toast[]
  /** false from an edit until the autosave that follows it has been written */
  saved: boolean
  /** the last autosave could not be written (storage full or blocked) */
  saveFailed: boolean
  /** a counter, not a value: adding one asks the inspector to put the cursor in the name field of what is selected */
  focusName: number
  /** floating panels */
  showLib: boolean
  showInsp: boolean
  /** id of the component added most recently (drives its entrance animation) */
  fresh: string | null
  modal: null | 'export' | 'import' | 'shortcuts' | 'command' | 'history' | 'share' | 'gestures'

  /** Open a blueprint: it replaces the document, clears history and selection, and plans any line that has no plan yet (older files) */
  load: (doc: Doc) => void
  /**
   * The one way the blueprint is edited. `fn` gets the current document and returns the next; returning the same
   * object means "nothing changed" and nothing happens, no undo step included. Otherwise the result is passed
   * through `withPlans` (so every line the router owns leaves here with a path that stands), stamped with a new
   * `updatedAt`, and stored as exactly one undo step, with redo emptied.
   *
   * `transient` stores the change without an undo step of its own, so it becomes part of the step before it:
   * for the later parts of something the user sees as one action. It does not empty redo.
   */
  apply: (fn: (d: Doc) => Doc, transient?: boolean) => void
  /** Make an undo step of the document as it is now, without changing it, so that transient changes after it undo back to here */
  checkpoint: () => void
  /** Undo and redo put a stored document back as it was, plans included: nothing is planned again */
  undo: () => void
  redo: () => void
  /** `additive` toggles each id in or out of the selection instead of replacing it */
  select: (ids: string[], additive?: boolean) => void
  /** Set interface state directly. Not for `doc`: that would skip planning, history and the unsaved mark */
  set: (p: Partial<State>) => void
  toast: (text: string, kind?: Toast['kind']) => void

  /** (x, y) is the corner of the footprint, in cells. Returns the new id */
  addNode: (type: string, x: number, y: number) => string
  /** null when nothing was added: an end is missing, both ends are the same, or the two are already connected (either way round) */
  addEdge: (from: string, to: string) => string | null
  /** add a component and connect it from `from` (or, with `into`, drop it into the middle of that connection): one undo step */
  addLinked: (type: string, x: number, y: number, link: { from?: string; into?: string }) => string
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
  /** take the path each of these is drawn with now as its own, so the router leaves it alone from then on */
  keepRoute: (ids: string[]) => void
  /** put a step into a connection at the point of its line nearest `at` */
  addBend: (id: string, at: [number, number]) => void
  /** take the turn at point `corner` of a connection's drawn line out of it */
  removeBend: (id: string, corner: number) => void
  /** make connections one straight line where they can be; says how many could not, and why */
  straighten: (ids: string[]) => { straight: number; apart: number }
  /** take the small kinks out of these connections; says how many it changed, and how many of those had been the router's */
  cleanLines: (ids: string[]) => { tidied: number; taken: number }
  /** move one end's component level with the other, so the connection between them is straight */
  lineUp: (id: string) => void
  /** draw connections as right-angled runs (no shape), one direct line, or a curve */
  setShape: (ids: string[], shape: EdgeT['shape']) => void
  addArea: (a: Omit<AreaT, 'id'>) => string
  addLabel: (x: number, y: number) => string
  patchNode: (id: string, p: Partial<NodeT>) => void
  patchProps: (ids: string[], p: Record<string, any>) => void
  patchEdge: (ids: string[], p: Partial<EdgeT>) => void
  patchArea: (id: string, p: Partial<AreaT>) => void
  patchLabel: (id: string, p: Partial<LabelT>) => void
  /** removing a component removes the connections at it too */
  remove: (ids: string[]) => void
  /** copies are offset by (dx, dy) cells; connections come along only when both their ends are copied */
  duplicate: (ids: string[], dx?: number, dy?: number) => void
  /** copy and paste use a clipboard private to this tab, not the system one */
  copy: () => void
  paste: () => void
  /** move the selection by (dx, dy) cells */
  nudge: (dx: number, dy: number) => void
  setTheme: (t: 'dark' | 'light') => void
}

// to a thousandth of a cell; the `+ 0` turns -0 into 0, so a position never reads or compares as minus zero
const r3 = (v: number) => Math.round(v * 1000) / 1000 + 0
let clipboard: { nodes: NodeT[]; edges: EdgeT[]; areas: AreaT[]; labels: LabelT[] } | null = null
// how many times the clipboard has been pasted, so each paste lands two cells further on and not on top of the last
let pasteCount = 0
/** the most undo steps kept; older ones fall off the far end */
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
  snap: getPref('snap', false),
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

  load: (doc) => set({ doc: withPlans(doc), past: [], future: [], selection: [], tool: 'select', placing: null, linkFrom: null, trace: null, multi: false, saved: true, saveFailed: false, lens: 'none', modal: null, panel: 'inspect' }),

  apply: (fn, transient) => {
    const { doc, past } = get()
    const made = fn(doc)
    if (made === doc) return
    // every line the router owns has its path planned here, once, as part of the edit that called for it
    const next = withPlans(made)
    set(transient
      ? { doc: touch(next), saved: false }
      : { doc: touch(next), past: [...past.slice(-(HISTORY - 1)), doc], future: [], saved: false })
  },
  checkpoint: () => set((s) => ({ past: [...s.past.slice(-(HISTORY - 1)), s.doc], future: [] })),
  // undo and redo count as edits to be saved: the document gets a new `updatedAt` (so it is a new object, not the one in history)
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
  addLinked: (type, x, y, link) => {
    const id = get().addNode(type, x, y)
    // transient: the connection joins the undo step `addNode` has just made
    get().apply((d) => {
      const made = d.nodes.find((n) => n.id === id)!
      if (link.into) {
        // the line that ran A → B now runs A → new → B, keeping what it was; a hand-shaped path no longer fits and is let go
        const e = d.edges.find((x) => x.id === link.into)
        if (!e) return d
        const plain = unshaped(e, false)
        return { ...d, edges: d.edges.flatMap((x) => (x.id === e.id ? [{ ...plain, to: id, fromSide: e.fromSide }, { ...plain, id: uid(), from: id, label: undefined, toSide: e.toSide }] : [x])) }
      }
      const a = d.nodes.find((n) => n.id === link.from)
      if (!a) return d
      const kind = guessKind(a, made), k = kindInfo(kind)!
      return { ...d, edges: [...d.edges, { id: uid(), from: a.id, to: id, style: k.style, arrow: k.arrow, width: 2, kind, origin: 'drawn' as const }] }
    }, true)
    return id
  },
  twinEdge: (id) => {
    const e = get().doc.edges.find((x) => x.id === id)
    if (!e) return null
    const copy = { ...unshaped(e), id: uid(), label: undefined, protocol: undefined, port: undefined, origin: 'drawn' as const }
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
    get().apply((d) => ({ ...d, edges: d.edges.map((x) => (x.id === id ? reended(e, end, node, side) : x)) }))
    return true
  },
  setKind: (ids, kind) => {
    const k = kindInfo(kind)!
    get().apply((d) => ({ ...d, edges: d.edges.map((e) => (ids.includes(e.id) ? { ...e, kind, style: k.style, arrow: k.arrow } : e)) }))
  },
  reverseEdge: (ids) => get().apply((d) => ({
    ...d,
    // the same line the other way round: its ends swap, and so do the sides, the order of its runs, and the path planned for it
    edges: d.edges.map((e) => {
      if (!ids.includes(e.id)) return e
      const { plan, ...rest } = e
      const turned: EdgeT = { ...rest, from: e.to, to: e.from, fromSide: e.toSide, toSide: e.fromSide, fromAt: e.toAt, toAt: e.fromAt, ...(e.via ? { via: [...e.via].reverse() } : {}), ...(e.runs ? { runs: [...e.runs].reverse() } : {}) }
      const a = d.nodes.find((n) => n.id === turned.from), b = d.nodes.find((n) => n.id === turned.to)
      return plan && a && b ? { ...turned, plan: { pts: [...plan.pts].reverse(), fromSide: plan.toSide, toSide: plan.fromSide, key: planKey(turned, a, b) } } : turned
    }),
  })),
  // handing a line to the router is asking for it to be planned now: whatever it carried, and any plan it had, goes
  resetRoute: (ids) => get().apply((d) => ({ ...d, edges: d.edges.map((e) => (ids.includes(e.id) && (isShaped(e) || e.plan) ? unshaped(e) : e)) })),
  keepRoute: (ids) => get().apply((d) => keepPath(d, ids)),
  addBend: (id, at) => get().apply((d) => bendAt(d, id, at)),
  removeBend: (id, corner) => get().apply((d) => unbend(d, id, corner)),
  straighten: (ids) => {
    const { doc, ...count } = straighten(get().doc, ids)
    get().apply(() => doc)
    return count
  },
  cleanLines: (ids) => {
    const { doc, ...count } = tidyKinks(get().doc, ids)
    if (count.tidied) get().apply(() => doc)
    return count
  },
  lineUp: (id) => get().apply((d) => lineUpEnds(d, id)),
  setShape: (ids, shape) => get().apply((d) => ({
    ...d,
    // a direct line or a curve has no track to follow, so one laid for right-angled runs is let go; going back to right angles starts from the router's plan
    edges: d.edges.map((e) => { if (!ids.includes(e.id) || e.shape === shape) return e; const plain = unshaped(e, false); return shape ? { ...plain, shape } : plain }),
  })),
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
    const edges = doc.edges.filter((e) => map.has(e.from) && map.has(e.to)).map((e) => shifted({ ...e, id: uid(), from: map.get(e.from)!, to: map.get(e.to)! }, dx, dy))
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
    const edges = clipboard.edges.map((e) => shifted({ ...e, id: uid(), from: map.get(e.from)!, to: map.get(e.to)! }, off, off))
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

/** What is selected stays selected through undo and redo, as long as it still exists: stepping back mid-edit should not drop what you were editing. */
function stillThere(doc: Doc, selection: string[]): string[] {
  if (!selection.length) return selection
  const ids = new Set([...doc.nodes, ...doc.edges, ...doc.areas, ...doc.labels].map((x) => x.id))
  return selection.filter((id) => ids.has(id))
}

/**
 * A connection with one end moved to another component. The track it was following was laid between the old ends, so it is
 * let go and the line is planned afresh; a side is pinned only when one was aimed for, and the other end keeps what it had.
 * The same function draws the line while the end is still in the hand, so what is shown is what is made.
 */
export function reended(e: EdgeT, end: 'from' | 'to', node: string, side?: Side): EdgeT {
  const { via: _v, runs: _r, fromAt: _a, toAt: _b, plan: _p, ...rest } = e
  return { ...rest, from: end === 'from' ? node : e.from, to: end === 'to' ? node : e.to, [end === 'from' ? 'fromSide' : 'toSide']: side }
}

/**
 * Move selected items by a delta measured from `base` (the doc at drag start).
 * Moving an area carries the nodes, labels and areas that sit inside it.
 *
 * (dx, dy) is the whole movement so far, in cells, not a step since the last call: positions are always worked
 * out from `base`, so a long drag cannot drift, and what an area carries is decided once, by where things stood
 * at the start. `doc` is the document to write the positions into, which may already differ from `base` in other ways.
 * Pure: the canvas uses it for the live document during a drag, and `nudge` for a committed move.
 */
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
    nodes: doc.nodes.map((n) => (carried.has(n.id) && bn.has(n.id) ? { ...n, x: r3(bn.get(n.id)!.x + dx), y: r3(bn.get(n.id)!.y + dy) } : n)),
    areas: doc.areas.map((a) => (carried.has(a.id) && ba.has(a.id) ? { ...a, x: r3(ba.get(a.id)!.x + dx), y: r3(ba.get(a.id)!.y + dy) } : a)),
    labels: doc.labels.map((l) => (carried.has(l.id) && bl.has(l.id) ? { ...l, x: r3(bl.get(l.id)!.x + dx), y: r3(bl.get(l.id)!.y + dy) } : l)),
    // a hand-shaped line whose two ends move together goes with them; one whose ends part company keeps its track where it was laid
    edges: doc.edges.map((e) => {
      const b = be.get(e.id)
      return b && (b.via || b.runs) && carried.has(e.from) && carried.has(e.to) ? { ...e, ...shifted(b, dx, dy) } : e
    }),
  }
}

// ---- autosave ---------------------------------------------------------------
// Any change of `doc` identity schedules a write to browser storage 450 ms after the last one. The subscription
// lives for the life of the module; `active` is what turns it on and off, so nothing is written while no blueprint
// is open or while one is being loaded.
let timer: ReturnType<typeof setTimeout> | undefined
let active = false
/** Turn autosave on or off. A write still waiting when it is turned off is not made while it stays off: call `flushSave` first. */
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
/** Write the document now instead of waiting, for when the page or the editor is about to go. Does nothing while autosave is off, and does not update `saved`. */
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
/**
 * `apply`, for edits that arrive as a stream (typing in a field, dragging a slider). Edits with the same `key` less
 * than 1.2 s apart become one undo step; `key` should name the field and the item, so different fields never merge.
 */
export function coalesce(key: string, fn: (d: Doc) => Doc) {
  const now = Date.now()
  // only fold into the previous step if nothing else (an undo, another edit, a load) happened in between
  const transient = key === lastKey && now - lastAt < 1200 && useStore.getState().doc === lastDoc
  lastKey = key
  lastAt = now
  useStore.getState().apply(fn, transient)
  lastDoc = useStore.getState().doc
}
