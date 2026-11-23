import { navigate } from '../core/nav'
import { fitView, groundAt, setFlat } from '../canvas/camera'
import { PROVIDERS, nodeName, translateDoc } from '../core/catalog'
import { straightness } from '../core/shape'
import { autoLayout, fitArea, inArea } from '../core/layout'
import { addSnapshot, encodeShare } from '../core/storage'
import { useStore } from '../core/store'

/*
 * Commands that more than one place offers: the toolbar, the context menu, the command palette, the
 * phone dock, the inspector and the keyboard all call these, so each does the same thing and says the
 * same thing wherever it is asked for. They are plain functions, not hooks: each reads the store at
 * the moment it runs. Changes to the blueprint go through `apply`, so each is one undo step.
 */

const S = () => useStore.getState()

/** Lay the whole blueprint out afresh and bring it into frame. Lines shaped by hand go back to the router, since the places they were shaped for are gone. Does nothing on an empty blueprint. */
export function tidy() {
  const s = S()
  if (!s.doc.nodes.length) return
  s.apply((d) => autoLayout(d))
  requestAnimationFrame(() => fitView())
  s.toast('Layout tidied')
}

/** Swap every component for its equivalent on another cloud, and turn the library to that cloud. One undo step. */
export function translateTo(provider: 'aws' | 'gcp' | 'azure') {
  const s = S()
  const r = translateDoc(s.doc, provider)
  const name = PROVIDERS.find((p) => p.id === provider)!.short
  if (!r.moved) return s.toast(r.kept ? `No ${name} equivalent for the remaining components` : `Already on ${name}`, 'warn')
  s.apply(() => r.doc)
  useStore.setState({ provider })
  s.toast(`Moved ${r.moved} component${r.moved === 1 ? '' : 's'} to ${name}` + (r.kept ? ` · ${r.kept} had no equivalent` : ''))
}

export function selectAll() {
  const d = S().doc
  S().select([...d.nodes, ...d.areas, ...d.labels].map((x) => x.id))
}

/**
 * Add a component at the middle of the canvas that is in view (clear of panels and sheets), on whole
 * cells. If that spot is taken it tries others nearby, three cells apart in rows of four; after 40
 * tries it goes where it is. Returns the new component's id.
 */
export function addAtCenter(type: string) {
  const s = S()
  const [wx, wy] = groundAt()
  let x = Math.round(wx - 1), y = Math.round(wy - 1)
  const taken = (px: number, py: number) => s.doc.nodes.some((n) => Math.abs(n.x - px) < 2 && Math.abs(n.y - py) < 2)
  for (let i = 0; i < 40 && taken(x, y); i++) { x += 3; if (i % 4 === 3) { x -= 12; y += 3 } }
  return s.addNode(type, x, y)
}

/** Keep a named copy of the blueprint as it is now in its version history. Unnamed, it is called by the date and time. */
export function saveVersion(name?: string) {
  const s = S()
  addSnapshot(s.doc, name || 'Version ' + new Date().toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }))
  s.toast('Version saved')
}

/** A link that carries the whole blueprint in its fragment (`#/s/...`); opening it makes a copy, see App. */
export async function shareUrl() {
  const payload = await encodeShare(S().doc)
  return `${location.origin}${location.pathname}#/s/${payload}`
}

/** Resize an area round the components inside it. Nothing changes, and no undo step is made, when it is empty. */
export function fitAreaToContents(id: string) {
  S().apply((d) => {
    const a = d.areas.find((x) => x.id === id)
    if (!a) return d
    const inside = d.nodes.filter((n) => inArea(a, n))
    if (!inside.length) return d
    return { ...d, areas: d.areas.map((x) => (x.id === id ? fitArea(a, inside) : x)) }
  })
}

/** Draw a new group round the selected components (other selected things are ignored) and select it. */
export function wrapSelectionInArea() {
  const s = S()
  const nodes = s.doc.nodes.filter((n) => s.selection.includes(n.id))
  if (!nodes.length) return
  const a = fitArea({ id: '', x: 0, y: 0, w: 1, d: 1, name: 'Group', color: '#8792A8', kind: 'group' }, nodes)
  const { id: _omit, ...rest } = a
  s.addArea(rest)
}

export const toggleFlat = () => setFlat(!S().flat)
export const go = (hash: string) => navigate(hash)

/**
 * Make connections straight. One whose components do not line up has the lighter of the two moved level with the other;
 * several at once are straightened where they can be, and the rest say why they were not.
 */
export function straightenLinks(ids: string[]) {
  const s = useStore.getState()
  const e = ids.length === 1 ? s.doc.edges.find((x) => x.id === ids[0]) : null
  const state = e ? straightness(s.doc, e) : null
  if (e && state?.state === 'apart') {
    const moved = s.doc.nodes.find((n) => n.id === state.move)
    s.lineUp(e.id)
    if (moved) s.toast(`Moved ${nodeName(moved)} into line`)
    return
  }
  const r = s.straighten(ids)
  if (r.apart) s.toast(`${r.apart} could not be straight: the components are not in line`, 'warn')
}

/**
 * Take the small kinks out of connections: the ones picked, or every one when none is. Only steps too small to have
 * been meant go; the rest of each line is left exactly as it was.
 */
export function cleanLines(ids?: string[]) {
  const s = useStore.getState()
  const picked = ids ?? s.selection.filter((id) => s.doc.edges.some((e) => e.id === id))
  const { tidied: n, taken } = s.cleanLines(picked.length ? picked : s.doc.edges.map((e) => e.id))
  // a line that was routed automatically keeps the path it has now: say so, since that is a change of whose line it is
  const kept = taken ? `. ${taken === n ? (n === 1 ? 'It keeps' : 'They keep') : `${taken} now ${taken === 1 ? 'keeps' : 'keep'}`} this path` : ''
  s.toast(n ? `Straightened ${n} ${n === 1 ? 'line' : 'lines'}${kept}` : 'No small kinks to take out')
}
