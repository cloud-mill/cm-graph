import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/geist'
import '@fontsource-variable/geist-mono'
import './styles.css'
import App from './App'
import { getPref } from './core/storage'
import { sureTaps, watchViewport } from './ui/device'

document.documentElement.dataset.theme = getPref('theme', 'dark')
watchViewport()
sureTaps()
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// The image exporter is kept out of the first download, then fetched quietly once the page is idle,
// so exporting works straight away and still works if the connection drops later.
const idle = (window as any).requestIdleCallback ?? ((f: () => void) => setTimeout(f, 1200))
idle(() => { import('./core/exporters').catch(() => { /* offline now: it is fetched on demand instead */ }) })
