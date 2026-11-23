import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/geist'
import '@fontsource-variable/geist-mono'
import './styles.css'
import App from './App'
import { watchHistory } from './core/nav'
import { getPref } from './core/storage'
import { sureTaps, watchViewport } from './ui/device'

// before the first render, so the page is never drawn in the wrong theme first
document.documentElement.dataset.theme = getPref('theme', 'dark')
// page-wide listeners that live as long as the page does: the functions they return (which stop them) are only used by tests
watchViewport()
sureTaps()
watchHistory()
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// The image exporter is kept out of the first download, then fetched quietly once the page is idle,
// so exporting works straight away and still works if the connection drops later.
const idle = (window as any).requestIdleCallback ?? ((f: () => void) => setTimeout(f, 1200))
idle(() => { import('./canvas/exporters').catch(() => { /* offline now: it is fetched on demand instead */ }) })
