import { type NodeT, centerOf } from './types'

export interface Guide {
  /** `x` guides run along the y axis at a fixed x, and the other way round */
  axis: 'x' | 'y'
  at: number
  from: number
  to: number
}

/**
 * Alignment guides for components being moved: one line for every row or
 * column of the grid on which a moving component's centre lines up with a
 * resting one. Each line spans everything on it, so it reads as "these are in line".
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
