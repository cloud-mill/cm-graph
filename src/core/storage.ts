import { type Doc, MAX_SCALE, MIN_SCALE } from './types'
import { uid } from './types'

/**
 * Persistence: blueprints, their named versions and preferences in `localStorage`, and share links.
 * There is no server. Keys, all under the prefix below: `index` (the list the dashboard shows), `doc:<id>`,
 * `snaps:<id>` and `pref:<name>`.
 *
 * Storage can be full, blocked or hand-edited, so reading and writing it never throws: a read that fails gives the
 * fallback, and a write says whether it worked. A blueprint read from storage, a file or a link is passed through
 * `coerceDoc` before the editor sees it; named versions are not.
 */

// the storage prefix predates the CloudMill Graph name; it stays so existing saved blueprints keep loading
const K = 'stratum:'

/** A blueprint's entry in the index: enough to list it without reading the blueprint itself. `nodes` is a count. */
export interface DocMeta {
  id: string
  name: string
  updatedAt: number
  nodes: number
}

/** A named version of a blueprint: a whole copy of it as it was at time `at` (ms since the epoch). */
export interface Snapshot {
  id: string
  name: string
  at: number
  doc: Doc
}

const read = <T,>(key: string, fallback: T): T => {
  try {
    const v = localStorage.getItem(K + key)
    return v ? (JSON.parse(v) as T) : fallback
  } catch {
    return fallback
  }
}
const write = (key: string, v: unknown) => {
  try {
    localStorage.setItem(K + key, JSON.stringify(v))
    return true
  } catch {
    return false
  }
}

/** The stored index, or an empty one if it is missing or not a list. */
const readIndex = (): DocMeta[] => {
  const v = read<unknown>('index', [])
  return Array.isArray(v) ? v.filter((m) => m && typeof m.id === 'string') : []
}

export const listDocs = (): DocMeta[] => readIndex().sort((a, b) => b.updatedAt - a.updatedAt)
/**
 * A stored blueprint, repaired on the way in: storage can hold files written by
 * older versions or edited by hand, and the editor must never open a broken one.
 * Null when there is nothing stored under that id, or what is there is not a blueprint.
 * The id is the storage key, whatever the file itself says.
 */
export function loadDoc(id: string): Doc | null {
  const raw = read<any>('doc:' + id, null)
  const doc = coerceDoc(raw)
  if (!doc) return null
  const t = (v: any) => (typeof v === 'number' && isFinite(v) ? v : Date.now())
  return { ...doc, id, name: typeof raw.name === 'string' ? raw.name : 'Untitled blueprint', createdAt: t(raw.createdAt), updatedAt: t(raw.updatedAt) }
}

/** Store a blueprint and bring its index entry up to date. False when the blueprint itself could not be written. */
export function saveDoc(doc: Doc) {
  const ok = write('doc:' + doc.id, doc)
  // a blueprint that could not be stored keeps its last good entry rather than gaining one that points at nothing
  if (!ok) return false
  const idx = readIndex().filter((m) => m.id !== doc.id)
  idx.push({ id: doc.id, name: doc.name, updatedAt: doc.updatedAt, nodes: doc.nodes.length })
  write('index', idx)
  return ok
}

export function deleteDoc(id: string) {
  try {
    localStorage.removeItem(K + 'doc:' + id)
    localStorage.removeItem(K + 'snaps:' + id)
  } catch { /* storage unavailable: nothing to remove */ }
  write('index', readIndex().filter((m) => m.id !== id))
}

export function duplicateDoc(id: string): Doc | null {
  const d = loadDoc(id)
  if (!d) return null
  const copy = { ...d, id: uid(), name: d.name + ' (copy)', createdAt: Date.now(), updatedAt: Date.now() }
  saveDoc(copy)
  return copy
}

/** A blueprint's named versions, newest first. Only the 20 newest are kept. They are checked far more lightly than a blueprint is on load. */
export const listSnapshots = (docId: string): Snapshot[] => {
  const v = read<unknown>('snaps:' + docId, [])
  return Array.isArray(v) ? v.filter((s) => s && s.doc && Array.isArray(s.doc.nodes)) : []
}
export function addSnapshot(doc: Doc, name: string) {
  const snaps = listSnapshots(doc.id)
  snaps.unshift({ id: uid(), name, at: Date.now(), doc })
  write('snaps:' + doc.id, snaps.slice(0, 20))
}
export function removeSnapshot(docId: string, id: string) {
  write('snaps:' + docId, listSnapshots(docId).filter((s) => s.id !== id))
}

export const getPref = <T,>(key: string, fallback: T) => read<T>('pref:' + key, fallback)
export const setPref = (key: string, v: unknown) => write('pref:' + key, v)

/**
 * Validate and normalise untrusted JSON into a Doc (imports, share links, and whatever is in storage).
 * Null only when it is not a blueprint at all (no `nodes` list). Otherwise it repairs and never refuses, because
 * the rest of the app assumes what this guarantees:
 *  - every field has the right type, with a default where it was missing or wrong;
 *  - ids are unique across components, connections, areas and labels;
 *  - every connection joins two different components that exist;
 *  - component sizes, line widths, label sizes and the lengths of stored paths are within bounds.
 * It does not check a component's `type` against the catalog, look inside `props`, or limit how many items there are.
 * The result always has a new id and new timestamps: a caller that knows better (`loadDoc`) puts the real ones back.
 */
export function coerceDoc(raw: any): Doc | null {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.nodes)) return null
  const s = (v: any, d = '') => (typeof v === 'string' ? v : d)
  const opt = (v: any) => (typeof v === 'string' && v ? v : undefined)
  const n = (v: any, d = 0) => (typeof v === 'number' && isFinite(v) ? v : d)
  const obj = (v: any) => !!v && typeof v === 'object' && !Array.isArray(v)
  const list = (v: any): any[] => (Array.isArray(v) ? v.filter(obj) : [])
  // ids must be unique for selection and rendering; a repeat gets a fresh one
  const seen = new Set<string>()
  const idOf = (v: any) => { let id = s(v); if (!id || seen.has(id)) id = uid(); seen.add(id); return id }
  const nodes = list(raw.nodes)
    .filter((x) => typeof x.type === 'string')
    .map((x) => ({
      id: idOf(x.id), type: x.type, x: n(x.x), y: n(x.y), name: opt(x.name),
      props: obj(x.props) ? x.props : {}, color: opt(x.color), notes: opt(x.notes), link: opt(x.link),
      // sizes outside the supported range are dropped rather than trusted
      ...(typeof x.scale === 'number' && x.scale !== 1 && x.scale >= MIN_SCALE && x.scale <= MAX_SCALE ? { scale: x.scale } : {}),
    }))
  const ids = new Set(nodes.map((x) => x.id))
  return {
    id: uid(),
    name: s(raw.name, 'Imported blueprint'),
    region: s(raw.region, 'us-east-1'),
    nodes,
    edges: list(raw.edges)
      .filter((e) => ids.has(e.from) && ids.has(e.to) && e.from !== e.to)
      .map((e) => ({
        id: idOf(e.id), from: e.from, to: e.to, label: opt(e.label), color: opt(e.color),
        style: ['solid', 'dashed', 'dotted'].includes(e.style) ? e.style : 'solid',
        arrow: ['none', 'end', 'both'].includes(e.arrow) ? e.arrow : 'end', width: n(e.width) > 0 && n(e.width) <= 20 ? n(e.width) : 2,
        // what the line means and how it was shaped: all optional, so older files read as plain automatic connections
        ...(['request', 'data', 'event', 'replication', 'dependency'].includes(e.kind) ? { kind: e.kind } : {}),
        ...(opt(e.protocol) ? { protocol: String(e.protocol).slice(0, 40) } : {}),
        ...(opt(e.port) ? { port: String(e.port).slice(0, 40) } : {}),
        ...(['drawn', 'imported', 'inferred'].includes(e.origin) ? { origin: e.origin } : {}),
        ...(Array.isArray(e.via) && e.via.length && e.via.length <= 64 && e.via.every((p: any) => Array.isArray(p) && p.length === 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]))
          ? { via: e.via.map((p: any) => [p[0], p[1]] as [number, number]) } : {}),
        ...(['n', 'e', 's', 'w'].includes(e.fromSide) ? { fromSide: e.fromSide } : {}),
        ...(['n', 'e', 's', 'w'].includes(e.toSide) ? { toSide: e.toSide } : {}),
        ...(e.shape === 'direct' || e.shape === 'curved' ? { shape: e.shape } : {}),
        ...(Array.isArray(e.runs) && e.runs.length <= 64 && e.runs.every((v: any) => Number.isFinite(v)) ? { runs: e.runs.map(Number) } : {}),
        ...(Number.isFinite(e.fromAt) ? { fromAt: e.fromAt } : {}),
        ...(Number.isFinite(e.toAt) ? { toAt: e.toAt } : {}),
        // a planned path is only ever followed while its key still matches the diagram, so a damaged one is simply planned again
        ...(e.plan && typeof e.plan.key === 'string' && ['n', 'e', 's', 'w'].includes(e.plan.fromSide) && ['n', 'e', 's', 'w'].includes(e.plan.toSide) && Array.isArray(e.plan.pts) && e.plan.pts.length >= 2 && e.plan.pts.length <= 130 && e.plan.pts.every((p: any) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]))
          ? { plan: { key: e.plan.key, fromSide: e.plan.fromSide, toSide: e.plan.toSide, pts: e.plan.pts.map((p: any) => [Number(p[0]), Number(p[1])]) } } : {}),
      })),
    areas: list(raw.areas).map((a) => ({
      id: idOf(a.id), x: n(a.x), y: n(a.y), w: Math.max(1, n(a.w, 4)), d: Math.max(1, n(a.d, 4)), name: s(a.name, 'Area'),
      color: s(a.color, '#8F6FF2'), kind: ['vpc', 'subnet', 'zone', 'group'].includes(a.kind) ? a.kind : 'group',
    })),
    labels: list(raw.labels).map((l) => ({
      id: idOf(l.id), x: n(l.x), y: n(l.y), text: s(l.text, 'Label'), size: n(l.size) > 0 && n(l.size) <= 400 ? n(l.size) : 20, color: opt(l.color), dir: l.dir === 'y' ? 'y' : 'x',
    })),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

// ---- share links: deflate + base64url in the URL fragment -------------------

// The whole blueprint travels in the link itself, so sharing needs no server and the payload is only as private as the link.

async function pipe(data: Uint8Array, stream: TransformStream<any, any>) {
  const out = new Response(new Blob([data as BlobPart]).stream().pipeThrough(stream))
  return new Uint8Array(await out.arrayBuffer())
}

/** The payload of a share link. The blueprint's id and timestamps are left out: whoever opens the link gets a copy of their own. */
export async function encodeShare(doc: Doc): Promise<string> {
  const { id, createdAt, updatedAt, ...rest } = doc
  const bytes = await pipe(new TextEncoder().encode(JSON.stringify(rest)), new CompressionStream('deflate-raw'))
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** The blueprint in a share link's payload, validated; null when the payload is damaged or is not a blueprint. */
export async function decodeShare(payload: string): Promise<Doc | null> {
  try {
    const bin = atob(payload.replace(/-/g, '+').replace(/_/g, '/'))
    const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0))
    const json = new TextDecoder().decode(await pipe(bytes, new DecompressionStream('deflate-raw')))
    return coerceDoc(JSON.parse(json))
  } catch {
    return null
  }
}
