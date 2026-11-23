import { useMemo } from 'react'
import { Download, Flame } from 'lucide-react'
import { fitView } from '../canvas/camera'
import { CATEGORIES, HOURS, REGIONS, defOf, defaultProps, docCost, docProviders, money, nodeName } from '../core/catalog'
import { budgetCsv, download, slug } from '../core/files'
import { RATE_CARD } from '../core/pricing'
import { useStore } from '../core/store'
import type { PricingModel } from '../core/types'
import { Segmented, Toggle, Select } from './atoms'

/** A ring split by share of `total`. Each part is one full circle whose dash is as long as its share, started where the last one ended. */
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

const BASIS_ROWS = [
  { id: 'fixed', name: 'Fixed', blurb: 'Published rates for capacity that runs all month whether it is used or not.' },
  { id: 'usage', name: 'Usage-based', blurb: 'Published rates times the traffic and volumes entered on each component. As right as those numbers.' },
  { id: 'estimate', name: 'Estimated', blurb: 'The rate itself is not verified: a service or region whose price list is not loaded, or a size that is not sold.' },
] as const

/**
 * The Budget tab: what the blueprint costs a month and what that figure rests on. Two totals are in
 * play: `cost.list` is every line added up, and `cost.total` is that less the free allowances.
 * Shares and the ring are of the list price; the headline is the total. Pricing model and the heatmap
 * are session settings in the store; region belongs to the blueprint and changing it is an undo step.
 */
export function BudgetPanel() {
  const doc = useStore((s) => s.doc)
  const pricing = useStore((s) => s.pricing)
  const lens = useStore((s) => s.lens)
  const selection = useStore((s) => s.selection)
  const s = useStore.getState()
  const cost = useMemo(() => docCost(doc, pricing), [doc, pricing])
  const onDemand = useMemo(() => docCost(doc, 'ondemand').total, [doc])
  const cats = CATEGORIES.map((c) => ({ ...c, value: cost.byCategory.get(c.id) ?? 0 })).filter((c) => c.value > 0).sort((a, b) => b.value - a.value)
  const rows = doc.nodes.map((n) => ({ n, c: cost.perNode.get(n.id)! })).filter((r) => r.c.monthly > 0).sort((a, b) => b.c.monthly - a.c.monthly)
  const max = rows[0]?.c.monthly ?? 1
  const saving = onDemand - cost.total
  const free = cost.list - cost.total
  const region = REGIONS.find((r) => r.id === doc.region)
  const clouds = docProviders(doc)
  const abroad = !!region && !region.id.startsWith('us-')
  const newest = Object.values(RATE_CARD.published).sort().at(-1)

  return (
    <>
      <div className="budget-hero">
        <div className="budget-donut">
          <Donut parts={cats} total={cost.list} />
          <div className="budget-center">
            <span className="mono big">{money(cost.total, true)}</span>
            <span className="muted">per month</span>
          </div>
        </div>
        <div className="budget-legend">
          {cats.map((c) => (
            <div key={c.id}><i style={{ background: c.color }} /><span>{c.name}</span><span className="mono">{Math.round((c.value / cost.list) * 100)}%</span></div>
          ))}
          {!cats.length && <div className="muted">Add billable components to see a breakdown.</div>}
        </div>
      </div>
      <div className="budget-sub">
        <span><b className="mono">{money(cost.total * 12, true)}</b> per year</span>
        {saving > 1 && <span className="save">saves {money(saving, true)}/mo vs on-demand</span>}
      </div>

      {cost.list > 0 && (
        <section className="sect">
          <h5>What this figure rests on</h5>
          {/* one bar, split by how far each part can be trusted */}
          <div className="basis-bar" role="img" aria-label={BASIS_ROWS.map((b) => `${b.name} ${money(cost.byBasis[b.id])}`).join(', ')}>
            {BASIS_ROWS.map((b) => cost.byBasis[b.id] > 0 && <i key={b.id} className={b.id} style={{ flexGrow: cost.byBasis[b.id] }} />)}
          </div>
          <div className="basis-rows">
            {BASIS_ROWS.map((b) => (
              <div key={b.id} className={'basis-row ' + b.id}>
                <span><i className="basis" />{b.name}</span><span className="mono">{b.id === 'estimate' && cost.byBasis[b.id] > 0 ? '~' : ''}{money(cost.byBasis[b.id])}</span>
                <small>{b.blurb}</small>
              </div>
            ))}
            {free > 0.005 && (
              <div className="basis-row credit">
                <span>Free allowances</span><span className="mono">-{money(free)}</span>
                <small>What every account gets free each month, taken off once for the whole blueprint: {cost.credits.map((c) => `${c.name} (${money(c.monthly)})`).join(', ')}. If the account runs other workloads, they share these.</small>
              </div>
            )}
          </div>
        </section>
      )}

      <section className="sect">
        <h5>Pricing model</h5>
        <Segmented<PricingModel> value={pricing} onChange={(v) => s.set({ pricing: v })}
          options={[{ value: 'ondemand', label: 'On-demand' }, { value: 'commit1', label: '1-yr commit' }, { value: 'commit3', label: '3-yr commit' }]} />
        {pricing !== 'ondemand' && (
          <p className="insp-note">
            Instances, databases, caches and search nodes are shown at their published reserved rate with no upfront payment (3-year terms use partial upfront where that is all that is sold). Anything without a published reserved price stays on-demand.
          </p>
        )}
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
            const rough = c.lines.some((l) => (l.basis ?? 'estimate') === 'estimate')
            return (
              <button key={n.id} className={'cost-row' + (selection.includes(n.id) ? ' on' : '')} onClick={() => { s.select([n.id]); fitView([n.id], true, 1.1) }}>
                <span className="cost-row-top">
                  <span className="cost-name">{nodeName(n)}</span>
                  <span className="mono" title={rough ? 'Includes an estimated rate' : undefined}>{rough ? '~' : ''}{money(c.monthly)}</span>
                </span>
                <span className="cost-row-sub">
                  <span className="muted">{d.svc}{d.summary ? ' · ' + d.summary({ ...defaultProps(n.type), ...n.props }) : ''}</span>
                  <span className="muted mono">{Math.round((c.monthly / cost.list) * 100)}%</span>
                </span>
                <span className="bar"><i style={{ width: `${(c.monthly / max) * 100}%`, background: CATEGORIES.find((x) => x.id === d.category)!.color }} /></span>
              </button>
            )
          })}
        </div>
      </section>

      <section className="sect">
        <h5>Assumptions</h5>
        <ul className="assume">
          <li>Everything runs all month: {HOURS} hours, the convention the providers' own calculators use.</li>
          <li>List prices in US dollars for {region?.name ?? doc.region}. No negotiated discounts, credits or tax.</li>
          <li>Usage-priced services are charged at their first pricing tier; very large volumes cost a little less per unit.</li>
          <li>Not included: data transfer between zones and services, support plans, backups and snapshots, and anything not drawn.</li>
          {abroad && clouds.some((c) => c !== 'aws') && <li>Google Cloud and Azure components are priced at US rates here, and marked as estimates: their regional price lists are not loaded.</li>}
        </ul>
        <h5 style={{ marginTop: 14 }}>Sources</h5>
        <ul className="assume">
          <li>AWS: <a href={RATE_CARD.url} target="_blank" rel="noreferrer">{RATE_CARD.source}</a>, read {RATE_CARD.generated}{newest ? ` (price files published up to ${newest})` : ''}, for all {RATE_CARD.regions.length} regions.</li>
          <li>Azure: Retail Prices API, East US. Google Cloud: published pricing pages, Iowa. Both checked 2026-11-20 for the rates not marked as estimates.</li>
        </ul>
      </section>
      <div className="insp-actions">
        <button className="btn ghost" onClick={() => { download(slug(doc.name) + '-budget.csv', budgetCsv(doc, pricing), 'text/csv'); s.toast('Budget exported as CSV') }}><Download size={14} />Export CSV</button>
      </div>
      <p className="fine">An estimate for comparing designs, not a quote. Your bill depends on real usage.</p>
    </>
  )
}
