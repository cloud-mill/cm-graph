import { memo, type ReactNode } from 'react'
import { type Proj, type Pt, U, f, mix, poly, pt, shade } from '../core/iso'
import { type ModelKind, defOf } from '../core/catalog'
import { GLYPHS } from './glyphs'

/**
 * Procedural isometric component models. Everything is built from a few
 * solids (box, cylinder/frustum) projected through `Proj`, so models morph
 * smoothly between the isometric and plan views. Geometry is expressed in the
 * node's local space: a 2×2 footprint with the origin at its back corner.
 *
 * A model is two things: its shapes, and the gradients those shapes are filled with. The gradients are named after
 * the colour they shade, so every model of that colour shares them, and whoever draws models puts them in the
 * document once (`ModelDefs`). A face is one shape with one fill: the light falling off down a wall and the sheen
 * across a lid are part of the gradient it is filled with, not a second shape laid over the first.
 */

interface Ctx {
  p: Proj
  k: number // unique-ish key counter
  /** flat colours and no small detail: for a view from so far out that neither could be seen */
  plain: boolean
  /** the gradients the shapes built so far are filled with, by id */
  defs: Map<string, ReactNode>
}

const P = (c: Ctx, x: number, y: number, z: number): Pt => pt(c.p, x, y, z)

/** The fill of a wall of this colour: the colour itself at the top, falling off into shadow towards the ground. */
function wall(c: Ctx, color: string): string {
  if (c.plain) return color
  const id = 'mw' + color.slice(1)
  if (!c.defs.has(id)) c.defs.set(id, (
    <linearGradient key={id} id={id} x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stopColor={color} />
      <stop offset="1" stopColor={mix(color, '#000000', 0.26)} />
    </linearGradient>
  ))
  return `url(#${id})`
}
/** The fill of a lid of this colour: a soft sheen across the corner nearest the light, fading into the colour itself. */
function sheen(c: Ctx, color: string): string {
  if (c.plain) return color
  const id = 'ml' + color.slice(1)
  if (!c.defs.has(id)) c.defs.set(id, (
    <linearGradient key={id} id={id} x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stopColor={mix(color, '#ffffff', 0.2)} />
      <stop offset="0.55" stopColor={color} />
    </linearGradient>
  ))
  return `url(#${id})`
}

// World-fixed light: each face keeps its shade as the camera orbits, which is
// the depth cue that makes the scene read as solid.
const SHADE = { top: 0.14, yp: -0.12, xp: -0.34, xn: -0.2, yn: -0.42 }
/** larger = nearer the camera (for painter's ordering of solids on the ground) */
const depth = (c: Ctx, x: number, y: number) => x * c.p.c + y * c.p.d

function box(c: Ctx, x: number, y: number, z: number, w: number, d: number, h: number, color: string, top?: string): ReactNode {
  const x1 = x + w, y1 = y + d, z1 = z + h
  // of each pair of opposite sides, only the one facing the camera is drawn
  const yFront = c.p.d >= 0, xFront = c.p.c >= 0
  const fy = yFront ? y1 : y, fx = xFront ? x1 : x
  const yFace = poly([P(c, x, fy, z), P(c, x1, fy, z), P(c, x1, fy, z1), P(c, x, fy, z1)])
  const xFace = poly([P(c, fx, y, z), P(c, fx, y1, z), P(c, fx, y1, z1), P(c, fx, y, z1)])
  const lid = poly([P(c, x, y, z1), P(c, x1, y, z1), P(c, x1, y1, z1), P(c, x, y1, z1)])
  // walls fall off towards the ground, unless they are too low for it to show; the lid catches a soft sheen and a lit rim
  const tall = h * c.p.e > 0.12
  const yCol = shade(color, yFront ? SHADE.yp : SHADE.yn), xCol = shade(color, xFront ? SHADE.xp : SHADE.xn), lidCol = top ?? shade(color, SHADE.top)
  return (
    <g key={c.k++}>
      <polygon points={yFace} fill={tall ? wall(c, yCol) : yCol} />
      <polygon points={xFace} fill={tall ? wall(c, xCol) : xCol} />
      {c.plain ? <polygon points={lid} fill={lidCol} /> : <polygon points={lid} fill={sheen(c, lidCol)} stroke={shade(color, 0.55)} strokeOpacity={0.55} strokeWidth={0.8} strokeLinejoin="round" />}
    </g>
  )
}

/** detail on the +y face of a box, in face-local coords u∈[0,w], v∈[0,h]; hidden when that face is turned away */
function leftQuad(c: Ctx, x: number, y1: number, z: number, u0: number, v0: number, u1: number, v1: number, fill: string, opacity = 1) {
  if (c.p.d <= 0 || c.plain) return null
  return (
    <polygon key={c.k++} fillOpacity={opacity === 1 ? undefined : opacity} fill={fill}
      points={poly([P(c, x + u0, y1, z + v0), P(c, x + u1, y1, z + v0), P(c, x + u1, y1, z + v1), P(c, x + u0, y1, z + v1)])} />
  )
}
/** detail on the +x face of a box */
function rightQuad(c: Ctx, x1: number, y: number, z: number, u0: number, v0: number, u1: number, v1: number, fill: string, opacity = 1) {
  if (c.p.c <= 0 || c.plain) return null
  return (
    <polygon key={c.k++} fillOpacity={opacity === 1 ? undefined : opacity} fill={fill}
      points={poly([P(c, x1, y + u0, z + v0), P(c, x1, y + u1, z + v0), P(c, x1, y + u1, z + v1), P(c, x1, y + u0, z + v1)])} />
  )
}

// straight pieces in a full circle
const SEG = 28
/** Points round a circle on the ground at height `z`, or round the arc between two angles (radians, measured on the ground from +x). */
function ring(c: Ctx, cx: number, cy: number, z: number, r: number, from = 0, to = Math.PI * 2, n = SEG): Pt[] {
  const out: Pt[] = []
  for (let i = 0; i <= n; i++) {
    const a = from + ((to - from) * i) / n
    out.push(P(c, cx + Math.cos(a) * r, cy + Math.sin(a) * r, z))
  }
  return out
}

/** Cylinder or frustum (r0 at the bottom, r1 at the top). */
function cyl(c: Ctx, cx: number, cy: number, z: number, r0: number, r1: number, h: number, color: string, top?: string): ReactNode {
  const { a, b } = c.p
  // silhouette tangent angle: where screen-x is extreme
  const th = Math.atan2(b, a)
  // near half passes through the angle that maximises screen-y
  const near = Math.atan2(c.p.d, c.p.c)
  let from = th, to = th + Math.PI
  const mid = from + Math.PI / 2
  if (Math.cos(mid - near) < 0) { from = th + Math.PI; to = th + Math.PI * 2 }
  const bottom = ring(c, cx, cy, z, r0, from, to)
  const upper = ring(c, cx, cy, z + h, r1, from, to).reverse()
  const lid = poly(ring(c, cx, cy, z + h, r1)), lidCol = top ?? shade(color, 0.16)
  if (c.plain) return (
    <g key={c.k++}>
      <polygon points={poly([...bottom, ...upper])} fill={shade(color, -0.14)} />
      <polygon points={lid} fill={lidCol} />
    </g>
  )
  // round the side, light on one flank and shadow on the other
  const gid = 'cg' + color.replace('#', '')
  if (!c.defs.has(gid)) c.defs.set(gid, (
    <linearGradient key={gid} id={gid} x1="0" x2="1" y1="0" y2="0">
      <stop offset="0" stopColor={shade(color, 0.02)} />
      <stop offset="0.45" stopColor={shade(color, -0.14)} />
      <stop offset="1" stopColor={shade(color, -0.42)} />
    </linearGradient>
  ))
  return (
    <g key={c.k++}>
      <polygon points={poly([...bottom, ...upper])} fill={`url(#${gid})`} />
      <polygon points={lid} fill={sheen(c, lidCol)} stroke={shade(color, 0.55)} strokeOpacity={0.5} strokeWidth={0.8} />
    </g>
  )
}

function band(c: Ctx, cx: number, cy: number, z: number, r: number, color: string, w = 1.4): ReactNode {
  if (c.plain) return null
  const th = Math.atan2(c.p.b, c.p.a)
  const near = Math.atan2(c.p.d, c.p.c)
  let from = th, to = th + Math.PI
  if (Math.cos(from + Math.PI / 2 - near) < 0) { from = th + Math.PI; to = th + Math.PI * 2 }
  return <polyline key={c.k++} points={poly(ring(c, cx, cy, z, r, from, to))} fill="none" stroke={color} strokeWidth={w} strokeOpacity={Math.min(1, c.p.e)} />
}

/** Glyph lying flat on a horizontal plane, centred at (cx, cy, z) spanning `size` world units. */
function decal(c: Ctx, glyph: string, cx: number, cy: number, z: number, size: number, color = '#ffffff', opacity = 0.92): ReactNode {
  if (c.plain) return null
  const [tx, ty] = P(c, cx, cy, z)
  const k = (U * size) / 24
  const { a, b, c: cc, d } = c.p
  // the glyph is drawn on a 24-unit square about its own middle: the move to that middle is folded into the one matrix
  const m = [a * k, cc * k, b * k, d * k]
  return (
    <path key={c.k++} d={GLYPHS[glyph] ?? GLYPHS.cube} transform={`matrix(${f(m[0])} ${f(m[1])} ${f(m[2])} ${f(m[3])} ${f(tx - 12 * (m[0] + m[2]))} ${f(ty - 12 * (m[1] + m[3]))})`}
      fill="none" stroke={color} strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" strokeOpacity={opacity} />
  )
}

function build(kind: ModelKind, color: string, glyph: string, p: Proj, plain: boolean): Built {
  const c: Ctx = { p, k: 0, plain, defs: new Map() }
  const out: ReactNode[] = []
  const dark = shade(color, -0.55)
  const lite = shade(color, 0.45)
  switch (kind) {
    case 'tower': {
      const h = 1.25
      out.push(box(c, 0.3, 0.3, 0, 1.4, 1.4, h, color))
      for (let i = 0; i < 3; i++) out.push(leftQuad(c, 0.3, 1.7, 0, 0.18, 0.28 + i * 0.3, 1.22, 0.4 + i * 0.3, dark, 0.55))
      out.push(rightQuad(c, 1.7, 0.3, 0, 0.16, h - 0.3, 0.3, h - 0.18, '#4ade80'))
      out.push(rightQuad(c, 1.7, 0.3, 0, 0.4, h - 0.3, 0.54, h - 0.18, lite, 0.6))
      out.push(decal(c, glyph, 1, 1, h, 0.92))
      break
    }
    case 'rack': {
      const h = 1.75
      out.push(box(c, 0.2, 0.2, 0, 1.6, 1.6, 0.1, shade(color, -0.4)))
      out.push(box(c, 0.35, 0.35, 0.1, 1.3, 1.3, h, color))
      for (let i = 0; i < 5; i++) {
        out.push(leftQuad(c, 0.35, 1.65, 0.1, 0.14, 0.2 + i * 0.3, 1.16, 0.38 + i * 0.3, dark, 0.6))
        out.push(leftQuad(c, 0.35, 1.65, 0.1, 0.98, 0.25 + i * 0.3, 1.08, 0.33 + i * 0.3, i % 2 ? '#4ade80' : lite, 0.95))
      }
      out.push(decal(c, glyph, 1, 1, h + 0.1, 0.84))
      break
    }
    case 'slab': {
      out.push(box(c, 0.12, 0.12, 0, 1.76, 1.76, 0.1, shade(color, -0.42)))
      out.push(box(c, 0.25, 0.25, 0.1, 1.5, 1.5, 0.4, color))
      out.push(leftQuad(c, 0.25, 1.75, 0.1, 0.15, 0.14, 1.35, 0.24, lite, 0.35))
      out.push(decal(c, glyph, 1, 1, 0.5, 1.0))
      break
    }
    case 'tile': {
      out.push(box(c, 0.2, 0.2, 0, 1.6, 1.6, 0.22, color))
      if (!plain) out.push(
        <polygon key={c.k++} fill="none" stroke={lite} strokeWidth={1} strokeOpacity={0.5}
          points={poly([P(c, 0.36, 0.36, 0.22), P(c, 1.64, 0.36, 0.22), P(c, 1.64, 1.64, 0.22), P(c, 0.36, 1.64, 0.22)])} />,
      )
      out.push(decal(c, glyph, 1, 1, 0.22, 0.98))
      break
    }
    case 'cylinder': {
      const h = 1.2
      out.push(cyl(c, 1, 1, 0, 0.74, 0.74, h, color))
      out.push(band(c, 1, 1, h * 0.36, 0.74, dark))
      out.push(band(c, 1, 1, h * 0.7, 0.74, dark))
      out.push(decal(c, glyph, 1, 1, h, 0.8))
      break
    }
    case 'bucket': {
      const h = 1.1
      out.push(cyl(c, 1, 1, 0, 0.56, 0.8, h, color, shade(color, 0.3)))
      out.push(<polygon key={c.k++} points={poly(ring(c, 1, 1, h, 0.66))} fill={shade(color, -0.3)} />)
      out.push(band(c, 1, 1, h * 0.72, 0.56 + 0.24 * 0.72, lite, 1.2))
      out.push(decal(c, glyph, 1, 1, h, 0.66))
      break
    }
    case 'stack': {
      for (let i = 0; i < 3; i++) {
        const inset = 0.22 + (i === 1 ? 0.06 : 0)
        out.push(box(c, inset, inset, i * 0.36, 2 - inset * 2, 2 - inset * 2, 0.26, i === 1 ? shade(color, -0.16) : color))
      }
      out.push(decal(c, glyph, 1, 1, 0.98, 0.94))
      break
    }
    case 'cluster': {
      out.push(box(c, 0.1, 0.1, 0, 1.8, 1.8, 0.16, shade(color, -0.45)))
      const cells: [number, number, number, string, boolean][] = [
        [0.26, 0.26, 0.95, color, true], [1.06, 0.26, 0.6, shade(color, 0.18), false], [0.26, 1.06, 0.6, shade(color, 0.18), false], [1.06, 1.06, 0.8, color, true],
      ]
      cells.sort((m, n) => depth(c, m[0], m[1]) - depth(c, n[0], n[1]))
      for (const [x, y, h, col, mark] of cells) {
        out.push(box(c, x, y, 0.16, 0.68, 0.68, h, col))
        if (mark) out.push(decal(c, glyph, x + 0.34, y + 0.34, 0.16 + h, 0.5))
      }
      break
    }
    case 'people': {
      const figs: [number, number, string][] = [[0.62, 0.72, shade(color, 0.2)], [1.42, 0.86, shade(color, -0.1)], [0.92, 1.42, color]]
      out.push(<polygon key={c.k++} points={poly(ring(c, 1, 1, 0, 0.95))} fill={shade(color, -0.5)} fillOpacity={0.35} />)
      figs.sort((m, n) => depth(c, m[0], m[1]) - depth(c, n[0], n[1]))
      for (const [x, y, col] of figs) {
        out.push(cyl(c, x, y, 0, 0.27, 0.12, 0.62, col))
        const [hx, hy] = P(c, x, y, 0.84)
        out.push(<circle key={c.k++} cx={f(hx)} cy={f(hy)} r={0.2 * U} fill={shade(col, 0.3)} />)
        if (!plain) out.push(<circle key={c.k++} cx={f(hx - 2.2)} cy={f(hy - 2.4)} r={0.08 * U} fill="#ffffff" fillOpacity={0.35} />)
      }
      break
    }
    case 'globe': {
      out.push(cyl(c, 1, 1, 0, 0.5, 0.36, 0.2, shade(color, -0.4)))
      const [gx, gy] = P(c, 1, 1, 1.0)
      const r = 0.78 * U
      if (plain) { out.push(<circle key={c.k++} cx={f(gx)} cy={f(gy)} r={r} fill={color} />); break }
      const gid = 'gl' + color.replace('#', '')
      if (!c.defs.has(gid)) c.defs.set(gid, (
        <radialGradient key={gid} id={gid} cx="0.34" cy="0.3" r="0.8">
          <stop offset="0" stopColor={shade(color, 0.45)} />
          <stop offset="0.55" stopColor={color} />
          <stop offset="1" stopColor={shade(color, -0.45)} />
        </radialGradient>
      ))
      out.push(
        <g key={c.k++}>
          <circle cx={f(gx)} cy={f(gy)} r={r} fill={`url(#${gid})`} />
          <g fill="none" stroke="#ffffff" strokeWidth={1.1} opacity={0.5}>
            <ellipse cx={f(gx)} cy={f(gy)} rx={r} ry={r * 0.36} />
            <ellipse cx={f(gx)} cy={f(gy)} rx={r * 0.4} ry={r} />
            <path d={`M${f(gx - r * 0.86)} ${f(gy - r * 0.5)}Q${f(gx)} ${f(gy - r * 0.2)} ${f(gx + r * 0.86)} ${f(gy - r * 0.5)}`} />
            <path d={`M${f(gx - r * 0.86)} ${f(gy + r * 0.5)}Q${f(gx)} ${f(gy + r * 0.8)} ${f(gx + r * 0.86)} ${f(gy + r * 0.5)}`} />
          </g>
        </g>,
      )
      break
    }
    case 'disc': {
      out.push(cyl(c, 1, 1, 0, 0.9, 0.9, 0.1, shade(color, -0.42)))
      out.push(cyl(c, 1, 1, 0.1, 0.76, 0.76, 0.34, color))
      if (!plain) out.push(<polygon key={c.k++} points={poly(ring(c, 1, 1, 0.44, 0.6))} fill="none" stroke={lite} strokeWidth={1} strokeOpacity={0.45} />)
      out.push(decal(c, glyph, 1, 1, 0.44, 0.86))
      break
    }
    case 'gate': {
      out.push(box(c, 0.2, 0.15, 0, 1.6, 1.7, 0.08, shade(color, -0.45)))
      for (const py of [0.25, 1.39].sort((m, n) => depth(c, 0, m) - depth(c, 0, n))) out.push(box(c, 0.55, py, 0.08, 0.9, 0.36, 0.95, shade(color, -0.08)))
      out.push(box(c, 0.45, 0.2, 1.03, 1.1, 1.6, 0.3, color))
      out.push(decal(c, glyph, 1, 1, 1.33, 0.82))
      break
    }
  }
  return { shapes: out, defs: [...c.defs.values()] }
}

/** A model as it is drawn: its shapes, and the gradients they are filled with. */
interface Built { shapes: ReactNode[]; defs: ReactNode[] }

/** The soft contact shadow a theme may put under each component. Any <svg> drawn with such a theme must include this once. */
export function SceneDefs() {
  return (
    <defs>
      <radialGradient id="st-ao">
        <stop offset="0.45" stopColor="#000" stopOpacity="0.55" />
        <stop offset="1" stopColor="#000" stopOpacity="0" />
      </radialGradient>
    </defs>
  )
}

// A model is drawn in its own local space, so every component of one kind and colour
// shares the same geometry under a given camera. Build it once per camera, not once per node.
const built = new WeakMap<Proj, Map<string, Built>>()
function geometry(kind: ModelKind, color: string, glyph: string, proj: Proj, plain = false): Built {
  let per = built.get(proj)
  if (!per) built.set(proj, (per = new Map()))
  const key = kind + '|' + color + '|' + glyph + (plain ? '|plain' : '')
  let g = per.get(key)
  if (!g) per.set(key, (g = build(kind, color, glyph, proj, plain)))
  return g
}

/**
 * One component's body, at unit size with its back corner at the origin. `plain` draws it in flat colours with no
 * small detail, for a view from very far out. Its gradients are not part of it: see `ModelDefs`.
 */
export const Model = memo(function Model({ type, color, proj, plain }: { type: string; color?: string; proj: Proj; plain?: boolean }) {
  const d = defOf(type)
  return <>{geometry(d.model, color ?? d.color, d.glyph, proj, plain).shapes}</>
})

/**
 * The gradients that the given models are filled with, each once. Whatever draws a `Model` must have this in the same
 * document for the same models (a `type` and the colour it is drawn in, the catalog's when none is given).
 */
export const ModelDefs = memo(function ModelDefs({ models, proj }: { models: readonly (readonly [type: string, color?: string])[]; proj: Proj }) {
  const seen = new Map<string, ReactNode>()
  for (const [type, color] of models) {
    const d = defOf(type)
    for (const def of geometry(d.model, color ?? d.color, d.glyph, proj).defs) seen.set((def as { key: string }).key, def)
  }
  return <defs>{[...seen.values()]}</defs>
})

/** Small standalone thumbnail of a component, used in the palette and menus. */
export const ModelIcon = memo(function ModelIcon({ type, proj, size = 56, color }: { type: string; proj: Proj; size?: number; color?: string }) {
  // local bounds of a 2×2×2 volume under this projection
  const xs: number[] = [], ys: number[] = []
  for (const [x, y, z] of [[0, 0, 0], [2, 0, 0], [0, 2, 0], [2, 2, 0], [0, 0, 1.9], [2, 0, 1.9], [0, 2, 1.9], [2, 2, 1.9]]) {
    const q = pt(proj, x, y, z)
    xs.push(q[0]); ys.push(q[1])
  }
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys)
  const models = [[type, color] as const]
  return (
    <svg width={size} height={size} viewBox={`${minX - 2} ${minY - 2} ${maxX - minX + 4} ${maxY - minY + 4}`} style={{ display: 'block' }}>
      <ModelDefs models={models} proj={proj} />
      <Model type={type} proj={proj} color={color} />
    </svg>
  )
})
