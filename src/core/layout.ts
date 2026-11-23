import { defOf } from './catalog'
import { isShaped, unshaped } from './shape'
import { type AreaT, type Doc, type NodeT, centerOf, footOf } from './types'

/**
 * Arranging things for the user: area membership, lining up, spacing out, and the whole-diagram auto-layout.
 * Each function takes a document and returns a new one (or the same one when nothing would change), and is
 * only ever run because the user asked for it. Positions are in cells.
 */

/** A component belongs to an area when the centre of its footprint is inside it or on its border. Areas keep no list of members. */
export const inArea = (a: AreaT, n: Pick<NodeT, 'x' | 'y' | 'scale'>) =>
  centerOf(n)[0] >= a.x && centerOf(n)[0] <= a.x + a.w && centerOf(n)[1] >= a.y && centerOf(n)[1] <= a.y + a.d

/** Resize an area to wrap the given nodes (and optionally child rects), `pad` cells clear all round with half a cell more on the -y side. */
export function fitArea(a: AreaT, nodes: Pick<NodeT, 'x' | 'y' | 'scale'>[], pad = 1, extra: { x: number; y: number; w: number; d: number }[] = []): AreaT {
  if (!nodes.length && !extra.length) return a
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const n of nodes) { x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y); x1 = Math.max(x1, n.x + footOf(n)); y1 = Math.max(y1, n.y + footOf(n)) }
  for (const r of extra) { x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y); x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.d) }
  return { ...a, x: x0 - pad, y: y0 - pad - 0.5, w: x1 - x0 + pad * 2, d: y1 - y0 + pad * 2 + 0.5 }
}

const PX = 6 // column pitch, in cells
const PY = 5 // row pitch, in cells
const FREE = '~'

/** Which way a set of components mostly runs: along x (a row) or along y (a column). */
const runOf = (nodes: Pick<NodeT, 'x' | 'y' | 'scale'>[]) => {
  const cx = nodes.map((n) => n.x + (n.scale ?? 1)), cy = nodes.map((n) => n.y + (n.scale ?? 1))
  return Math.max(...cx) - Math.min(...cx) >= Math.max(...cy) - Math.min(...cy) ? 'x' : 'y'
}

/** the least room left between two components that are put in a line, in cells */
const MIN_GAP = 1

/** Put the chosen components in one straight line: a row if they mostly run sideways, a column if they are stacked. */
export function lineUp(doc: Doc, ids: string[]): Doc {
  const sel = doc.nodes.filter((n) => ids.includes(n.id))
  if (sel.length < 2) return doc
  const run = runOf(sel), across = run === 'x' ? 'y' : 'x'
  // the middle one stays where it is, so the line forms around the group instead of dragging it away
  const centres = sel.map((n) => n[across] + (n.scale ?? 1)).sort((a, b) => a - b), line = centres[Math.floor((centres.length - 1) / 2)]
  // brought into one line, two that were in different rows may land on top of each other: each is moved along just far enough to stand clear
  const order = [...sel].sort((a, b) => a[run] - b[run] || (a.id < b.id ? -1 : 1))
  const place = new Map<string, number>()
  let edge = -Infinity
  for (const n of order) { const at = Math.max(n[run], edge); place.set(n.id, at); edge = at + 2 * (n.scale ?? 1) + MIN_GAP }
  const next = doc.nodes.map((n) => (place.has(n.id) ? { ...n, [across]: Math.round((line - (n.scale ?? 1)) * 2) / 2, [run]: place.get(n.id)! } : n))
  return next.every((n, i) => n.x === doc.nodes[i].x && n.y === doc.nodes[i].y) ? doc : { ...doc, nodes: next }
}

/** Space the chosen components evenly along the way they run. The two at the ends stay put unless that would leave the rest touching. */
export function spaceEvenly(doc: Doc, ids: string[]): Doc {
  const sel = doc.nodes.filter((n) => ids.includes(n.id))
  if (sel.length < 3) return doc
  const run = runOf(sel)
  const order = [...sel].sort((a, b) => a[run] + (a.scale ?? 1) - (b[run] + (b.scale ?? 1)))
  const size = (n: (typeof sel)[number]) => 2 * (n.scale ?? 1)
  const span = order[order.length - 1][run] + size(order[order.length - 1]) - order[0][run]
  // equal gaps between footprints, on the half-cell grid, and never less than the least room
  const gap = Math.max(MIN_GAP, Math.round(((span - order.reduce((t, n) => t + size(n), 0)) / (order.length - 1)) * 2) / 2)
  const place = new Map<string, number>()
  let at = order[0][run]
  for (const n of order) { place.set(n.id, at); at += size(n) + gap }
  if (order.every((n) => place.get(n.id) === n[run])) return doc
  return { ...doc, nodes: doc.nodes.map((n) => (place.has(n.id) ? { ...n, [run]: place.get(n.id)! } : n)) }
}

/**
 * Layered (Sugiyama-style) layout that understands areas.
 *
 * Columns follow the request path (longest-path ranking). Rows are grouped
 * into lanes: every innermost area gets its own band of rows, sibling areas
 * are stacked next to each other, and components outside any area either stay
 * inline with their neighbours or step aside when their column runs through an
 * area. Areas are then re-wrapped around their members.
 *
 * Every component is given a new place, laid out from the origin, and every hand-shaped
 * connection is handed back to the router. `membership` (area id to component ids) says
 * who belongs to which area when positions cannot: an import, where nothing has a place yet.
 */
export function autoLayout(doc: Doc, membership?: Map<string, string[]>): Doc {
  const nodes = doc.nodes
  if (!nodes.length) return doc
  const ids = new Set(nodes.map((n) => n.id))
  const edges = doc.edges.filter((e) => ids.has(e.from) && ids.has(e.to) && e.from !== e.to)

  // ---- membership (captured before anything moves)
  const members = membership ?? new Map(doc.areas.map((a) => [a.id, nodes.filter((n) => inArea(a, n)).map((n) => n.id)]))
  const live = doc.areas.filter((a) => (members.get(a.id) ?? []).length)
  const size = (a: AreaT) => members.get(a.id)!.length
  // parent = smallest area whose member set strictly contains this one's
  const parentOf = new Map<string, string | undefined>()
  for (const a of live) {
    const mine = members.get(a.id)!
    const parent = live
      .filter((b) => b.id !== a.id && size(b) > size(a) && mine.every((m) => members.get(b.id)!.includes(m)))
      .sort((p, q) => size(p) - size(q))[0]
    parentOf.set(a.id, parent?.id)
  }
  // leaf group of a node = its smallest area
  const leafOf = new Map<string, string>()
  const bySize = [...live].sort((a, b) => size(a) - size(b))
  for (const n of nodes) leafOf.set(n.id, bySize.find((a) => members.get(a.id)!.includes(n.id))?.id ?? FREE)
  const chain = (id: string): string[] => (parentOf.get(id) ? [...chain(parentOf.get(id)!), id] : [id])

  // ---- ranks: longest path over the DAG left after dropping back-edges
  const out = new Map<string, string[]>(), inn = new Map<string, string[]>(), adj = new Map<string, string[]>()
  for (const n of nodes) { out.set(n.id, []); inn.set(n.id, []); adj.set(n.id, []) }
  for (const e of edges) adj.get(e.from)!.push(e.to)
  const state = new Map<string, number>()
  const visit = (u: string) => {
    state.set(u, 1)
    for (const v of adj.get(u)!) {
      if (state.get(v) === 1) continue
      out.get(u)!.push(v); inn.get(v)!.push(u)
      if (!state.has(v)) visit(v)
    }
    state.set(u, 2)
  }
  for (const n of [...nodes].sort((a, b) => defOf(a.type).tier - defOf(b.type).tier)) if (!state.has(n.id)) visit(n.id)

  const rank = new Map<string, number>()
  const rankOf = (u: string): number => {
    if (rank.has(u)) return rank.get(u)!
    rank.set(u, 0)
    const ps = inn.get(u)!
    const r = ps.length ? Math.max(...ps.map(rankOf)) + 1 : 0
    rank.set(u, r)
    return r
  }
  nodes.forEach((n) => rankOf(n.id))
  const linked = (id: string) => inn.get(id)!.length + out.get(id)!.length > 0
  const maxRank = Math.max(0, ...nodes.filter((n) => linked(n.id)).map((n) => rank.get(n.id)!))
  for (const n of nodes) {
    if (linked(n.id)) continue
    rank.set(n.id, Math.max(0, Math.min(maxRank + 1, Math.round(((defOf(n.type).tier + 2) / 10) * (maxRank + 1)))))
  }
  // pull sources next to their first consumer so edges stay short
  for (const n of nodes) {
    const os = out.get(n.id)!
    if (!inn.get(n.id)!.length && os.length) rank.set(n.id, Math.min(...os.map((o) => rank.get(o)!)) - 1)
  }
  const minRank = Math.min(...nodes.map((n) => rank.get(n.id)!))
  const layers: string[][] = []
  for (const n of nodes) (layers[rank.get(n.id)! - minRank] ??= []).push(n.id)
  for (let i = 0; i < layers.length; i++) layers[i] ??= []
  const col = new Map<string, number>()
  layers.forEach((l, i) => l.forEach((id) => col.set(id, i)))

  // ---- order within columns: barycentre sweeps
  const pos = new Map<string, number>()
  layers.forEach((l) => l.forEach((id, i) => pos.set(id, i)))
  for (let it = 0; it < 4; it++) {
    const fwd = it % 2 === 0
    for (const l of fwd ? layers : [...layers].reverse()) {
      const bc = new Map(l.map((id) => {
        const nb = (fwd ? inn : out).get(id)!
        return [id, nb.length ? nb.reduce((s, v) => s + pos.get(v)!, 0) / nb.length : pos.get(id)!] as const
      }))
      l.sort((a, b) => bc.get(a)! - bc.get(b)!)
      l.forEach((id, i) => pos.set(id, i))
    }
  }

  // ---- lanes: one band of rows per leaf area, siblings kept adjacent
  const y = new Map<string, number>()
  const groups = [...new Set(nodes.map((n) => leafOf.get(n.id)!))].filter((g) => g !== FREE)
  const avgPos = (g: string) => {
    const ms = nodes.filter((n) => leafOf.get(n.id) === g)
    return ms.reduce((s, n) => s + pos.get(n.id)!, 0) / ms.length
  }
  const groupPos = new Map(groups.map((g) => [g, avgPos(g)]))
  const topPos = new Map<string, number>()
  for (const g of groups) { const t = chain(g)[0]; topPos.set(t, Math.min(topPos.get(t) ?? Infinity, groupPos.get(g)!)) }
  groups.sort((a, b) => {
    const ca = chain(a), cb = chain(b)
    if (ca[0] !== cb[0]) return topPos.get(ca[0])! - topPos.get(cb[0])! || ca[0].localeCompare(cb[0])
    // direct members of a parent sit before its child areas
    return ca.length - cb.length || groupPos.get(a)! - groupPos.get(b)! || a.localeCompare(b)
  })
  let cursor = 0
  let prevTop = ''
  for (const g of groups) {
    const perLayer = layers.map((l) => l.filter((id) => leafOf.get(id) === g))
    const rows = Math.max(...perLayer.map((l) => l.length))
    if (prevTop && chain(g)[0] !== prevTop) cursor += 2 // breathing room between unrelated areas
    prevTop = chain(g)[0]
    for (const l of perLayer) l.forEach((id, i) => y.set(id, cursor + Math.round(((rows - l.length) / 2 + i) * PY)))
    cursor += rows * PY
  }
  const bandMid = groups.length ? (cursor - PY) / 2 : 0

  // ---- free components: inline with neighbours unless their column crosses an area
  const span = new Map<string, [number, number]>()
  for (const a of live) {
    const cs = members.get(a.id)!.map((id) => col.get(id)!)
    span.set(a.id, [Math.min(...cs), Math.max(...cs)])
  }
  const blocked = (c: number) => [...span.values()].some(([lo, hi]) => c >= lo && c <= hi)
  const free = nodes.filter((n) => leafOf.get(n.id) === FREE)
  for (let pass = 0; pass < 3; pass++) {
    for (const l of layers) {
      const fs = l.filter((id) => leafOf.get(id) === FREE)
      if (!fs.length) continue
      const want = new Map(fs.map((id) => {
        const nb = [...inn.get(id)!, ...out.get(id)!].filter((v) => y.has(v))
        return [id, nb.length ? nb.reduce((s, v) => s + y.get(v)!, 0) / nb.length : y.get(id) ?? bandMid] as const
      }))
      fs.sort((a, b) => want.get(a)! - want.get(b)! || pos.get(a)! - pos.get(b)!)
      if (groups.length && blocked(col.get(fs[0])!)) {
        // step aside: above or below the lanes, whichever is nearer
        const up = fs.filter((id) => want.get(id)! < bandMid), down = fs.filter((id) => want.get(id)! >= bandMid)
        up.reverse().forEach((id, i) => y.set(id, -PY - 1 - i * PY))
        down.forEach((id, i) => y.set(id, cursor + 1 + i * PY))
      } else {
        const mid = fs.reduce((s, id) => s + want.get(id)!, 0) / fs.length
        fs.forEach((id, i) => y.set(id, Math.round(mid + (i - (fs.length - 1) / 2) * PY)))
      }
    }
  }
  void free

  const moved = nodes.map((n) => ({ ...n, x: col.get(n.id)! * PX, y: y.get(n.id) ?? 0 }))
  // final guard against stacked components in the same column
  for (const l of layers) {
    const colNodes = l.map((id) => moved.find((n) => n.id === id)!).sort((a, b) => a.y - b.y)
    for (let i = 1; i < colNodes.length; i++) if (colNodes[i].y - colNodes[i - 1].y < 3) colNodes[i].y = colNodes[i - 1].y + 3
  }
  const byId = new Map(moved.map((n) => [n.id, n]))

  // ---- re-wrap areas, innermost first so parents enclose their children
  const fitted = new Map<string, AreaT>()
  for (const a of bySize) {
    const ns = members.get(a.id)!.map((id) => byId.get(id)!).filter(Boolean)
    const kids = bySize.filter((c) => parentOf.get(c.id) === a.id && fitted.has(c.id)).map((c) => fitted.get(c.id)!)
    fitted.set(a.id, fitArea(a, ns, 1, kids.map((c) => ({ x: c.x - 0.75, y: c.y - 0.75, w: c.w + 1.5, d: c.d + 1.5 }))))
  }
  // every component has a new place, so paths shaped by hand for the old places no longer mean anything
  const edgesOut = doc.edges.some(isShaped) ? doc.edges.map((e) => (isShaped(e) ? unshaped(e) : e)) : doc.edges
  return { ...doc, nodes: moved, edges: edgesOut, areas: doc.areas.map((a) => fitted.get(a.id) ?? a) }
}
