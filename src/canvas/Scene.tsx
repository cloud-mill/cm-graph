import { memo, useMemo, useState } from 'react'
import { type Proj, type Pt, U, alpha, f, planeMatrixUV, poly, pt, upright, uprightAlong } from '../core/iso'
import { captionOf, type Flow } from '../core/links'
import { type Routed, routeAll } from '../core/router'
import { captionAnchor, drawingOf } from '../core/linePath'
import { nodeColor, nodeName } from '../core/catalog'
import { type AreaT, type Doc, type EdgeT, type LabelT, type NodeT, centerOf, footOf } from '../core/types'
import { Model, ModelDefs, SceneDefs } from './models'

// The diagram as SVG: areas, then connections, then the traffic on them, then captions and labels, then components from
// far to near. It draws a `Doc` through a `Proj` and nothing else: no store, no pointer handling, no pan or zoom (whoever
// uses it wraps it in a transform). Coordinates out are scene px: ground cells through `pt`, at zoom 1.
//
// It comes in three layers, bottom to top: <SceneGround/> (areas and connections), <SceneFlow/> (the moving traffic) and
// <SceneTop/> (captions, labels and components). <Scene/> is all three in one group, which is what a thumbnail or an
// export wants. The editor draws each in an <svg> of its own, because the browser redraws an <svg> as a whole: kept
// apart, traffic that moves sixty times a second redraws only itself, and a component that moves leaves the lines alone.
//
// What can be pressed carries `data-kind` (node, edge, area, label) and `data-id`; the canvas reads those to tell what a
// press landed on. Each kind of thing is a memoised view, so a drag that renders the scene every frame leaves alone
// whatever is handed the same props as before.
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
  /** only what touches this part of the scene is drawn, for a diagram too large to be worth drawing whole. Scene px */
  within?: Box | null
  /** drawn from too far out for detail to show: components in flat colours, no names or captions, lines without their channel */
  plain?: boolean
  /** components are told their place from far to near, which is what staggers them as a blueprint opens */
  stagger?: boolean
}

/** A rectangle in scene px. */
export interface Box { x0: number; y0: number; x1: number; y1: number }
const touches = (a: Box, b: Box) => a.x0 <= b.x1 && a.x1 >= b.x0 && a.y0 <= b.y1 && a.y1 >= b.y0

// Roughly where each thing is drawn, generously: it only decides what is worth drawing at all when the diagram is far larger
// than the screen, and what is asked for reaches well past the screen's edge. Kept against the object it was worked out
// from, which is never changed in place, so asking again on the next frame costs a look-up
const seen = new WeakMap<object, { proj: Proj; box: Box }>()
function boxOf(key: object, proj: Proj, make: () => Box): Box {
  const hit = seen.get(key)
  if (hit && hit.proj === proj) return hit.box
  const box = make()
  seen.set(key, { proj, box })
  return box
}
const around = (pts: Pt[], pad: number): Box => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const q of pts) { x0 = Math.min(x0, q[0]); x1 = Math.max(x1, q[0]); y0 = Math.min(y0, q[1]); y1 = Math.max(y1, q[1]) }
  return { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad }
}
/** Where a component is drawn, with room for its height and for its name: scene px. */
export const nodeBox = (n: NodeT, proj: Proj): Box => boxOf(n, proj, () => { const s = footOf(n); return around([pt(proj, n.x + s / 2, n.y + s / 2)], s * U * 2.2 + 90) })
/** Where a connection is drawn, with room for its caption: scene px. */
export const routeBox = (r: Routed, proj: Proj): Box => boxOf(r, proj, () => around(r.pts.map((p) => pt(proj, p[0], p[1])), 70))
const areaBox = (a: AreaT, proj: Proj): Box => boxOf(a, proj, () => around([pt(proj, a.x, a.y), pt(proj, a.x + a.w, a.y), pt(proj, a.x + a.w, a.y + a.d), pt(proj, a.x, a.y + a.d)], 40))
const labelBox = (l: LabelT, proj: Proj): Box => boxOf(l, proj, () => {
  // as long as its longest line and as deep as its lines, along whichever ground axis it runs
  const lines = l.text.split('\n'), len = (Math.max(...lines.map((t) => t.length)) * l.size * 0.7) / U, rows = (lines.length * l.size * 1.2) / U
  const c: Pt[] = l.dir === 'x' ? [pt(proj, l.x, l.y), pt(proj, l.x + len, l.y + rows), pt(proj, l.x - len, l.y - rows)] : [pt(proj, l.x, l.y), pt(proj, l.x + rows, l.y - len), pt(proj, l.x - rows, l.y + len)]
  return around(c, l.size * 2 + 20)
})

/**
 * Routes for a diagram that keep their identity while they keep their shape, so
 * moving one component only redraws the lines that actually changed.
 */
export function useRoutes(doc: Doc): Map<string, Routed> {
  // a holder that lives as long as the component does; what it holds is only ever touched while working out routes.
  // A route that comes out the same as last time is handed back as the very same object, which is what lets a memoised line skip its redraw
  const [keep] = useState(() => ({ last: new Map<string, Routed>() }))
  return useMemo(() => {
    const next = routeAll(doc.nodes, doc.edges)
    for (const [id, r] of next) {
      const was = keep.last.get(id)
      if (was && was !== r && was.shape === r.shape && was.manual === r.manual && was.fromSide === r.fromSide && was.toSide === r.toSide && was.pts.length === r.pts.length && was.pts.every((p, i) => p[0] === r.pts[i][0] && p[1] === r.pts[i][1]) && was.leg.join() === r.leg.join()) next.set(id, was)
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

type EdgeState = 'on' | 'off' | undefined
/**
 * A connection's caption, lying on the ground and reading upright from wherever the camera is. On a curve it is centred
 * on the line, with a halo of the background colour that parts the line around it. The canvas draws it a second time
 * over a selected curve's highlight, which would otherwise run straight through the words.
 */
export const EdgeCaption = memo(function EdgeCaption({ e, r, proj, theme, state }: { e: EdgeT; r: Routed; proj: Proj; theme: SceneTheme; state?: EdgeState }) {
  const caption = captionOf(e)
  if (!caption || r.pts.length < 2) return null
  const la = captionAnchor(r), lb = uprightAlong(proj, la.dir)
  return (
    <text className={'edge-caption' + (state ? ' ' + state : '')} data-edge={e.id} transform={planeMatrixUV(proj, la.at[0], la.at[1], 0, 1 / U, lb.u, lb.v)} fontFamily={MONO} fontSize={8.5} fontWeight={500} letterSpacing={0.5} fill={theme.textDim}
      textAnchor="middle" y={la.on ? 3 : -7} stroke={theme.bg} strokeWidth={la.on ? 6 : 4} paintOrder="stroke" strokeLinejoin="round" pointerEvents="none">
      {caption.toUpperCase()}
    </text>
  )
})

/** A line on a path being followed always shows its direction; a dependency never moves, because nothing travels along it; and while a flow is being followed, only its own lines move. */
const moves = (e: EdgeT, flow: boolean | undefined, state: EdgeState) => (state ? state === 'on' : !!flow) && e.kind !== 'dependency' && e.arrow !== 'none'

const EdgeView = memo(function EdgeView({ e, r, proj, theme, state, plain }: { e: EdgeT; r: Routed; proj: Proj; theme: SceneTheme; state?: EdgeState; plain?: boolean }) {
  const pts = r.pts
  const n = pts.length
  if (n < 2) return null
  const color = e.color || theme.edge
  // every layer below is drawn from this one geometry, so none of them can stray from the others
  const { full, line: d, heads } = drawingOf(proj, r, e.arrow)
  const dash = e.style === 'dashed' ? '5 5' : e.style === 'dotted' ? '0.5 5' : undefined
  return (
    <g className={'edge' + (state ? ' ' + state : '')}>
      {/* a dark channel under the line keeps it legible where it crosses areas and other lines */}
      {!plain && <path d={full} fill="none" stroke={theme.bg} strokeOpacity={0.85} strokeWidth={e.width + 5} strokeLinecap="round" strokeLinejoin="round" pointerEvents="none" />}
      <path d={d} className="edge-line" fill="none" stroke={color} strokeWidth={e.width * 0.75} strokeDasharray={dash} strokeLinecap="round" strokeLinejoin="round" pointerEvents="none" />
      {heads.map((h, i) => <polygon key={i} points={poly(h.map((q) => pt(proj, q[0], q[1]) as Pt))} fill={color} stroke={color} strokeWidth={1} strokeLinejoin="round" pointerEvents="none" />)}
      <path d={full} className="edge-hit" fill="none" stroke="transparent" strokeWidth={16} strokeLinejoin="round" data-kind="edge" data-id={e.id} style={{ cursor: 'pointer' }} />
    </g>
  )
})

/** The traffic on one connection: dots that travel its whole path, end to end. */
const FlowView = memo(function FlowView({ e, r, proj, theme }: { e: EdgeT; r: Routed; proj: Proj; theme: SceneTheme }) {
  if (r.pts.length < 2) return null
  return <path d={drawingOf(proj, r, e.arrow).full} className={'edge-flow' + (e.arrow === 'both' ? ' both' : '')} data-edge={e.id} fill="none" stroke={e.color || theme.flow} strokeWidth={e.width + 0.4} strokeLinecap="round" pointerEvents="none" />
})

const NodeView = memo(function NodeView({ n, proj, theme, showLabels, color, note, fresh, order, off, up, plain }: {
  n: NodeT; proj: Proj; theme: SceneTheme; showLabels?: boolean; color?: string; note?: string; fresh?: boolean; order?: number; off?: boolean; up?: boolean; plain?: boolean
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
    <g transform={`translate(${f(tx)} ${f(ty)})`} data-kind="node" data-id={n.id} className={'nd' + (fresh ? ' nd-new' : '') + (off ? ' off' : '') + (up ? ' up' : '')} style={order === undefined ? GRAB : { cursor: 'grab', ['--i' as any]: order }}>
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
      <g className="nd-body">{k === 1 ? <Model type={n.type} color={tint} proj={proj} plain={plain} /> : <g transform={`scale(${k})`}><Model type={n.type} color={tint} proj={proj} plain={plain} /></g>}</g>
      {showLabels && !plain && (
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
const GRAB = { cursor: 'grab' }

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

// areas are drawn outermost kind first, and within a kind the larger first, so one that sits inside another is on top of it
const KIND_ORDER = { vpc: 0, zone: 1, group: 2, subnet: 3 }
const stateOf = (id: string, focus: Flow | null | undefined, dim: string | null | undefined): EdgeState => (dim === id ? 'off' : focus ? (focus.edges.has(id) ? 'on' : 'off') : undefined)

/** What every layer is drawn from. `routes` is where each connection runs, worked out once by whoever draws the layers. */
interface LayerProps extends SceneProps { routes: Map<string, Routed> }

/** The bottom layer: areas, then connections (the line, its arrowheads and the area that takes a press). */
export const SceneGround = memo(function SceneGround({ doc, proj, theme, routes, focus, dim, within, plain }: LayerProps) {
  const areas = useMemo(() => [...doc.areas].sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || b.w * b.d - a.w * a.d), [doc.areas])
  return (
    <g>
      {areas.map((a) => (within && !touches(areaBox(a, proj), within) ? null : <AreaView key={a.id} a={a} proj={proj} theme={theme} />))}
      {doc.edges.map((e) => {
        const r = routes.get(e.id)
        return r && !(within && !touches(routeBox(r, proj), within)) ? <EdgeView key={e.id} e={e} r={r} proj={proj} theme={theme} state={stateOf(e.id, focus, dim)} plain={plain} /> : null
      })}
    </g>
  )
})

/** The middle layer: the traffic moving along connections. Nothing at all unless traffic is on or a flow is being followed. */
export const SceneFlow = memo(function SceneFlow({ doc, proj, theme, routes, flow, focus, dim, within }: LayerProps) {
  if (!flow && !focus) return null
  return (
    <g>
      {doc.edges.map((e) => {
        const r = routes.get(e.id)
        return r && moves(e, flow, stateOf(e.id, focus, dim)) && !(within && !touches(routeBox(r, proj), within)) ? <FlowView key={e.id} e={e} r={r} proj={proj} theme={theme} /> : null
      })}
    </g>
  )
})

/** How deep a band of components is, in cells along the way the camera looks. */
const BAND = 2
/** Components that stand at about the same distance from the camera, far to near within the band. `first` is the place of its first among all that are drawn. */
export interface Band { key: number; nodes: NodeT[]; first: number }
/**
 * The components to draw, in painter's order (far to near along the camera's ground direction), cut into bands of depth.
 *
 * Bands are what keeps one component's move from being everyone's business. Each is drawn by a memoised <NodeBand/>,
 * and a band that holds the same components as last time is handed back as the very same list, so React looks at the
 * band a component is in and no other. The editor goes further and gives each band an <svg> of its own, which the browser
 * repaints separately. Bands are fixed slices of depth, not so many components each, so that a component carried across
 * the canvas changes band now and then, and nothing else ever does.
 */
export function useBands(all: NodeT[], proj: Proj, within?: Box | null): Band[] {
  const [keep] = useState(() => ({ last: new Map<number, NodeT[]>() }))
  return useMemo(() => {
    // depth is compared to a thousandth of a cell: components level with each other must not swap places over rounding noise while they are carried
    const placed: { n: NodeT; d: number }[] = []
    for (const n of all) { if (within && !touches(nodeBox(n, proj), within)) continue; const p = centerOf(n); placed.push({ n, d: Math.round((p[0] * proj.c + p[1] * proj.d) * 1000) }) }
    placed.sort((a, b) => a.d - b.d || a.n.x - b.n.x || (a.n.id < b.n.id ? -1 : 1))
    const out: Band[] = [], next = new Map<number, NodeT[]>()
    for (let i = 0; i < placed.length;) {
      const key = Math.floor(placed[i].d / (BAND * 1000))
      // (always at least the one it starts on: a depth that is not a number is equal to nothing, itself included)
      let j = i + 1
      while (j < placed.length && Math.floor(placed[j].d / (BAND * 1000)) === key) j++
      let nodes = placed.slice(i, j).map((q) => q.n)
      const was = keep.last.get(key)
      if (was && was.length === nodes.length && was.every((n, k) => n === nodes[k])) nodes = was
      next.set(key, nodes)
      out.push({ key, nodes, first: i })
      i = j
    }
    keep.last = next
    return out
  }, [all, proj, within, keep])
}

interface BandProps extends Pick<SceneProps, 'proj' | 'theme' | 'showLabels' | 'lens' | 'fresh' | 'focus' | 'lifted' | 'plain'> { nodes: NodeT[]; first?: number }
/** One band of components. `first`, when given, staggers them as a blueprint opens. */
export const NodeBand = memo(function NodeBand({ nodes, first, proj, theme, showLabels = true, lens, fresh, focus, lifted, plain }: BandProps) {
  return (
    <>
      {nodes.map((n, i) => {
        const o = lens?.get(n.id)
        return <NodeView key={n.id} n={n} proj={proj} theme={theme} showLabels={showLabels} color={o?.color} note={o?.note} fresh={fresh === n.id} order={first === undefined ? undefined : first + i} off={!!focus && !focus.start.has(n.id) && !focus.up.has(n.id) && !focus.down.has(n.id)} up={!!lifted?.has(n.id)} plain={plain} />
      })}
    </>
  )
})

/** What lies over the lines and under the components: captions on connections and labels, with the gradients the components are filled with. */
export const SceneText = memo(function SceneText({ doc, proj, theme, lens, routes, focus, dim, within, plain, bands }: LayerProps & { bands: Band[] }) {
  // each kind of component in each colour it is drawn in, once. The list is the same object for as long as it holds the same
  // things, so the gradients are not gone over again on every frame of a drag
  const uses = new Map<string, readonly [string, string]>()
  if (!plain) for (const b of bands) for (const n of b.nodes) { const tint = lens?.get(n.id)?.color ?? nodeColor(n), k = n.type + '|' + tint; if (!uses.has(k)) uses.set(k, [n.type, tint]) }
  const key = [...uses.keys()].sort().join()
  const models = useMemo(() => [...uses.values()], [key])
  return (
    <g>
      <SceneDefs />
      {!plain && <ModelDefs models={models} proj={proj} />}
      {!plain && doc.edges.map((e) => {
        const r = routes.get(e.id)
        return r && (e.label || e.protocol || e.port) && !(within && !touches(routeBox(r, proj), within)) ? <EdgeCaption key={e.id} e={e} r={r} proj={proj} theme={theme} state={stateOf(e.id, focus, dim)} /> : null
      })}
      {doc.labels.map((l) => (within && !touches(labelBox(l, proj), within) ? null : <LabelView key={l.id} l={l} proj={proj} theme={theme} />))}
    </g>
  )
})

/** The top layer in one group: captions and labels, then every band of components from far to near. */
export const SceneTop = memo(function SceneTop(props: LayerProps) {
  const { doc, proj, within, stagger } = props
  const bands = useBands(doc.nodes, proj, within)
  return (
    <g>
      <SceneText {...props} bands={bands} />
      {bands.map((b) => <NodeBand key={b.key} nodes={b.nodes} first={stagger ? b.first : undefined} proj={proj} theme={props.theme} showLabels={props.showLabels} lens={props.lens} fresh={props.fresh} focus={props.focus} lifted={props.lifted} plain={props.plain} />)}
    </g>
  )
})

/** The diagram itself, every layer in one group: pure, so it is reused for thumbnails and exports. */
export const Scene = memo(function Scene(props: SceneProps) {
  const own = useRoutes(props.doc)
  const routes = props.routes ?? own
  return (
    <g>
      <SceneGround {...props} routes={routes} />
      <SceneFlow {...props} routes={routes} />
      <SceneTop {...props} routes={routes} />
    </g>
  )
})

/**
 * Bounding box of the projected diagram in scene px (before pan and zoom), with `pad` px added all round.
 * It allows for each component's height and for 0.9 of a cell past each of its sides; an empty diagram gets a small box about the origin.
 */
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
