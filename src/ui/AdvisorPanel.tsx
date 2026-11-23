import { useMemo } from 'react'
import { Check, Crosshair, ShieldCheck, Wand2 } from 'lucide-react'
import { fitView } from '../canvas/camera'
import { type Finding, analyze } from '../core/advisor'
import { money } from '../core/catalog'
import { useStore } from '../core/store'

const SEV = { high: 'High', medium: 'Medium', low: 'Low' }

function ScoreRing({ score }: { score: number }) {
  const R = 30, C = 2 * Math.PI * R
  const color = score >= 85 ? 'var(--pos)' : score >= 60 ? 'var(--warn)' : 'var(--danger)'
  return (
    <div className="score">
      <svg viewBox="0 0 76 76">
        <circle cx="38" cy="38" r={R} fill="none" stroke="var(--border)" strokeWidth="7" />
        <circle cx="38" cy="38" r={R} fill="none" stroke={color} strokeWidth="7" strokeLinecap="round" strokeDasharray={`${(score / 100) * C} ${C}`}
          transform="rotate(-90 38 38)" style={{ transition: 'stroke-dasharray .5s cubic-bezier(.2,.8,.2,1)' }} />
      </svg>
      <b className="mono">{score}</b>
    </div>
  )
}

/** The Advisor tab. Findings are worked out again from the blueprint whenever it changes; nothing about them is stored. */
export function AdvisorPanel() {
  const doc = useStore((s) => s.doc)
  const s = useStore.getState()
  const { findings, score } = useMemo(() => analyze(doc), [doc])
  // "apply all" leaves out the idle load balancer's fix, which is to delete it: that one is only done when asked for by itself
  const fixable = findings.filter((f) => f.fix && !f.id.startsWith('idle-lb'))
  const savings = findings.filter((f) => f.fix && f.saving).reduce((a, f) => a + f.saving!, 0)

  const show = (f: Finding) => {
    if (!f.nodes.length) { s.set({ panel: 'budget' }); return }
    s.select(f.nodes)
    fitView(f.nodes, true, 1.1)
  }
  const fix = (f: Finding) => {
    s.apply(f.fix!.apply)
    s.toast(`Applied: ${f.fix!.label}`)
  }
  const fixAll = () => {
    // all of them in one undo step
    s.apply((d) => fixable.reduce((acc, f) => f.fix!.apply(acc), d))
    s.toast(`Applied ${fixable.length} fix${fixable.length === 1 ? '' : 'es'}`)
  }

  return (
    <>
      <div className="advisor-hero">
        <ScoreRing score={score} />
        <div>
          <div className="title-static">{score >= 85 ? 'In good shape' : score >= 60 ? 'Room to improve' : 'Needs attention'}</div>
          <div className="insp-sub">
            {findings.length ? `${findings.length} finding${findings.length === 1 ? '' : 's'}` : 'No findings'}
            {savings > 1 && <> · <span className="save">{money(savings, true)}/mo recoverable</span></>}
          </div>
          <div className="sev-row">
            {(['high', 'medium', 'low'] as const).map((k) => (
              <span key={k} className={'sev sev-' + k}>{findings.filter((f) => f.severity === k).length} {SEV[k].toLowerCase()}</span>
            ))}
          </div>
        </div>
      </div>
      {fixable.length > 1 && (
        <div className="insp-actions top">
          <button className="btn primary wide" onClick={fixAll}><Wand2 size={14} />Apply {fixable.length} recommended fixes</button>
        </div>
      )}
      <div className="findings">
        {findings.map((f) => (
          <article key={f.id} className={'finding sev-' + f.severity}>
            <header>
              <span className={'sev sev-' + f.severity}>{SEV[f.severity]}</span>
              <span className="pillar">{f.pillar}</span>
              {f.saving ? <span className="save mono">-{money(f.saving, true)}/mo</span> : null}
            </header>
            <h6>{f.title}</h6>
            <p>{f.detail}</p>
            <footer>
              <button className="btn ghost sm" onClick={() => show(f)}><Crosshair size={13} />{f.nodes.length ? 'Show' : 'Open budget'}</button>
              {f.fix && <button className="btn sm" onClick={() => fix(f)}><Check size={13} />{f.fix.label}</button>}
            </footer>
          </article>
        ))}
        {!findings.length && (
          <div className="all-clear">
            <ShieldCheck size={28} />
            <b>{doc.nodes.length ? 'Nothing to flag' : 'Nothing to review yet'}</b>
            <span>{doc.nodes.length ? 'This blueprint passes every reliability, security and cost check.' : 'Add components and the advisor will review the design as you go.'}</span>
          </div>
        )}
      </div>
      <p className="fine">The advisor runs a set of static well-architected checks on the diagram. It is guidance, not an audit.</p>
    </>
  )
}
