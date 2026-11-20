import { memo, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Search, X } from 'lucide-react'
import { ModelIcon } from '../canvas/models'
import { CATALOG_LIST, CATEGORIES, PROVIDERS, type Category, type CompDef } from '../core/catalog'
import { ISO } from '../core/iso'
import { setPref } from '../core/storage'
import { useStore } from '../core/store'
import { addAtCenter } from './actions'
import { Select, keys } from './atoms'
import { haptic, isPhone, usePhone } from './device'

/** Which cloud the library shows. On a phone it sits in the sheet's header, so it is its own piece. */
export function CloudSeg() {
  const provider = useStore((s) => s.provider)
  return (
    <div className="cloud-seg" role="radiogroup" aria-label="Cloud provider">
      {PROVIDERS.map((p) => (
        <button key={p.id} role="radio" aria-checked={provider === p.id} className={provider === p.id ? 'on' : ''} title={p.name}
          onClick={() => { useStore.setState({ provider: p.id }); setPref('provider', p.id) }}>
          <i style={{ background: p.color }} />{p.short}
        </button>
      ))}
    </div>
  )
}

// ---- tiles ----------------------------------------------------------------------
// Each tile's picture is a small 3D drawing. Drawing all of them the moment the
// library opens is what used to make it stutter, so a tile draws its picture when
// it is about to scroll into sight, and a tile that has not changed is not redrawn.

type Near = (near: boolean) => void
const watching = new WeakMap<Element, Near>()
let watcher: IntersectionObserver | null = null
function whenNear(el: Element, cb: Near) {
  if (typeof IntersectionObserver === 'undefined') { cb(true); return () => {} }
  watcher ??= new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { watching.get(e.target)?.(true); watching.delete(e.target); watcher!.unobserve(e.target) }
  }, { rootMargin: '320px 0px' })
  watching.set(el, cb)
  watcher.observe(el)
  return () => { watching.delete(el); watcher?.unobserve(el) }
}

interface TileActs { down: (e: React.PointerEvent, type: string) => void; tap: (type: string) => void; twice: (type: string) => void }

const Tile = memo(function Tile({ d, on, sub, acts }: { d: CompDef; on: boolean; sub: string; acts: { current: TileActs } }) {
  const ref = useRef<HTMLButtonElement>(null)
  const [drawn, setDrawn] = useState(false)
  useEffect(() => whenNear(ref.current!, setDrawn), [])
  return (
    <button ref={ref} className={'pal-item' + (on ? ' on' : '')} title={`${d.name}: ${d.svc}`}
      onPointerDown={(e) => acts.current.down(e, d.type)} onClick={() => acts.current.tap(d.type)} onDoubleClick={() => acts.current.twice(d.type)}>
      {drawn ? <ModelIcon type={d.type} proj={ISO} size={44} /> : <span className="pal-ph" aria-hidden="true" />}
      <span className="pal-name">{d.provider === 'any' ? d.name : d.svc}</span>
      <span className="pal-aws">{sub}</span>
    </button>
  )
})

export function Palette() {
  const [q, setQ] = useState('')
  const [cat, setCat] = useState<Category | 'all'>('all')
  const placing = useStore((s) => s.placing)
  const provider = useStore((s) => s.provider)
  const phone = usePhone()
  // typing stays instant: the list catches up a moment later if it has to
  const dq = useDeferredValue(q)
  const scroller = useRef<HTMLDivElement>(null)
  const mine = useMemo(() => CATALOG_LIST.filter((d) => d.provider === provider || d.provider === 'any'), [provider])
  const input = useRef<HTMLInputElement>(null)
  // a finger scrolls this list, so a touch never starts a drag: it adds on tap instead
  const byTouch = useRef(false)
  const tapAdd = (type: string) => {
    if (!byTouch.current) return
    useStore.setState({ placing: null })
    addAtCenter(type)
    haptic(8)
    if (isPhone()) useStore.setState({ showLib: false })
  }
  // one set of handlers shared by every tile, so a tile never redraws just because the list around it did
  const acts = useRef<TileActs>({ down: () => {}, tap: () => {}, twice: () => {} })
  useLayoutEffect(() => {
    acts.current = {
      // a mouse press starts drag-to-place; a finger never does, because a finger on a tile is usually scrolling
      down: (e, type) => { byTouch.current = e.pointerType === 'touch'; if (e.button === 0 && !byTouch.current) { e.preventDefault(); useStore.setState({ placing: type, tool: 'select' }) } },
      tap: tapAdd,
      twice: (type) => { useStore.setState({ placing: null }); addAtCenter(type) },
    }
  })
  // a new search or filter starts from the top, not from wherever the last list was left
  useEffect(() => { scroller.current?.scrollTo?.(0, 0) }, [dq, cat, provider])
  const groups = useMemo(() => {
    const t = dq.trim().toLowerCase()
    // browsing shows one cloud; searching looks across all three, the current cloud first
    const pool = t ? [...CATALOG_LIST].sort((a, b) => Number(b.provider === provider) - Number(a.provider === provider)) : mine
    return CATEGORIES.filter((c) => t || cat === 'all' || c.id === cat).map((c) => ({
      ...c,
      items: pool.filter((d) => d.category === c.id && (!t || (d.name + ' ' + d.svc + ' ' + (d.keywords ?? '') + ' ' + d.type + ' ' + d.provider).toLowerCase().includes(t))),
    })).filter((g) => g.items.length)
  }, [dq, cat, provider, mine])
  const tag = (p: string) => PROVIDERS.find((x) => x.id === p)?.short

  // "/" jumps to the library search from anywhere on the canvas
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== '/' || /INPUT|TEXTAREA|SELECT/.test((e.target as HTMLElement)?.tagName ?? '')) return
      e.preventDefault()
      input.current?.focus()
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [])

  const cats = [{ value: 'all' as Category | 'all', label: 'All', long: 'All categories', color: '' }, ...CATEGORIES.map((c) => ({ value: c.id as Category | 'all', label: c.name, long: c.name, color: c.color }))]
  const searching = !!dq.trim()
  return (
    <aside className={'panel palette' + (phone ? ' touch' : '')}>
      <div className="panel-head">
        <span className="label">Library</span>
        <span className="label dim">{String(mine.length).padStart(2, '0')} / {CATALOG_LIST.length}</span>
      </div>
      {!phone && <CloudSeg />}
      <div className="search">
        <Search size={13} />
        <input ref={input} aria-label="Search components" placeholder={phone ? `Search ${CATALOG_LIST.length} components` : 'Search components'} value={q} onChange={(e) => setQ(e.target.value)} spellCheck={false}
          enterKeyHint="search" autoCapitalize="off" autoCorrect="off" autoComplete="off"
          onKeyDown={(e) => { if (e.key === 'Escape') { setQ(''); e.currentTarget.blur() } else if (e.key === 'Enter' && phone) e.currentTarget.blur() }} />
        {q ? <button className="search-clear" aria-label="Clear search" onClick={() => { setQ(''); input.current?.focus() }}><X size={14} /></button> : <kbd>/</kbd>}
      </div>
      {phone ? (
        // a row of chips to flick through beats a drop-down that covers the list it filters
        <div className={'pal-chips' + (searching ? ' off' : '')} role="radiogroup" aria-label="Category">
          {cats.map((c) => (
            <button key={c.value} role="radio" aria-checked={cat === c.value} className={cat === c.value ? 'on' : ''} disabled={searching}
              onClick={(e) => { setCat(c.value); e.currentTarget.scrollIntoView?.({ inline: 'center', block: 'nearest', behavior: 'smooth' }) }}>
              {c.color && <i style={{ background: c.color }} />}{c.label}
            </button>
          ))}
        </div>
      ) : (
        <Select className="cat-select" label="Category" value={cat} onChange={setCat} options={cats.map((c) => ({ value: c.value, label: c.long }))} />
      )}
      <div className="palette-scroll" ref={scroller}>
        {groups.map((g) => (
          <section key={g.id}>
            <h4><i style={{ background: g.color }} />{g.name}<span>{String(g.items.length).padStart(2, '0')}</span></h4>
            <div className="palette-grid">
              {g.items.map((d) => (
                <Tile key={d.type} d={d} on={placing === d.type} acts={acts}
                  sub={(searching && d.provider !== 'any' ? tag(d.provider) + ' · ' : '') + (d.provider === 'any' ? d.svc : d.name)} />
              ))}
            </div>
          </section>
        ))}
        {!groups.length && <div className="muted pad">Nothing matches “{dq}”.</div>}
      </div>
      <div className="palette-foot not-phone"><span>Drag to place</span><span><kbd>{keys('⇧')}</kbd> repeat</span></div>
    </aside>
  )
}
