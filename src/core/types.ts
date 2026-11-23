/**
 * The document model: a blueprint (`Doc`) and what it holds. Plain JSON-serialisable data with no behaviour,
 * since the same objects are kept in the store, in undo history, in browser storage and in share links.
 *
 * Every position and size is in cells on the ground plane (x to the east, y to the south). Turning them into
 * screen pixels is `core/iso`'s job and nothing here knows about the camera.
 */
export type ID = string

/** A component. */
export interface NodeT {
  id: ID
  /** catalog key; storage does not check it against the catalog, so it may be a type this build does not know */
  type: string
  /** the corner of the footprint with the least x and y, in cells. Not the centre: see `centerOf` */
  x: number
  y: number
  name?: string
  props: Record<string, any>
  color?: string
  notes?: string
  link?: string
  /** size multiplier; 1 (the default) is a 2×2 footprint */
  scale?: number
}

export const MIN_SCALE = 0.5, MAX_SCALE = 3
/** side of a component's square footprint, in grid cells */
export const footOf = (n: Pick<NodeT, 'scale'>) => 2 * (n.scale ?? 1)
/** centre of a component's footprint, in cells */
export const centerOf = (n: Pick<NodeT, 'x' | 'y' | 'scale'>): [number, number] => [n.x + footOf(n) / 2, n.y + footOf(n) / 2]

/** A side of a component's footprint: north is -y, east is +x. */
export type Side = 'n' | 'e' | 's' | 'w'

/** What a connection means. It decides how the line is drawn by default and how it is described. */
export type LinkKind = 'request' | 'data' | 'event' | 'replication' | 'dependency'

/** How a connection came to be in the diagram. None of these is observed traffic. */
export type LinkOrigin = 'drawn' | 'imported' | 'inferred'

/**
 * A connection. Its path is described in one of three ways, and for `routeAll` in `core/router` the earlier wins:
 * a drawing style that needs no path (`shape`), a track of its own (`runs`, with `fromAt`/`toAt` and both sides),
 * or a path the router planned and stored (`plan`). `via` is a fourth, kept only so older files still draw.
 */
export interface EdgeT {
  id: ID
  from: ID
  to: ID
  label?: string
  color?: string
  style: 'solid' | 'dashed' | 'dotted'
  arrow: 'none' | 'end' | 'both'
  width: number
  /** the relationship this line stands for; absent on older files, which read as a plain connection */
  kind?: LinkKind
  /** e.g. HTTPS, gRPC, PostgreSQL */
  protocol?: string
  /** e.g. 443, or 5432 */
  port?: string
  origin?: LinkOrigin
  /** how the line travels between its ends: absent means right-angled runs, `direct` is one straight line, `curved` a single sweep */
  shape?: 'direct' | 'curved'
  /**
   * The line's own track, once the user has shaped it: where each run between the first and the last lies.
   * The first run leaves `fromSide` and the last arrives at `toSide`; the ones between alternate across and
   * along, and each entry is the fixed coordinate of one (x for a run along y, y for a run along x).
   * An empty track between two facing sides means "one straight run": it is kept straight as things move.
   */
  runs?: number[]
  /** where along its side each end sits, in cells from the middle of it; set once the user has placed it */
  fromAt?: number
  toAt?: number
  /**
   * The path the router planned for this line, kept so that it is planned once and then left alone: nothing else
   * that happens in the diagram re-plans it. `key` records what it was planned for (the two components, where they
   * stood and how big they were, and any side or place on a side the user pinned: see `planKey`); when that no longer
   * matches, the plan is stale and the line is planned afresh. Only lines the router owns have one: a line with a
   * track of its own never does. `pts` are ground points in cells, from the port on `fromSide` to the port on `toSide`.
   */
  plan?: { pts: [number, number][]; fromSide: Side; toSide: Side; key: string }
  /** points an older file asked the line to pass through. Still drawn; shaping the line turns them into a track */
  via?: [number, number][]
  /** sides the user pinned the ends to; otherwise each end uses the side facing where the line goes */
  fromSide?: Side
  toSide?: Side
}

export type AreaKind = 'vpc' | 'subnet' | 'zone' | 'group'

/**
 * An area: a rectangle on the ground, in cells, `w` along x and `d` (depth) along y. It does not list its members:
 * a component belongs to an area while its centre lies inside it (`inArea` in `core/layout`).
 */
export interface AreaT {
  id: ID
  x: number
  y: number
  w: number
  d: number
  name: string
  color: string
  kind: AreaKind
}

/** A piece of text lying on the ground. */
export interface LabelT {
  id: ID
  x: number
  y: number
  text: string
  /** font size in fortieths of a cell (`U` to the cell), which is screen pixels at zoom 1 in the home view */
  size: number
  color?: string
  /** the ground axis the text runs along */
  dir: 'x' | 'y'
}

export interface Doc {
  id: ID
  name: string
  region: string
  nodes: NodeT[]
  edges: EdgeT[]
  areas: AreaT[]
  labels: LabelT[]
  createdAt: number
  updatedAt: number
}

export type PricingModel = 'ondemand' | 'commit1' | 'commit3'

/** How far a cost line can be trusted: see `core/pricing`. */
export type CostBasis = 'fixed' | 'usage' | 'estimate'

export interface CostLine {
  label: string
  monthly: number
  /** eligible for commitment discounts (savings plans / reserved) */
  commit?: boolean
  /** absent on a line that has not been classified, which reads as an estimate */
  basis?: CostBasis
  /** what the figure assumes or stands in for */
  note?: string
  /** metered usage that counts towards an account-wide free allowance: key, quantity and the rate it was priced at */
  meter?: { key: string; qty: number; rate: number }
}

/** A short id, unique enough within one blueprint and one browser. Not a secret and not cryptographically random. */
export const uid = () =>
  Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4)

export const emptyDoc = (name = 'Untitled blueprint'): Doc => ({
  id: uid(),
  name,
  region: 'us-east-1',
  nodes: [],
  edges: [],
  areas: [],
  labels: [],
  createdAt: Date.now(),
  updatedAt: Date.now(),
})
