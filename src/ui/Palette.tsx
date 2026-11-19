import { useEffect, useMemo, useRef, useState } from 'react'
import { Search } from 'lucide-react'
import { ModelIcon } from '../canvas/models'
import { CATALOG_LIST, CATEGORIES, PROVIDERS, type Category } from '../core/catalog'
import { ISO } from '../core/iso'
import { setPref } from '../core/storage'
import { useStore } from '../core/store'
import { addAtCenter } from './actions'
import { Select, keys } from './atoms'

export function Palette() {
  const [q, setQ] = useState('')
  const [cat, setCat] = useState<Category | 'all'>('all')
  const placing = useStore((s) => s.placing)
  const provider = useStore((s) => s.provider)
  const mine = useMemo(() => CATALOG_LIST.filter((d) => d.provider === provider || d.provider === 'any'), [provider])
  const input = useRef<HTMLInputElement>(null)
  const groups = useMemo(() => {
    const t = q.trim().toLowerCase()
    // browsing shows one cloud; searching looks across all three, the current cloud first
    const pool = t ? [...CATALOG_LIST].sort((a, b) => Number(b.provider === provider) - Number(a.provider === provider)) : mine
    return CATEGORIES.filter((c) => t || cat === 'all' || c.id === cat).map((c) => ({
      ...c,
      items: pool.filter((d) => d.category === c.id && (!t || (d.name + ' ' + d.svc + ' ' + (d.keywords ?? '') + ' ' + d.type + ' ' + d.provider).toLowerCase().includes(t))),
    })).filter((g) => g.items.length)
  }, [q, cat, provider, mine])
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

  return (
    <aside className="panel palette">
      <div className="panel-head">
        <span className="label">Library</span>
        <span className="label dim">{String(mine.length).padStart(2, '0')} / {CATALOG_LIST.length}</span>
      </div>
      <div className="cloud-seg" role="radiogroup" aria-label="Cloud provider">
        {PROVIDERS.map((p) => (
          <button key={p.id} role="radio" aria-checked={provider === p.id} className={provider === p.id ? 'on' : ''} title={p.name}
            onClick={() => { useStore.setState({ provider: p.id }); setPref('provider', p.id) }}>
            <i style={{ background: p.color }} />{p.short}
          </button>
        ))}
      </div>
      <div className="search">
        <Search size={13} />
        <input ref={input} aria-label="Search components" placeholder="Search components" value={q} onChange={(e) => setQ(e.target.value)} spellCheck={false}
          onKeyDown={(e) => e.key === 'Escape' && (setQ(''), e.currentTarget.blur())} />
        <kbd>/</kbd>
      </div>
      <Select className="cat-select" label="Category" value={cat} onChange={setCat}
        options={[{ value: 'all' as Category | 'all', label: 'All categories' }, ...CATEGORIES.map((c) => ({ value: c.id as Category | 'all', label: c.name }))]} />
      <div className="palette-scroll">
        {groups.map((g) => (
          <section key={g.id}>
            <h4><i style={{ background: g.color }} />{g.name}<span>{String(g.items.length).padStart(2, '0')}</span></h4>
            <div className="palette-grid">
              {g.items.map((d) => (
                <button key={d.type} className={'pal-item' + (placing === d.type ? ' on' : '')} title={`${d.name}: ${d.svc}`}
                  onPointerDown={(e) => { if (e.button === 0) { e.preventDefault(); useStore.setState({ placing: d.type, tool: 'select' }) } }}
                  onDoubleClick={() => { useStore.setState({ placing: null }); addAtCenter(d.type) }}>
                  <ModelIcon type={d.type} proj={ISO} size={44} />
                  <span className="pal-name">{d.provider === 'any' ? d.name : d.svc}</span>
                  <span className="pal-aws">{q.trim() && d.provider !== 'any' ? tag(d.provider) + ' · ' : ''}{d.provider === 'any' ? d.svc : d.name}</span>
                </button>
              ))}
            </div>
          </section>
        ))}
        {!groups.length && <div className="muted pad">Nothing matches “{q}”.</div>}
      </div>
      <div className="palette-foot"><span>Drag to place</span><span><kbd>{keys('⇧')}</kbd> repeat</span></div>
    </aside>
  )
}
