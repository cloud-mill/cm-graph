import { useEffect, useMemo, useRef, useState } from 'react'
import { CATALOG_LIST, type CompDef, PROVIDERS, equivalent } from '../core/catalog'
import { useBackLayer } from '../core/nav'
import { useStore } from '../core/store'

/** what most diagrams reach for next, offered before anything is typed */
const USUAL = ['ec2', 'lambda', 'rds', 's3', 'alb', 'sqs', 'dynamodb']

/**
 * A small search that opens where a connection was let go on empty ground:
 * pick a component and it is added there, already connected. Type to search
 * every cloud, arrows and Enter to choose, Escape to change your mind.
 * `x`, `y` are px from the canvas's top-left corner. It adds nothing itself: `onPick` is given the chosen type.
 */
export function QuickAdd({ x, y, onPick, onClose }: { x: number; y: number; onPick: (type: string) => void; onClose: () => void }) {
  const provider = useStore((s) => s.provider)
  const [q, setQ] = useState('')
  const [at, setAt] = useState(0)
  const box = useRef<HTMLDivElement>(null)
  const coarse = useMemo(() => typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches, [])
  useBackLayer(true, onClose)

  const items = useMemo(() => {
    const t = q.trim().toLowerCase()
    if (!t) return USUAL.map((u) => equivalent(u, provider)).filter((d): d is CompDef => !!d)
    const score = (d: CompDef) => {
      const name = d.name.toLowerCase(), svc = d.svc.toLowerCase()
      const hay = name + ' ' + svc + ' ' + (d.keywords ?? '') + ' ' + d.type
      if (!hay.includes(t)) return -1
      // a name that starts with what was typed first, then this cloud before the others
      return (name.startsWith(t) || svc.startsWith(t) ? 4 : name.includes(t) || svc.includes(t) ? 2 : 0) + (d.provider === provider || d.provider === 'any' ? 1 : 0)
    }
    return CATALOG_LIST.map((d) => [score(d), d] as const).filter(([s]) => s >= 0).sort((a, b) => b[0] - a[0]).slice(0, 7).map(([, d]) => d)
  }, [q, provider])

  // a press anywhere outside it closes it. Heard on the window in the capture phase, so it closes before whatever was pressed acts on the press
  useEffect(() => {
    const away = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) onClose() }
    window.addEventListener('pointerdown', away, true)
    return () => window.removeEventListener('pointerdown', away, true)
  }, [onClose])

  const pick = (d?: CompDef) => { if (d) onPick(d.type) }
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setAt((i) => Math.min(items.length - 1, i + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setAt((i) => Math.max(0, i - 1)) }
    else if (e.key === 'Enter') { e.preventDefault(); pick(items[Math.min(at, items.length - 1)]) }
    else if (e.key === 'Escape') { e.preventDefault(); onClose() }
    // what is typed here stays here: the editor's shortcuts listen on the window and would act on the same keys
    e.stopPropagation()
  }
  const tag = (d: CompDef) => (d.provider === 'any' ? '' : PROVIDERS.find((p) => p.id === d.provider)?.short ?? '')

  return (
    <div ref={box} className="quick-add" role="dialog" aria-label="Add and connect a component" style={{ left: x, top: y }}>
      <input autoFocus={!coarse} value={q} placeholder="Connect to a new…" aria-label="Search components" role="combobox" aria-expanded aria-controls="quick-add-list"
        autoCapitalize="off" autoCorrect="off" autoComplete="off" spellCheck={false}
        onChange={(e) => { setQ(e.target.value); setAt(0) }} onKeyDown={onKey} />
      <div id="quick-add-list" role="listbox" aria-label="Components">
        {items.map((d, i) => (
          <button key={d.type} role="option" aria-selected={i === at} className={i === at ? 'on' : ''} onPointerEnter={() => setAt(i)} onClick={() => pick(d)} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }}>
            <i style={{ background: d.color }} />
            <b>{d.name}</b>
            <span>{[tag(d), d.svc].filter(Boolean).join(' · ')}</span>
          </button>
        ))}
        {!items.length && <p>Nothing matches. Try another name.</p>}
      </div>
    </div>
  )
}
