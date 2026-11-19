import { useEffect, useMemo, useRef, useState } from 'react'
import { CornerDownLeft, Search } from 'lucide-react'
import { fitView, orbitTo, turn, viewHome, viewTop } from '../canvas/camera'
import { ModelIcon } from '../canvas/models'
import { CATALOG_LIST, PROVIDERS, defOf, nodeName } from '../core/catalog'
import { ISO } from '../core/iso'
import { useStore } from '../core/store'
import { keys } from './atoms'
import { addAtCenter, go, saveVersion, selectAll, tidy, toggleFlat, translateTo } from './actions'

interface Cmd {
  id: string
  group: 'Actions' | 'Add component' | 'Jump to'
  label: string
  hint?: string
  kbd?: string
  type?: string
  run: () => void
}

export function CommandPalette({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState('')
  const [idx, setIdx] = useState(0)
  const list = useRef<HTMLDivElement>(null)
  const all = useMemo<Cmd[]>(() => {
    const st = useStore.getState()
    const actions: Cmd[] = [
      { id: 'fit', group: 'Actions', label: 'Zoom to fit', kbd: 'F', run: () => fitView() },
      { id: 'view', group: 'Actions', label: st.flat ? 'Switch to isometric view' : 'Switch to plan view', kbd: st.flat ? '3' : '2', run: toggleFlat },
      { id: 'home', group: 'Actions', label: 'Home view (isometric)', hint: 'camera reset orbit', run: viewHome },
      { id: 'top', group: 'Actions', label: 'Top view', hint: 'camera plan', run: viewTop },
      { id: 'front', group: 'Actions', label: 'Front view', hint: 'camera side', run: () => orbitTo(0, 22) },
      { id: 'turnl', group: 'Actions', label: 'Turn view left', hint: 'camera rotate orbit', kbd: 'Q', run: () => turn(45) },
      { id: 'turnr', group: 'Actions', label: 'Turn view right', hint: 'camera rotate orbit', kbd: 'E', run: () => turn(-45) },
      { id: 'orbit', group: 'Actions', label: 'Orbit tool', hint: 'camera rotate 3d', kbd: 'O', run: () => st.set({ tool: 'orbit' }) },
      { id: 'tidy', group: 'Actions', label: 'Tidy layout automatically', run: tidy },
      { id: 'heat', group: 'Actions', label: st.lens === 'cost' ? 'Turn off cost heatmap' : 'Show cost heatmap', kbd: 'H', run: () => st.set({ lens: st.lens === 'cost' ? 'none' : 'cost' }) },
      { id: 'budget', group: 'Actions', label: 'Open budget', run: () => st.set({ panel: 'budget' }) },
      { id: 'advisor', group: 'Actions', label: 'Open architecture advisor', run: () => st.set({ panel: 'advisor' }) },
      { id: 'export', group: 'Actions', label: 'Export…', hint: 'PNG, SVG, Terraform, JSON, CSV', kbd: '⌘E', run: () => st.set({ modal: 'export' }) },
      { id: 'import', group: 'Actions', label: 'Import from Terraform or JSON…', run: () => st.set({ modal: 'import' }) },
      { id: 'share', group: 'Actions', label: 'Share link…', run: () => st.set({ modal: 'share' }) },
      { id: 'version', group: 'Actions', label: 'Save a version', kbd: '⌘S', run: () => saveVersion() },
      { id: 'history', group: 'Actions', label: 'Version history…', run: () => st.set({ modal: 'history' }) },
      { id: 'flow', group: 'Actions', label: st.flow ? 'Stop traffic animation' : 'Animate traffic flow', run: () => st.set({ flow: !st.flow }) },
      { id: 'grid', group: 'Actions', label: st.showGrid ? 'Hide grid' : 'Show grid', kbd: 'G', run: () => st.set({ showGrid: !st.showGrid }) },
      { id: 'labels', group: 'Actions', label: st.showLabels ? 'Hide component names' : 'Show component names', kbd: 'L', run: () => st.set({ showLabels: !st.showLabels }) },
      { id: 'theme', group: 'Actions', label: st.theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme', run: () => st.setTheme(st.theme === 'dark' ? 'light' : 'dark') },
      { id: 'all', group: 'Actions', label: 'Select all', kbd: '⌘A', run: selectAll },
      { id: 'keys', group: 'Actions', label: 'Keyboard shortcuts', kbd: '?', run: () => st.set({ modal: 'shortcuts' }) },
      { id: 'dash', group: 'Actions', label: 'Back to all blueprints', run: () => go('#/') },
      ...PROVIDERS.map((p): Cmd => ({ id: 'to:' + p.id, group: 'Actions', label: `Translate blueprint to ${p.short}`, hint: `${p.name} convert migrate cloud`, run: () => translateTo(p.id) })),
    ]
    const short = (id: string) => PROVIDERS.find((p) => p.id === id)?.short ?? ''
    // the library's current cloud first, so a bare "queue" finds the one you are building with
    const add: Cmd[] = [...CATALOG_LIST].sort((a, b) => Number(b.provider === st.provider) - Number(a.provider === st.provider)).map((d) => ({ id: 'add:' + d.type, group: 'Add component', label: d.provider === 'any' ? d.name : `${d.svc}`, hint: `${short(d.provider)} ${d.name} ${d.keywords ?? ''}`, type: d.type, run: () => { addAtCenter(d.type) } }))
    const jump: Cmd[] = st.doc.nodes.map((n) => ({ id: 'n:' + n.id, group: 'Jump to', label: nodeName(n), hint: defOf(n.type).svc, type: n.type, run: () => { st.select([n.id]); st.set({ panel: 'inspect' }); fitView([n.id], true, 1.1) } }))
    return [...actions, ...jump, ...add]
  }, [])

  const results = useMemo(() => {
    const t = q.trim().toLowerCase()
    if (!t) return all.filter((c) => c.group === 'Actions').slice(0, 9).concat(all.filter((c) => c.group === 'Add component').slice(0, 5))
    const words = t.split(/\s+/)
    return all
      .map((c) => {
        const hay = (c.label + ' ' + (c.hint ?? '')).toLowerCase()
        if (!words.every((w) => hay.includes(w))) return null
        const score = (c.label.toLowerCase().startsWith(t) ? 0 : c.label.toLowerCase().includes(t) ? 1 : 2) + (c.group === 'Jump to' ? -0.5 : 0)
        return { c, score }
      })
      .filter(Boolean)
      .sort((a, b) => a!.score - b!.score)
      .slice(0, 40)
      .map((x) => x!.c)
  }, [q, all])

  useEffect(() => setIdx(0), [q])
  useEffect(() => { list.current?.querySelector('.on')?.scrollIntoView({ block: 'nearest' }) }, [idx])

  const run = (c?: Cmd) => { if (!c) return; onClose(); c.run() }
  let lastGroup = ''
  return (
    <div className="scrim top" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="cmdk" role="dialog" aria-label="Command palette">
        <div className="cmdk-input">
          <Search size={16} />
          <input autoFocus aria-label="Search commands" placeholder="Search actions, components and anything on the canvas…" value={q} spellCheck={false}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setIdx((i) => Math.min(results.length - 1, i + 1)) }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setIdx((i) => Math.max(0, i - 1)) }
              else if (e.key === 'Enter') { e.preventDefault(); run(results[idx]) }
              else if (e.key === 'Escape') { e.stopPropagation(); onClose() }
            }} />
          <kbd>esc</kbd>
        </div>
        <div className="cmdk-list" ref={list}>
          {results.map((c, i) => {
            const head = c.group !== lastGroup ? <div className="cmdk-group" key={'g' + c.group}>{c.group}</div> : null
            lastGroup = c.group
            return [head,
              <button key={c.id} className={'cmdk-item' + (i === idx ? ' on' : '')} onPointerMove={(e) => { if ((e.movementX || e.movementY) && idx !== i) setIdx(i) }} onClick={() => run(c)}>
                {c.type ? <span className="cmdk-ico"><ModelIcon type={c.type} proj={ISO} size={26} /></span> : <span className="cmdk-ico dot" />}
                <span className="cmdk-label">{c.label}</span>
                {c.group !== 'Actions' && c.hint && <span className="muted">{c.hint.split(' ')[0] === c.label ? '' : c.hint.split(/ (?=[a-z])/)[0]}</span>}
                <span className="grow" />
                {c.kbd ? <kbd>{keys(c.kbd)}</kbd> : i === idx ? <CornerDownLeft size={13} className="muted" /> : null}
              </button>]
          })}
          {!results.length && <div className="muted pad center">Nothing matches “{q}”.</div>}
        </div>
      </div>
    </div>
  )
}
