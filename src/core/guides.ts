import { type NodeT, centerOf } from './types'

/**
 * What to mark on the canvas while components are being moved: where they have come level with others, and
 * where they are evenly spaced. These only report what is already true of the positions they are given. They
 * move nothing, so they are the same whether snapping is on or off. All values are in cells on the ground.
 */

/** One alignment line: at `at` on `axis`, running from `from` to `to` along the other axis. */
export interface Guide {
  /** `x` guides run along the y axis at a fixed x, and the other way round */
  axis: 'x' | 'y'
  at: number
  from: number
  to: number
}

/** One gap between two neighbours along `axis`, from `from` to `to`. */
export interface Gap { axis: 'x' | 'y'; /** where the gap sits across the axis */ at: number; from: number; to: number }

/**
 * Equal-spacing marks. When what is being moved sits exactly as far from its
 * neighbour on one side as on the other, or continues the rhythm its
 * neighbours already keep, the matching gaps are returned so they can be marked.
 * Everything moving is treated as one block, and gaps are measured between footprints, not centres.
 */
export function spacingGaps(nodes: NodeT[], moving: Set<string>): Gap[] {
  const mv = nodes.filter((n) => moving.has(n.id)), still = nodes.filter((n) => !moving.has(n.id))
  if (!mv.length || !still.length) return []
  const size = (n: NodeT) => 2 * (n.scale ?? 1)
  const box = { x0: Math.min(...mv.map((n) => n.x)), y0: Math.min(...mv.map((n) => n.y)), x1: Math.max(...mv.map((n) => n.x + size(n))), y1: Math.max(...mv.map((n) => n.y + size(n))) }
  const out: Gap[] = []
  for (const axis of ['x', 'y'] as const) {
    const lo = (n: NodeT) => (axis === 'x' ? n.x : n.y), hi = (n: NodeT) => lo(n) + size(n)
    const b0 = axis === 'x' ? box.x0 : box.y0, b1 = axis === 'x' ? box.x1 : box.y1
    const c0 = axis === 'x' ? box.y0 : box.x0, c1 = axis === 'x' ? box.y1 : box.x1
    // neighbours in the same row (or column): those level with what is moving
    const row = still.filter((n) => { const a = axis === 'x' ? n.y : n.x; return a < c1 - 0.01 && a + size(n) > c0 + 0.01 })
    const before = row.filter((n) => hi(n) <= b0 + 0.01).sort((p, q) => hi(q) - hi(p)), after = row.filter((n) => lo(n) >= b1 - 0.01).sort((p, q) => lo(p) - lo(q))
    const at = (c0 + c1) / 2, same = (a: number, b: number) => Math.abs(a - b) < 0.01
    const g0 = before.length ? b0 - hi(before[0]) : NaN, g1 = after.length ? lo(after[0]) - b1 : NaN
    const add = (from: number, to: number) => { if (to - from > 0.01 && !out.some((g) => g.axis === axis && same(g.from, from) && same(g.to, to))) out.push({ axis, at, from, to }) }
    if (g0 > 0.01 && same(g0, g1)) { add(hi(before[0]), b0); add(b1, lo(after[0])) }
    if (g0 > 0.01 && before.length > 1 && same(lo(before[0]) - hi(before[1]), g0)) { add(hi(before[1]), lo(before[0])); add(hi(before[0]), b0) }
    if (g1 > 0.01 && after.length > 1 && same(lo(after[1]) - hi(after[0]), g1)) { add(b1, lo(after[0])); add(hi(after[0]), lo(after[1])) }
  }
  return out
}

/**
 * Alignment guides for components being moved: one line for every row or
 * column on which a moving component's centre lines up with a resting one,
 * to within `tolerance` cells. Each line spans everything on it, so it reads
 * as "these are in line". Moving components are never aligned with each other.
 */
export function alignGuides(nodes: NodeT[], moving: Set<string>, tolerance = 0.01): Guide[] {
  const still = nodes.filter((n) => !moving.has(n.id))
  const out = new Map<string, Guide>()
  for (const m of nodes) {
    if (!moving.has(m.id)) continue
    const [mx, my] = centerOf(m)
    for (const s of still) {
      const [sx, sy] = centerOf(s)
      for (const [axis, at, a, b] of [['x', mx, my, sy], ['y', my, mx, sx]] as const) {
        if (Math.abs((axis === 'x' ? sx : sy) - at) > tolerance) continue
        const key = axis + at.toFixed(2)
        const g = out.get(key) ?? { axis, at, from: Math.min(a, b), to: Math.max(a, b) }
        g.from = Math.min(g.from, a, b); g.to = Math.max(g.to, a, b)
        out.set(key, g)
      }
    }
  }
  return [...out.values()]
}
