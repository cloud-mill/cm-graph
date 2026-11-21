import { memo, useMemo, useState } from 'react'
import { type Proj, type Pt, U, alpha, f, planeMatrixUV, poly, pt, upright, uprightAlong } from '../core/iso'
import { captionOf, type Flow } from '../core/links'
import { type Routed, routeAll } from '../core/router'
import { arrowAt, captionAnchor, lineOf } from '../core/routing'
import { nodeColor, nodeName } from '../core/catalog'
import { type AreaT, type Doc, type EdgeT, type LabelT, type NodeT, centerOf, footOf } from '../core/types'
import { Model, SceneDefs } from './models'

export interface SceneTheme {
  bg: string
  grid: string
  gridMajor: string
  edge: string
  text: string
  textDim: string
  /** contact-shadow strength */
  ao: number
  /** strength of the coloured light each component casts on the ground */
  glow: number
  flow: string
  /** selection, focus and live signals */
  accent: string
}

export const THEMES: Record<'dark' | 'light', SceneTheme> = {
  dark: { bg: '#060606', grid: '#1f1f22', gridMajor: '#35353a', edge: '#71717a', text: '#fafafa', textDim: '#a1a1aa', ao: 0, glow: 0, flow: '#ffffff', accent: '#fafafa' },
  light: { bg: '#ffffff', grid: '#d4d4d8', gridMajor: '#a1a1aa', edge: '#52525b', text: '#0a0a0a', textDim: '#71717a', ao: 0, glow: 0, flow: '#0a0a0a', accent: '#0a0a0a' },
}

const FONT = "'Geist Variable', 'Geist', system-ui, -apple-system, 'Segoe UI', sans-serif"
const MONO = "'Geist Mono Variable', 'Geist Mono', ui-monospace, 'SF Mono', Menlo, monospace"

export interface SceneProps {
  doc: Doc
  proj: Proj
  theme: SceneTheme
  showLabels?: boolean
  flow?: boolean
  /** per-node colour override + sublabel (lenses) */
  lens?: Map<string, { color: string; note?: string }> | null
  /** id of a component that was just added, so it can animate in */
  fresh?: string | null
  /** connection routes, when whoever draws the scene has already worked them out */
  routes?: Map<string, Routed>
  /** a flow being followed: everything off its paths steps back */
  focus?: Flow | null
  /** components picked up and in the hand */
  lifted?: Set<string> | null
  /** a connection that steps back while one of its ends is being moved somewhere else */
  dim?: string | null
}

/**
 * Routes for a diagram that keep their identity while they keep their shape, so
 * moving one component only redraws the lines that actually changed.
 */
export function useRoutes(doc: Doc): Map<string, Routed> {
  // a holder that lives as long as the component does; what it holds is only ever touched while working out routes
  const [keep] = useState(() => ({ last: new Map<string, Routed>() }))
  return useMemo(() => {
    const next = routeAll(doc.nodes, doc.edges)
    for (const [id, r] of next) {
      const was = keep.last.get(id)
      if (was && was.shape === r.shape && was.manual === r.manual && was.fromSide === r.fromSide && was.toSide === r.toSide && was.pts.length === r.pts.length && was.pts.every((p, i) => p[0] === r.pts[i][0] && p[1] === r.pts[i][1]) && was.leg.join() === r.leg.join()) next.set(id, was)
    }
    keep.last = next
    return next
  }, [doc.nodes, doc.edges, keep])
}

/** L-shaped registration marks at the corners of a ground rectangle. */
export function brackets(proj: Proj, x0: number, y0: number, x1: number, y1: number, len: number): string {
  const l = Math.min(len, (x1 - x0) / 2.5, (y1 - y0) / 2.5)
  const P = (x: number, y: number) => { const q = pt(proj, x, y); return f(q[0]) + ' ' + f(q[1]) }
  let d = ''
  for (const [cx, cy, sx, sy] of [[x0, y0, 1, 1], [x1, y0, -1, 1], [x1, y1, -1, -1], [x0, y1, 1, -1]]) {
    d += `M${P(cx + sx * l, cy)}L${P(cx, cy)}L${P(cx, cy + sy * l)}`
  }
  return d
}

const AreaView = memo(function AreaView({ a, proj }: { a: AreaT; proj: Proj; theme: SceneTheme }) {
  const pts = poly([pt(proj, a.x, a.y), pt(proj, a.x + a.w, a.y), pt(proj, a.x + a.w, a.y + a.d), pt(proj, a.x, a.y + a.d)])
  const outer = a.kind === 'vpc' || a.kind === 'zone'
  // the label hugs whichever corner currently reads as "top-left"
  const { u, v } = upright(proj)
  const hu = (Math.abs(u[0]) * a.w + Math.abs(u[1]) * a.d) / 2, hv = (Math.abs(v[0]) * a.w + Math.abs(v[1]) * a.d) / 2
  const lx = a.x + a.w / 2 - u[0] * (hu - 0.34) - v[0] * (hv - 0.26), ly = a.y + a.d / 2 - u[1] * (hu - 0.34) - v[1] * (hv - 0.26)
  return (
    <g>
      <polygon points={pts} fill={alpha(a.color, outer ? 0.045 : 0.07)} stroke={alpha(a.color, outer ? 0.55 : 0.6)} strokeWidth={1}
        strokeDasharray={outer ? undefined : '2 4'} strokeLinejoin="round" strokeLinecap="round" pointerEvents="none" />
      <path d={brackets(proj, a.x, a.y, a.x + a.w, a.y + a.d, outer ? 0.7 : 0.4)} fill="none" stroke={a.color} strokeWidth={outer ? 2 : 1.5} strokeLinecap="round" strokeLinejoin="round" pointerEvents="none" />
      <polygon points={pts} fill="none" stroke="transparent" strokeWidth={14} pointerEvents="stroke" data-kind="area" data-id={a.id} style={{ cursor: 'move' }} />
      <text transform={planeMatrixUV(proj, lx, ly, 0, 1 / U, u, v)} fontFamily={MONO} fontSize={9.5} fontWeight={600}
        letterSpacing={1.3} fill={a.color} dominantBaseline="hanging" pointerEvents="bounding-box" data-kind="area" data-id={a.id} style={{ cursor: 'move' }}>
        {a.name.toUpperCase()}
      </text>
    </g>
  )
})

const EdgeView = memo(function EdgeView({ e, r, proj, theme, flow, state }: { e: EdgeT; r: Routed; proj: Proj; theme: SceneTheme; flow?: boolean; state?: 'on' | 'off' }) {
  const pts = r.pts
  const n = pts.length
  if (n < 2) return null
  const color = e.color || theme.edge
  const hasEnd = e.arrow !== 'none'
  const hasStart = e.arrow === 'both'
  const d = lineOf(proj, r, hasStart ? 0.26 : 0, hasEnd ? 0.26 : 0)
  const full = lineOf(proj, r)
  const dash = e.style === 'dashed' ? '5 5' : e.style === 'dotted' ? '0.5 5' : undefined
  const caption = captionOf(e)
  const la = caption ? captionAnchor(r) : null
  const lb = la ? uprightAlong(proj, la.dir) : null
  const arrow = (tip: [number, number], from: [number, number]) =>
    <polygon points={poly(arrowAt(tip, from, 0.34).map((q) => pt(proj, q[0], q[1]) as Pt))} fill={color} stroke={color} strokeWidth={1} strokeLinejoin="round" pointerEvents="none" />
  // a line on a path being followed always shows its direction; a dependency never moves, because nothing travels along it
  // and while a flow is being followed, only its own lines move
  const moving = (state ? state === 'on' : !!flow) && e.kind !== 'dependency' && e.arrow !== 'none'
  return (
    <g className={'edge' + (state ? ' ' + state : '')}>
      {/* a dark channel under the line keeps it legible where it crosses areas and other lines */}
      <path d={full} fill="none" stroke={theme.bg} strokeOpacity={0.85} strokeWidth={e.width + 5} strokeLinecap="round" strokeLinejoin="round" pointerEvents="none" />
      <path d={d} className="edge-line" fill="none" stroke={color} strokeWidth={e.width * 0.75} strokeDasharray={dash} strokeLinecap="round" strokeLinejoin="round" pointerEvents="none" />
      {moving && <path d={full} className={'edge-flow' + (hasStart ? ' both' : '')} fill="none" stroke={e.color || theme.flow} strokeWidth={e.width + 0.4} strokeLinecap="round" pointerEvents="none" />}
      {hasEnd && arrow(pts[n - 1], pts[n - 2])}
      {hasStart && arrow(pts[0], pts[1])}
      <path d={full} className="edge-hit" fill="none" stroke="transparent" strokeWidth={16} strokeLinejoin="round" data-kind="edge" data-id={e.id} style={{ cursor: 'pointer' }} />
      {la && lb && (
        <text transform={planeMatrixUV(proj, la.at[0], la.at[1], 0, 1 / U, lb.u, lb.v)} fontFamily={MONO} fontSize={8.5} fontWeight={500} letterSpacing={0.5} fill={theme.textDim}
          textAnchor="middle" y={-7} stroke={theme.bg} strokeWidth={4} paintOrder="stroke" strokeLinejoin="round" pointerEvents="none">
          {caption.toUpperCase()}
        </text>
      )}
    </g>
  )
})

const NodeView = memo(function NodeView({ n, proj, theme, showLabels, color, note, fresh, order, off, up }: {
  n: NodeT; proj: Proj; theme: SceneTheme; showLabels?: boolean; color?: string; note?: string; fresh?: boolean; order: number; off?: boolean; up?: boolean
}) {
  const [tx, ty] = pt(proj, n.x, n.y)
  const k = n.scale ?? 1 // the body is drawn at unit size and scaled; the name stays the same size
  const [cx, cy] = pt(proj, k, k)
  const R = U * 1.5 * k
  const { u: lu, v: lv } = upright(proj) // name sits along the edge nearest the camera
  const tint = color ?? nodeColor(n)
  const gid = 'nl' + tint.replace('#', '')
  const count = n.props.count > 1 ? n.props.count : n.props.tasks > 1 && n.type === 'ecs' ? n.props.tasks : 0
  return (
    <g transform={`translate(${f(tx)} ${f(ty)})`} data-kind="node" data-id={n.id} className={'nd' + (fresh ? ' nd-new' : '') + (off ? ' off' : '') + (up ? ' up' : '')} style={{ cursor: 'grab', ['--i' as any]: order }}>
      {/* each component throws a faint pool of its own colour on the ground, then a soft contact shadow */}
      {theme.glow > 0 && (
        <>
          <defs>
            <radialGradient id={gid}>
              <stop offset="0.2" stopColor={tint} stopOpacity={theme.glow} />
              <stop offset="1" stopColor={tint} stopOpacity="0" />
            </radialGradient>
          </defs>
          <circle className="nd-glow" r={1.55} fill={`url(#${gid})`} transform={`matrix(${f(proj.a * R)} ${f(proj.c * R)} ${f(proj.b * R)} ${f(proj.d * R)} ${f(cx)} ${f(cy)})`} />
        </>
      )}
      {theme.ao > 0 && <circle className="nd-ao" r={1} fill="url(#st-ao)" opacity={theme.ao}
        transform={`matrix(${f(proj.a * R)} ${f(proj.c * R)} ${f(proj.b * R)} ${f(proj.d * R)} ${f(cx)} ${f(cy)})`} />}
      <g className="nd-body">{k === 1 ? <Model type={n.type} color={tint} proj={proj} /> : <g transform={`scale(${k})`}><Model type={n.type} color={tint} proj={proj} /></g>}</g>
      {showLabels && (
        <text className="nd-label" transform={planeMatrixUV(proj, k + lv[0] * (k + 0.22), k + lv[1] * (k + 0.22), 0, 1 / U, lu, lv)} fontFamily={FONT} fontSize={10.5} textAnchor="middle" dominantBaseline="hanging"
          stroke={theme.bg} strokeWidth={3.5} paintOrder="stroke" strokeLinejoin="round">
          <tspan fill={theme.text} fontWeight={600} letterSpacing={0.1}>{nodeName(n)}</tspan>
          {count > 1 && <tspan fill={theme.textDim} fontFamily={MONO} fontSize={8.5} fontWeight={500}>{'  ×' + count}</tspan>}
          {note && <tspan x={0} dy={13} fill={color ?? theme.textDim} fontFamily={MONO} fontWeight={600} fontSize={8.5}>{note}</tspan>}
        </text>
      )}
    </g>
  )
})

const LabelView = memo(function LabelView({ l, proj, theme }: { l: LabelT; proj: Proj; theme: SceneTheme }) {
  const lines = l.text.split('\n')
  // Labels keep their patch of ground but turn to face the camera: when the
  // view comes round the back, the text is spun 180° within the same footprint.
  const { u, v } = uprightAlong(proj, l.dir)
  const flipped = l.dir === 'x' ? u[0] < 0 : u[1] > 0
  const height = lines.length * l.size * 1.2
  return (
    <text transform={planeMatrixUV(proj, l.x, l.y, 0, 1 / U, u, v)} fontFamily={FONT} fontSize={l.size} fontWeight={600} fill={l.color || theme.text}
      dominantBaseline="hanging" textAnchor={flipped ? 'end' : 'start'} y={flipped ? -height + l.size * 0.2 : 0}
      data-kind="label" data-id={l.id} style={{ cursor: 'move' }} letterSpacing={-0.02 * l.size} pointerEvents="bounding-box">
      {lines.map((t, i) => (
        <tspan key={i} x={0} dy={i === 0 ? 0 : l.size * 1.2}>{t || ' '}</tspan>
      ))}
    </text>
  )
})

const KIND_ORDER = { vpc: 0, zone: 1, group: 2, subnet: 3 }

/** The diagram itself: pure, so it is reused for the editor, thumbnails and exports. */
export const Scene = memo(function Scene({ doc, proj, theme, showLabels = true, flow, lens, fresh, routes, focus, lifted, dim }: SceneProps) {
  const own = useRoutes(doc)
  const paths = routes ?? own
  // painter's order: far to near along the camera's ground direction
  // (depth is compared to a thousandth of a cell: components level with each other must not swap places over rounding noise while they are carried)
  const sorted = useMemo(() => { const depth = (n: NodeT) => { const p = centerOf(n); return Math.round((p[0] * proj.c + p[1] * proj.d) * 1000) }; return [...doc.nodes].sort((a, b) => depth(a) - depth(b) || a.x - b.x || (a.id < b.id ? -1 : 1)) }, [doc.nodes, proj])
  const areas = useMemo(() => [...doc.areas].sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || b.w * b.d - a.w * a.d), [doc.areas])
  return (
    <g>
      <SceneDefs />
      {areas.map((a) => <AreaView key={a.id} a={a} proj={proj} theme={theme} />)}
      {doc.edges.map((e) => {
        const r = paths.get(e.id)
        return r ? <EdgeView key={e.id} e={e} r={r} proj={proj} theme={theme} flow={flow} state={dim === e.id ? 'off' : focus ? (focus.edges.has(e.id) ? 'on' : 'off') : undefined} /> : null
      })}
      {doc.labels.map((l) => <LabelView key={l.id} l={l} proj={proj} theme={theme} />)}
      {sorted.map((n, i) => {
        const o = lens?.get(n.id)
        return <NodeView key={n.id} n={n} proj={proj} theme={theme} showLabels={showLabels} color={o?.color} note={o?.note} fresh={fresh === n.id} order={i} off={!!focus && !focus.start.has(n.id) && !focus.up.has(n.id) && !focus.down.has(n.id)} up={!!lifted?.has(n.id)} />
      })}
    </g>
  )
})

/** Bounding box of the projected diagram in scene px. */
export function sceneBounds(doc: Doc, proj: Proj, pad = 60) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  const add = (x: number, y: number, z = 0) => {
    const q = pt(proj, x, y, z)
    minX = Math.min(minX, q[0]); maxX = Math.max(maxX, q[0]); minY = Math.min(minY, q[1]); maxY = Math.max(maxY, q[1])
  }
  for (const n of doc.nodes) {
    const s = footOf(n), h = s / 2
    for (const [dx, dy] of [[0, 0], [s, 0], [0, s], [s, s]]) { add(n.x + dx, n.y + dy); add(n.x + dx, n.y + dy, s) }
    for (const [dx, dy] of [[h, s + 0.9], [h, -0.9], [s + 0.9, h], [-0.9, h]]) add(n.x + dx, n.y + dy)
  }
  for (const a of doc.areas) for (const [dx, dy] of [[0, 0], [a.w, 0], [0, a.d], [a.w, a.d]]) add(a.x + dx, a.y + dy)
  for (const l of doc.labels) { add(l.x, l.y); add(l.x + (l.dir === 'x' ? 4 : 0), l.y + (l.dir === 'x' ? 0.6 : -4)) }
  if (!isFinite(minX)) { minX = -200; maxX = 200; minY = -120; maxY = 120 }
  return { x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 }
}
