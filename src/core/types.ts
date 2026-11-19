export type ID = string

export interface NodeT {
  id: ID
  type: string
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
/** centre of a component's footprint */
export const centerOf = (n: Pick<NodeT, 'x' | 'y' | 'scale'>): [number, number] => [n.x + footOf(n) / 2, n.y + footOf(n) / 2]

export interface EdgeT {
  id: ID
  from: ID
  to: ID
  label?: string
  color?: string
  style: 'solid' | 'dashed' | 'dotted'
  arrow: 'none' | 'end' | 'both'
  width: number
}

export type AreaKind = 'vpc' | 'subnet' | 'zone' | 'group'

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

export interface LabelT {
  id: ID
  x: number
  y: number
  text: string
  size: number
  color?: string
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

export interface CostLine {
  label: string
  monthly: number
  /** eligible for commitment discounts (savings plans / reserved) */
  commit?: boolean
}

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
