import { useMemo } from 'react'
import { ArrowLeftRight, Copy, ExternalLink, Maximize2, Minus, RotateCcw, Route, Trash2 } from 'lucide-react'
import { fitView } from '../canvas/camera'
import { ModelIcon } from '../canvas/models'
import { CATEGORIES, HOURS, PROVIDERS, REGIONS, type PropDef, costOf, defOf, defaultProps, docCost, docProviders, money, nodeColor, nodeName, translateDoc } from '../core/catalog'
import { ISO } from '../core/iso'
import { KINDS, ORIGINS, captionOf, describe, kindInfo, linkProblems, traceFlow } from '../core/links'
import { coalesce, useStore } from '../core/store'
import { type AreaT, type EdgeT, type LabelT, type LinkKind, type NodeT, centerOf } from '../core/types'
import { NumberInput, Row, Segmented, Select, Swatches, TextInput, Toggle, keys } from './atoms'
import { isManual, isShaped, straightness } from '../core/shape'
import { fitAreaToContents, straightenLinks, translateTo } from './actions'

/** what each kind of figure rests on, in a sentence */
export const BASIS = {
  fixed: 'Published rate for capacity that is provisioned all month',
  usage: 'Published rate times the usage entered above',
  estimate: 'Estimate: the rate is not verified here',
} as const

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
  const tracing = useStore((st) => st.trace)
  const reach = useMemo(() => (nodes.length === 1 && links.length ? traceFlow(doc, n.id) : null), [doc, n.id, nodes.length, links.length])
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
            <div key={i} className={'cost-line ' + (l.basis ?? 'estimate')}>
              <span><i className="basis" title={BASIS[l.basis ?? 'estimate']} />{l.label}</span><span className="mono">{l.basis === 'estimate' ? '~' : ''}{money(l.monthly)}</span>
              {l.note && <small>{l.note}</small>}
            </div>
          ))}
          {nodes.length === 1 && !cost.lines.length && <div className="muted">No direct charge for this component.</div>}
          <div className="cost-total"><span>{nodes.length > 1 ? 'Selection total' : 'Monthly'}</span><span className="mono">{money(total)}<small>/mo</small></span></div>
        </div>
        {nodes.length === 1 && cost.lines.length > 0 && (
          <p className="insp-note">
            List price in {REGIONS.find((r) => r.id === doc.region)?.name ?? doc.region}, all month ({HOURS} hours){pricing !== 'ondemand' ? ', with reserved rates where they are published' : ''}.
            {cost.lines.some((l) => l.meter) && ' Free monthly allowances are taken off once for the whole blueprint, in Budget.'}
          </p>
        )}
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
              {reach && (
                <p className="insp-note">
                  {reach.up.size ? `${reach.up.size} upstream` : 'Nothing upstream'}, {reach.down.size ? `${reach.down.size} downstream` : 'nothing downstream'}.{' '}
                  {reach.up.size > 0 && 'Upstream components rely on this one, directly or through others.'}
                </p>
              )}
              <div className="conn-list">
                {links.map((e) => {
                  const other = doc.nodes.find((x) => x.id === (e.from === n.id ? e.to : e.from))
                  if (!other) return null
                  return (
                    <button key={e.id} className="conn" onClick={() => s.select([e.id])}>
                      <span className="conn-dir">{e.arrow === 'both' ? '↔' : e.arrow === 'none' ? '–' : e.from === n.id ? '→' : '←'}</span>
                      <span className="conn-name">{nodeName(other)}</span>
                      <span className="muted">{captionOf(e) || kindInfo(e.kind)?.name || defOf(other.type).svc}</span>
                    </button>
                  )
                })}
              </div>
              <div className="insp-actions inline">
                <button className={'btn ghost' + (tracing === n.id ? ' on' : '')} onClick={() => s.set({ trace: tracing === n.id ? null : n.id })}><Route size={14} />{tracing === n.id ? 'Stop following' : 'Follow the flow'}</button>
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

const PROTOCOLS = ['HTTPS', 'HTTP', 'gRPC', 'TCP', 'UDP', 'WebSocket', 'PostgreSQL', 'MySQL', 'Redis', 'Kafka', 'AMQP', 'MQTT', 'DNS', 'S3 API']

function EdgeInspector({ edges }: { edges: EdgeT[] }) {
  const s = useStore.getState()
  const doc = useStore((st) => st.doc)
  const focusName = useStore((st) => st.focusName)
  const tracing = useStore((st) => st.trace)
  const e = edges[0]
  const ids = edges.map((x) => x.id)
  const one = edges.length === 1
  const a = doc.nodes.find((n) => n.id === e.from), b = doc.nodes.find((n) => n.id === e.to)
  const kind = kindInfo(e.kind)
  const problems = one ? linkProblems(doc, e) : []
  const shaped = edges.filter(isShaped)
  const manual = edges.some(isManual)
  const straight = one ? straightness(doc, e) : null
  const mover = straight?.state === 'apart' ? doc.nodes.find((n) => n.id === straight.move) : null
  return (
    <>
      <div className="insp-hero slim">
        <div className="insp-hero-text">
          <div className="title-static">{one ? 'Connection' : `${edges.length} connections`}</div>
          {one && a && b && <div className="insp-sub">{describe(doc, e)}</div>}
        </div>
      </div>
      {one && a && b && (
        <section className="sect">
          <h5>Between</h5>
          {/* each end is a way to the component itself */}
          <div className="link-ends">
            <button className="link-end" onClick={() => s.select([a.id])}><ModelIcon type={a.type} proj={ISO} size={26} color={nodeColor(a)} /><span><small>From</small><b>{nodeName(a)}</b></span></button>
            <span className="link-arrow" aria-hidden="true">{e.arrow === 'both' ? '↔' : e.arrow === 'none' ? '–' : '→'}</span>
            <button className="link-end" onClick={() => s.select([b.id])}><ModelIcon type={b.type} proj={ISO} size={26} color={nodeColor(b)} /><span><small>To</small><b>{nodeName(b)}</b></span></button>
          </div>
        </section>
      )}
      <section className="sect">
        <h5>What it is</h5>
        <Row label="Relationship">
          <Select label="Relationship" value={(e.kind ?? '') as string} onChange={(v) => (v ? s.setKind(ids, v as LinkKind) : s.patchEdge(ids, { kind: undefined }))}
            options={[...(e.kind ? [] : [{ value: '', label: 'Not said' }]), ...KINDS.map((k) => ({ value: k.id as string, label: k.name }))]} />
        </Row>
        {kind && <p className="insp-note">{kind.blurb}.</p>}
        {one && (
          <>
            <Row label="Protocol">
              <TextInput label="Protocol" value={e.protocol ?? ''} placeholder="e.g. HTTPS" list="link-protocols"
                onChange={(v) => coalesce('eproto:' + e.id, (d) => ({ ...d, edges: upd(d.edges, e.id, { protocol: v.trim() || undefined }) }))} />
            </Row>
            <Row label="Port">
              <TextInput label="Port" value={e.port ?? ''} placeholder="e.g. 443" inputMode="numeric"
                onChange={(v) => coalesce('eport:' + e.id, (d) => ({ ...d, edges: upd(d.edges, e.id, { port: v.trim() || undefined }) }))} />
            </Row>
            <Row label="Label">
              <TextInput label="Connection label" value={e.label ?? ''} placeholder="e.g. orders, auth, nightly sync" autoFocusKey={focusName}
                onChange={(v) => coalesce('elabel:' + e.id, (d) => ({ ...d, edges: upd(d.edges, e.id, { label: v || undefined }) }))} />
            </Row>
            <datalist id="link-protocols">{PROTOCOLS.map((p) => <option key={p} value={p}>{p}</option>)}</datalist>
          </>
        )}
        {problems.map((p) => <p key={p} className="insp-note warn" role="status">{p}</p>)}
        {one && (
          <p className="insp-note origin">
            <b>{ORIGINS[e.origin ?? 'drawn'].name}.</b> {ORIGINS[e.origin ?? 'drawn'].blurb} Lines show how the system is meant to work; none of this is measured traffic.
          </p>
        )}
      </section>
      <section className="sect">
        <h5>Path</h5>
        <Row label="Shape">
          <Segmented size="sm" value={e.shape ?? 'ortho'} onChange={(v) => s.setShape(ids, v === 'ortho' ? undefined : v)}
            options={[{ value: 'ortho', label: 'Right-angled' }, { value: 'direct', label: 'Direct' }, { value: 'curved', label: 'Curved' }]} />
        </Row>
        {/* whose line it is: the router's, to plan afresh as things move, or the user's, to stay exactly as it was left */}
        <Row label="Routing">
          <Segmented size="sm" value={e.shape ? 'auto' : manual ? 'manual' : 'auto'} onChange={(v) => (v === 'manual' ? s.keepRoute(ids) : s.resetRoute(ids))}
            options={[{ value: 'auto', label: 'Automatic' }, { value: 'manual', label: 'Manual', disabled: !!e.shape }]} />
        </Row>
        <p className="insp-note">
          {one
            ? e.shape === 'direct' ? 'One straight line from one to the other, at whatever angle that is.'
              : e.shape === 'curved' ? 'A single curve from one side to the other.'
              : straight?.state === 'straight' ? (e.runs ? 'Straight, and kept straight: its ends slide along the sides as things move.' : 'Straight.')
              : straight?.state === 'apart' ? `${mover ? nodeName(mover) : 'One end'} is not in line with the other end, so a right-angled line has to turn. Lining them up moves it across.`
              : !e.runs && !e.via?.length && straight?.state === 'can' && straight.through ? 'Something stands between the two, so the line goes round it. Straighten takes it under instead.'
              : e.runs ? 'Shaped by hand. It keeps this shape when things move: only the runs next to a component stretch.'
              : e.via?.length ? 'Shaped by hand in an older version. Drag any run of it to reshape it.'
              : e.fromSide || e.toSide ? 'Routed automatically, from the side you chose.'
              : 'Routed automatically around other components.'
            : shaped.length ? `${shaped.length} of these ${shaped.length === 1 ? 'has' : 'have'} been shaped by hand.` : 'All routed automatically.'}
          {one && !e.shape && ' Drag any run of the line sideways to move it, a turn to move both runs that meet there, or an end to move it to another component.'}
        </p>
        {!e.shape && <Row label="Snap"><Toggle value={s.snapLines} onChange={(v) => s.set({ snapLines: v })} label="Snap lines into place while dragging" /></Row>}
        <div className="insp-actions inline">
          <button className="btn ghost" disabled={one && (e.shape === 'direct' || (straight?.state === 'straight' && !!e.runs))} onClick={() => straightenLinks(ids)}><Minus size={14} />{straight?.state === 'apart' ? 'Line up' : 'Straighten'}</button>
          <button className="btn ghost" disabled={!shaped.length} onClick={() => s.resetRoute(ids)}><RotateCcw size={14} />Route automatically</button>
        </div>
      </section>
      <section className="sect">
        <h5>Look</h5>
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
        <Swatches allowReset value={e.color} onChange={(c) => s.patchEdge(ids, { color: c })} />
      </section>
      <div className="insp-actions">
        {one && <button className={'btn ghost' + (tracing === e.id ? ' on' : '')} onClick={() => s.set({ trace: tracing === e.id ? null : e.id })}><Route size={14} />{tracing === e.id ? 'Stop following' : 'Follow the flow'}</button>}
        <button className="btn ghost" onClick={() => s.reverseEdge(ids)}><ArrowLeftRight size={14} />Reverse</button>
        {one && <button className="btn ghost" onClick={() => s.twinEdge(e.id)}><Copy size={14} />Second connection</button>}
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
