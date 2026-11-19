import { defaultProps } from '../core/catalog'
import { useStore } from '../core/store'
import { type Doc, type EdgeT, type NodeT, emptyDoc } from '../core/types'

/** Put the shared store back to its boot state. Call in `beforeEach`. */
export function resetStore(patch: Partial<ReturnType<typeof useStore.getState>> = {}) {
  useStore.setState({ ...useStore.getInitialState(), doc: emptyDoc(), ...patch }, true)
}

export const node = (id: string, type = 'ec2', x = 0, y = 0, extra: Partial<NodeT> = {}): NodeT =>
  ({ id, type, x, y, props: defaultProps(type), ...extra })

export const edge = (id: string, from: string, to: string, extra: Partial<EdgeT> = {}): EdgeT =>
  ({ id, from, to, style: 'solid', arrow: 'end', width: 2, ...extra })

/** A blueprint with fixed ids, so assertions can name things. */
export function docOf(nodes: NodeT[] = [], edges: EdgeT[] = [], extra: Partial<Doc> = {}): Doc {
  return { ...emptyDoc('Test blueprint'), id: 'doc1', nodes, edges, ...extra }
}
