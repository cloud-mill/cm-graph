import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/geist'
import '@fontsource-variable/geist-mono'
import './styles.css'
import App, { loadScreen, screenFor } from './App'
// Both screens draw diagrams, review them, and are built from the same small controls. Named here, those travel with the
// app itself, and not as files of their own that either screen would then have to wait for
import './canvas/Scene'
import './core/advisor'
import './ui/atoms'
import { watchHistory } from './core/nav'
import { getPref } from './core/storage'
import { sureTaps, watchViewport } from './ui/device'

// before the first render, so the page is never drawn in the wrong theme first
document.documentElement.dataset.theme = getPref('theme', 'dark')
// page-wide listeners that live as long as the page does: the functions they return (which stop them) are only used by tests
watchViewport()
sureTaps()
watchHistory()
// The first screen's code was asked for by the page itself, at the same time as this (see vite.config.ts). The app is drawn
// when it has arrived, so the first thing drawn is that screen and not a placeholder for it. If it cannot be fetched the
// app is drawn all the same, and says so.
const root = createRoot(document.getElementById('root')!)
const draw = () => root.render(
  <StrictMode>
    <App />
  </StrictMode>,
)
const first = loadScreen(screenFor(location.hash)).then(draw, draw)

// The other screen is kept out of the first download, and fetched quietly once this one has been drawn and the page has
// been idle a while, so that opening a blueprint, or going back to the list, is not a wait. Not sooner: on a slow
// connection it would only take from what the first screen is still waiting for. Fetched now, it also still works if the
// connection drops later.
const idle = (window as any).requestIdleCallback ?? ((f: () => void) => setTimeout(f, 1200))
const later = () => { /* offline now: it is fetched when it is first needed instead */ }
first.finally(() => setTimeout(() => idle(() => {
  loadScreen('Editor').catch(later)
  loadScreen('Dashboard').catch(later)
}), 2500))
