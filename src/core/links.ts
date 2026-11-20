import { defOf, nodeName } from './catalog'
import type { Doc, EdgeT, LinkKind, LinkOrigin, NodeT } from './types'

/**
 * What connections mean.
 *
 * A line in a diagram is a claim about the system, so each one carries a kind
 * (what sort of relationship), optionally a protocol and port, and where it came
 * from. Nothing here is measured traffic: a connection is either drawn by the
 * user, read out of infrastructure code, or guessed while importing, and the
 * interface says which.
 */

export interface KindInfo {
  id: LinkKind
  name: string
  /** one line for the inspector: what this relationship is */
  blurb: string
  style: EdgeT['style']
  arrow: EdgeT['arrow']
  /** the verb between the two names in a sentence: "web calls api" */
  verb: string
}

export const KINDS: KindInfo[] = [
  { id: 'request', name: 'Request', blurb: 'One side calls the other and waits for the answer', style: 'solid', arrow: 'end', verb: 'calls' },
  { id: 'data', name: 'Data', blurb: 'Reads from or writes to a store', style: 'solid', arrow: 'end', verb: 'reads and writes' },
  { id: 'event', name: 'Event', blurb: 'Sends messages without waiting: a queue, a topic, a stream', style: 'dashed', arrow: 'end', verb: 'sends events to' },
  { id: 'replication', name: 'Replication', blurb: 'Keeps a copy in step with the original', style: 'dotted', arrow: 'both', verb: 'replicates with' },
  { id: 'dependency', name: 'Dependency', blurb: 'Needs the other to exist or be configured; no traffic implied', style: 'dotted', arrow: 'end', verb: 'depends on' },
]
export const kindInfo = (k?: LinkKind) => KINDS.find((x) => x.id === k)

export const ORIGINS: Record<LinkOrigin, { name: string; blurb: string }> = {
  drawn: { name: 'Drawn', blurb: 'Someone drew this connection by hand.' },
  imported: { name: 'From code', blurb: 'Read from a reference between two resources in imported infrastructure code.' },
  inferred: { name: 'Inferred', blurb: 'Guessed while importing, because public entry points usually have clients. Check it.' },
}

/** The kind a new connection most likely is, from what it joins. A starting point the user can change. */
export function guessKind(from: NodeT, to: NodeT): LinkKind {
  const a = defOf(from.type).category, b = defOf(to.type).category
  if (b === 'messaging' || a === 'messaging') return 'event'
  if (b === 'database' || b === 'storage' || b === 'analytics') return a === b ? 'replication' : 'data'
  return 'request'
}

/** "HTTPS 443", "TCP 5432", "gRPC": the technical part of a connection's caption. */
export const wireOf = (e: EdgeT) => [e.protocol, e.port].filter(Boolean).join(' ')
/** What is written along the line. */
export const captionOf = (e: EdgeT) => [e.label, wireOf(e)].filter(Boolean).join(' · ')

/** A plain sentence for one connection: "web calls api over HTTPS 443". */
export function describe(doc: Doc, e: EdgeT): string {
  const a = doc.nodes.find((n) => n.id === e.from), b = doc.nodes.find((n) => n.id === e.to)
  if (!a || !b) return ''
  const verb = kindInfo(e.kind)?.verb ?? (e.arrow === 'none' ? 'is connected to' : e.arrow === 'both' ? 'talks both ways with' : 'connects to')
  const wire = wireOf(e)
  return `${nodeName(a)} ${verb} ${nodeName(b)}${wire ? ' over ' + wire : ''}`
}

// ---- following the flow ------------------------------------------------------------------

export interface Flow {
  /** everything the starting point can reach by following the arrows */
  down: Set<string>
  /** everything that can reach the starting point */
  up: Set<string>
  /** connections on any of those paths */
  edges: Set<string>
  /** the components the trace started from */
  start: Set<string>
}

/**
 * Follow the arrows out from a component or a connection, both ways.
 * A two-headed line carries flow in both directions; a line with no arrowhead is an
 * association rather than a flow, and is followed either way so nothing is silently left out.
 */
export function traceFlow(doc: Doc, id: string): Flow | null {
  const edge = doc.edges.find((e) => e.id === id), node = doc.nodes.find((n) => n.id === id)
  if (!edge && !node) return null
  const out = new Map<string, { to: string; e: string }[]>(), into = new Map<string, { to: string; e: string }[]>()
  const add = (m: typeof out, a: string, b: string, e: string) => { (m.get(a) ?? m.set(a, []).get(a)!).push({ to: b, e }) }
  const has = new Set(doc.nodes.map((n) => n.id))
  for (const e of doc.edges) {
    if (!has.has(e.from) || !has.has(e.to)) continue
    add(out, e.from, e.to, e.id); add(into, e.to, e.from, e.id)
    if (e.arrow !== 'end') { add(out, e.to, e.from, e.id); add(into, e.from, e.to, e.id) }
  }
  const edges = new Set<string>()
  const walk = (from: string[], m: typeof out) => {
    const seen = new Set<string>(), q = [...from]
    while (q.length) {
      const n = q.shift()!
      for (const { to, e } of m.get(n) ?? []) { edges.add(e); if (!seen.has(to) && !from.includes(to)) { seen.add(to); q.push(to) } }
    }
    return seen
  }
  const start = new Set(edge ? [edge.from, edge.to] : [node!.id])
  if (edge) edges.add(edge.id)
  // from a connection: downstream of where it arrives, upstream of where it leaves
  const down = walk(edge ? [edge.to] : [node!.id], out), up = walk(edge ? [edge.from] : [node!.id], into)
  for (const s of start) { down.delete(s); up.delete(s) }
  return { down, up, edges, start }
}

/** Connections that look wrong, from what the diagram itself says. */
export function linkProblems(doc: Doc, e: EdgeT): string[] {
  const a = doc.nodes.find((n) => n.id === e.from), b = doc.nodes.find((n) => n.id === e.to)
  if (!a || !b) return []
  const out: string[] = []
  const ca = defOf(a.type).category, cb = defOf(b.type).category
  if (ca === 'external' && (cb === 'database' || cb === 'storage') && e.kind !== 'dependency' && b.type !== 's3')
    out.push(`${nodeName(a)} reaches ${nodeName(b)} directly. Data stores are normally reached through a service, not from outside.`)
  if (e.port && !/^\d{1,5}(\s*[-,]\s*\d{1,5})*$/.test(e.port.trim())) out.push('The port is not a number, a range or a list of numbers.')
  else if (e.port && e.port.split(/[-,]/).some((p) => Number(p) > 65535 || Number(p) < 1)) out.push('Ports run from 1 to 65535.')
  if (e.kind === 'replication' && ca !== cb) out.push(`Replication usually joins two of the same kind of thing; this joins ${defOf(a.type).name.toLowerCase()} and ${defOf(b.type).name.toLowerCase()}.`)
  const twins = doc.edges.filter((x) => x.id !== e.id && x.from === e.from && x.to === e.to && (x.kind ?? '') === (e.kind ?? '') && wireOf(x) === wireOf(e) && (x.label ?? '') === (e.label ?? ''))
  if (twins.length) out.push('Another connection between these two says exactly the same thing.')
  return out
}
