/**
 * Builders for unit and component tests. Positions are ground cells, as in the blueprint itself.
 * The store is one object shared by every test in a file and nothing resets it for them: see `resetStore`.
 */
import { defaultProps } from '../core/catalog'
import { useStore } from '../core/store'
import { type Doc, type EdgeT, type NodeT, emptyDoc } from '../core/types'

/** Put the shared store back to its boot state. Call in `beforeEach`. */
export function resetStore(patch: Partial<ReturnType<typeof useStore.getState>> = {}) {
  useStore.setState({ ...useStore.getInitialState(), doc: emptyDoc(), ...patch }, true)
}

/** A component with the catalogue's default settings for its type, at (x, y) cells. */
export const node = (id: string, type = 'ec2', x = 0, y = 0, extra: Partial<NodeT> = {}): NodeT =>
  ({ id, type, x, y, props: defaultProps(type), ...extra })

/** A plain automatic connection: no sides, runs or plan, as an older blueprint would hold it. */
export const edge = (id: string, from: string, to: string, extra: Partial<EdgeT> = {}): EdgeT =>
  ({ id, from, to, style: 'solid', arrow: 'end', width: 2, ...extra })

/** A blueprint with fixed ids, so assertions can name things. */
export function docOf(nodes: NodeT[] = [], edges: EdgeT[] = [], extra: Partial<Doc> = {}): Doc {
  return { ...emptyDoc('Test blueprint'), id: 'doc1', nodes, edges, ...extra }
}
