import { useMemo } from 'react'
import { ArrowLeftRight, Copy, ExternalLink, Maximize2, Trash2 } from 'lucide-react'
import { fitView } from '../canvas/camera'
import { ModelIcon } from '../canvas/models'
import { CATEGORIES, PROVIDERS, REGIONS, type PropDef, costOf, defOf, defaultProps, docCost, docProviders, money, nodeColor, nodeName, translateDoc } from '../core/catalog'
import { ISO } from '../core/iso'
import { coalesce, useStore } from '../core/store'
import { type AreaT, type EdgeT, type LabelT, type NodeT, centerOf } from '../core/types'
import { NumberInput, Row, Segmented, Select, Swatches, TextInput, Toggle, keys } from './atoms'
import { fitAreaToContents, translateTo } from './actions'

const upd = <T extends { id: string }>(list: T[], id: string, p: Partial<T>) => list.map((x) => (x.id === id ? { ...x, ...p } : x))

function PropField({ def, value, onChange }: { def: PropDef; value: any; onChange: (v: any) => void }) {
  if (def.type === 'select')
    return (
      <Row label={def.label}>
        <Select label={def.label} value={String(value)} onChange={onChange} options={def.options!} />
      </Row>
    )
  if (def.type === 'toggle') return <Row label={def.label}><Toggle label={def.label} value={!!value} onChange={onChange} /></Row>
  return <Row label={def.label}><NumberInput label={def.label} value={Number(value) || 0} onChange={onChange} min={def.min} max={def.max} step={def.step} unit={def.unit} /></Row>
}

function NodeInspector({ nodes }: { nodes: NodeT[] }) {
  const s = useStore.getState()
  const doc = useStore((st) => st.doc)
  const pricing = useStore((st) => st.pricing)
  const focusName = useStore((st) => st.focusName)
  const n = nodes[0]
  const d = defOf(n.type)
  const same = nodes.every((x) => x.type === n.type)
  const ids = nodes.map((x) => x.id)
  const props = { ...defaultProps(n.type), ...n.props }
  const total = nodes.reduce((sum, x) => sum + costOf(x, doc.region, pricing).monthly, 0)
  const cost = costOf(n, doc.region, pricing)
  const links = nodes.length === 1 ? doc.edges.filter((e) => e.from === n.id || e.to === n.id) : []
  const cat = CATEGORIES.find((c) => c.id === d.category)!

  return (
    <>
      <div className="insp-hero">
        <div className="insp-icon"><ModelIcon type={n.type} proj={ISO} size={58} color={nodeColor(n)} /></div>
        <div className="insp-hero-text">
          {nodes.length === 1 ? (
            <TextInput label="Component name" className="title-input" value={n.name ?? ''} placeholder={d.name} autoFocusKey={focusName}
              onChange={(v) => coalesce('name:' + n.id, (doc) => ({ ...doc, nodes: upd(doc.nodes, n.id, { name: v || undefined }) }))} />
          ) : (
            <div className="title-static">{nodes.length} components</div>
          )}
          <div className="insp-sub"><i style={{ background: cat.color }} />{same ? `${d.name} · ${d.svc}` : 'Mixed selection'}</div>
        </div>
      </div>

      {same && d.props.length > 0 && (
        <section className="sect">
          <h5>Configuration</h5>
          {d.props.filter((p) => !p.showIf || p.showIf(props)).map((p) => (
            <PropField key={p.key} def={p} value={props[p.key]}
              onChange={(v) => coalesce(`prop:${ids.join()}:${p.key}`, (doc) => ({ ...doc, nodes: doc.nodes.map((x) => (ids.includes(x.id) ? { ...x, props: { ...x.props, [p.key]: v } } : x)) }))} />
          ))}
        </section>
      )}

      <section className="sect">
        <h5>Estimated cost</h5>
        <div className="cost-card">
          {nodes.length === 1 && cost.lines.map((l, i) => (
            <div key={i} className="cost-line"><span>{l.label}</span><span className="mono">{money(l.monthly)}</span></div>
          ))}
          {nodes.length === 1 && !cost.lines.length && <div className="muted">No direct charge for this component.</div>}
          <div className="cost-total"><span>{nodes.length > 1 ? 'Selection total' : 'Monthly'}</span><span className="mono">{money(total)}<small>/mo</small></span></div>
        </div>
      </section>

      <section className="sect">
        <h5>Appearance</h5>
        <Row label="Scale">
          <Select label="Scale" value={String(nodes.every((x) => (x.scale ?? 1) === (n.scale ?? 1)) ? n.scale ?? 1 : '')}
            options={[...(nodes.every((x) => (x.scale ?? 1) === (n.scale ?? 1)) ? [] : [{ value: '', label: 'Mixed' }]), ...SIZES.map((v) => ({ value: String(v), label: Math.round(v * 100) + '%' })), ...(SIZES.includes(n.scale ?? 1) ? [] : [{ value: String(n.scale), label: Math.round((n.scale ?? 1) * 100) + '%' }])]}
            onChange={(v) => { if (v) s.apply((doc) => ({ ...doc, nodes: doc.nodes.map((x) => (ids.includes(x.id) ? resized(x, Number(v)) : x)) })) }} />
        </Row>
        <Swatches allowReset value={nodes.every((x) => x.color === n.color) ? n.color : undefined} mixed={!nodes.every((x) => x.color === n.color)}
          onChange={(c) => s.apply((doc) => ({ ...doc, nodes: doc.nodes.map((x) => (ids.includes(x.id) ? { ...x, color: c } : x)) }))} />
      </section>

      {nodes.length === 1 && (
        <>
          <section className="sect">
            <h5>Notes</h5>
            <TextInput label="Notes" multiline value={n.notes ?? ''} placeholder="Runbook notes, owners, caveats…"
              onChange={(v) => coalesce('notes:' + n.id, (doc) => ({ ...doc, nodes: upd(doc.nodes, n.id, { notes: v || undefined }) }))} />
            <div className="link-row">
              <TextInput label="Link" value={n.link ?? ''} placeholder="https://link-to-docs-or-console"
                onChange={(v) => coalesce('link:' + n.id, (doc) => ({ ...doc, nodes: upd(doc.nodes, n.id, { link: v || undefined }) }))} />
              {n.link && /^https?:\/\//.test(n.link) && <a className="icon-btn" href={n.link} target="_blank" rel="noreferrer noopener" aria-label="Open link"><ExternalLink size={14} /></a>}
            </div>
          </section>
          {links.length > 0 && (
            <section className="sect">
              <h5>Connections <span className="count">{links.length}</span></h5>
              <div className="conn-list">
                {links.map((e) => {
                  const other = doc.nodes.find((x) => x.id === (e.from === n.id ? e.to : e.from))
                  if (!other) return null
                  return (
                    <button key={e.id} className="conn" onClick={() => s.select([e.id])}>
                      <span className="conn-dir">{e.arrow === 'both' ? '↔' : e.from === n.id ? '→' : '←'}</span>
                      <span className="conn-name">{nodeName(other)}</span>
                      <span className="muted">{e.label ?? defOf(other.type).svc}</span>
                    </button>
                  )
                })}
              </div>
            </section>
          )}
        </>
      )}
      <Actions ids={ids} onZoom={() => fitView(ids)} />
    </>
  )
}

function Actions({ ids, onZoom, noDup }: { ids: string[]; onZoom?: () => void; noDup?: boolean }) {
  const s = useStore.getState()
  return (
    <div className="insp-actions">
      {onZoom && <button className="btn ghost" onClick={onZoom}><Maximize2 size={14} />Focus</button>}
      {!noDup && <button className="btn ghost" onClick={() => s.duplicate(ids)}><Copy size={14} />Duplicate</button>}
      <button className="btn ghost danger" onClick={() => s.remove(ids)}><Trash2 size={14} />Delete</button>
    </div>
  )
}

function EdgeInspector({ edges }: { edges: EdgeT[] }) {
  const s = useStore.getState()
  const doc = useStore((st) => st.doc)
  const focusName = useStore((st) => st.focusName)
  const e = edges[0]
  const ids = edges.map((x) => x.id)
  const a = doc.nodes.find((n) => n.id === e.from), b = doc.nodes.find((n) => n.id === e.to)
  return (
    <>
      <div className="insp-hero slim">
        <div className="insp-hero-text">
          <div className="title-static">{edges.length > 1 ? `${edges.length} connections` : 'Connection'}</div>
          {edges.length === 1 && a && b && <div className="insp-sub">{nodeName(a)} → {nodeName(b)}</div>}
        </div>
      </div>
      <section className="sect">
        {edges.length === 1 && (
          <Row label="Label">
            <TextInput label="Connection label" value={e.label ?? ''} placeholder="e.g. HTTPS, gRPC, events" autoFocusKey={focusName}
              onChange={(v) => coalesce('elabel:' + e.id, (d) => ({ ...d, edges: upd(d.edges, e.id, { label: v || undefined }) }))} />
          </Row>
        )}
        <Row label="Line">
          <Segmented size="sm" value={e.style} onChange={(v) => s.patchEdge(ids, { style: v })}
            options={[{ value: 'solid', label: 'Solid' }, { value: 'dashed', label: 'Dashed' }, { value: 'dotted', label: 'Dotted' }]} />
        </Row>
        <Row label="Arrows">
          <Segmented size="sm" value={e.arrow} onChange={(v) => s.patchEdge(ids, { arrow: v })}
            options={[{ value: 'none', label: 'None' }, { value: 'end', label: 'One-way' }, { value: 'both', label: 'Both' }]} />
        </Row>
        <Row label="Weight">
          <Segmented size="sm" value={String(e.width) as any} onChange={(v) => s.patchEdge(ids, { width: Number(v) })}
            options={[{ value: '1.5', label: 'Thin' }, { value: '2', label: 'Regular' }, { value: '3.5', label: 'Bold' }]} />
        </Row>
      </section>
      <section className="sect">
        <h5>Colour</h5>
        <Swatches allowReset value={e.color} onChange={(c) => s.patchEdge(ids, { color: c })} />
      </section>
      <div className="insp-actions">
        <button className="btn ghost" onClick={() => s.apply((d) => ({ ...d, edges: d.edges.map((x) => (ids.includes(x.id) ? { ...x, from: x.to, to: x.from } : x)) }))}><ArrowLeftRight size={14} />Reverse</button>
        <button className="btn ghost danger" onClick={() => s.remove(ids)}><Trash2 size={14} />Delete</button>
      </div>
    </>
  )
}

function AreaInspector({ a }: { a: AreaT }) {
  const s = useStore.getState()
  const focusName = useStore((st) => st.focusName)
  return (
    <>
      <div className="insp-hero slim">
        <div className="insp-hero-text">
          <TextInput label="Area name" className="title-input" value={a.name} autoFocusKey={focusName} onChange={(v) => coalesce('aname:' + a.id, (d) => ({ ...d, areas: upd(d.areas, a.id, { name: v }) }))} />
          <div className="insp-sub"><i style={{ background: a.color }} />Area · {a.w} × {a.d} cells</div>
        </div>
      </div>
      <section className="sect">
        <Row label="Kind">
          <Segmented size="sm" value={a.kind} onChange={(v) => s.patchArea(a.id, { kind: v })}
            options={[{ value: 'vpc', label: 'VPC' }, { value: 'subnet', label: 'Subnet' }, { value: 'zone', label: 'Zone' }, { value: 'group', label: 'Group' }]} />
        </Row>
      </section>
      <section className="sect">
        <h5>Colour</h5>
        <Swatches value={a.color} onChange={(c) => c && s.patchArea(a.id, { color: c })} />
      </section>
      <div className="insp-actions">
        <button className="btn ghost" onClick={() => fitAreaToContents(a.id)}><Maximize2 size={14} />Fit contents</button>
        <button className="btn ghost" onClick={() => s.duplicate([a.id])}><Copy size={14} />Duplicate</button>
        <button className="btn ghost danger" onClick={() => s.remove([a.id])}><Trash2 size={14} />Delete</button>
      </div>
    </>
  )
}

function LabelInspector({ l }: { l: LabelT }) {
  const s = useStore.getState()
  const focusName = useStore((st) => st.focusName)
  return (
    <>
      <div className="insp-hero slim"><div className="insp-hero-text"><div className="title-static">Text label</div><div className="insp-sub">Lies flat on the ground plane</div></div></div>
      <section className="sect">
        <TextInput label="Label text" multiline value={l.text} autoFocusKey={focusName} onChange={(v) => coalesce('ltext:' + l.id, (d) => ({ ...d, labels: upd(d.labels, l.id, { text: v }) }))} />
        <Row label="Size"><NumberInput label="Size" value={l.size} min={8} max={96} step={2} unit="px" onChange={(v) => coalesce('lsize:' + l.id, (d) => ({ ...d, labels: upd(d.labels, l.id, { size: v }) }))} /></Row>
        <Row label="Direction">
          <Segmented size="sm" value={l.dir} onChange={(v) => s.patchLabel(l.id, { dir: v })} options={[{ value: 'x', label: 'Along X ↘' }, { value: 'y', label: 'Along Y ↗' }]} />
        </Row>
      </section>
      <section className="sect"><h5>Colour</h5><Swatches allowReset value={l.color} onChange={(c) => s.patchLabel(l.id, { color: c })} /></section>
      <Actions ids={[l.id]} />
    </>
  )
}

const SIZES = [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3]
/** Change a component's size about its centre, keeping it on the half-cell grid. */
function resized(n: NodeT, scale: number): NodeT {
  const [cx, cy] = centerOf(n)
  const { scale: _, ...rest } = n
  return { ...rest, x: Math.round((cx - scale) * 2) / 2, y: Math.round((cy - scale) * 2) / 2, ...(scale === 1 ? {} : { scale }) }
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

function DocInspector() {
  const doc = useStore((s) => s.doc)
  const pricing = useStore((s) => s.pricing)
  const s = useStore.getState()
  const cost = docCost(doc, pricing)
  const on = docProviders(doc)
  // what this exact architecture would cost on each cloud
  const clouds = useMemo(() => PROVIDERS.map((p) => {
    const t = translateDoc(doc, p.id)
    return { ...p, total: docCost(t.doc, pricing).total, moved: t.moved, kept: t.kept, share: doc.nodes.filter((n) => defOf(n.type).provider === p.id).length }
  }), [doc, pricing])
  const cheapest = Math.min(...clouds.map((c) => c.total))
  return (
    <>
      <div className="insp-hero slim">
        <div className="insp-hero-text">
          <TextInput label="Blueprint title" className="title-input" value={doc.name} onChange={(v) => coalesce('docname', (d) => ({ ...d, name: v }))} />
          <div className="insp-sub">{on.length ? on.map((p) => PROVIDERS.find((x) => x.id === p)!.short).join(' + ') + ' blueprint' : 'Blueprint settings'}</div>
        </div>
      </div>
      <section className="sect">
        <Row label="Region">
          <Select label="Region" value={doc.region} onChange={(v) => s.apply((d) => ({ ...d, region: v }))} options={REGIONS.map((r) => ({ value: r.id, label: r.name }))} />
        </Row>
      </section>
      <section className="sect">
        <div className="stat-grid">
          <div><b>{doc.nodes.length}</b><span>Components</span></div>
          <div><b>{doc.edges.length}</b><span>Connections</span></div>
          <div><b>{doc.areas.length}</b><span>Areas</span></div>
          <div><b className="mono">{money(cost.total, true)}</b><span>Per month</span></div>
        </div>
      </section>
      {doc.nodes.length > 0 && (
        <section className="sect">
          <h5>Cloud</h5>
          <div className="clouds">
            {clouds.map((c) => (
              <div key={c.id} className={'cloud-row' + (c.moved === 0 && c.share > 0 ? ' on' : '')}>
                <i style={{ background: c.color }} />
                <span className="cloud-name">{c.short}<small>{c.share ? `${c.share} component${c.share === 1 ? '' : 's'}` : 'none yet'}</small></span>
                <span className={'mono cloud-cost' + (c.total === cheapest && cost.total > 0 ? ' best' : '')}>{money(c.total, true)}</span>
                {c.moved > 0
                  ? <button className="btn sm" onClick={() => translateTo(c.id)} title={`Swap ${c.moved} component${c.moved === 1 ? '' : 's'} for ${c.name} equivalents`}>Move</button>
                  : <span className="label dim cloud-here">{c.share ? 'Current' : ''}</span>}
              </div>
            ))}
          </div>
          <p className="cloud-note">The same architecture, priced on each cloud. Moving swaps every component for its closest equivalent and is one undo step.</p>
        </section>
      )}
      <section className="sect tips">
        <h5>Working on the canvas</h5>
        <ul>
          <li>Drag a component from the library, or double-click it to drop it in view.</li>
          <li>Select a component and drag its handle to connect.</li>
          <li><kbd>{keys('⇧')}</kbd> + drag selects a region. <kbd>{keys('⌥')}</kbd> + drag clones.</li>
          <li>Right-drag to orbit the camera; <kbd>Q</kbd> / <kbd>E</kbd> turn it, the cube snaps to standard views.</li>
          <li><kbd>2</kbd> is the top view, <kbd>3</kbd> the home view.</li>
          <li><kbd>{keys('⌘K')}</kbd> opens the command palette.</li>
        </ul>
      </section>
    </>
  )
}

export function Inspector() {
  const doc = useStore((s) => s.doc)
  const selection = useStore((s) => s.selection)
  const sel = new Set(selection)
  const nodes = doc.nodes.filter((n) => sel.has(n.id))
  const edges = doc.edges.filter((e) => sel.has(e.id))
  const areas = doc.areas.filter((a) => sel.has(a.id))
  const labels = doc.labels.filter((l) => sel.has(l.id))
  const count = nodes.length + edges.length + areas.length + labels.length
  if (!count) return <DocInspector />
  if (nodes.length === count) return <NodeInspector nodes={nodes} />
  if (edges.length === count) return <EdgeInspector edges={edges} />
  if (count === 1 && areas.length) return <AreaInspector a={areas[0]} />
  if (count === 1 && labels.length) return <LabelInspector l={labels[0]} />
  return (
    <>
      <div className="insp-hero slim"><div className="insp-hero-text"><div className="title-static">{count} items selected</div>
        <div className="insp-sub">{[nodes.length && plural(nodes.length, 'component'), areas.length && plural(areas.length, 'area'), labels.length && plural(labels.length, 'label'), edges.length && plural(edges.length, 'connection')].filter(Boolean).join(' · ')}</div></div></div>
      <Actions ids={selection} onZoom={nodes.length ? () => fitView(nodes.map((n) => n.id)) : undefined} />
    </>
  )
}
