import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowRight, ArrowUpRight, Copy, Moon, Search, Sun, Trash2 } from 'lucide-react'
import { Scene, THEMES, sceneBounds } from '../canvas/Scene'
import { analyze } from '../core/advisor'
import { CATALOG_LIST, CATEGORIES, docCost, money } from '../core/catalog'
import { ISO, ISO_PITCH, ISO_YAW, makeCam } from '../core/iso'
import { type DocMeta, deleteDoc, duplicateDoc, listDocs, loadDoc, saveDoc } from '../core/storage'
import { useStore } from '../core/store'
import { TEMPLATES, instantiate } from '../core/templates'
import { type Doc, emptyDoc } from '../core/types'
import { navigate as go } from '../core/nav'

import { Logo, onActivate } from './atoms'

// Reading and writing Terraform, and the dialog that imports it, are not needed to draw this page. They come with the
// editor's code (see ./editing), which is fetched once this page is idle, when the pointer first comes to an Import
// button, or when one is pressed, whichever comes first: the sample of generated Terraform fills in as it arrives.
// The dialog is fetched by hand and not through React's `lazy`. That holds back anything that arrives a moment late
// for a third of a second so as not to flash a placeholder, which here would be a pause after every first press; and
// when the code cannot be fetched at all it fails the whole page, where all that has gone wrong is one button
type Importer = typeof import('./editing').ImportDialog
let importer: Importer | null = null
let fetchingImporter: Promise<void> | null = null
/** Fetch the import dialog's code, once. Rejects, and may be asked again, if it could not be fetched. */
const fetchImporter = () => (fetchingImporter ??= import('./editing').then((m) => { importer = m.ImportDialog }, (e) => { fetchingImporter = null; throw e }))

/*
 * The first screen: an introduction to the product, the templates, and the blueprints stored in this
 * browser. It reads storage directly and uses the store only for the theme; opening anything saves it
 * as a blueprint first and then goes to the editor, which loads it by id.
 */

const ago = (t: number) => {
  const s = (Date.now() - t) / 1000
  if (s < 60) return 'just now'
  if (s < 3600) return Math.floor(s / 60) + 'm ago'
  if (s < 86400) return Math.floor(s / 3600) + 'h ago'
  if (s < 86400 * 7) return Math.floor(s / 86400) + 'd ago'
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** Store a new blueprint and go to it. The editor loads from storage by id, so it has to be saved before the address changes. */
function open(doc: Doc) {
  saveDoc(doc)
  go('#/d/' + doc.id)
}

/** The reader has asked for less motion: previews are then drawn once and left alone. */
const still = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * True once the element has come within a screen's height or so of being seen, and from then on. For drawing something
 * costly only when it is about to be looked at: a list of saved blueprints can run to dozens of diagrams.
 */
function useNear(ref: { current: Element | null }): boolean {
  const [near, setNear] = useState(false)
  useEffect(() => {
    const el = ref.current
    // where the browser cannot say (or in a test, which lays nothing out), it is simply drawn
    if (near || !el || typeof IntersectionObserver === 'undefined') { setNear(true); return }
    const io = new IntersectionObserver((seen) => { if (seen.some((e) => e.isIntersecting)) setNear(true) }, { rootMargin: '600px' })
    io.observe(el)
    return () => io.disconnect()
  }, [ref, near])
  return near
}

/** A blueprint with more components than this is drawn plainly in a preview: at that size nothing finer could be made out. */
const PLAIN_PREVIEW = 120
/** How often the picture that turns on its own is drawn again, in ms: it moves a fraction of a degree a frame, so thirty a second is as smooth as sixty. */
const TURN_EVERY = 30

/**
 * A diagram that is alive: it drifts through a slow orbit on its own (`auto`),
 * or leans a few degrees while hovered. Same renderer as the editor.
 *
 * Every turn of the camera draws the whole diagram again, so it only turns while there is a reason to: the one that
 * turns on its own stops when it is scrolled out of sight, and one that leans draws nothing until it is pointed at and
 * nothing more once it has come back to rest.
 */
function LivePreview({ doc, theme, auto, labels = false, flow = false, onYaw }: {
  doc: Doc; theme: 'dark' | 'light'; auto?: boolean; labels?: boolean; flow?: boolean; onYaw?: (yaw: number) => void
}) {
  const [cam, setCam] = useState({ yaw: ISO_YAW, pitch: ISO_PITCH })
  const hover = useRef(false)
  const lean = useRef(0)
  const wrap = useRef<SVGSVGElement>(null)
  const shown = useMemo(() => ({ ...doc, labels: [] }), [doc])
  // frame once from the home view so the picture does not breathe as it turns
  const b = useMemo(() => {
    if (!auto) return sceneBounds(shown, ISO, 30)
    // the hero turns, so frame the whole sweep rather than one pose
    const all = [-16, -8, 0, 8, 16].map((d) => sceneBounds(shown, makeCam(ISO_YAW + d, ISO_PITCH), 40))
    const x = Math.min(...all.map((r) => r.x)), y = Math.min(...all.map((r) => r.y))
    return { x, y, w: Math.max(...all.map((r) => r.x + r.w)) - x, h: Math.max(...all.map((r) => r.y + r.h)) - y }
  }, [shown, auto])
  useEffect(() => {
    if (still()) return
    let raf = 0, last = 0, seen = true
    const t0 = performance.now()
    const tick = (now: number) => {
      raf = 0
      if (auto) {
        if (!seen) return
        raf = requestAnimationFrame(tick)
        if (now - last < TURN_EVERY) return
        last = now
        const t = (now - t0) / 1000
        const yaw = ISO_YAW + Math.sin(t / 4.2) * 16
        setCam({ yaw, pitch: ISO_PITCH + Math.sin(t / 6.1) * 3 })
        onYaw?.(yaw)
      } else {
        const target = hover.current ? 13 : 0
        const next = lean.current + (target - lean.current) * 0.09
        // back at rest, or as far over as it goes: nothing more to draw until the pointer comes or goes
        if (Math.abs(next - lean.current) < 0.01) return
        lean.current = next
        setCam({ yaw: ISO_YAW - next, pitch: ISO_PITCH + next * 0.22 })
        raf = requestAnimationFrame(tick)
      }
    }
    const run = () => { if (!raf) raf = requestAnimationFrame(tick) }
    const card = wrap.current?.closest('.card, .hero-stage, .feat')
    const on = () => { hover.current = true; run() }, off = () => { hover.current = false; run() }
    card?.addEventListener('pointerenter', on)
    card?.addEventListener('pointerleave', off)
    // the one that turns on its own does so only while some of it can be seen
    const io = auto && wrap.current && typeof IntersectionObserver !== 'undefined' ? new IntersectionObserver((e) => { seen = e.some((x) => x.isIntersecting); if (seen) run() }) : null
    if (io) io.observe(wrap.current!)
    else if (auto) run()
    return () => { cancelAnimationFrame(raf); io?.disconnect(); card?.removeEventListener('pointerenter', on); card?.removeEventListener('pointerleave', off) }
    // `onYaw` is left out on purpose: callers pass a new function each render, and restarting the loop would restart the orbit
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto])
  const proj = useMemo(() => makeCam(cam.yaw, cam.pitch), [cam])
  return (
    <svg ref={wrap} viewBox={`${b.x} ${b.y} ${b.w} ${b.h}`} className="preview" preserveAspectRatio="xMidYMid meet" style={{ pointerEvents: 'none' }} aria-hidden="true">
      <Scene doc={shown} proj={proj} theme={THEMES[theme]} showLabels={labels} flow={flow} plain={shown.nodes.length > PLAIN_PREVIEW} />
    </svg>
  )
}

/** A stored blueprint's card. Deleting takes two presses: the second button appears focused, and goes away if focus leaves it. */
function DocCard({ meta, theme, onChange }: { meta: DocMeta; theme: 'dark' | 'light'; onChange: () => void }) {
  const doc = useMemo(() => loadDoc(meta.id), [meta.id, meta.updatedAt])
  const [confirm, setConfirm] = useState(false)
  const card = useRef<HTMLDivElement>(null)
  // its picture is drawn when the card is about to come into view: far down a long list, it never is
  const near = useNear(card)
  const cost = useMemo(() => (doc ? docCost(doc).total : 0), [doc])
  if (!doc) return null
  return (
    <div className="card doc" ref={card}>
      <button className="card-open" aria-label={`Open ${doc.name || 'Untitled'}`} onClick={() => go('#/d/' + meta.id)} />
      <div className="card-art">{!doc.nodes.length ? <span className="label dim">Empty plane</span> : near ? <LivePreview doc={doc} theme={theme} /> : null}</div>
      <div className="card-body">
        <h3>{doc.name || 'Untitled'}</h3>
        <div className="card-meta"><span>{String(doc.nodes.length).padStart(2, '0')} nodes</span><span>{money(cost, true)}/mo</span><span>{ago(meta.updatedAt)}</span></div>
      </div>
      <div className="card-actions">
        <button className="icon-btn" aria-label="Duplicate" onClick={() => { duplicateDoc(meta.id); onChange() }}><Copy size={13} /><span className="tip">Duplicate</span></button>
        {confirm
          ? <button className="btn sm danger-solid" onClick={() => { deleteDoc(meta.id); onChange() }} onBlur={() => setConfirm(false)} autoFocus>Delete?</button>
          : <button className="icon-btn" aria-label="Delete" onClick={() => setConfirm(true)}><Trash2 size={13} /><span className="tip">Delete</span></button>}
      </div>
    </div>
  )
}

export function Dashboard() {
  const theme = useStore((s) => s.theme)
  const setTheme = useStore((s) => s.setTheme)
  const [docs, setDocs] = useState<DocMeta[]>(listDocs)
  const [q, setQ] = useState('')
  // the import dialog has been asked for; it is drawn as soon as its code is here, which after the first time is at once
  const [importing, setImporting] = useState(false)
  const [, arrived] = useState(0)
  const openImport = () => {
    setImporting(true)
    if (importer) return
    fetchImporter().then(() => arrived((n) => n + 1), () => {
      setImporting(false)
      useStore.getState().toast('The importer could not be loaded. Check your connection and try again.', 'warn')
    })
  }
  // the pointer, a finger or the keyboard has come to an Import button: by the time it is pressed the dialog is ready
  const nearImport = () => { fetchImporter().catch(() => { /* asked for again when the button is pressed, which is when to say so */ }) }
  const waiting = importing && !importer
  const Import = importer
  const templates = useMemo(() => TEMPLATES.map((t) => ({ t, doc: instantiate(t) })), [])
  const hero = templates[3]
  const az = useRef<HTMLSpanElement>(null)
  useEffect(() => { document.title = 'CloudMill Graph · cloud architecture studio' }, [])
  const refresh = () => setDocs(listDocs())
  // the editor writes its last change as it closes, which is after this screen first reads the list
  useEffect(() => { setDocs(listDocs()) }, [])
  const shown = docs.filter((d) => d.name.toLowerCase().includes(q.trim().toLowerCase()))
  const heroCost = useMemo(() => docCost(hero.doc).total, [hero])
  // the feature panels are computed from a real template, so they can never drift from what the product does
  const demo = useMemo(() => {
    const doc = templates[0].doc
    const cost = docCost(doc)
    const cats = CATEGORIES.map((c) => ({ ...c, value: cost.byCategory.get(c.id) ?? 0 })).filter((c) => c.value > 0).sort((a, b) => b.value - a.value)
    const { findings, score } = analyze(doc)
    return { cost, cats, findings, score }
  }, [templates])
  // The first lines of the Terraform the sample blueprint exports to, from its database on. Worked out by the editor's
  // code, so it waits until the panel is nearly in view: fetched any sooner, that code would be competing with this page
  // for the connection. The panel has a fixed height, so it fills in without moving anything
  const [hcl, setHcl] = useState<string[]>([])
  const ship = useRef<HTMLElement>(null)
  const shipNear = useNear(ship)
  useEffect(() => {
    if (!shipNear) return
    let live = true
    import('./editing').then(({ exportTerraform }) => {
      if (!live) return
      const lines = exportTerraform(templates[0].doc).split('\n')
      const at = Math.max(0, lines.findIndex((l) => l.startsWith('resource "aws_db_instance"')))
      setHcl(lines.slice(at, at + 11))
    }).catch(() => { /* offline before it was fetched: the panel stays empty */ })
    return () => { live = false }
  }, [templates, shipNear])

  return (
    <div className="dash">
      <header className="dash-top">
        <div className="brand"><Logo size={24} /><span>CloudMill Graph</span></div>
        <nav className="dash-nav" aria-label="Sections">
          <a href="#templates" onClick={(e) => { e.preventDefault(); document.getElementById('templates')?.scrollIntoView({ behavior: 'smooth' }) }}>Templates</a>
          <a href="#blueprints" onClick={(e) => { e.preventDefault(); document.getElementById('blueprints')?.scrollIntoView({ behavior: 'smooth' }) }}>Blueprints</a>
        </nav>
        <span className="grow" />
        <button className="icon-btn" aria-label="Toggle theme" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
          {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}<span className="tip">{theme === 'dark' ? 'Light theme' : 'Dark theme'}</span>
        </button>
        <button className="text-btn" onClick={openImport} onPointerEnter={nearImport} onPointerDown={nearImport} onFocus={nearImport} aria-busy={waiting || undefined}>Import Terraform</button>
        <button className="btn primary" onClick={() => open(emptyDoc())}>New blueprint<ArrowRight size={15} /></button>
      </header>

      <section className="hero">
        <div className="hero-copy">
          <span className="eyebrow"><i />Cloud architecture studio</span>
          <h1>Infrastructure,<br />drawn to scale.</h1>
          <p>CloudMill Graph is a drafting table for cloud systems. Compose an architecture in three dimensions, see what it costs as you build it, and let it review itself before anyone else has to.</p>
          <div className="hero-cta">
            <button className="btn primary lg" onClick={() => open(emptyDoc())}>Start a blueprint<ArrowRight size={15} /></button>
            <button className="btn ghost lg" onClick={() => open(instantiate(hero.t))}>Open the sample<ArrowUpRight size={15} /></button>
            <button className="btn ghost lg only-phone" onClick={openImport} onPointerDown={nearImport} onFocus={nearImport} aria-busy={waiting || undefined}>Import from Terraform</button>
          </div>
          <div className="hero-note">Runs entirely in your browser. No account, nothing uploaded.</div>
        </div>
        <div className="hero-stage" onClick={() => open(instantiate(hero.t))} role="button" tabIndex={0} aria-label="Open the sample blueprint"
          onKeyDown={onActivate(() => open(instantiate(hero.t)))}>
          <span className="tick tl" /><span className="tick tr" /><span className="tick bl" /><span className="tick br" />
          <span className="readout tl">{hero.t.name}</span>
          <span className="readout tr">AZ <span ref={az}>045°</span></span>
          <span className="readout bl">{String(hero.doc.nodes.length).padStart(2, '0')} nodes · {String(hero.doc.edges.length).padStart(2, '0')} links</span>
          <span className="readout br">{money(heroCost, true)}/mo</span>
          <LivePreview doc={hero.doc} theme={theme} auto flow onYaw={(y) => { if (az.current) az.current.textContent = String(Math.round(y)).padStart(3, '0') + '°' }} />
        </div>
      </section>

      <section className="statement">
        <h2><em>Draw it. Price it. Review it. Ship it.</em> <span>One canvas for AWS, Google Cloud and Azure that knows what your architecture costs and checks it before anyone else has to.</span></h2>
      </section>
      {/* each panel shows the real thing, computed from the sample blueprint, not a picture of it */}
      <section className="feats">
        <article className="feat">
          <div className="feat-art"><LivePreview doc={templates[1].doc} theme={theme} flow /></div>
          <div className="feat-body"><span className="feat-n">01</span><h3>Draw</h3><p>An isometric plane with a real orbit camera, and {CATALOG_LIST.length} components across AWS, Google Cloud and Azure.</p></div>
        </article>
        <article className="feat">
          <div className="feat-art pad">
            <div className="feat-total"><b>{money(demo.cost.total)}</b><span>per month</span></div>
            <div className="feat-bar">{demo.cats.map((c) => <i key={c.id} style={{ flex: c.value, background: c.color }} />)}</div>
            <ul className="feat-list">
              {demo.cats.slice(0, 4).map((c) => <li key={c.id}><i style={{ background: c.color }} /><span>{c.name}</span><em>{money(c.value)}</em></li>)}
            </ul>
          </div>
          <div className="feat-body"><span className="feat-n">02</span><h3>Price</h3><p>Every component knows its monthly cost. Totals and breakdowns update as you edit.</p></div>
        </article>
        <article className="feat">
          <div className="feat-art pad">
            <div className="feat-score">
              <svg viewBox="0 0 64 64" width="64" height="64" aria-hidden="true">
                <circle cx="32" cy="32" r="27" fill="none" stroke="var(--line-strong)" strokeWidth="5" />
                <circle cx="32" cy="32" r="27" fill="none" stroke={demo.score >= 80 ? 'var(--pos)' : 'var(--warn)'} strokeWidth="5" strokeLinecap="round"
                  strokeDasharray={`${(demo.score / 100) * 169.6} 169.6`} transform="rotate(-90 32 32)" />
                <text x="32" y="37.5" textAnchor="middle" fontSize="17" fontWeight="600" fill="var(--text)" fontFamily="var(--mono)">{demo.score}</text>
              </svg>
              <div><b>{demo.findings.length} findings</b><span>on the sample blueprint</span></div>
            </div>
            <ul className="feat-list findings">
              {demo.findings.slice(0, 3).map((f) => <li key={f.id}><span className={'sev sev-' + f.severity}>{f.severity}</span><span>{f.title}</span></li>)}
            </ul>
          </div>
          <div className="feat-body"><span className="feat-n">03</span><h3>Review</h3><p>A built-in advisor checks reliability, security and spend, and fixes most findings in one click.</p></div>
        </article>
        <article className="feat" ref={ship}>
          {/* named on the panel, which has a role to carry a name; the listing itself is empty until the code that writes it has arrived */}
          <div className="feat-art code" role="group" aria-label="Terraform generated from the sample blueprint"><pre>{hcl.map((l, i) => <span key={i} className={/^resource|^}/.test(l) ? 'k' : ''}>{l + '\n'}</span>)}</pre></div>
          <div className="feat-body"><span className="feat-n">04</span><h3>Ship</h3><p>Paste Terraform to get a diagram. Export a diagram to get Terraform, PNG, SVG or a share link.</p></div>
        </article>
      </section>

      <section className="dash-sect" id="templates">
        <div className="sect-head"><h2>Start from a proven shape.</h2><div><span className="muted">Six reference architectures across three clouds, each with realistic sizing and costs. Open one and it is yours to change.</span></div></div>
        <div className="grid wide">
          {templates.map(({ t, doc }) => (
            <div key={t.id} className="card" role="button" aria-label={`Start from the ${t.name} template`} onClick={() => open(instantiate(t))} tabIndex={0} onKeyDown={onActivate(() => open(instantiate(t)))}>
              <div className="card-art"><LivePreview doc={doc} theme={theme} /></div>
              <div className="card-body">
                <h3>{t.name}<ArrowUpRight size={14} /></h3>
                <p>{t.blurb}</p>
                <div className="card-meta"><span>{String(doc.nodes.length).padStart(2, '0')} nodes</span><span>{money(docCost(doc).total, true)}/mo</span><span>{t.tags.join(' · ')}</span></div>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="dash-sect" id="blueprints">
        <div className="sect-head">
          <h2>Your blueprints.</h2>
          <div>
            <span className="muted">{docs.length ? `${docs.length} stored in this browser. Nothing leaves it unless you share a link.` : 'Stored in this browser. Nothing leaves it unless you share a link.'}</span>
            {docs.length > 3 && <div className="search inline"><Search size={13} /><input placeholder="Filter blueprints" aria-label="Filter blueprints" value={q} onChange={(e) => setQ(e.target.value)} /></div>}
          </div>
        </div>
        {docs.length ? (
          <div className="grid">
            {shown.map((m) => <DocCard key={m.id} meta={m} theme={theme} onChange={refresh} />)}
            {!shown.length && <div className="muted pad">No blueprints match “{q}”.</div>}
          </div>
        ) : (
          <button className="empty-docs" onClick={() => open(emptyDoc())}>
            <span className="empty-mark" />
            <b>Nothing drafted yet</b>
            <span>Start a blueprint or open a template. Work saves automatically as you go.</span>
          </button>
        )}
      </section>
      <footer className="dash-foot">
        <span><Logo size={16} />CloudMill Graph</span>
        <span>Prices are estimates from approximate public list prices. AWS, Google Cloud and Azure service names are used for reference only.</span>
      </footer>
      {importing && Import && <Import onClose={() => setImporting(false)} onDoc={(d) => open(d)} />}
    </div>
  )
}
