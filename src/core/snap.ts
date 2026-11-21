import { type NodeT, type Side, footOf } from './types'

/**
 * The small pieces of judgement that make direct manipulation feel right:
 * where a dragged thing wants to settle, what a connection being drawn is
 * reaching for, and where a component's doors are.
 *
 * All of it is pure geometry on the ground plane, so it behaves the same at
 * any zoom or camera angle and can be tested without a screen.
 */

export type W = [number, number]

/**
 * Magnetic rounding. What is being dragged follows the pointer the whole way,
 * but lingers near each grid line and hurries across the gap between two, so
 * it feels drawn to where it will land without ever jumping there.
 * Continuous everywhere: at a grid line it is the grid line, halfway it is halfway.
 */
export function soft(v: number, step = 1, pull = 1.7): number {
  const s = Math.round(v / step) * step
  const t = (v - s) / step // -0.5 … 0.5
  return s + Math.sign(t) * 0.5 * Math.pow(Math.abs(t) * 2, pull) * step
}

/** how far outside its footprint a component's doors sit */
export const PORT_OUT = 0.42
export const SIDES: Side[] = ['n', 'e', 's', 'w']

/** The four doors of a component: the middle of each side, a little way out. */
export function portsOf(n: Pick<NodeT, 'x' | 'y' | 'scale'>, out = PORT_OUT): Record<Side, W> {
  const s = footOf(n), cx = n.x + s / 2, cy = n.y + s / 2
  return { n: [cx, n.y - out], s: [cx, n.y + s + out], e: [n.x + s + out, cy], w: [n.x - out, cy] }
}

/** Distance from a ground point to a component's footprint (0 inside it). */
export function reachTo(n: Pick<NodeT, 'x' | 'y' | 'scale'>, p: W): number {
  const s = footOf(n)
  return Math.hypot(Math.max(n.x - p[0], 0, p[0] - (n.x + s)), Math.max(n.y - p[1], 0, p[1] - (n.y + s)))
}

/**
 * What a connection being drawn should snap to: the component under the
 * pointer if there is one, otherwise the nearest one within `reach`.
 * Near enough is good enough, which is what makes connecting forgiving.
 */
export function magnet<T extends Pick<NodeT, 'id' | 'x' | 'y' | 'scale'>>(nodes: T[], p: W, reach: number, skip?: string, under?: string | null): T | null {
  if (under && under !== skip) { const hit = nodes.find((n) => n.id === under); if (hit) return hit }
  let best: T | null = null, bd = reach
  for (const n of nodes) {
    if (n.id === skip) continue
    const d = reachTo(n, p)
    if (d < bd || (d === bd && best === null && d < reach)) { bd = d; best = n }
  }
  return best
}

/** The door within `reach` of the point, if the pointer is aiming for one in particular. */
export function doorNear(ports: Record<Side, W>, p: W, reach: number): Side | undefined {
  let best: Side | undefined, bd = reach
  for (const s of SIDES) { const d = Math.hypot(ports[s][0] - p[0], ports[s][1] - p[1]); if (d < bd) { bd = d; best = s } }
  return best
}

type Box = Pick<NodeT, 'id' | 'x' | 'y' | 'scale'>
const overlaps = (a: Box, ax: number, ay: number, b: Box) => {
  const sa = footOf(a), sb = footOf(b)
  return ax < b.x + sb - 0.01 && ax + sa > b.x + 0.01 && ay < b.y + sb - 0.01 && ay + sa > b.y + 0.01
}

/**
 * Where a set of components can actually be put down. Two components never
 * share ground, so if the spot asked for is taken the nearest free one is
 * offered instead: the answer is an offset to add to every one of them.
 * Searched outwards ring by ring, so it is always the closest that fits.
 */
export function clearOf(moving: Box[], still: Box[], dx: number, dy: number, step = 1, rings = 8): [number, number] {
  const fits = (ox: number, oy: number) => !moving.some((m) => still.some((s) => overlaps(m, m.x + ox, m.y + oy, s)))
  if (fits(dx, dy)) return [dx, dy]
  for (let r = 1; r <= rings; r++) {
    let best: [number, number] | null = null, bd = Infinity
    for (let i = -r; i <= r; i++) for (let j = -r; j <= r; j++) {
      if (Math.max(Math.abs(i), Math.abs(j)) !== r) continue
      const ox = dx + i * step, oy = dy + j * step, d = i * i + j * j
      if (d < bd && fits(ox, oy)) { bd = d; best = [ox, oy] }
    }
    if (best) return best
  }
  return [dx, dy]
}
