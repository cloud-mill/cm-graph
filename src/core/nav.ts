import { useEffect, useLayoutEffect, useRef } from 'react'

/**
 * Navigation: the one place that touches browser history.
 *
 * There are two kinds of "where am I". Pages (the dashboard, a blueprint) are
 * real history entries with their own address. Layers are the things that sit on
 * top of a page for a moment: a sheet, a dialog, a menu, a tool waiting for a
 * tap. A layer has no address, but on a phone the Back button must still take
 * it away before it takes the page away.
 *
 * So while any layer is open, history holds one extra entry at the same
 * address: the guard. Back pops the guard, and popping it closes the topmost
 * layer. If more layers remain the guard goes straight back, so each press
 * peels exactly one. When the last layer is closed from the screen instead, the
 * guard is stepped off again, so history never fills with dead entries and the
 * next Back does what a browser's Back always does.
 *
 * There is only ever one guard, however many layers are open, and it is put
 * down or picked up after the current burst of changes has settled. Switching
 * from one sheet to another therefore costs history nothing.
 */

interface Layer { close: () => void }
interface Mark { guard?: boolean; from?: string }

const layers: Layer[] = []
/** the guard is the current history entry */
let guarded = false
/** our own history.back() calls that have not come round as popstate yet */
let stepping = 0
let settling = false

const mark = (): Mark => (history.state && typeof history.state === 'object' ? history.state : {}) as Mark
const page = (hash: string) => (hash === '' || hash === '#' ? '#/' : hash)

function settle() {
  settling = false
  // wait for our own step back to land before deciding anything else
  if (stepping) return
  if (layers.length && !guarded) { history.pushState({ ...mark(), guard: true }, ''); guarded = true }
  else if (!layers.length && guarded) { guarded = false; stepping++; history.back() }
}
function soon() {
  if (settling) return
  settling = true
  queueMicrotask(settle)
}

/** Put a layer on top. Returns the function that takes it off again (closing it from the screen). */
export function openLayer(close: () => void): () => void {
  const layer = { close }
  layers.push(layer)
  soon()
  return () => {
    const i = layers.indexOf(layer)
    if (i < 0) return // Back already took it
    layers.splice(i, 1)
    soon()
  }
}

function onPop() {
  if (stepping) {
    // this is our own step off the guard arriving
    stepping--
    soon()
    return
  }
  const onGuard = !!mark().guard
  if (guarded && !onGuard) {
    // Back was pressed with something open: it takes the top layer, not the page
    guarded = false
    const top = layers.pop()
    top?.close()
    soon()
  } else if (!guarded && onGuard) {
    // Forward onto a guard whose layer is long gone (or a reload while one was open): there is nothing to show for it
    stepping++
    history.back()
  }
}

/** Go to a page. `replace` swaps the current entry instead of adding one, for redirects that must not be returned to. */
export function navigate(hash: string, opts: { replace?: boolean } = {}) {
  const from = page(location.hash)
  if (page(hash) === from) return
  // whatever was open belonged to the page being left
  layers.length = 0
  // where Back from the new page leads: a replacement inherits that from the entry it replaces
  const state: Mark = { from: opts.replace ? mark().from : from }
  // a page change with something still open takes over the guard's slot, so the old page's guard can never be landed on
  if (opts.replace || guarded) history.replaceState(state, '', hash)
  else history.pushState(state, '', hash)
  guarded = false
  // neither call announces itself, and the router listens for this
  window.dispatchEvent(new HashChangeEvent('hashchange'))
}

/**
 * Up to the dashboard. If that is where this page was opened from, it is a step
 * back, so the dashboard's own Back then leaves the app instead of bouncing in again.
 */
export function goHome() {
  if (page(location.hash) === '#/') return
  const from = mark().from
  if (from === undefined || page(from) !== '#/') { navigate('#/'); return }
  // past the guard as well, if something is still open; whatever that was belonged to the page being left
  layers.length = 0
  stepping++
  if (guarded) { guarded = false; history.go(-2) } else history.back()
}

/** How many layers are open (for tests and diagnostics). */
export const openLayers = () => layers.length

/** Start listening. Returns the function that stops (tests use it to start clean). */
export function watchHistory() {
  layers.length = 0; guarded = false; stepping = 0; settling = false
  window.addEventListener('popstate', onPop)
  // reloaded while a layer was open: the page comes back without it, so the guard under us is stale
  if (mark().guard) { stepping++; history.back() }
  return () => window.removeEventListener('popstate', onPop)
}

/** While `open` is true, Back closes this instead of leaving the page. */
export function useBackLayer(open: boolean, close: () => void) {
  const ref = useRef(close)
  useLayoutEffect(() => { ref.current = close })
  useEffect(() => { if (open) return openLayer(() => ref.current()) }, [open])
}
