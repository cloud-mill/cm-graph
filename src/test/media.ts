import { vi } from 'vitest'

/**
 * A matchMedia the test controls. `set` flips which queries match and tells
 * listeners, the way rotating a phone or resizing a window would.
 * It replaces the global, and the config's `restoreMocks` does not put that back:
 * the test file calls `vi.unstubAllGlobals()` when it is done.
 */
export function stubMedia(matches: (query: string) => boolean = () => false) {
  let rule = matches
  const lists: { media: string; fire: () => void }[] = []
  const impl = (media: string) => {
    const subs = new Set<() => void>()
    lists.push({ media, fire: () => subs.forEach((f) => f()) })
    return {
      get matches() { return rule(media) }, media, onchange: null,
      addEventListener: (_: string, f: () => void) => subs.add(f), removeEventListener: (_: string, f: () => void) => subs.delete(f),
      addListener: (f: () => void) => subs.add(f), removeListener: (f: () => void) => subs.delete(f), dispatchEvent: () => false,
    }
  }
  vi.stubGlobal('matchMedia', impl)
  return { set(next: (query: string) => boolean) { rule = next; lists.forEach((l) => l.fire()) } }
}

/** the editor's phone layout: little room. Matches the query in src/ui/device.ts by its width clause, so it must change if that does */
export const PHONE = (q: string) => q.includes('max-width: 760px')
/** fingers rather than a mouse, on a screen with room (the phone question also mentions coarse pointers, so match exactly) */
export const COARSE = (q: string) => q.trim() === '(pointer: coarse)'
