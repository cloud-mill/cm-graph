import { Component, type ComponentType, type ReactNode, useEffect, useState, useSyncExternalStore } from 'react'
import { decodeShare, saveDoc } from './core/storage'
import { useStore } from './core/store'

// ---- the two screens, each fetched when it is first wanted ------------------------------------------------------
//
// The app's code is in three parts: what every screen needs, the list of blueprints, and the editor. Someone landing on
// the list does not wait for the editor, nor the other way round; the one not shown is fetched as soon as the page is
// idle (main.tsx), so going from one to the other is not a wait either.
//
// This is deliberately not React's `lazy` and <Suspense>. React keeps a Suspense fallback on screen for a third of a
// second once it has shown it, so that it does not flicker, which here would make every first screen a third of a second
// late. Instead the page asks for the first screen's code at the same moment as the app's own (see vite.config.ts) and
// the app is not drawn until it has it (main.tsx): the first thing drawn is the screen itself.
type ScreenName = 'Dashboard' | 'Editor'
const screens: { Dashboard?: ComponentType; Editor?: ComponentType<{ id: string }> } = {}
const fetching: Partial<Record<ScreenName, Promise<void>>> = {}
/** Which screen an address shows. A shared link ends in the editor, so that is what it will need. */
export const screenFor = (hash: string): ScreenName => (/^#\/[ds]\//.test(hash) ? 'Editor' : 'Dashboard')
// (each `import()` on a line of its own: written as two arms of one expression, the build fetches what both need whichever is taken)
const fetchers: Record<ScreenName, () => Promise<void>> = {
  Editor: () => import('./ui/editing').then((m) => { screens.Editor = m.Editor }),
  Dashboard: () => import('./ui/Dashboard').then((m) => { screens.Dashboard = m.Dashboard }),
}
/** Fetch a screen's code, once. Resolves when it can be drawn; rejects (and may be asked again) if it could not be fetched. */
export function loadScreen(name: ScreenName): Promise<void> {
  return (fetching[name] ??= fetchers[name]().catch((e) => { delete fetching[name]; throw e }))
}
/** True once the screen's code is here; until then it is being fetched. A failure to fetch it is thrown, for the boundary to show. */
function useScreen(name: ScreenName): boolean {
  const [, redraw] = useState(0)
  const [failed, setFailed] = useState<Error | null>(null)
  useEffect(() => {
    if (screens[name]) return
    let live = true
    loadScreen(name).then(() => { if (live) redraw((n) => n + 1) }, (e) => { if (live) setFailed(e instanceof Error ? e : new Error(String(e))) })
    return () => { live = false }
  }, [name])
  if (failed) throw failed
  return !!screens[name]
}

/*
 * The application shell: picks a screen from the address, and nothing else.
 *
 *   #/            the dashboard
 *   #/d/<id>      the editor, on the blueprint stored under that id
 *   #/s/<payload> a shared link: the whole blueprint is in the payload
 *
 * The address is the only routing state. Moving between pages goes through
 * `navigate` in core/nav, which is also where browser history is handled.
 */

// `navigate` changes the address with pushState, which fires no event of its own, and sends a
// `hashchange` by hand; so this one listener hears both its moves and the browser's
const onHash = (cb: () => void) => { window.addEventListener('hashchange', cb); return () => window.removeEventListener('hashchange', cb) }
/**
 * The address, read straight from the browser. Subscribing this way re-reads it
 * once the listener is in place, so a redirect made while the first screen was
 * still mounting (before anything could be listening) is not missed.
 */
const useHash = () => useSyncExternalStore(onHash, () => location.hash)

/** A render error anywhere should never leave a blank page: say so, and offer the way back. */
class Boundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) { return { error } }
  componentDidCatch(error: Error) { console.error(error) }
  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="boot crash">
        <b>Something broke while drawing this screen.</b>
        <span>Your blueprints are saved in this browser and are not affected.</span>
        <code>{this.state.error.message}</code>
        <div>
          <button className="btn primary" onClick={() => location.reload()}>Reload</button>
          <button className="btn ghost" onClick={() => { location.hash = '#/'; location.reload() }}>Back to all blueprints</button>
        </div>
      </div>
    )
  }
}

/** Rendered outside the error boundary, so a message can still be shown over a screen that has crashed. */
function Toasts() {
  const toasts = useStore((s) => s.toasts)
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => <div key={t.id} className={'toast ' + (t.kind ?? 'ok')}><i />{t.text}</div>)}
    </div>
  )
}

/** The screen the address asks for; a quiet holding screen while a shared link is decoded, or for the moment a screen's code is still on its way. */
function Screen({ hash }: { hash: string }) {
  const ready = useScreen(screenFor(hash))
  const doc = hash.match(/^#\/d\/([\w-]+)/)
  const { Editor, Dashboard } = screens
  // the editor is keyed by blueprint id, so opening another one starts it from nothing
  if (doc) return ready && Editor ? <Editor id={doc[1]} key={doc[1]} /> : <div className="boot" />
  if (hash.startsWith('#/s/')) return <div className="boot" />
  return ready && Dashboard ? <Dashboard /> : <div className="boot" />
}

export default function App() {
  const hash = useHash()
  const theme = useStore((s) => s.theme)
  useEffect(() => { document.documentElement.dataset.theme = theme }, [theme])

  // shared links: decode into a fresh local copy, then open it. The address is replaced, not added to, so Back
  // never returns to the link and makes a second copy. `live` drops a result that arrives after the address has moved on
  useEffect(() => {
    const m = hash.match(/^#\/s\/(.+)$/)
    if (!m) return
    let live = true
    decodeShare(m[1]).then((doc) => {
      if (!live) return
      if (!doc) { useStore.getState().toast('That share link is damaged or incomplete', 'warn'); location.replace('#/'); return }
      saveDoc(doc)
      location.replace('#/d/' + doc.id)
      useStore.getState().toast('Opened a copy of the shared blueprint')
    })
    return () => { live = false }
  }, [hash])

  // The boundary is keyed by the kind of screen ('#/d/', '#/s/' or '#/'), so leaving a crashed screen for another kind
  // clears the failure.
  return (
    <>
      <Boundary key={hash.slice(0, 4)}>
        <Screen hash={hash} />
      </Boundary>
      <Toasts />
    </>
  )
}
