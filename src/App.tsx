import { Component, type ReactNode, useEffect, useSyncExternalStore } from 'react'
import { decodeShare, saveDoc } from './core/storage'
import { useStore } from './core/store'
import { Dashboard } from './ui/Dashboard'
import { Editor } from './ui/Editor'

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

  const doc = hash.match(/^#\/d\/([\w-]+)/)
  // The boundary is keyed by the kind of screen ('#/d/', '#/s/' or '#/'), so leaving a crashed screen for another kind
  // clears the failure. The editor is keyed by blueprint id, so opening another one starts it from nothing.
  return (
    <>
      <Boundary key={hash.slice(0, 4)}>
        {doc ? <Editor id={doc[1]} key={doc[1]} /> : hash.startsWith('#/s/') ? <div className="boot" /> : <Dashboard />}
      </Boundary>
      <Toasts />
    </>
  )
}
