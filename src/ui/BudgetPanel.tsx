import { useMemo } from 'react'
import { Download, Flame } from 'lucide-react'
import { fitView } from '../canvas/camera'
import { CATEGORIES, REGIONS, defOf, defaultProps, docCost, money, nodeName } from '../core/catalog'
import { budgetCsv, download, slug } from '../core/files'
import { useStore } from '../core/store'
import type { PricingModel } from '../core/types'
import { Segmented, Toggle, Select } from './atoms'

function Donut({ parts, total }: { parts: { color: string; value: number }[]; total: number }) {
  const R = 44, C = 2 * Math.PI * R
  let acc = 0
  return (
    <svg viewBox="0 0 120 120" className="donut">
      <circle cx="60" cy="60" r={R} fill="none" stroke="var(--border)" strokeWidth="13" />
      {total > 0 && parts.map((p, i) => {
        const len = (p.value / total) * C
        const gap = parts.length > 1 ? 1.5 : 0
        const el = <circle key={i} cx="60" cy="60" r={R} fill="none" stroke={p.color} strokeWidth="13"
          strokeDasharray={`${Math.max(0, len - gap)} ${C}`} strokeDashoffset={-acc} transform="rotate(-90 60 60)" style={{ transition: 'stroke-dasharray .4s, stroke-dashoffset .4s' }} />
        acc += len
        return el
      })}
    </svg>
  )
}

export function BudgetPanel() {
  const doc = useStore((s) => s.doc)
  const pricing = useStore((s) => s.pricing)
  const lens = useStore((s) => s.lens)
  const selection = useStore((s) => s.selection)
  const s = useStore.getState()
  const cost = useMemo(() => docCost(doc, pricing), [doc, pricing])
  const onDemand = useMemo(() => docCost(doc, 'ondemand').total, [doc])
  const cats = CATEGORIES.map((c) => ({ ...c, value: cost.byCategory.get(c.id) ?? 0 })).filter((c) => c.value > 0).sort((a, b) => b.value - a.value)
  const rows = doc.nodes.map((n) => ({ n, c: cost.perNode.get(n.id)!.monthly })).filter((r) => r.c > 0).sort((a, b) => b.c - a.c)
  const max = rows[0]?.c ?? 1
  const saving = onDemand - cost.total

  return (
    <>
      <div className="budget-hero">
        <div className="budget-donut">
          <Donut parts={cats} total={cost.total} />
          <div className="budget-center">
            <span className="mono big">{money(cost.total, true)}</span>
            <span className="muted">per month</span>
          </div>
        </div>
        <div className="budget-legend">
          {cats.map((c) => (
            <div key={c.id}><i style={{ background: c.color }} /><span>{c.name}</span><span className="mono">{Math.round((c.value / cost.total) * 100)}%</span></div>
          ))}
          {!cats.length && <div className="muted">Add billable components to see a breakdown.</div>}
        </div>
      </div>
      <div className="budget-sub">
        <span><b className="mono">{money(cost.total * 12, true)}</b> per year</span>
        {saving > 1 && <span className="save">saves {money(saving, true)}/mo vs on-demand</span>}
      </div>

      <section className="sect">
        <h5>Pricing model</h5>
        <Segmented<PricingModel> value={pricing} onChange={(v) => s.set({ pricing: v })}
          options={[{ value: 'ondemand', label: 'On-demand' }, { value: 'commit1', label: '1-yr commit' }, { value: 'commit3', label: '3-yr commit' }]} />
        <div className="row" style={{ marginTop: 10 }}>
          <span className="row-label">Region</span>
          <span className="row-ctl">
            <Select label="Region" value={doc.region} onChange={(v) => s.apply((d) => ({ ...d, region: v }))} options={REGIONS.map((r) => ({ value: r.id, label: r.id }))} />
          </span>
        </div>
        <div className="row">
          <span className="row-label"><Flame size={13} style={{ verticalAlign: -2, marginRight: 5 }} />Cost heatmap</span>
          <span className="row-ctl right"><Toggle label="Cost heatmap" value={lens === 'cost'} onChange={(v) => s.set({ lens: v ? 'cost' : 'none' })} /></span>
        </div>
      </section>

      <section className="sect">
        <h5>By component <span className="count">{rows.length}</span></h5>
        <div className="cost-rows">
          {rows.map(({ n, c }) => {
            const d = defOf(n.type)
            return (
              <button key={n.id} className={'cost-row' + (selection.includes(n.id) ? ' on' : '')} onClick={() => { s.select([n.id]); fitView([n.id], true, 1.1) }}>
                <span className="cost-row-top">
                  <span className="cost-name">{nodeName(n)}</span>
                  <span className="mono">{money(c)}</span>
                </span>
                <span className="cost-row-sub">
                  <span className="muted">{d.svc}{d.summary ? ' · ' + d.summary({ ...defaultProps(n.type), ...n.props }) : ''}</span>
                  <span className="muted mono">{Math.round((c / cost.total) * 100)}%</span>
                </span>
                <span className="bar"><i style={{ width: `${(c / max) * 100}%`, background: CATEGORIES.find((x) => x.id === d.category)!.color }} /></span>
              </button>
            )
          })}
        </div>
      </section>
      <div className="insp-actions">
        <button className="btn ghost" onClick={() => { download(slug(doc.name) + '-budget.csv', budgetCsv(doc, pricing), 'text/csv'); s.toast('Budget exported as CSV') }}><Download size={14} />Export CSV</button>
      </div>
      <p className="fine">Estimates use approximate public list prices and exclude data transfer between services, support plans and taxes.</p>
    </>
  )
}
