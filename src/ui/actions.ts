import { fitView, groundAt, setFlat } from '../canvas/camera'
import { PROVIDERS, translateDoc } from '../core/catalog'
import { autoLayout, fitArea, inArea } from '../core/layout'
import { addSnapshot, encodeShare } from '../core/storage'
import { useStore } from '../core/store'

const S = () => useStore.getState()

export function tidy() {
  const s = S()
  if (!s.doc.nodes.length) return
  s.apply((d) => autoLayout(d))
  requestAnimationFrame(() => fitView())
  s.toast('Layout tidied')
}

/** Swap every component for its equivalent on another cloud. One undo step. */
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

/** Drop a component at the centre of the viewport, avoiding occupied cells. */
export function addAtCenter(type: string) {
  const s = S()
  const [wx, wy] = groundAt()
  let x = Math.round(wx - 1), y = Math.round(wy - 1)
  const taken = (px: number, py: number) => s.doc.nodes.some((n) => Math.abs(n.x - px) < 2 && Math.abs(n.y - py) < 2)
  for (let i = 0; i < 40 && taken(x, y); i++) { x += 3; if (i % 4 === 3) { x -= 12; y += 3 } }
  return s.addNode(type, x, y)
}

export function saveVersion(name?: string) {
  const s = S()
  addSnapshot(s.doc, name || 'Version ' + new Date().toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }))
  s.toast('Version saved')
}

export async function shareUrl() {
  const payload = await encodeShare(S().doc)
  return `${location.origin}${location.pathname}#/s/${payload}`
}

export function fitAreaToContents(id: string) {
  S().apply((d) => {
    const a = d.areas.find((x) => x.id === id)
    if (!a) return d
    const inside = d.nodes.filter((n) => inArea(a, n))
    if (!inside.length) return d
    return { ...d, areas: d.areas.map((x) => (x.id === id ? fitArea(a, inside) : x)) }
  })
}

export function wrapSelectionInArea() {
  const s = S()
  const nodes = s.doc.nodes.filter((n) => s.selection.includes(n.id))
  if (!nodes.length) return
  const a = fitArea({ id: '', x: 0, y: 0, w: 1, d: 1, name: 'Group', color: '#8792A8', kind: 'group' }, nodes)
  const { id: _omit, ...rest } = a
  s.addArea(rest)
}

export const toggleFlat = () => setFlat(!S().flat)
export const go = (hash: string) => { location.hash = hash }
