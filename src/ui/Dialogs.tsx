import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, Copy, Download, FileCode2, FileJson, History, Image, RotateCcw, Trash2, Upload } from 'lucide-react'
import { fitView } from '../canvas/camera'
import { Scene, THEMES, sceneBounds } from '../canvas/Scene'
import { budgetCsv, download, slug } from '../core/files'
import { makeCam, makeProj } from '../core/iso'
import { type Snapshot, addSnapshot, coerceDoc, listSnapshots, removeSnapshot } from '../core/storage'
import { useStore } from '../core/store'
import { isPhone } from './device'
import { SAMPLE_TF, exportTerraform, importTerraform } from '../core/terraform'
import type { Doc } from '../core/types'
import { Modal, Segmented, Toggle, keys } from './atoms'
import { shareUrl } from './actions'

/*
 * The editor's dialogs. Which one is open is the store's `modal`; each is mounted only while open, so
 * everything typed or chosen in one is local state that starts fresh the next time. They read the
 * store's settings (theme, camera) without subscribing to them, and write to the blueprint only through `apply`.
 */

/**
 * A still picture of a blueprint, drawn by the same renderer as the canvas and framed to fit its box.
 * `cam` (yaw and pitch in degrees) wins over `flat`; with neither it is the home isometric view.
 */
export function Preview({ doc, flat, cam, theme, labels = true }: { doc: Doc; flat?: boolean; cam?: { yaw: number; pitch: number }; theme: 'dark' | 'light'; labels?: boolean }) {
  // keyed on the two angles, not on `cam`: callers pass a new object on every render
  const proj = useMemo(() => (cam ? makeCam(cam.yaw, cam.pitch) : makeProj(flat ? 1 : 0)), [flat, cam?.yaw, cam?.pitch])
  const b = useMemo(() => sceneBounds(doc, proj, 40), [doc, proj])
  return (
    <svg viewBox={`${b.x} ${b.y} ${b.w} ${b.h}`} className="preview" preserveAspectRatio="xMidYMid meet" style={{ pointerEvents: 'none' }}>
      <Scene doc={doc} proj={proj} theme={THEMES[theme]} showLabels={labels} />
    </svg>
  )
}

type Format = 'png' | 'svg' | 'json' | 'tf' | 'csv'
const FORMATS: { id: Format; name: string; hint: string; icon: any }[] = [
  { id: 'png', name: 'PNG image', hint: 'High-resolution raster for docs and slides', icon: Image },
  { id: 'svg', name: 'SVG vector', hint: 'Infinitely scalable, editable in design tools', icon: Image },
  { id: 'tf', name: 'Terraform', hint: 'HCL starting point for every component', icon: FileCode2 },
  { id: 'json', name: 'Blueprint JSON', hint: 'Lossless, re-importable source file', icon: FileJson },
  { id: 'csv', name: 'Budget CSV', hint: 'Line-item cost breakdown', icon: FileJson },
]

export function ExportDialog({ onClose }: { onClose: () => void }) {
  const doc = useStore((s) => s.doc)
  const s = useStore.getState()
  const [format, setFormat] = useState<Format>('png')
  const [theme, setTheme] = useState<'dark' | 'light'>(s.theme)
  // 'cur' exports exactly what the orbit camera is showing. It is the starting choice when the camera is
  // anywhere but the home view (yaw 45, pitch 35.264) or the plan view
  const custom = !s.flat && (Math.abs(s.yaw - 45) > 0.5 || Math.abs(s.pitch - 35.264) > 0.5)
  const [viewMode, setViewMode] = useState<'3d' | '2d' | 'cur'>(custom ? 'cur' : s.flat ? '2d' : '3d')
  const flat = viewMode === '2d'
  const camOpt = viewMode === 'cur' ? { yaw: s.yaw, pitch: s.pitch } : undefined
  const [bg, setBg] = useState(true)
  const [labels, setLabels] = useState(true)
  const [scale, setScale] = useState<'1' | '2' | '4'>('2')
  const [busy, setBusy] = useState(false)
  const visual = format === 'png' || format === 'svg'
  const code = format === 'tf' ? exportTerraform(doc) : format === 'json' ? JSON.stringify(doc, null, 2) : format === 'csv' ? budgetCsv(doc, s.pricing) : ''
  const name = slug(doc.name)

  const run = async () => {
    setBusy(true)
    try {
      const o = { flat, cam: camOpt, theme, background: bg, labels }
      // the image renderer is fetched the first time an image is exported
      if (format === 'png') download(name + '.png', await (await import('../canvas/exporters')).pngBlob(doc, o, Number(scale)))
      else if (format === 'svg') download(name + '.svg', (await import('../canvas/exporters')).svgString(doc, o).svg, 'image/svg+xml')
      else if (format === 'tf') download('main.tf', code)
      else if (format === 'json') download(name + '.cloudmill.json', code, 'application/json')
      else download(name + '-budget.csv', code, 'text/csv')
      s.toast('Export downloaded')
      onClose()
    } catch (e: any) {
      s.toast(e.message ?? 'Export failed', 'warn')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title="Export" subtitle={doc.name} onClose={onClose} width={860}
      footer={<>
        {!visual && <button className="btn ghost" onClick={() => { navigator.clipboard.writeText(code); s.toast('Copied to clipboard') }}><Copy size={14} />Copy</button>}
        <button className="btn primary" onClick={run} disabled={busy}><Download size={14} />{busy ? 'Rendering…' : 'Download'}</button>
      </>}>
      <div className="export-grid">
        <div className="format-list">
          {FORMATS.map((f) => (
            <button key={f.id} className={'format' + (format === f.id ? ' on' : '')} onClick={() => setFormat(f.id)}>
              <f.icon size={16} />
              <span><b>{f.name}</b><small>{f.hint}</small></span>
            </button>
          ))}
          {visual && (
            <div className="export-opts">
              <div className="row"><span className="row-label">View</span><span className="row-ctl"><Segmented size="sm" value={viewMode} onChange={setViewMode} options={[{ value: '3d', label: 'Iso' }, { value: '2d', label: 'Plan' }, { value: 'cur', label: 'Current' }]} /></span></div>
              <div className="row"><span className="row-label">Theme</span><span className="row-ctl"><Segmented size="sm" value={theme} onChange={setTheme} options={[{ value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]} /></span></div>
              {format === 'png' && <div className="row"><span className="row-label">Scale</span><span className="row-ctl"><Segmented size="sm" value={scale} onChange={setScale} options={[{ value: '1', label: '1×' }, { value: '2', label: '2×' }, { value: '4', label: '4×' }]} /></span></div>}
              <div className="row"><span className="row-label">Background</span><span className="row-ctl right"><Toggle label="Background" value={bg} onChange={setBg} /></span></div>
              <div className="row"><span className="row-label">Names</span><span className="row-ctl right"><Toggle label="Names" value={labels} onChange={setLabels} /></span></div>
            </div>
          )}
        </div>
        <div className={'export-preview' + (visual && !bg ? ' checker' : '')} style={visual && bg ? { background: THEMES[theme].bg } : undefined}>
          {visual ? <Preview doc={doc} flat={flat} cam={camOpt} theme={theme} labels={labels} /> : <pre className="code">{code}</pre>}
        </div>
      </div>
    </Modal>
  )
}

/**
 * Terraform or blueprint JSON in, a diagram out. What is pasted is parsed on every change and shown,
 * so nothing is applied unseen. With `onDoc` (the dashboard) the result is handed over to become a new
 * blueprint; without it, it replaces the contents of the open one as a single undo step, keeping its
 * name and region.
 */
export function ImportDialog({ onClose, onDoc }: { onClose: () => void; onDoc?: (d: Doc) => void }) {
  const s = useStore.getState()
  const [mode, setMode] = useState<'tf' | 'json'>('tf')
  const [text, setText] = useState('')
  const file = useRef<HTMLInputElement>(null)
  const result = useMemo(() => {
    if (!text.trim()) return null
    try {
      if (mode === 'tf') {
        const r = importTerraform(text)
        return r.mapped ? r : { error: `Found ${r.resources} resource block(s), but none map to a known component.` }
      }
      const doc = coerceDoc(JSON.parse(text))
      return doc ? { doc, resources: doc.nodes.length, mapped: doc.nodes.length, skipped: [] as string[] } : { error: 'This JSON is not a blueprint file.' }
    } catch (e: any) {
      return { error: mode === 'json' ? 'Invalid JSON: ' + e.message : 'Could not parse this file.' }
    }
  }, [text, mode])
  const ok = result && 'doc' in result ? result : null

  const apply = () => {
    if (!ok) return
    if (onDoc) onDoc(ok.doc)
    else {
      s.apply((d) => ({ ...d, nodes: ok.doc.nodes, edges: ok.doc.edges, areas: ok.doc.areas, labels: ok.doc.labels }))
      s.select([])
      requestAnimationFrame(() => fitView())
      s.toast(`Imported ${ok.mapped} component${ok.mapped === 1 ? '' : 's'}`)
    }
    onClose()
  }
  const onFile = async (f?: File) => {
    if (!f) return
    setMode(/\.json$/i.test(f.name) ? 'json' : 'tf')
    setText(await f.text())
  }

  return (
    <Modal title="Import" subtitle="Turn infrastructure-as-code into a laid-out diagram" onClose={onClose} width={860}
      footer={<>
        {!onDoc && ok && s.doc.nodes.length > 0 && <span className="muted grow">Replaces the current canvas. You can undo.</span>}
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={!ok} onClick={apply}><Upload size={14} />{onDoc ? 'Create blueprint' : 'Import'}</button>
      </>}>
      <div className="import-bar">
        <Segmented value={mode} onChange={(v) => { setMode(v); setText('') }} options={[{ value: 'tf', label: 'Terraform (HCL)' }, { value: 'json', label: 'Blueprint JSON' }]} />
        <span className="grow" />
        {mode === 'tf' && <button className="btn ghost sm" onClick={() => setText(SAMPLE_TF)}>Load sample</button>}
        <button className="btn ghost sm" onClick={() => file.current?.click()}>Choose file…</button>
        <input ref={file} type="file" accept=".tf,.hcl,.json,.txt" hidden onChange={(e) => onFile(e.target.files?.[0])} />
      </div>
      <div className="export-grid import">
        <textarea className="code-input" aria-label={mode === 'tf' ? 'Terraform source' : 'Blueprint JSON'} spellCheck={false} value={text} onChange={(e) => setText(e.target.value)}
          onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); onFile(e.dataTransfer.files[0]) }}
          placeholder={isPhone() ? (mode === 'tf' ? 'Paste Terraform here,\nor load the sample above.\n\naws, google and azurerm\nproviders are understood.' : 'Paste a .cloudmill.json\nfile here.') : mode === 'tf' ? 'Paste or drop .tf files here.\n\nResources become components,\nreferences become connections,\nand networks become areas.\n\nWorks with the aws, google and\nazurerm providers.' : 'Paste or drop a .cloudmill.json file here.'} />
        <div className="export-preview" style={{ background: THEMES[s.theme].bg }}>
          {ok ? <Preview doc={ok.doc} theme={s.theme} /> : <div className="muted center">{result && 'error' in result ? result.error : 'A live preview appears here.'}</div>}
          {ok && mode === 'tf' && (
            <div className="import-stats">
              <span><b>{ok.mapped}</b> of {ok.resources} resources mapped</span>
              <span><b>{ok.doc.edges.length}</b> connections inferred</span>
              {ok.skipped.length > 0 && <span title={ok.skipped.join(', ')}>{ok.skipped.length} supporting type{ok.skipped.length === 1 ? '' : 's'} folded in</span>}
            </div>
          )}
        </div>
      </div>
    </Modal>
  )
}

export function ShareDialog({ onClose }: { onClose: () => void }) {
  const doc = useStore((s) => s.doc)
  const s = useStore.getState()
  const [url, setUrl] = useState('')
  const [copied, setCopied] = useState(false)
  useEffect(() => { shareUrl().then(setUrl) }, [doc])
  const copy = async () => {
    await navigator.clipboard.writeText(url)
    setCopied(true)
    s.toast('Link copied')
    setTimeout(() => setCopied(false), 1600)
  }
  return (
    <Modal title="Share blueprint" subtitle="Anyone with the link gets their own editable copy" onClose={onClose} width={520}>
      <div className="share-box">
        <input className="input mono" readOnly aria-label="Share link" value={url || 'Generating…'} onFocus={(e) => e.currentTarget.select()} />
        <button className="btn primary" onClick={copy} disabled={!url}>{copied ? <Check size={14} /> : <Copy size={14} />}{copied ? 'Copied' : 'Copy link'}</button>
      </div>
      <p className="fine left">
        The entire diagram is compressed into the link itself ({url ? (url.length / 1024).toFixed(1) : '…'} KB). Nothing is uploaded: no account,
        no server, and the link keeps working offline.
      </p>
    </Modal>
  )
}

// The cheat sheet. It is written by hand, not generated: the keys themselves are handled in `useShortcuts`
// (Editor.tsx) and the pointer gestures in canvas/Canvas.tsx, so a change there needs a change here
const KEYS: [string, [string, string][]][] = [
  ['Tools', [['V', 'Select'], ['C', 'Connect components'], ['A', 'Draw an area'], ['T', 'Add a text label'], ['Esc', 'Cancel / deselect']]],
  ['Panels', [['[', 'Show / hide library'], [']', 'Show / hide inspector'], ['\\', 'Show / hide both'], ['/', 'Search the library'], ['↵', 'Rename the selection']]],
  ['Canvas', [['Space + drag', 'Pan'], ['Scroll / pinch', 'Zoom'], ['F', 'Zoom to fit'], ['Right-drag', 'Orbit the camera'], ['⌥ + drag', 'Orbit (on empty canvas)'], ['Q / E', 'Turn the view 45°'], ['2 / 3', 'Top view / home view'], ['O', 'Orbit tool'], ['G', 'Toggle grid'], ['S', 'Snapping on / off'], ['L', 'Toggle names'], ['H', 'Cost heatmap']]],
  ['Editing', [['⌘Z / ⇧⌘Z', 'Undo / redo'], ['⌘C / ⌘V', 'Copy / paste'], ['⌘D', 'Duplicate'], ['Drag a door', 'Connect (to open ground: add and connect)'], ['Drag a line', 'Move that run of it sideways'], ['Drag a turn', 'Move both runs that meet there'], ['Ctrl + drag', 'Flip snapping for that drag'], ['Alt + drag a line', 'No help lining it up'], ['Double-click a turn', 'Take that bend out'], ['⌥ + drag', 'Clone while dragging'], ['⇧ + drag', 'Box select on empty ground, one axis on a component'], ['Esc', 'Put back what is in the hand'], ['Arrows', 'Nudge selection a cell (Shift: four, Alt: a twentieth)'], ['⌫', 'Delete'], ['⌘A', 'Select all']]],
  ['App', [['⌘K', 'Command palette'], ['⌘S', 'Save a version'], ['⌘E', 'Export'], ['?', 'This cheat sheet']]],
]

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="Keyboard shortcuts" onClose={onClose} width={680}>
      {/* the list can be longer than the window is tall: it takes focus so the keyboard can scroll it */}
      {/* oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
      <div className="keys" tabIndex={0} role="group" aria-label="Shortcuts">
        {KEYS.map(([group, rows]) => (
          <section key={group}>
            <h5>{group}</h5>
            {rows.map(([k, label]) => <div key={k}><span>{label}</span><kbd>{keys(k)}</kbd></div>)}
          </section>
        ))}
      </div>
    </Modal>
  )
}

/**
 * Named versions of the open blueprint. The list is a local copy of what is in storage, re-read after
 * each save or delete here. Restoring replaces the contents and region as one undo step, so it can be undone.
 */
export function HistoryDialog({ onClose }: { onClose: () => void }) {
  const doc = useStore((s) => s.doc)
  const s = useStore.getState()
  const [snaps, setSnaps] = useState<Snapshot[]>(() => listSnapshots(doc.id))
  const [name, setName] = useState('')
  const [pick, setPick] = useState<Snapshot | null>(snaps[0] ?? null)
  const refresh = () => { const l = listSnapshots(doc.id); setSnaps(l); return l }
  const save = () => {
    addSnapshot(doc, name.trim() || 'Version ' + (snaps.length + 1))
    setName('')
    setPick(refresh()[0])
  }
  const restore = (sn: Snapshot) => {
    s.apply((d) => ({ ...d, nodes: sn.doc.nodes, edges: sn.doc.edges, areas: sn.doc.areas, labels: sn.doc.labels, region: sn.doc.region }))
    s.select([])
    s.toast(`Restored “${sn.name}”`)
    onClose()
    requestAnimationFrame(() => fitView())
  }
  return (
    <Modal title="Version history" subtitle="Named checkpoints you can return to at any time" onClose={onClose} width={820}>
      <div className="share-box">
        <input className="input" aria-label="Version name" placeholder="Name this version, e.g. “Before multi-region”" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && save()} />
        <button className="btn primary" onClick={save}><History size={14} />Save version</button>
      </div>
      <div className="export-grid history">
        <div className="snap-list">
          {snaps.map((sn) => (
            <div key={sn.id} className={'snap' + (pick?.id === sn.id ? ' on' : '')} role="button" tabIndex={0} aria-pressed={pick?.id === sn.id}
              onClick={() => setPick(sn)} onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setPick(sn) } }}>
              <span><b>{sn.name}</b><small>{new Date(sn.at).toLocaleString()} · {sn.doc.nodes.length} components</small></span>
              <button className="icon-btn" aria-label="Delete version" onClick={(e) => { e.stopPropagation(); removeSnapshot(doc.id, sn.id); const l = refresh(); if (pick?.id === sn.id) setPick(l[0] ?? null) }}><Trash2 size={14} /></button>
            </div>
          ))}
          {!snaps.length && <div className="muted pad">No versions yet. Save one before a big change. It is stored alongside the blueprint in this browser.</div>}
        </div>
        {/* with nothing saved there is nothing to preview: on a phone that empty box would be half the screen */}
        {(snaps.length > 0 || !isPhone()) && (
          <div className="export-preview" style={{ background: THEMES[s.theme].bg }}>
            {pick ? <Preview doc={pick.doc} theme={s.theme} /> : <div className="muted center">Select a version to preview it.</div>}
            {pick && <button className="btn primary float" onClick={() => restore(pick)}><RotateCcw size={14} />Restore this version</button>}
          </div>
        )}
      </div>
    </Modal>
  )
}
